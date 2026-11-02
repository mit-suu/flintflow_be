/**
 * eval-import-match.ts — đo khớp mẫu I-3 của import mode 1 (FLF-343). Không nối Mongo, không gọi AI.
 * ─────────────────────────────────────────────────────────────────
 *   npm run eval:import-match                     # các biến thể sinh từ dàn mục mẫu (có đáp án) — tỉ lệ heading vào đúng mục
 *   npm run eval:import-match -- <file.docx> …    # file SRS thật: bản đồ heading ⇒ mục, phân bố độ tin, số chỗ "Cần xem"
 * File thật có thể thiếu mục / sai nên **không phải đáp án** — chỉ in báo cáo, không đặt ngưỡng (ngưỡng CI nằm ở
 * `match-harness.test.ts`). `--json` in JSON thay bảng.
 */
import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { matchReport, runHarness } from "../modules/import/match-harness.js"

const args = process.argv.slice(2)
const json = args.includes("--json")
const files = args.filter((a) => !a.startsWith("--"))
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`

const main = async (): Promise<void> => {
  if (!files.length) {
    const result = await runHarness()
    if (json) return void console.log(JSON.stringify(result, null, 2))
    console.log("# Khớp mẫu I-3 — biến thể sinh (có đáp án)\n")
    console.log("| Biến thể | Đúng | Tỉ lệ | Dòng mục lục thành nội dung |\n|---|---|---|---|")
    for (const v of result.variants) console.log(`| ${v.variant} | ${v.correct}/${v.total} | ${pct(v.accuracy)} | ${v.toc_blocks} |`)
    console.log(`\nTổng: ${pct(result.accuracy)}`)
    for (const v of result.variants) for (const m of v.misses) console.log(`- ${v.variant}: "${m.title}" ⇒ ${m.got ?? "(không nhận là heading)"} (đúng: ${m.expected})`)
    return
  }
  for (const file of files) {
    const report = await matchReport(await readFile(file))
    if (json) {
      console.log(JSON.stringify({ file, ...report }, null, 2))
      continue
    }
    console.log(`# ${basename(file)} — họ mẫu ${report.template_family}\n`)
    console.log("| Block | Cấp | Heading | Mục | Độ tin | Nhận theo | Cần xem |\n|---|---|---|---|---|---|---|")
    for (const h of report.headings) {
      console.log(`| ${h.block_id} | ${h.level ?? ""} | ${h.heading_text.replace(/\|/g, "/").slice(0, 70)} | ${h.section_id} | ${h.confidence.toFixed(2)} | ${h.detected_by} | ${h.needs_review ? "✔" : ""} |`)
    }
    console.log("\nPhân bố độ tin heading:", Object.entries(report.histogram).map(([k, n]) => `${k}: ${n}`).join(" · "))
    console.log(`Cần xem: ${report.needs_review.headings} heading, ${report.needs_review.table_columns} cột bảng`)
    console.log(`Dòng mục lục còn thành nội dung: ${report.toc_blocks}\n`)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
