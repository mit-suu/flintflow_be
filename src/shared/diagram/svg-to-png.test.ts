import { describe, expect, it } from "vitest"
import { MAX_PNG_PX, MAX_SVG_BYTES, svgToPng } from "./svg-to-png.js"
import { Scene } from "./svg-scene.js"

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const pngSize = (png: Buffer) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) })

const sampleScene = (): Scene => {
  const scene = new Scene()
  scene.rect("E", 0, 0, 160, 54, { name: "Analyst" })
  scene.text("E.name", 80, 32, "Analyst — Quản lý", { owner: "E", bold: true, size: 15 })
  scene.circle("P", 400, 27, 60)
  scene.line("F", [160, 27], [340, 27])
  scene.arrow("F", "classic")
  scene.label("F", "Requirement List")
  return scene
}

describe("svgToPng", () => {
  it("SVG từ Scene có chữ ⇒ PNG hợp lệ, 2x, không cần Chrome / font hệ thống", async () => {
    const svg = sampleScene().toSvg("Sample")
    const png = await svgToPng(svg)
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    const w = Number(/width="(\d+)"/.exec(svg)?.[1])
    const h = Number(/height="(\d+)"/.exec(svg)?.[1])
    expect(pngSize(png)).toEqual({ w: w * 2, h: h * 2 })
  })

  it("chữ thật sự được vẽ (font đóng gói nạp được): PNG có chữ khác PNG không chữ", async () => {
    const withText = new Scene()
    withText.text("T", 100, 40, "Requirement List", { size: 20 })
    // cùng kích thước: chỉ thay chữ bằng chuỗi rỗng
    const a = await svgToPng(withText.toSvg())
    const b = await svgToPng(withText.toSvg().replace(">Requirement List<", "><"))
    expect(a.length).toBeGreaterThan(b.length + 200)
  })

  it("SVG 10000×10000 ⇒ cạnh dài = trần 8192", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="5000" viewBox="0 0 10000 5000"><rect width="10000" height="5000" fill="#fff"/></svg>`
    expect(pngSize(await svgToPng(svg))).toEqual({ w: MAX_PNG_PX, h: MAX_PNG_PX / 2 })
  })

  it("SVG hỏng hoặc quá lớn ⇒ ném", async () => {
    await expect(svgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>`)).rejects.toThrow()
    await expect(svgToPng("not svg")).rejects.toThrow(/width\/height/)
    await expect(svgToPng(`<svg width="1" height="1">${" ".repeat(MAX_SVG_BYTES)}</svg>`)).rejects.toThrow(/svg too large/)
  })

  it("thời gian render: hình mẫu và hình 300 phần tử (ghi số vào báo cáo)", async () => {
    const big = new Scene()
    for (let i = 0; i < 100; i++) {
      const x = (i % 10) * 200
      const y = Math.floor(i / 10) * 120
      big.rect(`R${i}`, x, y, 150, 54)
      big.text(`T${i}`, x + 75, y + 32, `Entity ${i}`, { owner: `R${i}` })
      big.line(`L${i}`, [x + 150, y + 27], [x + 200, y + 27])
    }
    const t0 = performance.now()
    await svgToPng(sampleScene().toSvg())
    const t1 = performance.now()
    await svgToPng(big.toSvg())
    const t2 = performance.now()
    console.info(`[svg-to-png] mẫu: ${(t1 - t0).toFixed(0)} ms, 300 phần tử: ${(t2 - t1).toFixed(0)} ms`)
    expect(t2 - t1).toBeLessThan(5000)
  })
})
