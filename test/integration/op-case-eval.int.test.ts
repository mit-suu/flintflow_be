/**
 * op-case-eval (T22) — kiểm chính bộ chấm của `test/e2e-ai/op-cases.e2e.test.ts` bằng executor giả,
 * để lượt chạy provider thật (tốn credit) không bị hỏng vì lỗi harness.
 */
import { describe, it, expect } from "vitest"
import { OP_CASE_FILES, loadOpCase, userWritableOps } from "../helpers/op-cases.js"
import { formatVerdicts, resolveStepId, runOpCase, type DraftExecutor } from "../helpers/op-case-eval.js"
import type { AiActionResult } from "../../src/shared/ai/ai-action.types.js"
import type { OpTransaction } from "../../src/shared/ai/response-parser.js"

/** Executor giả trả đúng `ops` cho trước, kèm số token/credit giả để kiểm phần cộng dồn. */
const cannedExecutor =
  (ops: unknown[]): DraftExecutor =>
  async (actionType) =>
    ({
      success: true,
      data: { ops } as OpTransaction,
      rawText: JSON.stringify({ ops }),
      actionType,
      provider: "mock",
      aiModel: "mock",
      tokensUsed: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      latencyMs: 1,
      logId: "",
      cost: 2
    }) as AiActionResult<OpTransaction>

describe("bộ chấm 10 ca op", () => {
  it("S-5.x lấy hậu tố màn từ override của ca", () => {
    expect(resolveStepId(loadOpCase("case-06.json"))).toBe("S-5.1@S07")
    expect(resolveStepId(loadOpCase("case-01.json"))).toBe("S-3.1")
  })

  it("ca áp được: model trả đúng op kỳ vọng ⇒ PASS, cộng token/credit", async () => {
    const opCase = loadOpCase("case-02.json")
    const verdict = await runOpCase("case-02.json", cannedExecutor(opCase.expected_ops))
    expect(verdict, verdict.reason).toMatchObject({ expect: "apply", pass: true, attempts: 1, tokens_in: 100, tokens_out: 20, cost: 2 })
  })

  it("ca áp được: model trả ops rỗng ⇒ FAIL, ghi op thiếu", async () => {
    const verdict = await runOpCase("case-01.json", cannedExecutor([]))
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toContain("thiếu: add actors[]")
  })

  it("ca reject: model làm theo op sai ⇒ validator chặn qua mọi lượt ⇒ PASS nhưng model_avoided = false", async () => {
    const opCase = loadOpCase("case-08.json")
    const verdict = await runOpCase("case-08.json", cannedExecutor(opCase.expected_ops))
    expect(verdict).toMatchObject({ expect: "reject", pass: true, model_avoided: false, attempts: 3 })
  })

  it("ca reject: model không sinh op sai ⇒ PASS, model_avoided = true", async () => {
    const verdict = await runOpCase("case-07.json", cannedExecutor([]))
    expect(verdict).toMatchObject({ expect: "reject", pass: true, model_avoided: true })
  })

  it("chạy trọn 10 ca với op kỳ vọng ⇒ bảng markdown có đủ 10 dòng", { timeout: 120_000 }, async () => {
    const verdicts = []
    for (const file of OP_CASE_FILES) {
      const opCase = loadOpCase(file)
      const ops = opCase.must_reject ? opCase.expected_ops : userWritableOps(opCase.expected_ops)
      verdicts.push(await runOpCase(file, cannedExecutor(ops)))
    }
    const table = formatVerdicts(verdicts)
    expect(table.split("\n").filter((line) => line.startsWith("| case-"))).toHaveLength(10)
    // Mọi ca reject đều không để lọt op sai khi model làm theo đúng op sai
    expect(verdicts.filter((v) => v.expect === "reject").every((v) => v.pass)).toBe(true)
  })
})
