import { describe, it, expect } from "vitest"
import { DRAFT_LOCKED, assertDraftUnlocked, isDraftLocked } from "./draft-lock.js"
import type { BaselineSubmission } from "./spine.types.js"

const submission = (status: BaselineSubmission["status"]): BaselineSubmission => ({
  status,
  submitted_by: "u1",
  submitted_at: "2026-10-17T10:08:00.000Z",
  spine_version: 916,
  decided_by: null,
  decided_at: null,
  reason: null,
  rejection_comment_ids: []
})

describe("draft-lock — khoá sửa khi đang chờ Lead duyệt (FLF-293)", () => {
  it("chưa nộp hoặc Lead đã từ chối ⇒ sửa được", () => {
    expect(isDraftLocked({ baseline_submission: null })).toBe(false)
    expect(isDraftLocked({ baseline_submission: submission("rejected") })).toBe(false)
    expect(() => assertDraftUnlocked({ baseline_submission: null })).not.toThrow()
    expect(() => assertDraftUnlocked(null)).not.toThrow()
  })

  it("đang chờ duyệt ⇒ 409 DRAFT_LOCKED", () => {
    expect(isDraftLocked({ baseline_submission: submission("pending") })).toBe(true)
    expect(() => assertDraftUnlocked({ baseline_submission: submission("pending") })).toThrow(
      expect.objectContaining({ statusCode: 409, code: DRAFT_LOCKED })
    )
  })
})
