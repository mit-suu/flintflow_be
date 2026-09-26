import { describe, it, expect } from "vitest"
import { wireframeWidgets } from "./interface-description.js"

const salt = (...body: string[]) => ["@startsalt", "{", "  {+", ...body.map((l) => `    ${l}`), "  }", "}", "@endsalt", ""].join("\n")

describe("wireframeWidgets (FLF-214)", () => {
  it("đọc widget theo thứ tự: ô nhập lấy nhãn dòng trên, mật khẩu, checkbox, link, nút, dòng chữ", () => {
    const puml = salt(
      "{",
      "  <b>FLINTFLOW",
      "  Login",
      "}",
      "..",
      "<b>Log in to your account",
      "Email",
      '"john@example.com       "',
      "Password",
      '"........               "',
      "{ [ ] Remember me | <u>Forgot password?</u> }",
      "[        Log in        ]",
      "{ Don't have an account? | <u>Sign up</u> }"
    )
    expect(wireframeWidgets(puml, "Login")).toEqual([
      '"Log in to your account" text',
      "Email input",
      "Password input (masked)",
      "Remember me checkbox",
      "Forgot password? link",
      "Log in button",
      "\"Don't have an account?\" text",
      "Sign up link"
    ])
  })

  it("dropdown có nhãn, khoảng giá trị, radio, tab, bảng, vùng giữ chỗ và ô nhiều dòng", () => {
    const puml = salt(
      "{/ <b>Chat | Document }",
      '{ Price | "100      " | to | "900      " }',
      "Location",
      "^All districts      ^",
      "{ (X) Fast | ( ) Coaching }",
      "{# <b>Title | <b>Price",
      "  Villa | 1,000",
      "}",
      "{+",
      "  Map area",
      "}",
      "Message",
      "{+",
      "  Type here",
      "  .",
      "}"
    )
    expect(wireframeWidgets(puml, "Search")).toEqual([
      "tabs (Chat, Document)",
      "Price input (range)",
      "Location dropdown",
      "Fast option",
      "Coaching option",
      "table (Title, Price)",
      "Map area",
      "Message text area"
    ])
  })

  it("không phải wireframe (bảng function của Spine cũ, hình PlantUML khác) ⇒ null", () => {
    expect(wireframeWidgets("@startsalt\n{+\n  <b>Login\n  {#\n    <b>Function | <b>Description\n  }\n}\n@endsalt\n", "Login")).toBeNull()
    expect(wireframeWidgets("@startuml\nA -> B\n@enduml\n", "Login")).toBeNull()
  })
})
