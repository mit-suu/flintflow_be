/**
 * generate-svg-metrics.ts
 * ─────────────────────────────────────────────────────────────────
 * Sinh `src/shared/diagram/svg-kit-metrics.ts` từ font đóng gói `assets/fonts/LiberationSans-{Regular,Bold}.ttf`:
 * đo chữ (svg-kit) và vẽ PNG (resvg) dùng CÙNG một font nên hộp tính ra khớp hình.
 *
 * Chạy lại khi đổi font hoặc `MEASURED_CODES`: npm run svg:metrics
 * `svg-kit-metrics.test.ts` fail nếu bảng trên đĩa lệch với font.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getAssetsRoot } from "../config/paths.js"
import { FONT_FILES } from "../shared/diagram/svg-to-png.js"
import { MEASURED_CODES, readFontMetrics, type FontMetrics } from "../shared/diagram/ttf-metrics.js"

/** Dãy code point liên tiếp ⇒ `[start, w0, w1, …]` cho file ngắn. */
const runs = (advance: Map<number, number>): number[][] => {
  const out: number[][] = []
  let current: number[] | null = null
  let next = -1
  for (const code of [...advance.keys()].sort((a, b) => a - b)) {
    if (current && code === next) current.push(advance.get(code) ?? 0)
    else out.push((current = [code, advance.get(code) ?? 0]))
    next = code + 1
  }
  return out
}

const table = (name: string, m: FontMetrics): string =>
  `export const ${name}: readonly (readonly number[])[] = [\n${runs(m.advance)
    .map((r) => `  [${r.join(",")}]`)
    .join(",\n")}\n]\n`

export const renderMetricsModule = (fontsDir: string): string => {
  const regular = readFontMetrics(fs.readFileSync(path.join(fontsDir, FONT_FILES[0])), MEASURED_CODES)
  const bold = readFontMetrics(fs.readFileSync(path.join(fontsDir, FONT_FILES[1])), MEASURED_CODES)
  return [
    "// Sinh bởi src/scripts/generate-svg-metrics.ts từ assets/fonts/LiberationSans-{Regular,Bold}.ttf — không sửa tay.",
    "// Mỗi dòng: [code point đầu, advance width của code point đó, của code point kế tiếp, …] theo đơn vị font.",
    "",
    `export const UNITS_PER_EM = ${regular.unitsPerEm}`,
    `export const ASCENT = ${regular.ascent}`,
    `export const DESCENT = ${regular.descent}`,
    "",
    table("REGULAR_RUNS", regular),
    table("BOLD_RUNS", bold)
  ].join("\n")
}

export const METRICS_FILE = path.join("src", "shared", "diagram", "svg-kit-metrics.ts")

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(METRICS_FILE, renderMetricsModule(path.join(getAssetsRoot(), "fonts")), "utf8")
  console.log(`✅ Đã ghi ${METRICS_FILE}`)
}
