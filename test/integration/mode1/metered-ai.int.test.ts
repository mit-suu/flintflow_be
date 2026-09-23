/**
 * `withMeteredAi` trên đường thật (FLF-172, P4 §8.3 `metered-ai.test.ts`; plan §6 2G): `executeAiAction` thật (giữ/trừ/hoàn
 * credit, retry 2 lần), sổ `Usage` thật, provider giả ở tầng `callLLM`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeCrClarify } from "../../helpers/mode1.js"
import { createCr, crDetail, importedProject, routeReplaceCr } from "../../helpers/mode1-release-p4.js"
import { Usage } from "../../../src/modules/spine/usage.model.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { withMeteredAi } from "../../../src/modules/import/metered-ai.js"
import { ActionType } from "../../../src/shared/ai/ai-action.types.js"

beforeEach(() => {
  resetMockLlm()
  routeReplaceCr("2 seconds", "1 second")
})

const wallet = async (userId: string) => (await CreditWallet.findOne({ userId }).lean())!

const usageOf = async (projectId: string, stepId: string) => Usage.find({ projectId, step_id: stepId }).lean()

/** Bọc route hiện tại: `plan` quyết định lượt thứ n của prompt C-2 (Error ⇒ ném, chuỗi ⇒ trả thô, undefined ⇒ đi tiếp). */
const scriptClarify = (plan: (n: number) => string | Error | undefined) => {
  const base = mockOverrides.next!
  const counter = { n: 0 }
  mockOverrides.next = (p) => {
    if (p.includes("# CR Clarify")) {
      counter.n++
      const scripted = plan(counter.n)
      if (scripted !== undefined) return scripted
    }
    return base(p)
  }
  return counter
}

describe("withMeteredAi — usage theo từng loại gọi (luồng thật)", () => {
  it("import + CR: usage I-4:<section>, I-1.11, C-2/C-4/C-5:<cr> đều deducted; ví bị trừ đúng tổng cost; không còn hold", async () => {
    const { c, projectId, seeded } = await importedProject()
    const crId = await createCr(c, "Faster", "1 second instead of 2 seconds")
    const cr = `/change-requests/${crId}`
    for (const step of ["clarify", "impact", "propose", "verify"]) crDetail(await c.post(`${cr}/${step}`))

    const rows = await Usage.find({ projectId }).lean()
    const steps = new Set(rows.map((r) => r.step_id))
    expect([...steps].filter((s) => s.startsWith("I-4:")).length).toBeGreaterThan(0)
    for (const s of [...steps].filter((x) => x.startsWith("I-4:"))) expect(s).toMatch(/^I-4:(fixed|function):/)
    for (const s of ["I-1.11", "C-2:CR-001", "C-4:CR-001", "C-5:CR-001"]) expect(steps.has(s), s).toBe(true)
    expect(rows.every((r) => r.state === "deducted")).toBe(true)
    expect(rows.find((r) => r.step_id === "C-2:CR-001")).toMatchObject({ call_kind: ActionType.CR_CLARIFY, attempt: 1 })
    expect(rows.find((r) => r.step_id === "C-4:CR-001")).toMatchObject({ call_kind: ActionType.CR_PROPOSE })
    expect(rows.find((r) => r.step_id === "C-5:CR-001")).toMatchObject({ call_kind: ActionType.CR_CONSISTENCY })
    expect(rows.find((r) => r.step_id === "I-1.11")).toMatchObject({ call_kind: ActionType.IMPORT_SEMANTIC_CHECK })
    expect(rows.every((r) => r.tokens_in > 0 && r.tokens_out > 0 && r.logId)).toBe(true)

    const w = await wallet(seeded.userId)
    const spent = rows.reduce((sum, r) => sum + r.cost, 0)
    expect(spent).toBeGreaterThan(0)
    expect(1000 - w.balance).toBe(spent)
    expect(w.reserved).toBe(0)
  })
})

describe("withMeteredAi — retry + lỗi (C-2)", () => {
  it("timeout rồi sai schema rồi đúng ⇒ 3 lượt gọi (retry 2 lần), một usage deducted, ví trừ một lần, CR đi tiếp", async () => {
    const { c, projectId, seeded } = await importedProject()
    const before = await wallet(seeded.userId)
    const crId = await createCr(c, "Faster", "1 second instead of 2 seconds")
    const counter = scriptClarify((n) => (n === 1 ? new Error("Request timeout") : n === 2 ? "không phải JSON" : undefined))
    const res = crDetail(await c.post(`/change-requests/${crId}/clarify`))
    expect(counter.n).toBe(3)
    expect(res.change_request).toMatchObject({ status: "impact_review", paused: null })
    const rows = await usageOf(projectId, `C-2:${crId}`)
    expect(rows.map((r) => r.state)).toEqual(["deducted"])
    const after = await wallet(seeded.userId)
    expect(before.balance - after.balance).toBe(rows[0].cost)
    expect(after.reserved).toBe(0)
  }, 20_000)

  it("lỗi tạm thời cả 3 lượt ⇒ paused resume_later, usage refunded, ví không bị trừ; resume ⇒ đi tiếp", async () => {
    const { c, projectId, seeded } = await importedProject()
    const before = await wallet(seeded.userId)
    const crId = await createCr(c, "Faster", "1 second instead of 2 seconds")
    let failing = true
    const counter = scriptClarify(() => (failing ? new Error("upstream timeout") : undefined))
    const paused = crDetail(await c.post(`/change-requests/${crId}/clarify`))
    expect(counter.n).toBe(3)
    expect(paused.change_request).toMatchObject({ status: "clarifying", paused: { reason: "resume_later" } })
    expect((await usageOf(projectId, `C-2:${crId}`)).map((r) => r.state)).toEqual(["refunded"])
    expect(await wallet(seeded.userId)).toMatchObject({ balance: before.balance, reserved: 0 })

    failing = false
    const resumed = crDetail(await c.post(`/change-requests/${crId}/resume`))
    expect(resumed.change_request).toMatchObject({ status: "impact_review", paused: null })
    expect((await usageOf(projectId, `C-2:${crId}`)).map((r) => r.state).sort()).toEqual(["deducted", "refunded"])
  }, 30_000)

  it("lỗi không tạm thời ⇒ không retry (1 lượt), paused resume_later", async () => {
    const { c, seeded } = await importedProject()
    const crId = await createCr(c, "Faster", "1 second instead of 2 seconds")
    const counter = scriptClarify(() => new Error("invalid api key"))
    const paused = crDetail(await c.post(`/change-requests/${crId}/clarify`))
    expect(counter.n).toBe(1)
    expect(paused.change_request.paused).toMatchObject({ reason: "resume_later" })
    expect((await wallet(seeded.userId)).reserved).toBe(0)
  })

  it("hết credit ⇒ paused credits, provider không được gọi, usage refunded; nạp rồi resume ⇒ đi tiếp", async () => {
    const { c, projectId, seeded } = await importedProject()
    const crId = await createCr(c, "Faster", "1 second instead of 2 seconds")
    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 0 } })
    const counter = scriptClarify(() => undefined)
    const paused = crDetail(await c.post(`/change-requests/${crId}/clarify`))
    expect(counter.n).toBe(0)
    expect(paused.change_request).toMatchObject({ status: "clarifying", paused: { reason: "credits" } })
    expect((await usageOf(projectId, `C-2:${crId}`)).map((r) => r.state)).toEqual(["refunded"])
    expect(await wallet(seeded.userId)).toMatchObject({ balance: 0, reserved: 0 })

    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 50 } })
    const resumed = crDetail(await c.post(`/change-requests/${crId}/resume`))
    expect(resumed.change_request).toMatchObject({ status: "impact_review", paused: null })
    expect(counter.n).toBe(1)
  })
})

describe("withMeteredAi — gọi trực tiếp", () => {
  it("trả data đã parse + usageId trỏ tới dòng usage deducted với tokens/cost thật", async () => {
    const { projectId, seeded } = await importedProject()
    mockOverrides.next = (p) => fakeCrClarify({ entity_paths: [], keywords: ["x"] })(p)
    const res = await withMeteredAi<{ ambiguous: boolean }>({ projectId, userId: seeded.userId, stepId: "C-2:CR-099" }, ActionType.CR_CLARIFY, {
      cr_id: "CR-099",
      title: "t",
      description: "d",
      round: 1,
      clarifications: "",
      projection: "",
      outline: ""
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.ambiguous).toBe(false)
    const row = (await Usage.findById(res.usageId).lean())!
    expect(row).toMatchObject({ step_id: "C-2:CR-099", state: "deducted", tokens_in: res.tokens_in, tokens_out: res.tokens_out, cost: res.cost })
  })
})
