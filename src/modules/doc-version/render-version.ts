/**
 * File `.docx` của một version tài liệu mode 1 v2 (FLF-184, plan v2 §6 — D1): Spine là nguồn sự thật ⇒ mỗi version là
 * bản **render** từ snapshot Spine theo layout file người dùng (`assemble.service.renderSpineDocument` + `docx-writer`),
 * kèm stamp (`flintflow_project_id/version/source`) để nhận ra khi upload lại. Không gắn watermark ở file lưu —
 * `versions.service.downloadVersion` thêm DRAFT lúc tải bản chưa release (G8), như trước.
 */

import { DocxPackage, writeStamp } from "../docx-ooxml/index.js"
import { renderSpineDocument } from "../render/assemble.service.js"
import type { ChangeRecordRow } from "../render/section-renderer.js"
import { writeDocx } from "../render/docx-writer.js"
import type { Spine } from "../spine/spine.types.js"

export interface RenderVersionOptions {
  version: string
  /** Giá trị `flintflow_source` của stamp (`import`, `cr`, `release`). */
  stampSource: string
  /** Change của snapshot chưa ghi DB (C-7 render trước khi ghi Spine). */
  pendingRecord?: ChangeRecordRow[]
}

export const renderVersionFile = async (projectId: string, projectName: string, spine: Spine, opts: RenderVersionOptions): Promise<Buffer> => {
  // `baseline`: bản đã chốt của version — không in phụ lục cờ mở / watermark của bản làm việc
  const doc = await renderSpineDocument(projectId, projectName, spine, { version: opts.version, source: "baseline", pendingRecord: opts.pendingRecord })
  const pkg = await DocxPackage.load(await writeDocx(doc))
  await writeStamp(pkg, { project_id: projectId, version: opts.version, source: opts.stampSource })
  return pkg.toBuffer()
}
