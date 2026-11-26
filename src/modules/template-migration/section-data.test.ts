import { describe, expect, it } from "vitest"
import { sectionDataOf, sectionItemsOf, spineFilled, type SectionDataSpine } from "./section-data.js"

const spine = {
  custom_sections: [{ id: "c1", heading: "Ghi chú", level: 1, blocks: [{ kind: "paragraph", text: "Đoạn một", rows: null, image_ref: null }] }],
  project: { vision: "Chợ trực tuyến cho người bán nhỏ", goals: ["Đặt hàng trong 3 bước", "Mở shop trong một ngày"], release_scope: { in: ["Giỏ hàng"], out: [] }, form_factor: [] },
  business_rules: [{ id: "BR-01", tier: "high", statement: "Mỗi đơn chỉ thuộc một shop", source_validation_ids: [] }],
  actors: [{ id: "A01", name: "Cổng thanh toán", kind: "system" }],
  nfrs: [
    { id: "NFR-01", category: "reliability", statement: "Tự thử lại khi lỗi", kind: "descriptive", priority: null },
    { id: "NFR-02", category: "performance", statement: "Phản hồi dưới 2 giây", kind: "quantitative", priority: null }
  ],
  assumptions: [],
  other_requirements: [{ id: "OR-01", kind: "risk", statement: "Đơn vị vận chuyển chậm cập nhật" }],
  common_requirements: [],
  diagrams: [],
  messages: [],
  functions: [],
  features: []
} as unknown as SectionDataSpine

describe("section-data", () => {
  it("phần nhỏ của project: tầm nhìn, mục tiêu, phạm vi", () => {
    expect(sectionItemsOf("slot:vision", spine).map((i) => i.text)).toEqual(["Chợ trực tuyến cho người bán nhỏ"])
    expect(sectionItemsOf("slot:goals", spine)).toHaveLength(2)
    expect(sectionItemsOf("slot:scope", spine)).toHaveLength(1)
  })

  it("mục khung: phần tử Spine, NFR lọc theo nhóm của mục", () => {
    expect(sectionItemsOf("fixed:4.2.2", spine).map((i) => i.id)).toEqual(["NFR-01"])
    expect(sectionItemsOf("slot:risks", spine).map((i) => i.id)).toEqual(["OR-01"])
  })

  it("mục chữ tự do: đoạn văn của mục riêng", () => {
    expect(sectionItemsOf("custom:c1", spine).map((i) => i.text)).toEqual(["Đoạn một"])
  })

  it("sectionDataOf: cỡ + mẫu nội dung + phần tử có mã", () => {
    const data = sectionDataOf("fixed:1", spine)
    expect(data.size).toBe(5)
    expect(data.sample).toContain("Chợ trực tuyến")
    expect(data.items?.map((i) => i.id)).toEqual(["BR-01", "A01"])
  })

  it("spineFilled: có dữ liệu ⇒ true; phần nhỏ trống ⇒ false", () => {
    expect(spineFilled("slot:vision", spine)).toBe(true)
    expect(spineFilled("slot:assumptions", spine)).toBe(false)
    expect(spineFilled("slot:references", { ...spine, references: [] } as SectionDataSpine)).toBe(false)
  })
})
