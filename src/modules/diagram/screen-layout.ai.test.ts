import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { getSkill } from "../../shared/ai/prompt-registry.service.js"
import { LAYOUT_REFERENCES, SCREEN_LAYOUT_SKILL, extractSalt, layoutContext, layoutPrompt, layoutReferences, padFrame } from "./screen-layout.ai.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

describe("screen-layout.ai (FLF-214)", () => {
  it("layoutContext: chỉ màn cần vẽ - function theo order kèm trigger + validation, màn đích theo tên", () => {
    const context = layoutContext(FIXTURE, "S01")!
    expect(context.system_name).toBe("FlintFlow")
    expect(context.screen).toEqual({ name: "Login", description: expect.any(String), is_popup: false, tabs: [] })
    const functions = context.functions as { name: string; trigger: string; validations: string[] }[]
    expect(functions.map((f) => f.name)).toEqual(["Submit Credentials", "Log In with Google", "Toggle Password Visibility", "Navigate to Register", "Open Forgot Password"])
    expect(functions[0]).toMatchObject({ trigger: "User clicks the Log in button.", validations: ["Email must be a syntactically valid address.", "Password must not be empty."] })
    expect(context.navigates_to).toEqual(expect.arrayContaining(["Register", "Forgot Password"]))
    expect(JSON.stringify(context)).not.toMatch(/FN0|"S0/)
    expect(layoutContext(FIXTURE, "S99")).toBeNull()
  })

  it("layoutContext (FLF-410): phạm vi nền tảng + form_factor; ảnh gốc chỉ khi có, không gửi dữ liệu ảnh vào chữ", () => {
    const context = layoutContext(FIXTURE, "S01", ["web", "mobile"])!
    expect(context.allowed_platforms).toEqual(["web", "mobile"])
    expect(context.form_factor).toEqual(FIXTURE.project.form_factor)
    expect(context).not.toHaveProperty("original_images")
    const withOriginal = layoutContext(FIXTURE, "S01", ["web"], {
      mode: "original",
      images: [{ index: 0, caption: "Figure 3: Login screen", context: "The login layout", image: { mime: "image/png", data: "AAAA" } }]
    })!
    expect(withOriginal.mode).toBe("original")
    expect(withOriginal.original_images).toEqual([{ index: 0, caption: "Figure 3: Login screen", context: "The login layout" }])
    expect(JSON.stringify(withOriginal)).not.toContain("AAAA")
  })

  it("layoutPrompt: thân skill + reference bảng block + JSON màn; skill trả spec JSON qua renderFix", () => {
    const skill = getSkill(SCREEN_LAYOUT_SKILL, { references: [...LAYOUT_REFERENCES] })
    const prompt = layoutPrompt(skill.template, layoutContext(FIXTURE, "S01")!, LAYOUT_REFERENCES.map((r) => skill.references[r]))
    expect(prompt.startsWith(skill.template)).toBe(true)
    expect(prompt).toContain("# ScreenSpec blocks")
    expect(prompt.indexOf("# ScreenSpec blocks")).toBeLessThan(prompt.indexOf("## Screen to draw"))
    expect(prompt).toContain('"name": "Submit Credentials"')
    expect(skill.template).toContain("ScreenSpec")
    expect(skill.template).not.toContain("@startsalt")
    expect(`${skill.template}${prompt}`).not.toContain("—")
  })

  it("layoutReferences: luật ảnh gốc chỉ nối khi màn có ảnh gốc; thân skill không còn luật đó", () => {
    expect(layoutReferences()).toEqual(["blocks"])
    expect(layoutReferences({ mode: "system", images: [] })).toEqual(["blocks"])
    const original = { mode: "original" as const, images: [{ index: 0, caption: "Figure 3: Login screen", context: "" }] }
    expect(layoutReferences(original)).toEqual(["blocks", "originals"])

    const skill = getSkill(SCREEN_LAYOUT_SKILL, { references: layoutReferences(original) })
    expect(skill.template).not.toContain("## Which pictures are screens")
    expect(skill.template).not.toContain("## Mode `original`")
    const plain = layoutPrompt(skill.template, layoutContext(FIXTURE, "S01")!, ["blocks"].map((r) => skill.references[r]))
    expect(plain).not.toContain("screen_images`: the `index`")
    const withOriginal = layoutPrompt(skill.template, layoutContext(FIXTURE, "S01", ["web"], original)!, layoutReferences(original).map((r) => skill.references[r]))
    expect(withOriginal).toContain("## Which pictures are screens")
    expect(withOriginal).toContain("## Mode `original` (picture attached)")
    expect(withOriginal.indexOf("# Screens imported with an original picture")).toBeLessThan(withOriginal.indexOf("## Screen to draw"))
    expect(withOriginal).not.toContain("—")
  })

  it("extractSalt: nhận đúng một khối salt, bỏ khối sai hình / có dấu tiếng Việt", () => {
    expect(extractSalt("@startsalt\r\n{\r\n  [ OK ]\r\n}\r\n@endsalt\r\n")).toBe("@startsalt\n{\n  [ OK ]\n}\n@endsalt\n")
    expect(extractSalt("@startuml\nA -> B\n@enduml")).toBeNull()
    expect(extractSalt("@startsalt\n{\n  [ Đăng nhập ]\n}\n@endsalt")).toBeNull()
    expect(extractSalt("@startsalt\n{ }\n@endsalt\n@startsalt\n{ }\n@endsalt")).toBeNull()
    expect(extractSalt("```\n@startsalt\n{ }\n@endsalt\n```")).toBeNull()
  })

  it("padFrame: bọc nội dung khung ngoài bằng hàng/cột đệm, giữ nguyên phần ngoài khung, gọi lại không đệm thêm", () => {
    const salt = [
      "@startsalt",
      "{",
      "  {+",
      "    {",
      "      <b>NHATOT",
      "      Login",
      "    }",
      '    "a { b }        "',
      "    { [ ] Remember me | <u>Forgot password?</u> }",
      "    [ Log in ]",
      "  }",
      "}",
      "@endsalt",
      ""
    ].join("\n")
    const padded = padFrame(salt)
    expect(padded).toBe(
      [
        "@startsalt",
        "{",
        "  {+",
        "    .",
        "    { . | . | {",
        "      {",
        "        <b>NHATOT",
        "        Login",
        "      }",
        '      "a { b }        "',
        "      { [ ] Remember me | <u>Forgot password?</u> }",
        "      [ Log in ]",
        "    } | . | . }",
        "    .",
        "  }",
        "}",
        "@endsalt",
        ""
      ].join("\n")
    )
    expect(padFrame(padded)).toBe(padded)
  })

  it("padFrame: pop-up `{^\"Tên\"` cũng được đệm; không có khung ngoài ⇒ trả nguyên", () => {
    const popup = '@startsalt\n{\n  {^"Forgot Password"\n    [ Send ]\n  }\n}\n@endsalt\n'
    expect(padFrame(popup)).toBe('@startsalt\n{\n  {^"Forgot Password"\n    .\n    { . | . | {\n      [ Send ]\n    } | . | . }\n    .\n  }\n}\n@endsalt\n')
    const titleBelow = '@startsalt\n{\n  {^\n"Contact Support"\n    Name\n    "Nguyen Van A   "\n  }\n}\n@endsalt\n'
    expect(padFrame(titleBelow)).toBe(
      '@startsalt\n{\n  {^"Contact Support"\n    .\n    { . | . | {\n      Name\n      "Nguyen Van A   "\n    } | . | . }\n    .\n  }\n}\n@endsalt\n'
    )
    const bare = "@startsalt\n{\n  [ OK ]\n}\n@endsalt\n"
    expect(padFrame(bare)).toBe(bare)
  })
})
