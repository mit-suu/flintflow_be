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
}

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
