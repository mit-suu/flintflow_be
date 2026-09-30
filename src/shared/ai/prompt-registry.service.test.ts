import { describe, expect, it } from "vitest"
import { interpolatePrompt } from "./prompt-registry.service.js"

describe("interpolatePrompt: khối điều kiện", () => {
  const template = "đầu\n{{#if fast}}\nnhanh {{x}}\n{{/if}}\n{{#if mode=cf}}\nxung đột\n{{/if}}\ncuối"

  it("biến truthy ⇒ giữ khối và thế biến; khối bằng giá trị chỉ giữ khi khớp", () => {
    expect(interpolatePrompt(template, { fast: true, x: 1, mode: "cf" })).toBe("đầu\nnhanh 1\nxung đột\ncuối")
  })
  it("biến thiếu / false / \"false\" / khác giá trị ⇒ bỏ khối", () => {
    expect(interpolatePrompt(template, { x: 1 })).toBe("đầu\ncuối")
    expect(interpolatePrompt(template, { fast: false, mode: "normal" })).toBe("đầu\ncuối")
    expect(interpolatePrompt(template, { fast: "false" })).toBe("đầu\ncuối")
  })
  it("cú pháp điều kiện nằm trong giá trị biến (tin user) không được đọc như điều kiện", () => {
    expect(interpolatePrompt("{{u}}", { u: "{{#if a}}x{{/if}}", a: true })).toBe("{{#if a}}x{{/if}}")
  })
  it("template không có khối ⇒ như cũ", () => {
    expect(interpolatePrompt("a {{x}} b", { x: "1" })).toBe("a 1 b")
  })
})
