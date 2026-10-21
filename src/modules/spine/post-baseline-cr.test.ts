import { describe, it, expect } from "vitest"
import { CR_FIELDS_REQUIRED, assertCrInfo, crReason } from "./post-baseline-cr.js"
import { changeRequestInfoSchema } from "../pipeline/pipeline.dto.js"

describe("post-baseline-cr — FLF-294", () => {
  it("thiếu thông tin CR ⇒ 400 CR_FIELDS_REQUIRED; có ⇒ trả lại nguyên", () => {
    expect(() => assertCrInfo(undefined)).toThrow(expect.objectContaining({ statusCode: 400, code: CR_FIELDS_REQUIRED }))
    const info = { requester: "Ms. Lan", source: { kind: "verbal" as const } }
    expect(assertCrInfo(info)).toBe(info)
  })

  it("reason của lô = mã · người yêu cầu · nguồn (kèm tham chiếu nếu có) — lý do", () => {
    expect(crReason("CR-003", { requester: " Ms. Lan ", source: { kind: "meeting_minutes", ref: "Biên bản 15/10" } }, "Thêm cảnh báo vắng")).toBe(
      "CR-003 · Ms. Lan · meeting minutes: Biên bản 15/10 — Thêm cảnh báo vắng"
    )
    expect(crReason("CR-004", { requester: "Lead", source: { kind: "verbal", ref: null } }, "x")).toBe("CR-004 · Lead · verbal request — x")
  })

  it("DTO: chỉ nhận 6 nguồn của C-1 (không nhận `chat`), người yêu cầu không rỗng", () => {
    expect(changeRequestInfoSchema.safeParse({ requester: "Ms. Lan", source: { kind: "stakeholder_email", ref: "mail 12/10" } }).success).toBe(true)
    expect(changeRequestInfoSchema.safeParse({ requester: "Ms. Lan", source: { kind: "chat" } }).success).toBe(false)
    expect(changeRequestInfoSchema.safeParse({ requester: "  ", source: { kind: "verbal" } }).success).toBe(false)
  })
})
