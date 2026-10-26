/**
 * File `.docx` của một version tài liệu mode 1 v2 (FLF-184, plan v2 §6 — D1): Spine là nguồn sự thật ⇒ mỗi version là
 * bản **render** từ snapshot Spine theo layout file người dùng (`assemble.service.renderSpineDocument` + `docx-writer`),
 * kèm stamp (`flintflow_project_id/version/source`) để nhận ra khi upload lại. Không gắn watermark ở file lưu —
 * `versions.service.downloadVersion` thêm DRAFT lúc tải bản chưa release (G8), như trước.
 */

import { DocxPackage, writeStamp } from "../docx-ooxml/index.js"
import { Project } from "../project/project.model.js"
import { renderSpineDocument } from "../render/assemble.service.js"
import type { ChangeRecordRow } from "../render/section-renderer.js"
import { writeDocx } from "../render/docx-writer.js"
import { writerOptionsFor } from "../render/labels.js"
import type { Spine } from "../spine/spine.types.js"
import { projectLanguages, type ProjectLanguages } from "../translation/translation.service.js"

export interface RenderVersionOptions {
  version: string
  /** Giá trị `flintflow_source` của stamp (`import`, `cr`, `release`). */
  stampSource: string
  /** Change của snapshot chưa ghi DB (C-7 render trước khi ghi Spine). */
  pendingRecord?: ChangeRecordRow[]
  /** FLF-318: ngôn ngữ cho bản 1.0 lúc chuyển đổi — dự án chưa đổi mode nên chưa tự suy ra được. */
  languages?: ProjectLanguages
}

/**
 * FLF-318: dự án tạo SRS đã chuyển sang mode 1 ⇒ ngôn ngữ tài liệu + ngôn ngữ gốc (`en`) để render mẫu FPT qua lớp bản
 * dịch, như bản Lead đã ký. Dự án import thật ⇒ `null` (giữ đường cũ, không đổi byte nào).
 */
const convertedLanguages = async (projectId: string): Promise<ProjectLanguages | null> => {
  const project = await Project.findById(projectId, { mode: 1, converted_from: 1, documentLanguage: 1 }).lean()
  if (project?.converted_from !== "fpt") return null
  return projectLanguages(projectId, project)
}

export const renderVersionFile = async (projectId: string, projectName: string, spine: Spine, opts: RenderVersionOptions): Promise<Buffer> => {
  const languages = opts.languages ?? (await convertedLanguages(projectId))
  // `baseline`: bản đã chốt của version — không in phụ lục cờ mở / watermark của bản làm việc
  const doc = await renderSpineDocument(projectId, projectName, spine, {
    version: opts.version,
    source: "baseline",
    pendingRecord: opts.pendingRecord,
    ...(languages ? { languages } : {})
  })
  // Version file của dự án import thật ⇒ phụ lục cờ tiếng Việt (thông điệp cờ đã là tiếng Việt), bỏ qua ngôn ngữ tài
  // liệu ⇒ file không đổi byte nào so với trước FLF-265. Dự án chuyển từ mode 2 (FLF-318) theo ngôn ngữ tài liệu.
  const options = languages ? writerOptionsFor("import", languages.locale, "fpt") : writerOptionsFor("import")
  const pkg = await DocxPackage.load(await writeDocx(doc, options))
  await writeStamp(pkg, { project_id: projectId, version: opts.version, source: opts.stampSource })
  return pkg.toBuffer()
}
