import { describe, expect, it } from "vitest"
import { FUNCTION_LABELS, USE_CASE_LABELS, flowSteps, functionSpecValue, readSpecLines, sentences, useCaseSpecValue, type SpecSource } from "./spec-fields.js"

const para = (block_id: string, text: string, kind = "list_item"): SpecSource => ({ block_id, kind, text })

/** Mục chức năng của SRS thật (Report3 — "3.2.1 Register account (UC-01)"), rút gọn. */
const REGISTER: SpecSource[] = [
  para("B0975", "Function trigger:", "paragraph"),
  para("B0976", 'Navigation path: Landing page -> "Sign up" -> Sign-up screen'),
  para("B0977", "Timing Frequency: User-initiated only."),
  para("B0978", "Function description:", "paragraph"),
  para("B0979", "Actors / Roles: Guest; Email Service"),
  para("B0980", "Purpose: Allow a Guest to create an account."),
  para("B0981", "Interface: Sign-up screen:"),
  para("B0982", '"Email": Input - field for entering the email address.'),
  para("B0994", "Function details:", "paragraph"),
  para("B0995", "Data: Full name (optional), Email, Password"),
  para("B0996", "Validation: Email is required and must be a valid address. Password is required, 8–72 characters."),
  para("B0997", "Business rules: The email is unique across all accounts. BR-11: an email account must verify its email. See BR12."),
  para("B0998", 'Normal case: The Guest enters email and password -> the system creates the account -> the Verify-email screen opens.'),
  para("B0999", 'Abnormal case: The email is already registered -> "This email is already registered."; no account is created. The password is too weak (e.g. "abc") -> the rule text is shown.')
]

describe("readSpecLines + functionSpecValue (FLF-252)", () => {
  it("đặc tả chức năng mẫu FPT ⇒ field của chức năng; nhãn lạ (Actors / Roles, Data, phần tử giao diện) để AI đọc", () => {
    const spec = readSpecLines(REGISTER, FUNCTION_LABELS)
    expect([...spec.consumed].sort()).toEqual(["B0975", "B0976", "B0977", "B0978", "B0980", "B0981", "B0994", "B0996", "B0997", "B0998", "B0999"])
    expect(functionSpecValue(spec.values)).toEqual({
      trigger: 'Landing page -> "Sign up" -> Sign-up screen; User-initiated only.',
      description: "Allow a Guest to create an account.",
      screen_id: "Sign-up screen",
      normal: ["The Guest enters email and password", "the system creates the account", "the Verify-email screen opens."],
      // "; no account is created" là hệ quả của cùng trường hợp (chữ thường sau dấu chấm phẩy) ⇒ không tách
      abnormal: ['The email is already registered -> "This email is already registered."; no account is created', 'The password is too weak (e.g. "abc") -> the rule text is shown'],
      business_rule_ids: ["BR-11", "BR-12"],
      validations: [
        { kind: "format", statement: "Email is required and must be a valid address" },
        { kind: "format", statement: "Password is required, 8–72 characters" },
        { kind: "business", statement: "The email is unique across all accounts" },
        { kind: "business", statement: "See BR12" }
      ]
    })
  })

  it("nhãn rỗng mở nhóm: các gạch đầu dòng không nhãn ngay sau thuộc field đó; nhãn lạ đóng nhóm", () => {
    const spec = readSpecLines(
      [para("B1", "Normal case:", "paragraph"), para("B2", "1. User opens the form"), para("B3", "2. User submits"), para("B4", "Notes: none"), para("B5", "free text")],
      FUNCTION_LABELS
    )
    expect(spec.values.get("normal")).toEqual(["1. User opens the form", "2. User submits"])
    expect(flowSteps(spec.values.get("normal")!)).toEqual(["User opens the form", "User submits"])
    expect(spec.consumed.has("B5")).toBe(false)
  })

  it("không có nhãn quen ⇒ không có gì", () => {
    expect(functionSpecValue(readSpecLines([para("B1", "The learner signs in with email.", "paragraph")], FUNCTION_LABELS).values)).toEqual({})
  })
})

describe("sentences", () => {
  it("tách cả câu kết thúc bằng ngoặc kép, không tách sau viết tắt", () => {
    expect(sentences(['Wrong code -> "Invalid code." The code expired -> "Code expired." Use e.g. a new code.'])).toEqual([
      'Wrong code -> "Invalid code."',
      'The code expired -> "Code expired."',
      "Use e.g. a new code"
    ])
  })
})

describe("useCaseSpecValue — bảng dọc đặc tả use case", () => {
  it("bảng 2 cột nhãn | giá trị ⇒ use case có mã, tên, tác nhân chính + phụ, mô tả, include", () => {
    const rows = [
      ["Use Case ID", "UC-07"],
      ["Use Case Name", "Create organization"],
      ["Primary Actor", "SRS Author"],
      ["Secondary Actors", "Email Service, Payment Gateway"],
      ["Description", "The author creates a new organization."],
      ["Preconditions", "The author is signed in."],
      ["Includes", "UC-03"]
    ]
    expect(useCaseSpecValue(readSpecLines([{ block_id: "B0100", kind: "table", text: "", rows }], USE_CASE_LABELS).values)).toEqual({
      key: "UC-07",
      value: { name: "Create organization", actor_ids: ["SRS Author", "Email Service", "Payment Gateway"], description: "The author creates a new organization.", includes: ["UC-03"] }
    })
  })

  it("bảng 4 cột mẫu FPT (\"UC ID and Name:\") ⇒ tách mã và tên; bảng không phải đặc tả ⇒ null", () => {
    const fpt = [
      ["UC ID and Name:", "UC-02 Verify email address", "", ""],
      ["Created By:", "QuynhTTN", "Date Created:", "29/07/2026"],
      ["Primary Actor:", "Guest", "Secondary Actors:", "Email Service"]
    ]
    expect(useCaseSpecValue(readSpecLines([{ block_id: "B0200", kind: "table", text: "", rows: fpt }], USE_CASE_LABELS).values)).toEqual({
      key: "UC-02",
      value: { name: "Verify email address", actor_ids: ["Guest", "Email Service"] }
    })
    const list = [["ID", "Use Case", "Actors"], ["UC-01", "Register", "Guest"]]
    expect(useCaseSpecValue(readSpecLines([{ block_id: "B0300", kind: "table", text: "", rows: list }], USE_CASE_LABELS).values)).toBeNull()
  })
})
