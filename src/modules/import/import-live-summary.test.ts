import { describe, expect, it } from "vitest"
import { FOUND_MAX_NAMES, READING_STALE_MS, isReading, summarizeFound } from "./import-live-summary.js"
import type { IExtractionDraft } from "./extraction-draft.model.js"

type Draft = Parameters<typeof summarizeFound>[0]

const field = (path: string, value: unknown) => ({ path, value, confidence: 0.9, source_block_ids: ["B0001"], origin: "ai" as const, confirmed: false })
const draft = (over: Partial<Draft>): Draft => ({ status: "pending", fields: [], partial: null, diagram_images: [], ...over }) as Draft
const textItem = (entity: string, key: string | null, value: Record<string, unknown>) => ({ entity, key, value, confidence: 0.9, field_confidence: {}, source_block_ids: ["B0001"] })
const partialOf = (raw_steps: unknown[]): IExtractionDraft["partial"] => ({ plan_hash: "h", steps_done: raw_steps.length, raw_steps }) as IExtractionDraft["partial"]

describe("summarizeFound", () => {
  it("mục rỗng ⇒ không có gì", () => {
    expect(summarizeFound(draft({}))).toEqual([])
  })

  it("mục đã ghép: đếm phần tử theo loại, tối đa 3 tên, tên lấy từ field name", () => {
    const fields = ["UC-01", "UC-02", "UC-03", "UC-04"].flatMap((id, i) => [field(`use_cases[id=${id}].name`, `Flow ${i + 1}`), field(`use_cases[id=${id}].description`, "x")])
    fields.push(field("actors[id=A01].name", "Learner"), field("project.name", "Ignored"))
    const found = summarizeFound(draft({ status: "done", fields: fields as Draft["fields"] }))
    expect(found).toEqual([
      { entity: "use_cases", count: 4, names: ["Flow 1", "Flow 2", "Flow 3"] },
      { entity: "actors", count: 1, names: ["Learner"] }
    ])
    expect(FOUND_MAX_NAMES).toBe(3)
  })

  it("mục đã ghép: ưu tiên giá trị người sửa, ảnh sơ đồ đọc được tính là diagram", () => {
    const f = { ...field("actors[id=A01].name", "Old"), edited_value: "Edited" }
    const found = summarizeFound(
      draft({
        status: "done",
        fields: [f] as Draft["fields"],
        diagram_images: [
          { block_id: "B0009", kind: "usecase" },
          { block_id: "B0010", kind: "other" },
          { block_id: "B0011", kind: "failed" }
        ]
      })
    )
    expect(found).toEqual([
      { entity: "actors", count: 1, names: ["Edited"] },
      { entity: "diagram", count: 1, names: ["usecase"] }
    ])
  })

  it("đã đọc chưa ghép: lấy từ output thô; cùng khoá chỉ đếm một lần, không khoá thì dùng name, thiếu tên thì dùng khoá", () => {
    const partial = partialOf([
      { kind: "text", usage_id: "u", data: { section_id: "s", unmapped_block_ids: [], items: [textItem("use_cases", "UC-01", { name: "Log in" }), textItem("actors", null, { name: "Guest" }), textItem("functions", "FR-1", {})] } },
      {
        kind: "image",
        block_id: "B0020",
        status: "read",
        data: { section_id: "s", unmapped_block_ids: [], diagram_kind: "erd", items: [textItem("use_cases", "UC-01", { name: "Log in" }), textItem("entities", "E1", { name: "Course" })] }
      },
      { kind: "image", block_id: "B0021", status: "unavailable" }
    ])
    expect(summarizeFound(draft({ partial }))).toEqual([
      { entity: "use_cases", count: 1, names: ["Log in"] },
      { entity: "actors", count: 1, names: ["Guest"] },
      { entity: "functions", count: 1, names: ["FR-1"] },
      { entity: "diagram", count: 1, names: ["erd"] },
      { entity: "entities", count: 1, names: ["Course"] }
    ])
  })

  it("tên dài bị cắt, chuỗi người dùng giữ nguyên", () => {
    const [g] = summarizeFound(draft({ status: "done", fields: [field("glossary[id=G1].term", "x".repeat(200))] as Draft["fields"] }))
    expect(g.names[0].length).toBeLessThanOrEqual(80)
    const [h] = summarizeFound(draft({ status: "done", fields: [field("actors[id=A1].name", "  Quản trị — viên ")] as Draft["fields"] }))
    expect(h.names).toEqual(["Quản trị — viên"])
  })
})

describe("isReading", () => {
  const now = Date.parse("2026-11-23T10:00:00Z")
  it("đang chạy + dấu mới ⇒ đọc", () => expect(isReading(new Date(now - 5000), true, now)).toBe(true))
  it("không dấu ⇒ không đọc", () => expect(isReading(null, true, now)).toBe(false))
  it("import không còn chạy ⇒ không đọc", () => expect(isReading(new Date(now - 5000), false, now)).toBe(false))
  it("dấu quá cũ ⇒ không đọc", () => expect(isReading(new Date(now - READING_STALE_MS - 1), true, now)).toBe(false))
})
