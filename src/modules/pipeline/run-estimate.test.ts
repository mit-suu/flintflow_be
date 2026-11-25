import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine, StepStatus } from "../spine/spine.types.js"
import { orderedSteps } from "./step-registry.js"
import { planRunEstimate, type RunEstimateCosts } from "./run-estimate.js"
import { screenLoopProfile, stepsPerScreen } from "../spine/section-status.js"

const COSTS: RunEstimateCosts = { draft: 4, review: 2, elicit: 1, reviewLlm: false }

/** Spine với mọi bước trước `upTo` đã accepted, bước `upTo` trở đi pending. */
const spineAt = (upTo: string, extra: Partial<Spine> = {}): Spine => {
  const spine: Spine = { ...createEmptySpine({ name: "P" }), ...extra }
  const all = orderedSteps(spine)
  const idx = all.findIndex((s) => s.id === upTo)
  spine.steps = all.map((s, i) => ({ id: s.id, status: (i < idx ? "accepted" : "pending") as StepStatus, first_seq: null, last_seq: null, accepted_at: null }))
  return spine
}

describe("planRunEstimate (FLF-332 - ước tính credit trước lượt chạy hàng loạt)", () => {
  it("scope unit: chỉ đơn vị giai đoạn của bước tới lượt; mỗi bước gọi model một lượt Draft, giai đoạn chưa phỏng vấn thêm một lượt Elicit", () => {
    const est = planRunEstimate(spineAt("S-2.1"), { scope: "unit" }, COSTS)
    expect(est.from_step).toBe("S-2.1")
    expect(est.units).toEqual([{ unit: "S-2", steps: 5, ai_steps: 5, interview_credits: 1, credits: 1 + 5 * 4 }])
    expect(est.steps_total).toBe(5)
    expect(est.credits_total).toBe(21)
  })

  it("đơn vị đã phỏng vấn (quyết định còn hiệu lực ghi dưới id đơn vị) ⇒ không tính Elicit; B-0 không bao giờ phỏng vấn", () => {
    const decided = planRunEstimate(
      spineAt("S-2.1", { decisions: [{ id: "d1", topic_key: "k", question: "q", answer: "a", step_id: "S-2", at: "2026-10-27T00:00:00.000Z", superseded_by: null }] }),
      { scope: "unit" },
      COSTS
    )
    expect(decided.units[0].interview_credits).toBe(0)
    expect(decided.credits_total).toBe(20)
    const b0 = planRunEstimate(spineAt("B-0.1"), { scope: "unit" }, COSTS)
    expect(b0.units[0]).toMatchObject({ unit: "B-0", interview_credits: 0 })
  })

  it("scope all từ S-2 (sau Approve Brief): đếm hết S-2 → S-9, bước tất định (S-8.2, S-8.3, S-9.1, S-9.5) không tốn credit", () => {
    const est = planRunEstimate(spineAt("S-2.1"), { scope: "all" }, COSTS)
    expect(est.units.map((u) => u.unit)).toEqual(["S-2", "S-3", "S-4", "S-6", "S-7", "S-8", "S-9"])
    expect(est.steps_total).toBe(34)
    expect(est.ai_steps_total).toBe(30)
    // 30 bước × 4 + 7 giai đoạn × 1 lượt hỏi
    expect(est.credits_total).toBe(30 * 4 + 7)
    expect(est.scope_kind).toBeNull()
  })

  it("vòng S-5 tính theo từng màn, hai bước sổ sách S-5.1 / S-5.5 không gọi model", () => {
    const spine = spineAt("S-5.1@S01", {
      screens: [
        { id: "S01", name: "Đăng nhập", order: 1 } as never,
        { id: "S02", name: "Trang chủ", order: 2 } as never
      ]
    })
    const est = planRunEstimate(spine, { scope: "all", from: "S-5@S01" }, COSTS)
    expect(est.units.slice(0, 2)).toEqual([
      { unit: "S-5@S01", steps: 5, ai_steps: 3, interview_credits: 1, credits: 13 },
      { unit: "S-5@S02", steps: 5, ai_steps: 3, interview_credits: 1, credits: 13 }
    ])
  })

  it("REVIEW_LLM_ENABLED ⇒ mỗi bước gọi model thêm một lượt Review", () => {
    const est = planRunEstimate(spineAt("S-2.1"), { scope: "unit" }, { ...COSTS, reviewLlm: true })
    expect(est.credits_total).toBe(1 + 5 * (4 + 2))
  })

  it("không còn bước nào ⇒ rỗng, 0 credit; `from` không có trong pipeline ⇒ 404 STEP_NOT_FOUND", () => {
    const done = spineAt("S-9.5")
    done.steps = done.steps.map((s) => ({ ...s, status: "accepted" }))
    expect(planRunEstimate(done, { scope: "all" }, COSTS)).toMatchObject({ from_step: null, units: [], steps_total: 0, credits_total: 0 })
    expect(() => planRunEstimate(spineAt("S-2.1"), { scope: "unit", from: "S-5@S99" }, COSTS)).toThrow(/S-5@S99/)
  })
})

describe("planRunEstimate theo số màn (FLF-466 P08)", () => {
  const screens = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `S0${i + 1}`, name: `M${i + 1}`, order: i + 1, detail_status: "pending" }) as never)
  const withInputs = (spine: Spine): Spine => ({
    ...spine,
    project: { ...spine.project, goals: ["g1", "g2"] },
    other_requirements: [{ id: "OR1", kind: "constraint", statement: "x" } as never, { id: "OR2", kind: "constraint", statement: "y" } as never]
  })

  it("after_brief: chính xác step cố định từ S-2 (không vòng màn) + dải màn ước tính = hệ số × đầu vào S-1", () => {
    const spine = withInputs(spineAt("S-2.1"))
    const est = planRunEstimate(spine, { scope: "all", scope_kind: "after_brief" }, COSTS)
    expect(est.scope_kind).toBe("after_brief")
    expect(est.units.map((u) => u.unit)).toEqual(["S-2", "S-3", "S-4", "S-6", "S-7", "S-8", "S-9"])
    // 4 đầu vào × [1.5, 2.5] = [6, 10]; mỗi màn 1 elicit + 3 step AI × 4
    expect(est.screen_range).toMatchObject({ min: 6, max: 10, credits_per_screen: 13, credits_max: 130, estimated: true })
    expect(est.screen_range?.inputs.total).toBe(4)
  })

  it("screens_locked: credit chính xác = credit mỗi màn × số màn; mẫu không có Screen Layout ra ít step / màn hơn", () => {
    const full = spineAt("S-5.1@S01", { screens: screens(3) })
    const est = planRunEstimate(full, { scope: "all", scope_kind: "screens_locked" }, COSTS)
    expect(est.screen_range).toBeNull()
    expect(est.steps_total).toBe(15)
    expect(est.credits_total).toBe(3 * 13)
    const noLayout = spineAt("S-5.1@S01", { screens: screens(3) })
    noLayout.steps = noLayout.steps.map((s) => (s.id.startsWith("S-5.3@") ? { ...s, status: "skipped" as StepStatus } : s))
    const small = planRunEstimate(noLayout, { scope: "all", scope_kind: "screens_locked" }, COSTS)
    expect(small.steps_total).toBe(12)
    expect(small.credits_total).toBe(3 * 9)
    expect(stepsPerScreen(screenLoopProfile(full))).toBe(5)
    expect(stepsPerScreen(screenLoopProfile(noLayout))).toBe(4)

    // FLF-466 P08: ở B-2.3 (before S-5.n@... tồn tại), TemplateProfile.step_plan ẩn S-5.3 ⇒ after_brief tính đúng 4 step/màn
    const atBrief = withInputs(spineAt("S-2.1"))
    const estNoLayout = planRunEstimate(atBrief, { scope: "all", scope_kind: "after_brief" }, COSTS, { step_plan: [{ step_id: "S-5.3", state: "hidden" }] })
    expect(estNoLayout.screen_range).toMatchObject({ min: 6, max: 10, credits_per_screen: 9, credits_max: 90, estimated: true })
    expect(stepsPerScreen(screenLoopProfile(atBrief, { step_plan: [{ step_id: "S-5.3", state: "hidden" }] }))).toBe(4)
  })

  it("screens_added: chỉ màn được báo; ack_required trả lại nguyên lần báo đang chờ (reload vẫn thấy)", () => {
    const spine = spineAt("S-5.1@S01", { screens: screens(3) })
    spine.progress = { ...spine.progress, credit_acked_screens: ["S01", "S02"], credit_ack_required: { scope: "screens_added", credits: 13, created_at: "2026-11-25T00:00:00.000Z", screens: ["S03"] } }
    const est = planRunEstimate(spine, { scope: "all" }, COSTS)
    expect(est.scope_kind).toBe("screens_added")
    expect(est.units.map((u) => u.unit)).toEqual(["S-5@S03"])
    expect(est.credits_total).toBe(13)
    expect(est.ack_required?.scope).toBe("screens_added")
  })
})
