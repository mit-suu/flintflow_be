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
import { fieldLabel } from "../spine/human-labels.js"
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
  // Tóm tắt hiện cho user (gate, nhật ký) ⇒ ưu tiên bản ngôn ngữ user: giả định `statement_vi`, ghi chú Brief `content`
  for (const key of ["name", "term", "statement_vi", "content", "statement", "code", "text", "topic", "heading"]) {
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
    // `functions[id=FN001].validations[id=V1].statement` — lấy segment cuối là PHẦN TỬ: bộ chọn khớp theo `id`, hoặc bộ chọn
    // khớp ở segment đầu (`permissions[screen_id=S1,role_id=R1,action=view]`). Bộ chọn giá trị lồng dưới phần tử
    // (`use_cases[id=UC12].function_ids[=FN034]`) là FIELD của phần tử cha — FLF P06: trước đây thành collection
    // "function_ids" và chat in "Ghi +7 function_ids", "function_ids: FN009"
    let elementIndex = -1
    segments.forEach((seg, i) => {
      const sel = seg.selector
      if (sel?.kind === "match" && (i === 0 || sel.pairs.some(([k]) => k === "id"))) elementIndex = i
    })
    if (elementIndex === -1) {
      return { collection: first.key, id: null, field: segments.length > 1 ? segments[segments.length - 1].key : null }
    }
    const collection = segments[elementIndex].key
    // Field = segment ngay sau phần tử (`use_cases[id=UC12].function_ids[=FN034]` ⇒ `function_ids`)
    const field = elementIndex === segments.length - 1 ? null : segments[elementIndex + 1].key
    return { collection, id: idOf(elementIndex), field }
  } catch {
    return null
  }
}

/** Phân quyền không có tên: "<vai> trên màn <màn>" (FLF P06: trước đây in mã "P04"). */
const permissionTitleOf = (permission: unknown, spine: Spine): string | null => {
  if (!isRecord(permission)) return null
  const role = spine.roles.find((r) => r.id === permission.role_id)?.name ?? null
  const screen = spine.screens.find((sc) => sc.id === permission.screen_id)?.name ?? null
  // Vai / màn đã bị xoá sau đó (gộp use case) ⇒ vẫn không in mã
  return `${role ?? "Một vai trò"} trên ${screen ? `màn ${screen}` : "một màn đã xoá"}`
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
    // P06: thêm / bỏ một giá trị trong field của phần tử ĐÃ CÓ (`use_cases[id=UC12].function_ids[=FN034]`) là SỬA phần tử đó,
    // không phải "thêm use case" (trước đây chat ghi "Thêm use case: Manage Shop Setup" khi chỉ gắn chức năng)
    const kind = target.id !== null && target.field !== null ? "update" : kindOf(change)
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
    const permissionTitle = target.collection === "permissions" && spineAfter ? permissionTitleOf(kind === "remove" ? change.before : (fromSpine ?? change.value), spineAfter) : null
    const title =
      permissionTitle ??
      (target.id === null ? `${fieldLabel(target.field ?? target.collection)}: ${shortValue(change.value)}` : titleOf(fromSpine ?? element, target.id))
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
    // Sửa một phần tử CÓ ID: nói rõ đã đổi field nào ("Admin · tên, mô tả"). Field lẻ của `project` thì
    // tiêu đề đã là "<field>: <giá trị>" — thêm tên field lần nữa chỉ lặp lại chính nó.
    const detail = row.id !== null && row.kind === "update" && fields.size > 0 && fields.size <= 3 ? ` · ${[...fields].map(fieldLabel).join(", ")}` : ""
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
