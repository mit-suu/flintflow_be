/**
 * Tóm tắt trực tiếp của I-4 cho màn đọc file: mục nào đang được AI đọc và mỗi mục đã tìm thấy gì. Hàm thuần, chỉ trả số đếm
 * + tên ngắn (tối đa 3) để poll 2 giây vẫn nhỏ — không gửi `value` đầy đủ.
 */

import type { IExtractionDraft } from "./extraction-draft.model.js"
import type { EntityItem } from "./extracted-entities.js"
import { parseFieldPath } from "./extracted-entities.js"

/** Phần tử đã tìm thấy theo loại: `entity` là khoá loại (`use_cases`, `actors`…; ảnh sơ đồ đọc được = `diagram`). */
export interface FoundGroup {
  entity: string
  count: number
  names: string[]
}

/** Số tên tối đa mỗi loại và độ dài tối đa một tên. */
export const FOUND_MAX_NAMES = 3
const NAME_MAX_CHARS = 80

/** Đang đọc mà quá ngưỡng này không có tiến triển ⇒ coi là dấu cũ của lần chạy đã chết (server khởi động lại). */
export const READING_STALE_MS = 15 * 60 * 1000

/** Loại ảnh coi là "sơ đồ đã đọc được" (kind khác = không đọc / lỗi / chưa đọc được). */
const NOT_A_DIAGRAM = new Set(["other", "unsupported", "unavailable", "failed"])

const DIAGRAM_ENTITY = "diagram"

type DraftLike = Pick<IExtractionDraft, "status" | "fields" | "partial" | "diagram_images">

const clipName = (s: string): string => (s.length > NAME_MAX_CHARS ? `${s.slice(0, NAME_MAX_CHARS - 1)}…` : s)

const nameOf = (value: Record<string, unknown>, fallback: string | null): string | null => {
  for (const k of ["name", "title", "term"]) {
    const v = value[k]
    if (typeof v === "string" && v.trim()) return clipName(v.trim())
  }
  return fallback?.trim() ? clipName(fallback.trim()) : null
}

/** Gom phần tử theo loại; phần tử cùng (loại, khoá) chỉ đếm một lần. `project` là thông tin chung, không phải phần tử tìm thấy. */
class FoundCollector {
  private readonly groups = new Map<string, FoundGroup>()
  private readonly seen = new Set<string>()

  add(entity: string, key: string | null, name: string | null): void {
    if (entity === "project") return
    if (key !== null) {
      const k = `${entity}|${key}`
      if (this.seen.has(k)) return
      this.seen.add(k)
    }
    const g = this.groups.get(entity) ?? { entity, count: 0, names: [] }
    g.count++
    if (name && g.names.length < FOUND_MAX_NAMES && !g.names.includes(name)) g.names.push(name)
    this.groups.set(entity, g)
  }

  result(): FoundGroup[] {
    return [...this.groups.values()]
  }
}

const addItem = (c: FoundCollector, it: Pick<EntityItem, "entity" | "id" | "value"> | { entity: string; key: string | null; value: Record<string, unknown> }): void => {
  const key = "key" in it ? it.key : it.id
  c.add(it.entity, key, nameOf(it.value, key))
}

/** Section đã ghép: gom từ `fields` (path `use_cases[id=UC-01].name`) và ảnh sơ đồ đọc được. */
const foundFromFields = (c: FoundCollector, draft: DraftLike): void => {
  const byElement = new Map<string, { entity: string; id: string; value: Record<string, unknown> }>()
  for (const f of draft.fields) {
    const p = parseFieldPath(f.path)
    if (!p || p.id === null) continue
    const k = `${p.entity}|${p.id}`
    const el = byElement.get(k) ?? { entity: p.entity, id: p.id, value: {} }
    el.value[p.field] = f.edited_value ?? f.value
    byElement.set(k, el)
  }
  for (const el of byElement.values()) addItem(c, el)
}

/** Section đã đọc (một phần) nhưng chưa ghép: gom từ output thô của các lượt AI đã lưu ở `partial`. */
const foundFromPartial = (c: FoundCollector, partial: NonNullable<DraftLike["partial"]>): void => {
  for (const it of partial.items ?? []) addItem(c, it)
  for (const step of partial.raw_steps ?? []) {
    if (step.kind === "image") {
      if (step.status === "read" && step.data) {
        if (!NOT_A_DIAGRAM.has(step.data.diagram_kind)) c.add(DIAGRAM_ENTITY, `img:${step.block_id}`, step.data.diagram_kind)
        for (const it of step.data.items) addItem(c, it)
      }
    } else {
      for (const it of step.data.items) addItem(c, it)
    }
  }
}

/** "Tìm thấy" của một section — rỗng khi chưa đọc gì. */
export const summarizeFound = (draft: DraftLike): FoundGroup[] => {
  const c = new FoundCollector()
  if (draft.status === "done" || draft.fields.length > 0) {
    foundFromFields(c, draft)
    for (const img of draft.diagram_images ?? []) if (!NOT_A_DIAGRAM.has(img.kind)) c.add(DIAGRAM_ENTITY, `img:${img.block_id}`, img.kind)
  } else if (draft.partial) {
    foundFromPartial(c, draft.partial)
  }
  return c.result()
}

/**
 * Mục có đang được AI đọc không: có dấu `reading_since`, lần import còn chạy (`active`: `extracting`, không dừng) và dấu chưa
 * quá cũ. Dấu cũ của lần chạy đã chết ⇒ không đọc.
 */
export const isReading = (readingSince: Date | null | undefined, active: boolean, now: number = Date.now()): boolean =>
  active && !!readingSince && now - new Date(readingSince).getTime() < READING_STALE_MS
