import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine, StepStatus } from "../spine/spine.types.js"
import { orderedSteps } from "./step-registry.js"
import { estimateScreenCount, planRunEstimate, type RunEstimateCosts } from "./run-estimate.js"

const COSTS: RunEstimateCosts = { draft: 4, review: 2, elicit: 1, consistency: 3, qualityLens: true, consistencyLlm: true }

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
    expect(est.units).toEqual([{ unit: "S-2", steps: 5, ai_steps: 5, interview_credits: 1, credits: 21, credits_min: 21, credits_max: 21 }])
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

  it("scope all từ sau Approve Brief: có đơn vị S-5 ước tính (cận trên 14 màn + 1 vòng không màn), bước tất định không tốn credit", () => {
    const est = planRunEstimate(spineAt("S-1.1"), { scope: "all" }, COSTS)
    expect(est.units.map((u) => u.unit)).toEqual(["S-1", "S-2", "S-3", "S-4", "S-5", "S-6", "S-7", "S-8", "S-9"])
    // mỗi màn: 1 lượt hỏi + 3 bước gọi model × 4 = 13; (14 + 1) vòng
    expect(est.units.find((u) => u.unit === "S-5")).toEqual({
      unit: "S-5",
      steps: 75,
      ai_steps: 45,
      interview_credits: 15,
      credits: 15 * 13,
      credits_min: 6 * 13,
      credits_max: 15 * 13,
      screens: { min: 6, max: 14 }
    })
    expect(est.steps_total).toBe(38 + 75)
    expect(est.ai_steps_total).toBe(34 + 45)
    // 31 bước Draft × 4 + S-8.4 (3 × 1 lô) + S-9.2 (2 × 1 lô) + S-9.3 (2) + 8 giai đoạn × 1 lượt hỏi + vòng màn hình
    expect(est.credits_total).toBe(31 * 4 + 3 + 2 + 2 + 8 + 195)
    expect(est.credits_max).toBe(est.credits_total)
    expect(est.credits_min).toBe(31 * 4 + 3 + 2 + 2 + 8 + 78)
    expect(est.screen_estimate).toEqual({ min: 6, max: 14, basis: "default" })
  })

  it("estimateScreenCount: use case > năng lực Brief nhắm mô tả màn hình > dải mặc định", () => {
    const base = createEmptySpine({ name: "P" })
    expect(estimateScreenCount(base)).toEqual({ min: 6, max: 14, basis: "default" })
    const addendum = Array.from({ length: 5 }, (_, i) => ({ id: `A${i}`, topic: "t", content: "c", content_en: "c", target_section: "fixed:3.1.2", captured_at: "2026-11-25T00:00:00.000Z" }))
    expect(estimateScreenCount({ ...base, addendum })).toEqual({ min: 5, max: 10, basis: "brief" })
    const use_cases = Array.from({ length: 8 }, (_, i) => ({ id: `UC-${i}` })) as never
    expect(estimateScreenCount({ ...base, addendum, use_cases })).toEqual({ min: 7, max: 12, basis: "use_cases" })
  })

  it("đơn vị S-5 ước tính theo số use case khi đã qua S-3, bắt đầu từ S-4.1", () => {
    const use_cases = Array.from({ length: 8 }, (_, i) => ({ id: `UC-${i}` })) as never
    const est = planRunEstimate(spineAt("S-4.1", { use_cases }), { scope: "all" }, COSTS)
    expect(est.units.find((u) => u.unit === "S-5")?.credits).toBe(13 * 13)
  })

  it("không thêm đơn vị S-5 ước tính khi scope unit, khi S-4.1 đã accepted (dự án không màn), hoặc Spine đã có màn", () => {
    expect(planRunEstimate(spineAt("S-2.1"), { scope: "unit" }, COSTS).units.map((u) => u.unit)).toEqual(["S-2"])
    expect(planRunEstimate(spineAt("S-5.1@nonscreen"), { scope: "all", from: "S-6.1" }, COSTS).units.some((u) => u.unit === "S-5")).toBe(false)
    expect(planRunEstimate(spineAt("S-4.2"), { scope: "all" }, COSTS).units.some((u) => u.unit === "S-5")).toBe(false)
    const withScreens = spineAt("S-5.1@S01", { screens: [{ id: "S01", name: "A", order: 1 } as never] })
    expect(planRunEstimate(withScreens, { scope: "all", from: "S-5@S01" }, COSTS).units.some((u) => u.unit === "S-5")).toBe(false)
  })

  it("màn placeholder ⇒ vòng của nó không được đếm", () => {
    const spine = spineAt("S-5.1@S01", {
      screens: [
        { id: "S01", name: "A", order: 1, detail_status: "pending" } as never,
        { id: "S02", name: "B", order: 2, detail_status: "placeholder" } as never
      ]
    })
    const est = planRunEstimate(spine, { scope: "all", from: "S-5@S01" }, COSTS)
    expect(est.units.map((u) => u.unit).filter((u) => u.startsWith("S-5"))).toEqual(["S-5@S01"])
  })

  it("lô: màn có 13 function ⇒ S-5.2 và S-5.4 mỗi bước 3 lượt Draft", () => {
    const functions = Array.from({ length: 13 }, (_, i) => ({ id: `F${String(i + 1).padStart(2, "0")}`, screen_id: "S01", order: i })) as never
    const spine = spineAt("S-5.1@S01", { screens: [{ id: "S01", name: "A", order: 1, detail_status: "pending" } as never], functions })
    const est = planRunEstimate(spine, { scope: "all", from: "S-5@S01" }, COSTS)
    // 1 hỏi + (3 + 1 + 3) × 4
    expect(est.units[0]).toMatchObject({ unit: "S-5@S01", credits: 1 + 7 * 4 })
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
      { unit: "S-5@S01", steps: 5, ai_steps: 3, interview_credits: 1, credits: 13, credits_min: 13, credits_max: 13 },
      { unit: "S-5@S02", steps: 5, ai_steps: 3, interview_credits: 1, credits: 13, credits_min: 13, credits_max: 13 }
    ])
    expect(est.screen_estimate).toEqual({ min: 2, max: 2, basis: "screens" })
    expect(est.credits_min).toBe(est.credits_max)
  })

  it("scope unit không đi qua S-5 ⇒ screen_estimate null", () => {
    expect(planRunEstimate(spineAt("S-2.1"), { scope: "unit" }, COSTS).screen_estimate).toBeNull()
  })

  it("FLF-449: S-9.2 tính Review × lô, S-8.4 tính Consistency × lô, S-9.3 tính Review; không còn tính Review cộng thêm cho bước khác", () => {
    const s9 = planRunEstimate(spineAt("S-9.2"), { scope: "unit" }, COSTS)
    // S-9.2 (2) + S-9.3 (2) + S-9.4 (4); S-9.5 tất định
    expect(s9.units[0]).toMatchObject({ unit: "S-9", ai_steps: 3 })
    expect(s9.units[0].credits - s9.units[0].interview_credits).toBe(2 + 2 + 4)
    const s8 = planRunEstimate(spineAt("S-8.4"), { scope: "unit" }, COSTS)
    expect(s8.units[0]).toMatchObject({ unit: "S-8", ai_steps: 1 })
    expect(s8.units[0].credits - s8.units[0].interview_credits).toBe(3)
    // Giá nhân theo số lô: tăng giá để thấy tích, Spine rỗng ⇒ 1 lô
    const pricey = planRunEstimate(spineAt("S-9.2"), { scope: "unit" }, { ...COSTS, review: 5 }).units[0]
    expect(pricey.credits - pricey.interview_credits).toBe(5 + 5 + 4)
  })

  it("FLF-449: cờ env tắt ⇒ S-9.2 / S-8.4 tính 0 và không cộng ai_steps", () => {
    const off = { ...COSTS, qualityLens: false, consistencyLlm: false }
    const s9 = planRunEstimate(spineAt("S-9.2"), { scope: "unit" }, off)
    expect(s9.units[0].ai_steps).toBe(2)
    expect(s9.units[0].credits - s9.units[0].interview_credits).toBe(2 + 4)
    const s8 = planRunEstimate(spineAt("S-8.4"), { scope: "unit" }, off)
    expect(s8.units[0]).toMatchObject({ ai_steps: 0, credits: s8.units[0].interview_credits })
  })

  it("không còn bước nào ⇒ rỗng, 0 credit; `from` không có trong pipeline ⇒ 404 STEP_NOT_FOUND", () => {
    const done = spineAt("S-9.5")
    done.steps = done.steps.map((s) => ({ ...s, status: "accepted" }))
    expect(planRunEstimate(done, { scope: "all" }, COSTS)).toMatchObject({ from_step: null, units: [], steps_total: 0, credits_total: 0 })
    expect(() => planRunEstimate(spineAt("S-2.1"), { scope: "unit", from: "S-5@S99" }, COSTS)).toThrow(/S-5@S99/)
  })
})
