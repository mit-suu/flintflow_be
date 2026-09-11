/**
 * compile-check.ts
 * ─────────────────────────────────────────────────────────────────
 * Xác định một `.puml` có compile được hay không.
 *
 * Vấn đề cốt lõi: **PlantUML trả HTTP 200 kèm ẢNH LỖI** khi syntax sai. Kiểm
 * status code là không đủ — đó là cách một cờ `render_error` không bao giờ bắn
 * và một diagram gãy lọt vào tài liệu đã ký baseline.
 *
 * Hai cách phát hiện, theo thứ tự tin cậy:
 *   1. Header `x-plantuml-diagram-error` — rẻ và chính xác, NẾU build image đặt.
 *   2. Quét marker lỗi trong SVG trả về — luôn dùng được, nhưng là heuristic.
 *
 * Cách nào thực sự hoạt động với tag image đang ghim là câu hỏi THỰC NGHIỆM;
 * `plantuml.test.ts` trả lời nó và in ra kết quả.
 */

import { renderPlantUml, type PlantUmlRenderResult } from "./plantuml.client.js"

export type CompileCheckMethod = "header" | "svg-scan"

export type CompileCheckResult =
  | { ok: true; method: CompileCheckMethod; render: PlantUmlRenderResult }
  | {
      ok: false
      method: CompileCheckMethod
      error: string
      line?: string
      render: PlantUmlRenderResult
    }

/**
 * Marker lỗi trong SVG do PlantUML sinh. Giữ danh sách hẹp và có chủ ý: marker
 * quá rộng sẽ báo lỗi cho diagram hợp lệ mà tình cờ chứa chữ "error".
 */
const SVG_ERROR_MARKERS = [
  "syntax error",
  "Syntax Error",
  "[From string (line",
  "Assumed diagram type"
] as const

const scanSvgForError = (svg: string): string | null => {
  for (const marker of SVG_ERROR_MARKERS) {
    if (svg.includes(marker)) return marker
  }
  return null
}

/**
 * Compile-check một `.puml`. Luôn render bằng SVG vì chỉ SVG mới quét được
 * marker lỗi — PNG là bytes, không đọc được text.
 */
export const checkPlantUml = async (source: string): Promise<CompileCheckResult> => {
  const render = await renderPlantUml(source, "svg")

  // Cách 1: header chẩn đoán
  if (render.diagnostics.error) {
    return {
      ok: false,
      method: "header",
      error: render.diagnostics.error,
      line: render.diagnostics.errorLine,
      render
    }
  }

  // Cách 2: quét SVG
  const svg = render.data.toString("utf-8")
  const marker = scanSvgForError(svg)

  if (marker) {
    return {
      ok: false,
      method: "svg-scan",
      error: `SVG chứa marker lỗi của PlantUML: "${marker}"`,
      render
    }
  }

  return { ok: true, method: "svg-scan", render }
}
