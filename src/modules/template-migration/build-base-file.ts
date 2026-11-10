/**
 * Dựng file nền mới cho lần đổi mẫu: package mẫu đích chứa nội dung cũ theo nhóm và quyết định của BA. Chưa ghi gì vào dự án
 * (Spine, profile, version) — chỉ trả `buffer` + báo cáo từng mục để bước áp dụng quyết định tiếp.
 *
 *  - Mục khớp + nguyên vẹn: chép khối OOXML của file nền cũ dưới heading mẫu đích (`ooxml-transplant`).
 *  - Mục CR đã sửa / cần dịch / đổi ngược mà đã sửa sau lần đổi mẫu trước: để heading + chữ hướng dẫn của mẫu, rồi dựng từ Spine
 *    bằng writer mẫu hiện có (`writeTemplateDocx`) — chỉ những mục đó, các mục đã chép được đánh dấu `keepSource` nên không bị đụng.
 *  - Mục thiếu: giữ heading + chữ hướng dẫn của mẫu, không nội dung.
 *  - Mục thừa / conflict: theo quyết định (giữ thành mục riêng, chuyển vào mục thiếu, xoá, bảng ghép theo tiêu đề cột).
 *  - Mục chép lỗi: dựng từ Spine + cờ vàng trong báo cáo, không làm hỏng cả file. Kiểm cấu trúc cuối file còn lỗi ⇒ dựng lại
 *    toàn file từ Spine một lần.
 * Không có file nền (chế độ 2, `converted_from = fpt`, `start_kind = new`, chế độ 4) ⇒ `source = null`, mọi mục dựng từ Spine.
 */
import { DocxPackage, OoxmlError, readBlocks } from "../docx-ooxml/index.js"
import { NS, insertAfter, isW, removeNode, wAll, wEl, wKid, wKids, wText } from "../docx-ooxml/xml.js"
import { parseDocument } from "../import/parse.service.js"
import type { RenderedDocument } from "../render/rendered-document.types.js"
import { writeTemplateDocx } from "../render/template-docx-writer.js"
import { columnIdentity, DROP_FROM_PRINT, RECORD_OF_CHANGES, type MigrationGroups } from "./classify.js"
import { UNMAPPED_SECTION } from "../import/import.constants.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { createTransplanter, enforceRelsAllowList, pruneUnreferencedParts, validateDocxStructure, type DroppedItem } from "./ooxml-transplant.js"
import type { NewHeading, OldHeading, PairingResult } from "./pair-sections.js"

// ─── kiểu công khai ──────────────────────────────────────────────

export interface BaseFileSource {
  /** File nền hiện tại (đổi xuôi) hoặc file nền trước lần đổi mẫu (đổi ngược). */
  buffer: Buffer
  /**
   * `old_key` của từng heading trong file nguồn theo thứ tự tài liệu (heading có `level`, không tính phần nối) — người gọi suy từ
   * layout của profile. `null` = heading không thuộc mục nào (đi theo mục trước).
   */
  headingKeys: readonly (string | null)[]
}

/** Dựng bản in từ Spine cho các mục của mẫu đích (id mục = `section_id` của heading mẫu đích / mục riêng). */
export type SpineRenderer = (sectionIds: readonly string[]) => Promise<RenderedDocument>

export interface BuildBaseFileInput {
  /** File mẫu đích. */
  target: Buffer
  /** Heading của mẫu đích (`key = n<vị trí>`), cùng thứ tự với heading của file. */
  targetHeadings: readonly NewHeading[]
  oldHeadings: readonly OldHeading[]
  pairing: PairingResult
  groups: MigrationGroups
  decisions: readonly { id: string; choice: string }[]
  direction: "forward" | "reverse"
  source: BaseFileSource | null
  /** Đổi xuôi: `old_key` của mục đã bị CR sửa sau import — dựng từ Spine. */
  spineOnly?: ReadonlySet<string>
  /** Đổi xuôi sang mẫu khác ngôn ngữ: mọi mục dựng từ Spine (đã dịch). */
  needsTranslation?: boolean
  renderFromSpine?: SpineRenderer
  /** Số dòng Record of Changes có sẵn trong file nền (không ghi lại khi bảng đã được chép). */
  legacyRecordCount?: number
  /**
   * Đổi ngược: `target` là **bản chụp file nền trước lần đổi mẫu** (đúng file cũ, nguyên khối). Mục chưa sửa / chọn `discard` giữ
   * nguyên văn khối của bản chụp (không chép lại, không dịch lại); chỉ mục đã sửa dựng từ Spine, mục riêng / chuyển được chép từ
   * `source` (file nền hiện tại).
   */
  targetIsSnapshot?: boolean
  /** Bỏ file nền, dựng toàn bộ từ Spine (đường lùi khi file kết quả không qua kiểm cấu trúc). */
  forceSpine?: boolean
  /** Spine có phần tử (chức năng / use case / tính năng / màn): heading ví dụ của mẫu bỏ đi dù file cũ không có heading phần tử (dự án FPT / từ Spine). */
  hasSpineElements?: boolean
}

export type SectionMode = "transplant" | "table_mapped" | "spine" | "guidance" | "restored" | "custom" | "moved" | "removed"

export interface SectionReport {
  /** `new_key` của mẫu đích; mục riêng dùng `old_key`. */
  key: string
  old_key: string | null
  new_key: string | null
  /** `section_id` của heading mẫu đích (mục riêng: của heading cũ). */
  section_id: string
  mode: SectionMode
  /** `yellow`: chép khối lỗi hoặc dựng từ Spine không được — BA cần kiểm mục này. */
  flag?: "yellow"
  reason?: string
  dropped: DroppedItem[]
  warnings: string[]
}

export interface BuildBaseFileResult {
  buffer: Buffer
  sections: SectionReport[]
  /** Tổng hợp phần bị bỏ khỏi file (OLE, UNC, attachedTemplate…). */
  dropped: DroppedItem[]
  /** Vấn đề cấu trúc còn lại (rỗng = ổn). */
  problems: string[]
  warnings: string[]
  /** Đã dựng lại toàn file từ Spine vì kết quả chép khối không qua kiểm cấu trúc. */
  fellBackToSpine: boolean
}

export class BuildBaseFileError extends Error {
  constructor(
    readonly code: "target_headings_mismatch" | "target_unreadable",
    message: string
  ) {
    super(message)
  }
}

// ─── helper DOM ──────────────────────────────────────────────────

const hasPageBreak = (p: Element): boolean => wAll(p, "br").some((b) => (b.getAttributeNS(NS.w, "type") ?? b.getAttribute("w:type")) === "page")
const hasSectPr = (p: Element): boolean => wAll(p, "sectPr").length > 0
const hasField = (p: Element): boolean => ["fldChar", "fldSimple", "instrText"].some((n) => wAll(p, n).length > 0)
const hasVisible = (p: Element): boolean => wAll(p, "t").some((t) => t.textContent?.trim()) || ["drawing", "pict", "object"].some((n) => wAll(p, n).length > 0)

/** Đoạn chỉ để ngắt trang / section của file cũ — không chép sang (mẫu mới tự quyết định ngắt trang). */
const isLayoutOnly = (n: Element): boolean => isW(n, "p") && (hasSectPr(n) || hasPageBreak(n)) && !hasVisible(n)

/** Chữ hướng dẫn / bảng mẫu dưới heading mẫu đích: bỏ khi mục đã có nội dung thật. Ngắt trang / section / mục lục giữ nguyên. */
const isGuidance = (n: Element): boolean => isW(n, "tbl") || (isW(n, "p") && !hasSectPr(n) && !hasPageBreak(n) && !hasField(n))

const elementsAfter = (el: Element, stop: (n: Element) => boolean): Element[] => {
  const out: Element[] = []
  for (let n = el.nextSibling; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue
    const e = n as Element
    if (isW(e, "sectPr") || stop(e)) break
    out.push(e)
  }
  return out
}

const cellText = (tc: Element): string =>
  wKids(tc, "p")
    .map((p) => wAll(p, "t").map((t) => t.textContent ?? "").join(""))
    .join("\n")

const rowTexts = (tr: Element): string[] => wKids(tr, "tc").map(cellText)

/** Ghi chữ vào ô: giữ pPr / rPr của đoạn + run đầu của ô mẫu (định dạng của mẫu đích), mỗi dòng một đoạn. */
const setCellText = (tc: Element, text: string): void => {
  const doc = tc.ownerDocument
  const first = wKids(tc, "p")[0]
  const pPr = first && wKid(first, "pPr")
  const run = first && wKids(first, "r")[0]
  const rPr = run && wKid(run, "rPr")
  for (const p of wKids(tc, "p")) removeNode(p)
  for (const line of text.split("\n")) {
    const p = wEl(doc, "p")
    if (pPr) p.appendChild(pPr.cloneNode(true))
    if (line) {
      const r = wEl(doc, "r")
      if (rPr) r.appendChild(rPr.cloneNode(true))
      r.appendChild(wText(doc, "t", line))
      p.appendChild(r)
    }
    tc.appendChild(p)
  }
}

/** Ghi bảng cũ vào bảng mẫu đích: cột ghép theo định danh tiêu đề, cột mới của mẫu để trống, giữ hàng tiêu đề + định dạng hàng của mẫu. */
const fillTable = (target: Element, source: Element, sectionId: string): void => {
  const srcRows = wKids(source, "tr")
  if (!srcRows.length) return
  fillRows(target, rowTexts(srcRows[0]).map((h) => columnIdentity(h, null, sectionId)), srcRows.slice(1).map(rowTexts), sectionId)
}

/** Ghi các dòng (đã biết định danh cột nguồn) vào bảng mẫu đích: giữ hàng tiêu đề, dòng mẫu đầu tiên làm khuôn, bỏ mọi dòng mẫu còn lại. */
const fillRows = (target: Element, srcIds: readonly string[], rows: readonly (readonly string[])[], sectionId: string): void => {
  const trs = wKids(target, "tr")
  if (!trs.length) return
  const tgtIds = rowTexts(trs[0]).map((h) => columnIdentity(h, null, sectionId))
  const used = new Set<number>()
  const map = tgtIds.map((id) => {
    const at = srcIds.findIndex((s, i) => s === id && !used.has(i))
    if (at >= 0) used.add(at)
    return at
  })
  const prototype = (trs[1] ?? trs[0]).cloneNode(true) as Element
  for (const tr of trs.slice(1)) removeNode(tr)
  for (const values of rows) {
    const tr = prototype.cloneNode(true) as Element
    wKids(tr, "tc").forEach((tc, i) => setCellText(tc, map[i] !== undefined && map[i] >= 0 ? values[map[i]] ?? "" : ""))
    target.appendChild(tr)
  }
}

/** Mức trùng cột giữa hai bảng (theo định danh tiêu đề). */
const columnOverlap = (a: Element, b: Element, sectionId: string): number => {
  const ids = (t: Element): string[] => (wKids(t, "tr")[0] ? rowTexts(wKids(t, "tr")[0]).map((h) => columnIdentity(h, null, sectionId)) : [])
  const bs = new Set(ids(b))
  return ids(a).filter((id) => bs.has(id)).length
}

// ─── kế hoạch ────────────────────────────────────────────────────

type TableAction = "none" | "map" | "keep" | "drop"

interface Placement {
  oldKey: string
  tableAction: TableAction
  notes: string[]
  /** `move_to`: bỏ heading cũ, chỉ chuyển phần thân vào mục thiếu của mẫu đích. */
  moved: boolean
}

interface CustomPlan {
  oldKey: string
  notes: string[]
}

const TABLE_CONFLICTS = new Set(["table_columns", "record_of_changes"])

/** Phần của đầu vào đủ để lập kế hoạch đặt mục (không cần file). */
export type PlanInput = Pick<BuildBaseFileInput, "targetHeadings" | "oldHeadings" | "pairing" | "groups" | "decisions" | "targetIsSnapshot" | "hasSpineElements">

const planOf = (input: PlanInput): { byNew: Map<string, Placement[]>; customs: CustomPlan[]; removed: { oldKey: string; reason: string }[] } => {
  const decision = new Map(input.decisions.map((d) => [d.id, d.choice]))
  const conflictsOf = new Map<string, MigrationGroups["conflict"]>()
  for (const c of input.groups.conflict) conflictsOf.set(c.old_key, [...(conflictsOf.get(c.old_key) ?? []), c])
  const validNew = new Set(input.targetHeadings.map((h) => h.key))
  const byNew = new Map<string, Placement[]>()
  const customs: CustomPlan[] = []
  const removed: { oldKey: string; reason: string }[] = []
  const add = (newKey: string, p: Placement): void => void byNew.set(newKey, [...(byNew.get(newKey) ?? []), p])
  const dropped = new Set(input.groups.structure_only_dropped)

  for (const pair of input.pairing.pairs) {
    const notes: string[] = []
    if (pair.new_key && validNew.has(pair.new_key)) {
      let newKey = pair.new_key
      let tableAction: TableAction = "none"
      for (const c of conflictsOf.get(pair.old_key) ?? []) {
        const choice = decision.get(c.id)
        if (choice === "ai_resolve") notes.push("ai_resolve chưa chạy ở bước dựng file: dùng cách ghép tự động")
        if (TABLE_CONFLICTS.has(c.kind)) tableAction = choice === "keep_old_table" || choice === "keep_custom" ? "keep" : choice === "delete" || choice === DROP_FROM_PRINT ? "drop" : "map"
        else if (c.kind === "split_section" && choice?.startsWith("to:") && validNew.has(choice.slice(3))) newKey = choice.slice(3)
      }
      add(newKey, { oldKey: pair.old_key, tableAction, notes, moved: false })
      continue
    }
    if (dropped.has(pair.old_key)) {
      removed.push({ oldKey: pair.old_key, reason: "Heading nhóm không còn ở mẫu đích" })
      continue
    }
    const extra = decision.get(`e:${pair.old_key}`) ?? decision.get(`c:record_of_changes:${pair.old_key}`)
    if (extra === "delete" || extra === DROP_FROM_PRINT) removed.push({ oldKey: pair.old_key, reason: extra === DROP_FROM_PRINT ? "BA chọn bỏ khỏi bản in (dữ liệu giữ trong Spine)" : "BA chọn xoá" })
    else if (extra?.startsWith("move_to:") && validNew.has(extra.slice(8))) add(extra.slice(8), { oldKey: pair.old_key, tableAction: "none", notes, moved: true })
    else {
      if (extra === undefined) notes.push("Chưa có quyết định cho mục này: giữ thành mục riêng để không mất nội dung")
      if (extra === "ai_resolve") notes.push("ai_resolve chưa chạy ở bước dựng file: giữ thành mục riêng")
      customs.push({ oldKey: pair.old_key, notes })
    }
  }
  return { byNew, customs, removed }
}

// ─── layout dự kiến của file kết quả ─────────────────────────────

/** Một mục của layout mới theo thứ tự tài liệu (heading rỗng = phần nối). */
export interface PlannedLayoutEntry {
  heading_text: string
  level: number
  section_id: string
  kind: "target" | "moved" | "custom" | "follower"
  new_key: string | null
  old_key: string | null
  /** Mục thiếu của mẫu đích (trống + chữ hướng dẫn của mẫu). */
  missing: boolean
  guidance: string | null
}

export interface PlannedLayout {
  entries: PlannedLayoutEntry[]
  /** Heading của mẫu đích không có `section_id` (mục riêng của mẫu) và chưa có cặp: cần một mục riêng trống trong Spine. */
  newCustoms: { section_id: string; heading_text: string; level: number }[]
}

/**
 * Layout của file kết quả suy ra từ kế hoạch (cùng `planOf` và cùng thứ tự đặt với `buildOnce`), không cần file: bước áp dụng cần nó
 * trước khi dựng — bản in từ Spine của mục trong file phải theo đúng layout mới. Phần tử / phần nối đi theo mục cha của chúng.
 * `nextCustomId` cấp id `custom:*` cho heading riêng của mẫu chưa có cặp.
 */
export const planLayout = (input: PlanInput, nextCustomId: () => string): PlannedLayout => {
  const { byNew, customs } = planOf(input)
  const { targetHeadings, pairing } = input
  const oldByKey = new Map(input.oldHeadings.map((h) => [h.key, h]))
  const indexOfKey = new Map(targetHeadings.map((h, i) => [h.key, i]))
  const snapshot = !!input.targetIsSnapshot
  const suppressExamples = !snapshot && examplesSuppressed(pairing, input.hasSpineElements)
  /** Mỗi mục đích: phần đầu (heading + phần tử đi kèm), phần chuyển vào, phần mục riêng giữ lại. */
  const slots = targetHeadings.map(() => ({ head: [] as PlannedLayoutEntry[], moved: [] as PlannedLayoutEntry[], custom: [] as PlannedLayoutEntry[] }))
  const tail: PlannedLayoutEntry[] = []
  const newCustoms: PlannedLayout["newCustoms"] = []
  /** Nơi nhận phần tử / phần nối của từng mục cũ: chúng nằm vật lý sau mục cũ đứng ngay trước chúng, đúng như vùng chép khối. */
  const containerOf = new Map<string, PlannedLayoutEntry[]>()

  targetHeadings.forEach((heading, i) => {
    const all = byNew.get(heading.key) ?? []
    const pairPl = all.filter((p) => !p.moved)
    const movedPl = all.filter((p) => p.moved)
    const level = heading.level ?? 1
    if (!pairPl.length) {
      if (!(pairing.ignored_new.includes(heading.key) && suppressExamples)) {
        // Bản chụp: heading là của chính file cũ (đã có id mục thật), không phải mục thiếu của mẫu
        const unmapped = heading.section_id === UNMAPPED_SECTION && !snapshot
        const id = unmapped ? `custom:${nextCustomId()}` : heading.section_id
        if (unmapped) newCustoms.push({ section_id: id, heading_text: heading.heading_text, level })
        slots[i].head.push({ heading_text: heading.heading_text, level, section_id: id, kind: "target", new_key: heading.key, old_key: null, missing: !movedPl.length && !snapshot, guidance: heading.guidance ?? null })
      }
    } else {
      const first = oldByKey.get(pairPl[0].oldKey)
      // Heading mẫu đích có `section_id` thì giữ; mục riêng của mẫu ghép với mục cũ thì mang id của mục cũ (dữ liệu nằm ở đó)
      const id = heading.section_id === UNMAPPED_SECTION ? (first?.section_id ?? heading.section_id) : heading.section_id
      slots[i].head.push({ heading_text: heading.heading_text, level, section_id: id, kind: "target", new_key: heading.key, old_key: pairPl[0].oldKey, missing: false, guidance: null })
      for (const pl of pairPl) containerOf.set(pl.oldKey, slots[i].head)
    }
    for (const m of movedPl) {
      const old = oldByKey.get(m.oldKey)
      if (!old) continue
      slots[i].moved.push(entryOf(old, "moved", heading.key))
      containerOf.set(old.key, slots[i].moved)
    }
  })

  // Mục riêng giữ lại: sau mục có cặp đứng trước nó trong tài liệu cũ, chưa có mục nào đứng trước ⇒ cuối tài liệu
  const placed = new Map<string, number>()
  for (const [newKey, ps] of byNew) for (const p of ps) if (!p.moved) placed.set(p.oldKey, indexOfKey.get(newKey)!)
  const customKeys = new Set(customs.map((c) => c.oldKey))
  let last: number | null = null
  for (const old of input.oldHeadings) {
    const at = placed.get(old.key)
    if (at !== undefined) {
      last = at
      continue
    }
    if (!customKeys.has(old.key)) continue
    const dest = last === null ? tail : slots[last].custom
    dest.push(entryOf(old, "custom", null))
    containerOf.set(old.key, dest)
  }

  // Phần tử / phần nối đi theo mục đứng ngay trước chúng trong tài liệu cũ. Bản chụp đã chứa heading phần tử của chính nó.
  if (!snapshot) {
    const followerKeys = new Set(pairing.followers.map((f) => f.old_key))
    let current: PlannedLayoutEntry[] | null = null
    for (const old of input.oldHeadings) {
      if (!followerKeys.has(old.key)) {
        current = containerOf.get(old.key) ?? null
        continue
      }
      current?.push({ ...entryOf(old, "follower", null) })
    }
  }
  return { entries: [...slots.flatMap((s) => [...s.head, ...s.moved, ...s.custom]), ...tail], newCustoms }
}

const entryOf = (old: OldHeading, kind: PlannedLayoutEntry["kind"], newKey: string | null): PlannedLayoutEntry => ({ heading_text: old.heading_text, level: old.level, section_id: old.section_id, kind, new_key: newKey, old_key: old.key, missing: false, guidance: null })

/**
 * Heading ví dụ của mẫu (feature / function / UC…) bỏ đi khi dự án đã có phần tử của chính nó — phần tử được chép nguyên khối từ
 * file nền, giữ ví dụ lại sẽ in mỗi phần tử hai lần (một lần của dự án, một lần ví dụ của mẫu).
 */
export const examplesSuppressed = (pairing: PairingResult, hasSpineElements = false): boolean => hasSpineElements || pairing.followers.some((f) => f.kind === "element")

// ─── dựng ────────────────────────────────────────────────────────

interface SourceView {
  pkg: DocxPackage
  headingEl: Map<string, Element>
  /** Thân của mục (kể cả phần tử / phần nối đi theo) tới heading của mục khung / mục riêng kế tiếp. */
  region: (oldKey: string) => Element[] | null
}

const loadSource = async (source: BaseFileSource, anchorKeys: ReadonlySet<string>): Promise<{ view: SourceView | null; warning?: string }> => {
  const pkg = await DocxPackage.load(source.buffer)
  const headings = (await readBlocks(pkg)).filter((b) => b.kind === "heading" && b.level !== null && !b.tail)
  if (headings.length !== source.headingKeys.length) return { view: null, warning: "Số heading của file nền không khớp layout: dựng toàn bộ từ Spine" }
  const headingEl = new Map<string, Element>()
  const keyOfEl = new Map<Element, string | null>()
  headings.forEach((h, i) => {
    const key = source.headingKeys[i]
    keyOfEl.set(h.element, key)
    if (key && !headingEl.has(key)) headingEl.set(key, h.element)
  })
  const region = (oldKey: string): Element[] | null => {
    const el = headingEl.get(oldKey)
    if (!el?.parentNode) return null
    return elementsAfter(el, (n) => {
      if (!keyOfEl.has(n)) return false
      const key = keyOfEl.get(n)
      return !!key && anchorKeys.has(key)
    }).filter((n) => !isLayoutOnly(n))
  }
  return { view: { pkg, headingEl, region } }
}

const mergeDropped = (all: DroppedItem[], more: readonly DroppedItem[]): void => {
  for (const d of more) if (!all.some((x) => x.kind === d.kind && x.detail === d.detail)) all.push(d)
}

/** Heading mới theo kiểu heading cùng cấp của mẫu đích (mục riêng không chép được khối vẫn có chỗ để writer điền). */
const headingLike = (model: Element, text: string): Element => {
  const p = model.cloneNode(false) as Element
  const pPr = wKid(model, "pPr")
  if (pPr) p.appendChild(pPr.cloneNode(true))
  const doc = model.ownerDocument
  const r = wEl(doc, "r")
  r.appendChild(wText(doc, "t", text))
  p.appendChild(r)
  return p
}

// ─── quy chiếu lỗi cấu trúc về mục ───────────────────────────────

/** Định danh (rId, numId, footnote id, bookmark) mà các nút vừa chép tham chiếu tới — để quy lỗi cấu trúc về đúng mục. */
const referencesOf = (nodes: readonly Element[]): Set<string> => {
  const refs = new Set<string>()
  for (const root of nodes) {
    for (const el of [root, ...Array.from(root.getElementsByTagName("*"))]) {
      for (const a of Array.from(el.attributes)) if (a.namespaceURI === NS.r) refs.add(`rid:${a.value}`)
      if (el.namespaceURI !== NS.w) continue
      const val = el.getAttributeNS(NS.w, "val")
      if (el.localName === "numId" && val) refs.add(`num:${val}`)
      if (el.localName === "footnoteReference") refs.add(`fn:${el.getAttributeNS(NS.w, "id")}`)
      if (el.localName === "bookmarkStart") {
        refs.add(`bm:${el.getAttributeNS(NS.w, "name")}`)
        refs.add(`bmid:${el.getAttributeNS(NS.w, "id")}`)
      }
    }
  }
  return refs
}

/** Lỗi của `validateDocxStructure` ⇒ định danh bị nhắc tới; `null` = không quy được về nút cụ thể của thân văn bản. */
const referenceOfProblem = (problem: string): string | null => {
  let m = /^word\/document\.xml: .*@r:\w+="([^"]+)" không có trong rels$/.exec(problem)
  if (m) return `rid:${m[1]}`
  m = /^word\/_rels\/document\.xml\.rels: (\S+) trỏ part không có/.exec(problem)
  if (m) return `rid:${m[1]}`
  m = /^numId (\S+) không có trong numbering\.xml$/.exec(problem)
  if (m) return `num:${m[1]}`
  m = /^footnoteReference (\S+) không có trong footnotes\.xml$/.exec(problem)
  if (m) return `fn:${m[1]}`
  m = /^Trùng id bookmark (\S+)$/.exec(problem)
  if (m) return `bmid:${m[1]}`
  m = /^Trùng tên bookmark (.+)$/.exec(problem)
  if (m) return `bm:${m[1]}`
  return null
}

interface BuildPass extends BuildBaseFileResult {
  /** Định danh được tham chiếu bởi khối đã chép của từng mục (theo `old_key`). */
  refs: Map<string, Set<string>>
}

const TOO_LARGE = () =>
  new ApiError(422, "File quá lớn để dựng file nền mới (vượt giới hạn dung lượng giải nén hoặc số phần của gói). Hãy dùng file nhỏ hơn.", "TEMPLATE_MIGRATION_FILE_TOO_LARGE")

export const buildBaseFile = async (input: BuildBaseFileInput): Promise<BuildBaseFileResult> => {
  try {
    return await buildWithFallback(input)
  } catch (err) {
    if (err instanceof OoxmlError && err.code === "PACKAGE_TOO_LARGE") throw TOO_LARGE()
    throw err
  }
}

/**
 * Chỉ lỗi cấu trúc do lượt dựng gây ra mới kích hoạt lùi (lỗi có sẵn trong mẫu đích bị trừ đi). Lùi theo mục: lỗi quy được về mục
 * nào thì mục đó dựng lại từ Spine (tối đa hai vòng); không quy được ⇒ dựng lại toàn file từ Spine.
 */
const buildWithFallback = async (input: BuildBaseFileInput): Promise<BuildBaseFileResult> => {
  const baseline = new Set(await validateDocxStructure(await DocxPackage.load(input.target)))
  const forced = new Set<string>()
  const strip = ({ refs: _refs, ...result }: BuildPass): BuildBaseFileResult => result
  let pass = await buildOnce(input, forced, baseline)
  const notes: string[] = []
  if (baseline.size) notes.push(`Mẫu đích có sẵn ${baseline.size} vấn đề cấu trúc (không do lượt dựng này).`)

  for (let round = 0; round < 2 && pass.problems.length && !input.forceSpine; round++) {
    const culprits = new Set<string>()
    let unattributed = false
    for (const problem of pass.problems) {
      const ref = referenceOfProblem(problem)
      const owners = ref ? [...pass.refs].filter(([, set]) => set.has(ref)).map(([key]) => key) : []
      if (!owners.length) unattributed = true
      for (const key of owners) culprits.add(key)
    }
    const fresh = [...culprits].filter((k) => !forced.has(k))
    if (unattributed || !fresh.length) break
    for (const key of fresh) forced.add(key)
    notes.push(`Dựng lại từ Spine các mục chép lỗi cấu trúc: ${fresh.join(", ")}.`)
    pass = await buildOnce(input, forced, baseline)
  }

  const transplanted = pass.sections.some((s) => ["transplant", "table_mapped", "custom", "moved"].includes(s.mode))
  if (pass.problems.length && !input.forceSpine && transplanted) {
    const issues = pass.problems.slice(0, 3).join("; ")
    const retry = await buildOnce({ ...input, forceSpine: true }, new Set(), baseline)
    return { ...strip(retry), fellBackToSpine: true, warnings: [`Chép khối lỗi cấu trúc (${issues}): đã dựng toàn bộ từ Spine`, ...notes, ...retry.warnings] }
  }
  const result = strip(pass)
  return { ...result, warnings: [...notes, ...result.warnings] }
}

const buildOnce = async (input: BuildBaseFileInput, forced: ReadonlySet<string>, baseline: ReadonlySet<string>): Promise<BuildPass> => {
  const warnings: string[] = []
  const reports: SectionReport[] = []
  const dropped: DroppedItem[] = []
  const refs = new Map<string, Set<string>>()
  const { targetHeadings, pairing } = input

  const tgt = await DocxPackage.load(input.target)
  const tgtBlocks = await readBlocks(tgt)
  const tgtHeadingBlocks = tgtBlocks.filter((b) => b.kind === "heading" && b.level !== null && !b.tail)
  if (tgtHeadingBlocks.length !== targetHeadings.length) {
    throw new BuildBaseFileError("target_headings_mismatch", `File mẫu có ${tgtHeadingBlocks.length} heading nhưng mapping có ${targetHeadings.length}`)
  }
  const headingEls = tgtHeadingBlocks.map((b) => b.element)
  const headingSet = new Set<Element>(headingEls)
  const indexOfKey = new Map(targetHeadings.map((h, i) => [h.key, i]))
  const isTargetStop = (n: Element): boolean => headingSet.has(n)

  const { byNew, customs, removed } = planOf(input)
  const anchorKeys = new Set(pairing.pairs.map((p) => p.old_key))
  let view: SourceView | null = null
  if (input.source && !input.forceSpine) {
    const loaded = await loadSource(input.source, anchorKeys)
    view = loaded.view
    if (loaded.warning) warnings.push(loaded.warning)
  }
  // Một môi trường chép cho cả lượt dựng: numId / ảnh / rels dùng chung giữa các mục, bộ đếm id liên tục
  const transplanter = view ? await createTransplanter(view.pkg, tgt) : null
  const oldByKey = new Map(input.oldHeadings.map((h) => [h.key, h]))

  const editedKeep = new Set<string>()
  if (input.direction === "reverse") {
    const choice = new Map(input.decisions.map((d) => [d.id, d.choice]))
    for (const e of input.groups.edited_since) if ((choice.get(e.id) ?? e.default) !== "discard") editedKeep.add(e.old_key)
  }
  /** Lý do mục phải dựng từ Spine dù file nền đọc được; `null` = chép khối được. */
  const spineReason = (oldKey: string): { reason: string; flag?: "yellow" } | null => {
    if (forced.has(oldKey)) return { reason: "Khối chép sang làm file lỗi cấu trúc: dựng từ Spine", flag: "yellow" }
    if (editedKeep.has(oldKey)) return { reason: "Mục đã sửa sau lần đổi mẫu trước" }
    if (input.spineOnly?.has(oldKey)) return { reason: "Mục đã bị change request sửa" }
    if (input.direction === "forward" && input.needsTranslation) return { reason: "Đổi sang mẫu khác ngôn ngữ" }
    return null
  }
  const spineWanted = (oldKey: string): boolean => spineReason(oldKey) !== null

  /** Mục cần dựng từ Spine: heading mẫu đích (hoặc heading mục riêng) + report để gắn cờ khi writer không điền được. */
  const spineSlots: { el: Element; sectionId: string; report: SectionReport }[] = []
  const customSlots: { el: Element; sectionId: string }[] = []

  const report = (r: Omit<SectionReport, "dropped" | "warnings"> & Partial<Pick<SectionReport, "dropped" | "warnings">>): SectionReport => {
    const full: SectionReport = { dropped: [], warnings: [], ...r }
    reports.push(full)
    mergeDropped(dropped, full.dropped)
    return full
  }

  /** Chép một đoạn khối của mục `oldKey`; lỗi ⇒ trả lý do. */
  const transplant = async (oldKey: string, elements: Element[], after: Element): Promise<{ inserted: Element[]; dropped: DroppedItem[]; warnings: string[] } | { error: string }> => {
    if (!elements.length) return { inserted: [], dropped: [], warnings: [] }
    const res = await transplanter!.run({ key: oldKey, elements, after })
    if (!res.ok) return { error: `${res.error?.code ?? "unexpected"}: ${res.error?.message ?? ""}` }
    refs.set(oldKey, new Set([...(refs.get(oldKey) ?? []), ...referencesOf(res.inserted)]))
    return { inserted: res.inserted, dropped: res.dropped, warnings: res.warnings }
  }

  const tailOf = (heading: Element): Element => {
    const rest = elementsAfter(heading, isTargetStop)
    return rest[rest.length - 1] ?? heading
  }

  /**
   * Đặt một mục của file cũ (mục riêng giữ lại, hoặc mục chuyển vào heading của mẫu) ngay sau `after`: chép nguyên khối kèm
   * heading gốc; không chép được / cần Spine ⇒ heading mẫu cùng cấp + dựng từ Spine. Heading gốc luôn đi kèm nên khối này tự có
   * ranh giới mục — writer không ghi đè nó khi điền mục đứng trước. Trả `true` khi chép được khối.
   */
  const placeSection = async (old: OldHeading, after: Element, notes: string[], kind: "custom" | "moved", newKey: string | null): Promise<{ last: Element; transplanted: boolean }> => {
    const base = { key: old.key, old_key: old.key, new_key: newKey, section_id: old.section_id }
    const sourceHeading = view?.headingEl.get(old.key)
    const wanted = spineReason(old.key)
    let why: { reason: string; flag?: "yellow" } | null = wanted
    if (!wanted && view) {
      const region = sourceHeading ? view.region(old.key) : null
      if (sourceHeading && region) {
        const res = await transplant(old.key, [sourceHeading, ...region], after)
        if (!("error" in res)) {
          report({ ...base, mode: kind, dropped: res.dropped, warnings: [...notes, ...res.warnings] })
          return { last: res.inserted[res.inserted.length - 1] ?? after, transplanted: true }
        }
        why = { reason: `Chép khối lỗi (${res.error})`, flag: "yellow" }
      } else why = { reason: "Không tìm thấy khối của mục trong file nền", flag: "yellow" }
    } else if (!wanted) why = { reason: input.forceSpine ? "Dựng lại toàn file từ Spine" : input.source ? "File nền không đọc được theo layout" : "Dự án không có khối gốc" }
    const model = tgtHeadingBlocks.find((b) => b.level === old.level)?.element ?? headingEls[0]
    const synthetic = headingLike(model, old.heading_text)
    insertAfter(synthetic, after)
    const r = report({ ...base, mode: "spine", ...(why?.flag ? { flag: why.flag } : {}), reason: why?.reason, warnings: notes })
    spineSlots.push({ el: synthetic, sectionId: old.section_id, report: r })
    customSlots.push({ el: synthetic, sectionId: old.section_id })
    return { last: synthetic, transplanted: false }
  }

  const suppressExamples = !input.targetIsSnapshot && examplesSuppressed(pairing, input.hasSpineElements)
  for (let i = 0; i < targetHeadings.length; i++) {
    const heading = targetHeadings[i]
    const el = headingEls[i]
    const all = byNew.get(heading.key) ?? []
    const pairPl = all.filter((p) => !p.moved)
    const movedPl = all.filter((p) => p.moved)
    const base = { new_key: heading.key, section_id: heading.section_id }
    // Chữ hướng dẫn trước khi chèn gì vào heading này (chỉ dùng khi heading chỉ nhận nội dung chuyển vào)
    const guidanceBefore = !pairPl.length && !input.targetIsSnapshot ? elementsAfter(el, isTargetStop).filter(isGuidance) : []

    await (async (): Promise<void> => {
      if (!pairPl.length) {
        if (input.targetIsSnapshot) report({ ...base, key: heading.key, old_key: null, mode: "restored" })
        else if (pairing.ignored_new.includes(heading.key) && suppressExamples) {
          for (const n of elementsAfter(el, isTargetStop)) removeNode(n)
          removeNode(el)
          report({ ...base, key: heading.key, old_key: null, mode: "removed", reason: "Heading ví dụ của mẫu: mục cha đã có phần tử riêng" })
        } else if (!movedPl.length) report({ ...base, key: heading.key, old_key: null, mode: "guidance" })
        return
      }
      // Bản chụp: mục chưa sửa giữ nguyên văn khối — không chép lại từ file hiện tại (tránh in hai lần)
      if (input.targetIsSnapshot && !pairPl.some((p) => spineWanted(p.oldKey))) {
        report({ ...base, key: heading.key, old_key: pairPl[0].oldKey, mode: "restored" })
        return
      }
      const oldKey = pairPl[0].oldKey
      const notes = pairPl.flatMap((p) => p.notes)
      const asSpine = (reason: string, flag?: "yellow"): void => {
        const r = report({ ...base, key: heading.key, old_key: oldKey, mode: "spine", ...(flag ? { flag } : {}), reason, warnings: notes })
        spineSlots.push({ el, sectionId: heading.section_id, report: r })
      }

      if (!view) {
        asSpine(input.forceSpine ? "Dựng lại toàn file từ Spine" : input.source ? "File nền không đọc được theo layout" : "Dự án không có khối gốc")
        return
      }
      const wanted = pairPl.map((p) => spineReason(p.oldKey)).find((w) => w !== null)
      if (wanted) {
        asSpine(wanted.reason, wanted.flag)
        return
      }
      const regions = pairPl.map((p) => ({ p, elements: view!.region(p.oldKey) }))
      if (regions.some((r) => !r.elements)) {
        asSpine("Không tìm thấy khối của mục trong file nền", "yellow")
        return
      }

      // Bản chụp: thân heading là nội dung thật của file cũ, không phải chữ hướng dẫn
      const guidance = input.targetIsSnapshot ? [] : elementsAfter(el, isTargetStop).filter(isGuidance)
      const guidanceTables = guidance.filter((n) => isW(n, "tbl"))
      const usedTables = new Set<Element>()
      const inserted: Element[] = []
      const itemDropped: DroppedItem[] = []
      const itemWarnings = [...notes]
      let mapped = false
      let cursor: Element = el
      let failure: string | null = null

      const flush = async (owner: string, pending: Element[]): Promise<void> => {
        if (failure || !pending.length) return
        const res = await transplant(owner, pending, cursor)
        if ("error" in res) {
          failure = res.error
          return
        }
        if (res.inserted.length) {
          inserted.push(...res.inserted)
          cursor = res.inserted[res.inserted.length - 1]
        }
        itemDropped.push(...res.dropped)
        itemWarnings.push(...res.warnings)
      }

      for (const { p, elements } of regions) {
        let pending: Element[] = []
        for (const node of elements!) {
          if (isW(node, "tbl") && p.tableAction === "drop") {
            itemWarnings.push("Bảng cũ bị bỏ theo quyết định của BA")
            continue
          }
          if (isW(node, "tbl") && p.tableAction === "map") {
            const best = guidanceTables
              .filter((t) => !usedTables.has(t))
              .map((t) => ({ t, score: columnOverlap(node, t, heading.section_id) }))
              .sort((a, b) => b.score - a.score)[0]
            if (best && best.score > 0) {
              await flush(p.oldKey, pending)
              pending = []
              if (failure) break
              fillTable(best.t, node, heading.section_id)
              // Bảng đã nằm ngay sau con trỏ thì không cần dời (xmldom lỗi khi chèn nút trước chính nó)
              if (cursor.nextSibling !== best.t) insertAfter(best.t, cursor)
              usedTables.add(best.t)
              inserted.push(best.t)
              cursor = best.t
              mapped = true
              continue
            }
            itemWarnings.push("Mẫu đích không có bảng khớp cột: giữ bảng cũ nguyên cột")
          }
          pending.push(node)
        }
        await flush(p.oldKey, pending)
        if (failure) break
      }

      if (failure) {
        // Gỡ phần đã chèn của mục này; mục dựng từ Spine + cờ vàng
        for (const n of inserted) removeNode(n)
        asSpine(`Chép khối lỗi (${failure})`, "yellow")
        return
      }
      for (const n of guidance) if (!usedTables.has(n)) removeNode(n)
      report({ ...base, key: heading.key, old_key: oldKey, mode: mapped ? "table_mapped" : "transplant", dropped: itemDropped, warnings: itemWarnings })
    })()

    // Nội dung BA chuyển vào heading này: đặt sau phần thân hiện có, kèm heading gốc làm ranh giới (mục đứng trước dựng từ Spine
    // vẫn không ghi đè được). Mục chuyển không bao giờ bị bỏ lặng lẽ: không chép được thì dựng từ Spine + cờ vàng.
    let movedTransplanted = false
    for (const m of movedPl) {
      const old = oldByKey.get(m.oldKey)
      if (!old) continue
      const placed = await placeSection(old, tailOf(el), m.notes, "moved", heading.key)
      movedTransplanted ||= placed.transplanted
    }
    if (movedTransplanted && guidanceBefore.length) for (const n of guidanceBefore) removeNode(n)
  }

  // Mục riêng (giữ theo quyết định): đặt sau mục có cặp đứng trước nó trong tài liệu cũ
  const placedHeadingOf = new Map<string, Element>()
  for (const [newKey, ps] of byNew) for (const p of ps) if (!p.moved) placedHeadingOf.set(p.oldKey, headingEls[indexOfKey.get(newKey)!])
  const customByKey = new Map(customs.map((c) => [c.oldKey, c]))
  const targetDoc = await tgt.requireXml("word/document.xml")
  const bodyEl = wKid(targetDoc.documentElement, "body")!
  const lastBodyNode = (): Element => {
    const kids = wKids(bodyEl).filter((n) => !isW(n, "sectPr"))
    return kids[kids.length - 1] ?? headingEls[headingEls.length - 1]
  }
  let lastTail: Element | null = null
  for (const old of input.oldHeadings) {
    const placed = placedHeadingOf.get(old.key)
    if (placed) {
      lastTail = tailOf(placed)
      continue
    }
    const custom = customByKey.get(old.key)
    if (!custom) continue
    lastTail = (await placeSection(old, lastTail ?? lastBodyNode(), custom.notes, "custom", null)).last
  }
  for (const r of removed) {
    const o = oldByKey.get(r.oldKey)
    report({ key: r.oldKey, old_key: r.oldKey, new_key: null, section_id: o?.section_id ?? "", mode: "removed", reason: r.reason })
  }

  // Dựng từ Spine bằng writer mẫu: chỉ các mục trong `spineSlots`, mục khác đánh `keepSource`
  const flagSpine = (reason: string): void => {
    for (const s of spineSlots) {
      s.report.flag = "yellow"
      s.report.reason = `${s.report.reason ?? ""} (${reason})`.trim()
    }
  }
  let doc: RenderedDocument | null = null
  if (spineSlots.length) {
    if (!input.renderFromSpine) flagSpine("chưa có bộ dựng từ Spine")
    else {
      try {
        doc = await input.renderFromSpine(spineSlots.map((s) => s.sectionId))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error("[BuildBaseFile] dựng bản in từ Spine lỗi:", message)
        flagSpine(`dựng từ Spine lỗi: ${message}`)
      }
    }
  }
  // Record of Changes dựng từ Spine: tự ghi dòng vào bảng mẫu theo cột (writer chỉ nối vào dòng mẫu cuối của bảng)
  const rocSlot = doc ? spineSlots.find((x) => x.sectionId === RECORD_OF_CHANGES) : undefined
  if (doc && rocSlot) {
    const table = elementsAfter(rocSlot.el, isTargetStop).find((n) => isW(n, "tbl"))
    const keys = ["version", "date", "change_type", "in_charge", "description"] as const
    if (table) fillRows(table, keys.map((k) => `roc:${k}`), doc.recordOfChanges.map((r) => keys.map((k) => r[k])), RECORD_OF_CHANGES)
  }
  const liveBlocks = await readBlocks(tgt)
  let buffer = await tgt.toBuffer()
  if (doc) {
    try {
      const fresh = await parseDocument(buffer)
      const idOf = (el: Element): string => {
        const at = liveBlocks.findIndex((b) => b.element === el)
        const block = fresh.blocks[at]
        if (at < 0 || !block || block.kind !== "heading") throw new Error("Không định vị được heading trong file vừa dựng")
        return block.block_id
      }
      const headingMap = [
        ...headingEls.map((el, i) => ({ block_id: idOf(el), section_id: targetHeadings[i].section_id })),
        ...customSlots.map((c) => ({ block_id: idOf(c.el), section_id: c.sectionId }))
      ]
      const spineIds = new Set(spineSlots.map((s) => s.sectionId))
      const rocFromFile = reports.some((r) => r.section_id === RECORD_OF_CHANGES && (r.mode === "transplant" || r.mode === "table_mapped"))
      buffer = await writeTemplateDocx(doc, buffer, headingMap, [], {
        keepSource: new Set(doc.sections.map((s) => s.id).filter((id) => !spineIds.has(id))),
        // Dòng lịch sử đã có trong bảng (chép từ file nền hoặc vừa ghi ở trên) ⇒ writer không nối thêm
        legacyRecordCount: rocFromFile ? (input.legacyRecordCount ?? doc.recordOfChanges.length) : doc.recordOfChanges.length
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error("[BuildBaseFile] điền mục từ Spine lỗi:", message)
      flagSpine(`dựng từ Spine lỗi: ${message}`)
    }
  }

  // Ép allow-list rels, dọn part mồ côi (OLE / VBA đã gỡ rel, ảnh của mục lỗi) rồi kiểm cấu trúc — chỉ tính lỗi do lượt này gây ra
  const finalPkg = await DocxPackage.load(buffer)
  mergeDropped(dropped, await enforceRelsAllowList(finalPkg))
  await pruneUnreferencedParts(finalPkg)
  const out = await finalPkg.toBuffer()
  const problems = (await validateDocxStructure(await DocxPackage.load(out))).filter((p) => !baseline.has(p))
  return { buffer: out, sections: reports, dropped, problems, warnings, fellBackToSpine: false, refs }
}
