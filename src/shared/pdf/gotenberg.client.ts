/**
 * gotenberg.client.ts
 * ─────────────────────────────────────────────────────────────────
 * Client cho Gotenberg self-host (FLF-316): chuyển `.docx` do `writeDocx` sinh ra thành PDF.
 *
 * Bố cục SRS chỉ sống ở một chỗ là `.docx`; PDF là chính file đó qua LibreOffice trong container
 * Gotenberg, nên không có renderer PDF thứ hai phải giữ khớp với bản Word. Cùng mô hình với
 * `plantuml.client.ts`: service riêng gọi qua HTTP, image BE không cài LibreOffice.
 *
 * Không thêm dependency: multipart dựng bằng `FormData`/`Blob` có sẵn của Node 22.
 */

import { env } from "../../config/env.js"

/** Health check phải nhanh, không dùng GOTENBERG_TIMEOUT_MS của lượt chuyển. */
const HEALTH_TIMEOUT_MS = 1500

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

/** Mọi cách Gotenberg không trả được PDF — controller đổi thành `503 PDF_EXPORT_UNAVAILABLE`. */
export class PdfConverterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PdfConverterError"
  }
}

const baseUrl = (): string => env.GOTENBERG_URL.replace(/\/+$/, "")

const withTimeout = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Mọi file PDF mở đầu bằng `%PDF-`. Server lạ chiếm cổng trả 200 kèm HTML thì không lọt qua đây. */
const isPdf = (data: Buffer): boolean => data.subarray(0, 5).toString("latin1") === "%PDF-"

/**
 * `.docx` → PDF qua `POST /forms/libreoffice/convert`.
 *
 * `updateIndexes=true`: LibreOffice dựng lại mục lục trước khi xuất, nên mục lục có số trang thật
 * thay vì trường TOC rỗng mà Word chỉ điền khi người dùng mở file. Đó là mặc định của Gotenberg 8,
 * gửi tường minh để một lần đổi mặc định ở bản sau không lặng lẽ làm mất số trang.
 */
export const docxToPdf = async (docx: Buffer, fileName: string): Promise<Buffer> => {
  const form = new FormData()
  form.append("files", new Blob([new Uint8Array(docx)], { type: DOCX_MIME }), fileName)
  form.append("updateIndexes", "true")

  let res: Response
  try {
    res = await withTimeout(`${baseUrl()}/forms/libreoffice/convert`, { method: "POST", body: form }, env.GOTENBERG_TIMEOUT_MS)
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError"
    throw new PdfConverterError(
      timedOut
        ? `Gotenberg quá ${env.GOTENBERG_TIMEOUT_MS} ms (${baseUrl()})`
        : `không gọi được Gotenberg ở ${baseUrl()}: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  if (!res.ok) {
    // Lỗi của Gotenberg là text/plain ngắn — giữ một đoạn cho log, không đưa cho user.
    const detail = (await res.text().catch(() => "")).slice(0, 300)
    throw new PdfConverterError(`Gotenberg trả HTTP ${res.status}${detail ? `: ${detail}` : ""}`)
  }

  const data = Buffer.from(await res.arrayBuffer())
  if (!isPdf(data)) {
    throw new PdfConverterError(
      `${baseUrl()} trả HTTP ${res.status} kèm content-type "${res.headers.get("content-type") ?? "(trống)"}" ` +
        "nhưng nội dung không phải PDF — server đang nghe ở cổng này không phải Gotenberg"
    )
  }
  return data
}

/**
 * Probe sức khoẻ qua `GET /health` của Gotenberg (`{"status":"up",…}`). Đọc cả body chứ không chỉ
 * status: web server lạ chiếm cổng cũng có thể trả 200 cho `/health`.
 */
export const isGotenbergReachable = async (): Promise<boolean> => {
  try {
    const res = await withTimeout(`${baseUrl()}/health`, { method: "GET" }, HEALTH_TIMEOUT_MS)
    if (!res.ok) {
      void res.body?.cancel().catch(() => {})
      return false
    }
    const body = (await res.json().catch(() => null)) as { status?: unknown } | null
    return body?.status === "up"
  } catch {
    return false
  }
}
