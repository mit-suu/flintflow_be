import { describe, expect, it } from "vitest"
import { MIGRATION_ACTOR, planRedWaiverOps } from "./migrate-red-waivers.js"
import type { Flag } from "../modules/spine/spine.types.js"

const flag = (over: Partial<Flag>): Flag => ({
  id: "FL001",
  level: "red",
  rule_id: "section_empty",
  section_id: "fixed:1",
  target_id: null,
  message: "m",
  remediation_step: "S-2.1",
  opened_at_version: 1,
  resolved_at: null,
  waived_by_user: false,
  waive_reason: null,
  waived_at_version: null,
  kept_reason: null,
  kept_by: null,
  kept_at: null,
  ...over
})

describe("planRedWaiverOps (FLF-329)", () => {
  it("cờ đỏ mở còn waiver ⇒ 6 op: lý do cũ sang kept_reason, gỡ waiver; cờ vàng / cờ đóng / cờ đỏ không waive ⇒ bỏ qua", () => {
    const ops = planRedWaiverOps(
      [
        flag({ id: "FL001", waived_by_user: true, waive_reason: "Khách hàng chấp nhận chưa có số liệu", waived_at_version: 3 }),
        flag({ id: "FL002", level: "yellow", waived_by_user: true, waive_reason: "Khách hàng chấp nhận chưa có số liệu", waived_at_version: 3 }),
        flag({ id: "FL003", waived_by_user: true, waive_reason: "Khách hàng chấp nhận chưa có số liệu", waived_at_version: 3, resolved_at: "2026-10-01T00:00:00.000Z" }),
        flag({ id: "FL004" })
      ],
      "2026-10-26T00:00:00.000Z"
    )
    expect(ops.map((o) => [o.path, o.value])).toEqual([
      ["flags[id=FL001].kept_reason", "Khách hàng chấp nhận chưa có số liệu"],
      ["flags[id=FL001].kept_by", MIGRATION_ACTOR],
      ["flags[id=FL001].kept_at", "2026-10-26T00:00:00.000Z"],
      ["flags[id=FL001].waived_by_user", false],
      ["flags[id=FL001].waive_reason", null],
      ["flags[id=FL001].waived_at_version", null]
    ])
  })

  it("đã có kept_* (người dùng giữ nguyên sau khi waive) ⇒ giữ giá trị người dùng, chỉ gỡ waiver", () => {
    const ops = planRedWaiverOps([
      flag({ waived_by_user: true, waive_reason: "Lý do waive cũ hơn hai mươi ký tự", waived_at_version: 3, kept_reason: "Lý do giữ nguyên mới hơn hai mươi ký tự", kept_by: "u1", kept_at: "2026-10-20T00:00:00.000Z" })
    ])
    expect(ops.slice(0, 3).map((o) => o.value)).toEqual(["Lý do giữ nguyên mới hơn hai mươi ký tự", "u1", "2026-10-20T00:00:00.000Z"])
  })

  it("không có gì để chuyển ⇒ rỗng (chạy lại an toàn)", () => {
    expect(planRedWaiverOps([flag({})])).toEqual([])
  })
})
