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
 * quá rộng sẽ báo lỗi cho diagram hợp lệ mà tình cờ chứa chữ "error" — chữ
 * "syntax error" chung chung (vd tên message `Syntax error in email`) đã bị bỏ,
 * chỉ giữ đúng câu PlantUML in ra kèm dấu "?".
 */
const SVG_ERROR_MARKERS = [
  "Syntax Error?",
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

  // Cách 2: quét SVG. Probe T10 (1.2026.8): đường POST trả 400 + SVG lỗi, KHÔNG có header ⇒ rơi vào đây.
  const svg = render.data.toString("utf-8")
  const marker = scanSvgForError(svg)
  const line = /\[From string \(line (\d+)\)/.exec(svg)?.[1]

  // Cách 3: `@startdot` hỏng (dot báo lỗi) ⇒ PlantUML trả 200 + text `Error: <stdin>: syntax error…`, không phải SVG
  if (!svg.includes("<svg")) {
    return {
      ok: false,
      method: "svg-scan",
      error: `PlantUML không trả SVG: ${svg.trim().split("\n")[0]?.slice(0, 200) ?? ""}`,
      render
    }
  }

  if (marker || render.status >= 400) {
    return {
      ok: false,
      method: "svg-scan",
      error: marker ? `SVG chứa marker lỗi của PlantUML: "${marker}"` : `PlantUML trả HTTP ${render.status}`,
      ...(line ? { line } : {}),
      render
    }
  }

  return { ok: true, method: "svg-scan", render }
}
