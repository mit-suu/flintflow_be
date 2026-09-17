/**
 * plantuml.client.ts
 * ─────────────────────────────────────────────────────────────────
 * Client cho PlantUML server self-host (Phases §7.1).
 *
 * Hai đường gọi, theo thứ tự ưu tiên:
 *   1. POST {base}/{format} với source thô trong body — KHÔNG giới hạn độ dài.
 *   2. GET {base}/{format}/{encoded} — encoding deflate + base64 riêng của
 *      PlantUML. Dùng làm fallback vì URL có giới hạn độ dài, mà use-case
 *      diagram 19 màn / 70 UC thừa sức vượt.
 *
 * Không thêm dependency: encoding làm bằng `node:zlib`.
 */

import { deflateRawSync } from "node:zlib"
import { env } from "../../config/env.js"

export type PlantUmlFormat = "svg" | "png"

/** Health check phai nhanh, khong dung PLANTUML_TIMEOUT_MS cua render. */
const HEALTH_TIMEOUT_MS = 1500

export interface PlantUmlRenderResult {
  format: PlantUmlFormat
  /** Body trả về. SVG là text; PNG là bytes. */
  data: Buffer
  contentType: string
  /** Đường gọi thực tế đã dùng — probe test đọc field này. */
  transport: "post" | "get"
  /** HTTP status. Image `jetty` (PlantUML 1.2026.8) trả 400 kèm ảnh lỗi khi syntax sai. */
  status: number
  /**
   * Header chẩn đoán của PlantUML. Server đặt `x-plantuml-diagram-error` khi
   * syntax sai NHƯNG vẫn trả HTTP 200 kèm ảnh lỗi — nên header này là cách
   * phát hiện lỗi rẻ và chính xác nhất, nếu build image có hỗ trợ.
   */
  diagnostics: {
    error?: string
    errorLine?: string
  }
}

/** Bảng base64 riêng của PlantUML (KHÔNG phải base64 chuẩn). */
const PLANTUML_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"

const encode3Bytes = (b1: number, b2: number, b3: number): string => {
  const c1 = b1 >> 2
  const c2 = ((b1 & 0x3) << 4) | (b2 >> 4)
  const c3 = ((b2 & 0xf) << 2) | (b3 >> 6)
  const c4 = b3 & 0x3f

  return (
    PLANTUML_ALPHABET[c1 & 0x3f] +
    PLANTUML_ALPHABET[c2 & 0x3f] +
    PLANTUML_ALPHABET[c3 & 0x3f] +
    PLANTUML_ALPHABET[c4 & 0x3f]
  )
}

/** deflate + base64-kiểu-PlantUML, dùng cho đường GET. */
export const encodePlantUml = (source: string): string => {
  const deflated = deflateRawSync(Buffer.from(source, "utf-8"), { level: 9 })

  let out = ""
  for (let i = 0; i < deflated.length; i += 3) {
    const b1 = deflated[i]
    const b2 = i + 1 < deflated.length ? deflated[i + 1] : 0
    const b3 = i + 2 < deflated.length ? deflated[i + 2] : 0
    out += encode3Bytes(b1, b2, b3)
  }

  return out
}

const readDiagnostics = (res: Response) => ({
  error: res.headers.get("x-plantuml-diagram-error") ?? undefined,
  errorLine: res.headers.get("x-plantuml-diagram-error-line") ?? undefined
})

const baseUrl = (): string => env.PLANTUML_BASE_URL.replace(/\/+$/, "")

/** Media type không phân biệt hoa thường (RFC 9110) — chuẩn hoá trước khi so. */
const contentTypeOf = (res: Response): string =>
  (res.headers.get("content-type") ?? "").toLowerCase()

/**
 * Chỉ phản hồi `content-type: image/*` mới là sơ đồ. Bất kỳ web server nào cũng có
 * thể chiếm cổng PlantUML và trả 200 kèm HTML/JSON; nhận buffer đó rồi đẩy xuống
 * compile-check là đường sơ đồ hỏng lọt vào tài liệu đã ký baseline.
 */
const isImageResponse = (res: Response): boolean =>
  contentTypeOf(res).startsWith("image/")

/**
 * Probe thực nghiệm (T10, PlantUML 1.2026.8 image `jetty`): syntax sai ⇒ HTTP 400 + body vẫn là ẢNH LỖI.
 * POST không có header chẩn đoán; GET có `x-plantuml-diagram-error(-line)`. Đây là kết quả compile,
 * không phải lỗi transport — trả về cho compile-check thay vì ném.
 */
const isDiagramErrorImage = (res: Response): boolean =>
  res.status === 400 && isImageResponse(res)

const withTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number = env.PLANTUML_TIMEOUT_MS
): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Render `.puml` thành SVG/PNG.
 *
 * Lưu ý quan trọng: PlantUML trả **HTTP 200 kèm ẢNH LỖI** khi syntax sai, nên
 * hàm này KHÔNG kết luận thành công/thất bại. Việc đó là của compile-check.ts.
 */
export const renderPlantUml = async (
  source: string,
  format: PlantUmlFormat = "svg"
): Promise<PlantUmlRenderResult> => {
  const contentType = format === "svg" ? "image/svg+xml" : "image/png"

  // Đường 1: POST source thô
  try {
    const res = await withTimeout(`${baseUrl()}/${format}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: source
    })

    // 200 không phải ảnh ⇒ rơi xuống đường GET thay vì trả buffer rác.
    if ((res.ok && isImageResponse(res)) || isDiagramErrorImage(res)) {
      return {
        format,
        data: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get("content-type") ?? contentType,
        transport: "post",
        status: res.status,
        diagnostics: readDiagnostics(res)
      }
    }

    // Không dùng body này nữa ⇒ huỷ để undici nhả socket ngay thay vì đợi GC.
    // Một server lạ chiếm cổng làm mọi lô render đi qua đây.
    void res.body?.cancel().catch(() => {})
  } catch {
    // POST không được hỗ trợ hoặc lỗi mạng ⇒ thử đường GET
  }

  // Đường 2: GET với source đã encode
  const res = await withTimeout(
    `${baseUrl()}/${format}/${encodePlantUml(source)}`,
    { method: "GET" }
  )

  // Kiểm content-type TRƯỚC status: server lạ chiếm cổng thường không có route
  // `/svg/<enc>` nên trả 404 HTML — báo "HTTP 404" thì người đọc log tưởng PlantUML
  // hỏng, trong khi vấn đề là cổng đang bị chiếm.
  if (!isImageResponse(res)) {
    throw new Error(
      `${baseUrl()}/${format} trả HTTP ${res.status} kèm content-type ` +
        `"${res.headers.get("content-type") ?? "(trống)"}" thay vì image/* — ` +
        "server đang nghe ở cổng này không phải PlantUML"
    )
  }

  if (!res.ok && !isDiagramErrorImage(res)) {
    throw new Error(
      `PlantUML trả HTTP ${res.status} ${res.statusText} (${baseUrl()}/${format})`
    )
  }

  return {
    format,
    data: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") ?? contentType,
    transport: "get",
    status: res.status,
    diagnostics: readDiagnostics(res)
  }
}

/** Sơ đồ tí hon cho probe: render thật nhưng gần như không tốn gì. */
const HEALTH_PROBE_SOURCE = "@startuml\nA -> B\n@enduml"

/**
 * Server có sống không — dùng để probe test skip thay vì fail, và nuôi `/health`.
 *
 * Phải render thật chứ không `GET /`: một web server lạ chiếm cổng cũng trả 200
 * cho đường gốc, khiến `/health` báo `ok` trong khi PlantUML chưa hề chạy.
 * Không gọi `renderPlantUml` vì hàm đó dùng `PLANTUML_TIMEOUT_MS` của render.
 */
export const isPlantUmlReachable = async (): Promise<boolean> => {
  try {
    // Timeout ngan: day la health check, khong phai render.
    const res = await withTimeout(
      `${baseUrl()}/svg/${encodePlantUml(HEALTH_PROBE_SOURCE)}`,
      { method: "GET" },
      HEALTH_TIMEOUT_MS
    )
    return res.ok && isImageResponse(res)
  } catch {
    return false
  }
}
