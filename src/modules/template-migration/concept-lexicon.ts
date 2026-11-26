/**
 * Từ điển khái niệm để chấm "mục cũ nên đặt vào mục nào của mẫu mới" theo nghĩa (đổi mẫu) — thuần, không AI.
 *
 * Mỗi khái niệm là một nhóm từ khoá vi / en đã gập dấu (`foldText`). Một chữ khớp khi từ khoá đứng đầu một từ của chữ đó (cho phép
 * đuôi: "interface" khớp "interfaces"). Mục cũ và mục mẫu được quy về vector khái niệm rồi so với nhau (`place-score.ts`).
 */
import { foldText } from "../import/text-similarity.js"

export type Concept =
  | "sw_interface"
  | "hw_interface"
  | "ui"
  | "functions"
  | "security"
  | "availability"
  | "reliability"
  | "performance"
  | "usability"
  | "quality"
  | "observability"
  | "constraints"
  | "goals_scope"
  | "vision"
  | "context"
  | "assumption_risk"
  | "compliance"
  | "appendix_data"
  | "diagram"
  | "glossary"
  | "actors"
  | "overview"

export const CONCEPT_LEXICON: Readonly<Record<Concept, readonly string[]>> = {
  sw_interface: ["api", "tich hop", "cong thanh toan", "https", "json", "he thong ben ngoai", "he thong ngoai", "dich vu ngoai", "dich vu ben ngoai", "giao dien phan mem", "giao tiep he thong", "software interface", "integration", "external system", "external service", "webhook", "giao thuc", "thong diep trao doi"],
  hw_interface: ["thiet bi", "phan cung", "may in", "cam bien", "hardware", "device"],
  ui: ["man hinh", "luong man", "giao dien nguoi dung", "user interface", "screen", "bo cuc", "mockup"],
  functions: ["chuc nang", "use case", "tinh nang", "hanh vi", "function", "feature", "behavior", "behaviour", "ca su dung", "quy tac nghiep vu", "business rule"],
  security: ["phan quyen", "xac thuc", "vai tro", "ma hoa", "bao mat", "security", "authoriz", "authent", "permission", "role"],
  availability: ["uptime", "san sang", "availability", "gian doan", "sla", "khoi phuc", "bao tri dinh ky"],
  reliability: ["mtbf", "phuc hoi", "sao luu", "tin cay", "reliab", "du phong", "failover", "backup"],
  performance: ["hieu nang", "hieu suat", "thoi gian phan hoi", "thong luong", "performance", "latency", "do tre", "response time"],
  usability: ["kha dung", "de dung", "de su dung", "usability", "kha nang tiep can", "accessib", "ease of use"],
  quality: ["chat luong", "quality", "thuoc tinh chat luong"],
  observability: ["telemetry", "quan sat", "giam sat", "observab", "metric", "trace"],
  constraints: ["rang buoc", "constraint", "cong nghe", "dac thu"],
  goals_scope: ["muc tieu", "pham vi", "kinh doanh", "nang luc", "goal", "objective", "scope", "muc dich chinh"],
  vision: ["tam nhin", "vision"],
  context: ["so do ngu canh", "he sinh thai", "boi canh", "context", "thuong nguon", "ha nguon", "goc nhin"],
  assumption_risk: ["gia dinh", "phu thuoc", "rui ro", "cau hoi mo", "cau hoi con mo", "risk", "assumption", "dependenc", "tbd", "open question"],
  compliance: ["luat", "nghi dinh", "tieu chuan", "hop dong", "tuan thu", "quy dinh", "compliance", "regulat", "legal"],
  appendix_data: ["phu luc", "tu dien du lieu", "thuc the", "thong bao", "appendix", "data dictionary", "message", "erd", "entity"],
  diagram: ["so do", "diagram", "bieu do", "mo hinh"],
  glossary: ["thuat ngu", "dinh nghia", "viet tat", "glossary", "acronym"],
  actors: ["nguoi dung", "tac nhan", "persona", "actor", "user class"],
  overview: ["tong quan", "tom tat", "overview", "summary", "muc cao"]
}

const CONCEPTS = Object.keys(CONCEPT_LEXICON) as Concept[]

/** Khái niệm có trong chữ (mỗi khái niệm tính một lần). */
export const conceptsOf = (text: string): Set<Concept> => {
  const padded = ` ${foldText(text)}`
  const out = new Set<Concept>()
  if (padded.trim() === "") return out
  for (const c of CONCEPTS) if (CONCEPT_LEXICON[c].some((kw) => padded.includes(` ${kw}`))) out.add(c)
  return out
}

/**
 * Loại dữ liệu của một mục theo `section_id` ⇒ khái niệm của dữ liệu đó. Dùng cho cả mục cũ (dữ liệu nó mang) và mục mẫu (dữ liệu
 * nó nhận). Mục không có trong bảng (mục riêng, heading nhóm lạ) ⇒ không có loại dữ liệu.
 */
export const DATA_CONCEPTS: Readonly<Record<string, readonly Concept[]>> = {
  "fixed:I": [],
  "fixed:1": ["context", "goals_scope"],
  "fixed:2.1": ["actors"],
  "group:2.2": ["functions"],
  "fixed:2.2.1": ["diagram"],
  "fixed:2.2.2": ["functions"],
  "group:3": ["functions"],
  "group:3.1": ["functions"],
  "fixed:3.1.1": ["ui"],
  "fixed:3.1.2": ["ui"],
  "fixed:3.1.3": ["security"],
  "fixed:3.1.4": ["functions"],
  "fixed:3.1.5": ["appendix_data", "diagram"],
  "group:4": ["quality"],
  "fixed:4.1": ["sw_interface"],
  "group:4.2": ["quality"],
  "fixed:4.2.1": ["usability", "quality"],
  "fixed:4.2.2": ["reliability", "availability"],
  "fixed:4.2.3": ["performance"],
  "fixed:4.2.4": ["constraints", "observability"],
  "group:5": ["appendix_data"],
  "fixed:5.1": ["functions"],
  "fixed:5.2": ["security"],
  "fixed:5.3": ["appendix_data"],
  "fixed:5.4": ["assumption_risk"],
  "fixed:5.5": ["glossary"],
  "slot:vision": ["vision"],
  "slot:goals": ["goals_scope"],
  "slot:scope": ["goals_scope"],
  "slot:high_rules": ["functions"],
  "slot:business_rules": ["functions"],
  "slot:messages": ["appendix_data"],
  "slot:context": ["sw_interface", "context"],
  "slot:features": ["functions"],
  "slot:functional_requirements": ["functions"],
  "slot:assumptions": ["assumption_risk"],
  "slot:risks": ["assumption_risk"],
  "slot:open_questions": ["assumption_risk"],
  "slot:security": ["security"],
  "slot:analysis_models": ["diagram"]
}

export const dataConceptsOf = (sectionId: string): readonly Concept[] => DATA_CONCEPTS[sectionId] ?? []
