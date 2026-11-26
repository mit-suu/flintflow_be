/**
 * FLF-480 (B16): "Trước / Sau giống nhau" khi CR chỉ đổi luồng chính / luồng rẽ nhánh / điều kiện kiểm tra / điều
 * kiện bắt đầu của chức năng — `elementText` trước đây chỉ đọc `name`/`description`/… (`BODY_FIELDS`), bỏ qua
 * `normal`/`abnormal`/`validations`/`trigger`.
 */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { locationDisplay, elementText } from "./location-display.js"
import { elementValue, valueText } from "./spine-location.js"

const FN_PATH = "functions[id=FR-01]"

const spine = (): Spine => {
  const s = createEmptySpine({ name: "Lumen" })
  s.functions.push({
    id: "FR-01",
    screen_id: null,
    feature_id: "F-01",
    order: 1,
    name: "Log in",
    trigger: "User clicks Log in.",
    description: "Authenticate the user.",
    normal: ["User enters the email.", "User enters the password.", "System checks the password."],
    abnormal: ["Password is wrong."],
    validations: [{ id: "V1", kind: "format", statement: "Email must be valid." }],
    business_rule_ids: [],
    priority: null
  } as never)
  return s
}

describe("elementText - FLF-480 (B16)", () => {
  it("chức năng: gồm luồng chính / luồng rẽ nhánh / kiểm tra / điều kiện bắt đầu, mỗi bước một dòng, không nối bằng ', '", () => {
    const text = elementText({
      id: "FR-01",
      name: "Log in",
      trigger: "User clicks Log in.",
      description: "Authenticate the user.",
      normal: ["User enters the email.", "User enters the password."],
      abnormal: ["Password is wrong."],
      validations: [{ id: "V1", kind: "format", statement: "Email must be valid." }]
    })
    expect(text).toContain("User enters the email.\nUser enters the password.\nPassword is wrong.")
    expect(text).toContain("Email must be valid.")
    // FLF-480 (B16): nối bằng xuống dòng, không phải ", " — không thừa dấu kiểu "...,"
    expect(text).not.toMatch(/\.,/)
  })

  it("đổi một bước giữa luồng chính (normal[1]) ⇒ elementText khác nhau, chứa đúng bước bị đổi", () => {
    const s = spine()
    const before = elementValue(s, FN_PATH)
    const after = { ...(before as object), normal: ["User enters the email.", "User enters the phone number.", "System checks the password."] }
    expect(elementText(before)).not.toBe(elementText(after))
    expect(elementText(after)).toContain("User enters the phone number.")
    expect(elementText(after)).not.toContain("User enters the password.")
  })

  it("chỉ đổi trigger (điều kiện bắt đầu) ⇒ elementText vẫn khác nhau", () => {
    const s = spine()
    const before = elementValue(s, FN_PATH)
    const after = { ...(before as object), trigger: "User clicks the Log in button on the home page." }
    expect(elementText(before)).not.toBe(elementText(after))
  })
})

describe("locationDisplay - FLF-480 (B16): chức năng đổi luồng chính", () => {
  it("CR chỉ đổi normal[1] ⇒ before !== after, after chứa bước bị đổi, không có '.,'", () => {
    const s = spine()
    const before = elementValue(s, FN_PATH)
    const after = { ...(before as object), normal: ["User enters the email.", "User enters the phone number.", "System checks the password."] }
    const d = locationDisplay(s, FN_PATH, "edit", { old_text: valueText(before), new_text: valueText(after), comment_text: null, spine_ops: [] })
    expect(d.change).toBe("edit")
    expect(d.before).not.toBe(d.after)
    expect(d.after).toContain("User enters the phone number.")
    expect(d.before ?? "").not.toMatch(/\.,/)
    expect(d.after ?? "").not.toMatch(/\.,/)
  })
})
