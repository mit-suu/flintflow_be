import { describe, expect, it } from "vitest"
import { FIX_COMMENTS_MAX, fixCommentsForStep, type FixCommentSource } from "./step-comments.js"
import { stepsOf } from "../spine/section-registry.js"
import type { Spine } from "../spine/spine.types.js"

// Section cố định có step sở hữu — lấy từ bảng thật để test không gắn cứng id step
const SECTION = "fixed:2.1"
const OWNER = stepsOf(SECTION)[0]!

const spineWith = (status: string, acceptedAt: string | null): Pick<Spine, "steps"> =>
  ({ steps: [{ id: OWNER, status, first_seq: null, last_seq: null, accepted_at: acceptedAt }] }) as unknown as Pick<Spine, "steps">

const comment = (id: string, over: Partial<FixCommentSource> = {}): FixCommentSource => ({
  comment_id: id,
  anchor: { section_id: SECTION, label: "2.1 Actors" },
  text: `Góp ý ${id}`,
  status: "resolved",
  resolution: { kind: "fixed" },
  handled_at: new Date("2026-11-20T10:00:00Z"),
  ...over
})

describe("comment đưa vào lượt soạn lại của step mở lại (business-flow §3.5)", () => {
  it("step mở lại ⇒ chỉ comment 'đã sửa' xử lý sau lần chốt gần nhất, trên section step sở hữu", () => {
    expect(OWNER).toBeTruthy()
    const spine = spineWith("revision_requested", "2026-11-19T00:00:00Z")
    const out = fixCommentsForStep(spine, OWNER, [
      comment("CM-001"),
      comment("CM-002", { resolution: { kind: "kept" } }),
      comment("CM-003", { handled_at: new Date("2026-11-18T00:00:00Z") }),
      comment("CM-004", { status: "open", resolution: null, handled_at: null }),
      comment("CM-005", { anchor: { section_id: "fixed:does-not-exist", label: "x" } })
    ])
    expect(out).toEqual([{ comment_id: "CM-001", section_id: SECTION, label: "2.1 Actors", text: "Góp ý CM-001" }])
  })

  it("step không ở trạng thái mở lại, hoặc chưa từng chốt ⇒ không đưa comment nào", () => {
    expect(fixCommentsForStep(spineWith("accepted", "2026-11-19T00:00:00Z"), OWNER, [comment("CM-001")])).toEqual([])
    expect(fixCommentsForStep(spineWith("revision_requested", null), OWNER, [comment("CM-001")])).toEqual([])
  })

  it("giới hạn số comment để projection gọn", () => {
    const many = Array.from({ length: FIX_COMMENTS_MAX + 5 }, (_, i) => comment(`CM-${i}`))
    expect(fixCommentsForStep(spineWith("revision_requested", "2026-11-19T00:00:00Z"), OWNER, many)).toHaveLength(FIX_COMMENTS_MAX)
  })
})
