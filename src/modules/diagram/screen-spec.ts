/**
 * ScreenSpec (FLF-410): hợp đồng giữa model (skill `renderer/screen-layout`) và renderer mockup SVG
 * (`renderers/screen-mockup.ts`). Spec chỉ mô tả NỘI DUNG màn — không màu, không pixel, không cách hiển thị theo nền
 * tảng; màu / domain / nền tảng là theme của dự án (`shared/diagram/screen-theme.ts`). Đổi theme ⇒ vẽ lại từ spec đã lưu,
 * không gọi model.
 *
 * Model trả chuỗi JSON trong trường `puml` của `render_fix` (hợp đồng AI không đổi). Chuỗi là envelope
 * `{ spec, screen_images?, primary_color? }`; spec sai cấu trúc ⇒ `null` ⇒ bảng Function | Description.
 * Chữ quá dài bị cắt (`...`) thay vì làm hỏng cả spec — layout không vỡ, model không phải gọi lại.
 */

import { z } from "zod"
import { HEX_COLOR, SCREEN_PLATFORMS, type ScreenPlatform } from "../../shared/diagram/screen-theme.js"

export const LABEL_MAX = 60
export const CELL_MAX = 40
export const NAV_MAX = 24
export const MAX_BLOCKS = 20

/** Chuỗi một dòng, cắt về `max` ký tự (đuôi `...`). */
const text = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(/\s+/g, " ").trim())
    .transform((s) => (s.length > max ? `${s.slice(0, max - 3).trimEnd()}...` : s))
/**
 * Model hay ghi số / boolean dạng chuỗi (`"qty": "1"`, `"primary": "true"`) — lệch kiểu vô hại, không đáng loại cả spec.
 * Chuỗi số nguyên ⇒ số; `"true"` / `"false"` ⇒ boolean. Chuỗi khác (`"two"`) giữ nguyên để zod báo sai.
 */
const numeric = (v: unknown): unknown => (typeof v === "string" && /^ *-?[0-9]+ *$/.test(v) ? Number(v) : v)
const boolish = (v: unknown): unknown => (v === "true" ? true : v === "false" ? false : v)
const int = (min: number, max: number) => z.preprocess(numeric, z.number().int().min(min).max(max))
const flag = () => z.preprocess(boolish, z.boolean())

const label = text(LABEL_MAX)
const cell = text(CELL_MAX)

const fieldKind = z.enum(["text", "password", "date", "select", "textarea"])

const blockSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("fields"),
    items: z.array(z.strictObject({ label, required: flag().optional(), kind: fieldKind.optional(), placeholder: label.optional() })).min(1).max(12)
  }),
  z.strictObject({ type: z.literal("checkbox"), label: label.optional(), options: z.array(label).max(6).optional() }),
  z.strictObject({ type: z.literal("radio"), label: label.optional(), options: z.array(label).min(1).max(6) }),
  z.strictObject({ type: z.literal("buttons"), items: z.array(z.strictObject({ label: cell, primary: flag().optional() })).min(1).max(4) }),
  z.strictObject({ type: z.literal("link"), text: label }),
  z.strictObject({ type: z.literal("text"), text: text(120), strong: flag().optional() }),
  z.strictObject({ type: z.literal("search"), placeholder: label, button: cell.optional() }),
  z.strictObject({ type: z.literal("inline"), placeholder: label, button: cell }),
  z.strictObject({
    type: z.literal("items"),
    items: z.array(z.strictObject({ name: label, meta: label.optional(), price: cell.optional(), qty: int(0, 999).optional() })).min(1).max(4)
  }),
  z.strictObject({ type: z.literal("table"), columns: z.array(cell).min(1).max(6), rows: z.array(z.array(cell).max(6)).max(5) }),
  z.strictObject({ type: z.literal("summary"), rows: z.array(z.tuple([label, cell, flag().optional()])).min(1).max(6) }),
  z.strictObject({ type: z.literal("image"), label })
])

export const screenSpecSchema = z.strictObject({
  title: label,
  path: text(LABEL_MAX).transform((p) => (p.startsWith("/") ? p : `/${p}`)),
  platforms: z.array(z.enum(SCREEN_PLATFORMS)).min(1),
  nav: z.array(text(NAV_MAX)).max(6).optional(),
  back: flag().optional(),
  columns: z.preprocess(numeric, z.union([z.literal(1), z.literal(2), z.literal(3)])).optional(),
  popup: flag().optional(),
  tabs: z.array(text(NAV_MAX)).max(6).optional(),
  blocks: z.array(blockSchema).min(1).max(MAX_BLOCKS)
})

export type ScreenSpec = z.output<typeof screenSpecSchema>
export type ScreenBlock = ScreenSpec["blocks"][number]

export interface ScreenEnvelope {
  spec: ScreenSpec
  /** Index các ảnh gốc là ảnh màn hình (chỉ khi input có `original_images`); model không trả ⇒ null. */
  screenImages: number[] | null
  /** Màu chủ đạo của ảnh gốc (kiểu `original`); sai hex / không có ⇒ null. */
  primaryColor: string | null
}

/** Bỏ code fence ```json nếu model bọc. */
const unfence = (raw: string): string => {
  const t = raw.trim()
  const m = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(t)
  return m ? m[1].trim() : t
}

/**
 * Spec đã kiểm; `platforms` cắt về `allowed` (rỗng sau khi cắt ⇒ toàn bộ `allowed`). Sai cấu trúc ⇒ null.
 * `allowed` thiếu ⇒ giữ nguyên.
 */
export const parseScreenSpec = (value: unknown, allowed?: readonly ScreenPlatform[]): ScreenSpec | null => {
  const parsed = screenSpecSchema.safeParse(value)
  if (!parsed.success) return null
  const spec = parsed.data
  if (!allowed || allowed.length === 0) return spec
  const kept = SCREEN_PLATFORMS.filter((p) => spec.platforms.includes(p) && allowed.includes(p))
  return { ...spec, platforms: kept.length > 0 ? kept : SCREEN_PLATFORMS.filter((p) => allowed.includes(p)) }
}

/** Lỗi zod đọc được (cho lượt thử lại kèm lỗi). */
export const screenSpecErrors = (value: unknown): string[] => {
  const parsed = screenSpecSchema.safeParse(value)
  return parsed.success ? [] : parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
}

/** Chuỗi `puml` của model ⇒ JSON (chịu code fence). Không parse được ⇒ undefined. */
export const parseEnvelopeJson = (raw: string): unknown => {
  try {
    return JSON.parse(unfence(raw))
  } catch {
    return undefined
  }
}

/**
 * Envelope `{ spec, screen_images?, primary_color? }` của model. Chấp nhận cả spec trần (có `blocks`) phòng model bỏ vỏ.
 * Spec sai ⇒ null; `screen_images` / `primary_color` sai ⇒ null riêng field đó.
 */
export const parseScreenEnvelope = (raw: string, allowed?: readonly ScreenPlatform[]): ScreenEnvelope | null => {
  const json = parseEnvelopeJson(raw)
  if (typeof json !== "object" || json === null) return null
  const obj = json as Record<string, unknown>
  const specValue = "spec" in obj ? obj.spec : "blocks" in obj ? obj : undefined
  const spec = parseScreenSpec(specValue, allowed)
  if (!spec) return null
  const images = Array.isArray(obj.screen_images) && obj.screen_images.every((i) => Number.isInteger(i) && (i as number) >= 0) ? [...new Set(obj.screen_images as number[])] : null
  const color = typeof obj.primary_color === "string" && HEX_COLOR.test(obj.primary_color.trim()) ? obj.primary_color.trim().toUpperCase() : null
  return { spec, screenImages: images, primaryColor: color }
}

// ─── chữ hiển thị (dịch nhãn, mô tả Interface) ────────────────────

/** Áp `fn` lên mọi chữ hiển thị của spec theo thứ tự trên màn; giữ nguyên cấu trúc. */
export const mapSpecText = (spec: ScreenSpec, fn: (s: string) => string): ScreenSpec => {
  const opt = (s: string | undefined) => (s === undefined ? undefined : fn(s))
  const head = { title: fn(spec.title), nav: spec.nav?.map(fn), tabs: spec.tabs?.map(fn) }
  const blocks = spec.blocks.map((b): ScreenBlock => {
    switch (b.type) {
      case "fields":
        return { ...b, items: b.items.map((f) => ({ ...f, label: fn(f.label), placeholder: opt(f.placeholder) })) }
      case "checkbox":
        return { ...b, label: opt(b.label), options: b.options?.map(fn) }
      case "radio":
        return { ...b, label: opt(b.label), options: b.options.map(fn) }
      case "buttons":
        return { ...b, items: b.items.map((i) => ({ ...i, label: fn(i.label) })) }
      case "link":
      case "text":
        return { ...b, text: fn(b.text) }
      case "search":
        return { ...b, placeholder: fn(b.placeholder), button: opt(b.button) }
      case "inline":
        return { ...b, placeholder: fn(b.placeholder), button: fn(b.button) }
      case "items":
        return { ...b, items: b.items.map((i) => ({ ...i, name: fn(i.name), meta: opt(i.meta), price: opt(i.price) })) }
      case "table":
        return { ...b, columns: b.columns.map(fn), rows: b.rows.map((r) => r.map(fn)) }
      case "summary":
        return { ...b, rows: b.rows.map(([k, v, strong]): [string, string, boolean?] => (strong === undefined ? [fn(k), fn(v)] : [fn(k), fn(v), strong])) }
      case "image":
        return { ...b, label: fn(b.label) }
    }
  })
  return { ...spec, ...head, blocks }
}

/** Chữ hiển thị theo thứ tự trên màn, bỏ rỗng / trùng — đơn vị dịch nhãn mockup (FLF-265 N1). */
export const specLabels = (spec: ScreenSpec): string[] => {
  const seen: string[] = []
  mapSpecText(spec, (s) => {
    const t = s.trim()
    if (t && !seen.includes(t)) seen.push(t)
    return s
  })
  return seen
}
