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

import { isDeepStrictEqual } from "node:util"
import { legacyFlowEdge } from "./legacy-flow.js"
import { isRecord } from "./path-resolver.js"
import { sectionsOfPath, stepsOf } from "./section-registry.js"
import { computeSectionStates } from "./section-status.js"
import type { Op } from "./op.types.js"
import type { Change, Spine } from "./spine.types.js"

type BatchChange = Pick<Change, "op" | "path" | "before" | "value">
type StateChange = Pick<Change, "seq" | "path" | "before" | "value" | "step_id">

const ELEMENT = /^(\w+)\[id=([^\]]+)\]/
const FLOW_TO = /^screens\[id=[^\]]+\]\.flow_to(\[[^\]]*\])?$/

const idsOf = (spine: Spine, collection: string): Set<string> => {
  const list = (spine as unknown as Record<string, unknown>)[collection]
  return new Set(Array.isArray(list) ? list.flatMap((el) => (el && typeof el === "object" && typeof (el as { id?: unknown }).id === "string" ? [(el as { id: string }).id] : [])) : [])
}

/** Hai phần tử `flow_to` (cạnh hoặc chuỗi id của dữ liệu cũ) giống hệt nhau, kể cả trigger / guard. */
const sameEdge = (a: unknown, b: unknown): boolean => isDeepStrictEqual(legacyFlowEdge(a), legacyFlowEdge(b))

/** `flow_to` mới giữ nguyên mọi cạnh cũ (chỉ nối thêm): cạnh cũ đổi trigger / guard không phải nối thêm. */
const onlyAddsEdges = (c: BatchChange): boolean => {
  if (c.op === "add") return true
  if (c.op !== "set" || !Array.isArray(c.value)) return false
  const after = c.value as unknown[]
  return (Array.isArray(c.before) ? (c.before as unknown[]) : []).every((v) => after.some((a) => sameEdge(a, v)))
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
  // Cạnh `flow_to` bị gỡ có `before` là object { to, … }: màn đích là khoá
  const targetOf = (v: unknown): string | null => (typeof v === "string" ? v : isRecord(v) && typeof v.to === "string" ? v.to : null)
  const gone = (v: unknown): boolean => {
    const t = targetOf(v)
    return t !== null && removed.has(t)
  }
  if (c.op === "remove") return gone(c.before)
  if (c.op !== "set") return false
  if (c.value === null) return typeof c.before === "string" && removed.has(c.before)
  if (!Array.isArray(c.value) || !Array.isArray(c.before)) return false
  const after = c.value as unknown[]
  const before = c.before as unknown[]
  return after.every((a) => before.some((b) => sameEdge(a, b))) && before.filter((b) => !after.some((a) => sameEdge(a, b))).every(gone)
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
  at: string,
  /** Chỉ xét các section này (lô sửa use case: section mà lô ghi vào dữ liệu thuộc nó — `ownedSections`). */
  only?: ReadonlySet<string>
): Op[] => {
  const wasStale = new Set(computeSectionStates(before, [...beforeChanges]).filter((s) => s.status === "stale").map((s) => s.id))
  const accepted = new Set(after.steps.filter((s) => s.status === "accepted").map((s) => s.id))
  // Step còn sở hữu section đã stale từ trước ⇒ không ghi lại (ghi sẽ gỡ luôn chỗ cần hoà giải đó)
  const keep = new Set([...wasStale].flatMap((id) => stepsOf(id, after)))
  const steps = new Set<string>()
  for (const s of computeSectionStates(after, [...afterChanges])) {
    if (s.status !== "stale" || wasStale.has(s.id) || (only && !only.has(s.id))) continue
    for (const id of stepsOf(s.id, after)) if (accepted.has(id) && !keep.has(id)) steps.add(id)
  }
  return [...steps].map((id) => ({ op: "set" as const, path: `steps[id=${id}].accepted_at`, value: at }))
}

/**
 * Section mà các change này ghi vào dữ liệu **thuộc** nó (cột Sở hữu của bảng §4 — `sectionsOfPath(...).owner`), xét trên
 * cả Spine trước (phần tử đã xoá) lẫn sau (phần tử mới). Section chỉ đọc dữ liệu bị đổi không tính.
 */
export const ownedSections = (before: Spine, after: Spine, changes: readonly Pick<Change, "path">[]): Set<string> => {
  const out = new Set<string>()
  for (const c of changes) {
    for (const spine of [after, before]) {
      try {
        for (const id of sectionsOfPath(spine, c.path).owner) out.add(id)
      } catch {
        // path không phân giải trên Spine này (phần tử chỉ có ở bản kia) — bản còn lại lo
      }
    }
  }
  return out
}

