import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { getAssetsRoot } from "../../config/paths.js"
import { METRICS_FILE, renderMetricsModule } from "../../scripts/generate-svg-metrics.js"
import { arrowHeadShape, fontAscent, fontDescent, stereotype, textWidth } from "./svg-kit.js"

const fontsDir = path.join(getAssetsRoot(), "fonts")

describe("svg-kit metrics", () => {
  it("bảng width trên đĩa khớp font đóng gói (chạy `npm run svg:metrics` nếu lệch)", () => {
    const onDisk = fs.readFileSync(METRICS_FILE, "utf8").replace(/\r\n/g, "\n")
    expect(onDisk).toBe(renderMetricsModule(fontsDir))
  })

  it("font đóng gói khớp SHA-256 ghi trong assets/fonts/README.md", () => {
    const readme = fs.readFileSync(path.join(fontsDir, "README.md"), "utf8")
    for (const file of ["LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf", "LiberationSans-Italic.ttf"]) {
      const hash = createHash("sha256").update(fs.readFileSync(path.join(fontsDir, file))).digest("hex")
      expect(readme).toContain(`${hash}  ${file}`)
    }
  })
})

describe("textWidth", () => {
  it("đo theo Liberation Sans (metric Arial): 'M' = 1706/2048 em", () => {
    expect(textWidth("M", 2048)).toBe(1706)
    expect(textWidth("", 14)).toBe(0)
  })

  it("chữ đậm rộng hơn, chữ Việt có dấu có trong bảng", () => {
    expect(textWidth("Analyst", 15, true)).toBeGreaterThan(textWidth("Analyst", 15))
    // "ệ" có glyph riêng ⇒ không rơi về width của M
    expect(textWidth("ệ", 2048)).toBeLessThan(1706)
  })

  it("ký tự ngoài bảng ⇒ width của M (ước lượng rộng)", () => {
    expect(textWidth("中", 2048)).toBe(1706)
  })

  it("ascent + descent của font", () => {
    expect(fontAscent(2048)).toBe(1854)
    expect(fontDescent(2048)).toBe(434)
  })
})

describe("arrowHeadShape", () => {
  it("đỉnh nằm ở tip, thân lùi về phía nguồn", () => {
    for (const style of ["open", "classic", "triangle", "diamond", "diamond_filled"] as const) {
      const shape = arrowHeadShape(style, [100, 0], [0, 0])
      expect(shape.points.some(([x, y]) => x === 100 && y === 0)).toBe(true)
      expect(shape.points.every(([x]) => x <= 100)).toBe(true)
    }
    expect(arrowHeadShape("classic", [0, 0], [-10, 0]).filled).toBe(true)
    expect(arrowHeadShape("triangle", [0, 0], [-10, 0])).toMatchObject({ filled: false, closed: true })
    expect(arrowHeadShape("open", [0, 0], [-10, 0]).closed).toBe(false)
  })

  it("stereotype là ASCII thô", () => {
    expect(stereotype("include")).toBe("<<include>>")
  })
})
