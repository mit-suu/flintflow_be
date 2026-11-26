/** P08 (upload U2-7): CR đổi tên hệ thống ⇒ chỉ chạm tên hệ thống + nơi nhắc tên. */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { systemRenameLocations, systemRenameTarget } from "./spine-location.js"

const spine = (): Spine => {
  const s = createEmptySpine({ name: "TechMart" })
  s.project.system_name = "TechMart"
  s.project.vision = "TechMart lets shoppers buy electronics online."
  s.actors.push({ id: "A01", name: "Shopper", kind: "human", description: "Buys products on TechMart." } as never)
  s.use_cases.push({ id: "UC-01", name: "Browse product catalog", actor_ids: ["A01"], function_ids: [], description: "List products by category.", includes: [], extends: [] } as never)
  s.nfrs.push({ id: "NFR-01", category: "performance", kind: "quantitative", statement: "Product search responds within 2 seconds.", metric: "response time", threshold: "2 s", priority: null } as never)
  return s
}

describe("systemRenameTarget", () => {
  it("nhận câu đổi tên hệ thống (VI / EN), trả tên mới", () => {
    expect(systemRenameTarget("Đổi tên hệ thống thành TechMart Store")).toBe("TechMart Store")
    expect(systemRenameTarget("đổi tên ứng dụng thành “BarberGo Pro”.")).toBe("BarberGo Pro")
    expect(systemRenameTarget("Rename the system to TechMart Store")).toBe("TechMart Store")
  })
  it("CR khác hoặc đổi tên kèm việc khác ⇒ null", () => {
    expect(systemRenameTarget("Đổi tên actor Shopper thành Customer")).toBeNull()
    expect(systemRenameTarget("Thêm chức năng so sánh sản phẩm")).toBeNull()
    expect(systemRenameTarget("Đổi tên hệ thống thành TechMart Store và thêm màn so sánh")).toBeNull()
  })
})

describe("systemRenameLocations", () => {
  it("chỉ project + phần tử nhắc tên hệ thống (≤ 2 phần), không kéo use case / NFR không dính tên", () => {
    const found = systemRenameLocations(spine(), "TechMart")
    expect(found.map((f) => f.path)).toEqual(["project", "actors[id=A01]"])
    expect(found.length).toBeLessThanOrEqual(2)
  })
})

describe("systemRenameLocations + sơ đồ gốc", () => {
  it("file có sơ đồ ngữ cảnh gốc ở §1 ⇒ thêm vị trí vẽ lại hình", async () => {
    const { withOriginalDiagrams } = await import("./spine-location.js")
    const s = spine()
    s.custom_sections.push({ id: "CS01", heading: "Context diagram", level: 2, source: "import", blocks: [{ kind: "image", text: null, rows: null, image_ref: "word/media/image1.png", diagram: { kind: "context", source_hash: "x" } } as never] })
    const found = withOriginalDiagrams(s, ["fixed:1", "fixed:2.2.1"], systemRenameLocations(s, "TechMart"))
    expect(found.map((f) => f.path)).toEqual(expect.arrayContaining(["project", "custom_sections[id=CS01]"]))
  })
})

describe("FLF-480 (P09 #5): CR xoá phần tử theo mã", () => {
  it("removeElementTarget nhận câu xoá đứng riêng, trả mã", async () => {
    const { removeElementTarget } = await import("./spine-location.js")
    expect(removeElementTarget("Bỏ quy tắc BR-03")).toBe("BR-03")
    expect(removeElementTarget("Xoá use case UC-09.")).toBe("UC-09")
    expect(removeElementTarget("Remove BR-03")).toBe("BR-03")
    expect(removeElementTarget("Bỏ quy tắc BR-03 và thêm quy tắc mới")).toBeNull()
    expect(removeElementTarget("Thêm quy tắc BR-03")).toBeNull()
  })
  it("removeElementLocations: phần tử + nơi tham chiếu / nhắc mã, không kéo phần tử không liên quan", async () => {
    const { removeElementLocations } = await import("./spine-location.js")
    const s = spine()
    s.business_rules.push({ id: "BR-03", statement: "Giá không âm", description: "" } as never)
    s.business_rules.push({ id: "BR-04", statement: "Giỏ hàng tối đa 50 món", description: "" } as never)
    s.functions.push({ id: "FR-01", name: "Thêm giỏ", description: "Theo BR-03", normal: [], abnormal: [], validations: [], business_rule_ids: ["BR-03"], priority: null } as never)
    const paths = removeElementLocations(s, "BR-03").map((f) => f.path)
    expect(paths).toContain("business_rules[id=BR-03]")
    expect(paths).toContain("functions[id=FR-01]")
    expect(paths).not.toContain("business_rules[id=BR-04]")
    expect(paths).not.toContain("nfrs[id=NFR-01]")
    expect(removeElementLocations(s, "BR-99")).toEqual([])
  })
})
