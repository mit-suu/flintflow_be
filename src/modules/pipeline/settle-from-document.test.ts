/**
 * FLF-393 (business-flow §3.6): câu hỏi đang chờ được chốt bằng tài liệu tham khảo, có ghi nguồn. Server không tin model:
 * mã đoạn phải tra được ra chữ, câu mở thì câu trả lời phải là trích đoạn nguyên văn của đoạn đó.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const captured = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock("../project/requirement-source.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../project/requirement-source.service.js")>()
  return {
    ...actual,
    captureSources: vi.fn(async (...args: unknown[]) => {
      captured.calls.push(args)
      return 1
    })
  }
})

import type { Spine } from "../spine/spine.types.js"
import { captureSettledSources, settleFromChat, type AnswerInput } from "./step-runner.service.js"

const credit = { topic_key: "credit_topup", question: "Người dùng nạp credit bằng cách nào?", options: [] }
const stakes = { topic_key: "stakes", question: "Yếu tố tuân thủ thế nào?", options: [{ label: "Có quy định pháp luật" }, { label: "Chỉ quy định nội bộ" }] }
const asked = [credit, stakes] as never

const P391 = "An external payment service (VietQR / SePay checkout) that processes credit pack purchases and plan upgrades and reports the outcome by webhook."
const docs = new Map([["D1-P391", P391]])
const message = "Câu hỏi nạp credit đó, tài liệu đã ghi chưa?"

beforeEach(() => {
  captured.calls = []
})

describe("settleFromChat — chốt bằng tài liệu (FLF-393)", () => {
  it("trích đoạn nguyên văn của đoạn được dẫn ⇒ chốt, kèm mã đoạn nguồn", () => {
    const out = settleFromChat(asked, [{ topic_key: "credit_topup", answer: "VietQR / SePay checkout", source_paras: ["d1-p391"] }], message, undefined, docs)
    expect(out).toEqual([{ question_id: expect.any(String), answer: "VietQR / SePay checkout", source_paras: ["D1-P391"] }])
  })

  it("câu diễn lại / dịch (không phải chuỗi con của đoạn) ⇒ không chốt", () => {
    expect(settleFromChat(asked, [{ topic_key: "credit_topup", answer: "Chuyển khoản qua VietQR", source_paras: ["D1-P391"] }], message, undefined, docs)).toEqual([])
  })

  it("mã đoạn bịa / không tra được ⇒ không chốt", () => {
    expect(settleFromChat(asked, [{ topic_key: "credit_topup", answer: "VietQR / SePay checkout", source_paras: ["D1-P999"] }], message, undefined, docs)).toEqual([])
    expect(settleFromChat(asked, [{ topic_key: "credit_topup", answer: "VietQR / SePay checkout" }], message, undefined, docs)).toEqual([])
  })

  it("user tự trả lời ⇒ chốt bằng lời user, không gắn nguồn tài liệu", () => {
    const out = settleFromChat(asked, [{ topic_key: "credit_topup", answer: "chuyển khoản", source_paras: ["D1-P391"] }], "Nạp bằng chuyển khoản nhé", undefined, docs)
    expect(out).toEqual([{ question_id: expect.any(String), answer: "chuyển khoản" }])
  })

  it("câu có lựa chọn: nhãn hợp lệ + đoạn tra được ⇒ chốt kèm nguồn; đoạn không tra được ⇒ chốt như cũ, không nguồn", () => {
    expect(settleFromChat(asked, [{ topic_key: "stakes", answer: "Có quy định pháp luật", source_paras: ["D1-P391"] }], message, undefined, docs)).toEqual([
      { question_id: expect.any(String), answer: "Có quy định pháp luật", source_paras: ["D1-P391"] }
    ])
    expect(settleFromChat(asked, [{ topic_key: "stakes", answer: "Có quy định pháp luật", source_paras: ["D9-P01"] }], message, undefined, docs)).toEqual([
      { question_id: expect.any(String), answer: "Có quy định pháp luật" }
    ])
  })
})

describe("captureSettledSources — ghi nguồn cho quyết định (business-flow §3.6, UC-53)", () => {
  const spine = {
    decisions: [
      { id: "D1", topic_key: "credit_topup", question: "?", answer: "cũ", step_id: "B-0.1", at: "2026-11-12T00:00:00.000Z", superseded_by: "D2" },
      { id: "D2", topic_key: "credit_topup", question: "?", answer: "VietQR / SePay checkout", step_id: "B-0.1", at: "2026-11-12T00:01:00.000Z", superseded_by: null }
    ]
  } as unknown as Spine

  it("câu chốt bằng tài liệu ⇒ lưu nguồn cho quyết định đang hiệu lực của chủ đề đó", async () => {
    const settled = settleFromChat(asked, [{ topic_key: "credit_topup", answer: "VietQR / SePay checkout", source_paras: ["D1-P391"] }], message, undefined, docs)
    expect(await captureSettledSources("p", "B-0.1", spine, asked, settled)).toBe(1)
    expect(captured.calls).toEqual([["p", "B-0.1", spine, [{ path: "decisions[id=D2]", paras: ["D1-P391"] }]]])
  })

  it("câu user tự trả lời / chủ đề chưa có quyết định ⇒ không ghi nguồn", async () => {
    const userAnswer: AnswerInput[] = [{ question_id: "Q1", answer: "chuyển khoản" }]
    expect(await captureSettledSources("p", "B-0.1", spine, asked, userAnswer)).toBe(0)
    const noDecision = { decisions: [] } as unknown as Spine
    const settled = settleFromChat(asked, [{ topic_key: "credit_topup", answer: "VietQR / SePay checkout", source_paras: ["D1-P391"] }], message, undefined, docs)
    expect(await captureSettledSources("p", "B-0.1", noDecision, asked, settled)).toBe(0)
    expect(captured.calls).toEqual([])
  })
})
