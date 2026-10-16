/**
 * Giả định "màn chỉ giữ khung" mà S-4.1 ghi khi để một màn `placeholder` (skill screens-and-flow §3).
 *
 * Khi vòng S-5 của màn đó chạy xong và S-5.5 ký (`signed_off`), giả định này sai hẳn: màn đã có mô tả đầy đủ.
 * Trước đây nó vẫn nằm `unconfirmed` ⇒ cờ đỏ `unconfirmed_assumption` chặn ký baseline, và user phải tự bấm
 * "Sai" cho từng màn (E2E FAP: AS12–AS23 cho 12 màn đã mô tả 1.7k–2.8k ký tự).
 */

import type { Assumption, Spine } from "../spine/spine.types.js"
import type { Op } from "../spine/op.types.js"

/** Spine cũ: path trỏ cả màn (`screens[id=X]`), chỉ nhận ra qua câu chữ. */
const LEGACY_FRAME_ONLY = /frame only|placeholder|without detailed description|chỉ giữ khung|để lại/i

const isFrameOnlyAssumption = (assumption: Assumption, screenId: string): boolean => {
  if (assumption.origin_step_id !== "S-4.1") return false
  if (assumption.path === `screens[id=${screenId}].detail_status`) return true
  return assumption.path === `screens[id=${screenId}]` && LEGACY_FRAME_ONLY.test(assumption.statement)
}

/** Ops gỡ giả định "chỉ giữ khung" của `screenId` — gọi khi màn vừa được ký xong. */
export const retireFrameOnlyAssumptionOps = (spine: Spine, screenId: string): Op[] =>
  spine.assumptions
    .filter((a) => isFrameOnlyAssumption(a, screenId))
    .map((a) => ({ op: "remove" as const, path: `assumptions[id=${a.id}]`, reason: `Màn ${screenId} đã mô tả đầy đủ ở vòng S-5` }))
