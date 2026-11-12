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
import { loadFixedTemplateContext, writeProjectDocx } from "../render/project-docx-writer.js"
import { writerOptionsFor } from "../render/labels.js"
import { sourceFidelityFor } from "../render/source-fidelity.js"
import type { Spine } from "../spine/spine.types.js"
import { projectLanguages, type ProjectLanguages } from "../translation/translation.service.js"

import { type TemplateSourceBinding } from "./template-source-binding.js"

export interface RenderVersionOptions {
  templateSource?: TemplateSourceBinding | null
  recordChanges?: ChangeRecordRow[]
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
  const context = opts.templateSource ? await loadFixedTemplateContext(projectId, opts.templateSource) : null
  // `baseline`: bản đã chốt của version — không in phụ lục cờ mở / watermark của bản làm việc
  const renderOptions = {
    version: opts.version,
    source: "baseline" as const,
    pendingRecord: opts.pendingRecord,
    ...(opts.recordChanges !== undefined ? { recordChanges: opts.recordChanges } : {}),
    ...(languages ? { languages } : {})
  }
  const render = (snapshot: Spine) => context
    ? renderSpineDocument(projectId, projectName, snapshot, renderOptions, { loadTemplate: async () => context.layout })
    : renderSpineDocument(projectId, projectName, snapshot, renderOptions)
  const doc = await render(spine)
  // Dự án "Upload SRS có sẵn": mục chưa đổi so với lúc import in nguyên văn từ file upload (bản 0.1 = chính file upload)
  // FLF-416: dự án chuyển từ Luồng 2 (chế độ 3 / 4, có file khách) dựng bằng đúng ngôn ngữ chữ gốc ⇒ vẫn in theo file nền;
  // chỉ bản dịch sang ngôn ngữ khác mới bỏ file nền
  const otherLanguage = !!opts.languages && opts.languages.locale !== opts.languages.source
  const fidelity = await sourceFidelityFor(projectId, doc, render, { otherLanguage })
  // Version file của dự án import thật ⇒ phụ lục cờ tiếng Việt (thông điệp cờ đã là tiếng Việt), bỏ qua ngôn ngữ tài
  // liệu ⇒ chữ cố định của file giữ như trước FLF-265. Dự án chuyển từ mode 2 (FLF-318) theo ngôn ngữ tài liệu.
  const options = languages ? writerOptionsFor("import", languages.locale, "fpt") : writerOptionsFor("import")
  // FLF-344: mục lục ghi sẵn — file mở mà không cập nhật field (Protected View, trình xem) vẫn có mục lục bấm được
  const pkg = await DocxPackage.load(await writeProjectDocx(doc, { ...options, tocEntries: true }, undefined, context ?? opts.templateSource, fidelity))
  await writeStamp(pkg, { project_id: projectId, version: opts.version, source: opts.stampSource })
  return pkg.toBuffer()
}
