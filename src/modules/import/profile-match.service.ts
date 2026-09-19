/**
 * Khớp template profile (I-3, nút 1.6) — tất định, không tốn credit. FLF-171, plan §6 2B.
 * - Heading ⇒ section registry theo độ giống tiêu đề (EN/VI, bỏ dấu) + số mục; mỗi section cố định/nhóm nhận
 *   tối đa một heading (gán tham lam theo điểm).
 * - Heading con trực tiếp của chương 3 (ngoài 3.1) ⇒ feature, con của feature ⇒ function (id tạm, xem
 *   `section-catalog.ts`); heading con khác của một section ⇒ thuộc section cha.
 * - Heading nhận theo mẫu số mục (file không dùng style) bị giới hạn độ tin 0.75 để người dùng xác nhận (P0 §4.2).
 * - Cột bảng ⇒ field theo `table-header-dictionary.ts`.
 * Độ tin < 0.8 ⇒ `mapping_review` (nút 1.7).
 */

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
import { matchTableHeader } from "./table-header-dictionary.js"
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

export const matchHeadings = (blocks: ProfileBlock[]): HeadingMapEntry[] => {
  const headings = blocks.filter((b) => b.kind === "heading" && b.level !== null)
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

export const matchTables = (blocks: ProfileBlock[], blockSections: Map<string, string | null>): TableMapEntry[] =>
  blocks
    .filter((b) => b.kind === "table" && b.rows?.length)
    .flatMap((b) =>
      matchTableHeader(b.rows![0], blockSections.get(b.block_id) ?? null).columns.map((c) => ({
        block_id: b.block_id,
        column_index: c.column_index,
        header: c.header,
        field_path: c.field_path,
        confidence: round(c.confidence),
        confirmed: false
      }))
    )

/** Section bắt buộc (registry `required`, không suy dẫn) không có heading nào khớp. */
export const missingRequiredSections = (headingMap: HeadingMapEntry[]): string[] => {
  const mapped = new Set(headingMap.map((h) => h.section_id))
  return SECTION_CANDIDATES.filter((c) => c.kind === "fixed" && c.required && !mapped.has(c.id) && c.id !== "fixed:5.5").map((c) => c.id)
}

export const matchProfile = (blocks: ProfileBlock[]): ProfileMatch => {
  const heading_map = matchHeadings(blocks)
  const sections = assignBlockSections(blocks, heading_map)
  return {
    heading_map,
    table_map: matchTables(blocks, sections),
    required_sections: missingRequiredSections(heading_map),
    language: detectLanguage(blocks)
  }
}

/** Còn mục chưa xác nhận có độ tin dưới ngưỡng ⇒ cần bước 1.7. */
export const needsMappingReview = (profile: Pick<ProfileMatch, "heading_map" | "table_map">): boolean =>
  [...profile.heading_map, ...profile.table_map].some((e) => !e.confirmed && e.confidence < MAPPING_CONFIDENCE_THRESHOLD)

export const isProvisionalSection = (id: string): boolean => PROVISIONAL_SECTION.test(id)
