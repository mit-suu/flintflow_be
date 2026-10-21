import { describe, expect, it } from "vitest"
import { planPersonalWalletCleanup } from "./remove-personal-wallets.js"

describe("planPersonalWalletCleanup — xoá ví cá nhân (FLF-310)", () => {
  it("xoá ví của người không còn lượt giữ credit đang chạy (kể cả reserved lệch còn sót); người đang giữ để lại", () => {
    const plan = planPersonalWalletCleanup(
      [
        { _id: "w1", userId: "u1", balance: 80, reserved: 0 },
        { _id: "w2", userId: "u2", balance: 10, reserved: 2 },
        { _id: "w3", userId: "u3", balance: 50, reserved: 4 }
      ],
      new Set(["u3"])
    )
    expect(plan.remove.map((w) => w._id)).toEqual(["w1", "w2"])
    expect(plan.skipped.map((w) => w._id)).toEqual(["w3"])
    expect(plan.droppedBalance).toBe(90)
  })

  it("không có ví cá nhân ⇒ không xoá gì", () => {
    expect(planPersonalWalletCleanup([])).toEqual({ remove: [], skipped: [], droppedBalance: 0 })
  })
})
