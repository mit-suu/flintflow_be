import { describe, expect, it } from "vitest"
import { bareTargetId, stillOpenIn, targetFlagsOf, unresolvedProblemText } from "./flag-target.js"
import type { Flag } from "./spine.types.js"

const flag = (over: Partial<Flag>): Flag =>
  ({
    id: "FL1",
    level: "red",
    rule_id: "nfr_missing_number",
    section_id: "fixed:4.2.2",
    target_id: "NFR-12",
    message: "Yêu cầu độ tin cậy NFR-12 thiếu chỉ số đo / ngưỡng",
    remediation_step: "S-6.3",
    opened_at_version: 1,
    resolved_at: null,
    waived_by_user: false,
    waive_reason: null,
    waived_at_version: null,
    kept_reason: null,
    kept_by: null,
    ...over
  }) as Flag

describe("FLF-428 flag-target", () => {
  it("bareTargetId bóc id khỏi đường dẫn", () => {
    expect(bareTargetId("nfrs[id=NFR-12]")).toBe("NFR-12")
    expect(bareTargetId("use_cases[id=UC01].actor_ids[=A08]")).toBe("UC01")
    expect(bareTargetId("S20")).toBe("S20")
  })

  it("nhận cờ theo nguyên văn message hoặc mã phần tử đứng riêng; bỏ cờ đã đóng; không khớp mã là tiền tố", () => {
    const flags = [flag({}), flag({ id: "FL2", target_id: "NFR-1", message: "Yêu cầu độ tin cậy NFR-1 thiếu chỉ số đo / ngưỡng" }), flag({ id: "FL3", target_id: "NFR-13", resolved_at: "2026-11-16T00:00:00Z" })]
    expect(targetFlagsOf({ flags }, 'Trong §4.2.2 Reliability: sửa vấn đề "Yêu cầu độ tin cậy NFR-12 thiếu chỉ số đo / ngưỡng"').map((t) => t.target_id)).toEqual(["NFR-12"])
    expect(targetFlagsOf({ flags }, "đặt ngưỡng cho nfr-1 là 0").map((t) => t.target_id)).toEqual(["NFR-1"])
    expect(targetFlagsOf({ flags }, "NFR-13 thêm ngưỡng")).toEqual([])
    expect(targetFlagsOf({ flags }, "")).toEqual([])
  })

  it("gợi ý sửa chỉ cho luật đã biết; câu problem nêu luật + phần tử + gợi ý", () => {
    const [t] = targetFlagsOf({ flags: [flag({})] }, "NFR-12")
    expect(t.fix_hint).toContain("nfrs[id=NFR-12].threshold")
    expect(unresolvedProblemText(t)).toContain("nfr_missing_number on NFR-12")
    const [other] = targetFlagsOf({ flags: [flag({ rule_id: "orphan_actor", target_id: "A09", message: 'Tác nhân "X" không thuộc use case nào' })] }, "A09")
    expect(other.fix_hint).toBeUndefined()
  })

  it("stillOpenIn: cờ đích còn mở trong flags[] đã tính lại", () => {
    const targets = targetFlagsOf({ flags: [flag({})] }, "NFR-12")
    expect(stillOpenIn(targets, { flags: [flag({ target_id: "nfrs[id=NFR-12]" })] })).toHaveLength(1)
    expect(stillOpenIn(targets, { flags: [flag({ resolved_at: "2026-11-16T00:00:00Z" })] })).toHaveLength(0)
  })
})
