import { describe, it, expect } from "vitest"
import type { Spine } from "../spine/spine.types.js"
import { describeInterface, wireframeWidgets } from "./interface-description.js"

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

  it("bỏ qua hàng đệm quanh khung ngoài (padFrame) — cùng danh sách widget như bản không đệm", () => {
    const body = ["{", "  <b>FLINTFLOW", "  Login", "}", "..", "Email", '"john@example.com       "', "[        Log in        ]"]
    const padded = salt(".", "{ . | . | {", ...body.map((l) => `  ${l}`), "} | . | . }", ".")
    expect(wireframeWidgets(padded, "Login")).toEqual(["Email input", "Log in button"])
    expect(wireframeWidgets(padded, "Login")).toEqual(wireframeWidgets(salt(...body), "Login"))
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

  it("FLF-265: tiếng Việt — tên loại widget đứng trước, chữ trên widget giữ nguyên từ puml", () => {
    const puml = salt(
      "<b>Log in to your account",
      "Email",
      '"john@example.com       "',
      "Password",
      '"........               "',
      "{ [ ] Remember me | <u>Forgot password?</u> }",
      "{/ <b>Chat | Document }",
      '{ Price | "100      " | to | "900      " }',
      "Location",
      "^All districts      ^",
      "^Any^",
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
      "}",
      '"Search..."',
      "[        Log in        ]"
    )
    expect(wireframeWidgets(puml, "Login", "vi")).toEqual([
      'chữ "Log in to your account"',
      "ô nhập Email",
      "ô nhập Password (ẩn)",
      "ô chọn Remember me",
      "liên kết Forgot password?",
      "các tab (Chat, Document)",
      "ô nhập Price (khoảng)",
      "danh sách chọn Location",
      "danh sách chọn Any",
      "lựa chọn Fast",
      "lựa chọn Coaching",
      "bảng (Title, Price)",
      "vùng Map",
      "ô nhập nhiều dòng Message",
      'ô nhập "Search..."',
      "nút Log in"
    ])
    // Cùng wireframe, không truyền ngôn ngữ ⇒ đúng chuỗi tiếng Anh như trước
    expect(wireframeWidgets(puml, "Login")).toEqual([
      '"Log in to your account" text',
      "Email input",
      "Password input (masked)",
      "Remember me checkbox",
      "Forgot password? link",
      "tabs (Chat, Document)",
      "Price input (range)",
      "Location dropdown",
      "Any dropdown",
      "Fast option",
      "Coaching option",
      "table (Title, Price)",
      "Map area",
      "Message text area",
      'input "Search..."',
      "Log in button"
    ])
  })

  it("FLF-265: describeInterface — 'Màn hình X: …' / 'Pop-up X: …', mô tả màn giữ nguyên; mặc định tiếng Anh", () => {
    const screen = { id: "S1", feature_id: "F1", name: "Login", description: "Entry screen.", flow_to: [], is_popup: false, tabs: [], primary_function_id: null, queue_order: 1, detail_status: "signed_off" as const }
    const layout = { id: "D1", kind: "screen_layout" as const, section: "function:FN1", owner_kind: "screen", owner_id: "S1", render_status: "ok" as const, source_hash: "h", rendered_at: "2026-09-01T00:00:00.000Z" }
    const withLayout = { diagrams: [{ ...layout, puml: salt("Email", '"a@b.c   "', "[ Log in ]") }] } as unknown as Spine
    expect(describeInterface(withLayout, screen, "vi")).toBe("Màn hình Login: ô nhập Email, nút Log in.")
    expect(describeInterface(withLayout, screen)).toBe("Login screen: Email input, Log in button.")
    const noLayout = { diagrams: [] } as unknown as Spine
    expect(describeInterface(noLayout, { ...screen, is_popup: true }, "vi")).toBe("Pop-up Login: Entry screen.")
    expect(describeInterface(noLayout, { ...screen, is_popup: true })).toBe("Login pop-up: Entry screen.")
  })

  it("không phải wireframe (bảng function của Spine cũ, hình PlantUML khác) ⇒ null", () => {
    expect(wireframeWidgets("@startsalt\n{+\n  <b>Login\n  {#\n    <b>Function | <b>Description\n  }\n}\n@endsalt\n", "Login")).toBeNull()
    expect(wireframeWidgets("@startuml\nA -> B\n@enduml\n", "Login")).toBeNull()
  })
})
