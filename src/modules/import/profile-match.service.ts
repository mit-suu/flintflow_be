/**
 * Khớp template profile (I-3, nút 1.6) — tất định, không tốn credit. FLF-171, plan §6 2B.
 * - FLF-363: mọi heading so với **ngân hàng phần chung FPT + IEEE** (`part-bank.ts`) theo tên + mục cha, không đoán họ mẫu
 *   trước, **không dùng số mục** (số gõ tay / số Word). Nhãn họ mẫu (`fpt` / `ieee29148` / `mixed`) chỉ để báo cáo.
 * - Mỗi phần nhận tối đa một heading (phần lặp lại như Reliability + Availability nhận thêm heading khớp chắc); nhiều phần có
 *   thể cùng trích vào một section FPT; phần chỉ có ở IEEE giữ nguyên văn.
 * - Mục con lạ của chương chức năng ⇒ feature, con của feature ⇒ function (id tạm, xem `section-catalog.ts`); heading con
 *   khác của một section ⇒ thuộc section cha.
 * - Heading nhận theo mẫu số mục (file không dùng style) bị giới hạn độ tin 0.75 (P0 §4.2); FLF-343: tín hiệu phụ (in đậm,
 *   chữ to, mục lục) nâng trần (`detectorCap`).
 * - Nội dung dưới heading (loại bảng, mã BR / MSG) chỉ rõ mục khác tên ⇒ đổi theo nội dung, `content_mismatch` (D1–D2).
 * - Cột bảng ⇒ field theo `table-header-dictionary.ts`.
 * Độ tin < 0.8 ⇒ FLF-343: tự nhận + cờ "Cần xem" lúc finalize (không còn dừng ở `mapping_review`).
 */

import { isExtractableSection, targetsOf } from "./extract-targets.js"
import { MAPPING_CONFIDENCE_THRESHOLD, UNMAPPED_SECTION, type HeadingDetector, type HeadingSignal } from "./import.constants.js"
import type { ParsedBlock } from "./parse.service.js"
import { PROVISIONAL_SECTION, isContentSection, provisionalFeatureId, provisionalFunctionId } from "./section-catalog.js"
import { TABLE_ENTITIES, matchTable } from "./table-header-dictionary.js"
import { SLOT_SUGGESTION_CONFIDENCE, isContentSlot, slotParents, suggestSlot } from "./content-slots.js"
import { isInstructionText } from "../../shared/utils/instruction-text.js"
import { PART_BANK, isWeakTitle, partById, titleOrigins, type PartDef, type TemplateFamily } from "./part-bank.js"
import type { HeadingMapEntry, TableMapEntry } from "./template-profile.model.js"
import { foldText, foldTokens, splitHeadingNumber, titleSimilarity } from "./text-similarity.js"

/** Block tối thiểu để khớp profile / gán section (DocBlock đã lưu cũng dùng được). */
export interface ProfileBlock {
  block_id: string
  kind: ParsedBlock["kind"]
  level: number | null
  text: string
  heading_detector?: HeadingDetector | null
  rows?: string[][] | null
  /** FLF-343: tín hiệu phụ của heading (in đậm, chữ to, trùng mục lục, đánh số tự động). */
  heading_signals?: readonly HeadingSignal[]
  /** FLF-343: số mục Word tự sinh (không có trong chữ). FLF-363: không còn dùng để chấm điểm khớp. */
  auto_number?: string | null
  /** FLF-362: nhãn số Word đúng như Word hiện ("2.1.", "II.") — mang theo heading để hiển thị, không dùng chấm điểm. */
  number_label?: string | null
  /** FLF-364: đoạn có kiểu chữ hướng dẫn (nghiêng / tô nền / khác màu thân bài) — tín hiệu phụ của chữ hướng dẫn. */
  guidance_format?: boolean
}

export interface ProfileMatch {
  heading_map: HeadingMapEntry[]
  table_map: TableMapEntry[]
  language: string
  /** FLF-363: nhãn họ mẫu tính sau khi khớp (`fpt` / `ieee29148` / `mixed`). */
  template_family: TemplateFamily
}

const MATCH_MIN = 0.5
const WEAK_MATCH = 0.35
const NUMBERING_PATTERN_CAP = 0.75
const round = (n: number): number => Math.round(n * 100) / 100

/**
 * Trần độ tin theo cách nhận heading (FLF-343). Style / outline: không giới hạn. Chỉ theo chữ (số mục gõ tay, cỡ chữ) ⇒ 0.75
 * như trước (P0 §4.2) — trừ khi có tín hiệu phụ: trùng một dòng mục lục ⇒ 0.95; in đậm / chữ to ⇒ 0.9 (số mục gõ tay) hoặc
 * 0.85 (đánh số tự động, chữ to / style tiêu đề riêng in đậm).
 */
export const detectorCap = (detector: HeadingDetector, signals: readonly HeadingSignal[] = []): number => {
  if (detector === "style" || detector === "outline_level" || detector === "user") return 1
  if (detector === "toc" || signals.includes("toc")) return 0.95
  const formatted = signals.includes("bold") || signals.includes("large")
  if (detector === "numbering_pattern") return formatted ? 0.9 : NUMBERING_PATTERN_CAP
  if (detector === "numbering") return formatted ? 0.85 : NUMBERING_PATTERN_CAP
  // `format`: chữ to / style tiêu đề riêng — có in đậm thì chắc hơn
  return signals.includes("bold") ? 0.85 : NUMBERING_PATTERN_CAP
}

const detectLanguage = (blocks: ProfileBlock[]): string => {
  const sample = blocks.map((b) => b.text).join(" ").slice(0, 20000)
  const words = sample.split(/\s+/).filter(Boolean)
  if (!words.length) return "en"
  const vi = words.filter((w) => /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(w)).length
  return vi / words.length > 0.08 ? "vi" : "en"
}

/** Section của từng block theo heading gần nhất phía trên (heading nhóm/unmapped ⇒ `null`). */
export const assignBlockSections = (blocks: ProfileBlock[], headingMap: HeadingMapEntry[]): Map<string, string | null> => {
  const sectionOfHeading = new Map(headingMap.map((h) => [h.block_id, h.section_id]))
  const out = new Map<string, string | null>()
  const stack: { level: number; section: string | null }[] = []
  for (const b of blocks) {
    if (b.kind === "heading" && b.level !== null) {
      while (stack.length && stack[stack.length - 1].level >= b.level) stack.pop()
      const section = sectionOfHeading.get(b.block_id) ?? UNMAPPED_SECTION
      stack.push({ level: b.level, section })
      out.set(b.block_id, isContentSection(section) ? section : null)
      continue
    }
    const top = stack[stack.length - 1]?.section ?? null
    out.set(b.block_id, isContentSection(top) ? top : null)
  }
  return out
}

type MatchHeading = ProfileBlock & { title: string }

/** Tiêu đề đã bỏ số gõ tay (FLF-363: số mục không tham gia khớp — người dùng đánh số tuỳ ý). */
const headingsOf = (blocks: ProfileBlock[]): MatchHeading[] =>
  blocks.filter((b) => b.kind === "heading" && b.level !== null).map((b) => ({ ...b, title: splitHeadingNumber(b.text).title }))

/** Hai từ gần giống (sai một / hai ký tự: "descripton" ≈ "description"). */
const nearToken = (a: string, b: string): boolean => {
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 2) return false
  const limit = Math.min(a.length, b.length) >= 8 ? 2 : 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length] <= limit
}

/** Tên sai chính tả gần đúng — trần dưới ngưỡng chắc (cần xem); trước đây số mục phân định khi hai mục cùng điểm. */
const TYPO_CAP = 0.75
const typoSimilarity = (a: string, b: string): number => {
  const ta = [...new Set(foldTokens(a))]
  const tb = [...new Set(foldTokens(b))]
  if (!ta.length || !tb.length) return 0
  let common = 0
  let near = false
  for (const t of ta) {
    if (tb.includes(t)) common++
    else if (tb.some((u) => nearToken(t, u))) {
      common += 0.5
      near = true
    }
  }
  return near ? Math.min(TYPO_CAP, (2 * common) / (ta.length + tb.length)) : 0
}

const bestTitle = (title: string, part: PartDef): { score: number; text: string } => {
  let best = { score: 0, text: "" }
  for (const t of part.titles) {
    const score = Math.max(titleSimilarity(title, t.text), typoSimilarity(title, t.text))
    if (score > best.score) best = { score, text: t.text }
  }
  return best
}

/** Heading cha (gần nhất phía trên, cấp nhỏ hơn) của từng heading; heading cấp đầu ⇒ -1. */
const parentIndexes = (headings: MatchHeading[]): number[] => {
  const stack: number[] = []
  return headings.map((b, h) => {
    while (stack.length && headings[stack[stack.length - 1]].level! >= b.level!) stack.pop()
    const parent = stack[stack.length - 1] ?? -1
    stack.push(h)
    return parent
  })
}

/** Ngưỡng chắc chắn: phần lặp lại nhận thêm heading, heading trong chương chức năng khớp phần khác, mục mô tả tính năng. */
const STRONG_TITLE = 0.8

type Hit = { part: PartDef; score: number; title: string }

/** Phần có `parents` chỉ khớp khi heading cha giống chắc một phần cha (tên trùng ở hai chỗ: "Overview" trong Introduction). */
const inContext = (part: PartDef, parentTitle: string | null): boolean =>
  !part.parents ||
  (parentTitle !== null &&
    part.parents.some((id) => {
      const parent = partById(id)
      return !!parent && bestTitle(parentTitle, parent).score >= STRONG_TITLE
    }))

/** Phần được nhận trong chương chức năng / trong một tính năng (tổng quan chức năng 3.1 của FPT, cách chia của IEEE 830). */
const FEATURE_SCOPE_PART = /^(group:3\.1|fixed:3\.1\.)/
const allowedInFeatures = (part: PartDef): boolean =>
  FEATURE_SCOPE_PART.test(part.target) || part.target === "feature" || part.id === "part:ieee:sequence" || part.id === "part:ieee:classes"

/** Ràng buộc vòng hai cho từng heading (xem `headingScopes`). */
interface Limits {
  strict: ReadonlySet<number>
  inFeatures: ReadonlySet<number>
  detail: ReadonlySet<number>
}
const NO_LIMITS: Limits = { strict: new Set(), inFeatures: new Set(), detail: new Set() }

/**
 * Gán tham lam heading ⇒ phần theo điểm tên: mỗi phần một heading; phần `repeat` nhận thêm heading khớp chắc khác tên hoặc
 * khác mục cha (Reliability + Availability; User Interfaces trong Product Perspective và trong External Interfaces) — cùng
 * tên cùng chỗ là heading in hai lần. Bằng điểm ⇒ heading đứng trước, rồi phần có ngữ cảnh mục cha. `best` (điểm cao nhất,
 * bỏ tên quá chung) quyết định heading không khớp là "giống yếu" hay "không giống gì".
 */
const assignParts = (headings: MatchHeading[], parents: number[], limits: Limits = NO_LIMITS): { assigned: Map<number, Hit>; best: Map<number, number> } => {
  const pairs: (Hit & { h: number })[] = []
  const best = new Map<number, number>()
  headings.forEach((b, h) => {
    const parentTitle = parents[h] < 0 ? null : headings[parents[h]].title
    for (const part of PART_BANK) {
      if (part.underFeature || !inContext(part, parentTitle)) continue
      const { score, text } = bestTitle(b.title, part)
      if (!isWeakTitle(text)) best.set(h, Math.max(best.get(h) ?? 0, score))
      if (limits.detail.has(h) || (limits.inFeatures.has(h) && !allowedInFeatures(part))) continue
      if (score < (limits.strict.has(h) ? STRONG_TITLE : MATCH_MIN)) continue
      pairs.push({ h, part, score, title: text })
    }
  })
  pairs.sort((a, b) => b.score - a.score || a.h - b.h || (b.part.parents ? 1 : 0) - (a.part.parents ? 1 : 0))
  const assigned = new Map<number, Hit>()
  const used = new Map<string, Set<string>>()
  for (const p of pairs) {
    if (assigned.has(p.h)) continue
    const parentKey = parents[p.h] < 0 ? "" : foldText(headings[parents[p.h]].title)
    const place = `${foldText(p.title)}|${parentKey}`
    const seen = used.get(p.part.id)
    if (seen && !(p.part.repeat && p.score >= STRONG_TITLE && !seen.has(place))) continue
    assigned.set(p.h, { part: p.part, score: p.score, title: p.title })
    used.set(p.part.id, (seen ?? new Set()).add(place))
  }
  return { assigned, best }
}

const FEATURE_DETAIL = PART_BANK.filter((p) => p.underFeature)
const featureDetailScore = (title: string): number => Math.max(0, ...FEATURE_DETAIL.map((p) => bestTitle(title, p).score))

/**
 * Vùng của heading: trong mục có nội dung (`content`), chương chức năng (`chapter`: mục con là tính năng) hoặc một tính năng
 * (`feature`: mục con là chức năng).
 */
type Scope = "normal" | "content" | "chapter" | "feature"
const scopeOfPart = (part: PartDef): Scope =>
  part.features ? "chapter" : part.target === "feature" ? "feature" : isContentSection(part.target) && part.target !== "parent" ? "content" : "normal"

/**
 * Ràng buộc vòng hai theo kết quả gán vòng đầu — thay cho số mục trước đây (3.x là tính năng, 5.1.1 thuộc 5.1):
 * - heading nằm trong một mục có nội dung / chương chức năng / tính năng chỉ nhận phần khác khi tên khớp chắc (không thì
 *   thuộc mục cha, là tính năng hoặc chức năng);
 * - trong chương chức năng / tính năng chỉ nhận phần của chương đó (tổng quan chức năng, cách chia IEEE 830) — tính năng tên
 *   "Change Management" không thành mục Yêu cầu khác;
 * - mục mô tả trong tính năng ("Description and Priority") không gán phần nào (thuộc tính năng).
 */
const headingScopes = (headings: MatchHeading[], parents: number[], assigned: Map<number, Hit>): Limits => {
  const scope: Scope[] = []
  const strict = new Set<number>()
  const inFeatures = new Set<number>()
  const detail = new Set<number>()
  headings.forEach((b, h) => {
    const parentScope = parents[h] < 0 ? "normal" : scope[parents[h]]
    const hit = assigned.get(h)
    if (parentScope !== "normal") strict.add(h)
    if (parentScope === "chapter" || parentScope === "feature") inFeatures.add(h)
    if (parentScope === "feature" && featureDetailScore(b.title) >= STRONG_TITLE) detail.add(h)
    const kept = hit && (parentScope === "normal" || hit.score >= STRONG_TITLE) && (!inFeatures.has(h) || allowedInFeatures(hit.part))
    if (kept) scope.push(scopeOfPart(hit.part))
    else scope.push(parentScope === "chapter" || parentScope === "feature" ? "feature" : parentScope)
  })
  return { strict, inFeatures, detail }
}

/** Độ tin của tính năng / chức năng suy theo cấu trúc: mục cha chắc ⇒ 0.85, không ⇒ 0.7 (cần xem). */
const structureConfidence = (parentConfidence: number): number => (parentConfidence >= STRONG_TITLE ? 0.85 : 0.7)

/**
 * Khớp heading theo ngân hàng phần chung FPT + IEEE (FLF-363, `part-bank.ts`), không đoán họ mẫu trước, không dùng số mục.
 * 1. Gán tham lam theo tên (+ ngữ cảnh mục cha), hai vòng: vòng hai siết heading trong chương chức năng.
 * 2. Theo cấu trúc: phần `keep` ⇒ giữ nguyên văn; chương chức năng ⇒ mục con lạ là tính năng, con của tính năng là chức năng
 *    (mục mô tả tính năng thuộc tính năng); tính năng chứa chương con (Classes for classification) chỉ là heading; mục con
 *    lạ của mục có nội dung ⇒ thuộc mục đó; còn lại ⇒ không khớp.
 * 3. FLF-278: heading chưa khớp có tên đúng một phần dữ liệu Spine ⇒ gợi ý `slot:*`.
 */
const matchBankHeadings = (headings: MatchHeading[]): { entries: HeadingMapEntry[]; hits: Map<number, Hit> } => {
  const parents = parentIndexes(headings)
  const first = assignParts(headings, parents)
  const limits = headingScopes(headings, parents, first.assigned)
  const { detail } = limits
  const { assigned, best } = assignParts(headings, parents, limits)

  // Phần nhỏ ưu tiên (Purpose ⇒ slot:vision…) chỉ khi không heading nào khác nhận mục cha của nó — không thì về mục cha
  const takenBy = new Set([...assigned.values()].filter((hit) => !hit.part.slot).map((hit) => hit.part.target))
  const slotOf = new Map<number, string>()
  for (const [h, hit] of [...assigned.entries()].sort((a, b) => a[0] - b[0])) {
    const slot = hit.part.slot
    if (!slot || takenBy.has(slot) || slotParents(slot).some((p) => takenBy.has(p))) continue
    slotOf.set(h, slot)
    takenBy.add(slot)
  }

  // Tính năng chứa chương con có tính năng ⇒ chỉ là heading (không tạo tính năng rỗng "Specific requirements")
  const headingOnly = new Set<number>()
  headings.forEach((_, h) => {
    if (assigned.get(h)?.part.target !== "feature") return
    for (let k = h + 1; k < headings.length && headings[k].level! > headings[h].level!; k++) if (assigned.get(k)?.part.features) headingOnly.add(h)
  })

  const entries: HeadingMapEntry[] = []
  const stack: { level: number; section: string; features: boolean; confidence: number }[] = []
  headings.forEach((b, h) => {
    while (stack.length && stack[stack.length - 1].level >= b.level!) stack.pop()
    const parent = stack[stack.length - 1] ?? null
    const hit = assigned.get(h)
    let section: string
    let confidence: number
    let features = false
    if (detail.has(h) && parent) {
      section = parent.section
      confidence = featureDetailScore(b.title)
    } else if (hit) {
      features = !!hit.part.features
      confidence = hit.score
      const target = hit.part.target
      if (target === "keep" || headingOnly.has(h)) section = UNMAPPED_SECTION
      else if (target === "feature") section = provisionalFeatureId(b.block_id)
      else section = slotOf.get(h) ?? target
    } else if (parent?.features) {
      section = provisionalFeatureId(b.block_id)
      confidence = structureConfidence(parent.confidence)
    } else if (parent && /^feature:@/.test(parent.section)) {
      section = provisionalFunctionId(b.block_id)
      confidence = structureConfidence(parent.confidence)
    } else if (parent && isContentSection(parent.section)) {
      section = parent.section
      confidence = 0.8
    } else {
      section = UNMAPPED_SECTION
      confidence = (best.get(h) ?? 0) >= WEAK_MATCH ? 0.5 : 0.9
    }
    const detector = b.heading_detector ?? "style"
    confidence = Math.min(confidence, detectorCap(detector, b.heading_signals))
    entries.push({
      block_id: b.block_id,
      heading_text: b.text.trim(),
      section_id: section,
      confidence: round(confidence),
      detected_by: detector,
      confirmed: false,
      template_section: hit && !detail.has(h) ? hit.part.id : null
    })
    stack.push({ level: b.level!, section, features, confidence })
  })
  return { entries: withSlotSuggestions(entries), hits: assigned }
}

/**
 * Nhãn họ mẫu cho báo cáo (FLF-363): đếm heading khớp tên chỉ có ở FPT / chỉ có ở IEEE (tên chung không tính). Dưới 3 tên
 * IEEE hoặc FPT gấp đôi ⇒ `fpt`; ít tên FPT hoặc IEEE gấp đôi ⇒ `ieee29148`; còn lại ⇒ `mixed`.
 */
const familyOf = (hits: Map<number, Hit>): TemplateFamily => {
  let fpt = 0
  let ieee = 0
  for (const hit of hits.values()) {
    const origins = titleOrigins(hit.title)
    if (origins.length !== 1) continue
    if (origins[0] === "fpt") fpt++
    else ieee++
  }
  if (ieee < 3 || fpt >= 2 * ieee) return "fpt"
  if (fpt < 3 || ieee >= 2 * fpt) return "ieee29148"
  return "mixed"
}

/** Khớp heading theo ngân hàng phần (FLF-363). */
export const matchHeadings = (blocks: ProfileBlock[]): HeadingMapEntry[] => matchBankHeadings(headingsOf(blocks)).entries

/** Nhãn họ mẫu của tài liệu (chỉ để báo cáo — không quyết định cách khớp). */
export const detectTemplateFamily = (blocks: ProfileBlock[]): TemplateFamily => familyOf(matchBankHeadings(headingsOf(blocks)).hits)

/**
 * FLF-278 trên FLF-336 (business-flow 1.5): heading chưa khớp (`unmapped`, kể cả phần `keep`) mà tiêu đề chỉ đúng một
 * **phần** dữ liệu Spine (Purpose, Product Scope, Assumptions…) ⇒ gợi ý `slot:*`, độ tin dưới ngưỡng để BA xác nhận. Bỏ qua
 * khi mục FPT cha đã có heading (in hai lần) hoặc slot đã được gợi ý cho heading khác.
 */
const withSlotSuggestions = (entries: HeadingMapEntry[]): HeadingMapEntry[] => {
  const used = new Set(entries.map((e) => e.section_id))
  return entries.map((e) => {
    if (e.section_id !== UNMAPPED_SECTION) return e
    const slot = suggestSlot(e.heading_text)
    if (!slot || used.has(slot) || slotParents(slot).some((p) => used.has(p))) return e
    used.add(slot)
    return { ...e, section_id: slot, confidence: SLOT_SUGGESTION_CONFIDENCE }
  })
}

const extractsFrom = (sectionId: string | null): boolean => !!sectionId && isExtractableSection(sectionId) && targetsOf(sectionId).length > 0

/**
 * Cột bảng ⇒ field, chỉ cho bảng nằm ở section có trích (FLF-251): bảng lịch sử thay đổi, bảng dưới heading nhóm /
 * không khớp không bao giờ được trích nên không hiện ở bước xác nhận mapping (trước đây bảng Record of Changes bị đoán là NFR).
 */
export const matchTables = (blocks: ProfileBlock[], blockSections: Map<string, string | null>): TableMapEntry[] =>
  blocks
    .filter((b) => b.kind === "table" && b.rows?.length && extractsFrom(blockSections.get(b.block_id) ?? null))
    .flatMap((b) =>
      // Khớp theo tiêu đề + dữ liệu dưới tiêu đề (FLF-252): cột "#" là STT hay mã, ma trận phân quyền, hàng tiêu đề thật
      matchTable(b.rows!, blockSections.get(b.block_id) ?? null).columns.map((c) => ({
        block_id: b.block_id,
        column_index: c.column_index,
        header: c.header,
        field_path: c.field_path,
        confidence: round(c.confidence),
        confirmed: false,
        ...(c.role ? { role: c.role } : {}),
        ...(c.samples?.length ? { samples: c.samples } : {})
      }))
    )

// ─── nội dung dưới heading (FLF-363, D1–D2) ─────────────────────────

/**
 * Loại bảng ⇒ mục FPT là chỗ của nó, kèm từ phải có trong hàng tiêu đề — bảng chỉ có cột "Name / Description" khớp được
 * nhiều loại, không đủ để đổi mục. Bảng chung chung (chức năng, NFR, yêu cầu khác) không tính.
 */
const TABLE_HOME: Readonly<Record<string, { section: string; header: RegExp | null }>> = {
  actors: { section: "fixed:2.1", header: /actor|tác nhân/i },
  use_cases: { section: "fixed:2.2.2", header: /use ?case|ca sử dụng|uc/i },
  screens: { section: "fixed:3.1.2", header: /screen|màn hình/i },
  permissions: { section: "fixed:3.1.3", header: null },
  entities: { section: "fixed:3.1.5", header: /entit|thực thể|attribute|thuộc tính/i },
  business_rules: { section: "fixed:5.1", header: /rule|quy tắc|luật/i },
  messages: { section: "fixed:5.3", header: /message|thông báo/i },
  glossary: { section: "fixed:5.5", header: /term|thuật ngữ|abbreviation|acronym|viết tắt/i }
}

const tableHome = (rows: string[][]): string | null => {
  const { entity, shape } = matchTable(rows, null)
  const home = entity ? TABLE_HOME[entity] : undefined
  if (!home || (home.header && !home.header.test(shape.headers.join(" | ")))) return null
  return entity
}

/** Đoạn mở đầu bằng mã yêu cầu ⇒ mục của loại yêu cầu đó (cần ≥ 2 đoạn và chiếm đa số nội dung). */
const CODE_HOME: readonly [RegExp, string][] = [
  [/^\s*BR[-_ ]?\d+/i, "fixed:5.1"],
  [/^\s*MSG[-_ ]?\d+/i, "fixed:5.3"]
]

/** Độ tin khi đổi mục theo nội dung — dưới ngưỡng 0.8 ⇒ cờ "Cần xem". */
export const CONTENT_SWITCH_CONFIDENCE = 0.75

/**
 * Mục mà nội dung ngay dưới heading (tới heading kế) chỉ rõ: đa số bảng cùng một loại có chỗ riêng (bảng tác nhân, ERD, thuật
 * ngữ…), hoặc đa số đoạn mở đầu bằng mã BR / MSG. Không rõ ⇒ `null`.
 */
const contentHomes = (blocks: readonly ProfileBlock[]): Map<string, { section: string; entity: string | null }> => {
  const out = new Map<string, { section: string; entity: string | null }>()
  let heading: string | null = null
  let tables: string[] = []
  let codes: string[] = []
  let texts = 0
  const flush = () => {
    if (!heading) return
    const votes = new Map<string, number>()
    for (const t of tables) votes.set(t, (votes.get(t) ?? 0) + 1)
    const [entity, n] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0]
    if (entity && TABLE_HOME[entity] && n * 2 > tables.length) {
      out.set(heading, { section: TABLE_HOME[entity].section, entity })
      return
    }
    const codeVotes = new Map<string, number>()
    for (const c of codes) codeVotes.set(c, (codeVotes.get(c) ?? 0) + 1)
    const [section, m] = [...codeVotes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0]
    if (section && m >= 2 && m * 2 > texts) out.set(heading, { section, entity: null })
  }
  for (const b of blocks) {
    if (b.kind === "heading" && b.level !== null) {
      flush()
      heading = b.block_id
      tables = []
      codes = []
      texts = 0
    } else if (heading && b.kind === "table" && b.rows?.length) {
      tables.push(tableHome(b.rows) ?? "")
    } else if (heading && (b.kind === "paragraph" || b.kind === "list_item") && b.text.trim() && !isInstructionText(b.text)) {
      texts++
      const home = CODE_HOME.find(([re]) => re.test(b.text))?.[1]
      if (home) codes.push(home)
    }
  }
  flush()
  return out
}

/**
 * D1–D2: nội dung khớp chắc một mục khác mục theo tên ⇒ đổi theo nội dung (độ tin ≤ 0.75) và ghi `content_mismatch` để
 * finalize bật cờ "Tiêu đề và nội dung khác nhau"; heading không khớp tên mà nội dung rõ ⇒ đề xuất mục đó (≤ 0.75). Chỉ đổi
 * khi mục theo nội dung chưa có heading nào khác (file đã có mục "Tác nhân" thì bảng tác nhân trong "Bối cảnh" là ngữ cảnh) và
 * mục theo tên là mục có nội dung (không phải nhóm, tính năng, chức năng, phần giữ nguyên văn).
 */
const withContentSignals = (blocks: readonly ProfileBlock[], entries: HeadingMapEntry[]): HeadingMapEntry[] => {
  const homes = contentHomes(blocks)
  const used = new Set(entries.map((e) => e.section_id))
  return entries.map((e) => {
    const home = homes.get(e.block_id)
    if (!home || home.section === e.section_id || used.has(home.section)) return e
    const accepted = home.entity ? (TABLE_ENTITIES.find((d) => d.entity === home.entity)?.sections ?? []) : []
    if (accepted.includes(e.section_id)) return e
    const matchedByTitle = !!e.template_section && e.section_id !== UNMAPPED_SECTION
    const unmatched = !e.template_section && (e.section_id === UNMAPPED_SECTION || isContentSlot(e.section_id))
    if (matchedByTitle && (!isContentSection(e.section_id) || isProvisionalSection(e.section_id))) return e
    if (!matchedByTitle && !unmatched) return e
    used.add(home.section)
    return {
      ...e,
      section_id: home.section,
      confidence: Math.min(e.section_id === UNMAPPED_SECTION ? CONTENT_SWITCH_CONFIDENCE : e.confidence, CONTENT_SWITCH_CONFIDENCE),
      ...(matchedByTitle ? { content_mismatch: { by_title: e.section_id, by_content: home.section } } : {})
    }
  })
}

/** Độ dài tối đa của chữ hướng dẫn giữ cho mỗi heading. */
export const MAX_GUIDANCE_CHARS = 400

/**
 * Chữ hướng dẫn của mẫu dưới từng heading (business-flow 1.3 "detect guidance text"): các đoạn / gạch đầu dòng trước heading
 * kế tiếp mà là chữ hướng dẫn (`[…]`, "This section describes…"), bỏ ngoặc vuông bao ngoài, nối lại, cắt độ dài.
 */
export const guidanceByHeading = (blocks: readonly ProfileBlock[]): Map<string, string> => {
  const out = new Map<string, string>()
  let heading: string | null = null
  let parts: string[] = []
  const flush = () => {
    if (!heading || !parts.length) return
    const text = parts.join(" ").replace(/\s+/g, " ").trim()
    out.set(heading, text.length > MAX_GUIDANCE_CHARS ? `${text.slice(0, MAX_GUIDANCE_CHARS - 1).trimEnd()}…` : text)
  }
  for (const b of blocks) {
    if (b.kind === "heading" && b.level !== null) {
      flush()
      heading = b.block_id
      parts = []
    } else if (heading && (b.kind === "paragraph" || b.kind === "list_item") && isInstructionText(b.text)) {
      parts.push(b.text.trim().replace(/^\[([\s\S]*)\]$/, "$1").trim())
    }
  }
  flush()
  return out
}

export const matchProfile = (blocks: ProfileBlock[]): ProfileMatch => {
  const matched = matchBankHeadings(headingsOf(blocks))
  const template_family = familyOf(matched.hits)
  const guidance = guidanceByHeading(blocks)
  const labels = new Map(blocks.filter((b) => b.number_label).map((b) => [b.block_id, b.number_label!]))
  const heading_map = withContentSignals(blocks, matched.entries).map((h) => ({
    ...h,
    ...(guidance.has(h.block_id) ? { guidance: guidance.get(h.block_id)! } : {}),
    ...(labels.has(h.block_id) ? { number_label: labels.get(h.block_id)! } : {})
  }))
  const sections = assignBlockSections(blocks, heading_map)
  return {
    heading_map,
    table_map: matchTables(blocks, sections),
    language: detectLanguage(blocks),
    template_family
  }
}

/** Còn mục chưa xác nhận có độ tin dưới ngưỡng ⇒ cần bước 1.7 (chỉ còn ở bản ghi import cũ đang `mapping_review`). */
export const needsMappingReview = (profile: Pick<ProfileMatch, "heading_map" | "table_map">): boolean =>
  [...profile.heading_map, ...profile.table_map].some((e) => !e.confirmed && e.confidence < MAPPING_CONFIDENCE_THRESHOLD)

/**
 * FLF-343 (mode 1 một mạch): mục độ tin thấp chưa xác nhận ⇒ tự nhận (`confirmed` + `auto_confirmed`), **giữ nguyên độ tin**
 * để finalize gắn cờ "Cần xem" và dữ liệu đọc theo cột giữ độ tin của cột. Trả số mục đã tự nhận; sửa tại chỗ.
 */
export const autoConfirmMapping = (profile: { heading_map: HeadingMapEntry[]; table_map: TableMapEntry[] }): number => {
  let n = 0
  for (const e of [...profile.heading_map, ...profile.table_map]) {
    if (e.confirmed || e.confidence >= MAPPING_CONFIDENCE_THRESHOLD) continue
    e.confirmed = true
    e.auto_confirmed = true
    n++
  }
  return n
}

export const isProvisionalSection = (id: string): boolean => PROVISIONAL_SECTION.test(id)
