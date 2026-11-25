import { toUserLocale, type UserLocale } from "../../shared/i18n/locale.js"
import type { ProjectMode } from "./project.model.js"

/**
 * Ngôn ngữ tài liệu của dự án (FLF-265, D1) — hàm thuần, không đọc DB. `profileLanguage` là ngôn ngữ file upload
 * (`TemplateProfile.language`) của mode 1; nơi gọi tự nạp, mode 2 bỏ trống.
 */
export interface DocumentLanguageProject {
  mode?: ProjectMode | null
  documentLanguage?: UserLocale | null
  /** FLF-318: dự án tạo SRS đã chuyển sang mode 1 — chữ trong Spine vẫn là tiếng Anh của mode 2. */
  converted_from?: "fpt" | null
  /** FLF-466: ngôn ngữ chữ trong Spine sau dịch đè khi đổi mẫu; thiếu ⇒ suy như trước. */
  source_language?: UserLocale | string | null
}

/**
 * Ngôn ngữ xem trước + .docx: field đã lưu ⇒ mode 1 theo file ⇒ `en`. Giá trị suy ra, không lưu — dự án cũ
 * không có field đọc đúng hành vi trước FLF-265 (mode 2 `en`, mode 1 ngôn ngữ file).
 */
export const documentLanguageOf = (project: DocumentLanguageProject, profileLanguage?: unknown): UserLocale =>
  toUserLocale(project.documentLanguage) ?? (project.mode === "import" ? toUserLocale(profileLanguage) : null) ?? "en"

/**
 * Ngôn ngữ gốc của chữ trong Spine (D4): mode 2 sinh tiếng Anh ⇒ luôn `en`; mode 1 giữ chữ gốc của file ⇒ ngôn ngữ
 * file (lạ / thiếu ⇒ `en`). `documentLanguageOf` ≠ `sourceLanguageOf` ⇒ cần lớp bản dịch (phase 2–3). Dự án chuyển
 * từ mode 2 (FLF-318) giữ `en` như trước khi chuyển — `TemplateProfile.language` của nó là ngôn ngữ tài liệu.
 */
export const sourceLanguageOf = (
  project: DocumentLanguageProject,
  profileLanguage?: unknown,
  profile?: { flow2_entry_at?: Date | string | null; language?: string | null } | null
): UserLocale =>
  toUserLocale(project.source_language) ??
  ((project.mode === "import" && project.converted_from !== "fpt") || Boolean(profile?.flow2_entry_at)
    ? (toUserLocale(profileLanguage ?? profile?.language) ?? "en")
    : "en")

/**
 * FLF-466 (BF §3.7 "Ngôn ngữ và dịch"): dự án **có file nền** — upload thật (chế độ 1, 3, 4), tạo từ mẫu của org (`template_ref` /
 * `source_file_ref`), hoặc đã có một lần đổi mẫu áp dụng không phải chỉ đổi ngôn ngữ (`migrated_base_at`). Đổi mẫu khác ngôn ngữ
 * ⇒ dịch đè vào Spine. Dự án chế độ 2 tạo mới không file (kể cả đã chuyển, `converted_from = fpt`, không có `source_file_ref`)
 * chưa áp mẫu nào ⇒ chỉ đổi ngôn ngữ tài liệu.
 */
export const hasBaseFile = (
  project: Pick<DocumentLanguageProject, "mode" | "converted_from"> & { template_ref?: unknown },
  profile?: { source_file_ref?: string | null; migrated_base_at?: Date | string | null } | null
): boolean =>
  (project.mode === "import" && project.converted_from !== "fpt") ||
  Boolean(project.template_ref) ||
  Boolean(profile?.migrated_base_at) ||
  (Boolean(profile?.source_file_ref) && project.converted_from !== "fpt")
