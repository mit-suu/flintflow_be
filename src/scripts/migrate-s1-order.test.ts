import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../modules/spine/spine.repository.js"
import { orderedSteps } from "../modules/pipeline/step-registry.js"
import type { Spine, StepStatus } from "../modules/spine/spine.types.js"
import { planS1OrderMigration } from "./migrate-s1-order.js"

/** Step trước `upTo` (theo thứ tự cũ truyền vào) accepted. */
const withStatus = (accepted: string[]): Spine => {
  const spine = createEmptySpine({ name: "P" })
  spine.steps = orderedSteps(spine).map((s) => ({ id: s.id, status: (accepted.includes(s.id) ? "accepted" : "pending") as StepStatus, first_seq: 1, last_seq: 2, accepted_at: "2026-11-01T00:00:00.000Z" }))
  return spine
}
const B01_B16 = ["B-0.1", "B-0.2", "B-0.3", "B-1.1", "B-1.2", "B-1.3", "B-1.4", "B-1.5", "B-1.6"]

describe("planS1OrderMigration (FLF-466 P08)", () => {
  it("B-2.1 đã accepted, B-2.2 chưa, S-1 chưa chạy ⇒ mở lại B-2.1 và đặt con trỏ về S-1.1", () => {
    const plan = planS1OrderMigration(withStatus([...B01_B16, "B-2.1"]))
    expect(plan.action).toBe("reset_b2")
    expect(plan.reopened).toEqual(["B-2.1"])
    expect(plan.ops).toContainEqual({ op: "set", path: "steps[id=B-2.1].status", value: "pending" })
    expect(plan.ops).toContainEqual({ op: "set", path: "progress.current_step", value: "S-1.1" })
  })
  it("Approve Brief (B-2.3) đã accepted mà S-1 chưa xong ⇒ mở lại cả ba B-2.x", () => {
    const plan = planS1OrderMigration(withStatus([...B01_B16, "B-2.1", "B-2.2", "B-2.3"]))
    expect(plan.reopened).toEqual(["B-2.1", "B-2.2", "B-2.3"])
  })
  it("chưa B-2.x nào accepted ⇒ không mở lại gì, chỉ chỉnh con trỏ (nếu lệch)", () => {
    const spine = withStatus(B01_B16)
    spine.progress = { ...spine.progress, current_phase: "B-2", current_step: "B-2.1" }
    const plan = planS1OrderMigration(spine)
    expect(plan.action).toBe("fix_pointer")
    expect(plan.reopened).toEqual([])
  })
  it("S-1 đã xong ⇒ hợp lệ, không đổi; idempotent", () => {
    expect(planS1OrderMigration(withStatus([...B01_B16, "S-1.1", "S-1.2", "S-1.3", "S-1.4", "B-2.1", "B-2.2", "B-2.3"])).action).toBe("none")
  })
  it("S-1 chưa xong mà đã có step từ S-2 accepted ⇒ để xử lý tay", () => {
    expect(planS1OrderMigration(withStatus([...B01_B16, "S-2.1"])).action).toBe("manual")
  })
})
