/**
 * Check sau baseline v0 (nút 1.11 AI semantic — vàng, có credit; 1.12 code rule — đỏ/vàng). FLF-171, plan §6 2C.
 * 1.11 chạy kiểu map-reduce để đọc hết tài liệu dù dài bao nhiêu (trước đây chỉ 16k ký tự đầu):
 * - map: block chia lô ≤ `SEMANTIC_BATCH_CHARS` theo thứ tự tài liệu, mỗi lô một lượt `IMPORT_SEMANTIC_CHECK` (step
 *   `I-1.11:<n>`) kèm phần Spine của chính các section trong lô — tối đa `PARALLEL_BATCHES` lượt cùng lúc;
 * - reduce: cờ của từng lô áp theo thứ tự lô (`findingOps` bỏ cờ trùng cờ đang mở), rồi một lượt `IMPORT_CROSS_CHECK`
 *   (step `I-1.11:cross`) trên Spine gọn của cả tài liệu tìm lỗi giữa các section mà từng lô không thấy.
 * AI lỗi / hết credit ⇒ `paused` ở `checking`; resume bỏ qua lượt đã trừ credit (usage `deducted` theo step).
 * Cờ AI ghi vào `flags[]` với `rule_id = import_semantic` (không bị recompute đóng), mức vàng.
 */

import { ActionType } from "../../shared/ai/ai-action.types.js"
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
import { IMPORTED_DOC_VERSION } from "../doc-version/versioning.js"
import { DocBlock } from "./doc-block.model.js"
import { chunkBlocks } from "./extract.service.js"
import { idKey } from "./extracted-entities.js"
import { FieldAnchor } from "./field-anchor.model.js"
import type { MentionEntity } from "./import.constants.js"
import { transitionImport } from "./import.service.js"
import type { IImportedDocument } from "./imported-document.model.js"
import { withMeteredAi, type MeteredResult } from "./metered-ai.js"
import { IMPORT_SEMANTIC_RULE, MODE1_RULE_PROFILE } from "./mode1-rule-profile.js"

/** Tiền tố step của 1.11. Usage đúng `I-1.11` (không hậu tố) là lượt đơn của bản cũ — đã xong thì coi như xong cả 1.11. */
export const SEMANTIC_CHECK_STEP = "I-1.11"
export const CROSS_CHECK_STEP = `${SEMANTIC_CHECK_STEP}:cross`
export const semanticBatchStep = (n: number): string => `${SEMANTIC_CHECK_STEP}:${n}`

/** Ngân sách chữ mỗi lô map (~12k token in, GLM còn dư context) và trần một block. */
export const SEMANTIC_BATCH_CHARS = 48_000
const SEMANTIC_BLOCK_CHARS = 6_000
/** Số lượt map gọi cùng lúc — finalize chạy đồng bộ nên không xếp hàng tuần tự từng lô. */
export const PARALLEL_BATCHES = 3
const PROJECTION_LIMIT = 12_000
const CROSS_PROJECTION_LIMIT = 48_000
const RAISED_LIMIT = 8_000
/** Câu NFR / BR / mô tả chức năng trong Spine gọn của lượt kiểm chéo. */
const STATEMENT_CHARS = 200

const truncate = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}\n…(truncated)` : s)
const clip = (s: string): string => (s.length > STATEMENT_CHARS ? `${s.slice(0, STATEMENT_CHARS)}…` : s)

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
}

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
export const semanticBatches = (blocks: readonly CheckBlock[], budget = SEMANTIC_BATCH_CHARS): SemanticBatch[] =>
  chunkBlocks(
    blocks.filter((b) => b.text.trim()).map((b) => ({ ...b, text: `[${b.block_id}] (${b.section_id ?? "-"}) ${b.text}` })),
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

/** Đổi finding của model thành op thêm cờ vàng; section không phân giải được ⇒ `fixed:I`. */
export const findingOps = (spine: Spine, findings: FindingsOutput["findings"], rule: string): Op[] => {
  const sections = new Set(listSections(spine).map((s) => s.id))
  const nextId = flagIdGenerator(spine.flags)
  const open = new Set(spine.flags.filter((f) => f.resolved_at === null && f.rule_id === rule).map((f) => `${f.section_id}|${f.message}`))
  const ops: Op[] = []
  for (const f of findings) {
    const section = sections.has(f.section_id) ? f.section_id : "fixed:I"
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
      target_id: f.block_ids[0] ?? null,
      message,
      remediation_step: "C-1",
      opened_at_version: spine.spine_version + 1,
      resolved_at: null,
      waived_by_user: false,
      waive_reason: null,
      waived_at_version: null
    }
    // Lý do của máy — `section-renderer` INTERNAL_REASON lọc khỏi Record of Changes
    ops.push({ op: "add", path: "flags[]", value: flag, reason: `AI check: ${f.rule}` })
  }
  return ops
}

/**
 * Nhiều nhóm phát hiện (mỗi nhóm một luật) ghi cờ trong CÙNG một lô (FLF-252): id cờ cấp nối tiếp qua các nhóm. Gọi
 * `findingOps` riêng từng nhóm trên cùng Spine thì mỗi lần đếm lại từ cờ có sẵn ⇒ hai cờ trùng id, cả lô bị từ chối
 * ("Mục này đã tồn tại trong tài liệu" lúc tạo bản 0.0 khi vừa có ảnh không đọc được vừa có quyền không khớp màn).
 */
export const findingOpsInOrder = (spine: Spine, groups: readonly { findings: FindingsOutput["findings"]; rule: string }[]): Op[] => {
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

type CheckFailure = Extract<MeteredResult<FindingsOutput>, { ok: false }>

/**
 * 1.11 map + reduce. Trả lượt lỗi (để đặt `paused`) hoặc `null` khi đã xong hết. Lượt đã trừ credit ở lần chạy trước
 * (`done`) không gọi lại; lô xong trước lô lỗi vẫn được ghi cờ.
 */
const runSemanticCheck = async (projectId: string, userId: string, done: ReadonlySet<string>): Promise<CheckFailure | null> => {
  const spine = await loadSpine(projectId)
  const [blocks, anchors, sectioned] = await Promise.all([
    DocBlock.find({ projectId, doc_version: IMPORTED_DOC_VERSION, kind: { $in: ["paragraph", "list_item", "table_cell"] } })
      .sort({ "anchor.ordinal": 1 })
      .select("block_id text section_id mentions")
      .lean<CheckBlock[]>(),
    FieldAnchor.find({ projectId }).select("entity_path block_ids").lean(),
    DocBlock.find({ projectId, doc_version: IMPORTED_DOC_VERSION }).select("block_id section_id").lean()
  ])
  const scope = elementSections(anchors, new Map(sectioned.map((b) => [b.block_id, b.section_id ?? null])))
  const glossary = glossaryText(spine)

  // map: các lô chưa xong, tối đa PARALLEL_BATCHES lượt cùng lúc
  const pending = semanticBatches(blocks).filter((b) => !done.has(b.step_id))
  const results = await runLimited(pending, PARALLEL_BATCHES, (batch) =>
    withMeteredAi<FindingsOutput>({ projectId, userId, stepId: batch.step_id }, ActionType.IMPORT_SEMANTIC_CHECK, {
      section_ids: batch.section_ids.join(", "),
      // Không có anchor (dữ liệu trước FLF-171) ⇒ không biết phần tử thuộc lô nào: gửi đủ như trước, vẫn có trần ký tự
      projection: semanticProjection(spine, anchors.length ? scope.scopeOf(batch) : undefined),
      blocks: batch.lines,
      glossary
    })
  )
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
  const now = await loadSpine(projectId)
  const cross = await withMeteredAi<FindingsOutput>({ projectId, userId, stepId: CROSS_CHECK_STEP }, ActionType.IMPORT_CROSS_CHECK, {
    projection: crossProjection(now, scope.sectionOf),
    glossary,
    raised: raisedText(now)
  })
  if (!cross.ok) return cross
  await applyFindings(projectId, cross.data.findings, "AI cross-section check (1.11)")
  return null
}

/**
 * Chạy 1.11 (phần chưa xong) rồi 1.12, chuyển `gap_review`. Trả `false` khi phải dừng (paused).
 */
export const runImportCheck = async (doc: IImportedDocument, userId: string): Promise<boolean> => {
  const projectId = String(doc.projectId)
  doc.paused = null
  await doc.save()

  const done = new Set<string>(
    await Usage.find({ projectId, step_id: { $regex: /^I-1\.11(:|$)/ }, state: "deducted" }).distinct("step_id")
  )
  if (!done.has(SEMANTIC_CHECK_STEP)) {
    const failure = await runSemanticCheck(projectId, userId, done)
    if (failure) {
      doc.paused = { reason: failure.reason, at: new Date() }
      await doc.save()
      return false
    }
  }

  // BPMN 1.12: S-9.1 + S-9.2 bằng luật code trên baseline v0 ⇒ bật luật S-9 (`atBaseline`: giả định chưa xác nhận)
  await flagsService.recompute(projectId, { by: "import", ruleProfile: MODE1_RULE_PROFILE, atBaseline: true })
  await transitionImport(doc, "gap_review")
  return true
}

export const countOpenFlags = (flags: Flag[]): { red: number; yellow: number } => {
  const open = flags.filter((f) => f.resolved_at === null)
  return { red: open.filter((f) => f.level === "red").length, yellow: open.filter((f) => f.level === "yellow").length }
}
