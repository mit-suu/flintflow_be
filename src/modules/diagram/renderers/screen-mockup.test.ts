import { DOMParser } from "@xmldom/xmldom"
import { describe, expect, it } from "vitest"
import { checkScene } from "../../../shared/diagram/svg-geometry.js"
import { SVG_ELEMENT_WHITELIST } from "../../../shared/diagram/svg-scene.js"
import type { ResolvedScreenTheme, ScreenPlatform } from "../../../shared/diagram/screen-theme.js"
import type { ScreenBlock, ScreenSpec } from "../screen-spec.js"
import { SAMPLE_SPECS, SIGNUP_SPEC } from "../screen-spec.samples.js"
import { MOCKUP_MARGIN, renderScreenMockup, screenSpecOf, type MockupInput } from "./screen-mockup.js"
import { contrast, fit, paletteOf, wrap, WHITE } from "./screen-mockup-style.js"
import { textWidth } from "../../../shared/diagram/svg-kit.js"

const THEME: ResolvedScreenTheme = { primaryColor: "#3F5591", domain: "techmart.vn", platforms: ["web", "mobile"] }
const PLATFORMS: ScreenPlatform[] = ["web", "mobile"]

const input = (spec: ScreenSpec, platform: ScreenPlatform, theme: ResolvedScreenTheme = THEME): MockupInput => ({
  spec,
  theme,
  platform,
  systemName: "TechMart",
  screenName: "Sign Up",
  title: "Screen Layout - Sign Up",
  contentHash: "abc",
  mode: "system",
  allowedPlatforms: ["web", "mobile"]
})

const svgOf = (i: MockupInput) => renderScreenMockup(i).toSvg(i.title, MOCKUP_MARGIN)

const LONG = "Supercalifragilistic expialidocious label that goes on and on well past any column width"

/** Một block mỗi loại, chữ dài tối đa — mọi block × 2 nền tảng không có lỗi bố cục. */
const EVERY_BLOCK: ScreenBlock[] = [
  { type: "fields", items: [{ label: LONG.slice(0, 60), required: true, placeholder: LONG.slice(0, 60) }, { label: "Role", kind: "select", placeholder: "Admin" }, { label: "Bio", kind: "textarea" }, { label: "Password", kind: "password" }, { label: "Born", kind: "date", placeholder: "DD/MM/YYYY" }] },
  { type: "checkbox", label: LONG.slice(0, 60) },
  { type: "checkbox", label: "Notify me by", options: ["Email", "SMS", "Push notification"] },
  { type: "radio", label: "Delivery", options: ["Standard", LONG.slice(0, 60)] },
  { type: "buttons", items: [{ label: "Save changes", primary: true }, { label: "Cancel" }, { label: LONG.slice(0, 40) }, { label: "Delete" }] },
  { type: "link", text: LONG.slice(0, 60) },
  { type: "text", text: `${LONG} ${LONG}`.slice(0, 120), strong: true },
  { type: "search", placeholder: LONG.slice(0, 60), button: "Search" },
  { type: "inline", placeholder: "Voucher code", button: "Apply" },
  { type: "items", items: [{ name: LONG.slice(0, 60), meta: LONG.slice(0, 60), price: "999,999,999,999 VND", qty: 999 }, { name: "AirPods" }] },
  { type: "table", columns: ["SKU", "Product name", "Category", "In stock", "Status", "Updated"], rows: [["SS-S24-128", LONG.slice(0, 40), "Phones", "12", "Available", "01/11/2026"]] },
  { type: "summary", rows: [["Subtotal", "29,970,000 VND"], [LONG.slice(0, 60), LONG.slice(0, 40), true]] },
  { type: "image", label: "Store location map" }
]

describe("renderScreenMockup - bố cục", () => {
  it.each(PLATFORMS)("mọi loại block, chữ dài (%s) ⇒ checkScene không lỗi", (platform) => {
    for (const extra of [{}, { popup: true }, { tabs: ["Profile", "Security", LONG.slice(0, 24)], nav: ["Home", "Orders", "Cart", "Account", "Help", "More"], back: true }]) {
      for (const columns of [1, 2, 3] as const) {
        const spec: ScreenSpec = { title: LONG.slice(0, 60), path: "/very/long/path/that/keeps/going/and/going/forever", platforms: PLATFORMS, columns, blocks: EVERY_BLOCK, ...extra }
        const issues = checkScene(renderScreenMockup(input(spec, platform)), { allowBends: true })
        expect(issues.map((i) => i.message), JSON.stringify({ platform, extra, columns })).toEqual([])
      }
    }
  })

  it.each(Object.entries(SAMPLE_SPECS))("spec mẫu %s ⇒ không lỗi trên mọi nền tảng của nó", (_name, spec) => {
    for (const platform of spec.platforms) expect(checkScene(renderScreenMockup(input(spec, platform)), { allowBends: true })).toEqual([])
  })

  it("web: thanh địa chỉ https://domain + path; domain trống ⇒ chỉ path", () => {
    expect(svgOf(input(SIGNUP_SPEC, "web"))).toContain(">https://techmart.vn/signup<")
    const bare = svgOf(input(SIGNUP_SPEC, "web", { ...THEME, domain: null }))
    expect(bare).toContain(">/signup<")
    expect(bare).not.toContain("https://")
  })

  it("mobile: khung điện thoại tối thiểu 760 cao, app bar mang tên màn; web mang tên hệ thống", () => {
    const mobile = svgOf(input(SIGNUP_SPEC, "mobile"))
    const height = Number(/<svg[^>]*height="(\d+)"/.exec(mobile)?.[1])
    expect(height).toBeGreaterThanOrEqual(760)
    expect(mobile).toContain(">Sign Up<")
    expect(svgOf(input(SIGNUP_SPEC, "web"))).toContain(">TechMart<")
  })

  it("màu chính đi vào header và nút chính; màu sáng (vàng) ⇒ chữ trên nền màu chính là đen, chữ nhấn đủ tương phản", () => {
    const svg = svgOf(input(SIGNUP_SPEC, "web", { ...THEME, primaryColor: "#E4572E" }))
    expect(svg).toContain('fill="#E4572E"')
    const yellow = paletteOf("#FFD400")
    expect(yellow.onPrimary).toBe("#000000")
    expect(contrast(yellow.onPrimary, "#FFD400")).toBeGreaterThanOrEqual(4.5)
    expect(contrast(yellow.accent, WHITE)).toBeGreaterThanOrEqual(4.5)
    // Màu đậm ⇒ chữ trắng
    expect(paletteOf("#3F5591").onPrimary).toBe("#FFFFFF")
  })
})

describe("renderScreenMockup - an toàn + metadata", () => {
  const HOSTILE = `</metadata><script>alert(1)</script>"&'`

  it("chữ của model chứa thẻ ⇒ escape, SVG chỉ có phần tử whitelist, spec đọc lại nguyên vẹn", () => {
    const spec: ScreenSpec = { ...SIGNUP_SPEC, title: HOSTILE, blocks: [{ type: "link", text: HOSTILE }] }
    const svg = svgOf(input(spec, "web"))
    const errors: string[] = []
    const doc = new DOMParser({ errorHandler: (level: string, msg: string) => void (level !== "warning" && errors.push(msg)) }).parseFromString(svg, "image/svg+xml")
    expect(errors).toEqual([])
    const all = doc.getElementsByTagName("*")
    expect(Array.from({ length: all.length }, (_, i) => all.item(i)?.nodeName ?? "").every((n) => SVG_ELEMENT_WHITELIST.has(n))).toBe(true)
    expect(svg).not.toContain("<script")
    expect(screenSpecOf(svg)?.spec.title).toBe(HOSTILE)
  })

  it("screenSpecOf: spec, hash, kiểu, nền tảng của hình, phạm vi lúc vẽ; SVG khác / hỏng ⇒ null", () => {
    const stored = screenSpecOf(svgOf(input(SIGNUP_SPEC, "mobile")))
    expect(stored).toEqual({ spec: SIGNUP_SPEC, contentHash: "abc", mode: "system", allowed: ["web", "mobile"], platform: "mobile" })
    expect(screenSpecOf("<svg/>")).toBeNull()
    expect(screenSpecOf('<metadata id="ff-screen-spec">{not json</metadata>')).toBeNull()
    expect(screenSpecOf('<metadata id="ff-screen-spec">{"v":1,"spec":{"title":"x"},"content_hash":"a","mode":"system"}</metadata>')).toBeNull()
  })

  it("tất định: cùng đầu vào ⇒ cùng markup", () => {
    expect(svgOf(input(SAMPLE_SPECS.cart, "mobile"))).toBe(svgOf(input(SAMPLE_SPECS.cart, "mobile")))
  })
})

describe("screen-mockup-style", () => {
  it("fit: vừa ⇒ giữ; dài ⇒ cắt `...` trong bề rộng; quá hẹp ⇒ rỗng", () => {
    expect(fit("Log in", 15, 200)).toBe("Log in")
    const cut = fit(LONG, 15, 120)
    expect(cut.endsWith("...")).toBe(true)
    expect(textWidth(cut, 15)).toBeLessThanOrEqual(120)
    expect(fit(LONG, 15, 5)).toBe("")
  })

  it("wrap: ngắt theo từ, quá số dòng ⇒ dòng cuối cắt `...`", () => {
    const lines = wrap(`${LONG} ${LONG}`, 15, 200, 2)
    expect(lines).toHaveLength(2)
    expect(lines[1].endsWith("...")).toBe(true)
    for (const l of lines) expect(textWidth(l, 15)).toBeLessThanOrEqual(200)
    expect(wrap("Short text", 15, 200, 3)).toEqual(["Short text"])
  })
})
