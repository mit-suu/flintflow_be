import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { CreditAckRequired, Spine } from "../spine/spine.types.js"
import { PHASES } from "./step-registry.js"
import { creditAckBlocks, uncoveredScreens } from "./credit-ack.js"

const ack = (scope: CreditAckRequired["scope"], screens?: string[]): CreditAckRequired => ({ scope, credits: 10, created_at: "2026-11-25T00:00:00.000Z", ...(screens ? { screens } : {}) })

describe("thứ tự giai đoạn (FLF-466 P08)", () => {
  it("S-1 chạy trước B-2; Approve Brief (B-2) trước S-2", () => {
    expect(PHASES.indexOf("S-1")).toBeLessThan(PHASES.indexOf("B-2"))
    expect(PHASES.indexOf("B-2")).toBeLessThan(PHASES.indexOf("S-2"))
  })
})

describe("creditAckBlocks", () => {
  it("không có lần báo ⇒ không chặn", () => expect(creditAckBlocks(null, "S-2.1")).toBe(false))
  it("after_brief chặn mọi step từ S-2, không chặn Brief / S-1", () => {
    expect(creditAckBlocks(ack("after_brief"), "S-2.1")).toBe(true)
    expect(creditAckBlocks(ack("after_brief"), "S-5.2@S01")).toBe(true)
    expect(creditAckBlocks(ack("after_brief"), "B-2.3")).toBe(false)
    expect(creditAckBlocks(ack("after_brief"), "S-1.4")).toBe(false)
  })
  it("screens_locked chỉ chặn vòng màn", () => {
    expect(creditAckBlocks(ack("screens_locked", ["S01"]), "S-5.1@S01")).toBe(true)
    expect(creditAckBlocks(ack("screens_locked", ["S01"]), "S-4.2")).toBe(false)
  })
  it("screens_added chỉ chặn vòng của màn được báo", () => {
    expect(creditAckBlocks(ack("screens_added", ["S03"]), "S-5.2@S03")).toBe(true)
    expect(creditAckBlocks(ack("screens_added", ["S03"]), "S-5.2@S01")).toBe(false)
  })
})

describe("uncoveredScreens", () => {
  const base = (extra: Partial<Spine["progress"]>, s41: boolean): Spine => {
    const spine = createEmptySpine({ name: "P" })
    spine.screens = ["S01", "S02", "S03"].map((id) => ({ id, name: id, detail_status: id === "S02" ? "signed_off" : "pending" }) as never)
    spine.steps = s41 ? [{ id: "S-4.1", status: "accepted", first_seq: null, last_seq: null, accepted_at: null }] : []
    spine.progress = { ...spine.progress, ...extra }
    return spine
  }
  it("dự án cũ (chưa có credit_acked_screens) hoặc chưa chốt S-4.1 ⇒ không bắt", () => {
    expect(uncoveredScreens(base({}, true))).toEqual([])
    expect(uncoveredScreens(base({ credit_acked_screens: [] }, false))).toEqual([])
  })
  it("màn thêm sau S-4.1 chưa được báo (bỏ màn đã signed_off)", () => {
    expect(uncoveredScreens(base({ credit_acked_screens: ["S01"] }, true))).toEqual(["S03"])
  })
})
