/**
 * Mongoose model TranslationRunLock — khoá "đang dịch theo lô" theo (dự án, ngôn ngữ) (FLF-265 §2.4).
 * Hai `POST /translations/run` chồng nhau (bấm đúp, hai analyst, FE thử lại) sẽ tính cùng phần thiếu và trả credit hai
 * lần cho cùng bản dịch (`machine` chỉ chèn ⇒ bên sau bị bỏ im lặng). Một dòng một (projectId, locale): ai chiếm được
 * thì chạy, bên kia nhận 409 `TRANSLATION_RUNNING`. `lockedUntil` quá hạn (tiến trình chết giữa chừng) ⇒ chiếm lại được;
 * TTL index dọn dòng cũ. Không phải trạng thái bản dịch — "thiếu" vẫn tính từ hash khi đọc.
 */

import mongoose, { Schema, Document } from "mongoose"
import { USER_LOCALES, type UserLocale } from "../../shared/i18n/locale.js"

export interface ITranslationRunLock extends Document {
  projectId: mongoose.Types.ObjectId
  locale: UserLocale
  /** Mã của lượt đang giữ khoá — chỉ lượt đó nhả được. */
  token: string
  lockedUntil: Date
}

const translationRunLockSchema = new Schema<ITranslationRunLock>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    locale: { type: String, enum: USER_LOCALES, required: true },
    token: { type: String, required: true },
    lockedUntil: { type: Date, required: true }
  },
  { strict: true }
)

translationRunLockSchema.index({ projectId: 1, locale: 1 }, { unique: true })
translationRunLockSchema.index({ lockedUntil: 1 }, { expireAfterSeconds: 0 })

export const TranslationRunLock = mongoose.model<ITranslationRunLock>("TranslationRunLock", translationRunLockSchema)
