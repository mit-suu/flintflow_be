/**
 * Ảnh gốc của file người dùng upload (mode 1 v3 phase 5, nợ T3): mục riêng giữ `image_ref` = part ảnh trong gói
 * (`word/media/image3.png`); render nhúng lại đúng ảnh đó thay cho dòng "[Image]". Trước đây bản render 0.0 mất 35/39 ảnh.
 *
 * Tham chiếu dùng chung cơ chế ảnh của diagram (`diagram-ref:<id>`) với id dạng `media:<part>`. Bytes lấy từ file gốc của
 * lần import (`ImportedDocument.file_ref`), giữ gói đã mở trong bộ nhớ một lúc để một lượt render nhiều ảnh chỉ mở zip một lần.
 * Writer nhúng được PNG và JPEG; EMF/WMF/khác ⇒ `null` (tài liệu hiện chỗ giữ ảnh + chú thích — xem `assemble.service`).
 */

import { DocxPackage } from "../docx-ooxml/index.js"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { ImportedDocument } from "../import/imported-document.model.js"

export const MEDIA_PREFIX = "media:"

export const mediaId = (part: string): string => `${MEDIA_PREFIX}${part}`
export const isMediaId = (id: string): boolean => id.startsWith(MEDIA_PREFIX)

/** PNG / JPEG theo magic bytes — writer chỉ nhúng hai loại này. */
export const embeddableImage = (data: Buffer): boolean =>
  (data.length > 8 && data.readUInt32BE(0) === 0x89504e47) || (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)

const CACHE_MS = 60_000
const cache = new Map<string, { at: number; pkg: Promise<DocxPackage | null> }>()

const originalPackage = (projectId: string): Promise<DocxPackage | null> => {
  const now = Date.now()
  for (const [key, entry] of cache) if (now - entry.at > CACHE_MS) cache.delete(key)
  const hit = cache.get(projectId)
  if (hit) return hit.pkg
  const pkg = (async () => {
    const doc = (await ImportedDocument.findOne({ projectId, file_ref: { $ne: null } }, { file_ref: 1 }, { sort: { createdAt: -1 } }).lean()) as { file_ref?: string | null } | null
    if (!doc?.file_ref) return null
    return DocxPackage.load(await docFileStore().load(doc.file_ref))
  })().catch(() => null)
  cache.set(projectId, { at: now, pkg })
  return pkg
}

/** Test dùng để cô lập giữa các ca. */
export const clearImportMediaCache = (): void => cache.clear()

/** Ảnh gốc `part` của project ⇒ base64 (PNG/JPEG), không nhúng được / không có ⇒ `null`. */
export const loadImportMedia = async (projectId: string, part: string): Promise<string | null> => {
  const pkg = await originalPackage(projectId)
  const data = pkg ? await pkg.binary(part) : null
  return data && embeddableImage(data) ? data.toString("base64") : null
}
