import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { getSkill } from "../../shared/ai/prompt-registry.service.js"
import { SCREEN_LAYOUT_SKILL, extractSalt, layoutContext, layoutPrompt } from "./screen-layout.ai.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

describe("screen-layout.ai (FLF-214)", () => {
  it("layoutContext: chỉ màn cần vẽ — function theo order kèm trigger + validation, màn đích theo tên", () => {
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

  it("layoutPrompt: thân skill + JSON màn; skill là prompt thật trả renderFix", () => {
    const skill = getSkill(SCREEN_LAYOUT_SKILL)
    const prompt = layoutPrompt(skill.template, layoutContext(FIXTURE, "S01")!)
    expect(prompt.startsWith(skill.template)).toBe(true)
    expect(prompt).toContain('"name": "Submit Credentials"')
    expect(skill.template).toContain("@startsalt")
  })

  it("extractSalt: nhận đúng một khối salt, bỏ khối sai hình / có dấu tiếng Việt", () => {
    expect(extractSalt("@startsalt\r\n{\r\n  [ OK ]\r\n}\r\n@endsalt\r\n")).toBe("@startsalt\n{\n  [ OK ]\n}\n@endsalt\n")
    expect(extractSalt("@startuml\nA -> B\n@enduml")).toBeNull()
    expect(extractSalt("@startsalt\n{\n  [ Đăng nhập ]\n}\n@endsalt")).toBeNull()
    expect(extractSalt("@startsalt\n{ }\n@endsalt\n@startsalt\n{ }\n@endsalt")).toBeNull()
    expect(extractSalt("```\n@startsalt\n{ }\n@endsalt\n```")).toBeNull()
  })
})
