/**
 * SRS lệch format cho test I-4 (FLF-444): mỗi biến thể là một dòng của bảng *File lệch format* (business-flow §3.1).
 * Phần chung (Product Overview, bảng tác nhân / use case / business rule) giữ file đủ dấu hiệu SRS để qua preflight.
 */

import { makeDocx, p, styled, table } from "../../docx-ooxml/testing/make-docx.js"
import { SRS_FIXTURE_TEXT } from "./srs-fixture.js"

export const OFF_FORMAT_VARIANTS = ["renamed", "mismatch", "mixed", "prose", "bold", "twice"] as const
export type OffFormatVariant = (typeof OFF_FORMAT_VARIANTS)[number]

const STYLES =
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  [1, 2, 3].map((n) => `<w:style w:type="paragraph" w:styleId="u${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/></w:style>`).join("")

/** Câu của từng biến thể (fake AI trong test tìm block theo câu). */
export const OFF_FORMAT_TEXT = {
  /** Tên khác chuẩn: heading tự đặt. */
  reportRequirement: "The system shall export a monthly progress report as a PDF file.",
  enrollRequirement: "Learners can enroll in a course and track their progress.",
  /** Tên đúng, nội dung sai: mục "Use Case Descriptions" chứa test case. */
  testCases: ["TC-01 Log in with a wrong password: the system shows an error message.", "TC-02 Register with an existing email: the system rejects the request."],
  /** Một section nhiều loại nội dung: chức năng nền lẫn NFR. */
  reminderFunction: "The system sends a reminder email to learners every night.",
  reminderNfr: "Reminder emails shall be delivered within 5 minutes of the scheduled time.",
  /** FLF-453: NFR trong mục riêng (heading tự đặt) khi file còn mục 4.2.3 FlintFlow. */
  customNfr: "Course search results shall load within 2 seconds for 500 concurrent learners.",
  /** Văn xuôi thay cho bảng, không có ID. */
  proseActors: ["A learner enrolls in courses and takes quizzes.", "An administrator manages courses and user accounts."]
}

/** Đoạn in đậm (không style heading) - tiêu đề chỉ in đậm, có số mục. */
const bold = (text: string): string => `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

export const makeOffFormatSrsDocx = async (variant: OffFormatVariant): Promise<Buffer> => {
  const T = SRS_FIXTURE_TEXT
  const O = OFF_FORMAT_TEXT
  const h = (level: number, text: string): string => (variant === "bold" ? bold(text) : styled(`u${level}`, text))
  const actors = variant === "prose" ? O.proseActors.map((s) => p(s)) : [table([["Actor", "Description"], T.actorRow, ["Admin", "Manages courses and users."]])]
  const useCases =
    variant === "mismatch"
      ? [h(3, "2.2.2 Use Case Descriptions"), ...O.testCases.map((s) => p(s))]
      : [h(3, "2.2.2 Use Case Descriptions"), table([["Use Case ID", "Use Case Name", "Actor"], T.ucRow, ["UC-02", "Log in", "Learner"]])]
  const body = [
    h(1, "1 Product Overview"),
    p(T.purpose),
    h(1, "2 User Requirements"),
    h(2, "2.1 Actors"),
    ...actors,
    h(2, "2.2 Use Cases"),
    ...useCases,
    ...(variant === "renamed" ? [h(1, "Phần mở rộng"), p(O.reportRequirement), h(2, "Những gì hệ thống làm được"), p(O.enrollRequirement)] : []),
    ...(variant === "mixed" ? [h(1, "3 Functional Requirements"), h(2, "3.1 System Functional Overview"), h(3, "3.1.4 Non-Screen Functions"), p(O.reminderFunction), p(O.reminderNfr)] : []),
    ...(variant === "twice" ? [h(1, "Những gì hệ thống làm được"), p(O.customNfr), h(1, "4 Non-Functional Requirements"), h(2, "4.2 Quality Attributes"), h(3, "4.2.3 Performance"), p(T.perf)] : []),
    ...(variant === "bold" ? [h(1, "4 Non-Functional Requirements"), h(2, "4.2 Quality Attributes"), h(3, "4.2.3 Performance"), p(T.perf)] : []),
    h(1, "5 Requirement Appendix"),
    h(2, "5.1 Business Rules"),
    table([["BR ID", "Business Rule"], T.rule])
  ].join("")
  return makeDocx({ body, styles: STYLES })
}
