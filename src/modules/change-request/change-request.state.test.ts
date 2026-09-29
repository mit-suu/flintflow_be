import { describe, it, expect } from "vitest"
import {
  CR_STATUSES,
  CR_TRANSITIONS,
  MAX_CLARIFY_ROUNDS,
  assertTransition,
  canAskMore,
  canPause,
  canTransition,
  holdsLocks,
  isTerminal,
  nextAfterVerifyFail,
  type CrStatus
} from "./change-request.state.js"
import { Mode1Error } from "../import/mode1.errors.js"

/** Bảng cạnh tiến viết tay theo plan §5.4 (chưa gồm huỷ). */
const FORWARD: [CrStatus, CrStatus][] = [
  ["draft", "clarifying"],
  ["clarifying", "awaiting_answers"],
  ["clarifying", "impact_review"],
  ["awaiting_answers", "clarifying"],
  ["impact_review", "proposing"],
  ["proposing", "verifying"],
  ["verifying", "ready_to_submit"],
  ["verifying", "proposing"],
  ["verifying", "manual_fix"],
  ["manual_fix", "verifying"],
  ["ready_to_submit", "in_review"],
  ["ready_to_submit", "verifying"],
  // phase 8: gộp thêm lệnh sửa ⇒ làm rõ lại
  ["impact_review", "clarifying"],
  ["proposing", "clarifying"],
  ["verifying", "clarifying"],
  ["manual_fix", "clarifying"],
  ["ready_to_submit", "clarifying"],
  ["in_review", "written"],
  ["in_review", "proposing"],
  ["in_review", "rejected"]
]
const TERMINAL: CrStatus[] = ["written", "rejected", "cancelled"]
const CANCEL: [CrStatus, CrStatus][] = CR_STATUSES.filter((s) => !TERMINAL.includes(s)).map((s) => [s, "cancelled"])
const key = (from: CrStatus, to: CrStatus) => `${from}→${to}`
const allowed = new Set([...FORWARD, ...CANCEL].map(([f, t]) => key(f, t)))

describe("change-request.state — cạnh chuyển trạng thái", () => {
  it.each(FORWARD)("%s → %s hợp lệ", (from, to) => {
    expect(canTransition(from, to)).toBe(true)
  })

  it.each(CANCEL)("huỷ được từ %s (UC-53, kể cả khi paused)", (from, to) => {
    expect(canTransition(from, to)).toBe(true)
  })

  it("mọi cặp (from, to) ngoài bảng đều bị từ chối — 100% cạnh có test", () => {
    for (const from of CR_STATUSES) {
      for (const to of CR_STATUSES) expect(canTransition(from, to), key(from, to)).toBe(allowed.has(key(from, to)))
    }
    const declared = CR_STATUSES.flatMap((from) => CR_TRANSITIONS[from].map((to) => key(from, to)))
    expect(new Set(declared)).toEqual(allowed)
  })

  it("chuyển sai ném 409 CR_INVALID_TRANSITION kèm đích hợp lệ", () => {
    try {
      assertTransition("draft", "in_review")
      expect.unreachable()
    } catch (err) {
      const e = err as Mode1Error
      expect(e).toBeInstanceOf(Mode1Error)
      expect(e.statusCode).toBe(409)
      expect(e.code).toBe("CR_INVALID_TRANSITION")
      expect(e.meta).toEqual({ status: "draft", to: "in_review", allowed: ["clarifying", "cancelled"] })
    }
  })

  it("ghi xong / đóng / huỷ là trạng thái cuối", () => {
    expect(CR_STATUSES.filter(isTerminal)).toEqual(TERMINAL)
  })
})

describe("change-request.state — pause, khoá, giới hạn", () => {
  it("chỉ bước gọi AI được pause: clarifying, proposing, verifying", () => {
    expect(CR_STATUSES.filter(canPause)).toEqual(["clarifying", "proposing", "verifying"])
  })

  it("giữ khoá block từ impact_review tới in_review; nháp, làm rõ và trạng thái cuối không giữ", () => {
    expect(CR_STATUSES.filter(holdsLocks)).toEqual(["impact_review", "proposing", "verifying", "manual_fix", "ready_to_submit", "in_review"])
    for (const s of TERMINAL) expect(holdsLocks(s)).toBe(false)
  })

  it("làm rõ tối đa 3 vòng", () => {
    expect(MAX_CLARIFY_ROUNDS).toBe(3)
    expect([0, 1, 2, 3, 4].map(canAskMore)).toEqual([true, true, true, false, false])
  })

  it("verify trượt: AI làm lại 2 lần, lần thứ 3 chuyển sửa tay (3.9)", () => {
    expect([0, 1, 2, 3].map(nextAfterVerifyFail)).toEqual(["proposing", "proposing", "manual_fix", "manual_fix"])
  })
})
