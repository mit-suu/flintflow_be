/**
 * Phần nhỏ (`slot:*`) cho heading của mẫu khách — FLF-278 trên FLF-335/336, business-flow 1.5 / 2.10.
 *
 * Mẫu IEEE / mẫu công ty chia nhỏ hơn khung FPT: `fixed:1` Product Overview gộp vision + goals + scope + quy tắc cấp cao +
 * hệ thống ngoài, còn mẫu tách thành 1.1 Purpose, 1.4 Product Scope… Heading map vào một **phần** dữ liệu Spine đã có:
 * - I-4 trích chữ dưới heading vào đúng collection của phần đó (`SLOT_TARGETS`);
 * - bản in chỉ in phần đó dưới heading (`section-renderer#renderContentSlot`);
 * - kế hoạch step / so cấu trúc đích tính theo mục FPT cha (`slotParents`).
 * Không thêm field Spine, không đổi section registry. Một phần dữ liệu chỉ in một lần: slot và mục FPT cha không cùng có
 * heading (`slotOverlaps`).
 */

import type { Spine } from "../spine/spine.types.js"

export interface ContentSlotDef {
  id: `slot:${string}`
  label_en: string
  label_vi: string
  /** Mục FPT gộp phần dữ liệu này (chồng lấn: không cùng có heading trong một mẫu). */
  parents: readonly string[]
  /** Collection Spine I-4 trích chữ dưới heading (như `SECTION_TARGETS`). */
  targets: readonly string[]
}

export const CONTENT_SLOTS: readonly ContentSlotDef[] = Object.freeze([
  { id: "slot:vision", label_en: "Purpose and vision", label_vi: "Mục đích và tầm nhìn", parents: ["fixed:1"], targets: ["project"] },
  { id: "slot:goals", label_en: "Product goals", label_vi: "Mục tiêu sản phẩm", parents: ["fixed:1"], targets: ["project"] },
  { id: "slot:scope", label_en: "Release scope (in / out)", label_vi: "Phạm vi phát hành (trong / ngoài)", parents: ["fixed:1"], targets: ["project"] },
  { id: "slot:high_rules", label_en: "High-level business rules", label_vi: "Quy tắc nghiệp vụ cấp cao", parents: ["fixed:1"], targets: ["business_rules"] },
  { id: "slot:business_rules", label_en: "Business rules", label_vi: "Quy tắc nghiệp vụ", parents: ["fixed:5.1"], targets: ["business_rules"] },
  { id: "slot:messages", label_en: "Messages", label_vi: "Thông báo", parents: ["fixed:5.3"], targets: ["messages"] },
  { id: "slot:context", label_en: "System context and external systems", label_vi: "Bối cảnh hệ thống và hệ thống ngoài", parents: ["fixed:1"], targets: ["actors"] },
  { id: "slot:features", label_en: "Product functions overview", label_vi: "Tổng quan chức năng sản phẩm", parents: [], targets: ["functions"] },
  { id: "slot:functional_requirements", label_en: "Functional requirements", label_vi: "Yêu cầu chức năng", parents: [], targets: ["functions"] },
  { id: "slot:platforms", label_en: "Platforms and operating environment", label_vi: "Nền tảng và môi trường hoạt động", parents: [], targets: ["project"] },
  { id: "slot:assumptions", label_en: "Assumptions", label_vi: "Giả định", parents: ["fixed:5.4"], targets: ["other_requirements"] },
  { id: "slot:risks", label_en: "Risks", label_vi: "Rủi ro", parents: ["fixed:5.4"], targets: ["other_requirements"] },
  { id: "slot:open_questions", label_en: "Open questions (TBD)", label_vi: "Câu hỏi còn mở (TBD)", parents: ["fixed:5.4"], targets: ["other_requirements"] },
  { id: "slot:security", label_en: "Common security requirements", label_vi: "Yêu cầu bảo mật chung", parents: ["fixed:5.2"], targets: ["common_requirements"] },
  { id: "slot:localization", label_en: "Localization requirements", label_vi: "Yêu cầu bản địa hoá", parents: ["fixed:5.2"], targets: ["common_requirements"] },
  {
    id: "slot:analysis_models",
    label_en: "Analysis models (use case, screen flow, ERD diagrams)",
    label_vi: "Sơ đồ phân tích (use case, luồng màn hình, ERD)",
    parents: ["fixed:2.2.1", "fixed:3.1.1", "fixed:3.1.5"],
    targets: []
  },
  // FLF-365: mục chỉ có ở mẫu IEEE 29148 — Spine có chỗ riêng (`references[]`, `release` của yêu cầu, `verifications[]`)
  { id: "slot:references", label_en: "References", label_vi: "Tài liệu tham khảo", parents: [], targets: ["references"] },
  // Bảng phân bổ trong file là yêu cầu đã có ở chương chức năng ⇒ không trích lại (sẽ nhân đôi); skill điền `release`
  { id: "slot:apportioning", label_en: "Apportioning of requirements", label_vi: "Phân bổ yêu cầu", parents: [], targets: [] },
  { id: "slot:verification", label_en: "Verification", label_vi: "Kiểm chứng", parents: [], targets: ["verifications"] },
  // FLF-390: mục "Phân tán" của "Thiết kế và triển khai" (mẫu IEEE / jam01 3.5) — chỗ in sơ đồ triển khai. Dữ liệu chỉ từ
  // ảnh sơ đồ (đọc ảnh) hoặc người dùng yêu cầu, không trích từ chữ
  { id: "slot:distribution", label_en: "Distribution", label_vi: "Phân tán", parents: [], targets: [] }
])

const SLOT_BY_ID = new Map<string, ContentSlotDef>(CONTENT_SLOTS.map((s) => [s.id, s]))
export const isContentSlot = (id: string | null | undefined): boolean => !!id && SLOT_BY_ID.has(id)
export const contentSlot = (id: string): ContentSlotDef | undefined => SLOT_BY_ID.get(id)
export const slotParents = (id: string): readonly string[] => SLOT_BY_ID.get(id)?.parents ?? []

/** Mục (FPT hoặc slot) dùng chung dữ liệu với `id` — đối xứng. */
export const overlapsOf = (id: string): string[] => {
  const slot = SLOT_BY_ID.get(id)
  if (slot) return [...slot.parents]
  return CONTENT_SLOTS.filter((s) => s.parents.includes(id)).map((s) => s.id)
}

/** Cặp (mục FPT, slot) cùng có heading trong mapping ⇒ nội dung in hai lần. */
export const slotOverlaps = (sectionIds: Iterable<string>): [string, string][] => {
  const used = new Set(sectionIds)
  return CONTENT_SLOTS.flatMap((s) => (used.has(s.id) ? s.parents.filter((p) => used.has(p)).map((p): [string, string] => [p, s.id]) : []))
}

/** Bộ mục của layout cộng mục FPT cha của các slot (cha "có mặt" qua các phần nhỏ của nó). */
export const withSlotParents = (ids: Iterable<string>): Set<string> => {
  const out = new Set(ids)
  for (const id of [...out]) for (const p of slotParents(id)) out.add(p)
  return out
}

/** Phần dữ liệu của slot đã có trong Spine chưa (so cấu trúc đích, kế hoạch step). */
export const slotHasData = (spine: Spine, slotId: string): boolean => {
  const { project } = spine
  switch (slotId) {
    case "slot:vision":
      return !!project.vision?.trim()
    case "slot:goals":
      return project.goals.length > 0
    case "slot:scope":
      return project.release_scope.in.length + project.release_scope.out.length > 0
    case "slot:high_rules":
      return spine.business_rules.some((r) => r.tier === "high")
    case "slot:business_rules":
      return spine.business_rules.length > 0
    case "slot:messages":
      return spine.messages.length > 0
    case "slot:context":
      return spine.actors.some((a) => a.kind !== "human")
    case "slot:features":
      return spine.features.length > 0
    case "slot:functional_requirements":
      return spine.functions.length > 0
    case "slot:platforms":
      return project.form_factor.length > 0
    case "slot:assumptions":
      return spine.assumptions.some((a) => a.status !== "rejected") || spine.other_requirements.some((o) => o.kind === "assumption")
    case "slot:risks":
      return spine.other_requirements.some((o) => o.kind === "risk" || o.kind === "technical_risk")
    case "slot:open_questions":
      return spine.other_requirements.some((o) => o.kind === "open_question")
    case "slot:security":
      return spine.common_requirements.some((c) => ["security", "session", "audit"].includes(c.category))
    case "slot:localization":
      return spine.common_requirements.some((c) => ["localization", "date_format"].includes(c.category))
    case "slot:analysis_models":
      return spine.diagrams.some((d) => d.kind === "usecase" || d.kind === "screen_flow" || d.kind === "erd")
    case "slot:references":
      return (spine.references ?? []).length > 0
    case "slot:apportioning":
      return [...spine.functions, ...spine.nfrs].some((r) => !!r.release)
    case "slot:verification":
      return (spine.verifications ?? []).length > 0
    case "slot:distribution":
      return (spine.deployment_nodes ?? []).length > 0
    default:
      return false
  }
}

// ─── gợi ý theo từ khoá (business-flow 1.5) ─────────────────────────

/**
 * Chỉ cho heading matcher import chưa khớp (`unmapped`). Luật cụ thể trước luật chung; luật `null` chặn các luật chung phía
 * sau (Safety, Hardware Interfaces… Spine không có dữ liệu). So trên tiêu đề đã bỏ số gõ tay, chữ thường.
 */
const SUGGESTION_RULES: readonly [RegExp, string | null][] = [
  [/\bsafety\b|maintainab|portab|supportab|\blegal\b|licens|document conventions?|\breferences?\b|data retention|archiv/, null],
  [/\bdistribution\b|phân tán|deployment (view|diagram|topology)|sơ đồ triển khai/, "slot:distribution"],
  [/\bpurpose\b|mục đích|\bvision\b|tầm nhìn/, "slot:vision"],
  [/\bgoals?\b|\bobjectives?\b|mục tiêu/, "slot:goals"],
  [/\bscope\b|phạm vi/, "slot:scope"],
  [/product perspective|system context|\bcontext\b|bối cảnh/, "slot:context"],
  [/product functions?|functional overview|features? (list|overview|summary)|tổng quan chức năng|danh sách chức năng/, "slot:features"],
  [/operating environment|\bplatforms?\b|môi trường (hoạt động|vận hành)|nền tảng/, "slot:platforms"],
  [/assumptions?|giả định/, "slot:assumptions"],
  [/\brisks?\b|rủi ro/, "slot:risks"],
  [/to be determined|\btbd\b|open (issues?|questions?)|câu hỏi (mở|còn mở)|vấn đề (mở|còn mở)/, "slot:open_questions"],
  [/hardware interfaces?|communications? interfaces?|giao tiếp phần cứng|giao tiếp truyền thông/, null],
  [/security|bảo mật|an toàn thông tin/, "slot:security"],
  [/locali[sz]ation|internationali[sz]ation|bản địa|đa ngôn ngữ/, "slot:localization"],
  // Chỉ tiêu đề nói rõ "analysis models" — "diagram" chung chung (Class diagram, Context diagram) để matcher import xử lý
  [/analysis models?|mô hình phân tích/, "slot:analysis_models"]
]

const normalizeTitle = (title: string): string =>
  title
    .normalize("NFC")
    .toLowerCase()
    .replace(/^\s*(?:\d+(?:\.\d+)*[.)]?|[ivxlc]+[.)]|[a-z][.)])\s+/u, "")
    .trim()

/** Gợi ý phần nhỏ cho heading chưa khớp; `null` = không gợi ý. */
export const suggestSlot = (title: string): string | null => {
  const text = normalizeTitle(title)
  return SUGGESTION_RULES.find(([re]) => re.test(text))?.[1] ?? null
}

/** Heading của một chức năng / tính năng (kể cả mã tạm `function:@B…`) — tên riêng, không phải tên mục của mẫu. */
const isEntityHeading = (id: string): boolean => id.startsWith("function:") || id.startsWith("feature:")

/**
 * Repair semantic bindings at fixed-template export without changing source headings or order.
 * - Gợi ý theo **từ khoá** (`suggestSlot`) chỉ cho heading chưa khớp / mục FPT: tên chức năng "Manage Security Questions",
 *   tính năng "Risk Assessment", nhóm "3 Functional Requirements" không thành phần nhỏ bảo mật / rủi ro.
 * - Tiêu đề **đúng tên** mục mẫu ("Business Rules", "Messages", "Functional Requirements") gán phần nhỏ, trừ heading con
 *   nằm trong một chức năng / tính năng (có `level`): "Business Rules" của từng chức năng thuộc chức năng đó.
 */
export const bindFixedTemplateSlots = <T extends { heading_text: string; section_id: string; level?: number | null }>(entries: readonly T[]): T[] => {
  let entityLevel: number | null = null
  return entries.map((entry) => {
    const level = entry.level ?? null
    if (entityLevel !== null && level !== null && level <= entityLevel) entityLevel = null
    const nested = entityLevel !== null && level !== null && level > entityLevel
    if (isEntityHeading(entry.section_id) && level !== null && !nested) entityLevel = level
    // Heading nhóm (`group:*`, vd "3 Functional Requirements" của cấu trúc FlintFlow) giữ nguyên: chỉ chứa mục con
    if (entry.section_id.startsWith("group:") || nested) return { ...entry }
    const title = normalizeTitle(entry.heading_text)
    const exact = /^(business rules|quy tắc nghiệp vụ)$/u.test(title)
      ? "slot:business_rules"
      : /^(messages|thông báo)$/u.test(title)
      ? "slot:messages"
      : /^(functional requirements|yêu cầu chức năng)$/u.test(title)
      ? "slot:functional_requirements"
      : null
    const keywordAllowed = !isEntityHeading(entry.section_id)
    const slot = exact ?? (keywordAllowed ? suggestSlot(entry.heading_text) : null)
    return slot ? { ...entry, section_id: slot } : { ...entry }
  })
}

/**
 * Mẫu bắt buộc: `bindFixedTemplateSlots` + quy tắc **cha và con cùng mục** — heading cha mà một heading con (sâu hơn, trước heading
 * cùng cấp kế tiếp) nhận cùng mục FPT, hoặc phần nhỏ của chính mục đó, ⇒ cha thành heading bao (`unmapped`, chỉ giữ tiêu đề), con
 * mang dữ liệu. Vd "3.1 External Interface Requirements" › "3.1.2 Software Interfaces" (cùng `fixed:4.1`); "1. Introduction" ›
 * "1.1 Purpose" (`slot:vision` của `fixed:1`). Không có ⇒ heading con bị gộp vào cha, mất khỏi bản in. `level` thiếu ⇒ chỉ gán
 * phần nhỏ. Dùng chung lúc tách file (`matchHeadings`) và lúc xuất (`project-docx-writer`, `layout-sections`).
 */
export const bindFixedTemplateHeadings = <T extends { heading_text: string; section_id: string; level?: number | null }>(entries: readonly T[]): T[] => {
  const bound = bindFixedTemplateSlots(entries)
  return bound.map((entry, i) => {
    const level = entry.level ?? null
    // "Functional Requirements" chứa heading của từng chức năng / tính năng ⇒ heading bao (không in thêm bảng tổng hợp,
    // mỗi chức năng đã in dưới heading riêng)
    if (level !== null && entry.section_id === "slot:functional_requirements") {
      for (let k = i + 1; k < bound.length; k++) {
        const child = bound[k]
        if (!child.heading_text.trim()) continue
        if (child.level === null || child.level === undefined || child.level <= level) break
        if (isEntityHeading(child.section_id)) return { ...entry, section_id: "unmapped" }
      }
      return entry
    }
    if (level === null || !entry.section_id.startsWith("fixed:") || !entry.heading_text.trim()) return entry
    for (let k = i + 1; k < bound.length; k++) {
      const child = bound[k]
      if (!child.heading_text.trim()) continue
      if (child.level === null || child.level === undefined || child.level <= level) break
      if (child.section_id === entry.section_id || slotParents(child.section_id).includes(entry.section_id)) return { ...entry, section_id: "unmapped" }
    }
    return entry
  })
}

/** Độ tin của gợi ý từ khoá — dưới ngưỡng 0.8 của mapping review ⇒ BA luôn xác nhận. */
export const SLOT_SUGGESTION_CONFIDENCE = 0.7
