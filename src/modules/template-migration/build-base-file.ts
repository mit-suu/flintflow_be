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
import { layoutFailureReason, writeTemplateDocx, type SlotFailure } from "../render/template-docx-writer.js"
import { columnIdentity, DROP_FROM_PRINT, RECORD_OF_CHANGES, isFreeTextSection, readChoice, type MigrationGroups } from "./classify.js"
import { UNMAPPED_SECTION } from "../import/import.constants.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { isInstructionText, splitInstruction } from "../../shared/utils/instruction-text.js"
import { createTransplanter, enforceRelsAllowList, pruneUnreferencedParts, requestFieldUpdate, validateDocxStructure, widenTocLevels, type DroppedItem } from "./ooxml-transplant.js"
import { wrapperKeys, type NewHeading, type OldHeading, type PairingResult } from "./pair-sections.js"
import { numberingOfHeadings, renumberEntries, type HeadingNumbering } from "./numbering.js"
import { isPartialSlotOf, overlapsOf } from "../import/content-slots.js"
import { targetsOf } from "../import/extract-targets.js"
import { foldText, splitHeadingNumber } from "../import/text-similarity.js"

// ─── kiểu công khai ──────────────────────────────────────────────

export interface BaseFileSource {
  /** File nền hiện tại (đổi xuôi) hoặc file nền trước lần đổi mẫu (đổi ngược). */
  buffer: Buffer
  /**
   * `old_key` của từng heading trong file nguồn theo thứ tự tài liệu (heading có `level`, không tính phần nối) — người gọi suy từ
   * layout của profile. `null` = heading không thuộc mục nào (đi theo mục trước).
   */
  headingKeys: readonly (string | null)[]
  /**
   * Chữ heading cùng thứ tự với `headingKeys`. File có heading không nằm trong layout (heading con cùng mục với heading cha,
   * import không ghi vào layout) ⇒ số heading lệch: ghép theo chữ, heading thừa của file đi theo mục trước.
   */
  headingTexts?: readonly string[]
}

/** File nền + heading của layout có chữ (heading rỗng là phần nối, không có trong file). */
export const sourceOf = (buffer: Buffer, oldHeadings: readonly OldHeading[]): BaseFileSource => {
  const named = oldHeadings.filter((h) => h.heading_text.trim())
  return { buffer, headingKeys: named.map((h) => h.key), headingTexts: named.map((h) => h.heading_text) }
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
  /** Kiểu đánh số heading của mẫu đích (đọc lúc chuẩn bị); thiếu ⇒ suy từ chữ heading của mẫu. */
  numbering?: HeadingNumbering
  /** Layout đã lập ở bước áp dụng (cùng id mục riêng với Spine) — thiếu ⇒ lập lại từ kế hoạch. */
  plannedLayout?: PlannedLayout
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
  /**
   * Mục có dữ liệu Spine mà không ghi được vào file (bộ dựng từ Spine lỗi / writer không điền được slot): file nền chỉ còn chữ
   * hướng dẫn ở đó. Bước áp dụng chặn khi mảng này khác rỗng — lưu file như vậy thì bản xuất in mục rỗng mà không ai biết.
   */
  unwritten: UnwrittenSection[]
}

export interface UnwrittenSection {
  section_id: string
  heading: string
  reason: string
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

/**
 * Mục thiếu (D7): thân mục của mẫu đích chỉ còn **trống + chữ hướng dẫn** — đoạn hướng dẫn (`isInstructionText`, hoặc chứa chữ
 * hướng dẫn mẫu đã nhận cho heading này) và hàng tiêu đề bảng. Chữ khác còn sót trong file mẫu (nội dung dự án cũ, ảnh, dòng
 * bảng) không in ra.
 */
const keepGuidanceOnly = (nodes: readonly Element[], guidance: string | undefined): void => {
  const own = splitInstruction(guidance ?? "").guidance.concat(guidance?.trim() ? [guidance.trim()] : [])
  const isOwnGuidance = (text: string) => own.some((g) => text.includes(g)) || splitInstruction(text).guidance.some((g) => !!guidance?.includes(g))
  for (const n of nodes) {
    if (isW(n, "tbl")) {
      for (const tr of wKids(n, "tr").slice(1)) removeNode(tr)
      continue
    }
    const text = wAll(n, "t").map((t) => t.textContent ?? "").join("").trim()
    if (!text || !(isInstructionText(text) || isOwnGuidance(text))) removeNode(n)
  }
}

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

const paragraphText = (p: Element): string => wAll(p, "t").map((t) => t.textContent ?? "").join("")

/** Đổi chữ của một đoạn, giữ định dạng run đầu: chữ dồn vào `w:t` đầu, các `w:t` khác để trống (bookmark / field không đụng). */
const setParagraphText = (p: Element, text: string): void => {
  const ts = wAll(p, "t")
  if (!ts.length) return
  ts[0].textContent = text
  ts[0].setAttribute("xml:space", "preserve")
  for (const t of ts.slice(1)) t.textContent = ""
}

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
  /**
   * Phần gộp giữ heading cũ (bỏ số cũ, đánh số lại) ở **cấp heading đích + 1**, đặt cuối cây con của heading đích — sau cặp chính và phần
   * tử của nó. `false` = cặp chính, hoặc phần gộp duy nhất vào mục đích trống (bỏ heading cũ, nội dung nằm ngay dưới heading đích).
   */
  moved: boolean
  /** Phần gộp mà mục đích đã in đúng dữ liệu đó từ Spine (`same_data`): không chép khối, không có mục trong layout (không in hai lần). */
  skip?: boolean
  /** Chia theo phần tử (`distribute`): mã phần tử Spine in dưới heading này; mục dựng từ Spine. */
  items?: string[]
  /** Chia theo phần tử: heading đầu (cặp gốc) giữ `section_id` của mục, in phần tử còn lại; heading khác thành mục riêng có lát phần tử. */
  primary?: boolean
}

interface CustomPlan {
  oldKey: string
  notes: string[]
}

const TABLE_CONFLICTS = new Set(["table_columns", "record_of_changes"])

/** Phần của đầu vào đủ để lập kế hoạch đặt mục (không cần file). */
export type PlanInput = Pick<BuildBaseFileInput, "targetHeadings" | "oldHeadings" | "pairing" | "groups" | "decisions" | "targetIsSnapshot" | "hasSpineElements" | "numbering">

const relatedIds = (a: string, b: string): boolean => a === b || overlapsOf(a).includes(b) || overlapsOf(b).includes(a)

/** `new_key` của mục thiếu theo cặp mà Spine có dữ liệu để in. */
const filledKeys = (groups: MigrationGroups): Set<string> => new Set(groups.missing.filter((m) => m.filled_from_spine).map((m) => m.new_key))

/**
 * `section_id` mà layout đã đặt dữ liệu của tài liệu cũ vào (mục có cặp, phần gộp — kể cả phần gộp bỏ qua vì mục đích đã in dữ liệu
 * đó từ Spine —, mục riêng giữ lại). Heading khác của mẫu cùng id không mang id đó nữa (không in lại dữ liệu ấy).
 */
const placedSectionIds = (input: PlanInput, byNew: ReadonlyMap<string, readonly Placement[]>, customs: readonly CustomPlan[]): Set<string> => {
  const oldSection = new Map(input.oldHeadings.map((h) => [h.key, h.section_id]))
  const ids = new Set<string>()
  for (const heading of input.targetHeadings) {
    for (const p of byNew.get(heading.key) ?? []) {
      // Phần gộp bỏ qua vì mục đích đã in đúng dữ liệu đó từ Spine: dữ liệu vẫn có chỗ (ở mục đích)
      const id = !p.moved && heading.section_id !== UNMAPPED_SECTION ? heading.section_id : oldSection.get(p.oldKey)
      if (id && id !== UNMAPPED_SECTION) ids.add(id)
    }
  }
  for (const c of customs) {
    const id = oldSection.get(c.oldKey)
    if (id && id !== UNMAPPED_SECTION) ids.add(id)
  }
  return ids
}

const planOf = (input: PlanInput): { byNew: Map<string, Placement[]>; customs: CustomPlan[]; removed: { oldKey: string; reason: string }[]; records: string[] } => {
  const decision = new Map(input.decisions.map((d) => [d.id, readChoice(input.groups, d.id, d.choice)]))
  const conflictsOf = new Map<string, MigrationGroups["conflict"]>()
  for (const c of input.groups.conflict) conflictsOf.set(c.old_key, [...(conflictsOf.get(c.old_key) ?? []), c])
  const validNew = new Set(input.targetHeadings.map((h) => h.key))
  const byNew = new Map<string, Placement[]>()
  const customs: CustomPlan[] = []
  const removed: { oldKey: string; reason: string }[] = []
  /** Record of Changes cũ ghép theo tên cột vào bảng lịch sử đứng trước heading đầu của mẫu (mẫu không có heading riêng cho nó). */
  const records: string[] = []
  const add = (newKey: string, p: Placement): void => void byNew.set(newKey, [...(byNew.get(newKey) ?? []), p])
  const dropped = new Set(input.groups.structure_only_dropped)
  const oldSection = new Map(input.oldHeadings.map((h) => [h.key, h.section_id]))
  const targetByKey = new Map(input.targetHeadings.map((h) => [h.key, h]))
  const filled = filledKeys(input.groups)
  const wrappers = wrapperKeys(input.targetHeadings)
  /** Phần gộp (mục thừa / mục đặt sai chỗ chọn "chuyển vào"), theo thứ tự tài liệu cũ. */
  const moves: { newKey: string; oldKey: string; notes: string[]; free: boolean }[] = []

  for (const pair of input.pairing.pairs) {
    const notes: string[] = []
    if (pair.new_key && validNew.has(pair.new_key)) {
      // Cặp theo id nhưng sai nghĩa: BA chọn gộp sang mục khác / giữ thành mục riêng thay vì giữ cặp
      const placement = decision.get(`c:placement:${pair.old_key}`)
      if (placement?.startsWith("move_to:") && validNew.has(placement.slice(8))) {
        moves.push({ newKey: placement.slice(8), oldKey: pair.old_key, notes, free: false })
        continue
      }
      if (placement === "keep_custom") {
        customs.push({ oldKey: pair.old_key, notes })
        continue
      }
      let newKey = pair.new_key
      let tableAction: TableAction = "none"
      let distribute: MigrationGroups["conflict"][number] | null = null
      for (const c of conflictsOf.get(pair.old_key) ?? []) {
        const choice = decision.get(c.id)
        if (choice === "ai_resolve") notes.push("ai_resolve chưa chạy ở bước dựng file: dùng cách ghép tự động")
        if (TABLE_CONFLICTS.has(c.kind)) tableAction = choice === "keep_old_table" || choice === "keep_custom" ? "keep" : choice === "delete" || choice === DROP_FROM_PRINT ? "drop" : "map"
        else if (c.kind === "split_section" && choice?.startsWith("to:") && validNew.has(choice.slice(3))) newKey = choice.slice(3)
        else if (c.kind === "split_section" && choice === "distribute" && c.item_targets?.length) distribute = c
      }
      if (distribute) {
        // Mỗi heading của mục bị tách nhận đúng phần tử của nó; heading đầu nhận cả phần tử không phân loại được
        for (const k of distribute.candidate_keys.filter((key) => validNew.has(key))) {
          const items = distribute.item_targets!.filter((t) => t.new_key === k).map((t) => t.id)
          if (k === newKey || items.length) add(k, { oldKey: pair.old_key, tableAction, notes: [...notes, "Chia theo từng phần tử: dựng từ Spine"], moved: false, items, primary: k === newKey })
        }
        continue
      }
      add(newKey, { oldKey: pair.old_key, tableAction, notes, moved: false })
      continue
    }
    if (dropped.has(pair.old_key)) {
      removed.push({ oldKey: pair.old_key, reason: "Heading nhóm không còn ở mẫu đích" })
      continue
    }
    const extra = decision.get(`e:${pair.old_key}`) ?? decision.get(`c:record_of_changes:${pair.old_key}`)
    if (extra === "map_by_header" && oldSection.get(pair.old_key) === RECORD_OF_CHANGES) records.push(pair.old_key)
    else if (extra === DROP_FROM_PRINT) removed.push({ oldKey: pair.old_key, reason: "BA chọn bỏ khỏi bản in (dữ liệu giữ trong Spine)" })
    else if (extra?.startsWith("move_to:") && validNew.has(extra.slice(8))) moves.push({ newKey: extra.slice(8), oldKey: pair.old_key, notes, free: isFreeTextSection(oldSection.get(pair.old_key) ?? "") })
    else {
      if (extra === undefined) notes.push("Chưa có quyết định cho mục này: giữ thành mục riêng để không mất nội dung")
      if (extra === "ai_resolve") notes.push("ai_resolve chưa chạy ở bước dựng file: giữ thành mục riêng")
      customs.push({ oldKey: pair.old_key, notes })
    }
  }
  // Phần gộp N → 1. Mục khung "chuyển vào" một heading **trống** của mẫu và là phần duy nhất = ghép với heading đó: nội dung nằm dưới
  // heading đích, không kèm heading cũ (test tay 11/11). Mục đích đã có nội dung (cặp chính / dữ liệu Spine), nhận ≥ 2 phần, hoặc là
  // heading nhóm ⇒ mỗi phần giữ heading cũ ở cấp đích + 1, cuối cây con. Mục chữ tự do luôn giữ heading của nó.
  const partsOf = new Map<string, number>()
  for (const m of moves) partsOf.set(m.newKey, (partsOf.get(m.newKey) ?? 0) + 1)
  for (const m of moves) {
    const target = targetByKey.get(m.newKey)!
    if (filled.has(m.newKey) && relatedIds(oldSection.get(m.oldKey) ?? "", target.section_id)) {
      add(m.newKey, { oldKey: m.oldKey, tableAction: "none", notes: [...m.notes, "Dữ liệu đã in từ Spine ở mục đích: không chép lần hai"], moved: true, skip: true })
      continue
    }
    const hasContent = (byNew.get(m.newKey) ?? []).some((p) => !p.moved) || filled.has(m.newKey) || wrappers.has(m.newKey) || (partsOf.get(m.newKey) ?? 0) > 1
    add(m.newKey, { oldKey: m.oldKey, tableAction: "none", notes: m.notes, moved: m.free || hasContent })
  }
  return { byNew, customs, removed, records }
}

/** `old_key` của mục cũ ⇒ vị trí heading mẫu đích nó ghép cặp (không tính mục chuyển vào). */
const pairedIndexOf = (byNew: ReadonlyMap<string, Placement[]>, targetHeadings: readonly NewHeading[]): Map<string, number> => {
  const indexOfKey = new Map(targetHeadings.map((h, i) => [h.key, i]))
  const out = new Map<string, number>()
  for (const [newKey, ps] of byNew) for (const p of ps) if (!p.moved && indexOfKey.has(newKey)) out.set(p.oldKey, indexOfKey.get(newKey)!)
  return out
}

/**
 * Phần tử đi theo mục cha **có cặp** (và phần nối / phần tử đứng liền sau chúng) ⇒ `old_key` mục cha. Chúng được đặt ở cuối cây con
 * của heading đích ghép với mục cha, không theo vị trí vật lý trong file cũ (lỗi C, test tay 11/11: tính năng của FPT nằm dưới mục
 * đứng trước chúng — "3.1.5 ERD" ⇒ "User Interfaces" của mẫu IEEE; tính năng của IEEE "3.1 Functions" chen trước "3.1 System
 * Functional Overview" của mẫu FPTU). Phần tử có mục cha không có cặp (mục riêng, chuyển, xoá) giữ cách cũ: đi theo vùng vật lý.
 */
export const relocatedFollowers = (oldHeadings: readonly OldHeading[], pairing: PairingResult, paired: ReadonlyMap<string, number>): Map<string, string> => {
  const follower = new Map(pairing.followers.map((f) => [f.old_key, f]))
  const out = new Map<string, string>()
  let current: string | null = null
  for (const h of oldHeadings) {
    const f = follower.get(h.key)
    if (!f) {
      current = null
      continue
    }
    if ((f.kind === "element" || f.kind === "child") && f.parent_old_key && paired.has(f.parent_old_key)) current = f.parent_old_key
    if (current) out.set(h.key, current)
  }
  return out
}

/** Vị trí heading mẫu đích đầu tiên sau `i` có cấp ≤ cấp của `i` (hết cây con của `i`); không có ⇒ `levels.length`. */
const subtreeEnd = (levels: readonly number[], i: number): number => {
  for (let j = i + 1; j < levels.length; j++) if (levels[j] <= levels[i]) return j
  return levels.length
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
  /** Chia theo phần tử: chỉ in các phần tử Spine này dưới heading (mục bị tách chọn "chia theo từng yêu cầu"). */
  items?: string[]
  /** Mục thiếu theo cặp nhưng in từ dữ liệu Spine. */
  from_spine?: true
}

export interface PlannedLayout {
  entries: PlannedLayoutEntry[]
  /** Heading của mẫu đích không có `section_id` (mục riêng của mẫu) và chưa có cặp: cần một mục riêng trống trong Spine. */
  newCustoms: { section_id: string; heading_text: string; level: number }[]
  /** Chữ heading cũ ⇒ chữ mới của heading đã đánh số lại (sửa tham chiếu chéo nguyên ô / nguyên đoạn trong file). */
  renumbered: Map<string, string>
  /** Heading cũ không số vừa nhận số vì đứng giữa anh em có số (chỉ sửa chữ heading của file, không sửa ô / đoạn trùng chữ). */
  numbered?: Map<string, string>
  /**
   * Chia theo phần tử: heading lặp lại một mục (vd "3.3.4 Tính sẵn sàng" của 4.2.2) là mục riêng trống + lát phần tử in dưới nó
   * (`profile.section_slices`, `nfrs:NFR-06`); heading đầu của mục in phần còn lại.
   */
  slices: { custom_id: string; section_id: string; items: string[] }[]
}

/** Kiểu đánh số dùng cho lần dựng: bản chụp (đổi ngược) giữ nguyên chữ của chính file cũ. */
const numberingFor = (input: PlanInput): HeadingNumbering => (input.targetIsSnapshot ? "none" : (input.numbering ?? numberingOfHeadings(input.targetHeadings)))

/**
 * Layout của file kết quả suy ra từ kế hoạch (cùng `planOf` và cùng thứ tự đặt với `buildOnce`), không cần file: bước áp dụng cần nó
 * trước khi dựng — bản in từ Spine của mục trong file phải theo đúng layout mới. Phần tử / phần nối đi theo mục cha của chúng.
 * Thứ tự trong một heading đích: cặp chính, mục riêng giữ sau nó, phần tử dời theo cặp, rồi phần gộp (theo thứ tự tài liệu cũ; phần gộp
 * của heading sâu hơn đứng trước phần gộp của heading nhóm chứa nó). `nextCustomId` cấp id `custom:*` cho heading riêng của mẫu chưa có cặp.
 */
export const planLayout = (input: PlanInput, nextCustomId: () => string): PlannedLayout => {
  const { byNew, customs } = planOf(input)
  const { targetHeadings, pairing } = input
  const oldByKey = new Map(input.oldHeadings.map((h) => [h.key, h]))
  const snapshot = !!input.targetIsSnapshot
  const suppressExamples = !snapshot && examplesSuppressed(pairing, input.hasSpineElements)
  const merged = mergedChildren(pairing, snapshot)
  const filled = filledKeys(input.groups)
  const levels = targetHeadings.map((h) => h.level ?? 1)
  /** Mỗi mục đích: phần đầu (heading + cặp), mục riêng giữ lại, phần tử dời theo cặp, phần gộp (kèm cấp heading đích để xếp sâu trước). */
  const slots = targetHeadings.map(() => ({ head: [] as PlannedLayoutEntry[], custom: [] as PlannedLayoutEntry[], after: [] as PlannedLayoutEntry[], merged: [] as { level: number; entries: PlannedLayoutEntry[] }[] }))
  const tail: PlannedLayoutEntry[] = []
  const newCustoms: PlannedLayout["newCustoms"] = []
  const slices: PlannedLayout["slices"] = []
  /** Nơi nhận phần tử / phần nối của từng mục cũ: chúng nằm vật lý sau mục cũ đứng ngay trước chúng, đúng như vùng chép khối. */
  const containerOf = new Map<string, PlannedLayoutEntry[]>()
  /** Độ lệch cấp của từng mục cũ đã đặt (cấp nơi đặt − cấp cũ) — phần tử / mục riêng đi theo nó dịch cùng độ lệch, như `buildOnce`. */
  const shiftOf = new Map<string, number>()

  // Nhiều heading của mẫu cùng một `section_id` (3.1.2 / 3.1.3 cùng `fixed:4.1`, 3.4 / 3.5.x cùng `fixed:5.4`): id thuộc heading có cặp
  // (heading BA chọn cho mục bị tách), không có cặp thì thuộc heading đầu. Heading còn lại mang id đó thì bản in đặt dữ liệu vào heading
  // đứng trước (renderer / writer lấy lần đầu của id) — sai chỗ BA đã chọn.
  const ownedIds = snapshot ? new Set<string>() : placedSectionIds(input, byNew, customs)

  targetHeadings.forEach((heading, i) => {
    const all = byNew.get(heading.key) ?? []
    const pairPl = all.filter((p) => !p.moved)
    const movedPl = all.filter((p) => p.moved && !p.skip)
    const level = heading.level ?? 1
    if (!pairPl.length) {
      // Heading con cùng mục với heading cha (vd "Trong phạm vi" dưới "1.2 Phạm vi"): nội dung in dưới mục cha, không tạo mục riêng
      if (merged.has(heading.key) && !movedPl.length) return
      if (!(pairing.ignored_new.includes(heading.key) && suppressExamples)) {
        // Bản chụp: heading là của chính file cũ (đã có id mục thật), không phải mục thiếu của mẫu
        const shared = !snapshot && heading.section_id !== UNMAPPED_SECTION && ownedIds.has(heading.section_id)
        const unmapped = (heading.section_id === UNMAPPED_SECTION && !snapshot) || shared
        if (!unmapped && !snapshot && heading.section_id !== UNMAPPED_SECTION) ownedIds.add(heading.section_id)
        const id = unmapped ? `custom:${nextCustomId()}` : heading.section_id
        if (unmapped) newCustoms.push({ section_id: id, heading_text: heading.heading_text, level })
        const fromSpine = !shared && filled.has(heading.key)
        slots[i].head.push({ heading_text: heading.heading_text, level, section_id: id, kind: "target", new_key: heading.key, old_key: null, missing: !movedPl.length && !snapshot && !fromSpine, guidance: heading.guidance ?? null, ...(fromSpine ? { from_spine: true as const } : {}) })
      }
    } else {
      const first = oldByKey.get(pairPl[0].oldKey)
      // Heading mẫu đích có `section_id` thì giữ; mục riêng của mẫu ghép với mục cũ thì mang id của mục cũ (dữ liệu nằm ở đó). Heading
      // của mẫu chỉ là một phần của mục cũ (3.3.2 Bảo mật ↔ 5.2 Yêu cầu chung) ⇒ mang id mục cũ: in đủ dữ liệu, không chỉ phần bảo mật
      const id = heading.section_id === UNMAPPED_SECTION || (first && isPartialSlotOf(heading.section_id, first.section_id)) ? (first?.section_id ?? heading.section_id) : heading.section_id
      const split = pairPl.find((p) => p.items)
      let sectionId = id
      if (split && !split.primary && !snapshot && first) {
        // Heading lặp lại mục: mục riêng trống + lát phần tử (renderer in phần tử dưới chính heading này)
        sectionId = `custom:${nextCustomId()}`
        newCustoms.push({ section_id: sectionId, heading_text: heading.heading_text, level })
        const collection = targetsOf(first.section_id)[0] ?? "nfrs"
        slices.push({ custom_id: sectionId.slice("custom:".length), section_id: first.section_id, items: split.items!.map((x) => `${collection}:${x}`) })
      }
      slots[i].head.push({ heading_text: heading.heading_text, level, section_id: sectionId, kind: "target", new_key: heading.key, old_key: pairPl[0].oldKey, missing: false, guidance: null, ...(split ? { items: split.items } : {}) })
      for (const pl of pairPl) {
        // Mục chia theo phần tử dựng từ Spine: phần tử / phần nối của khối cũ không chép theo
        if (pl.items) continue
        containerOf.set(pl.oldKey, slots[i].head)
        const o = oldByKey.get(pl.oldKey)
        if (o) shiftOf.set(pl.oldKey, level - o.level)
      }
    }
    if (!movedPl.length) return
    // Phần gộp: heading cũ ở cấp đích + 1 (bản chụp: cùng cấp như trước), cuối cây con của heading đích
    const end = snapshot ? i : subtreeEnd(levels, i) - 1
    for (const m of movedPl) {
      const old = oldByKey.get(m.oldKey)
      if (!old) continue
      const shift = level + (snapshot ? 0 : 1) - old.level
      const bucket: PlannedLayoutEntry[] = [entryOf(old, "moved", heading.key, shift)]
      slots[end].merged.push({ level, entries: bucket })
      containerOf.set(old.key, bucket)
      shiftOf.set(old.key, shift)
    }
  })

  // Mục riêng giữ lại: sau mục có cặp đứng trước nó trong tài liệu cũ, chưa có mục nào đứng trước ⇒ cuối tài liệu
  const placed = pairedIndexOf(byNew, targetHeadings)
  const customKeys = new Set(customs.map((c) => c.oldKey))
  let last: number | null = null
  let lastShift = 0
  for (const old of input.oldHeadings) {
    const at = placed.get(old.key)
    if (at !== undefined) {
      last = at
      lastShift = shiftOf.get(old.key) ?? 0
      continue
    }
    if (!customKeys.has(old.key)) continue
    const dest = last === null ? tail : slots[last].custom
    const shift = last === null ? 0 : lastShift
    dest.push(entryOf(old, "custom", null, shift))
    containerOf.set(old.key, dest)
    shiftOf.set(old.key, shift)
  }

  // Phần tử theo mục cha có cặp: cuối cây con của heading đích ghép với mục cha (như `buildOnce`). Phần tử / phần nối còn lại đi
  // theo mục đứng ngay trước chúng trong tài liệu cũ. Bản chụp đã chứa heading phần tử của chính nó.
  if (!snapshot) {
    const followerKeys = new Set(pairing.followers.map((f) => f.old_key))
    const relocated = relocatedFollowers(input.oldHeadings, pairing, placed)
    let current: PlannedLayoutEntry[] | null = null
    let currentShift = 0
    for (const old of input.oldHeadings) {
      if (!followerKeys.has(old.key)) {
        current = containerOf.get(old.key) ?? null
        currentShift = shiftOf.get(old.key) ?? 0
        continue
      }
      const parent = relocated.get(old.key)
      if (parent !== undefined) {
        const at = placed.get(parent)!
        slots[subtreeEnd(levels, at) - 1].after.push(entryOf(old, "follower", null, shiftOf.get(parent) ?? 0))
        continue
      }
      current?.push({ ...entryOf(old, "follower", null, currentShift) })
    }
  }
  const entries = [...slots.flatMap((s) => [...s.head, ...s.custom, ...s.after, ...mergedOf(s.merged)]), ...tail]
  const { texts, changed, numbered } = renumberEntries(entries, numberingFor(input))
  return { entries: entries.map((e, i) => (texts[i] === e.heading_text ? e : { ...e, heading_text: texts[i] })), newCustoms, renumbered: changed, numbered, slices }
}

/** Phần gộp của heading sâu hơn đứng trước phần gộp của heading nhóm chứa nó (cùng chỗ cuối cây con); cùng cấp giữ thứ tự tài liệu cũ. */
const mergedOf = <T>(merged: readonly { level: number; entries: T[] }[]): T[] =>
  merged
    .map((m, i) => ({ ...m, i }))
    .sort((a, b) => b.level - a.level || a.i - b.i)
    .flatMap((m) => m.entries)

/** Mục cũ trong layout mới; `shift` = độ lệch cấp của nơi đặt (cấp heading đích − cấp heading cũ của mục chủ), kẹp 1–9. */
const entryOf = (old: OldHeading, kind: PlannedLayoutEntry["kind"], newKey: string | null, shift = 0): PlannedLayoutEntry => ({
  heading_text: old.heading_text,
  level: Math.min(9, Math.max(1, old.level + shift)),
  section_id: old.section_id,
  kind,
  new_key: newKey,
  old_key: old.key,
  missing: false,
  guidance: null
})

/**
 * Heading ví dụ của mẫu (feature / function / UC…) bỏ đi khi dự án đã có phần tử của chính nó — phần tử được chép nguyên khối từ
 * file nền, giữ ví dụ lại sẽ in mỗi phần tử hai lần (một lần của dự án, một lần ví dụ của mẫu).
 */
export const examplesSuppressed = (pairing: PairingResult, hasSpineElements = false): boolean => hasSpineElements || pairing.followers.some((f) => f.kind === "element")

/**
 * Heading con của mẫu đích cùng `section_id` với heading cha (`pairing.children`) gộp vào mục cha: không thành mục thiếu trong layout,
 * bị bỏ khỏi file nền (cả chữ hướng dẫn) — file và layout khớp nhau. Bản chụp (đổi ngược) giữ nguyên heading của chính file cũ; bản
 * ghi cũ không có `children` ⇒ rỗng, giữ hành vi cũ.
 */
const mergedChildren = (pairing: PairingResult, snapshot: boolean): ReadonlySet<string> => new Set(snapshot ? [] : (pairing.children ?? []))

// ─── dựng ────────────────────────────────────────────────────────

interface SourceView {
  pkg: DocxPackage
  headingEl: Map<string, Element>
  /** Thân của mục (kể cả phần tử / phần nối đi theo) tới heading của mục khung / mục riêng kế tiếp. */
  region: (oldKey: string) => Element[] | null
  /** Một đợt phần tử đã dời (`keys` liền nhau trong file cũ): heading phần tử đầu + mọi thứ tới heading ngoài đợt. */
  runRegion: (keys: ReadonlySet<string>, first: string) => Element[] | null
}

/**
 * Heading của file ⇒ `old_key` khi số heading lệch layout: đi theo thứ tự, mỗi heading của layout nhận heading đầu tiên còn lại
 * của file có cùng chữ (bỏ dấu, bỏ số). Heading của file không ghép được ⇒ `null` (thân của nó thuộc mục đứng trước — đúng như
 * import đã gộp heading con vào mục cha). Heading của layout không có trong file ⇒ mục đó không có vùng chép (dựng từ Spine, cờ
 * vàng). Không có `headingTexts`, hoặc không quá nửa heading của layout tìm thấy ⇒ `null` (file không cùng layout).
 */
export const alignHeadingKeys = (fileTexts: readonly string[], source: Pick<BaseFileSource, "headingKeys" | "headingTexts">): (string | null)[] | null => {
  const texts = source.headingTexts
  if (!texts || texts.length !== source.headingKeys.length) return null
  const fold = (t: string): string => foldText(t)
  const title = (t: string): string => foldText(splitHeadingNumber(t).title)
  const keys: (string | null)[] = fileTexts.map(() => null)
  let at = 0
  let matched = 0
  for (let j = 0; j < texts.length; j++) {
    const want = fold(texts[j])
    const wantTitle = title(texts[j])
    let i = fileTexts.findIndex((t, k) => k >= at && fold(t) === want)
    if (i < 0) i = fileTexts.findIndex((t, k) => k >= at && title(t) === wantTitle)
    if (i < 0) continue
    keys[i] = source.headingKeys[j]
    at = i + 1
    matched++
  }
  return matched * 2 > texts.length ? keys : null
}

/** `anchorKeys`: heading làm ranh giới vùng chép (mục khung / mục riêng + phần tử đã dời theo mục cha). */
const loadSource = async (source: BaseFileSource, anchorKeys: ReadonlySet<string>): Promise<{ view: SourceView | null; warning?: string }> => {
  const pkg = await DocxPackage.load(source.buffer)
  const headings = (await readBlocks(pkg)).filter((b) => b.kind === "heading" && b.level !== null && !b.tail)
  const keys = headings.length === source.headingKeys.length ? source.headingKeys : alignHeadingKeys(headings.map((h) => h.text), source)
  if (!keys) return { view: null, warning: "Số heading của file nền không khớp layout: dựng toàn bộ từ Spine" }
  const headingEl = new Map<string, Element>()
  const keyOfEl = new Map<Element, string | null>()
  headings.forEach((h, i) => {
    const key = keys[i]
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
  const runRegion = (keys: ReadonlySet<string>, first: string): Element[] | null => {
    const el = headingEl.get(first)
    if (!el?.parentNode) return null
    const rest = elementsAfter(el, (n) => {
      const key = keyOfEl.get(n)
      return !!key && anchorKeys.has(key) && !keys.has(key)
    }).filter((n) => !isLayoutOnly(n))
    return [el, ...rest]
  }
  const missing = source.headingKeys.filter((k) => k && !headingEl.has(k)).length
  const view = { pkg, headingEl, region, runRegion }
  return missing ? { view, warning: `${missing} heading của layout không tìm thấy trong file nền: các mục đó dựng từ Spine` } : { view }
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

  const { byNew, customs, removed, records } = planOf(input)
  // Phần tử theo mục cha có cặp: chép riêng vào cuối cây con của heading đích (như `planLayout`) ⇒ vùng chép của mục khác dừng ở đó.
  // Bản chụp (đổi ngược) đã chứa heading phần tử của chính nó: không dời.
  const relocated = input.targetIsSnapshot ? new Map<string, string>() : relocatedFollowers(input.oldHeadings, pairing, pairedIndexOf(byNew, targetHeadings))
  const anchorKeys = new Set([...pairing.pairs.map((p) => p.old_key), ...relocated.keys()])
  let view: SourceView | null = null
  if (input.source && !input.forceSpine) {
    const loaded = await loadSource(input.source, anchorKeys)
    view = loaded.view
    if (loaded.warning) warnings.push(loaded.warning)
  }
  // Một môi trường chép cho cả lượt dựng: numId / ảnh / rels dùng chung giữa các mục, bộ đếm id liên tục
  const transplanter = view ? await createTransplanter(view.pkg, tgt) : null
  const oldByKey = new Map(input.oldHeadings.map((h) => [h.key, h]))
  let planned = 0
  const plan = input.plannedLayout ?? planLayout(input, () => `build${++planned}`)
  const layoutIdOfKey = new Map<string, string>()
  for (const e of plan.entries) if (e.kind === "target" && e.new_key && !layoutIdOfKey.has(e.new_key)) layoutIdOfKey.set(e.new_key, e.section_id)
  /**
   * Id mục của heading mẫu đích theo layout: heading riêng của mẫu (`unmapped`) đã có cặp mang id của mục cũ ghép vào nó; heading
   * dùng chung `section_id` với heading BA chọn cho mục bị tách mang id mục riêng trống (`planLayout`) — writer không đặt dữ liệu
   * vào heading đứng trước.
   */
  const pairedSectionId = (h: NewHeading): string => {
    const fromLayout = layoutIdOfKey.get(h.key)
    if (fromLayout) return fromLayout
    if (h.section_id !== UNMAPPED_SECTION) return h.section_id
    const pl = (byNew.get(h.key) ?? []).find((p) => !p.moved)
    return pl ? (oldByKey.get(pl.oldKey)?.section_id ?? h.section_id) : h.section_id
  }
  /** Cấp heading thứ `i` của mẫu đích (đọc từ file). */
  const tgtLevel = (i: number): number => tgtHeadingBlocks[i]?.level ?? targetHeadings[i]?.level ?? 1
  /** Độ lệch cấp khi chép khối của mục cũ `oldKey` vào heading đích thứ `i` — heading con trong khối giữ đúng quan hệ cha / con. */
  const shiftOf = (oldKey: string, i: number): number => {
    const o = oldByKey.get(oldKey)
    return o ? tgtLevel(i) - o.level : 0
  }

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
  const transplant = async (oldKey: string, elements: Element[], after: Element, headingShift = 0): Promise<{ inserted: Element[]; dropped: DroppedItem[]; warnings: string[] } | { error: string }> => {
    if (!elements.length) return { inserted: [], dropped: [], warnings: [] }
    const res = await transplanter!.run({ key: oldKey, elements, after, headingShift })
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
  const placeSection = async (old: OldHeading, after: Element, notes: string[], kind: "custom" | "moved", newKey: string | null, headingShift = 0): Promise<{ last: Element; transplanted: boolean }> => {
    const base = { key: old.key, old_key: old.key, new_key: newKey, section_id: old.section_id }
    const sourceHeading = view?.headingEl.get(old.key)
    const wanted = spineReason(old.key)
    let why: { reason: string; flag?: "yellow" } | null = wanted
    if (!wanted && view) {
      const region = sourceHeading ? view.region(old.key) : null
      if (sourceHeading && region) {
        const res = await transplant(old.key, [sourceHeading, ...region], after, headingShift)
        if (!("error" in res)) {
          report({ ...base, mode: kind, dropped: res.dropped, warnings: [...notes, ...res.warnings] })
          return { last: res.inserted[res.inserted.length - 1] ?? after, transplanted: true }
        }
        why = { reason: `Chép khối lỗi (${res.error})`, flag: "yellow" }
      } else why = { reason: "Không tìm thấy khối của mục trong file nền", flag: "yellow" }
    } else if (!wanted) why = { reason: input.forceSpine ? "Dựng lại toàn file từ Spine" : input.source ? "File nền không đọc được theo layout" : "Dự án không có khối gốc" }
    const placedLevel = Math.min(9, Math.max(1, old.level + headingShift))
    const model = tgtHeadingBlocks.find((b) => b.level === placedLevel)?.element ?? tgtHeadingBlocks.find((b) => b.level === old.level)?.element ?? headingEls[0]
    const synthetic = headingLike(model, old.heading_text)
    insertAfter(synthetic, after)
    const r = report({ ...base, mode: "spine", ...(why?.flag ? { flag: why.flag } : {}), reason: why?.reason, warnings: notes })
    spineSlots.push({ el: synthetic, sectionId: old.section_id, report: r })
    customSlots.push({ el: synthetic, sectionId: old.section_id })
    return { last: synthetic, transplanted: false }
  }

  const suppressExamples = !input.targetIsSnapshot && examplesSuppressed(pairing, input.hasSpineElements)
  const merged = mergedChildren(pairing, !!input.targetIsSnapshot)
  /** Mục cũ đã chép khối dưới heading đích ghép cặp — chỉ khi đó mới chép phần tử dời theo nó (như trước: mục dựng từ Spine không kèm khối file cũ). */
  const transplantedOld = new Set<string>()
  const filled = filledKeys(input.groups)
  /** Phần gộp chờ đặt sau khi phần tử dời theo cặp đã vào chỗ (phần gộp đứng cuối cây con của heading đích). */
  const mergeQueue: { i: number; pl: Placement; guidance: Element[] }[] = []
  for (let i = 0; i < targetHeadings.length; i++) {
    const heading = targetHeadings[i]
    const el = headingEls[i]
    const all = byNew.get(heading.key) ?? []
    const pairPl = all.filter((p) => !p.moved)
    const movedPl = all.filter((p) => p.moved && !p.skip)
    const base = { new_key: heading.key, section_id: heading.section_id }
    for (const sk of all.filter((p) => p.skip)) report({ ...base, key: sk.oldKey, old_key: sk.oldKey, mode: "moved", reason: sk.notes[sk.notes.length - 1] })
    // Chữ hướng dẫn trước khi chèn gì vào heading này (chỉ dùng khi heading chỉ nhận nội dung chuyển vào)
    const guidanceBefore = !pairPl.length && !input.targetIsSnapshot ? elementsAfter(el, isTargetStop).filter(isGuidance) : []

    await (async (): Promise<void> => {
      if (!pairPl.length) {
        if (input.targetIsSnapshot) report({ ...base, key: heading.key, old_key: null, mode: "restored" })
        else if (pairing.ignored_new.includes(heading.key) && suppressExamples) {
          for (const n of elementsAfter(el, isTargetStop)) removeNode(n)
          removeNode(el)
          report({ ...base, key: heading.key, old_key: null, mode: "removed", reason: "Heading ví dụ của mẫu: mục cha đã có phần tử riêng" })
        } else if (merged.has(heading.key) && !movedPl.length) {
          for (const n of guidanceBefore) removeNode(n)
          removeNode(el)
          report({ ...base, key: heading.key, old_key: null, mode: "removed", reason: "Heading con cùng mục với heading cha: gộp vào mục cha" })
        } else if (filled.has(heading.key) && pairedSectionId(heading) === heading.section_id) {
          // Mục thiếu theo cặp nhưng Spine có dữ liệu (tầm nhìn, giả định…): in từ Spine như workspace, không chỉ chữ hướng dẫn.
          // Heading dùng chung id với heading khác đã nhận dữ liệu (layout cấp mục riêng trống) thì không in lại
          const r = report({ ...base, key: heading.key, old_key: null, mode: "spine", reason: "Mục in từ dữ liệu Spine" })
          spineSlots.push({ el, sectionId: heading.section_id, report: r })
        } else if (!movedPl.length) {
          keepGuidanceOnly(guidanceBefore, heading.guidance)
          report({ ...base, key: heading.key, old_key: null, mode: "guidance" })
        }
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
        // Heading lặp lại mục (chia theo phần tử) mang id mục riêng của layout — writer điền đúng lát phần tử của nó
        const layoutId = pairPl.some((p) => p.items && !p.primary) ? input.plannedLayout?.entries.find((e) => e.kind === "target" && e.new_key === heading.key)?.section_id : undefined
        spineSlots.push({ el, sectionId: layoutId ?? pairedSectionId(heading), report: r })
      }

      if (!view) {
        asSpine(input.forceSpine ? "Dựng lại toàn file từ Spine" : input.source ? "File nền không đọc được theo layout" : "Dự án không có khối gốc")
        return
      }
      // Chia theo phần tử: mỗi heading in đúng phần tử của nó từ Spine (khối cũ gồm mọi phần tử, không chép được một phần)
      const wanted = pairPl.some((p) => p.items) ? { reason: "Chia theo từng phần tử: dựng từ Spine", flag: undefined } : pairPl.map((p) => spineReason(p.oldKey)).find((w) => w !== null)
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

      const flush = async (owner: string, pending: Element[], headingShift = 0): Promise<void> => {
        if (failure || !pending.length) return
        const res = await transplant(owner, pending, cursor, headingShift)
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
              await flush(p.oldKey, pending, shiftOf(p.oldKey, i))
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
        await flush(p.oldKey, pending, shiftOf(p.oldKey, i))
        if (failure) break
      }

      if (failure) {
        // Gỡ phần đã chèn của mục này; mục dựng từ Spine + cờ vàng
        for (const n of inserted) removeNode(n)
        asSpine(`Chép khối lỗi (${failure})`, "yellow")
        return
      }
      for (const n of guidance) if (!usedTables.has(n)) removeNode(n)
      for (const p of pairPl) transplantedOld.add(p.oldKey)
      report({ ...base, key: heading.key, old_key: oldKey, mode: mapped ? "table_mapped" : "transplant", dropped: itemDropped, warnings: itemWarnings })
    })()

    // Nội dung BA chuyển vào heading này: đặt sau phần thân hiện có, kèm heading gốc làm ranh giới (mục đứng trước dựng từ Spine
    // vẫn không ghi đè được). Mục chuyển không bao giờ bị bỏ lặng lẽ: không chép được thì dựng từ Spine + cờ vàng.
    for (const pl of movedPl) mergeQueue.push({ i, pl, guidance: guidanceBefore })
  }

  // Mục riêng (giữ theo quyết định): đặt sau mục có cặp đứng trước nó trong tài liệu cũ
  const placedHeadingOf = new Map<string, Element>()
  const placedIndexOf = new Map<string, number>()
  for (const [newKey, ps] of byNew)
    for (const p of ps)
      if (!p.moved) {
        placedHeadingOf.set(p.oldKey, headingEls[indexOfKey.get(newKey)!])
        placedIndexOf.set(p.oldKey, indexOfKey.get(newKey)!)
      }
  const customByKey = new Map(customs.map((c) => [c.oldKey, c]))
  const targetDoc = await tgt.requireXml("word/document.xml")
  const bodyEl = wKid(targetDoc.documentElement, "body")!
  const lastBodyNode = (): Element => {
    const kids = wKids(bodyEl).filter((n) => !isW(n, "sectPr"))
    return kids[kids.length - 1] ?? headingEls[headingEls.length - 1]
  }
  let lastTail: Element | null = null
  // Mục riêng giữ cùng quan hệ cấp với mục có cặp đứng trước nó (như `planLayout`)
  let lastShift = 0
  // Mục riêng chưa có mục có cặp nào đứng trước (vd. "1 Introduction" đầu file cũ): `planLayout` xếp vào cuối tài liệu (`tail`) ⇒ đặt
  // sau cùng, sau mọi mục riêng khác — đặt ngay lúc gặp thì mục riêng nối sau mục có cặp cuối cùng sẽ chèn sau nó, lệch thứ tự layout
  // ⇒ heading_map gán nhầm id, xuất Word báo TEMPLATE_LAYOUT_UNAVAILABLE (test tay lượt 3, 11/11)
  const tailCustoms: OldHeading[] = []
  for (const old of input.oldHeadings) {
    const placed = placedHeadingOf.get(old.key)
    if (placed) {
      lastTail = tailOf(placed)
      lastShift = shiftOf(old.key, placedIndexOf.get(old.key)!)
      continue
    }
    const custom = customByKey.get(old.key)
    if (!custom) continue
    if (!lastTail) {
      tailCustoms.push(old)
      continue
    }
    lastTail = (await placeSection(old, lastTail, custom.notes, "custom", null, lastShift)).last
  }
  // Phần tử dời theo mục cha có cặp: từng đợt (liền nhau trong file cũ, cùng mục cha) chép vào cuối cây con của heading đích — ngay
  // trước heading đích kế tiếp có cấp ≤ (sau mục chuyển vào / mục riêng của cây con), hết tài liệu thì trước mục riêng `tailCustoms`
  if (view && relocated.size) {
    const levels = targetHeadings.map((h) => h.level ?? 1)
    const runs: { parent: string; keys: string[] }[] = []
    let prev: string | undefined
    for (const old of input.oldHeadings) {
      const parent = relocated.get(old.key)
      if (parent !== undefined && parent === prev) runs[runs.length - 1].keys.push(old.key)
      else if (parent !== undefined) runs.push({ parent, keys: [old.key] })
      prev = parent
    }
    for (const run of runs) {
      const at = placedIndexOf.get(run.parent)
      if (at === undefined || !transplantedOld.has(run.parent)) continue
      const elements = view.runRegion(new Set(run.keys), run.keys[0])
      const stop = headingEls.slice(subtreeEnd(levels, at)).find((h) => h.parentNode)
      let after: Element | null = stop ? (stop.previousSibling as Element | null) : lastBodyNode()
      while (after && after.nodeType !== 1) after = after.previousSibling as Element | null
      const res = elements && after ? await transplant(run.parent, elements, after, shiftOf(run.parent, at)) : { error: "Không tìm thấy khối của phần tử trong file nền" }
      if ("error" in res) {
        const owner = reports.find((r) => r.old_key === run.parent)
        const reason = `Không chép được phần tử theo mục (${res.error}): ${run.keys.length} heading`
        if (owner) Object.assign(owner, { flag: "yellow", reason: [owner.reason, reason].filter(Boolean).join("; ") })
        warnings.push(reason)
        continue
      }
      mergeDropped(dropped, res.dropped)
      warnings.push(...res.warnings)
    }
  }
  // Phần gộp: heading cũ ở cấp đích + 1, cuối cây con của heading đích (sau cặp chính, mục riêng, phần tử dời) — như `planLayout`. Cùng chỗ
  // cuối cây con: heading sâu hơn trước heading nhóm chứa nó; cùng heading giữ thứ tự tài liệu cũ. Bản chụp giữ cách cũ (cùng cấp, sau thân).
  {
    const levels = targetHeadings.map((h) => h.level ?? 1)
    const snapshot = !!input.targetIsSnapshot
    const queue = mergeQueue
      .map((q, order) => ({ ...q, order, end: snapshot ? q.i + 1 : subtreeEnd(levels, q.i) }))
      .sort((a, b) => a.end - b.end || levels[b.i] - levels[a.i] || a.order - b.order)
    const transplantedInto = new Set<number>()
    for (const q of queue) {
      const old = oldByKey.get(q.pl.oldKey)
      if (!old) continue
      let after: Element | null
      if (snapshot) after = tailOf(headingEls[q.i])
      else {
        const stop = headingEls.slice(q.end).find((h) => h.parentNode)
        after = stop ? (stop.previousSibling as Element | null) : lastBodyNode()
        while (after && after.nodeType !== 1) after = after.previousSibling as Element | null
      }
      if (!after) continue
      const shift = tgtLevel(q.i) + (snapshot ? 0 : 1) - old.level
      const placed = await placeSection(old, after, q.pl.notes, "moved", targetHeadings[q.i].key, shift)
      if (placed.transplanted) transplantedInto.add(q.i)
    }
    // Heading đích trống chỉ nhận phần gộp: bỏ chữ hướng dẫn khi đã có nội dung chép sang
    for (const q of mergeQueue) if (transplantedInto.has(q.i)) for (const n of q.guidance) if (n.parentNode) removeNode(n)
  }
  let tailAfter: Element | null = null
  for (const old of tailCustoms) tailAfter = (await placeSection(old, tailAfter ?? lastBodyNode(), customByKey.get(old.key)!.notes, "custom", null, 0)).last
  for (const r of removed) {
    const o = oldByKey.get(r.oldKey)
    report({ key: r.oldKey, old_key: r.oldKey, new_key: null, section_id: o?.section_id ?? "", mode: "removed", reason: r.reason })
  }

  // Bảng lịch sử cũ ⇒ bảng lịch sử của mẫu đứng trước heading đầu, ghép theo tên cột (Phiên bản, Ngày, Người thực hiện, Mô tả)
  for (const oldKey of records) {
    const firstHeading = headingEls.find((h) => h.parentNode)
    const before: Element[] = []
    for (let n = bodyEl.firstChild; n && n !== firstHeading; n = n.nextSibling) if (n.nodeType === 1) before.push(n as Element)
    const target = before.filter((n) => isW(n, "tbl")).find((t) => { const tr = wKids(t, "tr")[0]; return !!tr && rowTexts(tr).filter((h) => columnIdentity(h, null, RECORD_OF_CHANGES).startsWith("roc:")).length >= 2 })
    const source = view?.region(oldKey)?.find((n) => isW(n, "tbl"))
    if (target && source) {
      fillTable(target, source, RECORD_OF_CHANGES)
      report({ key: oldKey, old_key: oldKey, new_key: null, section_id: RECORD_OF_CHANGES, mode: "table_mapped", reason: "Ghép vào bảng lịch sử sửa đổi đầu tài liệu của mẫu" })
    } else report({ key: oldKey, old_key: oldKey, new_key: null, section_id: RECORD_OF_CHANGES, mode: "removed", flag: "yellow", reason: "Không ghép được bảng lịch sử cũ vào bảng lịch sử của mẫu" })
  }

  // Đánh số lại heading đến từ tài liệu cũ theo layout (mẫu đánh số bằng chữ): heading đã chép giữ chữ cũ ⇒ ghi số mới; ô / đoạn có chữ
  // đúng bằng chữ heading cũ (bảng "Chức năng" của mô tả màn hình) đổi theo. Chỉ thay nguyên ô / nguyên đoạn, không thay chuỗi con.
  if (!input.targetIsSnapshot) {
    if (plan.renumbered.size || plan.numbered?.size) {
      const live = (await readBlocks(tgt)).filter((b) => b.kind === "heading" && b.level !== null && !b.tail)
      const titleKey = (text: string): string => foldText(splitHeadingNumber(text).title)
      let at = 0
      for (const e of plan.entries) {
        if (!e.heading_text.trim()) continue
        const idx = live.findIndex((b, j) => j >= at && titleKey(b.text) === titleKey(e.heading_text))
        if (idx < 0) continue
        at = idx + 1
        const current = paragraphText(live[idx].element).trim()
        if (current !== e.heading_text && (plan.renumbered.get(current) === e.heading_text || plan.numbered?.get(current) === e.heading_text)) setParagraphText(live[idx].element, e.heading_text)
      }
      const headingSet = new Set(live.map((b) => b.element))
      for (const p of wAll(bodyEl, "p")) {
        if (headingSet.has(p)) continue
        const next = plan.renumbered.get(paragraphText(p).trim())
        if (next) setParagraphText(p, next)
      }
    }
  }

  // Dựng từ Spine bằng writer mẫu: chỉ các mục trong `spineSlots`, mục khác đánh `keepSource`
  const flagSpine = (reason: string): void => {
    for (const s of spineSlots) {
      s.report.flag = "yellow"
      s.report.reason = `${s.report.reason ?? ""} (${reason})`.trim()
    }
  }
  const unwritten: UnwrittenSection[] = []
  const headingOfSlot = (s: (typeof spineSlots)[number]): string => paragraphText(s.el).trim()
  /** Mục dựng từ Spine không ghi được: cờ vàng kèm lý do; mục có dữ liệu (hoặc chưa biết vì bộ dựng lỗi) ⇒ `unwritten`. */
  const failSlot = (s: (typeof spineSlots)[number], reason: string, hasData: boolean): void => {
    s.report.flag = "yellow"
    s.report.reason = `${s.report.reason ?? ""} (dựng từ Spine lỗi: ${reason})`.trim()
    if (hasData && !unwritten.some((u) => u.section_id === s.sectionId)) unwritten.push({ section_id: s.sectionId, heading: headingOfSlot(s), reason })
  }
  let doc: RenderedDocument | null = null
  if (spineSlots.length) {
    if (!input.renderFromSpine) flagSpine("chưa có bộ dựng từ Spine")
    else {
      try {
        doc = await input.renderFromSpine(spineSlots.map((s) => s.sectionId))
      } catch (err) {
        const reason = layoutFailureReason(err)
        console.error("[BuildBaseFile] dựng bản in từ Spine lỗi:", reason)
        for (const s of spineSlots) failSlot(s, reason, true)
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
        // Heading đã bỏ khỏi file (heading con gộp vào mục cha, heading ví dụ của mẫu) ⇒ không định vị: không còn chỗ trong file
        ...headingEls.flatMap((el, i) => (!el.parentNode ? [] : [{ block_id: idOf(el), section_id: pairedSectionId(targetHeadings[i]) }])),
        ...customSlots.map((c) => ({ block_id: idOf(c.el), section_id: c.sectionId }))
      ]
      const spineIds = new Set(spineSlots.map((s) => s.sectionId))
      const rocFromFile = reports.some((r) => r.section_id === RECORD_OF_CHANGES && (r.mode === "transplant" || r.mode === "table_mapped"))
      // Chịu lỗi theo mục: một mục không điền được không làm cả file chỉ còn khung mẫu
      const failures: SlotFailure[] = []
      buffer = await writeTemplateDocx(doc, buffer, headingMap, [], {
        keepSource: new Set(doc.sections.map((s) => s.id).filter((id) => !spineIds.has(id))),
        // Dòng lịch sử đã có trong bảng (chép từ file nền hoặc vừa ghi ở trên) ⇒ writer không nối thêm
        legacyRecordCount: rocFromFile ? (input.legacyRecordCount ?? doc.recordOfChanges.length) : doc.recordOfChanges.length,
        failures
      })
      const printed = new Map(doc.sections.map((s) => [s.id, s]))
      for (const f of failures) {
        console.error(`[BuildBaseFile] điền mục ${f.section_id} từ Spine lỗi:`, f.reason)
        const slot = spineSlots.find((s) => s.sectionId === f.section_id)
        const hasData = !!printed.get(f.section_id)?.blocks.length
        if (slot) failSlot(slot, f.reason, hasData)
        else if (hasData && !unwritten.some((u) => u.section_id === f.section_id)) unwritten.push({ section_id: f.section_id, heading: printed.get(f.section_id)?.heading ?? f.section_id, reason: f.reason })
      }
    } catch (err) {
      const reason = layoutFailureReason(err)
      console.error("[BuildBaseFile] điền mục từ Spine lỗi:", reason)
      for (const s of spineSlots) failSlot(s, reason, !!doc.sections.find((x) => x.id === s.sectionId)?.blocks.length)
    }
  }

  // Ép allow-list rels, dọn part mồ côi (OLE / VBA đã gỡ rel, ảnh của mục lỗi) rồi kiểm cấu trúc — chỉ tính lỗi do lượt này gây ra
  const finalPkg = await DocxPackage.load(buffer)
  mergeDropped(dropped, await enforceRelsAllowList(finalPkg))
  await pruneUnreferencedParts(finalPkg)
  // Mục lục của mẫu giới hạn cấp ⇒ nới tới cấp heading sâu nhất của layout mới (tên chức năng ở cấp 4 vào mục lục)
  if (!input.targetIsSnapshot) await widenTocLevels(finalPkg, Math.max(0, ...plan.entries.filter((e) => e.heading_text.trim()).map((e) => e.level)))
  // Mục lục chép theo file mẫu là mục lục của mẫu ⇒ yêu cầu Word dựng lại khi mở
  await requestFieldUpdate(finalPkg)
  const out = await finalPkg.toBuffer()
  const problems = (await validateDocxStructure(await DocxPackage.load(out))).filter((p) => !baseline.has(p))
  return { buffer: out, sections: reports, dropped, problems, warnings, fellBackToSpine: false, unwritten, refs }
}
