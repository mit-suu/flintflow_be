import { describe, expect, it } from "vitest"
import { isWireframeSalt, localizeSalt, wireframeLabels } from "./salt-text.js"
import { padFrame } from "./screen-layout.ai.js"
import { DIAGRAM_LABELS } from "./renderers/labels.js"

/** Wireframe thật của model (dự án FAP, đã qua `padFrame`). */
const ACCOUNTS = padFrame(`@startsalt
{
  {+
    {
      <b>FAP
      User Account Management
    }
    ..
    <b>Accounts
    {#
      <b>Full name | <b>User code | <b>Role | <b>Email | <b>Status
      Nguyen Van An | GC000123 | Student | an.nguyen@example.com | Active
    }
    ..
    Full name
    "Nguyen Van An                   "
    { User code | Role }
    { "GC000123              " | ^Student          ^ }
    Password
    "........                        "
    { [ ] Remember me | <u>Forgot password?</u> }
    { (X) Fast | ( ) Coaching }
    { [        Create account        ] | [ Update ] }
  }
}
@endsalt
`)

const RESERVED = ["User Account Management", "FAP"]

describe("isWireframeSalt", () => {
  it("salt model vẽ / salt trong @startuml ⇒ có; bảng Function | Description (mọi ngôn ngữ), sơ đồ khác ⇒ không", () => {
    expect(isWireframeSalt(ACCOUNTS)).toBe(true)
    expect(isWireframeSalt("@startuml\nsalt\n{+\n  [ OK ]\n}\n@enduml\n")).toBe(true)
    for (const l of Object.values(DIAGRAM_LABELS)) {
      expect(isWireframeSalt(`@startsalt\n{+\n  <b>Login\n  {#\n    <b>${l.functionColumn} | <b>${l.descriptionColumn}\n  }\n}\n@endsalt\n`)).toBe(false)
    }
    expect(isWireframeSalt("@startuml\nactor A\n@enduml\n")).toBe(false)
  })
})

describe("wireframeLabels", () => {
  it("chữ hiển thị khác nhau theo thứ tự; bỏ tên màn / tên hệ thống, mã, e-mail, ô mật khẩu, ký hiệu checkbox / radio", () => {
    expect(wireframeLabels(ACCOUNTS, RESERVED)).toEqual([
      "Accounts",
      "Full name",
      "User code",
      "Role",
      "Email",
      "Status",
      "Nguyen Van An",
      "Student",
      "Active",
      "Password",
      "Remember me",
      "Forgot password?",
      "Fast",
      "Coaching",
      "Create account",
      "Update"
    ])
  })

  it("tên giữ chỗ so không phân biệt hoa thường / khoảng trắng; không phải wireframe ⇒ rỗng", () => {
    expect(wireframeLabels(ACCOUNTS, ["user  account management", "fap"])).not.toContain("User Account Management")
    expect(wireframeLabels(ACCOUNTS)).toEqual(expect.arrayContaining(["User Account Management", "FAP"]))
    expect(wireframeLabels("@startuml\nactor A\n@enduml\n")).toEqual([])
  })

  it("menu, tab, thanh cuộn, khung có chữ, sprite (fixture cũ dạng @startuml salt)", () => {
    const legacy = [
      "@startuml",
      "salt",
      "{+",
      "  {* FlintFlow | Project: FlintFlow | <&person> }",
      "  {/ <b>Chat | Document | History }",
      "  {SI",
      '    "AI: Which external systems?"',
      "  }",
      "  {+ Gate: S-2.3 External Systems | [ Accept ] | [ Regenerate ] }",
      "  {T",
      "    + Root",
      "    ++ Child item",
      "  }",
      "  {Total | 3 }",
      "}",
      "@enduml"
    ].join("\n")
    expect(wireframeLabels(legacy, ["FlintFlow"])).toEqual([
      "Project: FlintFlow",
      "Chat",
      "Document",
      "History",
      "AI: Which external systems?",
      "Gate: S-2.3 External Systems",
      "Accept",
      "Regenerate",
      "Root",
      "Child item",
      "Total"
    ])
  })
})

describe("localizeSalt", () => {
  const VI: Record<string, string> = {
    "User Account Management": "Quản lý tài khoản",
    Accounts: "Tài khoản",
    "Full name": "Họ và tên",
    Status: "Trạng thái",
    Student: "Sinh viên",
    "Remember me": "Ghi nhớ đăng nhập",
    "Forgot password?": "Quên mật khẩu?",
    Fast: "Nhanh",
    "Create account": "Tạo tài khoản",
    Update: "Cập nhật"
  }

  it("thay đúng chữ, giữ cú pháp + khoảng đệm; chữ không có bản dịch giữ nguyên", () => {
    const out = localizeSalt(ACCOUNTS, (text) => VI[text])
    expect(out).toContain("<b>FAP")
    expect(out).toContain("Quản lý tài khoản")
    expect(out).toContain("<b>Tài khoản")
    expect(out).toContain("<b>Họ và tên | <b>User code | <b>Role | <b>Email | <b>Trạng thái")
    expect(out).toContain("Nguyen Van An | GC000123 | Sinh viên | an.nguyen@example.com | Active")
    expect(out).toContain('"Nguyen Van An                   "')
    expect(out).toContain('{ "GC000123              " | ^Sinh viên          ^ }')
    expect(out).toContain('"........                        "')
    expect(out).toContain("{ [ ] Ghi nhớ đăng nhập | <u>Quên mật khẩu?</u> }")
    expect(out).toContain("{ (X) Nhanh | ( ) Coaching }")
    expect(out).toContain("{ [        Tạo tài khoản        ] | [ Cập nhật ] }")
    // Khung đệm của padFrame, dòng kẻ, số dòng không đổi
    expect(out.split("\n").length).toBe(ACCOUNTS.split("\n").length)
    expect(out).toContain("{ . | . | {")
    expect(localizeSalt(ACCOUNTS, () => undefined)).toBe(ACCOUNTS)
  })

  it("ký tự cú pháp trong chữ dịch bị lọc theo vị trí — không mở / đóng widget", () => {
    const salt = '@startsalt\n{+\n  Name\n  "Your name   "\n  [ Save ]\n  ^All^\n}\n@endsalt\n'
    const out = localizeSalt(salt, (text) => ({ Name: "Tên | {x}", "Your name": 'Tên "bạn"', Save: "Lưu [nháp]", All: "Tất cả ^" })[text])
    expect(out).toBe(`@startsalt\n{+\n  Tên x\n  "Tên 'bạn'   "\n  [ Lưu nháp ]\n  ^Tất cả^\n}\n@endsalt\n`)
    // Chữ dịch rỗng sau khi lọc ⇒ giữ chữ gốc
    expect(localizeSalt(salt, (text) => (text === "Save" ? "[]" : undefined))).toBe(salt)
  })

  it("không phải wireframe ⇒ trả nguyên", () => {
    const table = `@startsalt\n{+\n  <b>Login\n  {#\n    <b>Function | <b>Description\n    Log In | Signs in\n  }\n}\n@endsalt\n`
    expect(localizeSalt(table, () => "X")).toBe(table)
  })
})
