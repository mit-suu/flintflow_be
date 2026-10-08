/**
 * C-2 làm rõ CR (`clarify.service.ts`, nút 3.2–3.3, UC-49) trên Mongo thật, provider AI giả. FLF-172, plan §8.3.
 * Ca chính: mơ hồ ⇒ câu hỏi; trả lời xong gọi lại; quá 3 vòng đi tiếp. Thêm: đích rỗng ⇒ từ khoá dự phòng,
 * hết credit ⇒ paused + resume, trả lời sai số câu / sai trạng thái, thiếu Spine.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { PERF_TARGETS, crDoc, detail, importedProject, newCr, promptsOf, resetCrMock, routeCr } from "../../helpers/mode1-cr-p4.js"
import { fakeCrClarify } from "../../helpers/mode1.js"
import { answerClarification, runClarify } from "../../../src/modules/change-request/clarify.service.js"
import { Spine } from "../../../src/modules/spine/spine.model.js"
import { Usage } from "../../../src/modules/spine/usage.model.js"

beforeEach(() => resetCrMock())

const clarifyOut = (o: { ambiguous: boolean; questions?: string[]; entity_paths?: string[]; keywords?: string[] }) =>
  JSON.stringify({ ambiguous: o.ambiguous, questions: o.questions ?? [], targets: { entity_paths: o.entity_paths ?? [], keywords: o.keywords ?? [] } })

/** Model luôn thấy mơ hồ, hỏi một câu theo vòng. */
const alwaysAmbiguous = (p: string) => {
  if (!p.includes("# CR Clarify")) return undefined
  const round = /Round (\d+) of at most 3/.exec(p)?.[1]
  return clarifyOut({ ambiguous: true, questions: [`Question of round ${round}?`] })
}

describe("C-2 mơ hồ ⇒ câu hỏi; trả lời ⇒ gọi lại", () => {
  it("vòng 1 mơ hồ ⇒ awaiting_answers + pending_questions; prompt có mô tả, nguồn, projection, outline", async () => {
    const { c } = await importedProject()
    const crId = await newCr(c, "Change the login", "AMBIGUOUS-CR: change UC-02 somehow.")
    const asked = detail(await c.post(`/change-requests/${crId}/clarify`))
    expect(asked.change_request.status).toBe("awaiting_answers")
    expect(asked.change_request.clarifications).toEqual([{ round: 1, questions: ["Which screen?"], answers: [], suggestions: [[]] }])  // model không gợi ý ⇒ [] cho từng câu
    expect(asked.pending_questions).toEqual(["Which screen?"])
    const [prompt] = promptsOf("# CR Clarify")
    expect(prompt).toContain("Round 1 of at most 3")
    expect(prompt).toContain("AMBIGUOUS-CR: change UC-02 somehow.")
    expect(prompt).toContain("stakeholder_email — Email PM 2026-09-17")
    // projection nạp chi tiết phần tử CR nhắc tới; outline gồm heading của version mới nhất
    expect(prompt).toContain("use_cases[id=UC-02] =")
    expect(prompt).toContain("4.2.3 Performance (fixed:4.2.3)")
  })

  it("trả lời ⇒ chạy lại C-2 với câu trả lời trong prompt (vòng 2) ⇒ rõ ⇒ impact_review, lưu đích", async () => {
    const { c, projectId } = await importedProject()
    const crId = await newCr(c, "Change the login", "AMBIGUOUS-CR: change the login somehow.")
    detail(await c.post(`/change-requests/${crId}/clarify`))
    const answered = detail(await c.post(`/change-requests/${crId}/answers`, { answers: ["The login screen SCR-01"] }))
    expect(answered.change_request.status).toBe("impact_review")
    expect(answered.pending_questions).toEqual([])
    const clarifies = promptsOf("# CR Clarify")
    expect(clarifies).toHaveLength(2)
    expect(clarifies[1]).toContain("Round 2 of at most 3")
    expect(clarifies[1]).toContain("Q1.1: Which screen?\nA: The login screen SCR-01")
    const cr = await crDoc(projectId, crId)
    expect(cr.targets).toMatchObject({ entity_paths: PERF_TARGETS.entity_paths, keywords: PERF_TARGETS.keywords })
    // mỗi lượt gọi có sổ usage step C-2:<cr>
    expect(await Usage.countDocuments({ projectId, step_id: `C-2:${crId}` })).toBe(2)
  })

  it("CR rõ ngay vòng 1 ⇒ không hỏi, đi thẳng impact_review", async () => {
    const { c } = await importedProject()
    const crId = await newCr(c)
    const d = detail(await c.post(`/change-requests/${crId}/clarify`))
    expect(d.change_request).toMatchObject({ status: "impact_review", clarifications: [] })
    expect(promptsOf("# CR Clarify")).toHaveLength(1)
  })
})

describe("C-2 tối đa 3 vòng", () => {
  it("model vẫn mơ hồ sau 3 vòng hỏi ⇒ lần gọi thứ 4 bắt buộc đi tiếp, đích = từ khoá dự phòng từ tiêu đề", async () => {
    routeCr(alwaysAmbiguous)
    const { c, projectId } = await importedProject()
    const crId = await newCr(c, "Change the login screen somehow", "Something about login.")
    const cr = `/change-requests/${crId}`
    let d = detail(await c.post(`${cr}/clarify`))
    for (let round = 1; round <= 3; round++) {
      expect(d.change_request.status).toBe("awaiting_answers")
      expect(d.pending_questions).toEqual([`Question of round ${round}?`])
      d = detail(await c.post(`${cr}/answers`, { answers: [`Answer ${round}`] }))
    }
    expect(d.change_request.status).toBe("impact_review")
    expect(d.change_request.clarifications.map((x) => x.round)).toEqual([1, 2, 3])
    expect(d.change_request.clarifications.every((x) => x.answers.length === 1)).toBe(true)
    const prompts = promptsOf("# CR Clarify")
    expect(prompts).toHaveLength(4)
    // vòng thứ 4 vẫn báo "Round 3 of at most 3" cho model
    expect(prompts[3]).toContain("Round 3 of at most 3")
    expect(prompts[3]).toContain("Q3.1: Question of round 3?\nA: Answer 3")
    // từ ≥ 5 ký tự của tiêu đề, tối đa 5
    expect((await crDoc(projectId, crId)).targets).toMatchObject({ entity_paths: [], keywords: ["Change", "login", "screen", "somehow"] })
  })

  it("model rõ nhưng chỉ trả entity_paths ⇒ giữ keywords rỗng, không dùng dự phòng", async () => {
    routeCr((p) => (p.includes("# CR Clarify") ? clarifyOut({ ambiguous: false, entity_paths: ["nfrs[id=NFR-01]"] }) : undefined))
    const { c, projectId } = await importedProject()
    const crId = await newCr(c)
    detail(await c.post(`/change-requests/${crId}/clarify`))
    expect((await crDoc(projectId, crId)).targets).toMatchObject({ entity_paths: ["nfrs[id=NFR-01]"], keywords: [] })
  })

  it("model trả 'rõ' mà đích rỗng (sai schema) ⇒ retry rồi paused resume_later, không lưu đích, vẫn ở clarifying", async () => {
    routeCr((p) => (p.includes("# CR Clarify") ? clarifyOut({ ambiguous: false }) : undefined))
    const { c, projectId } = await importedProject()
    const crId = await newCr(c, "Performance update", "x")
    const d = detail(await c.post(`/change-requests/${crId}/clarify`))
    expect(d.change_request).toMatchObject({ status: "clarifying", paused: { reason: "resume_later" } })
    // lượt đầu + 2 lần retry
    expect(promptsOf("# CR Clarify")).toHaveLength(3)
    expect((await crDoc(projectId, crId)).targets).toMatchObject({ entity_paths: [], keywords: [] })
  })
})

describe("C-2 lỗi và biên", () => {
  it("trả lời sai số câu ⇒ 400; trả lời khi không chờ ⇒ 409; clarify lại khi đã impact_review ⇒ 409", async () => {
    const { c } = await importedProject()
    const crId = await newCr(c, "Change the login", "AMBIGUOUS-CR: something.")
    const cr = `/change-requests/${crId}`
    detail(await c.post(`${cr}/clarify`))
    const wrong = await c.post(`${cr}/answers`, { answers: ["a", "b"] })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error.code).toBe("VALIDATION_ERROR")
    expect((await c.post(`${cr}/answers`, { answers: [] })).status).toBe(400)
    // đang chờ trả lời thì không gọi clarify được
    expect((await c.post(`${cr}/clarify`)).body.error.code).toBe("CR_INVALID_TRANSITION")
    detail(await c.post(`${cr}/answers`, { answers: ["Login screen"] }))
    const late = await c.post(`${cr}/answers`, { answers: ["x"] })
    expect(late.status).toBe(409)
    expect(late.body.error.code).toBe("CR_INVALID_TRANSITION")
    expect((await c.post(`${cr}/clarify`)).status).toBe(409)
  })

  it("hết credit ⇒ paused credits ở clarifying, không hỏi; nạp rồi resume ⇒ đi tiếp", async () => {
    const { c, seeded } = await importedProject()
    const crId = await newCr(c)
    const { CreditWallet } = await import("../../../src/modules/credits/credit-wallet.model.js")
    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 0 } })
    const paused = detail(await c.post(`/change-requests/${crId}/clarify`))
    expect(paused.change_request).toMatchObject({ status: "clarifying", paused: { reason: "credits" }, clarifications: [] })
    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 100 } })
    const resumed = detail(await c.post(`/change-requests/${crId}/resume`))
    expect(resumed.change_request).toMatchObject({ status: "impact_review", paused: null })
  })

  it("service: thiếu Spine ⇒ 404 SPINE_NOT_FOUND; answerClarification sai số câu ⇒ 400", async () => {
    const { c, projectId, seeded } = await importedProject()
    const crId = await newCr(c, "Change the login", "AMBIGUOUS-CR: something.")
    detail(await c.post(`/change-requests/${crId}/clarify`))
    await expect(answerClarification(await crDoc(projectId, crId), seeded.userId, [])).rejects.toMatchObject({ statusCode: 400 })

    const other = await newCr(c)
    await Spine.deleteOne({ projectId })
    await expect(runClarify(await crDoc(projectId, other), seeded.userId)).rejects.toMatchObject({ statusCode: 404 })
  })

  it("model đổi câu hỏi giữa các vòng ⇒ mỗi vòng lưu riêng, pending_questions là vòng cuối", async () => {
    routeCr((p) => {
      if (!p.includes("# CR Clarify")) return undefined
      if (p.includes("Round 1 of")) return clarifyOut({ ambiguous: true, questions: ["Q-a?", "Q-b?"] })
      if (p.includes("Round 2 of")) return clarifyOut({ ambiguous: true, questions: ["Q-c?"] })
      return fakeCrClarify(PERF_TARGETS)(p)
    })
    const { c } = await importedProject()
    const crId = await newCr(c)
    const cr = `/change-requests/${crId}`
    expect(detail(await c.post(`${cr}/clarify`)).pending_questions).toEqual(["Q-a?", "Q-b?"])
    const r2 = detail(await c.post(`${cr}/answers`, { answers: ["A-a", "A-b"] }))
    expect(r2.pending_questions).toEqual(["Q-c?"])
    const done = detail(await c.post(`${cr}/answers`, { answers: ["A-c"] }))
    expect(done.change_request.status).toBe("impact_review")
    expect(done.change_request.clarifications).toEqual([
      { round: 1, questions: ["Q-a?", "Q-b?"], answers: ["A-a", "A-b"], suggestions: [[], []] },
      { round: 2, questions: ["Q-c?"], answers: ["A-c"], suggestions: [[]] }
    ])
  })
})
