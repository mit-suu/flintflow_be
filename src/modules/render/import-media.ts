/**
 * Ảnh gốc của file người dùng upload (mode 1 v3 phase 5, nợ T3): mục riêng giữ `image_ref` = part ảnh trong gói
 * (`word/media/image3.png`); render nhúng lại đúng ảnh đó thay cho dòng "[Image]". Trước đây bản render 0.0 mất 35/39 ảnh.
 *
 * Tham chiếu dùng chung cơ chế ảnh của diagram (`diagram-ref:<id>`) với id dạng `media:<part>`. Bytes lấy từ file gốc của
 * lần import (`ImportedDocument.file_ref`), giữ gói đã mở trong bộ nhớ một lúc để một lượt render nhiều ảnh chỉ mở zip một lần.
 * Writer nhúng được PNG và JPEG; EMF/WMF/khác ⇒ `null` (tài liệu hiện chỗ giữ ảnh + chú thích — xem `assemble.service`).
 */

import type { LlmImage } from "../../shared/ai/providers/provider.types.js"
import { DocxPackage } from "../docx-ooxml/index.js"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { ImportedDocument } from "../import/imported-document.model.js"

export const MEDIA_PREFIX = "media:"

export const mediaId = (part: string): string => `${MEDIA_PREFIX}${part}`
export const isMediaId = (id: string): boolean => id.startsWith(MEDIA_PREFIX)

/** Loại ảnh theo magic bytes: PNG / JPEG (writer nhúng được, Gemini đọc được); còn lại ⇒ `null`. */
export const imageMime = (data: Buffer): LlmImage["mime"] | null =>
  data.length > 8 && data.readUInt32BE(0) === 0x89504e47
    ? "image/png"
    : data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      ? "image/jpeg"
      : null

/** PNG / JPEG theo magic bytes — writer chỉ nhúng hai loại này. */
export const embeddableImage = (data: Buffer): boolean => imageMime(data) !== null

const CACHE_MS = 60_000
/** Gói đã mở theo `file_ref` (không theo project: upload lại thì file mới, không dùng nhầm gói cũ). */
const cache = new Map<string, { at: number; pkg: Promise<DocxPackage | null> }>()

const originalPackage = async (projectId: string): Promise<DocxPackage | null> => {
  const doc = (await ImportedDocument.findOne({ projectId, file_ref: { $ne: null } }, { file_ref: 1 }, { sort: { createdAt: -1 } }).lean()) as { file_ref?: string | null } | null
  if (!doc?.file_ref) return null
  const now = Date.now()
  for (const [key, entry] of cache) if (now - entry.at > CACHE_MS) cache.delete(key)
  const hit = cache.get(doc.file_ref)
  if (hit) return hit.pkg
  const fileRef = doc.file_ref
  const pkg = (async () => DocxPackage.load(await docFileStore().load(fileRef)))().catch(() => null)
  cache.set(fileRef, { at: now, pkg })
  return pkg
}

/** Test dùng để cô lập giữa các ca. */
export const clearImportMediaCache = (): void => cache.clear()

/** Ảnh gốc `part` của project kèm loại (PNG/JPEG) — dùng cho render và I-4 phần ảnh (Gemini). Không có / EMF… ⇒ `null`. */
export const loadImportImage = async (projectId: string, part: string): Promise<LlmImage | null> => {
  const pkg = await originalPackage(projectId)
  const data = pkg ? await pkg.binary(part) : null
  const mime = data ? imageMime(data) : null
  return data && mime ? { mime, data: data.toString("base64") } : null
}

/** Ảnh gốc `part` của project ⇒ base64 (PNG/JPEG), không nhúng được / không có ⇒ `null`. */
export const loadImportMedia = async (projectId: string, part: string): Promise<string | null> => (await loadImportImage(projectId, part))?.data ?? null
