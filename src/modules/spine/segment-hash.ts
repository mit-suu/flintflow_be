/**
 * Đoạn nguyên văn của file import (FLF-366 — mode 1: bản 0.1 khớp file gốc, CR chỉ đổi phần bị sửa). Hàm thuần.
 * Mỗi mục FPT `fixed:*` của file được chia thành các **đoạn** liên tiếp theo đúng thứ tự gốc (`import/step-plan.ts`):
 * - `original`: dãy khối không trích được (văn xuôi, ảnh, heading con) — nằm ở một phần nối của `custom_sections[]`, in
 *   từ Spine như mọi mục riêng (CR sửa văn xuôi / bỏ ảnh sơ đồ gốc đi đường cũ);
 * - `spine`: một khối đã trích (bảng BR, đoạn mô tả…) + khối gốc + phần tử Spine trích từ nó + dấu của các phần tử đó.
 *   Dấu còn khớp ⇒ in nguyên văn file; lệch ⇒ chỉ phần tử của đoạn được dựng lại từ Spine, đúng chỗ đó.
 * Dữ liệu đoạn nằm ở `TemplateProfile.section_segments` (ngoài Spine — không thêm trường nào vào Spine).
 *
 * Dấu tính từ **dữ liệu Spine** mà đoạn hiển thị, kể cả dữ liệu lấy từ phần tử khác (tên actor trong bảng use case, tên
 * màn / vai trò của ô phân quyền) — không hash kết quả render (sửa renderer sẽ làm mọi tài liệu lệch dấu).
 */

import { createHash } from "node:crypto"
import type { CustomBlock, OriginalDiagramKind, Spine } from "./spine.types.js"

/** Field `project` mà mục 1 (Product Overview) in ra — khoá phần tử `project:<field>`. */
export const PROJECT_SEGMENT_FIELDS = ["vision", "goals", "release_scope"] as const
type ProjectField = (typeof PROJECT_SEGMENT_FIELDS)[number]

/**
 * Mảng phần tử mà từng mục FPT in ra (theo `render/section-renderer.ts`). Chỉ mảng **là nội dung** của mục — mảng chỉ dùng
 * để tra tên (features trong bảng màn, screens / roles của ma trận phân quyền) không lọc, để bảng dựng lại vẫn đủ tên.
 */
export const SECTION_ITEM_ARRAYS: Readonly<Record<string, readonly string[]>> = {
  "fixed:1": ["project", "business_rules", "actors"],
  "fixed:2.1": ["actors"],
  "fixed:2.2.1": [],
  "fixed:2.2.2": ["use_cases"],
  "fixed:3.1.1": [],
  "fixed:3.1.2": ["screens"],
  "fixed:3.1.3": ["permissions"],
  "fixed:3.1.4": ["functions"],
  "fixed:3.1.5": ["entities"],
  "fixed:4.1": ["nfrs"],
  "fixed:4.2.1": ["nfrs"],
  "fixed:4.2.2": ["nfrs"],
  "fixed:4.2.3": ["nfrs"],
  "fixed:4.2.4": ["nfrs"],
  "fixed:5.1": ["business_rules"],
  "fixed:5.2": ["common_requirements"],
  "fixed:5.3": ["messages"],
  "fixed:5.4": ["other_requirements"],
  "fixed:5.5": ["glossary"]
}

const NFR_CATEGORY: Readonly<Record<string, string>> = {
  "fixed:4.1": "interface",
  "fixed:4.2.1": "usability",
  "fixed:4.2.2": "reliability",
  "fixed:4.2.3": "performance",
  "fixed:4.2.4": "other"
}

/** Mục FPT được chia đoạn (mục khác — feature, function, slot, mục riêng — giữ cách in cũ). */
export const isSegmentedSection = (sectionId: string): boolean => sectionId in SECTION_ITEM_ARRAYS

type Element = { id?: string } & Record<string, unknown>

/** Phần tử của mảng có được mục đó in ra không (mục 1 chỉ in BR cấp cao + actor không phải người, NFR theo nhóm…). */
const printsIn = (sectionId: string, array: string, el: Element): boolean => {
  if (sectionId === "fixed:1") {
    if (array === "business_rules") return el.tier === "high"
    if (array === "actors") return el.kind !== "human"
  }
  if (sectionId === "fixed:5.1" && array === "business_rules") return el.tier === "detail"
  if (array === "nfrs") return el.category === NFR_CATEGORY[sectionId]
  return true
}

export const segmentItemKey = (array: string, id: string): string => `${array}:${id}`

const splitKey = (key: string): { array: string; id: string } => {
  const at = key.indexOf(":")
  return { array: key.slice(0, at), id: key.slice(at + 1) }
}

const listOf = (spine: Spine, array: string): Element[] => {
  const list = (spine as unknown as Record<string, unknown>)[array]
  return Array.isArray(list) ? (list as Element[]) : []
}

/** Khoá mọi phần tử mục đó đang in (theo Spine hiện tại). */
export const sectionItemKeys = (spine: Spine, sectionId: string): string[] =>
  (SECTION_ITEM_ARRAYS[sectionId] ?? []).flatMap((array) =>
    array === "project"
      ? PROJECT_SEGMENT_FIELDS.map((f) => segmentItemKey("project", f))
      : listOf(spine, array).flatMap((el) => (el.id && printsIn(sectionId, array, el) ? [segmentItemKey(array, el.id)] : []))
  )

/** Phần tử Spine có thể trích vào mục đó (khoá `array:id`) — dùng khi chia phần tử cho đoạn lúc import. */
export const printableIn = (spine: Spine, sectionId: string, key: string): boolean => {
  const { array, id } = splitKey(key)
  if (!(SECTION_ITEM_ARRAYS[sectionId] ?? []).includes(array)) return false
  if (array === "project") return (PROJECT_SEGMENT_FIELDS as readonly string[]).includes(id)
  const el = listOf(spine, array).find((x) => x.id === id)
  return !!el && printsIn(sectionId, array, el)
}

/** Field không in ra / đổi mà nội dung không đổi (thứ tự) — không vào dấu. */
const VOLATILE_FIELDS = new Set(["order"])

/** Mảng có tên hiển thị — đích của các tham chiếu mà bảng in tên thay cho id. */
const NAMED_ARRAYS = ["actors", "roles", "use_cases", "features", "screens", "functions", "entities", "glossary", "messages"] as const

/** Tên hiển thị của mọi phần tử có id (tra tham chiếu). */
const nameIndex = (spine: Spine): Map<string, string> => {
  const out = new Map<string, string>()
  for (const array of NAMED_ARRAYS) {
    for (const el of listOf(spine, array)) {
      const name = typeof el.name === "string" ? el.name : typeof el.term === "string" ? el.term : typeof el.code === "string" ? el.code : null
      if (el.id && name !== null) out.set(el.id, name)
    }
  }
  return out
}

/** Chuỗi trong giá trị (đệ quy) — tìm id phần tử khác mà phần tử này tham chiếu. */
const strings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") out.push(value)
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out))
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out))
  return out
}

const sha = (value: unknown): string => createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16)

const MISSING = "∅"

/** Dấu của một phần tử (`business_rules:BR-01`, `project:vision`): nội dung + tên các phần tử nó tham chiếu. Đã xoá ⇒ `∅`. */
export const segmentItemHash = (spine: Spine, key: string, names: Map<string, string> = nameIndex(spine)): string => {
  const { array, id } = splitKey(key)
  if (array === "project") return sha(spine.project[id as ProjectField] ?? null)
  const el = listOf(spine, array).find((x) => x.id === id)
  if (!el) return MISSING
  const own = Object.fromEntries(Object.entries(el).filter(([k]) => !VOLATILE_FIELDS.has(k)))
  const refs = [...new Set(strings(own).filter((s) => s !== id && names.has(s)))].sort().map((s) => [s, names.get(s)])
  return sha([own, refs])
}

/** Dấu của một đoạn: dấu từng phần tử theo khoá (thứ tự khoá không ảnh hưởng). */
export const segmentHash = (spine: Spine, items: readonly string[], names: Map<string, string> = nameIndex(spine)): string =>
  sha([...items].sort().map((k) => [k, segmentItemHash(spine, k, names)]))

/** Dấu của nhiều phần tử một lượt (dùng chung bảng tên). */
export const segmentItemHashes = (spine: Spine, keys: readonly string[]): { key: string; hash: string }[] => {
  const names = nameIndex(spine)
  return keys.map((key) => ({ key, hash: segmentItemHash(spine, key, names) }))
}

// ─── dữ liệu đoạn (TemplateProfile.section_segments) ───────────────

/** Nhắc tới phần tử Spine trong văn xuôi nguyên văn lúc import (tên / mã) — cờ vàng khi phần tử đó đổi tên hay bị xoá. */
export interface SegmentMention {
  /** Đường dẫn phần tử: `actors[id=A01]`. */
  path: string
  array: string
  id: string
  /** Tên lúc import (nhắc theo tên); `null` khi chỉ nhắc theo mã. */
  name: string | null
}

/** Ảnh sơ đồ gốc (§4.13) trong một dãy nguyên văn — CR bỏ ảnh ⇒ in sơ đồ FlintFlow cùng loại tại chỗ. */
export interface SegmentDiagram {
  image_ref: string
  kind: OriginalDiagramKind
}

export type SegmentPart =
  | { kind: "original"; custom_id: string; diagrams: SegmentDiagram[]; mentions: SegmentMention[] }
  | { kind: "spine"; items: string[]; source_hash: string; blocks: CustomBlock[]; mentions: SegmentMention[] }

export interface SectionSegments {
  section_id: string
  parts: SegmentPart[]
  /** Mọi phần tử mục in ra lúc import + dấu — phần tử mới / đã đổi mà không thuộc đoạn nào ⇒ in cuối mục. */
  known: { key: string; hash: string }[]
}

/** Đoạn `spine` còn in nguyên văn: không có phần tử nào (luôn nguyên văn) hoặc dấu còn khớp. */
export const isVerbatim = (spine: Spine, part: Extract<SegmentPart, { kind: "spine" }>, names?: Map<string, string>): boolean =>
  part.items.length === 0 || segmentHash(spine, part.items, names) === part.source_hash

/** Mọi phần tử đã có chỗ in trong một đoạn của tài liệu (mục nào cũng được). */
export const homedItems = (records: readonly SectionSegments[]): Set<string> =>
  new Set(records.flatMap((r) => r.parts.flatMap((p) => (p.kind === "spine" ? p.items : []))))

/**
 * Tính lại dấu sau một lô ghi `by: import` (vd FLF-360 đọc lại ảnh sau khi có bản 0.1): đoạn chứa phần tử vừa ghi nhận dấu
 * mới (không bị coi là CR đã sửa), `known` cập nhật theo. `touched` = khoá phần tử vừa ghi; không truyền ⇒ tính lại hết.
 */
export const rehashSegments = (records: readonly SectionSegments[], spine: Spine, touched?: ReadonlySet<string>): SectionSegments[] => {
  const names = nameIndex(spine)
  const hit = (key: string) => !touched || touched.has(key)
  return records.map((r) => {
    const fresh = new Set(sectionItemKeys(spine, r.section_id))
    const known = new Map(r.known.map((k) => [k.key, k.hash]))
    for (const key of fresh) if (hit(key)) known.set(key, segmentItemHash(spine, key, names))
    return {
      ...r,
      parts: r.parts.map((p) => (p.kind === "spine" && p.items.some(hit) ? { ...p, source_hash: segmentHash(spine, p.items, names) } : p)),
      known: [...known].map(([key, hash]) => ({ key, hash }))
    }
  })
}

/** Khoá phần tử từ đường dẫn op (`business_rules[id=BR-01].statement` ⇒ `business_rules:BR-01`, `project.vision` ⇒ `project:vision`). */
export const segmentKeyOfPath = (path: string): string | null => {
  const project = /^project\.([a-z_]+)/.exec(path)
  if (project) return segmentItemKey("project", project[1])
  const m = /^([a-z_]+)\[id=([^\]]+)\]/.exec(path)
  return m ? segmentItemKey(m[1], m[2]) : null
}
