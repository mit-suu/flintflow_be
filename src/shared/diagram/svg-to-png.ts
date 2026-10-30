/**
 * svg-to-png.ts
 * ─────────────────────────────────────────────────────────────────
 * PNG cho sơ đồ tự dựng (`format = svg`) bằng resvg — không cần Chrome, không cần PlantUML, không dùng font hệ thống
 * (image `node:22-alpine` không có font): chỉ Liberation Sans (Regular, Bold, Italic) đóng gói ở `assets/fonts/`, cũng là font sinh bảng đo chữ.
 *
 * - Render qua `renderAsync` (threadpool libuv) ⇒ không chặn event loop.
 * - Scale 2x như `toPng` của guideline; cạnh dài bị chặn ở `MAX_PNG_PX` (thu nhỏ, không lỗi).
 * - Import lazy: thiếu binary native chỉ làm hỏng lượt vẽ svg (thành `render_status = error`), không làm server
 *   crash lúc boot.
 */

import path from "node:path"
import { getAssetsRoot } from "../../config/paths.js"

export const PNG_SCALE = 2
export const MAX_PNG_PX = 8192
export const MAX_SVG_BYTES = 2 * 1024 * 1024
export const FONT_FAMILY = "Liberation Sans"
export const FONT_FILES = ["LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf", "LiberationSans-Italic.ttf"] as const

type ResvgModule = typeof import("@resvg/resvg-js")
let resvg: Promise<ResvgModule> | null = null
const loadResvg = (): Promise<ResvgModule> => {
  resvg ??= import("@resvg/resvg-js").catch((err: unknown) => {
    resvg = null
    throw err
  })
  return resvg
}

const svgSize = (svg: string): { w: number; h: number } | null => {
  const tag = /<svg\b[^>]*>/.exec(svg)?.[0]
  const w = Number(tag && /\swidth="([\d.]+)"/.exec(tag)?.[1])
  const h = Number(tag && /\sheight="([\d.]+)"/.exec(tag)?.[1])
  return w > 0 && h > 0 ? { w, h } : null
}

/** SVG → PNG 2x (trần `MAX_PNG_PX`). Ném khi SVG quá lớn, không parse được hoặc resvg không nạp được. */
export const svgToPng = async (svg: string): Promise<Buffer> => {
  if (Buffer.byteLength(svg, "utf8") > MAX_SVG_BYTES) throw new Error(`svg too large (> ${MAX_SVG_BYTES} bytes)`)
  const size = svgSize(svg)
  if (!size) throw new Error("svg thiếu width/height")
  const longest = Math.max(size.w, size.h) * PNG_SCALE
  const fitTo =
    longest > MAX_PNG_PX
      ? size.w >= size.h
        ? { mode: "width" as const, value: MAX_PNG_PX }
        : { mode: "height" as const, value: MAX_PNG_PX }
      : { mode: "zoom" as const, value: PNG_SCALE }

  const { renderAsync } = await loadResvg()
  const fontsDir = path.join(getAssetsRoot(), "fonts")
  const image = await renderAsync(svg, {
    fitTo,
    background: "#ffffff",
    font: {
      fontFiles: FONT_FILES.map((f) => path.join(fontsDir, f)),
      loadSystemFonts: false,
      defaultFontFamily: FONT_FAMILY,
      sansSerifFamily: FONT_FAMILY
    }
  })
  return image.asPng()
}
