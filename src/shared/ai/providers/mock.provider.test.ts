/**
 * Provider mock phải trả output **hợp schema** của từng ActionType (T24).
 *
 * Trước T24 nó luôn trả `{status, message, promptSnippet}`, nên bật mock thì step chết ở bước parse
 * chứ không đi được tới gate — chính là lý do e2e của T23 không phủ được bước AI. Test này khoá lại
 * điều đó bằng cách parse đầu ra bằng đúng schema mà `response-parser.ts` dùng.
 */
import { describe, expect, it } from "vitest"
import { callMockLLM, mockOutputFor } from "./mock.provider.js"
import { ActionType } from "../ai-action.types.js"
import {
  changeInstructionSchema,
  discoveryStepSchema,
  elicitSchema,
  opTransactionSchema,
  renderFixSchema,
  reviewSchema
} from "../response-parser.js"

/** Bóc khối ```json ... ``` giống đường parse thật. */
const json = (text: string): unknown => JSON.parse(text.replace(/^```json\n/, "").replace(/\n```$/, ""))

const outputOf = (actionType: string): unknown => {
  const text = mockOutputFor(actionType, "prompt bất kỳ")
  expect(text, `${actionType} phải có output riêng`).not.toBeNull()
  return json(text as string)
}

describe("mockOutputFor — đúng schema theo ActionType", () => {
  it.each([ActionType.DRAFT, ActionType.REGENERATE, ActionType.REVISION, ActionType.GLOSSARY_SCAN, ActionType.RECONCILE])(
    "%s trả opTransaction với lô op rỗng",
    (actionType) => {
      const parsed = opTransactionSchema.parse(outputOf(actionType))
      expect(parsed.ops).toEqual([])
      expect(parsed.notes).toContain("MOCK AI")
    }
  )

  it.each([ActionType.ELICIT, ActionType.DISCOVERY_STEP])("%s trả elicit không câu hỏi", (actionType) => {
    const parsed = elicitSchema.parse(outputOf(actionType))
    expect(parsed.questions).toEqual([])
    expect(parsed.reply).toContain("MOCK AI")
    // discovery_step dùng schema mở rộng — cùng payload phải qua được cả hai
    expect(() => discoveryStepSchema.parse(outputOf(actionType))).not.toThrow()
  })

  it.each([ActionType.REVIEW, ActionType.CONSISTENCY_PASS])("%s trả danh sách cờ rỗng", (actionType) => {
    expect(reviewSchema.parse(outputOf(actionType)).flags).toEqual([])
  })

  it("change_instruction trả clarification_needed (lô op rỗng bị schema từ chối)", () => {
    const parsed = changeInstructionSchema.parse(outputOf(ActionType.CHANGE_INSTRUCTION))
    expect(parsed.clarification_needed).toBeTruthy()
    // Chứng minh vì sao không dùng `ops: []` ở đây
    expect(() => changeInstructionSchema.parse({ ops: [] })).toThrow()
  })

  it("render_fix trả puml biên dịch được về mặt hình dạng", () => {
    const parsed = renderFixSchema.parse(outputOf(ActionType.RENDER_FIX))
    expect(parsed.puml.startsWith("@startuml")).toBe(true)
    expect(parsed.puml.trimEnd().endsWith("@enduml")).toBe(true)
  })

  it("ActionType ngoài pipeline (chat) không có output riêng — rơi về văn bản tự do", () => {
    expect(mockOutputFor(ActionType.CHAT, "xin chào")).toBeNull()
    expect(mockOutputFor(undefined, "xin chào")).toBeNull()
  })
})

describe("callMockLLM", () => {
  it("dùng actionType của providerConfig và đếm token theo độ dài thật", async () => {
    const res = await callMockLLM("một prompt draft", { provider: "mock", model: "mock", actionType: ActionType.DRAFT })
    expect(opTransactionSchema.parse(json(res.text)).ops).toEqual([])
    expect(res.promptTokens).toBeGreaterThan(0)
    expect(res.completionTokens).toBeGreaterThan(0)
    expect(res.raw).toMatchObject({ mock: true, actionType: ActionType.DRAFT })
  })

  it("không có actionType thì vẫn trả JSON hợp lệ (đường chat cũ)", async () => {
    const res = await callMockLLM("Tóm tắt tài liệu này", { provider: "mock", model: "mock" })
    expect(json(res.text)).toHaveProperty("summary")
  })
})
