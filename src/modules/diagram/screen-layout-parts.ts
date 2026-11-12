/**
 * Các part của một target `screen_layout` (FLF-410): mockup SVG mỗi nền tảng một hình, hoặc bảng Function | Description.
 *
 * Thứ tự quyết định (không gọi model khi không cần):
 * 1. Hình đang có còn đúng (`ok`, cùng `source_hash`, không `force`) ⇒ giữ nguyên.
 * 2. Spec đã lưu trong SVG của màn có `contentHash` khớp ngữ cảnh hiện tại ⇒ vẽ lại bằng code (đổi theme, nền tảng).
 * 3. Gọi model (`drawLayout`) ⇒ spec mới.
 * 4. Model lỗi / spec null / scene có lỗi bố cục ⇒ bảng function (một part, `format: puml`).
 *
 * `specOnly` (đổi theme): bước 3 bị bỏ — màn chưa có spec giữ nguyên hình đang có (trả `null`).
 */

import { createHash } from "node:crypto"
import type { Diagram, Spine } from "../spine/spine.types.js"
import { stableStringify } from "../spine/source-hash.js"
import { checkScene } from "../../shared/diagram/svg-geometry.js"
import type { RenderContext } from "../../shared/diagram/erd-notation.js"
import { resolveScreenTheme, SCREEN_PLATFORMS, type ResolvedScreenTheme, type ScreenMockupMode, type ScreenPlatform } from "../../shared/diagram/screen-theme.js"
import { systemName } from "../spine/system-name.js"
import { renderKind, type RenderedDiagramPart } from "./renderers/index.js"
import { compareIds } from "./renderers/common.js"
import { MOCKUP_MARGIN, renderScreenMockup, screenSpecOf } from "./renderers/screen-mockup.js"
import { layoutContext, type DrawLayout, type LayoutInput } from "./screen-layout.ai.js"
import type { ScreenEnvelope, ScreenSpec } from "./screen-spec.js"

/** Ảnh gốc của màn import (kiểu vẽ + ảnh) — phần dự án import nạp; không có ⇒ màn FlintFlow thường. */
export type LoadOriginal = (projectId: string, spine: Spine, screenId: string, mode: ScreenMockupMode) => Promise<{ input: NonNullable<LayoutInput["original"]>; imageHash: string } | null>

export interface ScreenLayoutPartsInput {
  projectId: string
  userId: string
  spine: Spine
  screenId: string
  context: RenderContext
  /** Hình đang có của target (đã sắp theo id). */
  existing: readonly Diagram[]
  force: boolean
  specOnly: boolean
  drawLayout: DrawLayout
  loadOriginal?: LoadOriginal
  /** Kết quả lượt gọi model của màn (ảnh màn hình, màu ảnh gốc) — phần vẽ lại ảnh gốc đọc lại. */
  onDrawn?: (screenId: string, envelope: ScreenEnvelope | null) => void
}

const PLATFORM_LABEL: Readonly<Record<ScreenPlatform, string>> = { web: "Web", mobile: "Mobile" }

/**
 * Hash ngữ cảnh model đọc (nội dung màn + kiểu vẽ + ảnh gốc): khác ⇒ phải gọi model lại. KHÔNG gồm phạm vi nền tảng: đổi
 * nền tảng trong theme vẽ lại bằng code (`platformsToDraw`), không tốn lượt model.
 */
export const layoutContentHash = (context: Record<string, unknown>, mode: ScreenMockupMode, imageHash = ""): string => {
  const { allowed_platforms: _allowed, ...content } = context
  return createHash("sha256").update(stableStringify({ context: content, mode, imageHash })).digest("hex")
}

/**
 * Nền tảng vẽ: model thu hẹp (`spec.platforms` ⊊ phạm vi lúc hỏi — màn quản trị chỉ web) ⇒ giữ phần thu hẹp trong theme hiện
 * tại; không thu hẹp ⇒ mọi nền tảng của theme hiện tại (dự án vừa thêm mobile thì màn thường có thêm hình mobile).
 */
export const platformsToDraw = (spec: ScreenSpec, allowedAtDraw: readonly ScreenPlatform[], theme: ResolvedScreenTheme): ScreenPlatform[] => {
  const narrowed = allowedAtDraw.some((p) => !spec.platforms.includes(p))
  const kept = narrowed ? SCREEN_PLATFORMS.filter((p) => spec.platforms.includes(p) && theme.platforms.includes(p)) : []
  return kept.length > 0 ? kept : [...theme.platforms]
}

/** Chế độ vẽ của màn: màn import đã bật mockup ⇒ kiểu đã chọn; còn lại `system`. */
export const mockupModeOf = (context: RenderContext, screenId: string): ScreenMockupMode =>
  context.screenMockups?.find((m) => m.screen_id === screenId)?.mode ?? "system"

/**
 * Bảng function làm nền: renderer code. Màn import không có `primary_function_id` (TechMart SCR-01…) nhưng đã bật mockup ⇒
 * gắn vào function đầu tiên của màn theo `order`.
 */
const basePart = (spine: Spine, screenId: string, context: RenderContext): RenderedDiagramPart | null => {
  const direct = renderKind(spine, "screen_layout", screenId, context)[0]
  if (direct) return direct
  if (!context.screenMockups?.some((m) => m.screen_id === screenId)) return null
  const first = spine.functions.filter((f) => f.screen_id === screenId).sort((a, b) => a.order - b.order || compareIds(a.id, b.id))[0]
  if (!first) return null
  const patched: Spine = { ...spine, screens: spine.screens.map((s) => (s.id === screenId ? { ...s, primary_function_id: first.id } : s)) }
  return renderKind(patched, "screen_layout", screenId, context)[0] ?? null
}

const asPart = (d: Diagram): RenderedDiagramPart => ({
  kind: d.kind,
  section: d.section,
  owner_kind: d.owner_kind,
  owner_id: d.owner_id,
  format: d.format,
  source: d.source,
  source_hash: d.source_hash
})

/** Mockup mọi nền tảng của spec; có lỗi bố cục ⇒ null (rơi về bảng function). */
export const mockupParts = (
  spine: Spine,
  base: RenderedDiagramPart,
  spec: ScreenSpec,
  theme: ResolvedScreenTheme,
  contentHash: string,
  mode: ScreenMockupMode,
  allowedAtDraw: readonly ScreenPlatform[]
): RenderedDiagramPart[] | null => {
  const screen = spine.screens.find((s) => s.id === base.owner_id)
  const shown = platformsToDraw(spec, allowedAtDraw, theme)
  const name = screen?.name ?? base.owner_id ?? ""
  const parts: RenderedDiagramPart[] = []
  for (const platform of shown) {
    const title = shown.length > 1 ? `Screen Layout - ${name} (${PLATFORM_LABEL[platform]})` : `Screen Layout - ${name}`
    const scene = renderScreenMockup({ spec, theme, platform, systemName: systemName(spine.project), screenName: name, title, contentHash, mode, allowedPlatforms: allowedAtDraw })
    if (checkScene(scene, { allowBends: true }).length > 0) return null
    parts.push({ ...base, format: "svg", source: scene.toSvg(title, MOCKUP_MARGIN), issues: [] })
  }
  return parts
}

/** Part của target; `null` = bỏ qua target, giữ nguyên hình đang có (`specOnly` mà màn chưa có spec). */
export const screenLayoutParts = async (input: ScreenLayoutPartsInput): Promise<RenderedDiagramPart[] | null> => {
  const { spine, screenId, context, existing } = input
  const base = basePart(spine, screenId, context)
  if (!base) return []
  if (!input.force && existing.length > 0 && existing.every((d) => d.render_status === "ok" && d.source_hash === base.source_hash)) return existing.map(asPart)

  const theme = resolveScreenTheme(context.screenTheme, spine.project.form_factor)
  const mode = mockupModeOf(context, screenId)
  const imported = context.screenMockups?.some((m) => m.screen_id === screenId) ?? false
  const original = imported && input.loadOriginal ? await input.loadOriginal(input.projectId, spine, screenId, mode).catch(() => null) : null
  const modelContext = layoutContext(spine, screenId, theme.platforms, original?.input)
  if (!modelContext) return [base]
  const contentHash = layoutContentHash(modelContext, mode, original?.imageHash)

  const stored = existing.map((d) => (d.format === "svg" ? screenSpecOf(d.source) : null)).find((s) => s !== null && s.contentHash === contentHash && s.mode === mode)
  if (stored) return mockupParts(spine, base, stored.spec, theme, contentHash, mode, stored.allowed) ?? [base]
  if (input.specOnly) return null

  const envelope = await input
    .drawLayout({ projectId: input.projectId, userId: input.userId, spine, screenId, platforms: theme.platforms, ...(original ? { original: original.input } : {}) })
    .catch(() => null)
  input.onDrawn?.(screenId, envelope)
  if (!envelope) return [base]
  return mockupParts(spine, base, envelope.spec, theme, contentHash, mode, theme.platforms) ?? [base]
}
