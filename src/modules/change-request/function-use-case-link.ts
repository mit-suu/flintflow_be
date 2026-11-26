/**
 * FLF-469 (lưới an toàn của luật 3i / 3j): CR thêm chức năng ⇒ chức năng mới phải thuộc một use case có sẵn; CR xoá chức
 * năng cuối cùng của một use case ⇒ use case đó bị xoá. Model làm sót thì code bù. Hàm thuần.
 */

import type { Op } from "../spine/op.types.js"
import type { Spine } from "../spine/spine.types.js"
import { emptiedUseCases, unlinkedNewFunctions } from "../spine/use-case-propagation.js"

export interface LinkFix {
  ops: Op[]
  notes: string[]
}

const onlyOne = <T extends { id: string }>(list: readonly T[]): T | null => (list.length === 1 ? list[0] : null)

/**
 * `add`: chức năng mới chưa thuộc use case nào ⇒ op gắn vào use case đoán được (cùng màn, rồi cùng tính năng; đúng một
 * use case mới chọn), không đoán được ⇒ chỉ ghi chú. `remove`: use case vừa hết chức năng ⇒ op xoá.
 */
export const linkFunctionsToUseCases = (spine: Spine, after: Spine, intent: "add" | "remove"): LinkFix => {
  const ops: Op[] = []
  const notes: string[] = []
  if (intent === "remove") {
    for (const uc of emptiedUseCases(spine, after)) {
      ops.push({ op: "remove", path: `use_cases[id=${uc.id}]`, reason: "Use case không còn chức năng nào" })
      notes.push(`Xoá use case "${uc.name}" vì không còn chức năng nào`)
    }
    return { ops, notes }
  }
  const pending = new Map<string, string[]>()
  for (const fn of unlinkedNewFunctions(spine, after)) {
    const full = after.functions.find((f) => f.id === fn.id)
    const others = (key: "screen_id" | "feature_id") => {
      const value = full?.[key]
      if (!value) return []
      const sibling = new Set(after.functions.filter((f) => f.id !== fn.id && f[key] === value).map((f) => f.id))
      return after.use_cases.filter((u) => u.function_ids.some((id) => sibling.has(id)))
    }
    const target = onlyOne(others("screen_id")) ?? (others("screen_id").length === 0 ? onlyOne(others("feature_id")) : null)
    if (!target) {
      notes.push(`Chức năng "${fn.name}" chưa gắn use case nào - chọn use case khi duyệt`)
      continue
    }
    pending.set(target.id, [...(pending.get(target.id) ?? []), fn.id])
    notes.push(`Gắn chức năng "${fn.name}" vào use case "${target.name}" (đoán theo màn / tính năng)`)
  }
  for (const [ucId, fnIds] of pending) {
    const uc = after.use_cases.find((u) => u.id === ucId)!
    ops.push({ op: "set", path: `use_cases[id=${ucId}].function_ids`, value: [...uc.function_ids, ...fnIds], reason: "Gắn chức năng mới vào use case" })
  }
  return { ops, notes }
}
