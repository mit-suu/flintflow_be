/**
 * Wireframe màn bằng model (FLF-214) — skill `renderer/screen-layout`.
 *
 * Renderer code (`screen-layout.renderer.ts`) chỉ biết tên + mô tả function nên chỉ vẽ được bảng
 * Function | Description. Model đọc thêm trigger ("clicks the Log in button"), validation ("Email must…"),
 * pop-up/tab và màn đích để vẽ wireframe salt có ô nhập, nút, link như màn thật.
 *
 * Đi qua call kind `render_fix` có sẵn (đầu ra `{ puml }`, 1 credit) với prompt của skill screen-layout —
 * không thêm `ActionType` (hợp đồng đóng băng). Không ghi gì vào Spine: salt chỉ thành `diagrams[].puml`.
 * Mọi lỗi (hết credit, parse, salt sai hình) ⇒ `null` ⇒ `diagram.service` vẽ bảng function như trước.
 */

import { ActionType } from "../../shared/ai/ai-action.types.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { getSkill } from "../../shared/ai/prompt-registry.service.js"
import type { RenderFixOutput } from "../../shared/ai/response-parser.js"
import { VIETNAMESE_DIACRITICS } from "../spine/deterministic-check.js"
import type { Spine } from "../spine/spine.types.js"
import { compareIds } from "./renderers/common.js"

export const SCREEN_LAYOUT_SKILL = "screen-layout"

export interface LayoutInput {
  projectId: string
  userId: string
  spine: Spine
  screenId: string
}

/** Trả salt model vẽ cho màn, hoặc `null` để dùng bảng function. Không bao giờ ném. */
export type DrawLayout = (input: LayoutInput) => Promise<string | null>

export const noAiLayout: DrawLayout = async () => null

/** Dữ liệu màn đưa cho model — đúng `reads` của skill, không hơn. */
export const layoutContext = (spine: Spine, screenId: string): Record<string, unknown> | null => {
  const screen = spine.screens.find((s) => s.id === screenId)
  if (!screen) return null
  const names = new Map(spine.screens.map((s) => [s.id, s.name]))
  return {
    system_name: spine.project.system_name?.trim() || null,
    screen: { name: screen.name, description: screen.description, is_popup: screen.is_popup, tabs: screen.tabs },
    functions: spine.functions
      .filter((f) => f.screen_id === screenId)
      .sort((a, b) => a.order - b.order || compareIds(a.id, b.id))
      .map((f) => ({ name: f.name, trigger: f.trigger, description: f.description, validations: f.validations.map((v) => v.statement) })),
    navigates_to: screen.flow_to.map((id) => names.get(id)).filter((n): n is string => Boolean(n))
  }
}

export const layoutPrompt = (template: string, context: Record<string, unknown>): string =>
  `${template}\n\n## Screen to draw\n\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n`

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

export const aiScreenLayout: DrawLayout = async ({ projectId, userId, spine, screenId }) => {
  try {
    const context = layoutContext(spine, screenId)
    if (!context) return null
    const skill = getSkill(SCREEN_LAYOUT_SKILL)
    const result = await executeAiAction<RenderFixOutput>(
      ActionType.RENDER_FIX,
      { rawPrompt: layoutPrompt(skill.template, context) },
      projectId,
      userId,
      { provider: skill.providerConfig.provider, model: skill.providerConfig.model }
    )
    const salt = extractSalt(result.data.puml)
    return salt === null ? null : padFrame(salt)
  } catch (err) {
    console.warn(`[diagram] Model không vẽ được wireframe ${screenId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
