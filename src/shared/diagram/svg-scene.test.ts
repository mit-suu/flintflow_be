import { DOMParser } from "@xmldom/xmldom"
import { describe, expect, it } from "vitest"
import { Scene, SVG_ELEMENT_WHITELIST } from "./svg-scene.js"

const parse = (svg: string) => {
  const errors: string[] = []
  const doc = new DOMParser({ errorHandler: (level: string, msg: string) => void (level !== "warning" && errors.push(msg)) }).parseFromString(svg, "image/svg+xml")
  return { doc, errors }
}

const elementNames = (svg: string): string[] => {
  const all = parse(svg).doc.getElementsByTagName("*")
  return Array.from({ length: all.length }, (_, i) => all.item(i)?.nodeName ?? "")
}

const HOSTILE = [
  "<script>alert(1)</script>",
  `"/><foreignObject><body onload="x()"/></foreignObject>`,
  "]]><![CDATA[",
  `<!ENTITY xxe SYSTEM "file:///etc/passwd">&xxe;`,
  "tab\u000Bvertical\u0000nul￾",
  "lone \uD800 surrogate \uDFFF",
  "O'Brien & Sons"
]

describe("Scene.toSvg — escape tập trung", () => {
  it.each(HOSTILE)("chữ user %j ⇒ SVG parse được, chỉ có phần tử whitelist", (hostile) => {
    const scene = new Scene()
    scene.rect("E1", 0, 0, 200, 60, { name: hostile })
    scene.text("E1.name", 100, 35, hostile, { owner: "E1" })
    scene.line("F1", [200, 30], [400, 30])
    scene.label("F1", hostile)
    const svg = scene.toSvg(hostile)
    const { errors } = parse(svg)
    expect(errors).toEqual([])
    expect(elementNames(svg).every((n) => SVG_ELEMENT_WHITELIST.has(n))).toBe(true)
    expect(svg).not.toMatch(/<script|<foreignObject|<!ENTITY|\u000B|\u0000/)
  })

  it("giữ nguyên chữ hợp lệ (ký tự Việt, cặp surrogate đúng)", () => {
    const scene = new Scene()
    scene.text("T", 0, 0, "Quản lý 😀")
    const { doc } = parse(scene.toSvg())
    expect(doc.getElementsByTagName("text")[0].textContent).toBe("Quản lý 😀")
  })

  it("màu ngoài dạng hex / none ⇒ ném (không có đường chèn thuộc tính)", () => {
    expect(() => new Scene().rect("R", 0, 0, 1, 1, { fill: `red" onload="x` })).toThrow(/màu/)
  })

  it("trùng id hoặc toạ độ không hữu hạn ⇒ ném", () => {
    const scene = new Scene()
    scene.rect("R", 0, 0, 1, 1)
    expect(() => scene.rect("R", 0, 0, 1, 1)).toThrow(/trùng id/)
    expect(() => scene.rect("Z", 0, 0, 0, 10)).toThrow(/kích thước dương/)
    expect(() => scene.circle("C", 0, 0, 0)).toThrow(/kích thước dương/)
    scene.text("T", Number.NaN, 0, "x")
    expect(() => scene.toSvg()).toThrow(/không hữu hạn/)
  })
})

describe("Scene.toSvg — tất định", () => {
  const build = () => {
    const scene = new Scene()
    scene.rect("A", 10.123456, 20, 150, 54, { name: "Analyst" })
    scene.text("A.name", 85.06, 52, "Analyst", { bold: true, size: 15, owner: "A" })
    scene.circle("P", 400, 47, 40, { name: "System" })
    scene.line("F", [160.123, 47], [360, 47])
    scene.arrow("F", "classic")
    scene.label("F", "Data")
    return scene.toSvg("Context")
  }

  it("cùng lệnh 2 lần ⇒ cùng chuỗi", () => {
    expect(build()).toBe(build())
  })

  it("snapshot nhỏ: nhãn ở lớp trên cùng, số làm tròn 2 chữ số", () => {
    expect(build()).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <svg xmlns="http://www.w3.org/2000/svg" width="470" height="120" viewBox="-10 -13 470 120">
      <title>Context</title>
      <rect x="-10" y="-13" width="470" height="120" fill="#fff"/>
      <rect x="10.12" y="20" width="150" height="54" fill="#7ACFF5" stroke="#000" stroke-width="1.2"/>
      <text x="85.06" y="52" font-family="&apos;Liberation Sans&apos;, Arial, Helvetica, sans-serif" font-size="15" text-anchor="middle" font-weight="bold" fill="#000">Analyst</text>
      <circle cx="400" cy="47" r="40" fill="#7ACFF5" stroke="#000" stroke-width="1.2"/>
      <line x1="160.12" y1="47" x2="360" y2="47" stroke="#000" stroke-width="1.2"/>
      <polygon points="360,47 347,52.5 352.85,47 347,41.5" fill="#000" stroke="#000" stroke-width="0.8" stroke-linejoin="miter"/>
      <rect x="242.33" y="38.5" width="35.46" height="17" fill="#fff"/>
      <text x="260.06" y="47" font-family="&apos;Liberation Sans&apos;, Arial, Helvetica, sans-serif" font-size="13" text-anchor="middle" dominant-baseline="central" fill="#000">Data</text>
      </svg>
      "
    `)
  })
})
