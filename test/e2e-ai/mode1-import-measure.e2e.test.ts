/**
 * mode1-import-measure.e2e — đo luồng import mode 1 trọn vẹn với PROVIDER THẬT. Chỉ chạy khi `E2E_AI=1`:
 *   MEASURE_SRS="<đường dẫn .docx>" MEASURE_LABEL=<nhãn> npm run test:e2e-ai -- test/e2e-ai/mode1-import-measure.e2e.test.ts
 *
 * Luồng HTTP thật (FLF-343, một mạch): upload (preflight + tách file + khớp mẫu) → Bắt đầu (`/import/extract` kèm
 * `confirm_latest`) → I-4 → finalize nối tiếp (baseline 0.1 + 1.11 + 1.12), chờ job. Mongo in-memory — không đụng DB thật. PlantUML tắt trong test nên sơ đồ có
 * cờ render, không ảnh hưởng số đo AI.
 *
 * Ghi `test/e2e-ai/results/mode1-measure-<label>-<file>-<ISO>.{md,json}`: lượt gọi / token / credit theo bước, thời gian
 * từng chặng, số cờ AI, và độ phủ của 1.11 = phần chữ tài liệu mà lượt AI kiểm tra đọc được. Bản trước map-reduce (một
 * lượt `I-1.11`) cắt khối chữ ở 16 000 ký tự ⇒ độ phủ = min(1, 16 000 / tổng); bản theo lô (`I-1.11:<n>`) đọc hết.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { seedFixture } from "../setup.js"
import { createMode1Project, mode1Api } from "../helpers/mode1.js"

const enabled = process.env.E2E_AI === "1"
const SRS = process.env.MEASURE_SRS ?? ""
const LABEL = (process.env.MEASURE_LABEL ?? "run").replace(/[^\w.-]+/g, "_")
/** Trần chữ của 1.11 trước map-reduce (`BLOCKS_LIMIT` cũ trong `check.service.ts`). */
const LEGACY_BLOCKS_LIMIT = 16_000

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, "results")

interface StepRow {
  group: string
  calls: number
  tokens_in: number
  tokens_out: number
  credits: number
}

describe.skipIf(!enabled || !SRS)("Đo import mode 1 — provider thật (E2E_AI=1, MEASURE_SRS)", () => {
  it("upload → I-4 → finalize/1.11", { timeout: 90 * 60_000 }, async () => {
    const { Usage } = await import("../../src/modules/spine/usage.model.js")
    const { DocBlock } = await import("../../src/modules/import/doc-block.model.js")
    const { IMPORTED_DOC_VERSION } = await import("../../src/modules/doc-version/versioning.js")
    const repo = await import("../../src/modules/spine/spine.repository.js")

    const seeded = await seedFixture("minimal", { balance: 50_000 })
    const projectId = await createMode1Project(seeded, path.basename(SRS, ".docx"))
    const c = mode1Api(seeded, projectId)
    const timings: Record<string, number> = {}
    const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const t0 = Date.now()
      try {
        return await fn()
      } finally {
        timings[name] = (Date.now() - t0) / 1000
      }
    }

    const buf = fs.readFileSync(SRS)
    const up = await timed("upload_parse", () => c.upload(buf, path.basename(SRS)))
    expect(up.status, JSON.stringify(up.body.error)).toBe(201)
    const importId = up.body.data.import.id as string
    let view = (await c.get("/import")).body.data
    expect(view.import.status).toBe("extracting")
    const estimate = view.credit_estimate

    // một lần Bắt đầu: I-4 ⇒ baseline 0.1 ⇒ 1.11–1.12 (đo gộp)
    const { run } = await timed("one_pass", () => c.extractAndWait(importId, "/import/extract", 60 * 60_000))
    // I-4 phải xong (không section lỗi, đã qua `extracting`); finalize dừng (vd 1.11 lỗi) vẫn ghi số đo I-4, rồi mới đánh trượt
    expect(run?.sections.filter((s: { error: unknown }) => s.error) ?? []).toEqual([])
    view = (await c.get("/import")).body.data
    expect(view.import.status).not.toBe("extracting")

    // ─── số đo ───────────────────────────────────────────────────
    const usage = await Usage.find({ projectId, state: "deducted" }).lean()
    const groupOf = (step: string): string => (step.startsWith("I-4:") ? "I-4" : step === "I-1.11:cross" ? "I-1.11 cross" : step.startsWith("I-1.11") ? "I-1.11 map" : step)
    const rows = new Map<string, StepRow>()
    for (const u of usage) {
      const g = groupOf(u.step_id)
      const r = rows.get(g) ?? { group: g, calls: 0, tokens_in: 0, tokens_out: 0, credits: 0 }
      r.calls++
      r.tokens_in += u.tokens_in ?? 0
      r.tokens_out += u.tokens_out ?? 0
      r.credits += u.cost ?? 0
      rows.set(g, r)
    }
    // Thời gian riêng của I-4 (one_pass gộp cả finalize): từ lượt I-4 đầu tiên được ghi tới lượt cuối được trừ credit
    const i4 = usage.filter((u) => u.step_id.startsWith("I-4:")) as Array<(typeof usage)[number] & { createdAt: Date; updatedAt: Date }>
    if (i4.length) {
      timings.i4_span = (Math.max(...i4.map((u) => +new Date(u.updatedAt))) - Math.min(...i4.map((u) => +new Date(u.createdAt)))) / 1000
    }
    // Số lượt I-4 theo section ⇒ biết đường găng (section nhiều lượt nhất) khi chạy song song
    const i4BySection: Record<string, number> = {}
    for (const u of i4) {
      const section = u.step_id.slice("I-4:".length)
      i4BySection[section] = (i4BySection[section] ?? 0) + 1
    }
    const checkBlocks = await DocBlock.find({ projectId, doc_version: IMPORTED_DOC_VERSION, kind: { $in: ["paragraph", "list_item", "table_cell"] } })
      .select("block_id text section_id")
      .lean()
    const checkChars = checkBlocks.filter((b) => b.text.trim()).reduce((n, b) => n + `[${b.block_id}] (${b.section_id ?? "-"}) ${b.text}`.length + 1, 0)
    const steps = usage.map((u) => u.step_id)
    const batched = steps.some((s) => /^I-1\.11:\d+$/.test(s))
    const coverage = batched ? 1 : Math.min(1, LEGACY_BLOCKS_LIMIT / Math.max(1, checkChars))
    const spine = (await repo.get(projectId))!
    const openFlags = spine.flags.filter((f) => f.resolved_at === null)
    const result = {
      label: LABEL,
      credit_estimate: estimate ?? null,
      srs: path.basename(SRS),
      file_bytes: buf.length,
      blocks_total: await DocBlock.countDocuments({ projectId, doc_version: IMPORTED_DOC_VERSION }),
      check_chars: checkChars,
      check_mode: batched ? "map-reduce" : "single (16k cap)",
      check_coverage: Number(coverage.toFixed(4)),
      status: view.import.status,
      paused: view.import.paused,
      timings_s: timings,
      i4_calls_by_section: i4BySection,
      steps: [...rows.values()].sort((a, b) => a.group.localeCompare(b.group)),
      total: {
        calls: usage.length,
        tokens_in: usage.reduce((n, u) => n + (u.tokens_in ?? 0), 0),
        tokens_out: usage.reduce((n, u) => n + (u.tokens_out ?? 0), 0),
        credits: usage.reduce((n, u) => n + (u.cost ?? 0), 0)
      },
      spine: Object.fromEntries(["actors", "use_cases", "features", "functions", "screens", "entities", "nfrs", "business_rules"].map((k) => [k, (spine as unknown as Record<string, unknown[]>)[k].length])),
      flags: {
        red: openFlags.filter((f) => f.level === "red").length,
        yellow: openFlags.filter((f) => f.level === "yellow").length,
        ai_semantic: openFlags.filter((f) => f.rule_id === "import_semantic").length
      }
    }

    fs.mkdirSync(OUT_DIR, { recursive: true })
    const stem = `mode1-measure-${LABEL}-${path.basename(SRS, ".docx").replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}`
    fs.writeFileSync(path.join(OUT_DIR, `${stem}.json`), JSON.stringify(result, null, 2))
    const md = [
      `# Đo import mode 1 — ${result.label} — ${result.srs}`,
      "",
      `- File ${result.file_bytes} byte, ${result.blocks_total} block; chữ cho 1.11: ${result.check_chars} ký tự`,
      `- 1.11: ${result.check_mode}, độ phủ ${(result.check_coverage * 100).toFixed(1)}%`,
      `- Trạng thái cuối: ${result.status}${result.paused ? ` (paused: ${JSON.stringify(result.paused)})` : ""}`,
      `- Thời gian (s): ${Object.entries(timings).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ")}`,
      `- Spine: ${Object.entries(result.spine).map(([k, v]) => `${v} ${k}`).join(", ")}`,
      `- Cờ mở: ${result.flags.red} đỏ, ${result.flags.yellow} vàng (AI 1.11: ${result.flags.ai_semantic})`,
      "",
      "| Bước | Lượt gọi | tokens_in | tokens_out | Credit |",
      "|---|---:|---:|---:|---:|",
      ...result.steps.map((r) => `| ${r.group} | ${r.calls} | ${r.tokens_in} | ${r.tokens_out} | ${r.credits} |`),
      `| **Tổng** | ${result.total.calls} | ${result.total.tokens_in} | ${result.total.tokens_out} | ${result.total.credits} |`,
      ""
    ].join("\n")
    fs.writeFileSync(path.join(OUT_DIR, `${stem}.md`), md)
    console.log(md)
    expect(result.status).toBe("gap_review")
  })
})
