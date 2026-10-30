/**
 * Dữ liệu sinh cho bộ đo khớp mẫu I-3 (FLF-343, `match-harness.ts`): dàn mục SRS theo mẫu FPT có đáp án, các biến thể dương
 * (heading theo style, in đậm, numPr, đổi tên, style riêng, mục lục Word / gõ tay) và âm (thứ không phải heading). Chỉ dùng
 * cho test và script đo.
 */

import { makeDocx, p, table } from "../../docx-ooxml/testing/make-docx.js"

/** Mục đúng: id section, hoặc `feature` / `function` (id tạm theo block nên chỉ so loại). */
export type ExpectedSection = string

export interface OutlineEntry {
  level: number
  number: string
  title: string
  /** Tiêu đề ở biến thể "đổi tên". */
  renamed: string
  expected: ExpectedSection
}

/** Dàn mục SRS theo mẫu FPT, đánh số liên tục (đánh số tự động của Word không nhảy số). */
export const HARNESS_OUTLINE: readonly OutlineEntry[] = [
  { level: 1, number: "1", title: "Product Overview", renamed: "Introduction", expected: "fixed:1" },
  { level: 1, number: "2", title: "User Requirements", renamed: "User Requirement Specification", expected: "group:2" },
  { level: 2, number: "2.1", title: "Actors", renamed: "System Actors", expected: "fixed:2.1" },
  { level: 2, number: "2.2", title: "Use Cases", renamed: "Use Case Model", expected: "group:2.2" },
  { level: 3, number: "2.2.1", title: "Use Case Diagram", renamed: "Use Case Diagrams", expected: "fixed:2.2.1" },
  { level: 3, number: "2.2.2", title: "Use Case Descriptions", renamed: "Use Case Specifications", expected: "fixed:2.2.2" },
  { level: 1, number: "3", title: "Functional Requirements", renamed: "System Functional Requirements", expected: "group:3" },
  { level: 2, number: "3.1", title: "System Functional Overview", renamed: "Functional Overview", expected: "group:3.1" },
  { level: 3, number: "3.1.1", title: "Screens Flow", renamed: "Screen Navigation Flow", expected: "fixed:3.1.1" },
  { level: 3, number: "3.1.2", title: "Screen Descriptions", renamed: "Screen List", expected: "fixed:3.1.2" },
  { level: 2, number: "3.2", title: "Authentication", renamed: "Account Access", expected: "feature" },
  { level: 3, number: "3.2.1", title: "Register account", renamed: "Sign up", expected: "function" },
  { level: 3, number: "3.2.2", title: "Log in to system", renamed: "Sign in", expected: "function" },
  { level: 2, number: "3.3", title: "Course Management", renamed: "Courses", expected: "feature" },
  { level: 3, number: "3.3.1", title: "Create course", renamed: "Add a course", expected: "function" },
  { level: 1, number: "4", title: "Non-Functional Requirements", renamed: "Non-functional Requirement", expected: "group:4" },
  { level: 2, number: "4.1", title: "External Interfaces", renamed: "External Interface Requirements", expected: "fixed:4.1" },
  { level: 2, number: "4.2", title: "Quality Attributes", renamed: "Quality Requirements", expected: "group:4.2" },
  { level: 3, number: "4.2.1", title: "Usability", renamed: "Ease of Use", expected: "fixed:4.2.1" },
  { level: 3, number: "4.2.2", title: "Reliability", renamed: "Availability", expected: "fixed:4.2.2" },
  { level: 3, number: "4.2.3", title: "Performance", renamed: "Performance Requirements", expected: "fixed:4.2.3" },
  { level: 1, number: "5", title: "Requirement Appendix", renamed: "Appendix", expected: "group:5" },
  { level: 2, number: "5.1", title: "Business Rules", renamed: "Business Rule List", expected: "fixed:5.1" }
]

export const HARNESS_VARIANTS = ["style", "bold", "numpr", "renamed", "custom_style", "toc_word", "toc_hand"] as const
export type HarnessVariant = (typeof HARNESS_VARIANTS)[number]

const STYLES =
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  [1, 2, 3].map((n) => `<w:style w:type="paragraph" w:styleId="H${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/></w:style>`).join("") +
  [1, 2, 3].map((n) => `<w:style w:type="paragraph" w:styleId="TOC${n}"><w:name w:val="toc ${n}"/><w:basedOn w:val="Normal"/></w:style>`).join("") +
  // Style riêng của nhóm (không tên "heading", không outlineLvl): chỉ in đậm + cỡ chữ
  [32, 28, 24].map((sz, i) => `<w:style w:type="paragraph" w:styleId="Custom${i + 1}"><w:name w:val="Team Title ${i + 1}"/><w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`).join("") +
  `<w:style w:type="paragraph" w:styleId="ListPara"><w:name w:val="List Paragraph"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>`

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const run = (text: string, rPr = ""): string => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
const para = (runs: string, pPr = ""): string => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs}</w:p>`

/** Nội dung dưới mỗi heading — đủ dài để cỡ chữ thân bài là cỡ phổ biến nhất. */
const bodyOf = (e: OutlineEntry): string =>
  p(`This part of the document describes ${e.title.toLowerCase()} for the Lumen learning platform in enough detail for the team.`) +
  (e.expected === "fixed:2.1" ? table([["Actor", "Description"], ["Learner", "A person who enrolls in courses."]]) : "") +
  (e.expected === "function" ? para(run("Show an error when the input is invalid."), `<w:pStyle w:val="ListPara"/>`) : "")

const headingOf = (e: OutlineEntry, variant: HarnessVariant): string => {
  const numbered = `${e.number} ${variant === "renamed" ? e.renamed : e.title}`
  switch (variant) {
    case "style":
    case "renamed":
    case "toc_word":
      return para(run(numbered), `<w:pStyle w:val="H${e.level}"/>`)
    case "bold":
      return para(run(numbered, "<w:b/>"))
    case "numpr":
      // Số do Word sinh (`numPr`), chữ không có số; in đậm, không style heading
      return para(run(e.title, "<w:b/>"), `<w:numPr><w:ilvl w:val="${e.level - 1}"/><w:numId w:val="7"/></w:numPr>`)
    case "custom_style":
      return para(run(e.title), `<w:pStyle w:val="Custom${e.level}"/>`)
    case "toc_hand":
      // Đoạn in đậm, không số, không style — mục lục gõ tay cho biết cấp + đây là heading
      return para(run(e.title, "<w:b/>"))
  }
}

const wordToc = (outline: readonly OutlineEntry[]): string =>
  `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr><w:sdtContent>` +
  para(run("Table of Contents")) +
  outline.map((e, i) => para(`${run(`${e.number}`)}<w:r><w:tab/></w:r>${run(e.title)}<w:r><w:tab/></w:r>${run(String(i + 3))}`, `<w:pStyle w:val="TOC${e.level}"/>`)).join("") +
  `</w:sdtContent></w:sdt>`

const handToc = (outline: readonly OutlineEntry[]): string =>
  para(run("Table of Contents")) + outline.map((e, i) => para(run(`${e.number} ${e.title} ${".".repeat(20)} ${i + 3}`))).join("")

/** `numbering.xml`: numId 7 = dàn mục `%1.` / `%1.%2.` / `%1.%2.%3.`, numId 8 = gạch đầu dòng. */
const NUMBERING =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:abstractNum w:abstractNumId="1">${["%1.", "%1.%2.", "%1.%2.%3."].map((t, i) => `<w:lvl w:ilvl="${i}"><w:numFmt w:val="decimal"/><w:lvlText w:val="${t}"/></w:lvl>`).join("")}</w:abstractNum>` +
  `<w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>` +
  `<w:num w:numId="7"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="8"><w:abstractNumId w:val="2"/></w:num>` +
  `</w:numbering>`

const docOf = (body: string): Promise<Buffer> => makeDocx({ styles: STYLES, body, extraParts: { "word/numbering.xml": NUMBERING } })

/** Sinh một biến thể .docx của dàn mục. */
export const buildVariant = (variant: HarnessVariant, outline: readonly OutlineEntry[] = HARNESS_OUTLINE): Promise<Buffer> =>
  docOf(
    [
      para(run("Software Requirement Specification — Lumen")),
      variant === "toc_word" ? wordToc(outline) : variant === "toc_hand" ? handToc(outline) : "",
      ...outline.map((e) => headingOf(e, variant) + bodyOf(e))
    ].join("")
  )

/**
 * Biến thể âm tính (FLF-343): thêm thứ **không phải** heading vào bản style — gạch đầu dòng in đậm, danh sách khoá<tab>giá trị,
 * tiêu đề bìa cỡ 36pt, câu thân bài trùng tiêu đề mục lục. Không được thêm heading nào, không được mất đoạn nào.
 */
export const NEGATIVE_VARIANTS = ["bold_bullets", "tab_list", "cover_title", "toc_title_body"] as const
export type NegativeVariant = (typeof NEGATIVE_VARIANTS)[number]

export interface NegativeCase {
  buffer: Buffer
  /** Heading đúng — đúng bằng tiêu đề dàn mục (có số). */
  headings: string[]
  /** Đoạn nhiễu phải còn là block nội dung. */
  keep: string[]
}

export const buildNegative = async (variant: NegativeVariant, outline: readonly OutlineEntry[] = HARNESS_OUTLINE): Promise<NegativeCase> => {
  const bullet = (text: string) => para(run(text, "<w:b/>"), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="8"/></w:numPr>`)
  const tabbed = (key: string, value: string) => para(`${run(key)}<w:r><w:tab/></w:r>${run(value)}`)
  const noise: Record<NegativeVariant, { before: string; after: string; keep: string[] }> = {
    bold_bullets: { before: "", after: bullet("Fast checkout") + bullet("Secure payment") + bullet("Course catalogue"), keep: ["Fast checkout", "Secure payment", "Course catalogue"] },
    tab_list: { before: "", after: tabbed("Port", "8080") + tabbed("Timeout", "30") + tabbed("Retries", "3"), keep: ["Port\t8080", "Timeout\t30", "Retries\t3"] },
    cover_title: { before: para(run("Lumen Learning Platform", `<w:sz w:val="72"/>`)), after: "", keep: ["Lumen Learning Platform"] },
    toc_title_body: { before: wordToc(outline), after: p("Actors"), keep: ["Actors"] }
  }
  const n = noise[variant]
  const body = [n.before, ...outline.map((e, i) => headingOf(e, "style") + bodyOf(e) + (i === 2 ? n.after : ""))].join("")
  return { buffer: await docOf(body), headings: outline.map((e) => `${e.number} ${e.title}`), keep: n.keep }
}
