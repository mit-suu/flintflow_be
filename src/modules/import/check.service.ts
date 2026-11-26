/**
 * Check sau baseline v0 (nút 1.11 AI semantic — vàng, có credit; 1.12 code rule — đỏ/vàng). FLF-171, plan §6 2C.
 * 1.11 chạy kiểu map-reduce để đọc hết tài liệu dù dài bao nhiêu (trước đây chỉ 16k ký tự đầu):
 * - map: block chia lô ≤ `SEMANTIC_BATCH_CHARS` theo thứ tự tài liệu, mỗi lô một lượt `IMPORT_SEMANTIC_CHECK` (step
 *   `I-1.11:<n>`) kèm phần Spine của chính các section trong lô — tối đa `IMPORT_CHECK_CONCURRENCY` lượt cùng lúc;
 * - reduce: cờ của từng lô áp theo thứ tự lô (`findingOps` bỏ cờ trùng cờ đang mở), rồi một lượt `IMPORT_CROSS_CHECK`
 *   (step `I-1.11:cross`) trên Spine gọn của cả tài liệu tìm lỗi giữa các section mà từng lô không thấy.
 * AI lỗi / hết credit ⇒ `paused` ở `checking`; resume bỏ qua lượt đã trừ credit (usage `deducted` theo step).
 * Cờ AI ghi vào `flags[]` với `rule_id = import_semantic` (không bị recompute đóng), mức vàng.
 */

import { env } from "../../config/env.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { getActionCost } from "../../shared/ai/credit-reservation.service.js"
import type { FindingsOutput } from "../../shared/ai/response-parser.js"
import { applyTransaction } from "../spine/op-engine.js"
import type { Op } from "../spine/op.types.js"
import * as flagsService from "../spine/flags.service.js"
import { aiFindingLabel, humanizeText } from "../spine/human-labels.js"
import { listSections } from "../spine/section-registry.js"
import * as spineRepository from "../spine/spine.repository.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type { Flag, Spine, SpineRecord } from "../spine/spine.types.js"
import { Usage } from "../spine/usage.model.js"
import { IMPORTED_DOC_VERSIONS } from "../doc-version/versioning.js"
import { DocBlock } from "./doc-block.model.js"
import { chunkBlocks, isTemplateOnlyProject } from "./extract.service.js"
import { idKey } from "./extracted-entities.js"
import { FieldAnchor } from "./field-anchor.model.js"
import type { MentionEntity } from "./import.constants.js"
import { transitionImport } from "./import.service.js"
import type { IImportedDocument } from "./imported-document.model.js"
import { withMeteredAi, type MeteredResult } from "./metered-ai.js"
import { IMPORT_SEMANTIC_RULE } from "./mode1-rule-profile.js"
import { contentSlot, isContentSlot, slotParents } from "./content-slots.js"
import { mode1RuleProfileFor } from "./mode1-guard.js"
import { Project } from "../project/project.model.js"
import { TemplateProfile } from "./template-profile.model.js"
import { isDerivedHeading } from "./target-structure.js"

/** Tiền tố step của 1.11. Usage đúng `I-1.11` (không hậu tố) là lượt đơn của bản cũ — đã xong thì coi như xong cả 1.11. */
export const SEMANTIC_CHECK_STEP = "I-1.11"
export const CROSS_CHECK_STEP = `${SEMANTIC_CHECK_STEP}:cross`
export const semanticBatchStep = (n: number): string => `${SEMANTIC_CHECK_STEP}:${n}`

/** Ngân sách chữ mỗi lô map (~12k token in, GLM còn dư context) và trần một block. */
export const SEMANTIC_BATCH_CHARS = 48_000
const SEMANTIC_BLOCK_CHARS = 6_000
/** Số lượt map gọi cùng lúc (`IMPORT_CHECK_CONCURRENCY`) — finalize chạy đồng bộ nên không xếp hàng tuần tự từng lô. */
export const parallelBatches = (): number => env.IMPORT_CHECK_CONCURRENCY
const PROJECTION_LIMIT = 12_000
const CROSS_PROJECTION_LIMIT = 48_000
const RAISED_LIMIT = 8_000
/** Câu NFR / BR / mô tả chức năng trong Spine gọn của lượt kiểm chéo. */
const STATEMENT_CHARS = 200

const truncate = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}\n…(truncated)` : s)
const clip = (s: string): string => (s.length > STATEMENT_CHARS ? `${s.slice(0, STATEMENT_CHARS)}…` : s)

/** FLF-454: tài liệu có mục mục tiêu (Spine có ít nhất một mục tiêu dự án) ⇒ mới chạy hai phân tích mục tiêu / KPI. */
export const hasGoalSection = (spine: Pick<Spine, "project">): boolean => (spine.project.goals ?? []).some((g) => g.trim())

/** Mảng Spine được phép lọc theo phạm vi lô; `actors` luôn gửi đủ (ngắn, cần cho lệch thuật ngữ). */
type ScopedArray = "use_cases" | "functions" | "nfrs" | "business_rules"

/** Giữ phần tử nào trong phép chiếu của một lô; không truyền ⇒ giữ hết. */
export type ProjectionScope = (array: ScopedArray, id: string) => boolean

/** Phép chiếu gọn của Spine cho model (không nạp toàn Spine — coding-rules §3.6). */
export const semanticProjection = (spine: Spine, keep: ProjectionScope = () => true): string => {
  const pick = <T extends { id: string }>(array: ScopedArray, arr: T[], keys: (keyof T)[]) =>
    arr.filter((x) => keep(array, x.id)).map((x) => Object.fromEntries(keys.map((k) => [k, x[k]])))
  return truncate(
    JSON.stringify({
      actors: spine.actors.map((a) => ({ id: a.id, name: a.name })),
      use_cases: pick("use_cases", spine.use_cases, ["id", "name", "actor_ids"]),
      functions: pick("functions", spine.functions, ["id", "name", "feature_id", "normal", "abnormal"]),
      nfrs: pick("nfrs", spine.nfrs, ["id", "category", "statement"]),
      business_rules: pick("business_rules", spine.business_rules, ["id", "statement"])
    }),
    PROJECTION_LIMIT
  )
}

/**
 * Spine gọn của cả tài liệu cho lượt kiểm chéo: id, tên, câu rút gọn + section của phần tử. Thứ tự mảng là thứ tự ưu
 * tiên khi chạm trần — NFR / BR (nguồn mâu thuẫn) đứng trước use case.
 */
export const crossProjection = (spine: Spine, sectionOf: (array: string, id: string) => string | null): string => {
  const at = (array: string, id: string) => ({ section_id: sectionOf(array, id) })
  return truncate(
    JSON.stringify({
      actors: spine.actors.map((a) => ({ id: a.id, name: a.name, ...at("actors", a.id) })),
      nfrs: spine.nfrs.map((n) => ({ id: n.id, category: n.category, statement: clip(n.statement), ...at("nfrs", n.id) })),
      business_rules: spine.business_rules.map((b) => ({ id: b.id, statement: clip(b.statement), ...at("business_rules", b.id) })),
      functions: spine.functions.map((f) => ({ id: f.id, name: f.name, description: clip(f.description), ...at("functions", f.id) })),
      use_cases: spine.use_cases.map((u) => ({ id: u.id, name: u.name, actor_ids: u.actor_ids, ...at("use_cases", u.id) }))
    }),
    CROSS_PROJECTION_LIMIT
  )
}

/** Block đưa vào 1.11 (chữ có trong tài liệu, kèm mã phần tử được nhắc). */
export interface CheckBlock {
  block_id: string
  text: string
  section_id: string | null
  mentions?: { entity: MentionEntity; id: string }[]
  /** FLF-459: 1–3 = Code đã kết luận là chữ hướng dẫn của mẫu, không phải chữ thật của tài liệu. */
  guidance_layer?: 1 | 2 | 3 | 4
}

/**
 * FLF-454 (business-flow §2 "Ai kiểm"): phạm vi AI rà ở bước 1.9. Loại: section Ngoài phạm vi (nguyên tắc 4), mục tự sinh
 * (Record of Changes, bìa, mục lục), mục còn trống (chỉ heading / chỉ chữ hướng dẫn, không có chữ thật).
 */
export interface CheckScope {
  /** Section không đưa cho AI (Ngoài phạm vi, còn trống, tự sinh). */
  excluded_sections?: ReadonlySet<string>
  /**
   * Block chữ thuộc mục bị loại. Khối chữ dưới heading riêng có `section_id = null` và heading của mục lục / bìa là `unmapped`
   * nên so `section_id` không đủ - nối khối với heading của nó (`excludedCheckBlocks`).
   */
  excluded_blocks?: ReadonlySet<string>
}

/**
 * FLF-454: block thuộc mục bị loại khỏi lượt AI. Đi theo thứ tự tài liệu: heading mở mục (có trong cấu trúc đích / bản sơ bộ qua
 * `block_id`, hoặc là mục tự sinh theo bảng heading) đặt mục hiện tại; heading con của mục đó giữ nguyên mục. Hàm thuần.
 */
export const excludedCheckBlocks = (
  blocks: readonly { block_id: string; kind?: string; text?: string }[],
  structure: { sections: readonly { section_id: string; status: "present" | "missing" | "out_of_scope"; block_id?: string }[] } | null | undefined,
  headingMap: readonly { block_id: string; section_id: string }[] = []
): Set<string> => {
  const entries = new Map<string, boolean>()
  for (const s of structure?.sections ?? []) if (s.block_id) entries.set(s.block_id, s.status !== "present")
  const mapped = new Map(headingMap.map((h) => [h.block_id, h.section_id]))
  const out = new Set<string>()
  let excluded = false
  for (const b of blocks) {
    if (b.kind === "heading") {
      const derived = isDerivedHeading(mapped.get(b.block_id) ?? "", b.text ?? "")
      if (derived || entries.has(b.block_id)) excluded = derived || entries.get(b.block_id)!
    } else if (excluded) out.add(b.block_id)
  }
  return out
}

/** Hàm thuần: id section loại khỏi lượt AI từ cấu trúc đích (hoặc bản sơ bộ) và bảng heading của file. */
export const excludedCheckSections = (
  structure: { sections: readonly { section_id: string; status: "present" | "missing" | "out_of_scope" }[] } | null | undefined,
  headings: readonly { section_id: string; heading_text: string }[] = []
): Set<string> => {
  const out = new Set<string>()
  for (const s of structure?.sections ?? []) if (s.status !== "present") out.add(s.section_id)
  for (const h of headings) if (isDerivedHeading(h.section_id, h.heading_text)) out.add(h.section_id)
  return out
}

/** Chữ thật để AI rà: có chữ, không phải chữ hướng dẫn Code đã kết luận, không thuộc section bị loại. */
const inCheckScope = (b: CheckBlock, scope: CheckScope): boolean =>
  !!b.text.trim() &&
  !(b.guidance_layer !== undefined && b.guidance_layer <= 3) &&
  !(b.section_id && scope.excluded_sections?.has(b.section_id)) &&
  !scope.excluded_blocks?.has(b.block_id) &&
  !(b.section_id && isDerivedHeading(b.section_id, ""))

export interface SemanticBatch {
  step_id: string
  section_ids: string[]
  /** `[B0001] (section) text`, mỗi block một dòng. */
  lines: string
  /** Khoá `<mảng>|<idKey>` của phần tử được nhắc trong lô. */
  mentioned: Set<string>
}

/** Loại mã nhận được trong chữ ⇒ mảng Spine của phép chiếu. */
const MENTION_ARRAYS: Readonly<Partial<Record<MentionEntity, ScopedArray>>> = {
  use_case: "use_cases",
  function: "functions",
  nfr: "nfrs",
  business_rule: "business_rules"
}

const scopeKey = (array: string, id: string): string => `${array}|${idKey(id)}`

/** Chia block thành lô theo thứ tự tài liệu; lô thứ n mang step `I-1.11:<n>` (block không đổi sau baseline ⇒ ổn định khi resume). */
export const semanticBatches = (blocks: readonly CheckBlock[], budget = SEMANTIC_BATCH_CHARS, scope: CheckScope = {}): SemanticBatch[] =>
  chunkBlocks(
    blocks.filter((b) => inCheckScope(b, scope)).map((b) => ({ ...b, text: `[${b.block_id}] (${b.section_id ?? "-"}) ${b.text}` })),
    budget,
    SEMANTIC_BLOCK_CHARS
  ).map((batch, i) => ({
    step_id: semanticBatchStep(i + 1),
    section_ids: [...new Set(batch.map((b) => b.section_id).filter((s): s is string => !!s))],
    lines: batch.map((b) => b.text).join("\n"),
    mentioned: new Set(batch.flatMap((b) => (b.mentions ?? []).flatMap((m) => (MENTION_ARRAYS[m.entity] ? [scopeKey(MENTION_ARRAYS[m.entity]!, m.id)] : []))))
  }))

/** Section của từng phần tử Spine, suy từ anchor (phần tử ⇒ block nguồn ⇒ section của block). */
export interface ElementSections {
  sectionOf: (array: string, id: string) => string | null
  /** Phạm vi phép chiếu của một lô: phần tử thuộc section của lô hoặc được nhắc trong lô. */
  scopeOf: (batch: Pick<SemanticBatch, "section_ids" | "mentioned">) => ProjectionScope
}

export const elementSections = (
  anchors: readonly { entity_path: string; block_ids: readonly string[] }[],
  blockSection: ReadonlyMap<string, string | null>
): ElementSections => {
  const sections = new Map<string, string[]>()
  for (const a of anchors) {
    const m = /^([a-z_]+)\[id=([^\]]+)\]$/.exec(a.entity_path)
    if (!m) continue
    const found = [...new Set(a.block_ids.map((b) => blockSection.get(b)).filter((s): s is string => !!s))]
    if (found.length) sections.set(scopeKey(m[1], m[2]), found)
  }
  return {
    sectionOf: (array, id) => sections.get(scopeKey(array, id))?.[0] ?? null,
    scopeOf: (batch) => {
      const inBatch = new Set(batch.section_ids)
      return (array, id) => batch.mentioned.has(scopeKey(array, id)) || (sections.get(scopeKey(array, id)) ?? []).some((s) => inBatch.has(s))
    }
  }
}

/**
 * Chạy `fn` cho từng phần tử, tối đa `limit` lượt cùng lúc, kết quả theo thứ tự đầu vào. Một lượt trả `ok: false` (hết
 * credit / AI lỗi) ⇒ không mở lượt mới — lượt đang chạy vẫn chạy xong; phần tử chưa chạy ⇒ `undefined`.
 */
export const runLimited = async <T, R extends { ok: boolean }>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<(R | undefined)[]> => {
  const out: (R | undefined)[] = new Array(items.length).fill(undefined)
  let next = 0
  let stop = false
  const worker = async (): Promise<void> => {
    while (!stop && next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
      if (!out[i]!.ok) stop = true
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const flagIdGenerator = (flags: Flag[]): (() => string) => {
  let n = Math.max(0, ...flags.map((f) => Number(/^FL(\d+)$/.exec(f.id)?.[1] ?? 0)))
  return () => `FL${String(++n).padStart(3, "0")}`
}

/**
 * Phần nhỏ không có mục FPT cha (tổng quan chức năng, yêu cầu chức năng, nền tảng…) ⇒ mục FPT giữ đúng loại dữ liệu của
 * nó (chức năng ⇒ chức năng đầu tiên / 3.1.4, dự án ⇒ 1), không dồn về Record of Changes (`fixed:I`).
 */
const slotHome = (slotId: string, sections: ReadonlySet<string>): string | undefined => {
  const targets = contentSlot(slotId)?.targets ?? []
  if (targets.includes("functions")) return [...sections].find((id) => id.startsWith("function:")) ?? (sections.has("fixed:3.1.4") ? "fixed:3.1.4" : undefined)
  if (targets.includes("project")) return sections.has("fixed:1") ? "fixed:1" : undefined
  return undefined
}

/** Một phát hiện thành cờ vàng; `target_id` (FLF-343) = đường dẫn phần tử / block được nói tới — thiếu ⇒ block đầu. */
export type Finding = FindingsOutput["findings"][number] & { target_id?: string | null }

/**
 * Đổi finding của model thành op thêm cờ vàng; section không phân giải được ⇒ `fixed:I`. Phần nhỏ `slot:*` của mẫu bắt buộc
 * (FLF-278) không phải mục Spine (bất biến 3 chặn `flags[].section_id` trỏ tới nó) ⇒ trỏ về mục FPT cha của phần nhỏ.
 */
export const findingOps = (spine: Spine, findings: readonly Finding[], rule: string): Op[] => {
  const sections = new Set(listSections(spine).map((s) => s.id))
  const nextId = flagIdGenerator(spine.flags)
  const open = new Set(spine.flags.filter((f) => f.resolved_at === null && f.rule_id === rule).map((f) => `${f.section_id}|${f.message}`))
  const ops: Op[] = []
  for (const f of findings) {
    const parent = isContentSlot(f.section_id) ? (slotParents(f.section_id).find((p) => sections.has(p)) ?? slotHome(f.section_id, sections)) : undefined
    const section = sections.has(f.section_id) ? f.section_id : (parent ?? "fixed:I")
    // Không in mã luật thô (`[ambiguity]`) cho người đọc — luật AI biết tên thì thành nhãn tiếng Việt đứng đầu
    const label = aiFindingLabel(f.rule)
    const text = humanizeText(f.message)
    const message = label ? `${label}: ${text}` : text
    if (open.has(`${section}|${message}`)) continue
    open.add(`${section}|${message}`)
    const flag: Flag = {
      id: nextId(),
      level: "yellow",
      rule_id: rule,
      section_id: section,
      target_id: f.target_id ?? f.block_ids[0] ?? null,
      message,
      remediation_step: "C-1",
      opened_at_version: spine.spine_version + 1,
      resolved_at: null,
      waived_by_user: false,
      waive_reason: null,
      waived_at_version: null,
      kept_reason: null,
      kept_by: null,
      kept_at: null
    }
    // Lý do của máy — `section-renderer` INTERNAL_REASON lọc khỏi Record of Changes
    ops.push({ op: "add", path: "flags[]", value: flag, reason: `AI check: ${f.rule}` })
  }
  return ops
}

/**
 * Nhiều nhóm phát hiện (mỗi nhóm một luật) ghi cờ trong CÙNG một lô (FLF-252): id cờ cấp nối tiếp qua các nhóm. Gọi
 * `findingOps` riêng từng nhóm trên cùng Spine thì mỗi lần đếm lại từ cờ có sẵn ⇒ hai cờ trùng id, cả lô bị từ chối
 * ("Mục này đã tồn tại trong tài liệu" lúc tạo bản 0.1 khi vừa có ảnh không đọc được vừa có quyền không khớp màn).
 */
export const findingOpsInOrder = (spine: Spine, groups: readonly { findings: readonly Finding[]; rule: string }[]): Op[] => {
  const ops: Op[] = []
  let flags = spine.flags
  for (const g of groups) {
    const next = findingOps({ ...spine, flags }, g.findings, g.rule)
    ops.push(...next)
    flags = [...flags, ...next.map((o) => o.value as Flag)]
  }
  return ops
}

export const stripRecord = ({ projectId: _p, ...spine }: SpineRecord): Spine => spine

const loadSpine = async (projectId: string): Promise<Spine> => {
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  return stripRecord(record)
}

/** Ghi cờ vàng của một lượt AI (đọc Spine mới nhất để id cờ nối tiếp và bỏ cờ trùng cờ lô trước vừa ghi). */
const applyFindings = async (projectId: string, findings: FindingsOutput["findings"], reason: string): Promise<void> => {
  if (!findings.length) return
  const spine = await loadSpine(projectId)
  const ops = findingOps(spine, findings, IMPORT_SEMANTIC_RULE)
  if (ops.length) await applyTransaction(projectId, { base_version: spine.spine_version, ops, by: "import", reason, step_id: null })
}

const glossaryText = (spine: Spine): string => JSON.stringify(spine.glossary.map((g) => ({ term: g.term, definition: g.definition })))

/** Cờ 1.11 đang mở — đưa cho lượt kiểm chéo để không nói lại. */
const raisedText = (spine: Spine): string =>
  truncate(
    spine.flags
      .filter((f) => f.rule_id === IMPORT_SEMANTIC_RULE && f.resolved_at === null)
      .map((f) => `- (${f.section_id}) ${f.message}`)
      .join("\n") || "(none)",
    RAISED_LIMIT
  )

/**
 * FLF-454: file chưa đủ cấu trúc đích (I-5 ra `resolved_mode` 3 / 4) ⇒ bước 1.9 không chạy, không trừ credit. Ưu tiên kết quả
 * I-5 cuối (`target_structure`), chưa finalize thì bản sơ bộ ở màn đọc khung. Dự án cũ không có ý định (`template_intent`) hoặc chưa
 * có kết quả so ⇒ không chặn (giữ luồng cũ).
 */
const lacksTargetStructure = async (projectId: string): Promise<boolean> => {
  const [project, profile] = await Promise.all([
    Project.findById(projectId, { template_intent: 1 }).lean(),
    TemplateProfile.findOne({ projectId }, { target_structure: 1, structure_preview: 1 }).lean()
  ])
  if (project?.template_intent !== "fixed" && project?.template_intent !== "free") return false
  const mode = (profile?.target_structure ?? profile?.structure_preview)?.resolved_mode
  return mode !== undefined && mode !== 1
}

/** Block chữ đưa vào 1.9 + phạm vi loại (Ngoài phạm vi, mục tự sinh). Dùng chung cho lượt chạy và số credit báo trước. */
export const loadCheckInput = async (projectId: string): Promise<{ blocks: CheckBlock[]; scope: CheckScope }> => {
  const [all, profile] = await Promise.all([
    DocBlock.find({ projectId, doc_version: { $in: IMPORTED_DOC_VERSIONS }, kind: { $in: ["heading", "paragraph", "list_item", "table_cell"] } })
      .sort({ "anchor.ordinal": 1 })
      .select("block_id kind text section_id mentions guidance_layer")
      .lean<(CheckBlock & { kind: string })[]>(),
    TemplateProfile.findOne({ projectId }, { target_structure: 1, structure_preview: 1, heading_map: 1 }).lean()
  ])
  const structure = profile?.target_structure ?? profile?.structure_preview
  const blocks = all.filter((b) => b.kind !== "heading")
  return {
    blocks,
    scope: { excluded_sections: excludedCheckSections(structure, profile?.heading_map), excluded_blocks: excludedCheckBlocks(all, structure, profile?.heading_map) }
  }
}

type CheckFailure = Extract<MeteredResult<FindingsOutput>, { ok: false }>

/**
 * 1.11 map + reduce. Trả lượt lỗi (để đặt `paused`) hoặc `null` khi đã xong hết. Lượt đã trừ credit ở lần chạy trước
 * (`done`) không gọi lại; lô xong trước lô lỗi vẫn được ghi cờ.
 */
const runSemanticCheck = async (projectId: string, importId: string, userId: string, done: ReadonlySet<string>, guard: CheckGuard): Promise<CheckFailure | null> => {
  const spine = await loadSpine(projectId)
  const [{ blocks, scope: checkScope }, anchors, sectioned] = await Promise.all([
    loadCheckInput(projectId),
    FieldAnchor.find({ projectId }).select("entity_path block_ids").lean(),
    DocBlock.find({ projectId, doc_version: { $in: IMPORTED_DOC_VERSIONS } }).select("block_id section_id").lean()
  ])
  const scope = elementSections(anchors, new Map(sectioned.map((b) => [b.block_id, b.section_id ?? null])))
  const glossary = glossaryText(spine)
  const hasGoals = hasGoalSection(spine)

  // map: các lô chưa xong, tối đa `IMPORT_CHECK_CONCURRENCY` lượt cùng lúc
  const pending = semanticBatches(blocks, SEMANTIC_BATCH_CHARS, checkScope).filter((b) => !done.has(b.step_id))
  const mapStarted = Date.now()
  const results = await runLimited(pending, parallelBatches(), async (batch) => {
    await guard()
    return withMeteredAi<FindingsOutput>({ projectId, userId, stepId: batch.step_id }, ActionType.IMPORT_SEMANTIC_CHECK, {
      section_ids: batch.section_ids.join(", "),
      // Không có anchor (dữ liệu trước FLF-171) ⇒ không biết phần tử thuộc lô nào: gửi đủ như trước, vẫn có trần ký tự
      projection: semanticProjection(spine, anchors.length ? scope.scopeOf(batch) : undefined),
      blocks: batch.lines,
      glossary,
      // FLF-454: phân tích "tính năng không phục vụ mục tiêu" / "mục tiêu thiếu KPI" chỉ khi tài liệu có mục tiêu
      goal_analyses: hasGoals
    })
  })
  // Đo thời gian bước kiểm tra theo lô (không log nội dung tài liệu)
  console.info(`[I-1.11] import ${importId}: kiểm tra theo lô xong sau ${Date.now() - mapStarted} ms, ${pending.length} lô, ${pending.length} lượt AI, song song ${parallelBatches()}`)
  // reduce: ghi theo thứ tự lô ⇒ id cờ ổn định; hết credit được ưu tiên báo (nạp xong tự chạy tiếp — credit-flow)
  let failure: CheckFailure | null = null
  for (const r of results) {
    if (!r) continue
    if (!r.ok) {
      if (!failure || r.reason === "credits") failure = r
      continue
    }
    await applyFindings(projectId, r.data.findings, "AI semantic check (1.11)")
  }
  if (failure) return failure

  // kiểm chéo giữa các section: chỉ khi mọi lô đã xong, đọc cờ lô vừa ghi để không lặp lại
  const hasContent = spine.use_cases.length + spine.functions.length + spine.nfrs.length + spine.business_rules.length > 0
  if (done.has(CROSS_CHECK_STEP) || !hasContent) return null
  await guard()
  const crossStarted = Date.now()
  const now = await loadSpine(projectId)
  const cross = await withMeteredAi<FindingsOutput>({ projectId, userId, stepId: CROSS_CHECK_STEP }, ActionType.IMPORT_CROSS_CHECK, {
    projection: crossProjection(now, scope.sectionOf),
    glossary,
    raised: raisedText(now)
  })
  console.info(`[I-1.11] import ${importId}: kiểm chéo xong sau ${Date.now() - crossStarted} ms, 1 lượt AI`)
  if (!cross.ok) return cross
  await applyFindings(projectId, cross.data.findings, "AI cross-section check (1.11)")
  return null
}

/** Gọi trước mỗi lượt AI và trước khi chuyển trạng thái: lần chạy nền đã hết giờ / bị thay ⇒ ném lỗi để dừng (FLF-391). */
type CheckGuard = () => Promise<void>
const noGuard: CheckGuard = async () => undefined

/**
 * Chạy 1.11 (phần chưa xong) rồi 1.12, chuyển `gap_review`. Trả `false` khi phải dừng (paused).
 */
export const runImportCheck = async (doc: IImportedDocument, userId: string, guard: CheckGuard = noGuard): Promise<boolean> => {
  const projectId = String(doc.projectId)
  doc.paused = null
  await doc.save()

  const done = new Set<string>(
    await Usage.find({ projectId, step_id: { $regex: /^I-1\.11(:|$)/ }, state: "deducted" }).distinct("step_id")
  )
  // FLF-411 (U1-8): khung mẫu (chữ là hướng dẫn / ví dụ, Spine không nhận nội dung) ⇒ không có gì để AI đối chiếu, không trừ credit
  // FLF-454: file chưa đủ cấu trúc đích không chạy 1.9, không trừ credit
  if (!done.has(SEMANTIC_CHECK_STEP) && !(await isTemplateOnlyProject(projectId)) && !(await lacksTargetStructure(projectId))) {
    const failure = await runSemanticCheck(projectId, String(doc._id), userId, done, guard)
    if (failure) {
      doc.paused = { reason: failure.reason, at: new Date() }
      await doc.save()
      return false
    }
  }

  // BPMN 1.12: S-9.1 + S-9.2 bằng luật code trên baseline v0 ⇒ bật luật S-9 (`atBaseline`: giả định chưa xác nhận)
  await guard()
  await flagsService.recompute(projectId, { by: "import", ruleProfile: await mode1RuleProfileFor(projectId), atBaseline: true })
  await transitionImport(doc, "gap_review")
  return true
}

/**
 * FLF-343: ước tính lượt AI của bước kiểm tra (1.11) cho màn báo credit một lần sau upload — cùng cách chia lô của lượt chạy
 * (`semanticBatches` trên block chữ, section hiện tại) + một lượt kiểm chéo. Là cận trên: sau finalize section tạm
 * (`function:@B0012`) đổi sang id thật ngắn hơn nên số lô không tăng; tài liệu không có phần tử nào thì lượt kiểm chéo không chạy.
 */
export const estimateCheckCalls = async (projectId: string): Promise<{ batches: number; calls: number; credits: number }> => {
  // FLF-411 (U1-8): khung mẫu không chạy 1.11 (`runImportCheck`) ⇒ màn đọc khung không báo "Dự kiến ~6 credit"
  if (await isTemplateOnlyProject(projectId)) return { batches: 0, calls: 0, credits: 0 }
  // FLF-454: file chưa đủ cấu trúc đích ⇒ 1.9 không chạy, không báo credit
  if (await lacksTargetStructure(projectId)) return { batches: 0, calls: 0, credits: 0 }
  const { blocks, scope } = await loadCheckInput(projectId)
  const batches = semanticBatches(blocks, SEMANTIC_BATCH_CHARS, scope).length
  const [batchCost, crossCost] = await Promise.all([getActionCost(ActionType.IMPORT_SEMANTIC_CHECK), getActionCost(ActionType.IMPORT_CROSS_CHECK)])
  return { batches, calls: batches + 1, credits: batches * batchCost + crossCost }
}

export const countOpenFlags = (flags: Flag[]): { red: number; yellow: number } => {
  const open = flags.filter((f) => f.resolved_at === null)
  return { red: open.filter((f) => f.level === "red").length, yellow: open.filter((f) => f.level === "yellow").length }
}
