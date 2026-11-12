/**
 * Mockup màn §3.x.y Screen Layout (FLF-410): ScreenSpec (nội dung, do model) + theme dự án (màu chính, domain, nền tảng,
 * do người dùng) ⇒ SVG dựng qua `Scene`. Hàm thuần — cùng đầu vào ⇒ cùng markup.
 *
 * - Web (rộng 1190): khung trình duyệt (3 chấm + thanh địa chỉ `https://<domain><path>`, domain trống ⇒ chỉ path), header
 *   màu chính có tên hệ thống + `nav`, tabs, tiêu đề, block theo `columns`.
 * - Mobile (390 + khung điện thoại): thanh trạng thái, app bar màu chính (nút back, tên màn), một cột, nút rộng hết màn,
 *   `nav` ⇒ thanh tab dưới đáy.
 * - Pop-up: nền mờ, hộp thoại giữa màn, không header.
 *
 * Spec + hash nội dung model đã đọc đi kèm SVG trong `<metadata id="ff-screen-spec">` (`diagrams[].source` là SVG đầy đủ)
 * để đổi theme / dịch nhãn vẽ lại không gọi model (`screenSpecOf`). Bố cục: phân loại phần tử cho `checkScene`, chữ dài
 * cắt `...` theo bảng đo chữ.
 */

import { Scene } from "../../../shared/diagram/svg-scene.js"
import type { ResolvedScreenTheme, ScreenMockupMode, ScreenPlatform } from "../../../shared/diagram/screen-theme.js"
import { SCREEN_MOCKUP_MODES, SCREEN_PLATFORMS } from "../../../shared/diagram/screen-theme.js"
import { textWidth } from "../../../shared/diagram/svg-kit.js"
import { parseScreenSpec, type ScreenSpec } from "../screen-spec.js"
import { drawBlocks, type Area, type BlockContext } from "./screen-mockup-blocks.js"
import { BORDER, CHROME, DEVICE, DIM, fit, LINE, MUTED, paletteOf, TEXT, WHITE, type MockupPalette } from "./screen-mockup-style.js"

export const SCREEN_SPEC_METADATA_ID = "ff-screen-spec"

const WEB_W = 1190
const WEB_PAD = 32
const MOBILE_W = 390
const MOBILE_PAD = 20
const FRAME = 14
const MOBILE_MIN_H = 760
const WEB_MIN_H = 520
const BAR = 46

export interface MockupInput {
  spec: ScreenSpec
  theme: ResolvedScreenTheme
  platform: ScreenPlatform
  /** Tên hệ thống trên header web. */
  systemName: string
  /** Tên màn trên app bar mobile. */
  screenName: string
  /** `<title>` của SVG = chú thích ảnh. */
  title: string
  /** Hash ngữ cảnh model đã đọc — so ở lượt vẽ sau để dùng lại spec. */
  contentHash: string
  mode: ScreenMockupMode
  /** Phạm vi nền tảng model được hỏi lúc vẽ — biết `spec.platforms` là model thu hẹp (màn chỉ web) hay là cả phạm vi. */
  allowedPlatforms: readonly ScreenPlatform[]
}

const counterIds = () => {
  const used = new Set<string>()
  return (key: string): string => {
    let id = key
    for (let n = 2; used.has(id); n++) id = `${key}~${n}`
    used.add(id)
    return id
  }
}

const blockContext = (scene: Scene, pal: MockupPalette, mobile: boolean): BlockContext => ({ scene, pal, mobile, id: counterIds() })

/** Chiều cao các block trong bề rộng `w` — đo bằng một scene nháp (vẽ thật cần biết kích thước khung trước). */
const blocksHeight = (spec: ScreenSpec, pal: MockupPalette, mobile: boolean, w: number, cols: number): number =>
  drawBlocks(blockContext(new Scene(), pal, mobile), spec.blocks, { x: 0, w }, 0, cols)

const urlText = (theme: ResolvedScreenTheme, path: string): string => (theme.domain ? `https://${theme.domain}${path}` : path)

/** Thanh tab dưới header; tab đầu active. `segments`: chia đều bề rộng (mobile), không ⇒ nối tiếp từ trái (web). */
const drawTabs = (c: BlockContext, tabs: readonly string[], x: number, y: number, w: number, segments: boolean): number => {
  const h = 44
  c.scene.rect(c.id("tabs"), x, y, w, h, { fill: WHITE, stroke: "none", container: true })
  c.scene.rect(c.id("tabs-hr"), x, y + h - 1, w, 1, { fill: LINE, stroke: "none" })
  let cursor = x + (segments ? 0 : WEB_PAD)
  tabs.forEach((tab, i) => {
    const seg = segments ? w / tabs.length : Math.min(textWidth(tab, 15, i === 0) + 32, x + w - cursor)
    if (seg < 40) return
    const text = fit(tab, 15, seg - 16, i === 0)
    if (!text) return
    const cx = cursor + seg / 2
    c.scene.text(c.id(`tab-${i}`), cx, y + h / 2 - 2, text, { size: 15, bold: i === 0, baseline: "central", color: i === 0 ? c.pal.accent : MUTED })
    if (i === 0) c.scene.rect(c.id("tab-active"), cx - textWidth(text, 15, true) / 2 - 8, y + h - 4, textWidth(text, 15, true) + 16, 3, { fill: c.pal.primary, stroke: "none" })
    cursor += seg
  })
  return y + h
}

// ─── web ─────────────────────────────────────────────────────────

const renderWeb = (scene: Scene, input: MockupInput, pal: MockupPalette): void => {
  const { spec, theme } = input
  const cols = spec.columns ?? 1
  const popup = spec.popup ?? false
  const contentW = WEB_W - WEB_PAD * 2
  const dialogW = 560
  const headerBottom = popup ? BAR : BAR + 64 + (spec.tabs?.length ? 44 : 0)
  const body = popup ? blocksHeight(spec, pal, false, dialogW - 56, Math.min(cols, 2)) : blocksHeight(spec, pal, false, contentW, cols)
  const H = popup ? Math.max(BAR + 60 + 56 + body + 28 + 60, WEB_MIN_H) : Math.max(headerBottom + 36 + 50 + body + 40, WEB_MIN_H)
  const c = blockContext(scene, pal, false)

  scene.rect(c.id("frame"), 0, 0, WEB_W, H, { fill: WHITE, stroke: BORDER, strokeWidth: 1, container: true, name: "browser" })
  scene.rect(c.id("bar"), 0, 0, WEB_W, BAR, { fill: CHROME, stroke: "none", container: true, name: "browser bar" })
  ;["#E0504A", "#E8B23A", "#52B548"].forEach((dot, i) => scene.circle(c.id(`dot-${i}`), 22 + i * 22, BAR / 2, 7, { fill: dot, stroke: "none" }))
  const pill = scene.rect(c.id("url"), 118, 9, 652, 28, { fill: WHITE, stroke: "#BBBBBB", strokeWidth: 1, radius: 14, name: "address bar" })
  const url = fit(urlText(theme, spec.path), 14, 652 - 28)
  if (url) scene.text(c.id("url-t"), 132, BAR / 2, url, { size: 14, anchor: "start", baseline: "central", owner: pill, color: MUTED })

  if (popup) {
    scene.rect(c.id("dim"), 0, BAR, WEB_W, H - BAR, { fill: DIM, stroke: "none", container: true, name: "page" })
    const dx = (WEB_W - dialogW) / 2
    const top = BAR + 60
    scene.rect(c.id("dialog"), dx, top, dialogW, 56 + body + 28, { fill: WHITE, stroke: "none", radius: 8, container: true, name: spec.title })
    const title = fit(spec.title, 20, dialogW - 56, true)
    if (title) scene.text(c.id("title"), dx + 28, top + 40, title, { size: 20, bold: true, anchor: "start", color: TEXT })
    drawBlocks(c, spec.blocks, { x: dx + 28, w: dialogW - 56 }, top + 56, Math.min(cols, 2))
    return
  }

  scene.rect(c.id("header"), 0, BAR, WEB_W, 64, { fill: pal.primary, stroke: "none", container: true, name: "header" })
  const brand = fit(input.systemName, 22, WEB_W * 0.4, true)
  if (brand) scene.text(c.id("brand"), WEB_PAD, BAR + 32, brand, { size: 22, bold: true, anchor: "start", baseline: "central", color: pal.onPrimary })
  let right = WEB_W - WEB_PAD
  const navLimit = WEB_PAD + textWidth(brand, 22, true) + 40
  for (const [i, item] of [...(spec.nav ?? [])].reverse().entries()) {
    const w = textWidth(item, 15)
    if (right - w < navLimit) break
    scene.text(c.id(`nav-${i}`), right, BAR + 32, item, { size: 15, anchor: "end", baseline: "central", color: pal.onPrimary })
    right -= w + 28
  }
  let y = BAR + 64
  if (spec.tabs?.length) y = drawTabs(c, spec.tabs, 0, y, WEB_W, false)
  y += 36
  const title = fit(spec.title, 26, contentW, true)
  if (title) scene.text(c.id("title"), WEB_PAD, y + 26, title, { size: 26, bold: true, anchor: "start", color: TEXT })
  drawBlocks(c, spec.blocks, { x: WEB_PAD, w: contentW }, y + 50, cols)
}

// ─── mobile ──────────────────────────────────────────────────────

const renderMobile = (scene: Scene, input: MockupInput, pal: MockupPalette): void => {
  const { spec } = input
  const popup = spec.popup ?? false
  const nav = (spec.nav ?? []).slice(0, 5)
  const W = MOBILE_W
  const ox = FRAME
  const oy = FRAME
  const area: Area = popup ? { x: ox + 40, w: W - 80 } : { x: ox + MOBILE_PAD, w: W - MOBILE_PAD * 2 }
  const body = blocksHeight(spec, pal, true, area.w, 1)
  const top = popup ? 140 : 46 + 56 + (spec.tabs?.length ? 44 : 0) + 28 + 42
  const H = Math.max(top + body + (popup ? 28 + 40 : 40) + (nav.length && !popup ? 56 : 0) + 40, MOBILE_MIN_H)
  const c = blockContext(scene, pal, true)

  scene.rect(c.id("device"), 0, 0, W + FRAME * 2, H + FRAME * 2, { fill: DEVICE, stroke: "none", radius: 52, container: true, name: "phone" })
  scene.rect(c.id("screen"), ox, oy, W, H, { fill: popup ? DIM : WHITE, stroke: "none", radius: 40, container: true, name: "screen" })
  scene.text(c.id("clock"), ox + 28, oy + 30, "9:41", { size: 14, bold: true, anchor: "start", color: TEXT })
  scene.rect(c.id("notch"), ox + W / 2 - 55, oy + 12, 110, 26, { fill: DEVICE, stroke: "none", radius: 13 })
  ;[7, 10, 13].forEach((h, i) => scene.rect(c.id(`signal-${i}`), ox + W - 92 + i * 6, oy + 31 - h, 4, h, { fill: TEXT, stroke: "none" }))
  scene.rect(c.id("battery"), ox + W - 62, oy + 19, 24, 12, { fill: WHITE, stroke: TEXT, strokeWidth: 1, radius: 3 })
  scene.rect(c.id("battery-level"), ox + W - 60, oy + 21, 17, 8, { fill: TEXT, stroke: "none", radius: 1 })

  if (popup) {
    scene.rect(c.id("dialog"), ox + 20, oy + top - 56, W - 40, 56 + body + 28, { fill: WHITE, stroke: "none", radius: 12, container: true, name: spec.title })
    const title = fit(spec.title, 18, W - 80, true)
    if (title) scene.text(c.id("title"), ox + 40, oy + top - 20, title, { size: 18, bold: true, anchor: "start", color: TEXT })
    drawBlocks(c, spec.blocks, { x: area.x, w: area.w }, oy + top, 1)
  } else {
    const bar = scene.rect(c.id("appbar"), ox, oy + 46, W, 56, { fill: pal.primary, stroke: "none", container: true, name: "app bar" })
    if (spec.back) scene.decoration(c.id("back"), bar, [[ox + 28, oy + 46 + 18], [ox + 19, oy + 46 + 28], [ox + 28, oy + 46 + 38]], { stroke: pal.onPrimary, strokeWidth: 2.5 })
    const name = fit(input.screenName, 18, W - 120, true)
    if (name) scene.text(c.id("appbar-t"), ox + W / 2, oy + 46 + 28, name, { size: 18, bold: true, baseline: "central", color: pal.onPrimary })
    let y = oy + 46 + 56
    if (spec.tabs?.length) y = drawTabs(c, spec.tabs, ox, y, W, true)
    y += 28
    const title = fit(spec.title, 22, area.w, true)
    if (title) scene.text(c.id("title"), area.x, y + 22, title, { size: 22, bold: true, anchor: "start", color: TEXT })
    drawBlocks(c, spec.blocks, area, y + 42, 1)
    if (nav.length) {
      // trên vùng bo góc dưới (bán kính 40) ⇒ góc thanh tab không lòi ra ngoài màn
      const navTop = oy + H - 40 - 56
      scene.rect(c.id("tabbar"), ox, navTop, W, 56, { fill: WHITE, stroke: "none", container: true, name: "tab bar" })
      scene.rect(c.id("tabbar-hr"), ox, navTop, W, 1, { fill: LINE, stroke: "none" })
      const seg = W / nav.length
      const active = nav.findIndex((n) => spec.title.toLowerCase().includes(n.toLowerCase()) || n.toLowerCase().includes(spec.title.toLowerCase()))
      nav.forEach((item, i) => {
        const cx = ox + seg * i + seg / 2
        const tint = i === active ? pal.accent : MUTED
        scene.rect(c.id(`tabbar-i${i}`), cx - 9, navTop + 9, 18, 18, { fill: WHITE, stroke: tint, strokeWidth: 1.5, radius: 4 })
        const text = fit(item, 12, seg - 8, i === active)
        if (text) scene.text(c.id(`tabbar-${i}`), cx, navTop + 42, text, { size: 12, bold: i === active, baseline: "central", color: tint })
      })
    }
  }
  scene.rect(c.id("home"), ox + W / 2 - 67, oy + H - 14, 134, 5, { fill: DEVICE, stroke: "none", radius: 3 })
}

// ─── metadata ────────────────────────────────────────────────────

interface SpecRecord {
  v: 1
  spec: ScreenSpec
  content_hash: string
  mode: ScreenMockupMode
  allowed: ScreenPlatform[]
  platform: ScreenPlatform
}

/** Mockup của một nền tảng: `Scene` (để kiểm bố cục) + markup kèm metadata spec. */
export const renderScreenMockup = (input: MockupInput): Scene => {
  const scene = new Scene()
  const pal = paletteOf(input.theme.primaryColor)
  if (input.platform === "mobile") renderMobile(scene, input, pal)
  else renderWeb(scene, input, pal)
  const record: SpecRecord = { v: 1, spec: input.spec, content_hash: input.contentHash, mode: input.mode, allowed: [...input.allowedPlatforms], platform: input.platform }
  scene.metadata(SCREEN_SPEC_METADATA_ID, JSON.stringify(record))
  return scene
}

/** Lề trắng quanh mockup: trang xem bo góc ảnh và .docx đặt ảnh sát chữ — khung trình duyệt / điện thoại không bị xén góc. */
export const MOCKUP_MARGIN = 12

const unescapeXml = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")

const METADATA = new RegExp(`<metadata id="${SCREEN_SPEC_METADATA_ID}">([^<]*)</metadata>`)

/** Spec đã lưu trong SVG mockup (nguồn `diagrams[].source`). Không có / hỏng ⇒ null. */
export interface StoredScreenSpec {
  spec: ScreenSpec
  contentHash: string
  mode: ScreenMockupMode
  allowed: ScreenPlatform[]
  /** Nền tảng của hình này. */
  platform: ScreenPlatform
}

export const screenSpecOf = (svg: string): StoredScreenSpec | null => {
  const raw = METADATA.exec(svg)?.[1]
  if (raw === undefined) return null
  try {
    const record = JSON.parse(unescapeXml(raw)) as Partial<SpecRecord>
    const spec = parseScreenSpec(record.spec)
    if (!spec || typeof record.content_hash !== "string" || !(SCREEN_MOCKUP_MODES as readonly unknown[]).includes(record.mode)) return null
    const allowed = SCREEN_PLATFORMS.filter((p) => Array.isArray(record.allowed) && record.allowed.includes(p))
    return { spec, contentHash: record.content_hash, mode: record.mode as ScreenMockupMode, allowed: allowed.length > 0 ? allowed : [...spec.platforms], platform: record.platform === "mobile" ? "mobile" : "web" }
  } catch {
    return null
  }
}
