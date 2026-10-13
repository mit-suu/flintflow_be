import { toUserLocale, type UserLocale } from "../../shared/i18n/locale.js"
import type { ProjectMode } from "./project.model.js"

/**
 * Ngôn ngữ tài liệu của dự án (FLF-265, D1) — hàm thuần, không đọc DB. `profileLanguage` là ngôn ngữ file upload
 * (`TemplateProfile.language`) của mode 1; nơi gọi tự nạp, mode 2 bỏ trống.
 */
export interface DocumentLanguageProject {
  mode?: ProjectMode | null
  documentLanguage?: UserLocale | null
}

/**
 * Ngôn ngữ xem trước + .docx: field đã lưu ⇒ mode 1 theo file ⇒ `en`. Giá trị suy ra, không lưu — dự án cũ
 * không có field đọc đúng hành vi trước FLF-265 (mode 2 `en`, mode 1 ngôn ngữ file).
 */
export const documentLanguageOf = (project: DocumentLanguageProject, profileLanguage?: unknown): UserLocale =>
  toUserLocale(project.documentLanguage) ?? (project.mode === "import" ? toUserLocale(profileLanguage) : null) ?? "en"

/**
 * Ngôn ngữ gốc của chữ trong Spine (D4): mode 2 sinh tiếng Anh ⇒ luôn `en`; mode 1 giữ chữ gốc của file ⇒ ngôn ngữ
 * file (lạ / thiếu ⇒ `en`). `documentLanguageOf` ≠ `sourceLanguageOf` ⇒ cần lớp bản dịch (phase 2–3).
 */
export const sourceLanguageOf = (project: DocumentLanguageProject, profileLanguage?: unknown): UserLocale =>
  project.mode === "import" ? (toUserLocale(profileLanguage) ?? "en") : "en"
