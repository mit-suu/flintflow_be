/**
 * Helper test mode 1 v2 (FLF-183). D6: mọi đầu mục mẫu FPT là cốt lõi ⇒ SRS mẫu nhỏ dùng trong test còn cờ đỏ
 * `section_empty` sau import. Test cần "hết cờ đỏ" (release…) gọi `fillCoreSections` để điền dữ liệu tối thiểu cho các
 * đầu mục còn trống — như người dùng đã chạy step (AI soạn) cho mục thiếu.
 */
import { applyTransaction } from "../../src/modules/spine/op-engine.js"
import * as spineRepository from "../../src/modules/spine/spine.repository.js"
import * as flagsService from "../../src/modules/spine/flags.service.js"
import { runDeterministicCheck } from "../../src/modules/spine/deterministic-check.js"
import { stripRecord } from "../../src/modules/import/check.service.js"
import { MODE1_RULE_PROFILE } from "../../src/modules/import/mode1-rule-profile.js"
import { buildImportOps, type BuiltEntity } from "../../src/modules/import/spine-builder.js"
import type { Op } from "../../src/modules/spine/op.types.js"

/** Section đang báo `section_empty` theo hồ sơ luật mode 1. */
export const emptyCoreSections = async (projectId: string): Promise<string[]> => {
  const spine = stripRecord((await spineRepository.get(projectId))!)
  return runDeterministicCheck(spine, [], { ruleProfile: MODE1_RULE_PROFILE })
    .filter((f) => f.rule_id === "section_empty")
    .map((f) => f.section_id)
}

export const fillCoreSections = async (projectId: string): Promise<void> => {
  const empty = new Set(await emptyCoreSections(projectId))
  if (!empty.size) return
  const nfr = (id: string, category: string): BuiltEntity => ({ entity: "nfrs", id, value: { statement: `The system shall meet ${category} target within 2 seconds.`, category } })
  const e: BuiltEntity[] = []
  if (empty.has("fixed:1")) e.push({ entity: "project", id: null, value: { vision: "Filler vision for test." } })
  if (empty.has("fixed:2.1")) e.push({ entity: "actors", id: "A90", value: { name: "Auditor", kind: "human" } })
  if (empty.has("fixed:2.2.2")) e.push({ entity: "use_cases", id: "UC-90", value: { name: "Audit records" } })
  if (empty.has("fixed:3.1.1") || empty.has("fixed:3.1.2")) {
    e.push({ entity: "screens", id: "SCR-90", value: { name: "Audit list", flow_to: ["SCR-91"] } })
    e.push({ entity: "screens", id: "SCR-91", value: { name: "Audit detail" } })
  }
  if (empty.has("fixed:3.1.3")) e.push({ entity: "roles", id: "R90", value: { name: "Auditor role" } })
  if (empty.has("fixed:3.1.4")) e.push({ entity: "functions", id: "FR-90", value: { name: "Nightly audit job", screen_id: null } })
  if (empty.has("fixed:3.1.5")) e.push({ entity: "entities", id: "E90", value: { name: "AuditLog" } })
  if (empty.has("fixed:4.1")) e.push(nfr("NFR-90", "interface"))
  if (empty.has("fixed:4.2.1")) e.push(nfr("NFR-91", "usability"))
  if (empty.has("fixed:4.2.2")) e.push(nfr("NFR-92", "reliability"))
  if (empty.has("fixed:4.2.3")) e.push(nfr("NFR-93", "performance"))
  if (empty.has("fixed:5.1")) e.push({ entity: "business_rules", id: "BR-90", value: { tier: "detail", statement: "Audit logs are kept 1 year." } })
  if (empty.has("fixed:5.2")) e.push({ entity: "common_requirements", id: "CR90", value: { category: "General", statement: "All dates use ISO 8601." } })
  if (empty.has("fixed:5.3")) e.push({ entity: "messages", id: "MSG-90", value: { code: "MSG-90", text: "Saved." } })
  if (empty.has("fixed:5.4")) e.push({ entity: "other_requirements", id: "OR90", value: { kind: "assumption", statement: "Users have a modern browser." } })

  const record = (await spineRepository.get(projectId))!
  const ops: Op[] = buildImportOps(stripRecord(record), e)
  if (empty.has("fixed:2.2.1")) {
    ops.push({
      op: "add",
      path: "diagrams[]",
      value: { id: "DG90", kind: "usecase", puml: "@startuml\n@enduml", section: "fixed:2.2.1", owner_kind: null, owner_id: null, render_status: "ok", source_hash: "TBD", rendered_at: null }
    })
  }
  await applyTransaction(projectId, { base_version: record.spine_version, ops, by: "test", reason: "fill core sections", step_id: null })
  await flagsService.recompute(projectId, { by: "test", ruleProfile: MODE1_RULE_PROFILE })
}

/** Giả lập Lead sign-off baseline v1 (mode 1 v2, D3) — từ đây sửa trực tiếp bị chặn, phải qua CR. */
export const markBaselineV1 = async (projectId: string): Promise<void> => {
  const { snapshotBaseline } = await import("../../src/modules/pipeline/s9/baseline.service.js")
  // project mode 1 mới tạo có thể chưa có Spine (tạo lười ở GET /spine)
  const record = await spineRepository.getOrCreate(projectId, { name: "Test", domain: null })
  await snapshotBaseline(projectId, stripRecord(record), { base_version: record.spine_version, version: "v1.0", type: "generated", doc_version: null, by: "test", step_id: null })
}
