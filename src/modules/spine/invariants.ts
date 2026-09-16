/**
 * invariants.ts
 * ─────────────────────────────────────────────────────────────────
 * 8 bất biến srs-spine.md §6. Kiểm ở CUỐI lô (không phải từng op).
 *
 * Mỗi bất biến nhận `(after, before)`:
 * - 1, 2, 8 là bất biến về việc XOÁ ⇒ so trạng thái trước/sau lô. Kiểm tuyệt đối thì
 *   Spine mới (mảng rỗng, `sections[]` rỗng) sẽ bị từ chối mọi lô.
 * - 3, 4, 5, 6 kiểm tuyệt đối trên `after` rồi chỉ giữ vi phạm MỚI (không có ở `before`):
 *   Spine migrate từ legacy đang lỗi vẫn sửa được; lỗi cũ hiện qua cờ đỏ T09.
 * - 7 nằm ngoài document Spine (ChatSession.is_pipeline, partial unique index T01) ⇒ không kiểm ở đây.
 */

import type { Spine } from "./spine.types.js"
import type { RejectRule, Violation } from "./op.types.js"
import { findDeadReferences } from "./reference-fields.js"
import { REQUIRED_FIXED_SECTION_IDS } from "./section-registry.js"

export interface InvariantContext {
  /** Màn được revert khôi phục lại — không phải "thêm màn mới" nên bất biến 8 không đòi pending/queued. */
  restoredScreenIds?: ReadonlySet<string>
}

export interface Invariant {
  id: number
  name: string
  check(after: Spine, before: Spine, context: InvariantContext): Violation[]
}

/** Bất biến 1 — section bắt buộc theo khoá logic, lấy từ section registry (T09). `fixed:4.2.4` tuỳ chọn, `fixed:I` dẫn xuất. */
export const REQUIRED_FIXED_SECTIONS: readonly string[] = REQUIRED_FIXED_SECTION_IDS

const violation = (rule: RejectRule, path: string, message: string): Violation => ({ rule, path, message })

/**
 * Chỉ giữ vi phạm chưa có ở `before` (khoá: rule + path). Không khoá theo message: message chứa dữ liệu
 * (vd danh sách order) nên đổi theo lô, làm vi phạm cũ bị coi là mới.
 */
const onlyNew =
  (check: (spine: Spine) => Violation[]) =>
  (after: Spine, before: Spine): Violation[] => {
    const key = (v: Violation) => `${v.rule}|${v.path ?? ""}`
    const existing = new Set(check(before).map(key))
    return check(after).filter((v) => !existing.has(key(v)))
  }

// ─── 1 ───────────────────────────────────────────────────────────

const invariant1: Invariant = {
  id: 1,
  name: "required_section",
  check(after, before) {
    const out: Violation[] = []
    const afterIds = new Set(after.sections.map((s) => s.id))
    const beforeIds = new Set(before.sections.map((s) => s.id))

    for (const id of REQUIRED_FIXED_SECTIONS) {
      if (beforeIds.has(id) && !afterIds.has(id)) {
        out.push(violation("invariant_1_required_section", `sections[id=${id}]`, `Không được xoá section bắt buộc ${id}`))
      }
    }
    for (const prefix of ["feature:", "function:"]) {
      const count = (ids: Set<string>) => [...ids].filter((id) => id.startsWith(prefix)).length
      if (count(beforeIds) > 0 && count(afterIds) === 0) {
        out.push(
          violation("invariant_1_required_section", `sections[id=${prefix}*]`, `Phải còn ít nhất một section ${prefix}*`)
        )
      }
    }
    return out
  }
}

// ─── 2 ───────────────────────────────────────────────────────────

const PROTECTED_ARRAYS: readonly { label: string; count: (s: Spine) => number }[] = [
  { label: "actors", count: (s) => s.actors.length },
  { label: "actors[kind=human]", count: (s) => s.actors.filter((a) => a.kind === "human").length },
  { label: "screens", count: (s) => s.screens.length },
  { label: "entities", count: (s) => s.entities.length },
  { label: "use_cases", count: (s) => s.use_cases.length },
  { label: "features", count: (s) => s.features.length },
  { label: "functions", count: (s) => s.functions.length },
  { label: "roles", count: (s) => s.roles.length },
  { label: "nfrs[category=reliability]", count: (s) => s.nfrs.filter((n) => n.category === "reliability").length },
  { label: "nfrs[category=performance]", count: (s) => s.nfrs.filter((n) => n.category === "performance").length },
  { label: "common_requirements", count: (s) => s.common_requirements.length }
]

const invariant2: Invariant = {
  id: 2,
  name: "last_element",
  check: (after, before) =>
    PROTECTED_ARRAYS.filter((arr) => arr.count(before) > 0 && arr.count(after) === 0).map((arr) =>
      violation("invariant_2_last_element", arr.label, `Không được xoá phần tử cuối cùng của ${arr.label}`)
    )
}

// ─── 3 ───────────────────────────────────────────────────────────

const invariant3: Invariant = {
  id: 3,
  name: "dead_reference",
  check: onlyNew((spine) =>
    findDeadReferences(spine).map((hit) =>
      violation("invariant_3_dead_reference", hit.refPath, `Khoá "${hit.targetId}" (${hit.field.path}) không trỏ tới phần tử tồn tại`)
    )
  )
}

// ─── 4 ───────────────────────────────────────────────────────────

const invariant4: Invariant = {
  id: 4,
  name: "screen_missing",
  check: onlyNew((spine) => {
    const screens = new Set(spine.screens.map((s) => s.id))
    const out: Violation[] = []
    for (const f of spine.functions) {
      if (f.screen_id !== null && !screens.has(f.screen_id)) {
        out.push(
          violation("invariant_4_screen_missing", `functions[id=${f.id}].screen_id`, `screen_id "${f.screen_id}" không thuộc screens[] và không null`)
        )
      }
    }
    return out
  })
}

// ─── 5 ───────────────────────────────────────────────────────────

const invariant5: Invariant = {
  id: 5,
  name: "order",
  check: onlyNew((spine) => {
    const out: Violation[] = []

    const orders = spine.features.map((f) => f.order).sort((a, b) => a - b)
    if (orders.some((o, i) => o !== i)) {
      out.push(
        violation("invariant_5_feature_order", "features", `features[].order phải duy nhất và liên tục từ 0 (hiện: ${orders.join(", ")})`)
      )
    }

    const groups = new Map<string, Map<number, string[]>>()
    for (const f of spine.functions) {
      const group = `${f.feature_id}|${f.screen_id === null ? "nonscreen" : "screen"}`
      const byOrder = groups.get(group) ?? new Map<number, string[]>()
      byOrder.set(f.order, [...(byOrder.get(f.order) ?? []), f.id])
      groups.set(group, byOrder)
    }
    for (const [group, byOrder] of groups) {
      const [featureId, scope] = group.split("|")
      for (const [order, fnIds] of byOrder) {
        if (fnIds.length < 2) continue
        out.push(
          violation(
            "invariant_5_function_order",
            `functions[feature_id=${featureId}].order`,
            `functions ${[...fnIds].sort().join(", ")} trùng order ${order} trong feature ${featureId} (${scope})`
          )
        )
      }
    }
    return out
  })
}

// ─── 6 ───────────────────────────────────────────────────────────

const invariant6: Invariant = {
  id: 6,
  name: "feature_mismatch",
  check: onlyNew((spine) => {
    const screenFeature = new Map(spine.screens.map((s) => [s.id, s.feature_id]))
    const out: Violation[] = []
    for (const f of spine.functions) {
      if (f.screen_id === null) continue
      const expected = screenFeature.get(f.screen_id)
      if (expected !== undefined && expected !== f.feature_id) {
        out.push(
          violation(
            "invariant_6_feature_mismatch",
            `functions[id=${f.id}].feature_id`,
            `functions[id=${f.id}].feature_id = ${f.feature_id} lệch feature ${expected} của màn ${f.screen_id}`
          )
        )
      }
    }
    return out
  })
}

// ─── 7 ───────────────────────────────────────────────────────────

const invariant7: Invariant = {
  id: 7,
  name: "single_pipeline_session",
  // sessions[] nằm ở collection chatsessions — partial unique index is_pipeline (T01), promote ở T13
  check: () => []
}

// ─── 8 ───────────────────────────────────────────────────────────

/** Phase mà thêm màn phải vào hàng đợi (bất biến 8). */
export const SCREEN_LOOP_PHASE = "S-5"

const invariant8: Invariant = {
  id: 8,
  name: "screen_cursor_queue",
  check(after, before, context) {
    const out: Violation[] = []
    const afterScreens = new Map(after.screens.map((s) => [s.id, s]))
    const beforeScreens = new Set(before.screens.map((s) => s.id))

    const cursor = before.progress.screen_cursor
    if (cursor !== null && beforeScreens.has(cursor) && !afterScreens.has(cursor)) {
      out.push(violation("invariant_8_cursor_screen", `screens[id=${cursor}]`, `Không được xoá màn đang là progress.screen_cursor (${cursor})`))
    }

    if (after.progress.current_phase === SCREEN_LOOP_PHASE) {
      const queue = new Set(after.progress.screen_queue)
      for (const [id, screen] of afterScreens) {
        if (beforeScreens.has(id) || context.restoredScreenIds?.has(id)) continue
        if (screen.detail_status !== "pending") {
          out.push(
            violation("invariant_8_screen_not_pending", `screens[id=${id}].detail_status`, `Màn thêm trong S-5 phải có detail_status = pending`)
          )
        }
        if (!queue.has(id)) {
          out.push(violation("invariant_8_screen_not_queued", `progress.screen_queue`, `Màn ${id} thêm trong S-5 phải nằm trong screen_queue`))
        }
      }
    }
    return out
  }
}

export const INVARIANTS: readonly Invariant[] = Object.freeze([
  invariant1,
  invariant2,
  invariant3,
  invariant4,
  invariant5,
  invariant6,
  invariant7,
  invariant8
])

export const checkInvariants = (after: Spine, before: Spine, context: InvariantContext = {}): Violation[] =>
  INVARIANTS.flatMap((inv) => inv.check(after, before, context))
