/**
 * FLF-375 (business-flow nguyên tắc 9): tin nhắn trong lúc CR mở — câu hỏi được trả lời và KHÔNG thành yêu cầu bổ sung
 * của CR; lệnh sửa vẫn gộp vào CR như trước.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { PERF_TARGETS, crToReady, importedProject, prompts, resetCrMock } from "../../helpers/mode1-cr-p4.js"
import { fakeCrClarify, fakeCrPropose } from "../../helpers/mode1.js"
import { ChangeRequest } from "../../../src/modules/change-request/change-request.model.js"

const QUESTION = "không vẽ lại hình à?"
const REPLY = "Có - sơ đồ use case sẽ được vẽ lại."

beforeEach(() =>
  resetCrMock((p) => fakeCrClarify(PERF_TARGETS)(p) ?? fakeCrPropose(p) ?? (p.includes(QUESTION) ? JSON.stringify({ reply: REPLY, questions: [] }) : undefined))
)

describe("POST /change-requests/:crId/messages", () => {
  it("câu hỏi ⇒ AI trả lời kèm tóm tắt CR; không thêm yêu cầu bổ sung, CR giữ nguyên trạng thái", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr } = await crToReady(c)
    const res = await c.post(`${cr}/messages`, { text: QUESTION })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data.message).toEqual({ kind: "answer", reply: REPLY })
    const doc = (await ChangeRequest.findOne({ projectId, cr_id: crId }).lean())!
    expect(doc.amendments).toEqual([])
    expect(doc.status).toBe("ready_to_submit")
    const prompt = prompts.filter((p) => p.includes(QUESTION)).at(-1)!
    expect(prompt).toContain(`Open change request ${crId}`)
  })

  it("lệnh sửa ⇒ gộp vào CR như /amend (quay lại làm rõ)", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr } = await crToReady(c)
    const res = await c.post(`${cr}/messages`, { text: "Đổi luôn ngưỡng thành 800 ms" })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data.message).toEqual({ kind: "amended" })
    const doc = (await ChangeRequest.findOne({ projectId, cr_id: crId }).lean())!
    expect(doc.amendments.map((a) => a.text)).toEqual(["Đổi luôn ngưỡng thành 800 ms"])
  })
})
