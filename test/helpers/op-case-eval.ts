/**
 * op-case-eval.ts (T22)
 * ─────────────────────────────────────────────────────────────────
 * Chạy một ca op T02 (`fixtures/op-cases/case-XX.json`) qua đúng đường production của step Draft:
 * Spine fixture trong Mongo → `buildStepContext` → `draftOps` (retry schema ≤ 2) — rồi chấm điểm.
 * `executor` mặc định là `executeAiAction` (provider thật, trừ credit thật); test harness truyền executor giả.
 *
 * Luật chấm (ghi lại ở docs/testing.md):
 *   - Ca áp được: PASS khi `draftOps` trả lô hợp lệ VÀ mỗi op kỳ vọng user ghi được (bỏ path hệ thống quản lý)
 *     có op cùng loại + cùng path trong lô. Không so `value` (văn phong model khác nhau là bình thường).
 *   - Ca `must_reject`: PASS khi lô cuối KHÔNG chứa trọn bộ op sai. Ghi riêng `model_avoided` (lượt đầu model
 *     đã không sinh op sai) để phân biệt với trường hợp validator chặn hộ (`guardrail_caught`).
 */
import { applyOverrides, loadOpCase, userWritableOps, type OpCaseFile } from "./op-cases.js"
import { seedFixture } from "../setup.js"
import { buildStepContext } from "../../src/modules/pipeline/context-projection.js"
import { DraftRejectedError, draftOps, type DraftAttempt, type DraftExecutor } from "../../src/modules/pipeline/draft-to-ops.js"

export interface OpCaseVerdict {
  file: string
  name: string
  step_id: string
  expect: "apply" | "reject"
  pass: boolean
  reason: string
  /** Ca reject: lượt đầu model đã không sinh op sai. */
  model_avoided?: boolean
  attempts: number
  tokens_in: number
  tokens_out: number
  cost: number
  final_ops: Array<{ op: string; path: string }>
}

interface OpLike {
  op: string
  path: string
}

const asOps = (ops: unknown[]): OpLike[] =>
  ops.filter((o): o is OpLike => typeof o === "object" && o !== null && "op" in o && "path" in o).map((o) => ({ op: String(o.op), path: String(o.path) }))

const normalizePath = (path: string): string => path.replace(/\s+/g, "")
const sameOp = (a: OpLike, b: OpLike): boolean => a.op === b.op && normalizePath(a.path) === normalizePath(b.path)
const containsAll = (haystack: OpLike[], needles: OpLike[]): boolean => needles.every((n) => haystack.some((h) => sameOp(h, n)))

/** Step của vòng S-5 cần hậu tố `@<screen>` — lấy màn đang trỏ trong override của ca. */
export const resolveStepId = (opCase: OpCaseFile): string => {
  if (!opCase.step_id.startsWith("S-5.")) return opCase.step_id
  const cursor = opCase.spine_before_overrides?.["progress.screen_cursor"]
  return `${opCase.step_id}@${typeof cursor === "string" ? cursor : "nonscreen"}`
}

export const scoreOpCase = (
  file: string,
  opCase: OpCaseFile,
  outcome: { finalOps: unknown[] | null; attempts: DraftAttempt[]; usage: { tokens_in: number; tokens_out: number; cost: number }[]; error?: string }
): OpCaseVerdict => {
  const finalOps = outcome.finalOps === null ? [] : asOps(outcome.finalOps)
  const totals = outcome.usage.reduce(
    (acc, u) => ({ tokens_in: acc.tokens_in + u.tokens_in, tokens_out: acc.tokens_out + u.tokens_out, cost: acc.cost + u.cost }),
    { tokens_in: 0, tokens_out: 0, cost: 0 }
  )
  const base = {
    file,
    name: opCase.name,
    step_id: opCase.step_id,
    attempts: outcome.attempts.length,
    ...totals,
    final_ops: finalOps
  }
  const expected = asOps(opCase.expected_ops)

  if (opCase.must_reject) {
    const firstOps = asOps(outcome.attempts[0]?.ops ?? [])
    const modelAvoided = !containsAll(firstOps, expected)
    const leaked = outcome.finalOps !== null && containsAll(finalOps, expected)
    return {
      ...base,
      expect: "reject",
      pass: !leaked,
      model_avoided: modelAvoided,
      reason: leaked
        ? `op sai lọt qua (${opCase.must_reject})`
        : modelAvoided
          ? "model không sinh op sai"
          : `validator chặn op sai (${opCase.must_reject})`
    }
  }

  if (outcome.finalOps === null) {
    return { ...base, expect: "apply", pass: false, reason: outcome.error ?? "không có lô op hợp lệ" }
  }
  const wanted = userWritableOps(expected)
  const missing = wanted.filter((w) => !finalOps.some((f) => sameOp(f, w)))
  return {
    ...base,
    expect: "apply",
    pass: missing.length === 0,
    reason: missing.length === 0 ? "đủ op kỳ vọng" : `thiếu: ${missing.map((m) => `${m.op} ${m.path}`).join("; ")}`
  }
}

/** Seed ca vào Mongo, gọi `draftOps` với `prompt_context` làm câu trả lời của user, chấm điểm. */
export const runOpCase = async (file: string, executor?: DraftExecutor): Promise<OpCaseVerdict> => {
  const opCase = loadOpCase(file)
  const kind = opCase.spine_before_ref.includes("minimal") ? "minimal" : "full"
  const seeded = await seedFixture(kind, { mutate: (spine) => applyOverrides(spine, opCase.spine_before_overrides) })
  const stepId = resolveStepId(opCase)
  const ctx = await buildStepContext(seeded.projectId, stepId)

  try {
    const result = await draftOps(seeded.projectId, stepId, ctx, {
      userId: seeded.userId,
      answers: opCase.prompt_context,
      ...(executor ? { executor } : {})
    })
    return scoreOpCase(file, opCase, { finalOps: result.txn?.ops ?? [], attempts: result.attempts, usage: result.usage })
  } catch (err) {
    if (!(err instanceof DraftRejectedError)) throw err
    return scoreOpCase(file, opCase, { finalOps: null, attempts: err.attempts, usage: [], error: err.message })
  }
}

export const formatVerdicts = (verdicts: OpCaseVerdict[]): string => {
  const passed = verdicts.filter((v) => v.pass).length
  const rows = verdicts.map(
    (v) =>
      `| ${v.file} | ${v.step_id} | ${v.expect} | ${v.pass ? "PASS" : "FAIL"} | ${v.attempts} | ${v.tokens_in} | ${v.tokens_out} | ${v.cost} | ${v.reason.replace(/\|/g, "\\|")} |`
  )
  return [
    `**${passed}/${verdicts.length} pass**`,
    "",
    "| Ca | Step | Kỳ vọng | Kết quả | Lượt | Token in | Token out | Credit | Ghi chú |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows
  ].join("\n")
}

export type { DraftExecutor }
