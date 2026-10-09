/**
 * Khớp template profile (I-3, nút 1.6) — tất định, không tốn credit. FLF-171, plan §6 2B.
 * - FLF-252: nhận họ mẫu trước (FPT / IEEE 830 / IEEE dạng System Features — `template-catalog.ts`); mẫu IEEE khớp theo
 *   danh mục IEEE rồi trích vào section FPT (nhiều mục IEEE có thể cùng một section), mục chỉ có ở IEEE giữ nguyên văn.
 * - Mẫu FPT: heading ⇒ section registry theo độ giống tiêu đề (EN/VI, bỏ dấu) + số mục; mỗi section cố định/nhóm nhận
 *   tối đa một heading (gán tham lam theo điểm).
 * - Heading con trực tiếp của chương 3 (ngoài 3.1) ⇒ feature, con của feature ⇒ function (id tạm, xem
 *   `section-catalog.ts`); heading con khác của một section ⇒ thuộc section cha.
 * - Heading nhận theo mẫu số mục (file không dùng style) bị giới hạn độ tin 0.75 để người dùng xác nhận (P0 §4.2).
 * - Cột bảng ⇒ field theo `table-header-dictionary.ts`.
 * Độ tin < 0.8 ⇒ `mapping_review` (nút 1.7).
 */

import { isExtractableSection, targetsOf } from "./extract-targets.js"
import { MAPPING_CONFIDENCE_THRESHOLD, UNMAPPED_SECTION, type HeadingDetector } from "./import.constants.js"
import type { ParsedBlock } from "./parse.service.js"
import {
  PROVISIONAL_SECTION,
  SECTION_CANDIDATES,
  isContentSection,
  provisionalFeatureId,
  provisionalFunctionId,
  type SectionCandidate
} from "./section-catalog.js"
import { matchTable } from "./table-header-dictionary.js"
import { TEMPLATE_CATALOGS, type TemplateEntry, type TemplateFamily } from "./template-catalog.js"
import type { HeadingMapEntry, TableMapEntry } from "./template-profile.model.js"
import { splitHeadingNumber, titleSimilarity } from "./text-similarity.js"

/** Block tối thiểu để khớp profile / gán section (DocBlock đã lưu cũng dùng được). */
export interface ProfileBlock {
  block_id: string
  kind: ParsedBlock["kind"]
  level: number | null
  text: string
  heading_detector?: HeadingDetector | null
  rows?: string[][] | null
}

export interface ProfileMatch {
  heading_map: HeadingMapEntry[]
  table_map: TableMapEntry[]
  required_sections: string[]
  language: string
  /** FLF-252: họ mẫu nhận được (`fpt` / `ieee830` / `ieee_features`). */
  template_family: TemplateFamily
}

const MATCH_MIN = 0.5
const WEAK_MATCH = 0.35
const NUMBERING_PATTERN_CAP = 0.75
const round = (n: number): number => Math.round(n * 100) / 100

const scoreHeading = (text: string, cand: SectionCandidate): number => {
  const { number, title } = splitHeadingNumber(text)
  const t = Math.max(...cand.titles.map((alias) => Math.max(titleSimilarity(title, alias), titleSimilarity(text, alias))))
  if (!number) return t
  const n = number === cand.number ? 1 : 0
  return 0.7 * t + 0.3 * n
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

const headingsOf = (blocks: ProfileBlock[]): ProfileBlock[] => blocks.filter((b) => b.kind === "heading" && b.level !== null)

/**
 * Heading khớp chắc một mục của danh mục: tên giống ≥ 0.8 và (mục hoặc heading không đánh số, hoặc số mục trùng). Heading
 * không số chỉ xét tên — trước đây file IEEE không đánh số không bao giờ được nhận là IEEE.
 */
const STRONG_TITLE = 0.8
const familyScore = (headings: ProfileBlock[], entries: readonly { number: string; titles: readonly string[] }[]): number =>
  headings.filter((b) => {
    const { number, title } = splitHeadingNumber(b.text)
    return entries.some((c) => (!c.number || !number || number === c.number) && Math.max(...c.titles.map((t) => titleSimilarity(title, t))) >= STRONG_TITLE)
  }).length

/**
 * Họ mẫu của tài liệu (FLF-252): chấm cả dàn heading với từng danh mục (FPT, IEEE 830, IEEE dạng System Features) theo số
 * mục + tên. Chỉ chọn mẫu khác FPT khi khớp chắc ≥ 3 heading và hơn hẳn FPT — tài liệu ít heading vẫn khớp như FPT.
 */
export const detectTemplateFamily = (blocks: ProfileBlock[]): TemplateFamily => {
  const headings = headingsOf(blocks)
  const fpt = familyScore(headings, SECTION_CANDIDATES)
  let best: { family: TemplateFamily; score: number } = { family: "fpt", score: fpt }
  for (const [family, entries] of Object.entries(TEMPLATE_CATALOGS) as [Exclude<TemplateFamily, "fpt">, readonly TemplateEntry[]][]) {
    const score = familyScore(headings, entries)
    if (score >= 3 && score > best.score) best = { family, score }
  }
  return best.family
}

const aliasSimilarity = (text: string, titles: readonly string[]): number => {
  const { title } = splitHeadingNumber(text)
  return Math.max(...titles.map((alias) => Math.max(titleSimilarity(title, alias), titleSimilarity(text, alias))))
}

/** Mục cha theo số trong cùng danh mục (`3.1.1` ⇒ `3.1`); mục không số / chương ⇒ `null`. */
const parentEntryOf = (entry: TemplateEntry, catalog: readonly TemplateEntry[]): TemplateEntry | null => {
  const dot = entry.number.lastIndexOf(".")
  if (dot < 0) return null
  const parent = entry.number.slice(0, dot)
  return catalog.find((c) => c.number === parent) ?? null
}

/**
 * Điểm khớp heading ↔ mục danh mục: mục không đánh số chỉ theo tên; heading không số ⇒ tên × 0.8. Tên trùng ở hai chỗ của
 * mẫu (User Interfaces 2.1.2 / 3.1.1, Specific Requirements 3 / 3.2): heading cha giống mục cha của mục danh mục ⇒ cộng điểm,
 * để file đánh số khác mẫu (hoặc không đánh số) vẫn vào đúng chỗ.
 */
const scoreEntry = (text: string, entry: TemplateEntry, parentText: string | null, catalog: readonly TemplateEntry[]): number => {
  const { number } = splitHeadingNumber(text)
  const t = aliasSimilarity(text, entry.titles)
  if (!entry.number) return t
  const parentEntry = parentText === null ? null : parentEntryOf(entry, catalog)
  const inContext = parentEntry !== null && aliasSimilarity(parentText!, parentEntry.titles) >= STRONG_TITLE
  if (!number) return (inContext ? 0.95 : 0.8) * t
  if (number === entry.number) return 0.7 * t + 0.3
  return 0.7 * t + (inContext ? 0.2 : 0)
}

/** Heading cha (gần nhất phía trên, cấp nhỏ hơn) của từng heading; heading cấp đầu ⇒ `null`. */
const parentHeadingTexts = (headings: ProfileBlock[]): (string | null)[] => {
  const stack: ProfileBlock[] = []
  return headings.map((b) => {
    while (stack.length && stack[stack.length - 1].level! >= b.level!) stack.pop()
    const parent = stack[stack.length - 1]?.text ?? null
    stack.push(b)
    return parent
  })
}

/** Độ tin của feature/function suy theo cấu trúc ở mẫu không phải FPT — luôn để người dùng xác nhận (FLF-252). */
const NON_FPT_STRUCTURE_CAP = 0.75

/**
 * Khớp heading theo danh mục mẫu IEEE (FLF-252). Mỗi mục danh mục nhận tối đa một heading (trừ mục `parent` lặp lại dưới
 * mỗi tính năng), nhưng nhiều mục có thể cùng trích vào một section FPT. Heading không khớp danh mục: dưới mục `features`
 * ⇒ tính năng, dưới tính năng ⇒ chức năng (độ tin ≤ 0.75 — cần xác nhận), dưới mục có nội dung ⇒ thuộc mục đó, còn lại
 * ⇒ giữ nguyên văn.
 */
const matchWithCatalog = (headings: ProfileBlock[], catalog: readonly TemplateEntry[]): HeadingMapEntry[] => {
  const pairs: { h: number; c: TemplateEntry; score: number }[] = []
  const best = new Map<number, number>()
  const parents = parentHeadingTexts(headings)
  headings.forEach((b, h) => {
    for (const c of catalog) {
      const score = scoreEntry(b.text, c, parents[h], catalog)
      best.set(h, Math.max(best.get(h) ?? 0, score))
      if (score >= MATCH_MIN) pairs.push({ h, c, score })
    }
  })
  pairs.sort((a, b) => b.score - a.score || a.h - b.h)
  const assigned = new Map<number, { entry: TemplateEntry; score: number }>()
  const used = new Set<string>()
  for (const p of pairs) {
    if (assigned.has(p.h) || (p.c.target !== "parent" && used.has(p.c.id))) continue
    assigned.set(p.h, { entry: p.c, score: p.score })
    used.add(p.c.id)
  }

  // Mục `feature` có mục con chứa tính năng (3.2 › 3.2.2 Classes for classification) ⇒ chỉ là heading: tính năng nằm dưới
  // mục con, không tạo thêm tính năng rỗng mang tên "Specific requirements"
  const headingOnly = new Set<number>()
  headings.forEach((b, h) => {
    if (assigned.get(h)?.entry.target !== "feature") return
    for (let k = h + 1; k < headings.length && headings[k].level! > b.level!; k++) {
      if (assigned.get(k)?.entry.features) headingOnly.add(h)
    }
  })

  const entries: HeadingMapEntry[] = []
  const stack: { level: number; section: string; features: boolean }[] = []
  headings.forEach((b, h) => {
    while (stack.length && stack[stack.length - 1].level >= b.level!) stack.pop()
    const parent = stack[stack.length - 1] ?? null
    const hit = assigned.get(h)
    let section: string
    let confidence: number
    let features = false
    if (hit) {
      features = !!hit.entry.features
      confidence = hit.score
      const target = hit.entry.target
      if (target === "keep" || headingOnly.has(h)) section = UNMAPPED_SECTION
      else if (target === "feature") section = provisionalFeatureId(b.block_id)
      else if (target === "parent") section = parent && isContentSection(parent.section) ? parent.section : UNMAPPED_SECTION
      else section = target
    } else if (parent?.features) {
      section = provisionalFeatureId(b.block_id)
      confidence = NON_FPT_STRUCTURE_CAP
    } else if (parent && /^feature:@/.test(parent.section)) {
      section = provisionalFunctionId(b.block_id)
      confidence = NON_FPT_STRUCTURE_CAP
    } else if (parent && isContentSection(parent.section)) {
      section = parent.section
      confidence = 0.8
    } else {
      section = UNMAPPED_SECTION
      confidence = (best.get(h) ?? 0) >= WEAK_MATCH ? 0.5 : 0.9
    }
    const detector = b.heading_detector ?? "style"
    if (detector === "numbering_pattern") confidence = Math.min(confidence, NUMBERING_PATTERN_CAP)
    entries.push({
      block_id: b.block_id,
      heading_text: b.text.trim(),
      section_id: section,
      confidence: round(confidence),
      detected_by: detector,
      confirmed: false,
      template_section: hit?.entry.id ?? null
    })
    stack.push({ level: b.level!, section, features })
  })
  return entries
}

/** Khớp heading theo họ mẫu (FLF-252); không truyền ⇒ tự nhận họ mẫu. */
export const matchHeadings = (blocks: ProfileBlock[], family: TemplateFamily = detectTemplateFamily(blocks)): HeadingMapEntry[] =>
  family === "fpt" ? matchFptHeadings(headingsOf(blocks)) : matchWithCatalog(headingsOf(blocks), TEMPLATE_CATALOGS[family])

const matchFptHeadings = (headings: ProfileBlock[]): HeadingMapEntry[] => {
  // 1. Gán tham lam section cố định/nhóm
  const pairs: { h: number; c: SectionCandidate; score: number }[] = []
  const best = new Map<number, number>()
  headings.forEach((b, h) => {
    for (const c of SECTION_CANDIDATES) {
      const score = scoreHeading(b.text, c)
      best.set(h, Math.max(best.get(h) ?? 0, score))
      if (score >= MATCH_MIN) pairs.push({ h, c, score })
    }
  })
  pairs.sort((a, b) => b.score - a.score || a.h - b.h)
  const assigned = new Map<number, { section: string; confidence: number }>()
  const usedCandidates = new Set<string>()
  for (const p of pairs) {
    if (assigned.has(p.h) || usedCandidates.has(p.c.id)) continue
    assigned.set(p.h, { section: p.c.id, confidence: p.score })
    usedCandidates.add(p.c.id)
  }

  // 2. Heading còn lại: feature/function theo cấu trúc chương 3, hoặc thuộc section cha
  const entries: HeadingMapEntry[] = []
  const stack: { level: number; section: string }[] = []
  headings.forEach((b, h) => {
    while (stack.length && stack[stack.length - 1].level >= b.level!) stack.pop()
    const parent = stack[stack.length - 1]?.section ?? null
    const { number } = splitHeadingNumber(b.text)
    let hit = assigned.get(h)
    if (!hit) {
      if (parent === "group:3") {
        hit = { section: provisionalFeatureId(b.block_id), confidence: number && /^3\.([2-9]|\d{2})$/.test(number) ? 0.85 : 0.7 }
      } else if (parent && /^feature:@/.test(parent)) {
        hit = { section: provisionalFunctionId(b.block_id), confidence: number && /^3\.\d+\.\d+$/.test(number) ? 0.85 : 0.7 }
      } else if (isContentSection(parent)) {
        hit = { section: parent, confidence: 0.8 }
      } else {
        hit = { section: UNMAPPED_SECTION, confidence: (best.get(h) ?? 0) >= WEAK_MATCH ? 0.5 : 0.9 }
      }
    }
    const detector = b.heading_detector ?? "style"
    const confidence = detector === "numbering_pattern" ? Math.min(hit.confidence, NUMBERING_PATTERN_CAP) : hit.confidence
    entries.push({ block_id: b.block_id, heading_text: b.text.trim(), section_id: hit.section, confidence: round(confidence), detected_by: detector, confirmed: false })
    stack.push({ level: b.level!, section: hit.section })
  })
  return entries
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

/**
 * Đầu mục mẫu FPT không có heading nào khớp. Mode 1 v2 (D6, FLF-183): **mọi** đầu mục FPT là cốt lõi — chỉ trừ
 * Record of Changes (`fixed:I`) vì hệ thống tự sinh từ lịch sử thay đổi.
 */
export const missingRequiredSections = (headingMap: HeadingMapEntry[]): string[] => {
  const mapped = new Set(headingMap.map((h) => h.section_id))
  return SECTION_CANDIDATES.filter((c) => c.kind === "fixed" && !mapped.has(c.id) && c.id !== "fixed:I").map((c) => c.id)
}

export const matchProfile = (blocks: ProfileBlock[]): ProfileMatch => {
  const template_family = detectTemplateFamily(blocks)
  const heading_map = matchHeadings(blocks, template_family)
  const sections = assignBlockSections(blocks, heading_map)
  return {
    heading_map,
    table_map: matchTables(blocks, sections),
    required_sections: missingRequiredSections(heading_map),
    language: detectLanguage(blocks),
    template_family
  }
}

/** Còn mục chưa xác nhận có độ tin dưới ngưỡng ⇒ cần bước 1.7. */
export const needsMappingReview = (profile: Pick<ProfileMatch, "heading_map" | "table_map">): boolean =>
  [...profile.heading_map, ...profile.table_map].some((e) => !e.confirmed && e.confidence < MAPPING_CONFIDENCE_THRESHOLD)

export const isProvisionalSection = (id: string): boolean => PROVISIONAL_SECTION.test(id)
