/**
 * Finalize (nút 1.10) — phần hàm thuần mà `finalize.service.ts` ghép lại: field đã xác nhận ⇒ thực thể ⇒ op
 * một lô, section tạm ⇒ id thật. Plan §8.2 `finalize.test.ts`. FLF-172 P4.
 * Transaction `by: import`, FieldAnchor, DocVersion 0.0, baseline `imported` (cần Mongo) ở
 * `test/integration/mode1/finalize.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { planTransaction } from "../spine/op-engine.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import { collectEntities, realSectionId, resolveProvisional } from "./extracted-entities.js"
import type { ExtractedField } from "./extraction-draft.model.js"
import { needsConfirm } from "./import.constants.js"
import { buildImportOps } from "./spine-builder.js"

const field = (path: string, value: unknown, confidence = 0.9, confirmed = false, extra: Partial<ExtractedField> = {}): ExtractedField => ({
  path,
  value,
  confidence,
  source_block_ids: ["B0005"],
  origin: "ai",
  confirmed,
  ...extra
})

/** Cùng điều kiện lọc với `finalizeImport`: đã xác nhận hoặc không cần xác nhận (độ tin ≥ 0.7, không đọc từ ảnh). */
const acceptedOf = (fields: ExtractedField[]) => fields.filter((f) => f.confirmed || !needsConfirm(f))

describe("finalize — field ⇒ thực thể ⇒ op", () => {
  it("field độ tin thấp chưa xác nhận bị bỏ; đã xác nhận (kể cả độ tin thấp) được ghi; edited_value thắng", () => {
    const fields = [
      field("actors[id=A01].name", "Learner"),
      field("actors[id=A01].description", "đoán", 0.4),
      field("functions[id=FR-3.2.1].trigger", "Learner submits", 0.5, true, { edited_value: "Learner clicks Log in" })
    ]
    const entities = [...collectEntities(acceptedOf(fields)).values()]
    expect(entities.map((e) => [e.entity, e.id, e.value])).toEqual([
      ["actors", "A01", { name: "Learner" }],
      ["functions", "FR-3.2.1", { trigger: "Learner clicks Log in" }]
    ])
  })

  it("ngưỡng 0.7 đúng biên: 0.7 được nhận, 0.69 bị bỏ", () => {
    expect(acceptedOf([field("actors[id=A01].name", "x", 0.7), field("actors[id=A02].name", "y", 0.69)]).map((f) => f.path)).toEqual(["actors[id=A01].name"])
  })

  it("phase 5: field đọc từ ảnh (origin vision) chưa xác nhận bị bỏ dù độ tin 0.7; xác nhận rồi thì ghi", () => {
    const v = (path: string, confirmed: boolean) => field(path, "Guest", 0.7, confirmed, { origin: "vision" })
    expect(acceptedOf([v("actors[id=A08].name", false), v("actors[id=A09].name", true)]).map((f) => f.path)).toEqual(["actors[id=A09].name"])
  })

  it("phase 5: danh sách tham chiếu từ nhiều nguồn gộp hợp (bảng + ảnh); field khác lấy giá trị sau", () => {
    const fields = [
      field("use_cases[id=UC-02].actor_ids", ["A01", "Guest"], 0.7, true, { origin: "vision" }),
      field("use_cases[id=UC-02].name", "Login", 0.7, true, { origin: "vision" }),
      field("use_cases[id=UC-02].actor_ids", ["A01"]),
      field("use_cases[id=UC-02].name", "Log in")
    ]
    expect([...collectEntities(fields).values()][0].value).toEqual({ actor_ids: ["A01", "Guest"], name: "Log in" })
  })

  it("mọi thực thể thành một lô op duy nhất, chạy khô hợp lệ trên Spine rỗng với by import", () => {
    const fields = [
      field("project.vision", "Lumen is an online learning platform."),
      field("actors[id=A01].name", "Learner"),
      field("actors[id=A01].kind", "human"),
      field("use_cases[id=UC-01].name", "Register account"),
      field("use_cases[id=UC-01].actor_ids", ["Learner"]),
      field("business_rules[id=BR-01].statement", "Passwords must have at least 8 characters.")
    ]
    const spine = createEmptySpine({ name: "Lumen" })
    const ops = buildImportOps(spine, [...collectEntities(acceptedOf(fields)).values()].map((e) => ({ entity: e.entity, id: e.id, value: e.value })))
    expect(ops.length).toBeGreaterThanOrEqual(4)
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import", reason: "Import SRS", step_id: null }, { startSeq: 1 })
    expect(new Set(plan.changes.map((c) => c.by))).toEqual(new Set(["import"]))
    expect(plan.spine.actors.map((a) => a.id)).toEqual(["A01"])
    expect(plan.spine.use_cases[0]).toMatchObject({ id: "UC-01", actor_ids: ["A01"] })
    expect(plan.spine.project.vision).toContain("Lumen")
    // import không đụng steps[] (mode 1 không có quy trình step — xem báo cáo P4)
    expect(plan.spine.steps).toEqual([])
  })

  it("block nguồn gộp theo thực thể (FieldAnchor ghi từ đây)", () => {
    const fields = [field("actors[id=A01].name", "Learner", 0.9, false, { source_block_ids: ["B0005"] }), field("actors[id=A01].kind", "human", 0.9, false, { source_block_ids: ["B0006", "B0005"] })]
    const [e] = collectEntities(fields).values()
    expect([...e.source_block_ids]).toEqual(["B0005", "B0006"])
  })

  it("section tạm của heading feature/function ⇒ id thật cho block/profile", () => {
    const provisional = resolveProvisional([
      { block_id: "B0030", heading_text: "3.2 Authentication", section_id: "feature:@B0030", confidence: 0.85, detected_by: "style", confirmed: false },
      { block_id: "B0031", heading_text: "3.2.1 Register account", section_id: "function:@B0031", confidence: 0.85, detected_by: "style", confirmed: false }
    ])
    expect(realSectionId("feature:@B0030", provisional)).toBe("feature:F-3.2")
    expect(realSectionId("function:@B0031", provisional)).toBe("function:FR-3.2.1")
    expect(realSectionId("function:@B0999", provisional)).toBe("function:@B0999")
  })
})
