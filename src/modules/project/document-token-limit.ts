/**
 * FLF-405 — giới hạn tài liệu tham khảo theo token của phần chữ (business-flow §3.6): một mức cho **mỗi lần tải** (sức đọc
 * của model — `REFERENCE_MAX_TOKENS_PER_UPLOAD`) và một mức **tổng mỗi dự án** theo gói của org sở hữu
 * (`plan.config` `maxReferenceTokens`). Không giới hạn số file.
 *
 * Kiểm ngay sau khi Code trích chữ, trước khi upload Cloudinary / ghi DB / gọi model ⇒ bị từ chối không tốn gì.
 * Tài liệu đã có trước khi bật trần không bị xoá hay chặn; dự án đang vượt trần chỉ không tải thêm được.
 */
import type mongoose from "mongoose"
import { env } from "../../config/env.js"
import { getPlan, type PlanDefinition } from "../billing/plan.config.js"
import { Subscription } from "../credits/subscription.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { ProjectDocument } from "./project-document.model.js"

export const DOCUMENT_TOO_LONG = "DOCUMENT_TOO_LONG"
export const PROJECT_DOCUMENT_QUOTA_EXCEEDED = "PROJECT_DOCUMENT_QUOTA_EXCEEDED"

const SPLIT_HINT = "Hãy tách file hoặc chỉ giữ phần liên quan rồi tải lại."

const fmt = (n: number): string => n.toLocaleString("vi-VN")

export interface ReferenceTokenLimits {
  perUpload: number
  perProject: number
  plan: PlanDefinition
}

/** Trần của dự án lấy theo gói đang active của org sở hữu; chưa có gói ⇒ Free. */
export const referenceTokenLimits = async (orgId: string | mongoose.Types.ObjectId): Promise<ReferenceTokenLimits> => {
  const subscription = await Subscription.findOne({ organizationId: orgId, status: "active" }).select("plan").lean()
  const plan = getPlan(subscription?.plan ?? "free")
  return { perUpload: env.REFERENCE_MAX_TOKENS_PER_UPLOAD, perProject: plan.maxReferenceTokens, plan }
}

/**
 * Tổng token tài liệu **còn hiệu lực** của dự án (bản đã bị thay không tính; parse lỗi `tokenCount = null` không tính).
 * `excludeDocumentId`: bản sắp bị thay ("Thay bản cũ") — trừ ra trước khi so.
 */
export const referenceTokensUsed = async (
  projectId: string | mongoose.Types.ObjectId,
  excludeDocumentId?: string | null
): Promise<number> => {
  const docs = await ProjectDocument.find({ projectId, supersededBy: null }).select("_id tokenCount").lean()
  return docs.reduce((sum, d) => (excludeDocumentId && String(d._id) === excludeDocumentId ? sum : sum + (d.tokenCount ?? 0)), 0)
}

export interface ReferenceTokenCheck {
  file: string
  tokenCount: number
  used: number
  perUpload: number
  perProject: number
}

/** Hàm thuần: vượt trần ⇒ `413` kèm số token + trần trong `meta`. */
export const checkReferenceTokens = ({ file, tokenCount, used, perUpload, perProject }: ReferenceTokenCheck): void => {
  if (tokenCount > perUpload) {
    throw new ApiError(
      413,
      `Tài liệu "${file}" dài khoảng ${fmt(tokenCount)} token, vượt giới hạn ${fmt(perUpload)} token cho mỗi lần tải. ${SPLIT_HINT}`,
      DOCUMENT_TOO_LONG,
      { file, token_count: tokenCount, limit: perUpload }
    )
  }
  if (used + tokenCount > perProject) {
    throw new ApiError(
      413,
      `Dự án đã dùng ${fmt(used)} / ${fmt(perProject)} token tài liệu tham khảo; thêm "${file}" (khoảng ${fmt(tokenCount)} token) sẽ vượt giới hạn. Hãy xoá bớt tài liệu không cần, tách file hoặc chỉ giữ phần liên quan.`,
      PROJECT_DOCUMENT_QUOTA_EXCEEDED,
      { file, token_count: tokenCount, used, limit: perProject }
    )
  }
}

/**
 * Bước 1 — ngay sau khi trích chữ: trần một lần tải. Trả trần đã nạp để bước 2 dùng lại.
 * Chỉ cần `tokenCount` của chính file nên chặn sớm nhất, trước cả kiểm trùng / hỏi bản mới.
 */
export const assertReferenceUploadLimit = async (input: {
  orgId: string | mongoose.Types.ObjectId
  file: string
  tokenCount: number
}): Promise<ReferenceTokenLimits> => {
  const limits = await referenceTokenLimits(input.orgId)
  checkReferenceTokens({ file: input.file, tokenCount: input.tokenCount, used: 0, perUpload: limits.perUpload, perProject: Number.POSITIVE_INFINITY })
  return limits
}

/**
 * Bước 2 — sau kiểm trùng / hỏi bản mới (FLF-398), trước Cloudinary / ghi DB: trần tổng dự án. Phải chạy sau bước hỏi bản
 * mới, nếu không người dùng sát trần không bao giờ được hỏi "Thay bản cũ" để trừ token bản cũ.
 */
export const assertReferenceProjectQuota = async (input: {
  limits: ReferenceTokenLimits
  projectId: string | mongoose.Types.ObjectId
  file: string
  tokenCount: number
  replaceDocumentId?: string | null
}): Promise<void> => {
  const used = await referenceTokensUsed(input.projectId, input.replaceDocumentId)
  checkReferenceTokens({ file: input.file, tokenCount: input.tokenCount, used, perUpload: input.limits.perUpload, perProject: input.limits.perProject })
}

/** `meta` của `GET /projects/:id/documents` — FE hiện "đã dùng x / y". */
export const referenceTokenMeta = async (
  orgId: string | mongoose.Types.ObjectId,
  projectId: string | mongoose.Types.ObjectId
): Promise<{ tokens_used: number; tokens_limit: number; tokens_per_upload_limit: number }> => {
  const [{ perUpload, perProject }, used] = await Promise.all([referenceTokenLimits(orgId), referenceTokensUsed(projectId)])
  return { tokens_used: used, tokens_limit: perProject, tokens_per_upload_limit: perUpload }
}
