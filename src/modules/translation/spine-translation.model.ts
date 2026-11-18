/**
 * Mongoose model SpineTranslation — bản dịch một đơn vị chữ SRS (FLF-265 D6), NẰM NGOÀI Spine.
 * Khoá theo NỘI DUNG `(projectId, locale, sourceHash)`: chữ gốc giống nhau dùng chung, baseline cũ vẫn tra được, sửa chữ
 * gốc không ghi đè bản dịch cũ (hash mới ⇒ đơn vị "thiếu", tính khi đọc — không lưu cờ cũ/mới).
 * `origin`: `author` = lượt AI ghi Spine trả kèm (D16), thắng `machine` = dịch theo lô (`POST /translations/run`).
 * Không có bản sửa tay (D7).
 */

import mongoose, { Schema, Document } from "mongoose"
import { USER_LOCALES, type UserLocale } from "../../shared/i18n/locale.js"

export const TRANSLATION_ORIGINS = ["author", "machine"] as const
export type TranslationOrigin = (typeof TRANSLATION_ORIGINS)[number]

export interface ISpineTranslation extends Document {
  projectId: mongoose.Types.ObjectId
  locale: UserLocale
  sourceLocale: UserLocale
  sourceHash: string
  /** Cùng kiểu với chữ gốc: chuỗi, hoặc mảng chuỗi cùng độ dài. */
  text: string | string[]
  origin: TranslationOrigin
  createdAt: Date
  /**
   * Lần cuối nội dung bản dịch đổi (chèn mới hoặc ghi đè bản `author`) — FLF-369: `GET /projects/:id/version` lấy max theo
   * (dự án, ngôn ngữ) làm revision lớp dịch, để tab khác biết có bản dịch mới (bản dịch không tăng `spine_version`).
   * Bản ghi trước FLF-369 không có — không cần migrate: client chỉ so sự thay đổi của revision.
   */
  updatedAt?: Date
}

const isTranslationText = (value: unknown): boolean =>
  (typeof value === "string" && value.length > 0) || (Array.isArray(value) && value.every((v) => typeof v === "string"))

const spineTranslationSchema = new Schema<ISpineTranslation>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    locale: { type: String, enum: USER_LOCALES, required: true },
    sourceLocale: { type: String, enum: USER_LOCALES, required: true },
    sourceHash: { type: String, required: true },
    text: {
      type: Schema.Types.Mixed,
      required: true,
      validate: { validator: isTranslationText, message: "Bản dịch phải là chuỗi hoặc mảng chuỗi" }
    },
    origin: { type: String, enum: TRANSLATION_ORIGINS, required: true },
    createdAt: { type: Date, default: () => new Date() },
    updatedAt: { type: Date }
  },
  { strict: true }
)

spineTranslationSchema.index({ projectId: 1, locale: 1, sourceHash: 1 }, { unique: true })
spineTranslationSchema.index({ projectId: 1, locale: 1, updatedAt: -1 })

export const SpineTranslation = mongoose.model<ISpineTranslation>("SpineTranslation", spineTranslationSchema)
