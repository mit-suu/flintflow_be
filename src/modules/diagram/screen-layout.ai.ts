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
    return extractSalt(result.data.puml)
  } catch (err) {
    console.warn(`[diagram] Model không vẽ được wireframe ${screenId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
