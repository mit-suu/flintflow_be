import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine, StepStatus } from "../spine/spine.types.js"
import { orderedSteps } from "./step-registry.js"
import { planRunEstimate, type RunEstimateCosts } from "./run-estimate.js"

const COSTS: RunEstimateCosts = { draft: 4, review: 2, elicit: 1, reviewLlm: false }

/** Spine với mọi bước trước `upTo` đã accepted, bước `upTo` trở đi pending. */
const spineAt = (upTo: string, extra: Partial<Spine> = {}): Spine => {
  const spine: Spine = { ...createEmptySpine({ name: "P" }), ...extra }
  const all = orderedSteps(spine)
  const idx = all.findIndex((s) => s.id === upTo)
  spine.steps = all.map((s, i) => ({ id: s.id, status: (i < idx ? "accepted" : "pending") as StepStatus, first_seq: null, last_seq: null, accepted_at: null }))
  return spine
}

describe("planRunEstimate (FLF-332 — ước tính credit trước lượt chạy hàng loạt)", () => {
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

  it("scope all từ sau Approve Brief: đếm hết S-1 → S-9, bước tất định (S-8.2, S-8.3, S-9.1, S-9.5) không tốn credit", () => {
    const est = planRunEstimate(spineAt("S-1.1"), { scope: "all" }, COSTS)
    expect(est.units.map((u) => u.unit)).toEqual(["S-1", "S-2", "S-3", "S-4", "S-6", "S-7", "S-8", "S-9"])
    expect(est.steps_total).toBe(38)
    expect(est.ai_steps_total).toBe(34)
    // 34 bước × 4 + 8 giai đoạn × 1 lượt hỏi
    expect(est.credits_total).toBe(34 * 4 + 8)
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
