/**
 * Id của phần tử CR thêm mới (FLF-307). Model tự đánh số khi `add` (`UC-91`, `SCR-84`) rất hay trùng id đã có — danh
 * sách trong prompt bị cắt, file upload xếp id không theo thứ tự — và C-5 trượt `duplicate_id`, AI làm lại, lại trùng.
 * Code đổi id trùng sang id chưa dùng (cùng khuôn với tài liệu) thay vì bắt AI làm lại. Hàm thuần — không DB.
 */

import { ID_FORMATS, formatFor, isPlaceholderId, nextIdIn } from "../spine/id-allocator.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeLocation } from "./change-location.model.js"

type Rec = Record<string, unknown>

const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v)

/** Mảng cấp gốc mà op `add` nhắm tới (`screens[]` ⇒ `screens`), chỉ với collection server đánh id. */
const addCollection = (op: unknown): string | null => {
  if (!isRecord(op) || op.op !== "add" || typeof op.path !== "string") return null
  const m = /^(\w+)\[\]$/.exec(op.path)
  return m && m[1] in ID_FORMATS ? m[1] : null
}

/** Thay giá trị chuỗi **trùng khớp cả chuỗi** với id cũ (không thay chuỗi con — "SCR-8" không đụng "SCR-84"). */
const remap = (value: unknown, mapping: ReadonlyMap<string, string>): unknown => {
  if (typeof value === "string") return mapping.get(value) ?? value
  if (Array.isArray(value)) return value.map((v) => remap(v, mapping))
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, mapping)]))
  return value
}

type IdLocation = Pick<IChangeLocation, "location_id" | "conclusion" | "proposal">

/**
 * Đổi id trùng trong các op `add` của CR (theo thứ tự vị trí): trùng phần tử có sẵn hoặc trùng phần tử vị trí trước của
 * cùng CR vừa thêm ⇒ id kế tiếp chưa dùng. Tham chiếu tới id cũ trong **op `add` khác** của CR đổi theo (phần tử mới
 * nhắc phần tử mới — model tưởng id đó còn trống); op `set`/`remove` giữ nguyên vì nhắm phần tử có sẵn.
 * Ghi đè `proposal.spine_ops` của vị trí bị đổi; trả các vị trí đó (caller tính lại `new_text` rồi lưu).
 */
export const reassignDuplicateIds = <L extends IdLocation>(spine: Spine, locations: readonly L[]): L[] => {
  const taken = new Map<string, Set<string>>()
  const takenIn = (collection: string): Set<string> => {
    let set = taken.get(collection)
    if (!set) {
      const list = (spine as unknown as Rec)[collection]
      set = new Set(Array.isArray(list) ? list.flatMap((el) => (isRecord(el) && typeof el.id === "string" ? [el.id] : [])) : [])
      taken.set(collection, set)
    }
    return set
  }

  const mapping = new Map<string, string>()
  const edits = locations.filter((l) => l.conclusion === "edit" && l.proposal?.spine_ops.length)
  const renamed = new Set<object>()
  for (const l of edits) {
    for (const op of l.proposal!.spine_ops) {
      const collection = addCollection(op)
      const value = collection ? (op as Rec).value : undefined
      if (!collection || !isRecord(value) || typeof value.id !== "string" || !value.id) continue
      let id: string = value.id
      if (isPlaceholderId(id)) continue
      const ids = takenIn(collection)
      if (ids.has(id)) {
        const fresh = nextIdIn([...ids], formatFor([...ids], ID_FORMATS[collection]))
        mapping.set(id, fresh)
        value.id = id = fresh
        renamed.add(value)
      }
      ids.add(id)
    }
  }
  if (!mapping.size) return []

  const changed: L[] = []
  for (const l of edits) {
    let touched = false
    const ops = l.proposal!.spine_ops.map((op) => {
      if (!addCollection(op) || !isRecord((op as Rec).value)) return op
      // `id` của chính phần tử không remap (phần tử khác có thể vừa được đổi *khỏi* id này); field khác (`flow_to`,
      // `screen_id`, `extends`…) nhắc phần tử mới khác thì đổi theo
      const { id, ...rest } = (op as Rec).value as Rec
      const next = remap(rest, mapping) as Rec
      if (!renamed.has((op as Rec).value as object) && JSON.stringify(next) === JSON.stringify(rest)) return op
      touched = true
      return { ...(op as Rec), value: { id, ...next } }
    })
    if (touched) {
      l.proposal!.spine_ops = ops
      changed.push(l)
    }
  }
  return changed
}
