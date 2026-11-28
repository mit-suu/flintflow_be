/**
 * Mẫu chuẩn FlintFlow làm đích đổi mẫu (FLF-466 phase 09, BF §3.7 "Đích là mẫu chuẩn", kind nội bộ `standard`).
 *
 * Mẫu chuẩn không có họ mẫu trong thư viện org: file đích là **khung trống** của bản in mẫu FPT theo ngôn ngữ đích (Spine rỗng qua đúng đường
 * dựng của chế độ 2), mapping heading lấy bằng chính bước đọc file mẫu (`analyzeTemplateFile`) nên là mapping "có sẵn", không sửa ở bước Xem lại
 * (như mẫu org). Dựng một lần mỗi ngôn ngữ / tiến trình, lưu vào kho file; kho mất file thì dựng lại.
 */
import { createHash } from "node:crypto"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { analyzeTemplateFile, type AnalyzedTemplate } from "../import/org-template-versions.service.js"
import { renderSpineDocument } from "../render/assemble.service.js"
import { writeDocx } from "../render/docx-writer.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { UserLocale } from "../../shared/i18n/locale.js"
import type { NewHeading } from "./pair-sections.js"

/** Tên hiển thị của mẫu chuẩn (UI: "mẫu chuẩn FlintFlow"; không lộ "FPT"). */
export const STANDARD_TEMPLATE_NAME = "Mẫu chuẩn FlintFlow"

export interface StandardTemplate {
  language: UserLocale
  file_ref: string
  sha256: string
  headings: NewHeading[]
  analyzed: AnalyzedTemplate
}

const cache = new Map<UserLocale, StandardTemplate>()

const build = async (language: UserLocale): Promise<StandardTemplate> => {
  const doc = await renderSpineDocument(
    "000000000000000000000000",
    STANDARD_TEMPLATE_NAME,
    createEmptySpine({}),
    { version: "1.0", source: "baseline", recordChanges: [], languages: { locale: language, source: language } },
    { loadTemplate: async () => null }
  )
  const buffer = await writeDocx(doc, { language })
  const analyzed = await analyzeTemplateFile(buffer)
  const file_ref = await docFileStore().save(buffer, { projectId: "standard-template", kind: "upload", name: `standard-template-${language}.docx` })
  return {
    language,
    file_ref,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    analyzed,
    headings: analyzed.headings.map((h, i) => ({
      key: `n${i}`,
      heading_text: h.heading_text,
      section_id: h.section_id,
      ...(h.auto_confirmed ? { auto_confirmed: true } : {}),
      ...(h.guidance ? { guidance: h.guidance } : {})
    }))
  }
}

/** Mẫu chuẩn theo ngôn ngữ đích (file + heading + bảng). */
export const loadStandardTemplate = async (language: UserLocale): Promise<StandardTemplate> => {
  const cached = cache.get(language)
  if (cached) {
    try {
      await docFileStore().load(cached.file_ref)
      return cached
    } catch {
      cache.delete(language)
    }
  }
  const built = await build(language)
  cache.set(language, built)
  return built
}

/** Chỉ cho test: bỏ nhớ đệm trong tiến trình. */
export const _resetStandardTemplateCache = (): void => cache.clear()
