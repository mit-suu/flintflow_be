import { v2 as cloudinary } from "cloudinary"
import { Readable, Transform } from "node:stream"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"
import { ApiError } from "../../shared/utils/api-error.js"
// Import để chạy `cloudinary.config` một lần (cấu hình nằm ở module upload)
import "../../shared/utils/cloudinary.js"

/**
 * Xoá file gốc của tài liệu upload trên Cloudinary (upload dùng `resource_type: "raw"`).
 *
 * Best-effort: lỗi mạng/credential chỉ ghi log, không chặn việc xoá record trong DB — để lại một file mồ
 * côi trên Cloudinary rẻ hơn để lại một record trỏ tới tài liệu user đã xoá. Trả `true` khi Cloudinary
 * xác nhận đã xoá hoặc file vốn không còn.
 */
export const destroyDocumentAsset = async (publicId: string | null | undefined): Promise<boolean> => {
  if (!publicId) return false
  try {
    const result: unknown = await cloudinary.uploader.destroy(publicId, { resource_type: "raw", invalidate: true })
    const status = typeof result === "object" && result !== null && "result" in result ? result.result : null
    return status === "ok" || status === "not found"
  } catch (err) {
    console.warn(`[ProjectDocument] Không xoá được asset Cloudinary '${publicId}':`, err)
    return false
  }
}

/** Trần dung lượng file tải về (khớp trần upload của multer). */
export const DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024
/** Trần thời gian truyền nội dung sau khi kho đã trả header. */
export const DOWNLOAD_TRANSFER_TIMEOUT_MS = 120_000
/** Thời gian chờ kho lưu trữ trả file (gồm cả lúc truyền). */
export const DOWNLOAD_TIMEOUT_MS = 30_000

/** Bảng cố định theo đuôi file được phép upload; đuôi khác ⇒ `application/octet-stream`. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
}

export const contentTypeOfExtension = (extension: string | null | undefined): string =>
  CONTENT_TYPES[(extension ?? "").trim().toLowerCase()] ?? "application/octet-stream"

const unavailable = (reason: string): ApiError => {
  console.warn(`[ProjectDocument] Không tải được file gốc: ${reason}`)
  return new ApiError(503, "Chưa tải được file gốc của tài liệu. Hãy thử lại sau giây lát.", "DOCUMENT_UNAVAILABLE")
}

/** URL công khai dựng từ khoá lưu (không dùng `url` đã lưu). Upload dùng `resource_type: "raw"`. */
const buildAssetUrl = (publicId: string): string => cloudinary.url(publicId, { resource_type: "raw", type: "upload", secure: true })

/** Raw asset có thể được lưu kèm đuôi trong public id hoặc không; thử bản gốc rồi bản kèm đuôi. */
const candidatePublicIds = (publicId: string, extension: string | null | undefined): string[] => {
  const ext = (extension ?? "").trim().toLowerCase()
  return ext && !publicId.toLowerCase().endsWith(ext) ? [publicId, `${publicId}${ext}`] : [publicId]
}

/** Cắt luồng khi vượt trần byte — chặn kho trả file lớn hơn dự kiến. */
const byteLimiter = (maxBytes: number): Transform => {
  let seen = 0
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length
      if (seen > maxBytes) cb(new Error(`file vượt ${maxBytes} byte`))
      else cb(null, chunk)
    }
  })
}

export interface DocumentDownload {
  stream: Readable
  /** `null` khi kho không báo kích thước. */
  contentLength: number | null
  /** Gọi khi luồng kết thúc (xong / lỗi) để dọn timer. */
  dispose: () => void
}

/**
 * Mở luồng file gốc từ kho lưu trữ. Mọi lỗi (mạng, quá thời gian, HTTP không ok, file lớn quá trần, thiếu public id) ⇒
 * `503 DOCUMENT_UNAVAILABLE`. Chỉ trả khi kho đã trả header ok ⇒ controller mới gửi header cho client.
 */
export const openDocumentDownload = async (
  publicId: string | null | undefined,
  extension: string | null | undefined,
  options: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<DocumentDownload> => {
  if (!publicId) throw unavailable("tài liệu không có khoá lưu trữ")
  const maxBytes = options.maxBytes ?? DOWNLOAD_MAX_BYTES
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS)
  const dispose = () => clearTimeout(timer)

  try {
    let upstream: Response | null = null
    let lastStatus = 0
    for (const id of candidatePublicIds(publicId, extension)) {
      const res = await fetch(buildAssetUrl(id), { signal: controller.signal })
      if (res.ok) {
        upstream = res
        break
      }
      lastStatus = res.status
      await res.body?.cancel().catch(() => undefined)
      if (res.status !== 404) break
    }
    if (!upstream || !upstream.body) throw new Error(upstream ? "kho không trả nội dung" : `kho trả HTTP ${lastStatus}`)

    const declared = Number(upstream.headers.get("content-length"))
    const contentLength = Number.isFinite(declared) && declared > 0 ? declared : null
    if (contentLength !== null && contentLength > maxBytes) {
      await upstream.body.cancel().catch(() => undefined)
      throw new Error(`file ${contentLength} byte vượt trần ${maxBytes}`)
    }

    // Header đã về: bỏ hẹn giờ chờ kho, phần truyền có trần riêng (client chậm vẫn tải xong file 10 MB)
    dispose()
    const source = Readable.fromWeb(upstream.body as unknown as NodeReadableStream<Uint8Array>)
    const stream = source.pipe(byteLimiter(maxBytes))
    const transferTimer = setTimeout(() => stream.destroy(new Error("truyền file quá thời gian")), DOWNLOAD_TRANSFER_TIMEOUT_MS)
    source.once("error", (e) => stream.destroy(e))
    // Vượt trần / client ngắt / lỗi ⇒ huỷ luồng đọc từ kho, không đọc tiếp vô ích
    stream.once("close", () => {
      clearTimeout(transferTimer)
      source.destroy()
      controller.abort()
    })
    return { stream, contentLength, dispose: () => stream.destroy() }
  } catch (err) {
    dispose()
    if (err instanceof ApiError) throw err
    const timedOut = err instanceof Error && err.name === "AbortError"
    throw unavailable(timedOut ? "quá thời gian" : err instanceof Error ? err.message : String(err))
  }
}
