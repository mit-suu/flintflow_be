/**
 * srs-detect.ts — I-1 Preflight: tài liệu này có phải SRS / mẫu SRS không? (FLF-331, business-flow §3.1)
 * ─────────────────────────────────────────────────────────────────
 * Hàm thuần, **không gọi model, không tốn credit**: đếm tín hiệu trên khối đã cắt (`readBlocks`) — heading khớp danh
 * mục section FPT / mẫu IEEE, từ khoá kiểu SRS, mã `UC-01` / `FR-01`, bảng có cột use case / requirement — và tín hiệu
 * "loại tài liệu khác" (CV, hoá đơn, test plan, biên bản họp, hợp đồng).
 *
 * Trả **loại + độ tin + lý do**, không chỉ boolean (ghi chú hybrid plan B4: sau này preflight điều hướng theo loại file):
 * - `srs` / `srs_template` ⇒ đi tiếp (mẫu trống chỉ có heading + chữ hướng dẫn vẫn là mẫu SRS — chế độ 3/4);
 * - `not_srs` ⇒ preflight từ chối `NOT_SRS` kèm lý do ngắn — gồm cả file mà tiêu đề nói là loại tài liệu khác (SDD, kế hoạch
 *   dự án, tài liệu test…; `otherTitles`), vì chúng dùng chung từ vựng SRS nên điểm tín hiệu không phân biệt được;
 * - `unknown` ⇒ preflight cũng từ chối `NOT_SRS` ("không đủ dấu hiệu SRS") khi file không có lỗi nào khác — file không liên quan
 *   không vào luồng import (kể cả làm mẫu bắt buộc). SRS viết tự do vẫn có từ khoá + mã yêu cầu nên ra `srs`.
 * Ngưỡng và danh sách tín hiệu gom ở `SRS_DETECT_CONFIG` để chỉnh một chỗ.
 */

import type { OoxmlBlock } from "../docx-ooxml/index.js"
import { SECTION_CANDIDATES } from "./section-catalog.js"
import { TEMPLATE_CATALOGS } from "./template-catalog.js"

export type DocumentKind = "srs" | "srs_template" | "not_srs" | "unknown"

export interface DocumentKindResult {
  kind: DocumentKind
  /** 0–1, chỉ để hiển thị / xếp hạng; quyết định đi theo `kind`. */
  confidence: number
  /** Tín hiệu đã bắt được, mã ngắn (`heading:fixed:2.2.2`, `keyword:use case`, `id:UC`, `table:use_case`, `against:cv`). */
  signals: string[]
  /** Câu cho người dùng vì sao bị coi là không phải SRS / chưa chắc. */
  reasons: string[]
}

export type DetectableBlock = Pick<OoxmlBlock, "kind" | "text" | "level" | "rows">

/** Danh sách tín hiệu + ngưỡng — sửa ở đây, không rải trong code. */
export const SRS_DETECT_CONFIG = {
  /** Điểm tối thiểu để coi là SRS (không cần người xác nhận). */
  srsScore: 4,
  /** Dưới ngưỡng này **và** có tín hiệu loại khác ⇒ `not_srs`; dưới ngưỡng mà không có tín hiệu loại khác ⇒ `unknown`. */
  unknownScore: 2,
  /** Tiêu đề tài liệu / đoạn đầu nói thẳng đây là SRS. */
  titlePatterns: [
    /software\s+requirements?\s+specification/i,
    /\bSRS\b/,
    /requirements?\s+specification/i,
    /đặc\s*tả\s+yêu\s*cầu/i,
    /tài\s+liệu\s+yêu\s*cầu/i,
    /yêu\s*cầu\s+phần\s+mềm/i
  ],
  /** Từ khoá kiểu SRS trong chữ thường (đếm theo khoá, không theo số lần). */
  keywords: {
    use_case: /\buse\s*cases?\b|ca\s+sử\s+dụng/i,
    actor: /\bactors?\b|tác\s+nhân/i,
    functional_requirement: /functional\s+requirements?|yêu\s*cầu\s+chức\s+năng/i,
    non_functional: /non[-\s]?functional|phi\s+chức\s+năng/i,
    business_rule: /business\s+rules?|quy\s+tắc\s+nghiệp\s+vụ|luật\s+nghiệp\s+vụ/i,
    user_story: /user\s+stor(y|ies)|acceptance\s+criteria/i,
    stakeholder: /stakeholders?|bên\s+liên\s+quan/i,
    screen: /\bscreens?\b|wireframes?|màn\s+hình/i,
    glossary: /glossary|thuật\s+ngữ/i,
    nfr_words: /\b(performance|reliability|availability|usability|security)\b|hiệu\s+năng|độ\s+tin\s+cậy|bảo\s+mật/i
  } as Record<string, RegExp>,
  /** Mã yêu cầu: `UC-01`, `FR01`, `NFR-3`, `BR-12`, `REQ-007`, `US-4`. */
  idPattern: /\b(UC|FR|NFR|BR|REQ|US|SR|FN)[-_ ]?\d{1,4}\b/g,
  /** Bảng SRS: hàng đầu có ≥ 2 cột trong nhóm này. */
  tableHeaderWords: /\b(id|use\s*case|actor|requirement|priority|description|precondition|postcondition|trigger|screen|function|rule)\b|mã|tác\s+nhân|mô\s+tả|điều\s+kiện|ưu\s+tiên|màn\s+hình|chức\s+năng/i,
  /** Dấu hiệu tài liệu KHÁC — mỗi loại cần ≥ `againstMinHits` lượt khớp mới tính. */
  against: {
    cv: /curriculum\s+vitae|\bresume\b|work\s+experience|\beducation\b|\bskills?\b|hobbies|kinh\s+nghiệm\s+làm\s+việc|học\s+vấn|kỹ\s+năng|sơ\s+yếu\s+lý\s+lịch/i,
    invoice: /\binvoice\b|hoá\s+đơn|hóa\s+đơn|tổng\s+tiền|thành\s+tiền|\bVAT\b|thuế\s+GTGT|đơn\s+giá|số\s+lượng|unit\s+price|subtotal|amount\s+due/i,
    test_plan: /test\s+(plan|case|suite|scenario)|expected\s+result|actual\s+result|kịch\s+bản\s+kiểm\s+thử|kế\s+hoạch\s+kiểm\s+thử|kết\s+quả\s+mong\s+đợi|kết\s+quả\s+thực\s+tế|\bpass\/fail\b/i,
    meeting: /meeting\s+minutes|minutes\s+of\s+meeting|biên\s+bản\s+họp|attendees|thành\s+phần\s+tham\s+dự|agenda|action\s+items/i,
    contract: /\bcontract\b|hợp\s+đồng|bên\s+a\b|bên\s+b\b|điều\s+khoản|party\s+a|party\s+b/i
  } as Record<string, RegExp>,
  againstMinHits: 2,
  /**
   * Tiêu đề (đoạn đầu) nói thẳng là tài liệu KHÁC — vd báo cáo đồ án "Report 4 – Software Design Document". Các tài liệu
   * này dùng chung từ vựng SRS (use case, actor, mã UC) nên điểm tín hiệu không phân biệt được; tiêu đề thì rõ. Tiêu đề
   * SRS (`titlePatterns`) thắng.
   */
  otherTitles: {
    design: /software\s+(architecture\s+and\s+)?design\s+(document|description|specification)|\bSDD\b|tài\s+liệu\s+thiết\s+kế|đặc\s*tả\s+thiết\s+kế|thiết\s+kế\s+(phần\s+mềm|hệ\s+thống)/i,
    project_plan: /project\s+management\s+plan|software\s+project\s+management\s+plan|\bSPMP\b|kế\s+hoạch\s+quản\s+lý\s+dự\s+án/i,
    // "test plan" / "kế hoạch kiểm thử" đã có ở `against.test_plan` (theo nội dung) — ở đây chỉ tên tài liệu test của báo cáo
    test_doc: /(software\s+)?test(ing)?\s+(document(ation)?|specification|report)\b|tài\s+liệu\s+kiểm\s+thử/i,
    user_guide: /\buser\s+(guide|manual)\b|installation\s+guide|hướng\s+dẫn\s+(sử\s+dụng|cài\s+đặt)/i,
    project_intro: /project\s+introduction|giới\s+thiệu\s+dự\s+án/i
  } as Record<string, RegExp>,
  /** Mẫu trống / điền dở: ≥ tỉ lệ này đoạn nội dung là chữ hướng dẫn (hoặc không có đoạn nào) ⇒ `srs_template`. */
  templateInstructionRatio: 0.6,
  /** Văn xuôi không cấu trúc chỉ bị coi là `not_srs` khi đủ dài (số khối chữ và số từ); ngắn hơn ⇒ `unknown`. */
  proseMinBlocks: 8,
  proseMinWords: 80,
  /** Chữ hướng dẫn của mẫu: trong ngoặc, hoặc câu "Mục này mô tả…" / "This section describes…" (business-flow §3.1.1 lớp 3). */
  instructionPatterns: [/^[[<{(].*[\]>})]$/s, /^(this|the) section (describes|should|lists|contains)/i, /^(mục|phần) này (mô tả|trình bày|liệt kê|nêu)/i]
} as const

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFC")
    .replace(/^[\s\d.)(ivxlc]+(?=[a-zà-ỹ])/i, "") // bỏ số mục đầu dòng: "2.2.1 ", "III. "
    .replace(/[^\p{L}\p{N}\s&,/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()

/** Tiêu đề của mọi section / mục mẫu đã biết (FPT + IEEE) ⇒ (title chuẩn hoá → id). */
const KNOWN_HEADINGS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>()
  for (const c of SECTION_CANDIDATES) for (const t of c.titles) map.set(normalize(t), c.id)
  for (const entries of Object.values(TEMPLATE_CATALOGS)) for (const e of entries) for (const t of e.titles) if (!map.has(normalize(t))) map.set(normalize(t), e.id)
  return map
})()

const isHeading = (b: DetectableBlock): boolean => b.kind === "heading" || (b.level !== null && b.kind !== "table")

/** Heading khớp danh mục: so cả câu, rồi so phần sau dấu `:` / `-` (vd "Chương 2: Use Case"). */
const matchHeading = (text: string): string | null => {
  const n = normalize(text)
  if (!n) return null
  if (KNOWN_HEADINGS.has(n)) return KNOWN_HEADINGS.get(n)!
  for (const part of n.split(/[:\-–—]/).map((x) => x.trim()).filter(Boolean)) if (KNOWN_HEADINGS.has(part)) return KNOWN_HEADINGS.get(part)!
  return null
}

const round = (x: number): number => Math.round(x * 100) / 100

export const classifyDocument = (blocks: readonly DetectableBlock[]): DocumentKindResult => {
  const cfg = SRS_DETECT_CONFIG
  const signals: string[] = []
  const reasons: string[] = []
  let score = 0

  const tableText = (b: DetectableBlock): string => (b.rows ?? []).map((r) => r.join(" | ")).join("\n")
  const textOf = (b: DetectableBlock): string => (b.kind === "table" ? tableText(b) || b.text : b.text)
  const textBlocks = blocks.filter((b) => textOf(b).trim())
  const headings = textBlocks.filter(isHeading)
  const bodyParagraphs = textBlocks.filter((b) => !isHeading(b) && b.kind !== "table")
  const allText = textBlocks.map(textOf).join("\n")

  // 1. Tiêu đề tài liệu: 5 đoạn chữ đầu, hoặc heading cấp 1 đầu tiên
  const head = textBlocks.slice(0, 5).map(textOf).join("\n")
  if (cfg.titlePatterns.some((re) => re.test(head))) {
    score += 3
    signals.push("title:srs")
  }
  // Tiêu đề nói là loại tài liệu khác (SDD, kế hoạch dự án, tài liệu test…) ⇒ không phải SRS, bất kể từ vựng bên trong. Chỉ đọc
  // đoạn văn đầu file: bảng Record of Changes ngay sau bìa hay nhắc "SRS" (tài liệu test / thiết kế bám SRS) — không phải tiêu đề
  const titleHead = textBlocks.filter((b) => b.kind !== "table").slice(0, 5).map(textOf).join("\n")
  if (!cfg.titlePatterns.some((re) => re.test(titleHead))) {
    const other = Object.entries(cfg.otherTitles).find(([, re]) => re.test(titleHead))
    if (other) {
      const label: Record<string, string> = {
        design: "tài liệu thiết kế (Software Design Document)",
        project_plan: "kế hoạch quản lý dự án",
        test_doc: "tài liệu kiểm thử",
        user_guide: "hướng dẫn sử dụng / cài đặt",
        project_intro: "tài liệu giới thiệu dự án"
      }
      return {
        kind: "not_srs",
        confidence: 0.9,
        signals: [`title:${other[0]}`],
        reasons: [`Tiêu đề cho thấy đây là ${label[other[0]] ?? other[0]}, không phải tài liệu đặc tả yêu cầu (SRS) hay mẫu SRS.`]
      }
    }
  }

  // 2. Heading khớp danh mục FPT / IEEE (đếm section khác nhau, trần 6)
  const matched = new Set<string>()
  for (const h of headings) {
    const id = matchHeading(h.text)
    if (id) matched.add(id)
  }
  const headingScore = Math.min(6, matched.size)
  score += headingScore
  for (const id of matched) signals.push(`heading:${id}`)

  // 3. Từ khoá (trần 4)
  const keywordHits = Object.entries(cfg.keywords).filter(([, re]) => re.test(allText)).map(([k]) => k)
  score += Math.min(4, keywordHits.length)
  for (const k of keywordHits) signals.push(`keyword:${k}`)

  // 4. Mã yêu cầu khác nhau (≥ 3 mã ⇒ +2, ≥ 1 ⇒ +1)
  const ids = new Set<string>()
  for (const m of allText.matchAll(cfg.idPattern)) ids.add(m[0].toUpperCase().replace(/[-_ ]/, "-"))
  if (ids.size >= 3) score += 2
  else if (ids.size >= 1) score += 1
  if (ids.size) signals.push(`id:${[...ids].slice(0, 3).join(",")}`)

  // 5. Bảng kiểu SRS (trần 2)
  let srsTables = 0
  for (const b of blocks) {
    if (b.kind !== "table" || !b.rows?.length) continue
    const header = b.rows[0]
    const hits = header.filter((cell) => cfg.tableHeaderWords.test(cell)).length
    if (hits >= 2 && header.length >= 2) srsTables += 1
  }
  score += Math.min(2, srsTables)
  if (srsTables) signals.push(`table:${srsTables}`)

  // 6. Tín hiệu loại tài liệu khác
  const againstKinds: string[] = []
  for (const [kind, re] of Object.entries(cfg.against)) {
    const hits = allText.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))?.length ?? 0
    if (hits >= cfg.againstMinHits) {
      againstKinds.push(kind)
      signals.push(`against:${kind}`)
    }
  }
  const againstPenalty = againstKinds.length * 2
  const net = score - againstPenalty

  // Quyết định
  const srsEvidence = matched.size >= 3 || signals.includes("title:srs")
  if (net >= cfg.srsScore || (srsEvidence && net >= cfg.unknownScore)) {
    // Mẫu trống / điền dở: dưới heading hầu như chỉ còn chữ hướng dẫn `[...]`, `<<...>>`, "Mục này mô tả…"
    const instructionLike = bodyParagraphs.filter((b) => cfg.instructionPatterns.some((re) => re.test(b.text.trim()))).length
    const isTemplate = headings.length >= 3 && (bodyParagraphs.length === 0 || instructionLike / bodyParagraphs.length >= cfg.templateInstructionRatio)
    return {
      kind: isTemplate ? "srs_template" : "srs",
      confidence: round(Math.min(1, 0.5 + net / 12)),
      signals,
      reasons: isTemplate ? ["Tài liệu chủ yếu là đầu mục — coi là mẫu SRS (trống hoặc điền dở)"] : []
    }
  }

  const missing = "không có mục Use Case, Requirements, Actor hay mã yêu cầu (UC-01, FR-01)"
  if (againstKinds.length > 0 && net < cfg.unknownScore) {
    const label: Record<string, string> = { cv: "hồ sơ / CV", invoice: "hoá đơn / bảng giá", test_plan: "kế hoạch / kịch bản kiểm thử", meeting: "biên bản họp", contract: "hợp đồng" }
    reasons.push(`Không thấy dấu hiệu tài liệu yêu cầu: ${missing}; nội dung giống ${againstKinds.map((k) => label[k] ?? k).join(", ")}.`)
    return { kind: "not_srs", confidence: round(Math.min(1, 0.6 + againstKinds.length * 0.15)), signals, reasons }
  }

  const words = allText.split(/\s+/).filter(Boolean).length
  if (net < cfg.unknownScore && textBlocks.length >= cfg.proseMinBlocks && words >= cfg.proseMinWords && headings.length === 0 && srsTables === 0 && keywordHits.length === 0 && ids.size === 0) {
    // Văn xuôi dài không có cấu trúc, không một từ khoá SRS nào — gần như chắc không phải SRS. Tài liệu ngắn thì để `unknown`
    // (cho qua, cảnh báo) — chặn nhầm đắt hơn một lượt đọc file nhỏ.
    reasons.push(`Không thấy dấu hiệu tài liệu yêu cầu: ${missing}, cũng không có đầu mục nào.`)
    return { kind: "not_srs", confidence: 0.6, signals, reasons }
  }

  reasons.push(`Chưa chắc đây là SRS: ${missing} đủ rõ — hãy xem lại kết quả đọc file trước khi đi tiếp.`)
  return { kind: "unknown", confidence: round(Math.max(0, Math.min(0.49, 0.2 + net / 10))), signals, reasons }
}
