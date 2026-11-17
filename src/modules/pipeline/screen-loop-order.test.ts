import { describe, expect, it } from "vitest"
import { compareScreenIds, loopKeys, screenLoopOrder } from "./step-registry.js"
import { nextPendingScreen } from "./step-runner.service.js"
import type { Spine } from "../spine/spine.types.js"

const screen = (id: string, detail_status = "pending", queue_order = 0) => ({ id, detail_status, queue_order })

describe("P06 - vòng S-5 theo số màn (chốt 17/11)", () => {
  it("so mã màn theo số", () => {
    expect(["SCR-10", "SCR-02", "SCR-03"].sort(compareScreenIds)).toEqual(["SCR-02", "SCR-03", "SCR-10"])
    expect(["S10", "S2"].sort(compareScreenIds)).toEqual(["S2", "S10"])
  })
  it("dự án mới: theo số màn, bỏ qua queue_order model đặt", () => {
    const screens = [screen("S07", "pending", 1), screen("S03", "pending", 2), screen("S02", "pending", 0)]
    expect(screenLoopOrder(screens).map((s) => s.id)).toEqual(["S02", "S03", "S07"])
    expect(loopKeys({ screens, functions: [] } as never)).toEqual(["S02", "S03", "S07"])
  })
  it("màn đã xong / đang làm giữ phía trước — vòng dở không nhảy màn", () => {
    const screens = [screen("S02", "signed_off"), screen("S07", "in_progress"), screen("S03"), screen("S05")]
    expect(screenLoopOrder(screens).map((s) => s.id)).toEqual(["S02", "S07", "S03", "S05"])
  })
  it("nextPendingScreen lấy màn chờ trong hàng đợi theo số màn", () => {
    const spine = { screens: [screen("S07"), screen("S03"), screen("S05")], progress: { screen_queue: ["S07", "S05", "S03"] } } as unknown as Spine
    expect(nextPendingScreen(spine)).toBe("S03")
  })
})
