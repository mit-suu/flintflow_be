/**
 * Mongoose model TranslationGlossary — glossary dịch RIÊNG theo dự án và ngôn ngữ (FLF-265 D8), tự động, không có UI.
 * `seed` lấy từ `Spine.glossary[].term_native`; `model` học từ tên actor / màn / entity / feature đã dịch. Prompt dịch
 * chỉ nhận các thuật ngữ có mặt trong lô. Không sửa `Spine.glossary` (nội dung SRS §5.5).
 */

import mongoose, { Schema, Document } from "mongoose"
import { USER_LOCALES, type UserLocale } from "../../shared/i18n/locale.js"

export const GLOSSARY_ORIGINS = ["seed", "model"] as const
export type GlossaryOrigin = (typeof GLOSSARY_ORIGINS)[number]

export interface ITranslationGlossary extends Document {
  projectId: mongoose.Types.ObjectId
  locale: UserLocale
  /** Thuật ngữ ở ngôn ngữ gốc, đúng chữ như trong Spine. */
  term: string
  translation: string
  origin: GlossaryOrigin
}

const translationGlossarySchema = new Schema<ITranslationGlossary>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    locale: { type: String, enum: USER_LOCALES, required: true },
    term: { type: String, required: true, trim: true },
    translation: { type: String, required: true, trim: true },
    origin: { type: String, enum: GLOSSARY_ORIGINS, required: true }
  },
  { timestamps: true, strict: true }
)

translationGlossarySchema.index({ projectId: 1, locale: 1, term: 1 }, { unique: true })

export const TranslationGlossary = mongoose.model<ITranslationGlossary>("TranslationGlossary", translationGlossarySchema)
