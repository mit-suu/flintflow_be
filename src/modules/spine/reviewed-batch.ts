/**
 * FLF-318: lô thêm use case (FLF-311) người dùng đã duyệt qua bản xem trước không được bắt duyệt lại lần hai.
 *
 * Lô thêm use case tự soạn luôn phần kéo theo (chức năng, màn, luồng, quyền, thông báo) và người dùng đã thấy chúng ở bản
 * xem trước; nhưng change của lô mang `step_id = null` nên mọi section nó chạm (và lượt vẽ lại sơ đồ ngay sau) thành
 * `stale` — tới S-9 là cờ đỏ `section_stale_at_baseline` chặn baseline, dù không có gì lệch.
 *
 * Chỉ áp cho lô **trọn gói**: thêm phần tử mới (field của chính phần tử mới, nối thêm `flow_to`), hoặc xoá trọn phần tử
 * (luật 3g — xoá use case kéo theo chức năng, màn, thông báo chỉ thuộc nó) cùng các tham chiếu tới chúng mà cascade gỡ.
 * Lô có sửa nội dung phần tử còn lại (văn xuôi cũ có thể còn tên cũ) giữ luật "No auto-propagation" — section phụ thuộc
 * vẫn `stale`.
 * Hàm thuần: caller ghi `steps[id=…].accepted_at` qua `applyTransaction`.
 */

import { stepsOf } from "./section-registry.js"
import { computeSectionStates } from "./section-status.js"
import type { Op } from "./op.types.js"
import type { Change, Spine } from "./spine.types.js"

type BatchChange = Pick<Change, "op" | "path" | "before" | "value">
type StateChange = Pick<Change, "seq" | "path" | "before" | "value" | "step_id">

const ELEMENT = /^(\w+)\[id=([^\]]+)\]/
const FLOW_TO = /^screens\[id=[^\]]+\]\.flow_to(\[\])?$/

const idsOf = (spine: Spine, collection: string): Set<string> => {
  const list = (spine as unknown as Record<string, unknown>)[collection]
  return new Set(Array.isArray(list) ? list.flatMap((el) => (el && typeof el === "object" && typeof (el as { id?: unknown }).id === "string" ? [(el as { id: string }).id] : [])) : [])
}

/** `flow_to` mới giữ đủ cạnh cũ (chỉ nối thêm). */
const onlyAddsEdges = (c: BatchChange): boolean => {
  if (c.op === "add") return true
  if (c.op !== "set" || !Array.isArray(c.value)) return false
  const after = new Set((c.value as unknown[]).map(String))
  return (Array.isArray(c.before) ? (c.before as unknown[]) : []).every((v) => after.has(String(v)))
}

/** Id của mọi phần tử có trong `from` mà không còn trong `to` (mọi mảng gốc có `id`). */
const goneIds = (from: Spine, to: Spine): Set<string> => {
  const out = new Set<string>()
  for (const [key, value] of Object.entries(from)) {
    if (!Array.isArray(value)) continue
    const left = idsOf(to, key)
    for (const id of idsOf(from, key)) if (!left.has(id)) out.add(id)
  }
  return out
}

/**
 * Change cascade gỡ tham chiếu tới phần tử đã xoá: bỏ khỏi mảng (`…includes[=UC26]`, `flow_to`, `function_ids`) hoặc
 * đặt `null` (`primary_function_id`) — không đổi nội dung người đọc ngoài việc mất phần tử đã xoá.
 */
const onlyDropsRemoved = (c: BatchChange, removed: ReadonlySet<string>): boolean => {
  if (c.op === "remove") return typeof c.before === "string" && removed.has(c.before)
  if (c.op !== "set") return false
  if (c.value === null) return typeof c.before === "string" && removed.has(c.before)
  if (!Array.isArray(c.value) || !Array.isArray(c.before)) return false
  const after = (c.value as unknown[]).map(String)
  const before = (c.before as unknown[]).map(String)
  return after.every((v) => before.includes(v)) && before.filter((v) => !after.includes(v)).every((v) => removed.has(v))
}

/**
 * Lô trọn gói: mọi change chạm phần tử mới thêm trong lô hoặc phần tử bị xoá trọn trong lô, chỉ nối thêm cạnh `flow_to` của
 * màn có sẵn, hoặc chỉ gỡ tham chiếu tới phần tử đã xoá.
 */
export const isSelfContainedBatch = (before: Spine, after: Spine, changes: readonly BatchChange[]): boolean => {
  if (changes.length === 0) return false
  const added = goneIds(after, before)
  const removed = goneIds(before, after)
  return changes.every((c) => {
    const m = ELEMENT.exec(c.path)
    if (m && (added.has(m[2]) || removed.has(m[2]))) return true
    if (FLOW_TO.test(c.path) && onlyAddsEdges(c)) return true
    return onlyDropsRemoved(c, removed)
  })
}

/**
 * Op ghi lại `accepted_at` cho step sở hữu các section **mới** thành `stale` vì lô vừa duyệt (+ lượt vẽ lại đi kèm):
 * `beforeChanges` = change trước lô, `afterChanges` = mọi change tới giờ. Section đã stale từ trước giữ nguyên.
 */
export const reacceptOps = (
  before: Spine,
  beforeChanges: readonly StateChange[],
  after: Spine,
  afterChanges: readonly StateChange[],
  at: string
): Op[] => {
  const wasStale = new Set(computeSectionStates(before, [...beforeChanges]).filter((s) => s.status === "stale").map((s) => s.id))
  const accepted = new Set(after.steps.filter((s) => s.status === "accepted").map((s) => s.id))
  // Step còn sở hữu section đã stale từ trước ⇒ không ghi lại (ghi sẽ gỡ luôn chỗ cần hoà giải đó)
  const keep = new Set([...wasStale].flatMap((id) => stepsOf(id, after)))
  const steps = new Set<string>()
  for (const s of computeSectionStates(after, [...afterChanges])) {
    if (s.status !== "stale" || wasStale.has(s.id)) continue
    for (const id of stepsOf(s.id, after)) if (accepted.has(id) && !keep.has(id)) steps.add(id)
  }
  return [...steps].map((id) => ({ op: "set" as const, path: `steps[id=${id}].accepted_at`, value: at }))
}
