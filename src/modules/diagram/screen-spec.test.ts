import { describe, expect, it } from "vitest"
import { mapSpecText, parseScreenEnvelope, parseScreenSpec, screenSpecErrors, specLabels, type ScreenSpec } from "./screen-spec.js"
import { SAMPLE_SPECS, SIGNUP_SPEC } from "./screen-spec.samples.js"

describe("parseScreenSpec", () => {
  it.each(Object.entries(SAMPLE_SPECS))("spec mẫu %s hợp lệ", (_n, spec) => expect(parseScreenSpec(spec)).toEqual(spec))

  it("spec hợp lệ ⇒ giữ nguyên", () => {
    expect(parseScreenSpec(SIGNUP_SPEC)).toEqual(SIGNUP_SPEC)
  })

  it("platforms ngoài phạm vi dự án ⇒ cắt về phạm vi; cắt hết ⇒ toàn bộ phạm vi", () => {
    expect(parseScreenSpec(SIGNUP_SPEC, ["web"])?.platforms).toEqual(["web"])
    expect(parseScreenSpec({ ...SIGNUP_SPEC, platforms: ["mobile"] }, ["web"])?.platforms).toEqual(["web"])
  })

  it("chữ quá dài bị cắt `...`, không làm hỏng spec; path thiếu `/` được thêm", () => {
    const spec = parseScreenSpec({ ...SIGNUP_SPEC, path: "signup", title: "x".repeat(200) })
    expect(spec?.title).toHaveLength(60)
    expect(spec?.title.endsWith("...")).toBe(true)
    expect(spec?.path).toBe("/signup")
  })

  it.each([
    ["block lạ", { ...SIGNUP_SPEC, blocks: [{ type: "video", url: "x" }] }],
    ["key lạ", { ...SIGNUP_SPEC, color: "#fff" }],
    ["không block", { ...SIGNUP_SPEC, blocks: [] }],
    ["quá 20 block", { ...SIGNUP_SPEC, blocks: Array.from({ length: 21 }, () => ({ type: "link", text: "x" })) }],
    ["columns 4", { ...SIGNUP_SPEC, columns: 4 }],
    ["platforms rỗng", { ...SIGNUP_SPEC, platforms: [] }]
  ])("%s ⇒ null", (_name, value) => {
    expect(parseScreenSpec(value)).toBeNull()
    expect(screenSpecErrors(value).length).toBeGreaterThan(0)
  })
})

describe("parseScreenEnvelope", () => {
  it("model ghi số / boolean dạng chuỗi (TechMart Shopping Cart: qty \"1\") ⇒ vẫn nhận, đổi đúng kiểu; chuỗi không phải số ⇒ null", () => {
    const spec = {
      title: "Shopping Cart",
      path: "/cart",
      platforms: ["web"],
      columns: "1",
      back: "true",
      blocks: [
        { type: "items", items: [{ name: "Galaxy S24 128GB", price: "18,990,000 VND", qty: "1" }, { name: "AirPods Pro 2", qty: "2" }] },
        { type: "summary", rows: [["Total", "29,970,000 VND", "true"]] },
        { type: "buttons", items: [{ label: "Checkout", primary: "true" }] }
      ]
    }
    const parsed = parseScreenEnvelope(JSON.stringify({ spec, screen_images: [0] }))
    expect(parsed?.spec).toMatchObject({
      columns: 1,
      back: true,
      blocks: [{ items: [{ qty: 1 }, { qty: 2 }] }, { rows: [["Total", "29,970,000 VND", true]] }, { items: [{ primary: true }] }]
    })
    expect(parseScreenEnvelope(JSON.stringify({ spec: { ...spec, blocks: [{ type: "items", items: [{ name: "x", qty: "two" }] }] } }))).toBeNull()
  })

  const raw = (v: unknown) => JSON.stringify(v)

  it("envelope đủ: spec + screen_images + primary_color", () => {
    expect(parseScreenEnvelope(raw({ spec: SIGNUP_SPEC, screen_images: [2, 0, 2], primary_color: "#3f5591" }))).toEqual({
      spec: SIGNUP_SPEC,
      screenImages: [2, 0],
      primaryColor: "#3F5591"
    })
  })

  it("chịu code fence json và spec trần", () => {
    expect(parseScreenEnvelope("```json\n" + raw({ spec: SIGNUP_SPEC }) + "\n```")?.spec).toEqual(SIGNUP_SPEC)
    expect(parseScreenEnvelope(raw(SIGNUP_SPEC))?.spec).toEqual(SIGNUP_SPEC)
  })

  it("field phụ sai ⇒ null riêng field đó; spec sai / không phải JSON ⇒ null", () => {
    expect(parseScreenEnvelope(raw({ spec: SIGNUP_SPEC, screen_images: ["a"], primary_color: "blue" }))).toMatchObject({ screenImages: null, primaryColor: null })
    expect(parseScreenEnvelope(raw({ spec: { title: "x" } }))).toBeNull()
    expect(parseScreenEnvelope("@startsalt\n{}\n@endsalt")).toBeNull()
  })
})

describe("chữ hiển thị", () => {
  it("specLabels theo thứ tự trên màn, bỏ trùng", () => {
    expect(specLabels(SIGNUP_SPEC)).toEqual([
      "Create your account",
      "Full name",
      "Nguyen Van An",
      "Email",
      "an.nguyen@example.com",
      "Password",
      "Date of birth",
      "DD/MM/YYYY",
      "I agree to the Terms of Use",
      "Create account",
      "Sign up with Google",
      "Already have an account? Log in"
    ])
  })

  it("mapSpecText giữ cấu trúc, chỉ đổi chữ (kể cả bảng, summary)", () => {
    const spec: ScreenSpec = {
      ...SIGNUP_SPEC,
      nav: ["Home"],
      blocks: [
        { type: "table", columns: ["Name"], rows: [["Galaxy"]] },
        { type: "summary", rows: [["Total", "100", true], ["Tax", "5"]] }
      ]
    }
    const upper = mapSpecText(spec, (s) => s.toUpperCase())
    expect(upper.nav).toEqual(["HOME"])
    expect(upper.blocks).toEqual([
      { type: "table", columns: ["NAME"], rows: [["GALAXY"]] },
      { type: "summary", rows: [["TOTAL", "100", true], ["TAX", "5"]] }
    ])
    expect(parseScreenSpec(upper)).not.toBeNull()
  })
})
