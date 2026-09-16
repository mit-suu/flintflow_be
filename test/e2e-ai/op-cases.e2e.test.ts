/**
 * op-cases.e2e (T22) — 10 ca op T02 với PROVIDER THẬT. Chỉ chạy khi `E2E_AI=1` (`npm run test:e2e-ai`).
 *
 * Mỗi ca: Spine fixture vào Mongo in-memory → `buildStepContext` → `draftOps` với `executeAiAction` thật
 * (reserve/trừ credit trên ví seed sẵn) → chấm theo `test/helpers/op-case-eval.ts`.
 * Kết quả ghi `test/e2e-ai/results/op-cases-<ISO>.md` (số thật, không làm tròn) để chép vào `docs/measurements.md`.
 * DoD T22: ≥ 8/10 pass ở lần chạy ghi nhận.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, afterAll } from "vitest"
import { OP_CASE_FILES } from "../helpers/op-cases.js"
import { formatVerdicts, runOpCase, type OpCaseVerdict } from "../helpers/op-case-eval.js"

const enabled = process.env.E2E_AI === "1"
const PASS_THRESHOLD = 8

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, "results")

const verdicts: OpCaseVerdict[] = []

describe.skipIf(!enabled)("10 ca op T02 — provider thật (E2E_AI=1)", () => {
  for (const file of OP_CASE_FILES) {
    it(`${file}`, async () => {
      const verdict = await runOpCase(file)
      verdicts.push(verdict)
      // Không assert từng ca: tỉ lệ pass mới là chỉ số; ca fail vẫn được ghi vào báo cáo
      expect(verdict.file).toBe(file)
    })
  }

  it(`tỉ lệ pass ≥ ${PASS_THRESHOLD}/10`, () => {
    const passed = verdicts.filter((v) => v.pass).length
    expect(verdicts).toHaveLength(OP_CASE_FILES.length)
    expect(passed, formatVerdicts(verdicts)).toBeGreaterThanOrEqual(PASS_THRESHOLD)
  })

  afterAll(() => {
    if (verdicts.length === 0) return
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const header = [
      `# 10 ca op T02 — provider thật (${new Date().toISOString()})`,
      "",
      "Sinh bởi `npm run test:e2e-ai`. Luật chấm: `test/helpers/op-case-eval.ts`.",
      "Token/credit của ca bị `DraftRejectedError` không có trong bảng (lỗi không trả usage) — xem `AiActionLog`.",
      ""
    ].join("\n")
    fs.writeFileSync(path.join(OUT_DIR, `op-cases-${stamp}.md`), `${header}\n${formatVerdicts(verdicts)}\n`)
  })
})

describe.skipIf(enabled)("10 ca op T02 — provider thật", () => {
  it.skip("bỏ qua: đặt E2E_AI=1 để gọi provider thật (tốn credit)", () => {})
})
