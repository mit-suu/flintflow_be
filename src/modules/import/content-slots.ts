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
  { id: "slot:context", label_en: "System context and external systems", label_vi: "Bối cảnh hệ thống và hệ thống ngoài", parents: ["fixed:1"], targets: ["actors"] },
  { id: "slot:features", label_en: "Product functions overview", label_vi: "Tổng quan chức năng sản phẩm", parents: [], targets: ["functions"] },
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
  }
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
    case "slot:context":
      return spine.actors.some((a) => a.kind !== "human")
    case "slot:features":
      return spine.features.length > 0
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

/** Độ tin của gợi ý từ khoá — dưới ngưỡng 0.8 của mapping review ⇒ BA luôn xác nhận. */
export const SLOT_SUGGESTION_CONFIDENCE = 0.7
