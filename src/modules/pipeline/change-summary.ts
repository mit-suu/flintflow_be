/**
 * change-summary.ts
 * ─────────────────────────────────────────────────────────────────
 * Đổi `changes[]` của op engine thành những dòng người đọc được (FLF-177 WP-5 + 03-live-status-flow Lớp 3/4).
 *
 * Trước đây gate chỉ nói "Đã ghi 31 thay đổi" và tiến trình chỉ đếm số op: user duyệt mà không biết bên
 * trong có gì, nên Accept thành một phản xạ. Một dòng tóm tắt phải trả lời được: **thêm/sửa/xoá cái gì, tên
 * nó là gì, nằm ở mục nào của tài liệu**.
 *
 * Nguyên tắc: chỉ đọc từ `changes[]` và Spine SAU khi ghi — không đoán, không gọi model. Thay đổi sổ sách
 * của runner (`steps[]`, `progress`, `flags[]`, `sections[]`) không phải nội dung tài liệu nên bị lọc bỏ.
 */

import type { Change, Spine } from "../spine/spine.types.js"
import { isAbsent } from "../spine/op.types.js"
import { parsePath } from "../spine/path-resolver.js"
import { sectionsOfPath } from "../spine/section-registry.js"
import type { ChangeSummary } from "./pipeline.dto.js"

type ChangeLike = Pick<Change, "op" | "path" | "before" | "value"> & { reason?: string | null }

/** Gốc do runner/hệ thống quản lý — không phải nội dung user cần duyệt. */
const BOOKKEEPING_ROOTS: ReadonlySet<string> = new Set(["steps", "progress", "flags", "sections", "baselines", "usage"])

/** Nhãn tiếng Việt của collection, dùng ở dòng tóm tắt và ở tiêu đề nhóm. */
export const COLLECTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  project: "thông tin dự án",
  features: "nhóm chức năng",
  actors: "actor",
  roles: "vai trò",
  use_cases: "use case",
  screens: "màn hình",
  permissions: "quyền",
  entities: "thực thể",
  functions: "chức năng",
  validations: "ràng buộc",
  nfrs: "yêu cầu phi chức năng",
  business_rules: "quy tắc nghiệp vụ",
  common_requirements: "yêu cầu chung",
  messages: "thông điệp",
  other_requirements: "yêu cầu khác",
  glossary: "thuật ngữ",
  addendum: "ghi chú Brief",
  assumptions: "giả định",
  diagrams: "sơ đồ",
  custom_sections: "mục tự thêm",
  decisions: "quyết định đã chốt"
})

export const collectionLabel = (collection: string): string => COLLECTION_LABELS[collection] ?? collection

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Tên gọi được của một phần tử: `name` → `term` → `statement` → `code` → `text` → `id`. */
export const titleOf = (element: unknown, fallback: string): string => {
  if (!isRecord(element)) return fallback
  for (const key of ["name", "term", "statement", "code", "text", "topic", "heading"]) {
    const value = element[key]
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  return fallback
}

interface ParsedTarget {
  collection: string
  id: string | null
  field: string | null
}

const parseTarget = (path: string): ParsedTarget | null => {
  try {
    const segments = parsePath(path)
    const [first] = segments
    const idOf = (index: number): string | null => {
      const selector = segments[index]?.selector
      return selector?.kind === "match" ? (selector.pairs.find(([k]) => k === "id")?.[1] ?? selector.pairs.map(([, v]) => v).join("/")) : null
    }
    // `functions[id=FN001].validations[id=V1].statement` — lấy segment cuối CÓ selector làm phần tử
    let elementIndex = -1
    segments.forEach((seg, i) => {
      if (seg.selector && seg.selector.kind !== "append") elementIndex = i
    })
    if (elementIndex === -1) {
      return { collection: first.key, id: null, field: segments.length > 1 ? segments[segments.length - 1].key : null }
    }
    const collection = segments[elementIndex].key
    const field = elementIndex === segments.length - 1 ? null : segments[segments.length - 1].key
    return { collection, id: idOf(elementIndex), field }
  } catch {
    return null
  }
}

const kindOf = (change: ChangeLike): ChangeSummary["kind"] => {
  if (isAbsent(change.before)) return "add"
  if (isAbsent(change.value)) return "remove"
  return "update"
}

const shortValue = (value: unknown): string => {
  if (typeof value === "string") return value.length > 60 ? `${value.slice(0, 57)}…` : value
  if (Array.isArray(value)) return `${value.length} mục`
  if (value === null) return "trống"
  if (isRecord(value)) return titleOf(value, "…")
  return String(value)
}

/**
 * Một dòng cho mỗi phần tử bị động tới (nhiều op trên cùng phần tử gộp làm một). Thứ tự giữ theo lần đầu
 * xuất hiện, nên đọc dòng tóm tắt là thấy đúng thứ tự runner đã ghi.
 */
export const summarizeChanges = (changes: readonly ChangeLike[], spineAfter?: Spine): ChangeSummary[] => {
  const byKey = new Map<string, ChangeSummary & { fields: Set<string> }>()

  for (const change of changes) {
    const target = parseTarget(change.path)
    if (!target || BOOKKEEPING_ROOTS.has(parsePath(change.path)[0].key)) continue

    const key = `${target.collection}|${target.id ?? target.field ?? change.path}`
    const kind = kindOf(change)
    const element = kind === "remove" ? change.before : change.value
    const existing = byKey.get(key)

    if (existing) {
      // Phần tử vừa thêm rồi sửa tiếp trong cùng lô vẫn là "thêm"
      if (kind !== "add" && existing.kind === "update") existing.kind = kind === "remove" ? "remove" : existing.kind
      if (target.field) existing.fields.add(target.field)
      if (existing.title_vi === (target.id ?? target.collection) && isRecord(element)) existing.title_vi = titleOf(element, existing.title_vi)
      continue
    }

    const fromSpine =
      target.id && spineAfter
        ? ((spineAfter as unknown as Record<string, unknown>)[target.collection] as unknown[] | undefined)?.find(
            (el) => isRecord(el) && el.id === target.id
          )
        : undefined
    const title =
      target.id === null
        ? `${target.field ?? target.collection}: ${shortValue(change.value)}`
        : titleOf(fromSpine ?? element, target.id)
    const section = spineAfter ? (sectionsOfPath(spineAfter, change.path).owner[0] ?? null) : null

    byKey.set(key, {
      kind,
      collection: target.collection,
      id: target.id,
      title_vi: title,
      ...(section ? { section_id: section } : {}),
      fields: new Set(target.field ? [target.field] : [])
    })
  }

  return [...byKey.values()].map(({ fields, ...row }) => {
    // Sửa một phần tử: nói rõ đã đổi field nào ("Admin · tên, mô tả")
    const detail = row.kind === "update" && fields.size > 0 && fields.size <= 3 ? ` · ${[...fields].join(", ")}` : ""
    return { ...row, title_vi: `${row.title_vi}${detail}` }
  })
}

/** "+3 use case · sửa 2 chức năng · xoá 1 màn hình" — một dòng cho gate và toast. */
export const summaryHeadline = (summary: readonly ChangeSummary[]): string => {
  const counts = new Map<string, number>()
  for (const row of summary) {
    const key = `${row.kind}|${row.collection}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const verb: Record<ChangeSummary["kind"], string> = { add: "thêm", update: "sửa", remove: "xoá" }
  return [...counts.entries()]
    .map(([key, n]) => {
      const [kind, collection] = key.split("|") as [ChangeSummary["kind"], string]
      return `${verb[kind]} ${n} ${collectionLabel(collection)}`
    })
    .join(" · ")
}
