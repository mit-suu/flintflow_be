/**
 * FLF-361 — nguyên văn mục chức năng của file import (FLF-252) chia theo **trường** của chức năng. Hàm thuần.
 *
 * Lúc import, mỗi khối của mục ghi thêm các trường chức năng đọc từ khối đó (`fields`: `normal`, `validations`…) và mỗi
 * trường một dấu (`field_hashes`). CR sửa chức năng ⇒ chỉ khối của trường đã đổi dựng lại từ Spine, tại chỗ khối đầu tiên
 * của trường đó; nhãn ("Normal case:"), Navigation path, Interface, ảnh Screen layout… không thuộc trường đã đổi giữ nguyên
 * văn. Trước đây lệch dấu là cả mục dựng lại theo khung cũ, mất mọi dòng không có trong Spine.
 *
 * Dữ liệu nằm ở `TemplateProfile.function_originals` (Mixed) — không thêm trường vào Spine.
 */

import { createHash } from "node:crypto"
import type { CustomBlock, Spine } from "../spine/spine.types.js"

type Fn = Spine["functions"][number]

/** Heading con trong mục chức năng ("Function trigger", "Screen layout"…) — `level` tương đối heading của mục (≥ 1). */
export interface FunctionHeadingBlock {
  kind: "heading"
  text: string
  level: number
}

/** Khối nguyên văn của mục chức năng; `fields` = trường chức năng I-4 đọc từ khối này. */
export type FunctionOriginalBlock = (CustomBlock | FunctionHeadingBlock) & { fields?: string[] }

/** Trường có chữ in trong mục chức năng (tên ở tiêu đề mục; màn / ưu tiên không có dòng riêng). */
export const FUNCTION_TEXT_FIELDS = ["trigger", "description", "normal", "abnormal", "validations", "business_rule_ids"] as const
export type FunctionTextField = (typeof FUNCTION_TEXT_FIELDS)[number]
const isTextField = (f: string): f is FunctionTextField => (FUNCTION_TEXT_FIELDS as readonly string[]).includes(f)

const fieldValue = (fn: Fn, field: FunctionTextField): unknown =>
  field === "validations" ? fn.validations.map((v) => [v.kind, v.statement]) : (fn as unknown as Record<string, unknown>)[field]

const sha1 = (v: unknown): string => createHash("sha1").update(JSON.stringify(v ?? null)).digest("hex")

/** Dấu từng trường có chữ của chức năng. */
export const functionFieldHashes = (fn: Fn): Record<FunctionTextField, string> =>
  Object.fromEntries(FUNCTION_TEXT_FIELDS.map((f) => [f, sha1(fieldValue(fn, f))])) as Record<FunctionTextField, string>

/** Trường đã đổi so với lúc import. */
export const changedFunctionFields = (fn: Fn, hashes: Readonly<Record<string, string>>): Set<FunctionTextField> =>
  new Set(FUNCTION_TEXT_FIELDS.filter((f) => hashes[f] !== undefined && hashes[f] !== sha1(fieldValue(fn, f))))

const EMPTY_HASH: Readonly<Record<FunctionTextField, string>> = {
  trigger: sha1(""),
  description: sha1(""),
  normal: sha1([]),
  abnormal: sha1([]),
  validations: sha1([]),
  business_rule_ids: sha1([])
}

/** Nhãn khi trường đã đổi không có khối nào trong file (CR thêm luồng lỗi cho chức năng file không ghi). */
const FIELD_LABEL: Readonly<Record<FunctionTextField, string>> = {
  trigger: "Function trigger",
  description: "Function description",
  normal: "Normal case",
  abnormal: "Abnormal case",
  validations: "Validation",
  business_rule_ids: "Business rules"
}

/** Nhãn đầu dòng của khối gốc ("Timing frequency: …") — giữ khi dòng chỉ chứa một trường. */
const LEAD_LABEL = /^([^:\n]{1,40}):\s+\S/

const linesOf = (spine: Spine, fn: Fn, field: FunctionTextField, sample: string): string[] => {
  switch (field) {
    case "trigger":
    case "description": {
      const v = fn[field].trim()
      if (!v) return []
      const label = LEAD_LABEL.exec(sample)?.[1]
      return [label ? `${label}: ${v}` : v]
    }
    case "normal":
    case "abnormal":
      return fn[field].filter((x) => x.trim())
    case "validations":
      return fn.validations.map((v) => v.statement).filter((x) => x.trim())
    case "business_rule_ids": {
      const withId = /\b[A-Z]{1,5}[-_ ]?\d+/.test(sample)
      return fn.business_rule_ids.flatMap((id) => {
        const r = spine.business_rules.find((x) => x.id === id)
        if (!r) return []
        return [withId ? `${id}: ${r.statement}` : r.statement]
      })
    }
  }
}

const asBlocks = (lines: string[], kind: "paragraph" | "list_item"): CustomBlock[] => lines.map((text) => ({ kind, text, rows: null, image_ref: null }))

/**
 * Khối in của mục chức năng đã bị CR sửa: khối của trường đã đổi (và trường dùng chung khối với nó) thay bằng dữ liệu
 * Spine tại chỗ khối đầu tiên của trường, cùng kiểu khối (gạch đầu dòng / đoạn); khối khác giữ nguyên văn. Trường đã đổi
 * mà file không có khối ⇒ cuối mục, có nhãn. Trường đã đổi **có chữ lúc import** mà không biết khối nào ⇒ `null` (không
 * dựng lại tại chỗ được — giữ khối cũ là in chữ cũ; người gọi dựng lại cả mục).
 */
export const patchFunctionOriginal = (
  blocks: readonly FunctionOriginalBlock[],
  spine: Spine,
  fn: Fn,
  changed: ReadonlySet<FunctionTextField>,
  hashes: Readonly<Record<string, string>> = {}
): FunctionOriginalBlock[] | null => {
  const fieldsOf = (b: FunctionOriginalBlock): FunctionTextField[] => (b.fields ?? []).filter(isTextField)
  for (const f of changed) if (hashes[f] !== undefined && hashes[f] !== EMPTY_HASH[f] && !blocks.some((b) => fieldsOf(b).includes(f))) return null
  // Khối chứa nhiều trường mà một trường đổi ⇒ dựng lại cả các trường đó (không thì mất chữ của trường còn lại)
  const redo = new Set(changed)
  for (let grew = true; grew; ) {
    grew = false
    for (const b of blocks) {
      const fs = fieldsOf(b)
      if (!fs.some((f) => redo.has(f))) continue
      for (const f of fs) if (!redo.has(f)) (redo.add(f), (grew = true))
    }
  }
  const out: FunctionOriginalBlock[] = []
  const done = new Set<FunctionTextField>()
  for (const b of blocks) {
    const fs = fieldsOf(b).filter((f) => redo.has(f))
    if (!fs.length) {
      out.push(b)
      continue
    }
    for (const f of fs) {
      if (done.has(f)) continue
      done.add(f)
      const sample = blocks.find((x) => fieldsOf(x).includes(f))
      const text = sample && sample.kind !== "table" && sample.kind !== "image" ? sample.text : ""
      out.push(...asBlocks(linesOf(spine, fn, f, fieldsOf(sample!).length === 1 ? text : ""), sample?.kind === "list_item" ? "list_item" : f === "trigger" || f === "description" ? "paragraph" : "list_item"))
    }
  }
  for (const f of FUNCTION_TEXT_FIELDS) {
    if (!redo.has(f) || done.has(f)) continue
    const lines = linesOf(spine, fn, f, "")
    if (lines.length) out.push(...asBlocks([FIELD_LABEL[f]], "paragraph"), ...asBlocks(lines, f === "trigger" || f === "description" ? "paragraph" : "list_item"))
  }
  return out
}
