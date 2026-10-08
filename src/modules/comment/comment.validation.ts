import { z } from "zod"
import { COMMENT_ID_PATTERN, COMMENT_TEXT_MAX } from "./comment.model.js"

/** Thông báo theo đặc tả UC-49 (SRS v6 §3.9.3, Abnormal case). */
const commentText = z
  .string({ error: "Comment không được để trống." })
  .trim()
  .min(1, "Comment không được để trống.")
  .max(COMMENT_TEXT_MAX, `Comment dài quá ${COMMENT_TEXT_MAX} ký tự.`)

/** `POST /projects/:projectId/comments` */
export const createCommentSchema = z.strictObject({
  version: z.strictObject({
    source: z.enum(["draft", "baseline"]),
    /** `id` (`BLnnn`) hoặc `snapshot_ref` mà `GET /baselines` trả; bỏ trống với baseline ⇒ baseline mới nhất. */
    baseline_id: z.string().trim().min(1).max(100).optional()
  }),
  anchor: z.strictObject({
    section_id: z.string().trim().min(1).max(200),
    block_index: z.number().int().min(0).nullable().default(null)
  }),
  text: commentText
})

/** `POST /projects/:projectId/comments/:commentId/replies` */
export const replyCommentSchema = z.strictObject({ text: commentText })

/** `GET /projects/:projectId/comments?status=` — mặc định chỉ comment còn mở ("Show resolved" tắt). */
export const listCommentsQuerySchema = z.object({
  status: z.enum(["open", "all"]).default("open")
})

export const commentParamsSchema = z.object({
  commentId: z.string().regex(COMMENT_ID_PATTERN, "Mã comment không hợp lệ.")
})

export type CreateCommentDTO = z.infer<typeof createCommentSchema>
