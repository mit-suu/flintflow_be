/**
 * SRS mẫu dạng .docx cho test mode 1 (FLF-171): cấu trúc giống template FPT, heading dùng styleId bản địa hoá
 * (`u1`, `u2`…) như Word tiếng Việt. Tuỳ chọn `numberedOnly` sinh heading không style (như SRS thật của nhóm, P0 §4.2).
 */

import { imageRel, makeDocx, p, picture, styled, table } from "../../docx-ooxml/testing/make-docx.js"

const STYLES =
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  [1, 2, 3].map((n) => `<w:style w:type="paragraph" w:styleId="u${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/></w:style>`).join("") +
  `<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Dsach"><w:name w:val="List Paragraph"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>`

export interface SrsFixtureOptions {
  /** Heading là đoạn thường `2.1 Actors` (không style). */
  numberedOnly?: boolean
  /** Chèn thêm XML vào cuối body. */
  extraBody?: string
  /** Mode 1 v3 phase 5 (T3): ảnh nhúng dưới 2.2.1 (`word/media/<name>`) — PNG / JPEG / EMF tuỳ bytes truyền vào. */
  images?: { name: string; data: Buffer; caption?: string }[]
  /**
   * FLF-251: bảng Record of Changes dưới heading "I. Record of Changes" ở đầu tài liệu. `\n` trong ô ⇒ nhiều đoạn trong
   * cùng ô (như ô tiêu đề "A*⏎M, D" của SRS thật).
   */
  recordOfChanges?: string[][]
}

/** Bảng mà ô có `\n` thành nhiều đoạn trong ô (helper `table` chỉ dựng một đoạn mỗi ô). */
const multilineTable = (rows: string[][]): string =>
  `<w:tbl><w:tblPr/><w:tblGrid/>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${c.split("\n").map((line) => p(line)).join("")}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`

export const SRS_FIXTURE_TEXT = {
  purpose: "Lumen is an online learning platform for small training centers.",
  actorRow: ["Learner", "A person who enrolls in courses."],
  ucRow: ["UC-01", "Register account", "Learner"],
  loginNormal: "The learner enters email and password, then the system shows the dashboard.",
  perf: "The system shall respond within 2 seconds for 95% of requests.",
  rule: ["BR-01", "Passwords must have at least 8 characters."]
}

export const makeSrsDocx = async (opts: SrsFixtureOptions = {}): Promise<Buffer> => {
  const h = (level: number, number: string, title: string): string =>
    opts.numberedOnly ? p(`${number} ${title}`) : styled(`u${level}`, `${number} ${title}`)
  const T = SRS_FIXTURE_TEXT
  const body = [
    ...(opts.recordOfChanges ? [h(1, "I.", "Record of Changes"), multilineTable(opts.recordOfChanges)] : []),
    h(1, "1", "Product Overview"),
    p(T.purpose),
    h(1, "2", "User Requirements"),
    h(2, "2.1", "Actors"),
    table([["Actor", "Description"], T.actorRow, ["Admin", "Manages courses and users."]]),
    h(2, "2.2", "Use Cases"),
    h(3, "2.2.1", "Use Case Diagram"),
    p("The diagram shows UC-01 and UC-02."),
    ...(opts.images ?? []).map((img, i) => picture(`rIdImg${i + 1}`) + (img.caption ? styled("Caption", img.caption) : "")),
    h(3, "2.2.2", "Use Case Descriptions"),
    table([["Use Case ID", "Use Case Name", "Actor"], T.ucRow, ["UC-02", "Log in", "Learner"]]),
    h(1, "3", "Functional Requirements"),
    h(2, "3.1", "System Functional Overview"),
    h(3, "3.1.2", "Screen Descriptions"),
    p("SCR-01 Login screen lets the learner sign in."),
    h(2, "3.2", "Authentication"),
    h(3, "3.2.1", "Register account"),
    p("Learner creates an account with email (UC-01)."),
    h(3, "3.2.2", "Log in to system"),
    p(T.loginNormal),
    styled("Dsach", "Show an error when the password is wrong."),
    h(1, "4", "Non-Functional Requirements"),
    h(2, "4.2", "Quality Attributes"),
    h(3, "4.2.3", "Performance"),
    p(T.perf),
    h(1, "5", "Requirement Appendix"),
    h(2, "5.1", "Business Rules"),
    table([["BR ID", "Business Rule"], T.rule]),
    h(2, "5.9", "Team Notes"),
    p("Internal notes that do not belong to the template."),
    opts.extraBody ?? ""
  ].join("")
  const images = opts.images ?? []
  return makeDocx({
    body,
    styles: STYLES,
    extraDocRels: images.map((img, i) => imageRel(`rIdImg${i + 1}`, img.name)).join(""),
    extraParts: Object.fromEntries(images.map((img) => [`word/media/${img.name}`, img.data])),
    extraContentTypes: images.length
      ? `<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="emf" ContentType="image/x-emf"/>`
      : ""
  })
}

/**
 * SRS mẫu IEEE 830 (FLF-252): Revision History, chương 1–3 rút gọn; yêu cầu chức năng là bảng "ID | Requirement | Priority"
 * ngay dưới 3.2; Reliability + Availability cùng trích vào một section FPT.
 */
export const makeIeeeSrsDocx = async (): Promise<Buffer> =>
  makeDocx({
    styles: STYLES,
    body: [
      styled("u1", "Revision History"),
      table([["Version", "Date", "Author", "Description"], ["0.1", "01/09/2026", "Lan", "Initial draft"]]),
      styled("u1", "1. Introduction"),
      styled("u2", "1.1 Purpose"),
      p(SRS_FIXTURE_TEXT.purpose),
      styled("u2", "1.4 References"),
      p("IEEE Std 830-1998."),
      styled("u1", "2. Overall Description"),
      styled("u2", "2.3 User Characteristics"),
      table([["Actor", "Description"], SRS_FIXTURE_TEXT.actorRow, ["Admin", "Manages courses and users."]]),
      styled("u1", "3. Specific Requirements"),
      styled("u2", "3.2 Functional Requirements"),
      table([
        ["ID", "Requirement", "Priority"],
        ["FR-001", "The system shall let a learner register with an email address.", "Must"],
        ["FR-002", "The system shall let an admin lock a learner account.", "Should"]
      ]),
      styled("u2", "3.3 Performance Requirements"),
      p(SRS_FIXTURE_TEXT.perf),
      styled("u2", "3.5 Software System Attributes"),
      styled("u3", "3.5.1 Reliability"),
      p("The platform shall have a monthly uptime of at least 99.5%."),
      styled("u3", "3.5.2 Availability"),
      p("The platform shall be available 24 hours a day, 7 days a week.")
    ].join("")
  })
