/**
 * Finalize (nút 1.10) — phần hàm thuần mà `finalize.service.ts` ghép lại: field đã xác nhận ⇒ thực thể ⇒ op
 * một lô, section tạm ⇒ id thật. Plan §8.2 `finalize.test.ts`. FLF-172 P4.
 * Transaction `by: import`, FieldAnchor, DocVersion 0.1, baseline `imported` (cần Mongo) ở
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

describe("finalize - field ⇒ thực thể ⇒ op", () => {
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

  it("FLF-252: thứ tự phần tử theo nơi bảng / chữ định nghĩa - quan hệ từ sơ đồ ở mục trước không kéo use case lên đầu bảng", () => {
    const fields = [
      // 2.2.1: sơ đồ chỉ thêm quan hệ cho UC-03, UC-02
      field("use_cases[id=UC-03].actor_ids", ["Admin"], 0.65, true, { origin: "vision" }),
      field("use_cases[id=UC-02].actor_ids", ["Admin"], 0.65, true, { origin: "vision" }),
      // 2.2.2: bảng use case theo thứ tự tài liệu
      field("use_cases[id=UC-01].name", "Login", 1, false, { origin: "deterministic" }),
      field("use_cases[id=UC-02].name", "Logout", 1, false, { origin: "deterministic" }),
      field("use_cases[id=UC-03].name", "View Profile", 1, false, { origin: "deterministic" }),
      // phần tử chỉ có trong ảnh giữ chỗ nơi ảnh nhắc tới
      field("entities[id=E15].name", "DocChunk", 0.6, true, { origin: "vision" })
    ]
    expect([...collectEntities(fields).values()].map((e) => e.id)).toEqual(["UC-01", "UC-02", "UC-03", "E15"])
  })

  it("FLF-411 (#7): use case chỉ có trên sơ đồ (mục trước bảng) đứng SAU các dòng bảng, giữa chúng theo thứ tự ảnh", () => {
    const fields = [
      // 2.2.1: sơ đồ use case có UC-01…UC-04, chỉ UC-01, UC-02 có dòng trong bảng 2.2.2
      field("use_cases[id=UC-03].name", "Pay", 0.7, false, { origin: "vision" }),
      field("use_cases[id=UC-01].name", "View Menu", 0.7, false, { origin: "vision" }),
      field("use_cases[id=UC-04].name", "Rate", 0.7, false, { origin: "vision" }),
      field("use_cases[id=UC-02].name", "Order a Meal", 0.7, false, { origin: "vision" }),
      field("use_cases[id=UC-01].description", "Patron views the menu", 1, false, { origin: "deterministic" }),
      field("use_cases[id=UC-02].description", "Patron orders", 1, false, { origin: "deterministic" })
    ]
    expect([...collectEntities(fields).values()].map((e) => e.id)).toEqual(["UC-01", "UC-02", "UC-03", "UC-04"])
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

describe("FLF-343 needsReviewFindings - chỗ độ tin thấp vào baseline kèm cờ Cần xem", () => {
  it("field chưa xác nhận cần xem (độ tin < 0.7 / ảnh) + heading / cột tự nhận ⇒ mỗi chỗ một phát hiện, target = đường dẫn / block", async () => {
    const { needsReviewFindings } = await import("./finalize.service.js")
    const drafts = [
      {
        section_id: "fixed:2.1",
        fields: [
          field("actors[id=A01].name", "Learner", 0.95),
          field("actors[id=A01].kind", "human", 0.6),
          field("actors[id=A02].kind", "system", 0.7, false, { origin: "vision" }),
          field("actors[id=A03].kind", "human", 0.5, true)
        ]
      }
    ]
    const profile = {
      heading_map: [
        { block_id: "B0001", heading_text: "2.1 Actors", section_id: "fixed:2.1", confidence: 0.75, detected_by: "numbering_pattern" as const, confirmed: true, auto_confirmed: true },
        { block_id: "B0002", heading_text: "9 Team Notes", section_id: "unmapped", confidence: 0.5, detected_by: "style" as const, confirmed: true, auto_confirmed: true },
        { block_id: "B0003", heading_text: "5.1 Business Rules", section_id: "fixed:5.1", confidence: 0.95, detected_by: "style" as const, confirmed: false }
      ],
      table_map: [
        { block_id: "B0010", column_index: 1, header: "Kind", field_path: "actors[].kind", confidence: 0.6, confirmed: true, auto_confirmed: true },
        { block_id: "B0010", column_index: 2, header: "Note", field_path: null, confidence: 0.4, confirmed: true, auto_confirmed: true }
      ]
    }
    const spine = { ...createEmptySpine(), actors: [{ id: "A01" }, { id: "A02" }] } as unknown as Parameters<typeof needsReviewFindings>[0]
    const out = needsReviewFindings(spine, drafts, profile, [], new Map(), () => "fixed:2.1")
    expect(out.map((f) => [f.section_id, f.target_id])).toEqual([
      ["fixed:2.1", "B0001"],
      ["fixed:I", "B0002"],
      ["fixed:2.1", "B0010"],
      // FLF-411 (U2-5): field đọc bằng chữ gộp theo phần tử, target = đường dẫn phần tử
      ["fixed:2.1", "actors[id=A01]"],
      // FLF-411 (U2-1): field đọc từ ảnh gộp theo ảnh, target = block ảnh
      ["fixed:2.1", "B0005"]
    ])
    expect(out.every((f) => f.message.startsWith("Cần xem:"))).toBe(true)
    expect(out[4].message).toContain("đọc từ ảnh")
  })
})

describe("FLF-411 (U2-1) needsReviewFindings - đọc từ ảnh sơ đồ: một cờ mỗi ảnh, nêu tên phần tử", () => {
  it("nhiều field của nhiều actor trên một ảnh ⇒ một cờ; hai ảnh cùng mục ⇒ hai cờ đánh số; không mã nội bộ, không khoá thô", async () => {
    const { needsReviewFindings } = await import("./finalize.service.js")
    const vision = (path: string, value: unknown, block: string) => field(path, value, 0.7, false, { origin: "vision", source_block_ids: [block] })
    const drafts = [
      {
        section_id: "fixed:1",
        fields: [
          vision("project.system_name", "ShuttleBook", "B0100"),
          vision("actors[id=A02].name", "Customer", "B0100"),
          vision("actors[id=A02].kind", "human", "B0100"),
          vision("actors[id=A02].flows_in", ["Booking info"], "B0100"),
          vision("actors[id=A02].flows_out", ["Booking request"], "B0100"),
          vision("actors[id=A07].kind", "system", "B0100"),
          vision("actors[id=A07].flows_in", ["Payment result"], "B0101")
        ]
      }
    ]
    const spine = {
      ...createEmptySpine(),
      actors: [
        { id: "A02", name: "Customer", flows_in: ["Booking info"], flows_out: ["Booking request"] },
        { id: "A07", name: "Payment Gateway", flows_in: ["Payment result"], flows_out: [] }
      ]
    } as unknown as Parameters<typeof needsReviewFindings>[0]
    const layout = [{ order: 0, heading_text: "Context Diagram", level: 2, section_id: "fixed:1" }]
    const out = needsReviewFindings(spine, drafts, { heading_map: [], table_map: [] }, layout, new Map(), () => null)
    expect(out.map((f) => f.target_id)).toEqual(["B0100", "B0101"])
    expect(out[0].message).toBe(
      'Cần xem: dữ liệu đọc từ ảnh sơ đồ thứ 1 trong mục "Context Diagram" (Tên hệ thống, tác nhân "Customer", tác nhân "Payment Gateway"); đã đưa vào bản 0.1, sai thì sửa bằng change request'
    )
    expect(out[1].message).toContain('ảnh sơ đồ thứ 2 trong mục "Context Diagram" (tác nhân "Payment Gateway")')
    for (const f of out) expect(f.message).not.toMatch(/A0\d|flows_|\[id=/)
  })
})

describe("FLF-411 (U2-5) needsReviewFindings - đọc bằng chữ: một cờ mỗi phần tử, nêu tên và các trường", () => {
  it("nhiều field độ tin thấp của một phần tử ⇒ một cờ; không tên ⇒ trích câu; không mã nội bộ / khoá thô", async () => {
    const { needsReviewFindings } = await import("./finalize.service.js")
    const drafts = [
      {
        section_id: "fixed:5.4",
        fields: [
          field("other_requirements[id=OR-02].category", "legal", 0.69),
          field("other_requirements[id=OR-02].statement", "The system shall keep invoices for 10 years", 0.65)
        ]
      },
      {
        section_id: "fixed:3.1.4",
        fields: [
          field("functions[id=FR-3.2.1].name", "Login", 0.95),
          field("functions[id=FR-3.2.1].trigger", "User clicks Log in", 0.61),
          field("functions[id=FR-3.2.1].description", "Logs the user in", 0.66)
        ]
      }
    ]
    const spine = {
      ...createEmptySpine(),
      other_requirements: [{ id: "OR-02", statement: "The system shall keep invoices for 10 years" }],
      functions: [{ id: "FR-3.2.1", name: "Login" }]
    } as unknown as Parameters<typeof needsReviewFindings>[0]
    const out = needsReviewFindings(spine, drafts, { heading_map: [], table_map: [] }, [], new Map(), () => null)
    expect(out.map((f) => [f.section_id, f.target_id])).toEqual([
      ["fixed:5.4", "other_requirements[id=OR-02]"],
      ["fixed:3.1.4", "functions[id=FR-3.2.1]"]
    ])
    expect(out[0].message).toMatch(/^Cần xem: Yêu cầu khác "The system shall keep invoices for 10 years" - .+, .+ \(độ tin 65%\)/)
    expect(out[1].message).toMatch(/^Cần xem: Chức năng "Login" - .+, .+ \(độ tin 61%\)/)
    for (const f of out) expect(f.message).not.toMatch(/OR-02|FR-3|\[id=|category|trigger/)
  })
})

describe("FLF-361 needsReviewFindings - không hỏi lại chỗ không vào Spine / không còn là đoán", () => {
  it("UC → actor chỉ có trên ảnh đã bỏ (\"User\") ⇒ không cờ; tham chiếu vào được ⇒ có cờ; cấp BR ở 5.1 ⇒ không cờ; mã khác dạng vẫn khớp", async () => {
    const { needsReviewFindings } = await import("./finalize.service.js")
    const drafts = [
      { section_id: "fixed:2.2.1", fields: [field("use_cases[id=UC10].actor_ids", ["A08"], 0.7, false, { origin: "vision" }), field("use_cases[id=UC-11].actor_ids", ["A01", "A08"], 0.7, false, { origin: "vision" })] },
      { section_id: "fixed:5.1", fields: [field("business_rules[id=BR-01].tier", "high", 0.69)] }
    ]
    const spine = {
      ...createEmptySpine(),
      actors: [{ id: "A01" }],
      use_cases: [
        { id: "UC10", actor_ids: [] },
        { id: "UC11", actor_ids: ["A01"] }
      ],
      business_rules: [{ id: "BR-01", tier: "detail" }]
    } as unknown as Parameters<typeof needsReviewFindings>[0]
    const out = needsReviewFindings(spine, drafts, { heading_map: [], table_map: [] }, [], new Map(), () => null)
    // FLF-411 (U2-1): cờ đọc từ ảnh theo ảnh (block B0005), chỉ còn chỗ đã vào Spine
    expect(out.map((f) => f.target_id)).toEqual(["B0005"])
    expect(out[0].message).toContain("(use case UC-11)")
  })
})

describe("FLF-363 titleContentFindings - tiêu đề và nội dung khác nhau", () => {
  it("heading đổi mục theo nội dung ⇒ cờ nêu cả hai mục theo tên mẫu, không mã nội bộ; không thêm cờ Cần xem cho heading đó", async () => {
    const { needsReviewFindings, titleContentFindings } = await import("./finalize.service.js")
    const heading_map = [
      {
        block_id: "B0002",
        heading_text: "Product Perspective",
        section_id: "fixed:2.1",
        confidence: 0.75,
        detected_by: "style" as const,
        confirmed: true,
        auto_confirmed: true,
        content_mismatch: { by_title: "fixed:1", by_content: "fixed:2.1" }
      }
    ]
    const layout = [{ order: 0, heading_text: "Product Perspective", level: 2, section_id: "fixed:2.1" }]
    const spine = createEmptySpine() as unknown as Parameters<typeof titleContentFindings>[0]
    const out = titleContentFindings(spine, heading_map, layout)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ section_id: "fixed:2.1", target_id: "B0002", block_ids: ["B0002"] })
    expect(out[0].message).toContain('Tiêu đề "Product Perspective" giống mục "Product Overview"')
    expect(out[0].message).toContain('nội dung là của mục "Actors"')
    expect(out[0].message).not.toMatch(/fixed:|group:|@B/)
    expect(needsReviewFindings(spine, [], { heading_map, table_map: [] }, layout, new Map(), () => null)).toEqual([])
  })
})

describe("FLF-343 needsReviewFindings - trùng đường dẫn, phần tử bị bỏ", () => {
  it("cùng field ở hai section ⇒ một cờ; phần tử buildImportOps không đưa vào Spine ⇒ không cờ", async () => {
    const { needsReviewFindings } = await import("./finalize.service.js")
    const drafts = [
      { section_id: "fixed:2.1", fields: [field("actors[id=A01].kind", "human", 0.6), field("actors[id=A09].kind", "human", 0.6)] },
      { section_id: "fixed:2.2.1", fields: [field("actors[id=A01].kind", "human", 0.5)] }
    ]
    const spine = { ...createEmptySpine(), actors: [{ id: "A01" }] } as unknown as Parameters<typeof needsReviewFindings>[0]
    const out = needsReviewFindings(spine, drafts, { heading_map: [], table_map: [] }, [], new Map(), () => null)
    expect(out.map((f) => f.target_id)).toEqual(["actors[id=A01]"])
  })
})
