/**
 * Mockup màn bằng model (FLF-214, FLF-410) — skill `renderer/screen-layout`.
 *
 * Renderer code (`screen-layout.renderer.ts`) chỉ biết tên + mô tả function nên chỉ vẽ được bảng Function | Description.
 * Model đọc thêm trigger ("clicks the Log in button"), validation ("Email must…"), pop-up/tab và màn đích rồi trả
 * **ScreenSpec** (`screen-spec.ts`): nội dung màn, không màu / pixel. Code vẽ mockup web / mobile theo theme dự án
 * (`renderers/screen-mockup.ts`) — đổi theme vẽ lại từ spec, không gọi model.
 *
 * Đi qua call kind `render_fix` có sẵn (đầu ra `{ puml }`, 1 credit): model ghi envelope JSON vào `puml` — không thêm
 * `ActionType`, không đổi `renderFixSchema` (hợp đồng đóng băng). Không ghi gì vào Spine. Mọi lỗi (hết credit, parse, spec
 * sai schema) ⇒ `null` ⇒ `diagram.service` vẽ bảng function như trước.
 *
 * Màn import có ảnh gốc (phase vẽ lại ảnh gốc): input thêm `original_images` + `mode`; kiểu `original` gửi kèm ảnh. Model
 * chỉ ra ảnh nào là ảnh màn hình (`screen_images`) và, ở kiểu `original`, màu chủ đạo (`primary_color`).
 *
 * `extractSalt` / `padFrame` còn lại cho wireframe Salt cũ (FLF-214) đang nằm trong tài liệu chưa vẽ lại.
 */

import { ActionType } from "../../shared/ai/ai-action.types.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { getSkill } from "../../shared/ai/prompt-registry.service.js"
import type { RenderFixOutput } from "../../shared/ai/response-parser.js"
import type { LlmImage } from "../../shared/ai/providers/provider.types.js"
import type { ScreenMockupMode, ScreenPlatform } from "../../shared/diagram/screen-theme.js"
import { parseScreenEnvelope, type ScreenEnvelope } from "./screen-spec.js"
import { VIETNAMESE_DIACRITICS } from "../spine/deterministic-check.js"
import type { Spine } from "../spine/spine.types.js"
import { compareIds } from "./renderers/common.js"

export const SCREEN_LAYOUT_SKILL = "screen-layout"

/** Ảnh gốc của mục (dự án import). `image` chỉ có ở kiểu `original` và khi đọc được (PNG/JPEG). */
export interface OriginalImageInput {
  index: number
  caption: string
  context: string
  image?: LlmImage | null
}

export interface LayoutInput {
  projectId: string
  userId: string
  spine: Spine
  screenId: string
  /** Nền tảng dự án (theme đã resolve) — model chọn `platforms` của màn trong tập này. */
  platforms: readonly ScreenPlatform[]
  /** Chỉ màn import có ảnh gốc. */
  original?: { mode: ScreenMockupMode; images: readonly OriginalImageInput[] }
}

/** Trả envelope (spec + ảnh màn hình + màu) model trả cho màn, hoặc `null` để dùng bảng function. Không bao giờ ném. */
export type DrawLayout = (input: LayoutInput) => Promise<ScreenEnvelope | null>

export const noAiLayout: DrawLayout = async () => null

/** Dữ liệu màn đưa cho model — đúng `reads` của skill (+ phạm vi nền tảng, ảnh gốc), không hơn. */
export const layoutContext = (
  spine: Spine,
  screenId: string,
  platforms: readonly ScreenPlatform[] = ["web"],
  original?: LayoutInput["original"]
): Record<string, unknown> | null => {
  const screen = spine.screens.find((s) => s.id === screenId)
  if (!screen) return null
  const names = new Map(spine.screens.map((s) => [s.id, s.name]))
  return {
    system_name: spine.project.system_name?.trim() || null,
    form_factor: spine.project.form_factor ?? [],
    allowed_platforms: [...platforms],
    screen: { name: screen.name, description: screen.description, is_popup: screen.is_popup, tabs: screen.tabs },
    functions: spine.functions
      .filter((f) => f.screen_id === screenId)
      .sort((a, b) => a.order - b.order || compareIds(a.id, b.id))
      .map((f) => ({ name: f.name, trigger: f.trigger, description: f.description, validations: f.validations.map((v) => v.statement) })),
    navigates_to: screen.flow_to.map((e) => names.get(e.to)).filter((n): n is string => Boolean(n)),
    ...(original
      ? { mode: original.mode, original_images: original.images.map(({ index, caption, context }) => ({ index, caption, context })) }
      : {})
  }
}

/** Thân skill + reference bảng block (draftOps không nạp reference ⇒ nối tay ở đây) + JSON màn. */
export const layoutPrompt = (template: string, context: Record<string, unknown>, references: readonly string[] = []): string =>
  `${[template, ...references].join("\n\n")}\n\n## Screen to draw\n\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n`

/**
 * Salt hợp lệ về hình thức: đúng một khối `@startsalt … @endsalt`, không dấu tiếng Việt (nhãn `.puml` là tiếng
 * Anh). Cú pháp bên trong do compile-check của PlantUML quyết.
 */
export const extractSalt = (text: string): string | null => {
  const body = text.replace(/\r\n/g, "\n").trim()
  if (!body.startsWith("@startsalt\n") || !body.endsWith("\n@endsalt")) return null
  if ((body.match(/@startsalt/g) ?? []).length !== 1 || VIETNAMESE_DIACRITICS.test(body)) return null
  return `${body}\n`
}

/** Khung ngoài của màn: `{+` (màn thường) hoặc `{^"Tên màn"` / `{^` (pop-up). */
const FRAME_OPEN = /^(\s*)\{(\+|\^(".*")?)\s*$/
/** Chỉ một chuỗi `"…"` trên dòng — ngay sau `{^` thì đó là tiêu đề model viết xuống dòng, không phải ô nhập. */
const LONE_QUOTED = /^\s*("[^"]*")\s*$/
/**
 * Salt không có padding: widget dính sát viền khung (đo trên SVG: 0–2px). Bọc nội dung trong hàng
 * `{ . | . | { … } | . | . }` và thêm dòng `.` trên/dưới ⇒ ~15px hai bên, ~20px trên/dưới.
 */
export const PAD_ROW_OPEN = "{ . | . | {"
export const PAD_ROW_CLOSE = "} | . | . }"

/** `{` trừ `}` của một dòng, bỏ phần trong ô nhập `"…"`. */
const braceDelta = (line: string): number => {
  const bare = line.replace(/"[^"]*"/g, "")
  return (bare.match(/\{/g) ?? []).length - (bare.match(/\}/g) ?? []).length
}

/**
 * Thêm khoảng đệm giữa viền khung ngoài và nội dung; không thấy khung hoặc đã đệm ⇒ trả nguyên.
 * Pop-up `{^` có tiêu đề bị viết xuống dòng dưới (salt vẽ thành ô nhập) ⇒ gộp lại thành `{^"Tên"`.
 */
export const padFrame = (salt: string): string => {
  const lines = salt.split("\n")
  const open = lines.findIndex((l) => FRAME_OPEN.test(l))
  if (open < 0) return salt
  const title = lines[open].trim() === "{^" ? LONE_QUOTED.exec(lines[open + 1] ?? "") : null
  if (title) lines.splice(open, 2, `${FRAME_OPEN.exec(lines[open])![1]}{^${title[1]}`)
  let depth = 0
  let close = -1
  for (let i = open; i < lines.length; i++) {
    depth += braceDelta(lines[i])
    if (depth === 0) {
      close = i
      break
    }
  }
  const inner = lines.slice(open + 1, close)
  if (close < 0 || inner.every((l) => !l.trim()) || inner.some((l) => l.trim() === PAD_ROW_OPEN)) return salt
  const indent = `${FRAME_OPEN.exec(lines[open])![1]}  `
  return [
    ...lines.slice(0, open + 1),
    `${indent}.`,
    `${indent}${PAD_ROW_OPEN}`,
    ...inner.map((l) => (l.trim() ? `  ${l}` : l)),
    `${indent}${PAD_ROW_CLOSE}`,
    `${indent}.`,
    ...lines.slice(close)
  ].join("\n")
}

/** Reference của skill nối vào prompt (bảng block + 2 ví dụ). */
export const LAYOUT_REFERENCES = ["blocks"] as const
/** Luật màn có ảnh gốc (kiểu vẽ, nhận diện ảnh màn hình) — chỉ nối khi input có ảnh gốc, màn khác khỏi tốn token. */
export const ORIGINALS_REFERENCE = "originals"

/** Reference cần nối cho một màn: luôn có bảng block; thêm luật ảnh gốc khi màn có ảnh gốc. */
export const layoutReferences = (original?: LayoutInput["original"]): string[] =>
  original?.images.length ? [...LAYOUT_REFERENCES, ORIGINALS_REFERENCE] : [...LAYOUT_REFERENCES]

export const aiScreenLayout: DrawLayout = async ({ projectId, userId, spine, screenId, platforms, original }) => {
  try {
    const context = layoutContext(spine, screenId, platforms, original)
    if (!context) return null
    const references = layoutReferences(original)
    const skill = getSkill(SCREEN_LAYOUT_SKILL, { references })
    const images = original?.mode === "original" ? original.images.flatMap((i) => (i.image ? [i.image] : [])) : []
    const result = await executeAiAction<RenderFixOutput>(
      ActionType.RENDER_FIX,
      { rawPrompt: layoutPrompt(skill.template, context, references.map((r) => skill.references[r])) },
      projectId,
      userId,
      { provider: skill.providerConfig.provider, model: skill.providerConfig.model, ...(images.length ? { images } : {}) }
    )
    return parseScreenEnvelope(result.data.puml, platforms)
  } catch (err) {
    console.warn(`[diagram] Model không vẽ được mockup ${screenId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
