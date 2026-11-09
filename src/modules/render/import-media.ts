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

/**
 * `file_ref` của file gốc lần import mới nhất (`null` ⇒ dự án không có file gốc). Mọi lần lưu .docx đi qua
 * `docFileStore().save` — luôn là file GridFS mới, id mới — nên một `file_ref` không bao giờ đổi nội dung: `(file_ref, part)`
 * định danh đúng một ảnh, đủ làm khoá (hash tham chiếu, gói đã mở) mà không cần đọc bytes.
 */
export const currentImportFileRef = async (projectId: string): Promise<string | null> => {
  const doc = (await ImportedDocument.findOne({ projectId, file_ref: { $ne: null } }, { file_ref: 1 }, { sort: { createdAt: -1 } }).lean()) as { file_ref?: string | null } | null
  return doc?.file_ref ?? null
}

/**
 * Part có nhúng được không, đoán theo đuôi — KHÔNG mở file (tải + giải nén .docx gốc từ GridFS mất vài giây). Word đặt
 * đuôi part theo content type (`image3.png`, `image5.emf`), khớp với `imageMime` theo magic bytes. Lệch hiếm gặp (đuôi
 * `.png` mà bytes không phải PNG) chỉ làm route ảnh trả 404 — route vẫn kiểm bytes thật.
 */
export const embeddableMediaPart = (part: string): boolean => /\.(png|jpe?g)$/i.test(part)

/**
 * Gói đã mở theo `file_ref` (bất biến ⇒ giữ lâu không sai). Giới hạn số gói vì mỗi gói là cả file .docx trong bộ nhớ;
 * gói rảnh quá `PACKAGE_IDLE_MS` thì bỏ. Trước đây trần cứng 60 s ⇒ mở lại tài liệu sau một phút lại tải cả file.
 */
const PACKAGE_IDLE_MS = 10 * 60_000
const PACKAGE_MAX = 3
const cache = new Map<string, { at: number; pkg: Promise<DocxPackage | null> }>()

const packageOf = (fileRef: string): Promise<DocxPackage | null> => {
  const now = Date.now()
  for (const [key, entry] of cache) if (now - entry.at > PACKAGE_IDLE_MS) cache.delete(key)
  const hit = cache.get(fileRef)
  if (hit) {
    // LRU: dùng lại thì đưa về cuối, làm mới mốc rảnh
    cache.delete(fileRef)
    cache.set(fileRef, { at: now, pkg: hit.pkg })
    return hit.pkg
  }
  const pkg = (async () => DocxPackage.load(await docFileStore().load(fileRef)))().catch(() => null)
  cache.set(fileRef, { at: now, pkg })
  if (cache.size > PACKAGE_MAX) cache.delete(cache.keys().next().value as string)
  // Tải lỗi thì đừng giữ — lượt sau thử lại
  void pkg.then((loaded) => {
    if (!loaded && cache.get(fileRef)?.pkg === pkg) cache.delete(fileRef)
  })
  return pkg
}

/** Test dùng để cô lập giữa các ca. */
export const clearImportMediaCache = (): void => cache.clear()

/**
 * Đọc ảnh `part` trong file gốc `fileRef`, giữ lý do khi không đọc được — route ảnh cần phân biệt để client hiện đúng:
 * `unavailable` = không tải / giải nén được file gốc (lỗi storage, có thể tạm thời), `missing` = file không có part này,
 * `unsupported` = có bytes nhưng không phải PNG/JPEG (writer không nhúng được).
 */
export type ImportImageRead =
  | { ok: true; image: LlmImage }
  | { ok: false; reason: "unavailable" | "missing" | "unsupported" }

export const readImportImage = async (fileRef: string, part: string): Promise<ImportImageRead> => {
  const pkg = await packageOf(fileRef)
  if (!pkg) return { ok: false, reason: "unavailable" }
  const data = await pkg.binary(part).catch(() => null)
  if (!data) return { ok: false, reason: "missing" }
  const mime = imageMime(data)
  return mime ? { ok: true, image: { mime, data: data.toString("base64") } } : { ok: false, reason: "unsupported" }
}

/** Ảnh gốc `part` của project kèm loại (PNG/JPEG) — dùng cho render và I-4 phần ảnh (Gemini). Không có / EMF… ⇒ `null`. */
export const loadImportImage = async (projectId: string, part: string): Promise<LlmImage | null> => {
  const fileRef = await currentImportFileRef(projectId)
  if (!fileRef) return null
  const read = await readImportImage(fileRef, part)
  return read.ok ? read.image : null
}

/** Ảnh gốc `part` của project ⇒ base64 (PNG/JPEG), không nhúng được / không có ⇒ `null`. */
export const loadImportMedia = async (projectId: string, part: string): Promise<string | null> => (await loadImportImage(projectId, part))?.data ?? null
