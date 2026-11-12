import { describe, expect, it } from "vitest"
import {
  DEFAULT_PRIMARY_COLOR,
  domainFromText,
  normalizeDomain,
  resolvePlatforms,
  resolveScreenTheme,
  screenMockupsOf,
  screenThemeOf
} from "./screen-theme.js"

describe("normalizeDomain", () => {
  it.each([
    ["techmart.vn", "techmart.vn"],
    ["https://TechMart.vn/", "techmart.vn"],
    ["http://shop.example.com:8080/cart?x=1", "shop.example.com"],
    ["  www.techmart.vn.  ", "www.techmart.vn"]
  ])("%j ⇒ %j", (raw, host) => expect(normalizeDomain(raw)).toBe(host))

  it.each(["", "localhost", "not a domain", "-bad.com", "a..b", "x.1"])("%j ⇒ null", (raw) => expect(normalizeDomain(raw)).toBeNull())

  it("dài hơn 253 ký tự ⇒ null", () => expect(normalizeDomain(`${"a".repeat(60)}.`.repeat(5) + "com")).toBeNull())
})

describe("screenThemeOf", () => {
  it("dự án cũ không field ⇒ mọi field null", () => {
    expect(screenThemeOf({})).toEqual({ primaryColor: null, domain: null, platforms: null })
    expect(screenThemeOf(null)).toEqual({ primaryColor: null, domain: null, platforms: null })
  })

  it("giá trị sai kiểu bị bỏ, màu viết hoa, nền tảng giữ thứ tự web → mobile", () => {
    expect(screenThemeOf({ screenTheme: { primaryColor: "#3f5591", domain: "Shop.VN", platforms: ["mobile", "tv", "web"] } })).toEqual({
      primaryColor: "#3F5591",
      domain: "shop.vn",
      platforms: ["web", "mobile"]
    })
    expect(screenThemeOf({ screenTheme: { primaryColor: "red", domain: 42, platforms: [] } })).toEqual({ primaryColor: null, domain: null, platforms: null })
  })
})

describe("resolvePlatforms", () => {
  it("theme chọn tay thắng form_factor", () => {
    expect(resolvePlatforms({ platforms: ["mobile"] }, ["web_app"])).toEqual(["mobile"])
  })

  it.each([
    [["web_app"], ["web"]],
    [["mobile_app"], ["mobile"]],
    [["mobile_app", "web_app"], ["web", "mobile"]],
    [["Mobile application (iOS, Android)"], ["mobile"]],
    [["api_service"], ["web"]],
    [[], ["web"]]
  ])("form_factor %j ⇒ %j", (ff, expected) => expect(resolvePlatforms({ platforms: null }, ff)).toEqual(expected))

  it("resolveScreenTheme: màu null ⇒ màu mặc định", () => {
    expect(resolveScreenTheme(undefined, ["web_app"])).toEqual({ primaryColor: DEFAULT_PRIMARY_COLOR, domain: null, platforms: ["web"] })
  })
})

describe("domainFromText", () => {
  it("host xuất hiện nhiều nhất, bỏ host phổ biến và www.", () => {
    const text = [
      "Website: https://www.techmart.vn/home",
      "Reference: https://www.w3.org/TR/WCAG21/ and https://github.com/x/y and https://github.com/a",
      "Login at https://techmart.vn/login, admin at https://admin.techmart.vn",
      "See https://docs.google.com/document/d/1"
    ].join("\n")
    expect(domainFromText(text)).toBe("techmart.vn")
  })

  it("không có URL sản phẩm ⇒ null", () => {
    expect(domainFromText("See https://en.wikipedia.org/wiki/SRS and https://example.com")).toBeNull()
    expect(domainFromText("No links here, techmart.vn without scheme")).toBeNull()
  })

  it("hoà ⇒ host gặp trước", () => {
    expect(domainFromText("https://alpha.vn https://beta.vn")).toBe("alpha.vn")
  })
})

describe("screenMockupsOf", () => {
  it("bỏ phần tử sai, lọc index âm / không nguyên", () => {
    expect(
      screenMockupsOf({
        screenMockups: [
          { screen_id: "S01", mode: "original", enabled: true, image_indexes: [0, 2, -1, 1.5] },
          { screen_id: "S02", mode: "weird", enabled: true },
          { mode: "system" }
        ]
      })
    ).toEqual([{ screen_id: "S01", mode: "original", enabled: true, image_indexes: [0, 2] }])
  })
})
