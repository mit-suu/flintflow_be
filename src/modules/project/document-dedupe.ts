/**
 * FLF-398 — nhận diện tài liệu tham khảo trùng / bản mới của tài liệu đã có. Hàm thuần (không DB).
 *
 * - Trùng hệt: cùng SHA-256 của bytes file (`contentHash`). Tài liệu upload trước FLF-398 chưa có hash ⇒ so chữ đã đọc.
 * - Có thể là bản mới (khác nội dung): cùng **tên gốc** sau khi bỏ dấu phiên bản cuối tên (`SRS_v1.docx` ~ `SRS v2 (1).docx`),
 *   hoặc nội dung giống nhau nhiều theo đoạn (`Draft.docx` → `Final.docx`). Chỉ là gợi ý — người dùng chọn thay bản cũ hay
 *   giữ cả hai.
 */

import { createHash } from "node:crypto"
import { splitParagraphs } from "../../shared/ai/document-paragraphs.js"

export const contentHashOf = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")

/** Ngưỡng độ giống nội dung (hệ số Dice trên tập đoạn đã chuẩn hoá) để hỏi "có phải bản mới?". */
export const SIMILARITY_THRESHOLD = 0.7

const stripDiacritics = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")

/**
 * Dấu phiên bản ở **cuối** tên (sau khi đã hạ chữ thường, bỏ dấu, gộp `_ - .` / khoảng trắng thành một khoảng trắng). Bỏ lặp
 * đến khi hết: `srs v2 (1)` ⇒ `srs v2` ⇒ `srs`.
 */
const VERSION_SUFFIXES: readonly RegExp[] = [
  /(?:^| )\(\d+\)$/, // (1)
  /(?:^| )(?:copy|ban sao)(?: \d+)?$/, // - Copy, Copy 2, bản sao
  /(?:^| )(?:v|ver|version|rev|r) ?\d+(?: \d+)*$/, // v1, V2, v1.0, v2.1.3, ver2, version 3, rev3, r2
  /(?:^| )(?:final|draft|ban cuoi|ban nhap)$/,
  /(?:^| )(?:ban|lan) \d+$/, // bản 2, lần 2
  /(?:^| )\d{8}$/, // 20261111
  /(?:^| )\d{4} \d{1,2} \d{1,2}$/, // 2026-11-11
  /(?:^| )\d{1,2} \d{1,2} \d{4}$/ // 11-11-2026
]

/** Tên gốc của file để so "cùng tài liệu, khác phiên bản". Bỏ hết thành rỗng (vd file tên `v1.docx`) ⇒ giữ tên trước khi bỏ. */
export const baseNameOf = (fileName: string): string => {
  const withoutExt = fileName.replace(/\.[A-Za-z0-9]{1,5}$/, "")
  let name = stripDiacritics(withoutExt)
    .toLowerCase()
    .replace(/[\s_.-]+/g, " ")
    .trim()
  for (;;) {
    const before = name
    for (const re of VERSION_SUFFIXES) name = name.replace(re, "").trim()
    if (!name) return before
    if (name === before) return name
  }
}

const normalizeParagraph = (p: string): string => stripDiacritics(p).toLowerCase().replace(/\s+/g, " ").trim()

const paragraphSet = (text: string): Set<string> => new Set(splitParagraphs(text).map(normalizeParagraph).filter(Boolean))

/** Độ giống nội dung 0..1: hệ số Dice trên tập đoạn (đoạn bị sửa tính là khác). Một bên rỗng ⇒ 0. */
export const contentSimilarity = (a: string, b: string): number => {
  const pa = paragraphSet(a)
  const pb = paragraphSet(b)
  if (pa.size === 0 || pb.size === 0) return 0
  let shared = 0
  for (const p of pa) if (pb.has(p)) shared++
  return (2 * shared) / (pa.size + pb.size)
}

/** Chữ đã đọc giống hệt (tài liệu cũ chưa có hash). */
export const sameText = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = a?.replace(/\r\n?/g, "\n").trim()
  return !!x && x === b?.replace(/\r\n?/g, "\n").trim()
}

export interface ExistingDocument {
  id: string
  name: string
  docCode: number | null
  contentHash: string | null
  extractedText: string | null
  supersededBy: string | null
}

export interface DocumentRef {
  id: string
  name: string
  doc_code: number | null
}

export type DuplicateMatch = { document: DocumentRef; supersededBy: DocumentRef | null }

const refOf = (d: ExistingDocument): DocumentRef => ({ id: d.id, name: d.name, doc_code: d.docCode })

/**
 * File mới trùng hệt tài liệu nào: ưu tiên bản đang dùng; chỉ trùng bản đã bị thay ⇒ kèm bản đang thay nó. Không trùng ⇒ `null`.
 */
export const findDuplicate = (existing: readonly ExistingDocument[], hash: string, text: string | null): DuplicateMatch | null => {
  const same = (d: ExistingDocument) => (d.contentHash ? d.contentHash === hash : sameText(d.extractedText, text))
  const active = existing.find((d) => !d.supersededBy && same(d))
  if (active) return { document: refOf(active), supersededBy: null }
  const old = existing.find((d) => d.supersededBy && same(d))
  if (!old) return null
  // Bản đang dùng ở cuối chuỗi thay thế (v1 ← v2 ← v3)
  const byId = new Map(existing.map((d) => [d.id, d]))
  let current = byId.get(old.supersededBy!)
  const seen = new Set<string>()
  while (current?.supersededBy && !seen.has(current.id)) {
    seen.add(current.id)
    current = byId.get(current.supersededBy)
  }
  return { document: refOf(old), supersededBy: current ? refOf(current) : null }
}

export type VersionReason = "same_name" | "similar_content"

export interface VersionCandidate extends DocumentRef {
  reason: VersionReason
  /** Độ giống nội dung 0..1 (làm tròn 2 chữ số). */
  similarity: number
}

/**
 * Tài liệu đang dùng mà file mới có thể là bản mới của nó: cùng tên gốc, hoặc nội dung giống ≥ ngưỡng. Bản đã bị thay không
 * là ứng viên. Sắp: cùng tên trước, rồi độ giống giảm dần.
 */
export const findVersionCandidates = (existing: readonly ExistingDocument[], fileName: string, text: string | null): VersionCandidate[] => {
  const base = baseNameOf(fileName)
  const out: VersionCandidate[] = []
  for (const d of existing) {
    if (d.supersededBy) continue
    const similarity = text && d.extractedText ? Math.round(contentSimilarity(text, d.extractedText) * 100) / 100 : 0
    if (baseNameOf(d.name) === base) out.push({ ...refOf(d), reason: "same_name", similarity })
    else if (similarity >= SIMILARITY_THRESHOLD) out.push({ ...refOf(d), reason: "similar_content", similarity })
  }
  return out.sort((a, b) => (a.reason === b.reason ? b.similarity - a.similarity : a.reason === "same_name" ? -1 : 1))
}
