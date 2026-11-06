/**
 * image-ref.ts
 * ─────────────────────────────────────────────────────────────────
 * Ảnh của `GET /projects/:id/document` dạng THAM CHIẾU thay vì base64 (FLF-369, pipeline-contract #16 + #38). Chỉ đường
 * xem trước dùng — export Word/PDF và comment vẫn nhúng PNG (`assemble.service` mặc định).
 *
 * Ô `png` của block ảnh mang chuỗi `image-ref:<kind>:<id>[:<locale>]@<hash>`:
 * - `kind = diagram`: `id` = id sơ đồ; có `locale` ⇒ PNG bản dịch (N1) của nguồn đã dịch hiện tại.
 * - `kind = media`  : `id` = part ảnh trong file gốc (mode 1), đã `encodeURIComponent`.
 * - `hash`: đổi khi ảnh đổi. Sơ đồ gốc: theo phiên bản file đã lưu (GridFS `_id` + độ dài — ghi lại là đổi, kể cả vẽ ép);
 *   bản dịch: hash nguồn đã dịch (đúng hash trong tên file `<id>.<locale>.<hash>.png`); media: theo `(file_ref, part)` —
 *   file gốc bất biến theo `file_ref`, nên không phải tải + giải nén cả .docx chỉ để lấy hash (FLF-381).
 *
 * Lấy hash KHÔNG tải bytes (sơ đồ gốc + bản dịch đã có file): chặng nặng nhất của GET /document trước đây là tải và nhúng
 * mọi PNG. FE tải từng ảnh qua `GET /projects/:id/document/image?ref=…` (kiểm thành viên, kiểm id / locale / part, chỉ
 * đọc — không vẽ khi thiếu), cache theo chuỗi tham chiếu.
 */

import { createHash } from "node:crypto"
import { gridFsDiagramStore, type DiagramFileStat, type DiagramFileStore } from "../diagram/diagram-file.store.js"
import { localizedDiagramHash, localizedDiagramPng, type DiagramSource } from "../diagram/localized-diagram.service.js"
import { currentImportFileRef, embeddableMediaPart, imageMime, isMediaId, loadImportImage, MEDIA_PREFIX } from "./import-media.js"
import type { DiagramPngLoader, LocalizedDiagramPngLoader } from "./assemble.service.js"

export const IMAGE_REF_TOKEN_PREFIX = "image-ref:"

export type ImageRefKind = "diagram" | "media"

export interface ImageRef {
  kind: ImageRefKind
  id: string
  locale?: string
  hash: string
}

const shortHash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex").slice(0, 16)

export const formatImageRef = ({ kind, id, locale, hash }: ImageRef): string =>
  `${IMAGE_REF_TOKEN_PREFIX}${kind}:${encodeURIComponent(id)}${locale ? `:${locale}` : ""}@${hash}`

const TOKEN_RE = /^image-ref:(diagram|media):([^:@]+)(?::([a-z]{2}))?@([0-9a-f]{16})$/

/** Chuỗi tham chiếu ⇒ `ImageRef`; sai dạng ⇒ `null`. */
export const parseImageRef = (token: string): ImageRef | null => {
  const m = TOKEN_RE.exec(token)
  if (!m) return null
  let id: string
  try {
    id = decodeURIComponent(m[2])
  } catch {
    return null
  }
  return { kind: m[1] as ImageRefKind, id, ...(m[3] ? { locale: m[3] } : {}), hash: m[4] }
}

export const isImageRefToken = (value: unknown): value is string => typeof value === "string" && value.startsWith(IMAGE_REF_TOKEN_PREFIX)

/** Hash tham chiếu của sơ đồ gốc theo phiên bản file đã lưu. */
export const diagramFileHash = (version: string): string => shortHash(`diagram:${version}`)

/** Hash tham chiếu của ảnh gốc mode 1 theo `(file_ref, part)` — file gốc bất biến theo `file_ref` (xem `import-media.ts`). */
export const mediaHash = (fileRef: string, part: string): string => shortHash(`media:${fileRef}:${part}`)

/** `file_ref` của project, đọc một lần cho cả lượt dựng (28 ảnh = một truy vấn, không phải 28). */
const projectFileRefs = (fileRefOf: (projectId: string) => Promise<string | null>) => {
  const cache = new Map<string, Promise<string | null>>()
  return (projectId: string) => {
    let found = cache.get(projectId)
    if (!found) {
      found = fileRefOf(projectId).catch(() => null)
      cache.set(projectId, found)
    }
    return found
  }
}

/**
 * Loader ảnh gốc cho chế độ tham chiếu: thay cho `defaultDiagramPngLoader` — trả chuỗi `image-ref:` thay vì base64.
 * Sơ đồ chưa có file ⇒ `null` (placeholder như cũ). Media không nhúng được (EMF…) ⇒ `null` như cũ.
 */
/**
 * Metadata mọi PNG của dự án, đọc một lần cho cả lượt dựng (loader tạo mới mỗi request). Lỗi đọc ⇒ `null`, loader rơi về
 * stat từng file.
 */
const projectStats = (store: DiagramFileStore) => {
  const cache = new Map<string, Promise<Map<string, DiagramFileStat> | null>>()
  return (projectId: string) => {
    let found = cache.get(projectId)
    if (!found) {
      found = store.statAllPng(projectId).catch(() => null)
      cache.set(projectId, found)
    }
    return found
  }
}

/** Mỗi request tạo loader mới (cache metadata theo lượt dựng, không giữ qua request). */
export const refDiagramPngLoader = (store: DiagramFileStore = gridFsDiagramStore, fileRefOf = currentImportFileRef): DiagramPngLoader => {
  const stats = projectStats(store)
  const fileRefs = projectFileRefs(fileRefOf)
  return async (projectId, diagramId) => {
    if (isMediaId(diagramId)) {
      // Không mở file gốc: hash theo `(file_ref, part)`, nhúng được theo đuôi part — bytes chỉ đọc ở route ảnh
      const part = diagramId.slice(MEDIA_PREFIX.length)
      if (!embeddableMediaPart(part)) return null
      const fileRef = await fileRefs(projectId)
      return fileRef ? formatImageRef({ kind: "media", id: part, hash: mediaHash(fileRef, part) }) : null
    }
    const all = await stats(projectId)
    const stat = all ? (all.get(`${diagramId}.png`) ?? null) : await store.stat(projectId, diagramId, "png").catch(() => null)
    return stat ? formatImageRef({ kind: "diagram", id: diagramId, hash: diagramFileHash(stat.version) }) : null
  }
}

/**
 * Loader PNG bản dịch cho chế độ tham chiếu: file đã có ⇒ chỉ đọc metadata; chưa có ⇒ vẽ + lưu như đường nhúng (lần
 * đọc đầu sau khi dịch), rồi trả tham chiếu. Không vẽ được ⇒ `null` — tài liệu dùng ảnh gốc như cũ.
 */
export const refLocalizedPngLoader = (
  store: DiagramFileStore = gridFsDiagramStore,
  draw: LocalizedDiagramPngLoader = (p, d, l, s) => localizedDiagramPng(p, d, l, s)
): LocalizedDiagramPngLoader => {
  const stats = projectStats(store)
  return async (projectId, diagramId, locale, diagram: DiagramSource) => {
    const hash = localizedDiagramHash(locale, diagram.source)
    const ref = formatImageRef({ kind: "diagram", id: diagramId, locale, hash })
    const all = await stats(projectId)
    const exists = all ? all.has(`${diagramId}.${locale}.${hash}.png`) : await store.statLocalized(projectId, diagramId, locale, hash).catch(() => null)
    if (exists) return ref
    return (await draw(projectId, diagramId, locale, diagram)) ? ref : null
  }
}

/** Kết quả đọc một ảnh theo tham chiếu cho route. */
export type ImageRead =
  | { ok: true; data: Buffer; contentType: string }
  | { ok: false; reason: "not_found" | "changed" }

/**
 * Bytes của ảnh `ref` — CHỈ ĐỌC (không vẽ khi thiếu). Kiểm quyền / tập id hợp lệ là việc của controller. Hash lệch file
 * đang lưu ⇒ `changed` (FE tải lại tài liệu), tránh trả ảnh mới dưới hash cũ.
 */
export const readImageRef = async (
  projectId: string,
  ref: ImageRef,
  store: DiagramFileStore = gridFsDiagramStore,
  loadMedia = loadImportImage,
  fileRefOf = currentImportFileRef
): Promise<ImageRead> => {
  if (ref.kind === "media") {
    // Upload lại ⇒ `file_ref` mới ⇒ hash lệch ⇒ `changed` trước khi tải bytes của file mới
    const fileRef = await fileRefOf(projectId).catch(() => null)
    if (!fileRef) return { ok: false, reason: "not_found" }
    if (mediaHash(fileRef, ref.id) !== ref.hash) return { ok: false, reason: "changed" }
    const image = await loadMedia(projectId, ref.id).catch(() => null)
    if (!image) return { ok: false, reason: "not_found" }
    const data = Buffer.from(image.data, "base64")
    return { ok: true, data, contentType: imageMime(data) ?? "application/octet-stream" }
  }
  if (ref.locale) {
    const file = await store.loadLocalized(projectId, ref.id, ref.locale, ref.hash).catch(() => null)
    return file && file.data.length > 0 ? { ok: true, data: file.data, contentType: file.contentType } : { ok: false, reason: "not_found" }
  }
  const file = await store.load(projectId, ref.id, "png").catch(() => null)
  if (!file || file.data.length === 0) return { ok: false, reason: "not_found" }
  if (diagramFileHash(file.version ?? "") !== ref.hash) return { ok: false, reason: "changed" }
  return { ok: true, data: file.data, contentType: file.contentType }
}
