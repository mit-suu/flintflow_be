/**
 * FLF-375 (U1–U5): tên chỗ cần sửa và nội dung trước / sau **người đọc được** — không lộ mã nội bộ của Spine
 * (`CS11`, `F-3.2.9`, `VER-05`, `fixed:2.2.2`, `image_ref`, `flows_in`…). Mã có trong chính tài liệu khách (UC-09,
 * REQ-INT-005, BR-03, TC-INT-005…) được giữ. FE ghép `kind` (dịch theo ngôn ngữ giao diện) + `label`.
 */

import type { CustomBlock, Spine } from "../spine/spine.types.js"
import type { LocationProposal } from "./change-location.model.js"
import { elementValue, isArrayPath } from "./spine-location.js"

type Row = Record<string, unknown>
const isRow = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v)

export type DisplayChange = "edit" | "add" | "remove" | "comment" | "none"

export interface LocationDisplay {
  /** Loại chỗ: tên mảng Spine (`use_cases`, `nfrs`…) hoặc khối văn bản của file (`paragraph` · `table` · `image`). */
  kind: string
  /** Tên / trích đoạn người đọc được (≤ 90 ký tự), không chứa mã nội bộ. */
  label: string
  change: DisplayChange
  /** Nội dung trước / sau dạng câu (không phải JSON) — `null` khi không có. */
  before: string | null
  after: string | null
}

/** Mã người đọc thấy trong tài liệu (mã khách đặt). Mã nội bộ FlintFlow (CS11, VER-05, F-3.2.9, A07, M9…) không hiện. */
const DOC_ID = /^(UC|BR|REQ|NFR|MSG|TC|FR|US|IR|SR)[-_]?[A-Z0-9-]*\d/i

const clip = (s: string, n = 90): string => {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const LABEL_FIELDS = ["name", "term", "title", "statement", "artifact", "description", "definition", "content", "text"] as const
const BODY_FIELDS = ["name", "term", "title", "statement", "description", "definition", "content", "text", "rationale", "acceptance"] as const
/** Field ngắn in kèm sau chữ chính ("số đo: ngưỡng") — vd NFR đổi ngưỡng 2 s ⇒ 1 s phải thấy trong trước / sau. */
const DETAIL_FIELDS = ["metric", "threshold"] as const

const blockText = (b: CustomBlock): string => {
  if (b.kind === "table") return (b.rows ?? []).map((r) => r.join(" | ")).join("\n")
  if (b.kind === "image") return b.text ? `[${b.text}]` : "[hình]"
  return b.text ?? ""
}

/** Chữ của khối văn bản mục riêng / phần nối — mỗi khối một dòng. */
const blocksText = (blocks: readonly CustomBlock[]): string => blocks.map(blockText).filter((t) => t.trim()).join("\n")

/** Chữ chính của một phần tử Spine (tên — mô tả / phát biểu), không dạng `khoá: giá trị`. */
export const elementText = (value: unknown): string => {
  if (isRow(value) && Array.isArray(value.blocks)) return blocksText(value.blocks as CustomBlock[])
  if (!isRow(value)) return typeof value === "string" ? value : ""
  const id = typeof value.id === "string" && DOC_ID.test(value.id) ? value.id : ""
  const parts = BODY_FIELDS.map((f) => value[f]).filter((v): v is string => typeof v === "string" && v.trim().length > 0)
  const unique = parts.filter((p, i) => parts.indexOf(p) === i)
  const detail = DETAIL_FIELDS.map((f) => value[f]).filter((v): v is string => typeof v === "string" && v.trim().length > 0).join(": ")
  return [id && !unique.some((p) => p.includes(id)) ? id : "", ...unique, detail ? `(${detail})` : ""].filter(Boolean).join(" - ")
}

const elementLabel = (value: unknown): string => {
  if (!isRow(value)) return ""
  if (Array.isArray(value.blocks)) {
    const blocks = value.blocks as CustomBlock[]
    const caption = blocks.find((b) => b.kind === "paragraph" && b.text?.trim() && blocks.some((x) => x.kind === "image"))
    const first = blocks.find((b) => blockText(b).trim())
    return clip(caption?.text ?? (first ? blockText(first) : ""))
  }
  const id = typeof value.id === "string" && DOC_ID.test(value.id) ? value.id : ""
  const text = LABEL_FIELDS.map((f) => value[f]).find((v): v is string => typeof v === "string" && v.trim().length > 0) ?? ""
  return clip(id && !text.includes(id) ? `${id} ${text}` : text)
}

const blockKind = (value: unknown): string => {
  const blocks = isRow(value) && Array.isArray(value.blocks) ? (value.blocks as CustomBlock[]) : []
  if (blocks.some((b) => b.kind === "image")) return "image"
  if (blocks.some((b) => b.kind === "table")) return "table"
  return "paragraph"
}

const parse = (text: string | null | undefined): unknown => {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Mảng của path: `use_cases[id=UC-01]` / `use_cases[]` ⇒ `use_cases`; `project` ⇒ `project`. */
const collectionOf = (path: string): string => /^(\w+)/.exec(path)?.[1] ?? path

export const locationDisplay = (
  spine: Spine | null,
  path: string,
  conclusion: string | null,
  proposal: Pick<LocationProposal, "old_text" | "new_text" | "spine_ops" | "comment_text"> | null
): LocationDisplay => {
  const collection = collectionOf(path)
  const current = spine ? elementValue(spine, path) : undefined
  const before = parse(proposal?.old_text) ?? current
  const after = parse(proposal?.new_text)
  const removes = (proposal?.spine_ops ?? []).some((o) => isRow(o) && o.op === "remove" && o.path === path)

  if (isArrayPath(path)) {
    const added = (Array.isArray(after) ? after : []).filter(isRow)
    return {
      kind: collection,
      label: clip(added.map(elementLabel).filter(Boolean).join(", ")),
      change: conclusion === "edit" && added.length ? "add" : conclusion === "comment" ? "comment" : "none",
      before: null,
      after: added.length ? added.map(elementText).join("\n") : null
    }
  }
  const kind = collection === "custom_sections" ? blockKind(before ?? after) : collection
  // Nội dung bị xoá trắng (mục riêng còn lại không khối nào — vd đoạn + hình của use case bị xoá) cũng là "xoá"
  const emptied = after !== undefined && before !== undefined && !elementText(after).trim() && !!elementText(before).trim()
  const change: DisplayChange =
    conclusion === "edit" ? (removes || emptied ? "remove" : "edit") : conclusion === "comment" ? "comment" : "none"
  return {
    kind,
    label: elementLabel(before ?? after),
    change,
    before: before === undefined ? null : elementText(before),
    // Đề xuất chưa chạy thử được (op hỏng — vd tham chiếu phần tử không có) ⇒ `null`: KHÔNG phải xoá; bước kiểm bắt và AI soạn lại
    after: change === "edit" ? (after === undefined ? null : elementText(after)) : change === "comment" ? (proposal?.comment_text ?? null) : null
  }
}
