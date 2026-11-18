/**
 * P12 — business-flow §3.2 "Hai người sửa cùng lúc", phần **dùng chung** cho sửa qua chat trước baseline (BR-05) và change
 * request (C-6): đề xuất chưa xác nhận không có giá trị kiểm tra; lúc xác nhận Code kiểm lại từng chỗ trên nội dung **hiện
 * tại**, không theo `spine_version` cả tài liệu (version chỉ nói "có gì đó vừa ghi", không nói ghi vào đâu):
 *
 * | Trong lúc chờ, người khác đã…            | Kết quả                                                         |
 * | không đụng chỗ này                       | `unchanged` — ghi như thường                                    |
 * | sửa đúng như đề xuất                     | `same` — không ghi lại, báo "đã được <người> sửa giống"          |
 * | sửa phần khác trong cùng chỗ             | `rebased` — ghép phần người khác sửa + phần đề xuất đổi rồi ghi  |
 * | sửa đúng chữ mà đề xuất định đổi         | `conflict` — không ghi, màn so sánh 3 cột                        |
 *
 * Chỗ khác làm gãy tham chiếu: lô đã ghép được chạy khô (`planTransaction`) trên Spine hiện tại ⇒ bất biến vỡ là từ chối
 * trước khi ghi (cờ đỏ). Hàm thuần — không DB.
 */

import { isDeepStrictEqual } from "node:util"

type Row = Record<string, unknown>
const isRow = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v)
const eq = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b)

export type MergeResult = { ok: true; value: unknown } | { ok: false; at: string[] }

const join = (at: string, key: string): string => (at ? `${at}.${key}` : key)

/** Mảng phần tử có `id` chuỗi không trùng — ghép theo id thay vì theo vị trí. */
const keyedRows = (list: unknown[]): Map<string, Row> | null => {
  const out = new Map<string, Row>()
  for (const el of list) {
    if (!isRow(el) || typeof el.id !== "string" || out.has(el.id)) return null
    out.set(el.id, el)
  }
  return out
}

const mergeById = (base: Map<string, Row>, mine: Map<string, Row>, theirs: Map<string, Row>, at: string): MergeResult => {
  const value: unknown[] = []
  const conflicts: string[] = []
  for (const [id, t] of theirs) {
    const b = base.get(id)
    const m = mine.get(id)
    if (m === undefined) {
      // Mình xoá phần tử này: chỉ xoá được khi người kia không sửa nó
      if (b === undefined) value.push(t)
      else if (!eq(b, t)) conflicts.push(`${at}[id=${id}]`)
      continue
    }
    const r = merge3(b, m, t, `${at}[id=${id}]`)
    if (r.ok) {
      if (r.value !== undefined) value.push(r.value)
    } else conflicts.push(...r.at)
  }
  for (const [id, m] of mine) {
    if (theirs.has(id)) continue
    const b = base.get(id)
    // Người kia xoá phần tử mình sửa ⇒ đụng nhau; mình thêm mới ⇒ thêm vào cuối
    if (b === undefined) value.push(m)
    else if (!eq(b, m)) conflicts.push(`${at}[id=${id}]`)
  }
  return conflicts.length ? { ok: false, at: conflicts } : { ok: true, value }
}

/**
 * Ghép ba chiều: `base` = lúc AI soạn, `mine` = đề xuất, `theirs` = hiện tại. Hai bên đổi phần khác nhau (field khác,
 * dòng khác của mảng) ⇒ ghép; đổi cùng một chữ thành hai giá trị khác nhau ⇒ `at` = các chỗ đụng nhau.
 */
export const merge3 = (base: unknown, mine: unknown, theirs: unknown, at = ""): MergeResult => {
  if (eq(mine, theirs)) return { ok: true, value: mine }
  if (eq(base, mine)) return { ok: true, value: theirs }
  if (eq(base, theirs)) return { ok: true, value: mine }
  if (isRow(base) && isRow(mine) && isRow(theirs)) {
    const value: Row = {}
    const conflicts: string[] = []
    for (const key of new Set([...Object.keys(theirs), ...Object.keys(mine), ...Object.keys(base)])) {
      const r = merge3(base[key], mine[key], theirs[key], join(at, key))
      if (!r.ok) conflicts.push(...r.at)
      else if (r.value !== undefined) value[key] = r.value
    }
    return conflicts.length ? { ok: false, at: conflicts } : { ok: true, value }
  }
  if (Array.isArray(base) && Array.isArray(mine) && Array.isArray(theirs)) {
    const [b, m, t] = [keyedRows(base), keyedRows(mine), keyedRows(theirs)]
    if (b && m && t && (b.size || m.size || t.size)) return mergeById(b, m, t, at)
    if (base.length === mine.length && base.length === theirs.length) {
      const value: unknown[] = []
      const conflicts: string[] = []
      base.forEach((el, i) => {
        const r = merge3(el, mine[i], theirs[i], `${at}[${i}]`)
        if (r.ok) value.push(r.value)
        else conflicts.push(...r.at)
      })
      return conflicts.length ? { ok: false, at: conflicts } : { ok: true, value }
    }
  }
  return { ok: false, at: [at] }
}

export type PlaceOutcome =
  | { kind: "unchanged" }
  | { kind: "same" }
  | { kind: "rebased"; value: unknown }
  | { kind: "conflict"; at: string[] }

/** Phân loại một chỗ theo bảng 4 trường hợp — `before` lúc AI soạn, `proposed` đề xuất, `current` hiện tại. */
export const classifyPlace = (before: unknown, proposed: unknown, current: unknown): PlaceOutcome => {
  if (eq(current, before)) return { kind: "unchanged" }
  if (eq(current, proposed)) return { kind: "same" }
  const merged = merge3(before, proposed, current)
  return merged.ok ? { kind: "rebased", value: merged.value } : { kind: "conflict", at: merged.at }
}

/** Field cấp một (`description`, `goals`) của các chỗ đụng nhau — để màn so sánh chỉ hiện đúng phần đó. */
export const conflictFields = (at: readonly string[]): string[] => [...new Set(at.map((p) => /^[^.[]*/.exec(p)?.[0] ?? "").filter(Boolean))]

/** Giá trị đọc được cho người: chuỗi giữ nguyên, mảng chuỗi mỗi dòng một ý, còn lại JSON gọn. */
export const readableValue = (value: unknown): string => {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.map((v) => `- ${v}`).join("\n")
  return JSON.stringify(value, null, 2)
}

// ─── chỗ (phần tử Spine) mà một lô op chạm ─────────────────────────

const ELEMENT = /^(\w+)\[id=([^\]]+)\]/

/** `use_cases[id=UC-01].name` ⇒ `use_cases[id=UC-01]`; `project.goals` ⇒ `project`; phần tử chưa có id thật / còn lại ⇒ null. */
export const placeOfPath = (path: string): string | null => {
  if (path === "project" || path.startsWith("project.")) return "project"
  const m = ELEMENT.exec(path)
  if (!m || m[2].startsWith("$")) return null
  return m[0]
}

/** Giá trị hiện tại của chỗ — `undefined` nếu phần tử không còn. */
export const placeValue = (spine: object, place: string): unknown => {
  const doc = spine as Row
  if (place === "project") return doc.project
  const m = ELEMENT.exec(place)
  if (!m) return undefined
  const list = doc[m[1]]
  return Array.isArray(list) ? list.find((el) => isRow(el) && String(el.id) === m[2]) : undefined
}

/** Tên đọc được của phần tử (không mã nội bộ); `project` / không tên ⇒ "". */
export const placeLabel = (value: unknown): string => {
  if (!isRow(value)) return ""
  for (const key of ["name", "term", "title", "heading", "statement", "text"]) {
    if (typeof value[key] === "string" && (value[key] as string).trim()) return (value[key] as string).trim().slice(0, 120)
  }
  return ""
}

/**
 * Lô đã ghép cho Spine hiện tại: chỗ `same` bỏ op, chỗ `rebased` thay op của nó bằng `set` từng field lệch giữa hiện tại và
 * bản ghép (giữ `changes[]` theo field ⇒ mục đọc field khác không bị làm cũ oan), chỗ khác giữ op gốc.
 */
export const rebaseOps = <O extends { op: string; path: string; reason?: string }>(
  ops: readonly O[],
  current: object,
  outcomes: ReadonlyMap<string, PlaceOutcome>
): O[] => {
  const out: O[] = []
  const emitted = new Set<string>()
  for (const op of ops) {
    const place = placeOfPath(op.path)
    const outcome = place ? outcomes.get(place) : undefined
    if (!place || !outcome || outcome.kind === "unchanged") {
      out.push(op)
      continue
    }
    if (outcome.kind !== "rebased" || emitted.has(place)) continue
    emitted.add(place)
    const now = placeValue(current, place)
    const merged = outcome.value
    const reason = op.reason ? { reason: op.reason } : {}
    if (isRow(now) && isRow(merged) && Object.keys(now).every((k) => k in merged)) {
      for (const key of Object.keys(merged)) {
        if (!eq(now[key], merged[key])) out.push({ op: "set", path: `${place}.${key}`, value: merged[key], ...reason } as unknown as O)
      }
    } else out.push({ op: "set", path: place, value: merged, ...reason } as unknown as O)
  }
  return out
}
