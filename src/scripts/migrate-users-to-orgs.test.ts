import { describe, it, expect } from "vitest"
import { ORG_NAME_MAX } from "../modules/organization/organization.model.js"
import {
  BACKFILL_TARGETS,
  PLATFORM_NOTIFICATION_TYPES,
  buildReport,
  emptyStats,
  personalOrgName
} from "./migrate-users-to-orgs.js"

describe("migrate-users-to-orgs", () => {
  it("chạm đúng sáu collection đổi trục sở hữu, không chạm spines", () => {
    expect(BACKFILL_TARGETS.map((t) => t.collection)).toEqual([
      "projects",
      "folders",
      "creditwallets",
      "subscriptions",
      "credittransactions",
      "notifications"
    ])
    expect(BACKFILL_TARGETS.map((t) => t.collection)).not.toContain("spines")
  })

  it("thông báo cấp nền tảng không bị gắn vào org của ai", () => {
    const notifications = BACKFILL_TARGETS.find((t) => t.collection === "notifications")
    expect(notifications?.extraFilter).toEqual({ type: { $nin: [...PLATFORM_NOTIFICATION_TYPES] } })
  })

  it("tên org lấy từ tên hiển thị, thiếu thì lấy phần trước @ của email", () => {
    expect(personalOrgName({ name: "Tien", email: "tien@fpt.vn" })).toBe("Tien's Organization")
    expect(personalOrgName({ name: "  ", email: "hiep@fpt.vn" })).toBe("hiep's Organization")
    expect(personalOrgName({ name: null, email: null })).toBe("My Organization")
  })

  it("tên quá dài bị cắt về đúng giới hạn schema", () => {
    const name = personalOrgName({ name: "x".repeat(200), email: "a@b.c" })
    expect(name.length).toBeLessThanOrEqual(ORG_NAME_MAX)
    expect(name.endsWith("'s Organization")).toBe(true)
  })

  it("stats khởi tạo về 0 cho mọi collection", () => {
    const stats = emptyStats(true)
    expect(stats.dryRun).toBe(true)
    for (const target of BACKFILL_TARGETS) {
      expect(stats.backfilled[target.collection]).toBe(0)
      expect(stats.remainingNull[target.collection]).toBe(0)
    }
  })

  it("báo cáo nói rõ dry-run và kết luận sạch khi không còn document treo", () => {
    const report = buildReport(emptyStats(true), new Date("2026-09-20T00:00:00.000Z"))
    expect(report).toContain("dry-run")
    expect(report).toContain("Không còn document nào thiếu organizationId.")
  })

  it("báo cáo cảnh báo khi vẫn còn document thiếu organizationId", () => {
    const stats = emptyStats(false)
    stats.remainingNull.projects = 3
    const report = buildReport(stats, new Date("2026-09-20T00:00:00.000Z"))
    expect(report).toContain("Còn 3 document thiếu organizationId")
    expect(report).not.toContain("dry-run")
  })
})
