/**
 * Check sau baseline v0 (nút 1.11 AI semantic — vàng, có credit; 1.12 code rule — đỏ/vàng). FLF-171, plan §6 2C.
 * AI lỗi / hết credit ⇒ `paused` ở `checking`; resume chạy lại phần còn thiếu (AI đã chạy xong thì không gọi lại).
 * Cờ AI ghi vào `flags[]` với `rule_id = import_semantic` (không bị recompute đóng), mức vàng.
 */

import { ActionType } from "../../shared/ai/ai-action.types.js"
import type { FindingsOutput } from "../../shared/ai/response-parser.js"
import { applyTransaction } from "../spine/op-engine.js"
import type { Op } from "../spine/op.types.js"
import * as flagsService from "../spine/flags.service.js"
import { listSections } from "../spine/section-registry.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Flag, Spine, SpineRecord } from "../spine/spine.types.js"
import { Usage } from "../spine/usage.model.js"
import { IMPORTED_DOC_VERSION } from "../doc-version/versioning.js"
import { DocBlock } from "./doc-block.model.js"
import { transitionImport } from "./import.service.js"
import type { IImportedDocument } from "./imported-document.model.js"
import { withMeteredAi } from "./metered-ai.js"
import { IMPORT_SEMANTIC_RULE, MODE1_RULE_PROFILE } from "./mode1-rule-profile.js"

export const SEMANTIC_CHECK_STEP = "I-1.11"
const PROJECTION_LIMIT = 12_000
const BLOCKS_LIMIT = 16_000

const truncate = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}\n…(truncated)` : s)

/** Phép chiếu gọn của Spine cho model (không nạp toàn Spine — coding-rules §3.6). */
export const semanticProjection = (spine: Spine): string => {
  const pick = <T extends object>(arr: T[], keys: (keyof T)[]) => arr.map((x) => Object.fromEntries(keys.map((k) => [k, x[k]])))
  return truncate(
    JSON.stringify({
      actors: pick(spine.actors, ["id", "name"]),
      use_cases: pick(spine.use_cases, ["id", "name", "actor_ids"]),
      functions: pick(spine.functions, ["id", "name", "feature_id", "normal", "abnormal"]),
      nfrs: pick(spine.nfrs, ["id", "category", "statement"]),
      business_rules: pick(spine.business_rules, ["id", "statement"])
    }),
    PROJECTION_LIMIT
  )
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
    const message = `[${f.rule}] ${f.message}`
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
    ops.push({ op: "add", path: "flags[]", value: flag, reason: `AI check: ${f.rule}` })
  }
  return ops
}

export const stripRecord = ({ projectId: _p, ...spine }: SpineRecord): Spine => spine

/**
 * Chạy 1.11 (nếu chưa chạy xong) rồi 1.12, chuyển `gap_review`. Trả `false` khi phải dừng (paused).
 */
export const runImportCheck = async (doc: IImportedDocument, userId: string): Promise<boolean> => {
  const projectId = String(doc.projectId)
  doc.paused = null
  await doc.save()

  const semanticDone = await Usage.exists({ projectId, step_id: SEMANTIC_CHECK_STEP, state: "deducted" })
  if (!semanticDone) {
    const record = await spineRepository.get(projectId)
    if (!record) throw new Error("Không tìm thấy Spine của project")
    const spine = stripRecord(record)
    const blocks = await DocBlock.find({ projectId, doc_version: IMPORTED_DOC_VERSION, kind: { $in: ["paragraph", "list_item", "table_cell"] } })
      .sort({ "anchor.ordinal": 1 })
      .select("block_id text section_id")
      .lean()
    const result = await withMeteredAi<FindingsOutput>({ projectId, userId, stepId: SEMANTIC_CHECK_STEP }, ActionType.IMPORT_SEMANTIC_CHECK, {
      section_ids: [...new Set(blocks.map((b) => b.section_id).filter(Boolean))].join(", "),
      projection: semanticProjection(spine),
      blocks: truncate(blocks.map((b) => `[${b.block_id}] (${b.section_id ?? "-"}) ${b.text}`).join("\n"), BLOCKS_LIMIT),
      glossary: JSON.stringify(spine.glossary.map((g) => ({ term: g.term, definition: g.definition })))
    })
    if (!result.ok) {
      doc.paused = { reason: result.reason, at: new Date() }
      await doc.save()
      return false
    }
    const ops = findingOps(spine, result.data.findings, IMPORT_SEMANTIC_RULE)
    if (ops.length) {
      await applyTransaction(projectId, { base_version: spine.spine_version, ops, by: "import", reason: "AI semantic check (1.11)", step_id: null })
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
