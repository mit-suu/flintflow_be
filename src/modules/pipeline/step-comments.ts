/**
 * Comment mở lại step (business-flow §3.5): Analyst kết luận "đã sửa" ⇒ step sở hữu section quay về `revision_requested`
 * và AI soạn lại **theo comment**. Lượt soạn lại phải thấy chính các comment đó — chúng đã `resolved` (kind `fixed`) lúc
 * mở step, nên lọc theo thời điểm xử lý sau lần step được chốt gần nhất (`accepted_at`, mở lại theo comment không xoá mốc này).
 */

import { Comment } from "../comment/comment.model.js"
import type { Spine } from "../spine/spine.types.js"
import { stepsOf } from "../spine/section-registry.js"

export interface FixComment {
  comment_id: string
  section_id: string
  label: string
  text: string
}

export interface FixCommentSource {
  comment_id: string
  anchor: { section_id: string; label: string }
  text: string
  status: string
  resolution: { kind: string } | null
  handled_at: Date | null
}

/** Tối đa bao nhiêu comment / bao nhiêu ký tự mỗi comment đưa vào prompt (giữ projection gọn). */
export const FIX_COMMENTS_MAX = 20
const FIX_COMMENT_CHARS = 600

export const fixCommentsForStep = (spine: Pick<Spine, "steps">, stepId: string, comments: readonly FixCommentSource[]): FixComment[] => {
  const step = spine.steps.find((s) => s.id === stepId)
  if (step?.status !== "revision_requested" || !step.accepted_at) return []
  const since = new Date(step.accepted_at).getTime()
  return comments
    .filter((c) => c.status === "resolved" && c.resolution?.kind === "fixed" && c.handled_at !== null && new Date(c.handled_at).getTime() >= since)
    .filter((c) => stepsOf(c.anchor.section_id, spine as Spine).includes(stepId))
    .slice(0, FIX_COMMENTS_MAX)
    .map((c) => ({ comment_id: c.comment_id, section_id: c.anchor.section_id, label: c.anchor.label, text: c.text.slice(0, FIX_COMMENT_CHARS) }))
}

export const loadFixComments = async (projectId: string, spine: Pick<Spine, "steps">, stepId: string): Promise<FixComment[]> => {
  const step = spine.steps.find((s) => s.id === stepId)
  if (step?.status !== "revision_requested" || !step.accepted_at) return []
  const comments = (await Comment.find(
    { projectId, status: "resolved", "resolution.kind": "fixed", handled_at: { $gte: new Date(step.accepted_at) } },
    { comment_id: 1, anchor: 1, text: 1, status: 1, resolution: 1, handled_at: 1 }
  )
    .sort({ handled_at: 1 })
    .lean()) as unknown as FixCommentSource[]
  return fixCommentsForStep(spine, stepId, comments)
}
