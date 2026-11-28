/**
 * FLF-469 (B.1): ý cấu trúc của CR - thêm / xoá cả một chức năng, màn hình (không nhắc "use case"). Bộ nhận ý riêng của
 * change request, KHÔNG sửa `useCaseIntent` (chat trước baseline dùng chung và giữ nguyên hành vi). Hàm thuần.
 *
 * Nhận khi động từ đứng ngay trước danh từ cấu trúc (chỉ cho phép "một / mới / các / the / a" ở giữa): "Bỏ chức năng 3.3.5
 * Gửi tin nhắn…", "thêm một chức năng mới…", "remove the screen…". "Thêm validation cho chức năng X" hay "bổ sung cho chức
 * năng X" là sửa chức năng có sẵn nên KHÔNG tính. Tín hiệu yếu: "cho phép / allow …" mà đích C-2 là chức năng / mục tính
 * năng ⇒ thêm chức năng (CR-001 ChoViet "Cho phép người mua đổi địa chỉ giao hàng…").
 */

import { affirmedIndex, type UseCaseIntent } from "../spine/use-case-propagation.js"
import type { IChangeRequest } from "./change-request.model.js"

export type StructuralCollection = "functions" | "screens"

export interface StructuralRequest {
  intent: Extract<UseCaseIntent, "add" | "remove">
  collection: StructuralCollection
  /** `false` = suy từ "cho phép…" + đích, không có động từ thêm / xoá rõ ràng. */
  strong: boolean
}

const FILLER = "(?:(?:một|mới|các|những|the|a|an|new|1)\\s+){0,2}"
const FUNCTION_NOUN = "(?:chức năng|tính năng|function|feature|FR-[\\w.-]+|\\d+\\.\\d+(?:\\.\\d+)+)"
const SCREEN_NOUN = "(?:màn hình|màn|screen|popup)"
const ADD = "(?:thêm|bổ sung|tạo|add|create|introduce)"
const REMOVE = "(?:xoá|xóa|loại bỏ|(?<!\\p{L})bỏ(?!\\p{L})|gỡ|remove|delete|drop)"
const before = "(?<![\\p{L}\\p{N}])"

const verbNoun = (verb: string, noun: string): RegExp => new RegExp(`${before}${verb}\\s+${FILLER}${noun}`, "iu")
const ALLOW = /(?<![\p{L}\p{N}])(cho phép|allow|enable|hỗ trợ)(?![\p{L}\p{N}])/iu
const FUNCTION_TARGET = /^(function:|feature:|functions\[)/

type CrText = Pick<IChangeRequest, "title" | "description" | "amendments" | "clarifications">

const requesterText = (cr: CrText): string =>
  [cr.title, cr.description, ...(cr.amendments ?? []).map((a) => a.text), ...cr.clarifications.flatMap((c) => c.answers)].join("\n")

/** Ý cấu trúc của CR; không phải thêm / xoá chức năng, màn ⇒ `null`. Động từ đứng trước thắng. */
export const structuralRequest = (cr: CrText & Partial<Pick<IChangeRequest, "targets">>): StructuralRequest | null => {
  const text = requesterText(cr)
  const candidates: { at: number; intent: StructuralRequest["intent"]; collection: StructuralCollection }[] = []
  for (const [collection, noun] of [["functions", FUNCTION_NOUN], ["screens", SCREEN_NOUN]] as const) {
    for (const [intent, verb] of [["add", ADD], ["remove", REMOVE]] as const) {
      const at = affirmedIndex(verbNoun(verb, noun), text)
      if (at !== Infinity) candidates.push({ at, intent, collection })
    }
  }
  candidates.sort((a, b) => a.at - b.at)
  if (candidates[0]) return { intent: candidates[0].intent, collection: candidates[0].collection, strong: true }
  const targets = cr.targets?.entity_paths ?? []
  if (ALLOW.test(text) && targets.some((t) => FUNCTION_TARGET.test(t))) return { intent: "add", collection: "functions", strong: false }
  return null
}

/** `add` / `remove` khi CR thêm / xoá cả một chức năng hay màn; không ⇒ `null`. */
export const crStructuralIntent = (cr: CrText & Partial<Pick<IChangeRequest, "targets">>): UseCaseIntent | null => structuralRequest(cr)?.intent ?? null
