/**
 * FLF-278 trên FLF-335/336 — áp mapping heading đã lưu của mẫu tổ chức lên lần import mới (gọi từ `import.service#runParse`).
 * Tách khỏi `org-library.service` để `import.service` không phụ thuộc vòng vào service thư viện.
 */
import type mongoose from "mongoose"
import { OrgTemplate, OrgTemplateVersion, type OrgTemplateHeading } from "./org-library.model.js"
import type { HeadingMapEntry } from "./template-profile.model.js"

/** Khoá so khớp tiêu đề mục: bỏ số gõ tay đầu dòng, dấu câu, hoa/thường, khoảng trắng; giữ dấu tiếng Việt. */
export const normalizeTitle = (text: string): string =>
  text
    .normalize("NFC")
    .toLowerCase()
    .replace(/^\s*(?:\d+(?:\.\d+)*[.)]?|[ivxlc]+[.)]|[a-z][.)])\s+/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()

/**
 * Áp mapping đã lưu lên heading vừa đọc lại từ cùng file mẫu: cùng thứ tự + cùng tiêu đề ⇒ lấy `section_id` BA đã xác
 * nhận (đã xác nhận, độ tin 1). Heading lệch (file khác bản) giữ đề xuất của matcher, BA xác nhận lại ở 1.5.
 */
export const applyOrgMapping = (entries: readonly HeadingMapEntry[], saved: readonly OrgTemplateHeading[]): HeadingMapEntry[] =>
  entries.map((e, i) => {
    const s = saved[i]
    return s && normalizeTitle(s.heading_text) === normalizeTitle(e.heading_text) ? { ...e, section_id: s.section_id, confidence: 1, confirmed: true } : e
  })

/**
 * Mapping đã lưu của mẫu tổ chức theo đúng bản lúc import (FLF-395) — không theo bản mới nhất. Import cũ (trước FLF-395,
 * không có `version`) ⇒ bản 1 nếu họ đã migrate, chưa migrate thì mapping nằm trên họ mẫu.
 */
export const orgTemplateHeadings = async (orgTemplateId: mongoose.Types.ObjectId | string, version: number | null = null): Promise<OrgTemplateHeading[] | null> => {
  const v = await OrgTemplateVersion.findOne({ template_id: orgTemplateId, version: version ?? 1 }).select("headings").lean()
  if (v) return v.headings
  if (version) return null
  const t = await OrgTemplate.findById(orgTemplateId).select("headings").lean()
  return t?.headings ?? null
}

// ─── FLF-459: I-3 tự khớp mẫu thư viện org (business-flow §3.1 dòng I-3) ─────────

/** Một bản mẫu đã đăng trong thư viện org (mapping heading theo thứ tự file mẫu). */
export interface OrgTemplateCandidate {
  template_id: string
  version: number
  headings: OrgTemplateHeading[]
}

/** Mẫu đã khớp: cặp (vị trí heading của file, vị trí heading của mẫu) cùng tên, theo đúng thứ tự. */
export interface OrgTemplateHit {
  template_id: string
  version: number
  headings: OrgTemplateHeading[]
  pairs: [number, number][]
}

/** Tối thiểu số heading cùng tên với mẫu (mẫu quá ngắn khớp nhầm quá dễ). */
export const ORG_MATCH_MIN_HEADINGS = 3
/** Tỉ lệ heading của mẫu phải có trong file (cùng tên, đúng thứ tự). File điền mẫu thêm tính năng / chức năng vẫn khớp. */
export const ORG_MATCH_MIN_COVERAGE = 0.8

/** Dãy con chung dài nhất theo tên heading đã chuẩn hoá (giữ thứ tự) — file có thêm / bớt heading vẫn ghép đúng phần còn lại. */
const alignHeadings = (file: readonly string[], saved: readonly string[]): [number, number][] => {
  const n = file.length
  const m = saved.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = file[i] && file[i] === saved[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const pairs: [number, number][] = []
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (file[i] && file[i] === saved[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return pairs
}

/**
 * Chọn mẫu thư viện khớp file (không cần người chọn): heading của file ghép với heading của mẫu theo tên + thứ tự; mẫu đạt
 * khi có ≥ 3 heading ghép được và phủ ≥ 80% heading của mẫu. Nhiều mẫu đạt ⇒ nhiều heading ghép nhất, rồi phủ cao hơn, rồi bản
 * mới hơn. Không mẫu nào đạt ⇒ `null` (file khớp như mẫu mới của riêng dự án).
 */
export const pickOrgTemplate = (entries: readonly Pick<HeadingMapEntry, "heading_text">[], candidates: readonly OrgTemplateCandidate[]): OrgTemplateHit | null => {
  const file = entries.map((e) => normalizeTitle(e.heading_text))
  let best: (OrgTemplateHit & { coverage: number }) | null = null
  for (const c of candidates) {
    if (!c.headings.length) continue
    const pairs = alignHeadings(file, c.headings.map((h) => normalizeTitle(h.heading_text)))
    const coverage = pairs.length / c.headings.length
    if (pairs.length < ORG_MATCH_MIN_HEADINGS || coverage < ORG_MATCH_MIN_COVERAGE) continue
    const better =
      !best ||
      pairs.length > best.pairs.length ||
      (pairs.length === best.pairs.length && (coverage > best.coverage || (coverage === best.coverage && c.version > best.version)))
    if (better) best = { template_id: c.template_id, version: c.version, headings: c.headings, pairs, coverage }
  }
  if (!best) return null
  const { coverage: _coverage, ...hit } = best
  return hit
}

/**
 * Áp mapping của mẫu đã khớp: heading ghép được lấy `section_id` Lead đã xác nhận (độ tin 1, đã xác nhận) — tín hiệu Code: đúng
 * một heading của mẫu cùng tên, đúng thứ tự. Heading của file không có trong mẫu giữ đề xuất của matcher.
 */
export const applyMatchedOrgMapping = (entries: readonly HeadingMapEntry[], hit: OrgTemplateHit): HeadingMapEntry[] => {
  const savedOf = new Map(hit.pairs)
  return entries.map((e, i) => {
    const s = savedOf.has(i) ? hit.headings[savedOf.get(i)!] : undefined
    return s ? { ...e, section_id: s.section_id, confidence: 1, confirmed: true } : e
  })
}

/** Các bản mẫu đã đăng trong thư viện của org (không gồm bản riêng của một dự án, bản nháp). */
export const orgLibraryTemplates = async (orgId: mongoose.Types.ObjectId | string | null | undefined): Promise<OrgTemplateCandidate[]> => {
  if (!orgId) return []
  const rows = await OrgTemplateVersion.find({ orgId, status: "published", visibility: "org" }).select("template_id version headings").lean()
  return rows.map((r) => ({ template_id: String(r.template_id), version: r.version, headings: r.headings ?? [] }))
}
