/**
 * mock-llm.ts (T22)
 * ─────────────────────────────────────────────────────────────────
 * Provider giả lập ở tầng `callLLM` (llm.router) — thấp nhất có thể, để reserve/trừ credit, parse response,
 * retry, `AiActionLog`, `Usage` đều là code thật. Trả op đóng hộp từ `fixtures/op-cases/<nhóm>/<step>.json`
 * theo step trong prompt; elicit trả "không hỏi thêm".
 *
 * Dùng: `vi.mock("../../src/shared/ai/providers/llm.router.js", () => mockLlmRouterModule())`.
 */
import fs from "node:fs"
import path from "node:path"
import { FIXTURES_DIR } from "../setup.js"

export type CallKind = "elicit" | "draft" | "change" | "review" | "other"

export interface RecordedCall {
  step_id: string | null
  kind: CallKind
  prompt_chars: number
  tokens_in: number
  tokens_out: number
}

const OP_CASE_GROUPS = ["b0-s1", "s2-s3", "s4-s8"]

/** Cùng heuristic ký tự/4 với `context-projection.ts#estimateTokens` — provider giả không có số token thật. */
export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4))

export const detectCall = (prompt: string): { kind: CallKind; stepId: string | null } => {
  const head = prompt.slice(0, 2000)
  const kind: CallKind = head.includes("# Draft to Ops")
    ? "draft"
    : head.includes("# Elicit Loop")
      ? "elicit"
      : head.includes("# Apply Change Op")
        ? "change"
        : /# Review/i.test(head)
          ? "review"
          : "other"
  const step = /\*\*([BS]-\d+(?:\.\d+)*)\*\*/.exec(head)
  return { kind, stepId: step?.[1] ?? null }
}

export const findOpCase = (stepId: string): { ops: unknown[]; notes?: string } | null => {
  for (const group of OP_CASE_GROUPS) {
    const file = path.join(FIXTURES_DIR, "op-cases", group, `${stepId.toLowerCase()}.json`)
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { ops: unknown[]; notes?: string }
      return { ops: raw.ops, ...(raw.notes ? { notes: raw.notes } : {}) }
    }
  }
  return null
}

export const mockCalls: RecordedCall[] = []
/** Ảnh kèm từng lượt gọi (phase 5): loại + độ dài base64, theo thứ tự gọi. */
export const mockImages: { mime: string; bytes: number }[][] = []

/** Ghi đè từng lượt (vd ép lỗi); trả `undefined` để đi đường mặc định. */
export const mockOverrides: { next?: (prompt: string) => string | Error | undefined } = {}

export const resetMockLlm = (): void => {
  mockCalls.length = 0
  mockImages.length = 0
  mockOverrides.next = undefined
}

export const mockCallLLM = async (
  prompt: string,
  _config?: unknown,
  options: { images?: { mime: string; data: string }[] } = {}
): Promise<{ text: string; promptTokens: number; completionTokens: number; raw: unknown }> => {
  const { kind, stepId } = detectCall(prompt)
  mockImages.push((options.images ?? []).map((i) => ({ mime: i.mime, bytes: Buffer.from(i.data, "base64").length })))
  const override = mockOverrides.next?.(prompt)
  if (override instanceof Error) throw override

  let text = override
  if (text === undefined) {
    if (kind === "draft") {
      const opCase = stepId ? findOpCase(stepId) : null
      text = JSON.stringify(opCase ?? { ops: [] })
    } else if (kind === "elicit") {
      text = JSON.stringify({ reply: "ok", questions: [] })
    } else if (kind === "change") {
      // Test phải ghi đè bằng `mockOverrides.next`; mặc định hỏi lại để không âm thầm sửa Spine
      text = JSON.stringify({ clarification_needed: "Which element should change?" })
    } else {
      text = JSON.stringify({ findings: [], notes: "mock" })
    }
  }

  const call: RecordedCall = { step_id: stepId, kind, prompt_chars: prompt.length, tokens_in: estimateTokens(prompt), tokens_out: estimateTokens(text) }
  mockCalls.push(call)
  return { text, promptTokens: call.tokens_in, completionTokens: call.tokens_out, raw: { mock: true } }
}

export const mockLlmRouterModule = () => ({ callLLM: mockCallLLM })
