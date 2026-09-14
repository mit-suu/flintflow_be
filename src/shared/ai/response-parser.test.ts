import { describe, it, expect } from "vitest"
import { ActionType, AiActionError } from "./ai-action.types.js"
import { parseResponse, type OpTransaction, type ChangeInstructionOutput, type ReviewOutput } from "./response-parser.js"

const expectAiError = (fn: () => unknown, code: string) => {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(AiActionError)
    expect((err as AiActionError).code).toBe(code)
    return
  }
  throw new Error(`Expected AiActionError ${code}`)
}

describe("parseResponse — schema pipeline (T03)", () => {
  it("DRAFT nhận opTransaction hợp lệ, kể cả bọc code fence", () => {
    const raw = '```json\n{"ops":[{"op":"set","path":"actors[id=A03].name","value":"Administrator","reason":"typo"},{"op":"renumber","path":"features[]"}]}\n```'
    const out = parseResponse<OpTransaction>(raw, ActionType.DRAFT)

    expect(out.ops).toHaveLength(2)
    expect(out.ops[0].path).toBe("actors[id=A03].name")
  })

  it("DRAFT từ chối op lạ — không trả raw text", () => {
    expectAiError(
      () => parseResponse('{"ops":[{"op":"replace","path":"actors[]"}]}', ActionType.DRAFT),
      "SCHEMA_MISMATCH"
    )
  })

  it("DRAFT không phải JSON → PARSE_FAILED", () => {
    expectAiError(() => parseResponse("Here is the section text...", ActionType.DRAFT), "PARSE_FAILED")
  })

  it("ELICIT chuẩn hoá question dạng chuỗi", () => {
    const out = parseResponse<{ reply: string; questions: Array<{ question: string }> }>(
      '{"reply":"Ok","questions":["Ai duyệt yêu cầu?"]}',
      ActionType.ELICIT
    )

    expect(out.questions[0].question).toBe("Ai duyệt yêu cầu?")
  })

  it("REVIEW đòi section_id và message", () => {
    const ok = parseResponse<ReviewOutput>(
      '{"flags":[{"level":"yellow","rule_id":"ambiguity","section_id":"function:FN07","message":"mơ hồ"}]}',
      ActionType.REVIEW
    )
    expect(ok.flags).toHaveLength(1)

    expectAiError(
      () => parseResponse('{"flags":[{"level":"yellow","message":"x"}]}', ActionType.REVIEW),
      "SCHEMA_MISMATCH"
    )
  })

  it("CHANGE_INSTRUCTION cần clarification_needed hoặc ops", () => {
    const ask = parseResponse<ChangeInstructionOutput>(
      '{"clarification_needed":"Đổi actor nào?"}',
      ActionType.CHANGE_INSTRUCTION
    )
    expect(ask.clarification_needed).toBeTruthy()

    expectAiError(() => parseResponse("{}", ActionType.CHANGE_INSTRUCTION), "SCHEMA_MISMATCH")
  })

  it("RENDER_FIX đòi puml", () => {
    const out = parseResponse<{ puml: string }>('{"puml":"@startuml\\n@enduml"}', ActionType.RENDER_FIX)
    expect(out.puml).toContain("@startuml")
  })
})
