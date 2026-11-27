/**
 * Xem đề xuất của CR ngay trên tài liệu (FLF-495, contract #23b): dựng tài liệu từ Spine hiện tại và Spine sau CR (chạy khô
 * các đề xuất, không ghi Spine / file, không gọi AI, không vẽ hình), ghép block hai bản bằng bộ so block của màn so sánh
 * version rồi trả các mục có thay đổi kèm block ĐẦY ĐỦ của bản sau CR (block bị xoá chèn lại đúng chỗ) để FE tô lên tài liệu.
 *
 * Ghép block: `block_id` = `entity_path` (đoạn) nên cùng phần tử ghép đúng nhau; mục danh sách và dòng bảng ghép theo
 * `item_entity_paths` / `row_entity_paths`. Khối không gắn phần tử (heading, bảng nhiều phần tử, chữ nguyên văn của file) ghép
 * theo neo → LCS chữ → độ giống từ như màn so sánh version.
 */

import { createHash } from "node:crypto"
import { ApiError } from "../../shared/utils/api-error.js"
import { alignBlockLists, type AlignedPair, type DiffBlock } from "../doc-version/block-diff.js"
import { stripRecord } from "../import/check.service.js"
import { loadTemplateLayout } from "../render/assemble.service.js"
import { buildLayoutSections, type TemplateLayout } from "../render/layout-sections.js"
import type { Block, InlineRun, RenderedSection, TableCell } from "../render/rendered-document.types.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { ChangeLocation, type IChangeLocation } from "./change-location.model.js"
import type { IChangeRequest } from "./change-request.model.js"
import { spineAfterCr } from "./diagram-location.js"

export type DocChange = "unchanged" | "added" | "removed" | "modified" | "moved"

/** Dòng bảng: `cells` là dòng sau CR (dòng bị xoá: dòng cũ). `before` = chữ từng ô trước CR khi `modified`. */
export interface DocDiffRow {
  cells: TableCell[]
  change: DocChange
  before?: string[]
  /** Chỉ số ô đổi khi `modified`. */
  cells_changed?: number[]
  location_id?: string
}

/** Mục của danh sách gạch đầu dòng / đánh số. */
export interface DocDiffItem {
  runs: InlineRun[]
  change: DocChange
  before?: string
  location_id?: string
}

export interface DocDiffBlock {
  /** Block của bản sau CR (block bị xoá: block cũ). Bảng / danh sách vẽ theo `rows` / `items` ở dưới. */
  block: Block
  change: DocChange
  /** Chữ cũ khi `modified` (đoạn / tiêu đề). */
  before?: string
  location_id?: string
  rows?: DocDiffRow[]
  items?: DocDiffItem[]
  /** Chữ từng ô tiêu đề bảng trước CR, chỉ khi hàng tiêu đề đổi. */
  header_before?: string[]
}

export interface DocDiffSection {
  id: string
  number: string
  heading: string
  /** Chỉ khi tiêu đề mục đổi. */
  heading_before?: string
  level: number
  /** Vị trí `edit` của CR nằm ở mục này — FE cuộn tới mục khi một vị trí không có block / dòng riêng (dòng bảng không gắn phần tử). */
  location_ids: string[]
  /** `removed` / `added` khi cả mục bị xoá / thêm; còn lại `modified`. */
  change: "added" | "removed" | "modified"
  blocks: DocDiffBlock[]
}

export interface CrDocumentDiff {
  cr_id: string
  spine_version: number
  /** Số điểm đổi (block / dòng / mục danh sách có `change` ≠ unchanged), FE đánh số Trước / Sau theo thứ tự này. */
  change_count: number
  sections: DocDiffSection[]
}

export interface CrDocumentDiffDeps {
  loadSpine: (projectId: string) => Promise<Spine | null>
  loadLocations: (cr: Pick<IChangeRequest, "projectId" | "cr_id">) => Promise<IChangeLocation[]>
  loadTemplate: (projectId: string) => Promise<TemplateLayout | null>
}

const defaultDeps: CrDocumentDiffDeps = {
  loadSpine: async (projectId) => {
    const record = await spineRepository.get(projectId)
    return record ? stripRecord(record) : null
  },
  loadLocations: (cr) => ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }),
  loadTemplate: loadTemplateLayout
}

// ─── Block ⇒ DiffBlock ────────────────────────────────────────────

const runsText = (runs: readonly InlineRun[]): string => runs.map((r) => r.text).join("")
const cellsText = (cells: readonly TableCell[]): string[] => cells.map(runsText)
const hash = (text: string): string => createHash("sha1").update(text).digest("hex")

const diffBlock = (kind: DiffBlock["kind"], text: string, blockId: string | null, section: string): DiffBlock => ({
  block_id: blockId,
  text,
  text_hash: hash(`${kind}\n${text}`),
  kind,
  section,
  section_key: section
})

/** Trùng `entity_path` (một phần tử in hai lần) ⇒ thêm `#n` để neo vẫn là duy nhất. */
const uniqueIds = (): ((id: string | null | undefined) => string | null) => {
  const seen = new Map<string, number>()
  return (id) => {
    if (!id) return null
    const n = seen.get(id) ?? 0
    seen.set(id, n + 1)
    return n === 0 ? id : `${id}#${n}`
  }
}

/** Đơn vị so của một mục: block thật (bỏ ảnh / ngắt trang — chế độ này không vẽ hình). */
const comparable = (blocks: readonly Block[]): Block[] => blocks.filter((b) => b.type !== "image" && b.type !== "page_break")

/**
 * Block render của một mục ⇒ `DiffBlock` (hàm thuần). `block_id` = `entity_path` của đoạn; heading, danh sách và bảng không
 * có neo (ghép theo chữ), phần tử con của chúng ghép riêng ở `itemBlocks` / `rowBlocks`.
 */
export const renderedToDiffBlocks = (blocks: readonly Block[], sectionKey = ""): DiffBlock[] => {
  const id = uniqueIds()
  return comparable(blocks).map((b) => {
    switch (b.type) {
      case "heading":
        return diffBlock("heading", b.text, null, sectionKey)
      case "paragraph":
        return diffBlock("paragraph", runsText(b.runs), id(b.entity_path), sectionKey)
      case "bullet_list":
      case "numbered_list":
        // Kiểu "table" để bộ so ghép danh sách lẻ giữa hai khối đã khớp thành một danh sách bị sửa (mục ngắn khó đạt ngưỡng giống từ)
        return diffBlock("table", b.items.map(runsText).join("\n"), null, sectionKey)
      case "table":
        return diffBlock("table", [cellsText(b.header).join(" | "), ...b.rows.map((r) => cellsText(r).join(" | "))].join("\n"), null, sectionKey)
      default:
        return diffBlock("paragraph", "", null, sectionKey)
    }
  })
}

/** Mục danh sách ⇒ `DiffBlock` (neo = `item_entity_paths`). */
const itemBlocks = (items: readonly InlineRun[][], paths: readonly (string | null)[] | undefined): DiffBlock[] => {
  const id = uniqueIds()
  return items.map((runs, k) => diffBlock("paragraph", runsText(runs), id(paths?.[k]), ""))
}

/** Dòng bảng ⇒ `DiffBlock` (neo = `row_entity_paths`). */
const rowBlocks = (rows: readonly TableCell[][], paths: readonly (string | null)[] | undefined): DiffBlock[] => {
  const id = uniqueIds()
  return rows.map((cells, k) => diffBlock("paragraph", cellsText(cells).join(" | "), id(paths?.[k]), ""))
}

// ─── Gắn vị trí của CR ────────────────────────────────────────────

type LocationRef = Pick<IChangeLocation, "location_id" | "path" | "entity_paths" | "section_id" | "conclusion" | "proposal">

/** `use_cases[id=UC11].name` ⇒ `use_cases[id=UC11]`; `use_cases[]` + value.id ⇒ `use_cases[id=<id>]`. */
const elementOfOp = (op: unknown): string | null => {
  if (typeof op !== "object" || op === null) return null
  const { path, value } = op as { path?: unknown; value?: unknown }
  if (typeof path !== "string") return null
  const added = /^(\w+)\[\]$/.exec(path)
  if (added) {
    const id = typeof value === "object" && value !== null ? (value as { id?: unknown }).id : undefined
    return typeof id === "string" && id ? `${added[1]}[id=${id}]` : null
  }
  return /^[\w.]*?\w+\[[^\]]*\]/.exec(path)?.[0] ?? null
}

/** Phần tử Spine mà một vị trí chạm: chính nó, `entity_paths` và phần tử trong từng op đề xuất. */
const touchedElements = (loc: LocationRef): string[] => [
  loc.path,
  ...loc.entity_paths,
  ...(loc.proposal?.spine_ops ?? []).flatMap((op) => {
    const el = elementOfOp(op)
    return el ? [el] : []
  })
]

/** Từ `entity_path` của block / dòng sang `location_id` (vị trí `edit` chạm phần tử đó), rồi theo mục chứa nó. */
export const locationResolver = (locations: readonly LocationRef[]): ((entityPath: string | null | undefined, sectionId: string) => string | undefined) => {
  const edits = locations.filter((l) => l.conclusion === "edit")
  const byElement = new Map<string, string>()
  for (const loc of edits) for (const el of touchedElements(loc)) if (!byElement.has(el)) byElement.set(el, loc.location_id)
  return (entityPath, sectionId) => {
    if (entityPath) {
      const exact = byElement.get(entityPath)
      if (exact) return exact
      for (const [el, id] of byElement) if (entityPath.startsWith(el) || el.startsWith(entityPath)) return id
    }
    // Mục có nhiều vị trí mà không biết phần tử nào ⇒ không đoán (gán nhầm vị trí); FE vẫn cuộn tới mục qua `location_ids`
    const inSection = edits.filter((l) => l.section_id === sectionId)
    return inSection.length === 1 ? inSection[0].location_id : undefined
  }
}

// ─── So từng mục ──────────────────────────────────────────────────

const countChanges = (blocks: readonly DocDiffBlock[]): number =>
  blocks.reduce((n, b) => {
    const inner = (b.rows ?? b.items ?? []).filter((x) => x.change !== "unchanged").length + (b.header_before ? 1 : 0)
    return n + (b.rows || b.items ? inner : b.change === "unchanged" ? 0 : 1)
  }, 0)

/**
 * Trong một dãy liền nhau toàn khối thêm / xoá, khối bị xoá đứng trước khối thêm: bản cũ rồi bản mới (bộ so chỉ chèn khối xoá
 * trước khối đã khớp kế tiếp nên khối xoá thường tụt xuống cuối dãy).
 */
const settle = (pairs: readonly AlignedPair[]): AlignedPair[] => {
  const out: AlignedPair[] = []
  let run: AlignedPair[] = []
  const flush = (): void => {
    out.push(...run.filter((p) => p.change === "removed"), ...run.filter((p) => p.change !== "removed"))
    run = []
  }
  for (const p of pairs) {
    if (p.change === "added" || p.change === "removed") run.push(p)
    else {
      flush()
      out.push(p)
    }
  }
  flush()
  return out
}

const cellsChanged = (before: readonly string[], after: readonly string[]): number[] => {
  const out: number[] = []
  for (let c = 0; c < Math.max(before.length, after.length); c++) if ((before[c] ?? "").trim() !== (after[c] ?? "").trim()) out.push(c)
  return out
}

/**
 * Chuẩn hoá cặp của bộ so: đổi thứ tự thuần (`moved` mà chữ y nguyên) không phải thay đổi nội dung ⇒ `unchanged`; vừa đổi chỗ
 * vừa đổi chữ ⇒ `modified` (không được nuốt chỗ sửa); cặp khác loại block (danh sách ↔ bảng, đánh số ↔ gạch đầu dòng) ⇒ xoá khối
 * cũ + thêm khối mới; khối xoá đứng trước khối thêm.
 */
const normalizePairs = (
  pairs: readonly AlignedPair[],
  before: readonly DiffBlock[],
  after: readonly DiffBlock[],
  compatible: (beforeIndex: number, afterIndex: number) => boolean = () => true
): AlignedPair[] =>
  settle(
    pairs.flatMap((p): AlignedPair[] => {
      if (p.before === null || p.after === null) return [p]
      if (!compatible(p.before, p.after)) return [{ before: p.before, after: null, change: "removed" }, { before: null, after: p.after, change: "added" }]
      if (p.change === "moved") return [{ ...p, change: before[p.before].text_hash === after[p.after].text_hash ? "unchanged" : "modified" }]
      return [p]
    })
  )

/** Cặp của hai danh sách con (mục / dòng). */
const alignChildren = (before: DiffBlock[], after: DiffBlock[]): AlignedPair[] => normalizePairs(alignBlockLists(before, after).pairs, before, after)

const diffTable = (
  before: Extract<Block, { type: "table" }> | undefined,
  after: Extract<Block, { type: "table" }> | undefined,
  locate: (path: string | null | undefined) => string | undefined
): DocDiffRow[] => {
  const b = before?.rows ?? []
  const a = after?.rows ?? []
  return alignChildren(rowBlocks(b, before?.row_entity_paths), rowBlocks(a, after?.row_entity_paths)).map((p): DocDiffRow => {
    const cells = (p.after !== null ? a[p.after] : b[p.before as number]) as TableCell[]
    const path = p.after !== null ? after?.row_entity_paths?.[p.after] : before?.row_entity_paths?.[p.before as number]
    const location_id = p.change === "unchanged" ? undefined : locate(path)
    if (p.change !== "modified") return { cells, change: p.change, ...(location_id ? { location_id } : {}) }
    const old = cellsText(b[p.before as number])
    return { cells, change: "modified", before: old, cells_changed: cellsChanged(old, cellsText(cells)), ...(location_id ? { location_id } : {}) }
  })
}

const diffList = (
  before: Extract<Block, { type: "bullet_list" | "numbered_list" }> | undefined,
  after: Extract<Block, { type: "bullet_list" | "numbered_list" }> | undefined,
  locate: (path: string | null | undefined) => string | undefined
): DocDiffItem[] => {
  const b = before?.items ?? []
  const a = after?.items ?? []
  return alignChildren(itemBlocks(b, before?.item_entity_paths), itemBlocks(a, after?.item_entity_paths)).map((p): DocDiffItem => {
    const runs = (p.after !== null ? a[p.after] : b[p.before as number]) as InlineRun[]
    const path = p.after !== null ? after?.item_entity_paths?.[p.after] : before?.item_entity_paths?.[p.before as number]
    const location_id = p.change === "unchanged" ? undefined : locate(path)
    return {
      runs,
      change: p.change,
      ...(p.change === "modified" ? { before: runsText(b[p.before as number]) } : {}),
      ...(location_id ? { location_id } : {})
    }
  })
}

/** Bỏ `entity_path` thô (id nội bộ của Spine) khỏi block trả ra — FE chỉ cần `location_id`. */
const stripPaths = (block: Block): Block => {
  switch (block.type) {
    case "paragraph": {
      const { entity_path: _p, ...rest } = block
      return rest
    }
    case "bullet_list":
    case "numbered_list": {
      const { item_entity_paths: _i, ...rest } = block
      return rest
    }
    case "table": {
      const { row_entity_paths: _r, ...rest } = block
      return rest
    }
    default:
      return block
  }
}

const entityPathOf = (block: Block): string | undefined => (block.type === "paragraph" ? block.entity_path : undefined)

/** So hai bản của một mục (một trong hai có thể vắng: mục bị xoá / mới thêm). */
export const diffSection = (
  before: RenderedSection | undefined,
  after: RenderedSection | undefined,
  resolve: (entityPath: string | null | undefined, sectionId: string) => string | undefined,
  sectionLocationIds: (sectionId: string) => string[] = () => []
): DocDiffSection | null => {
  const sectionId = (after ?? before)!.id
  const locate = (path: string | null | undefined): string | undefined => resolve(path, sectionId)
  const b = comparable(before?.blocks ?? [])
  const a = comparable(after?.blocks ?? [])
  const beforeBlocks = renderedToDiffBlocks(b)
  const afterBlocks = renderedToDiffBlocks(a)
  const pairs = normalizePairs(alignBlockLists(beforeBlocks, afterBlocks).pairs, beforeBlocks, afterBlocks, (i, j) => b[i].type === a[j].type)
  const out: DocDiffBlock[] = []
  for (const p of pairs) {
    const block = (p.after !== null ? a[p.after] : b[p.before as number]) as Block
    const old = p.before !== null ? b[p.before] : undefined
    const change: DocChange = p.change === "moved" ? "unchanged" : p.change
    if (block.type === "table") {
      const rows = diffTable(old?.type === "table" ? old : undefined, p.after !== null ? (block as Extract<Block, { type: "table" }>) : undefined, locate)
      const headerBefore = old?.type === "table" && p.after !== null && cellsText(old.header).join("") !== cellsText(block.header).join("") ? cellsText(old.header) : undefined
      const touched = rows.some((r) => r.change !== "unchanged") || !!headerBefore
      out.push({
        block: stripPaths(block),
        change: touched ? (p.before === null ? "added" : p.after === null ? "removed" : "modified") : "unchanged",
        rows,
        ...(headerBefore ? { header_before: headerBefore } : {})
      })
      continue
    }
    if (block.type === "bullet_list" || block.type === "numbered_list") {
      const items = diffList(
        old && old.type === block.type ? old : undefined,
        p.after !== null ? (block as Extract<Block, { type: "bullet_list" | "numbered_list" }>) : undefined,
        locate
      )
      const touched = items.some((i) => i.change !== "unchanged")
      out.push({ block: stripPaths(block), change: touched ? (p.before === null ? "added" : p.after === null ? "removed" : "modified") : "unchanged", items })
      continue
    }
    const location_id = change === "unchanged" ? undefined : locate(entityPathOf(block))
    out.push({
      block: stripPaths(block),
      change,
      ...(change === "modified" && old ? { before: old.type === "paragraph" ? runsText(old.runs) : old.type === "heading" ? old.text : undefined } : {}),
      ...(location_id ? { location_id } : {})
    })
  }
  const headingChanged = !!before && !!after && before.heading !== after.heading
  const touched = countChanges(out) > 0 || headingChanged
  if (!touched) return null
  const shown = (after ?? before)!
  return {
    id: shown.id,
    number: shown.number,
    heading: shown.heading,
    ...(headingChanged ? { heading_before: before!.heading } : {}),
    level: shown.level,
    location_ids: sectionLocationIds(sectionId),
    change: !before ? "added" : !after ? "removed" : "modified",
    blocks: out
  }
}

/** Thứ tự mục: theo bản sau CR, mục chỉ có ở bản trước chèn trước mục đứng sau nó (như khối bị xoá). */
const sectionOrder = (before: readonly RenderedSection[], after: readonly RenderedSection[]): string[] => {
  const beforeIndex = new Map(before.map((s, i) => [s.id, i]))
  const afterIds = new Set(after.map((s) => s.id))
  const out: string[] = []
  const emitted = new Set<string>()
  const flush = (upTo: number): void => {
    before.forEach((s, i) => {
      if (i < upTo && !afterIds.has(s.id) && !emitted.has(s.id)) {
        emitted.add(s.id)
        out.push(s.id)
      }
    })
  }
  for (const s of after) {
    const i = beforeIndex.get(s.id)
    if (i !== undefined) flush(i)
    out.push(s.id)
  }
  flush(before.length)
  return out
}

export const diffSections = (
  before: readonly RenderedSection[],
  after: readonly RenderedSection[],
  resolve: (entityPath: string | null | undefined, sectionId: string) => string | undefined,
  sectionLocationIds: (sectionId: string) => string[] = () => []
): DocDiffSection[] => {
  const beforeById = new Map(before.map((s) => [s.id, s]))
  const afterById = new Map(after.map((s) => [s.id, s]))
  return sectionOrder(before, after).flatMap((id) => {
    const section = diffSection(beforeById.get(id), afterById.get(id), resolve, sectionLocationIds)
    return section ? [section] : []
  })
}

// ─── Dựng + cache ─────────────────────────────────────────────────

const noImage = (): undefined => undefined

const layoutSections = (spine: Spine, template: TemplateLayout): RenderedSection[] => buildLayoutSections(spine, template, [], { diagramPng: noImage }).sections

const DOCUMENT_DIFF_CACHE_MAX = 50
const diffCache = new Map<string, CrDocumentDiff>()

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex")

/** Chỉ cho test. */
export const _clearDocumentDiffCache = (): void => diffCache.clear()

/**
 * Khoá: dự án + phiên bản Spine + đề xuất của mọi vị trí (đổi đề xuất / kết luận ⇒ khác) + layout mẫu (gồm ngôn ngữ tài
 * liệu). Spine đổi (người khác ghi) hoặc đề xuất soạn lại ⇒ khoá khác, không bao giờ trả bản cũ.
 */
const cacheKey = (projectId: string, spine: Spine, locations: readonly LocationRef[], template: TemplateLayout): string =>
  digest([
    projectId,
    spine.spine_version,
    [...locations]
      .sort((x, y) => x.location_id.localeCompare(y.location_id))
      .map((l) => [l.location_id, l.path, l.section_id, l.entity_paths, l.conclusion, l.proposal?.spine_ops ?? []]),
    template
  ])

export const crDocumentDiff = async (
  cr: Pick<IChangeRequest, "projectId" | "cr_id">,
  deps: CrDocumentDiffDeps = defaultDeps
): Promise<CrDocumentDiff> => {
  const projectId = String(cr.projectId)
  const spine = await deps.loadSpine(projectId)
  if (!spine) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const template = await deps.loadTemplate(projectId)
  // Dự án không theo layout file: chế độ này chỉ dành cho tài liệu import (CR chế độ 1) ⇒ không có gì để tô
  if (!template) return { cr_id: cr.cr_id, spine_version: spine.spine_version, change_count: 0, sections: [] }
  const locations = await deps.loadLocations(cr)

  const key = cacheKey(projectId, spine, locations, template)
  const hit = diffCache.get(key)
  if (hit) {
    diffCache.delete(key)
    diffCache.set(key, hit)
    return hit
  }

  const sections = diffSections(
    layoutSections(spine, template),
    layoutSections(spineAfterCr(spine, locations), template),
    locationResolver(locations),
    (sectionId) => locations.filter((l) => l.conclusion === "edit" && l.section_id === sectionId).map((l) => l.location_id)
  )
  const result: CrDocumentDiff = {
    cr_id: cr.cr_id,
    spine_version: spine.spine_version,
    change_count: sections.reduce((n, s) => n + countChanges(s.blocks) + (s.heading_before ? 1 : 0), 0),
    sections
  }
  diffCache.set(key, result)
  if (diffCache.size > DOCUMENT_DIFF_CACHE_MAX) diffCache.delete(diffCache.keys().next().value as string)
  return result
}
