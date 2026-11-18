import { describe, it, expect } from "vitest"
import { TEMPLATE_FAMILY_STEPS } from "./migrate-template-family.js"
import { normalizeTemplateFamily } from "../modules/import/part-bank.js"

describe("migrate-template-family (FLF-363)", () => {
  it("đổi ieee830 / ieee_features ⇒ ieee29148 ở profile và mẫu tổ chức; filter chỉ khớp giá trị cũ ⇒ chạy lại an toàn", () => {
    expect(TEMPLATE_FAMILY_STEPS.map((s) => s.collection)).toEqual(["templateprofiles", "org_templates"])
    for (const step of TEMPLATE_FAMILY_STEPS) {
      expect(step.filter).toEqual({ template_family: { $in: ["ieee830", "ieee_features"] } })
      expect(step.set).toEqual({ template_family: "ieee29148" })
    }
  })

  it("đọc dữ liệu chưa chạy script vẫn ra nhãn mới", () => {
    expect(normalizeTemplateFamily("ieee830")).toBe("ieee29148")
    expect(normalizeTemplateFamily("ieee_features")).toBe("ieee29148")
    expect(normalizeTemplateFamily("mixed")).toBe("mixed")
    expect(normalizeTemplateFamily(null)).toBe("fpt")
    expect(normalizeTemplateFamily("lạ")).toBe("fpt")
  })
})
