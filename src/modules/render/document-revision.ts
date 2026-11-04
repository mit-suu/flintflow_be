/**
 * document-revision.ts
 * ─────────────────────────────────────────────────────────────────
 * Revision tài liệu (FLF-369, pipeline-contract #39): chuỗi đổi khi nội dung `GET /document` có thể đổi — nội dung Spine
 * (change gần nhất ngoài `flags[…]`), lớp bản dịch của ngôn ngữ tài liệu (bản dịch mới không tăng `spine_version`), và
 * chính ngôn ngữ tài liệu. Tab đang mở so revision này để tự tải bản mới mà không poll cả tài liệu.
 */

import type { UserLocale } from "../../shared/i18n/locale.js"
import * as spineRepository from "../spine/spine.repository.js"
import { translationRevision } from "../translation/translation.repository.js"

export interface VersionInfo {
  spine_version: number
  document_revision: string
}

export interface DocumentLanguages {
  locale: UserLocale
  source: UserLocale
}

/** `null` khi dự án chưa có Spine. Bản dịch chỉ đọc khi ngôn ngữ tài liệu khác ngôn ngữ gốc. */
export const documentVersion = async (projectId: string, languages: DocumentLanguages): Promise<VersionInfo | null> => {
  const translated = languages.locale !== languages.source
  const [head, translation] = await Promise.all([
    spineRepository.versionHead(projectId),
    translated ? translationRevision(projectId, languages.locale) : Promise.resolve(null)
  ])
  if (!head) return null
  return { spine_version: head.spine_version, document_revision: `${head.content_seq}:${translation ?? "-"}:${languages.locale}` }
}
