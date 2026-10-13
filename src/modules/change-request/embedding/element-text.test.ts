import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../../spine/spine.repository.js"
import type { Spine } from "../../spine/spine.types.js"
import { listElements } from "../spine-location.js"
import { crQueryText, elementDocs, ELEMENT_TEXT_MAX_CHARS, planSync, renderElementText, textHash } from "./element-text.js"

const spine = (): Spine => {
  const s = createEmptySpine({ name: "Lumen" })
  s.project.vision = "Online learning for small training centers."
  s.use_cases.push({ id: "UC-01", name: "Register account", actor_ids: ["A01"], function_ids: [], description: "Create an account with email.", includes: [], extends: [] } as never)
  s.functions.push({
    id: "FR-01",
    screen_id: null,
    feature_id: "F-01",
    order: 1,
    name: "Log in",
    trigger: "User clicks Log in",
    description: "Authenticate the user.",
    normal: ["Enter email", "Enter password"],
    abnormal: ["Wrong password"],
    validations: [{ id: "V1", kind: "format", statement: "Email must be valid." }],
    business_rule_ids: [],
    priority: null
  } as never)
  s.other_requirements.push({ id: "OR-01", kind: "legal", statement: "Comply with GDPR.", statement_vi: "Tuân thủ GDPR." } as never)
  s.custom_sections.push({ id: "CS01", heading: "Meeting notes", level: 1, source: "import", blocks: [{ kind: "paragraph", text: "Session timeout was discussed.", rows: null, image_ref: null }] })
  return s
}

describe("renderElementText", () => {
  it("nhãn + mã + tên ở dòng đầu, rồi field có nghĩa; bỏ field kỹ thuật và bản _vi", () => {
    const s = spine()
    expect(renderElementText("use_cases[id=UC-01]", s.use_cases[0])).toBe("Use case UC-01: Register account\ndescription: Create an account with email.")
    const fn = renderElementText("functions[id=FR-01]", s.functions[0])
    expect(fn.split("\n")[0]).toBe("Function FR-01: Log in")
    expect(fn).toContain("normal: Enter email; Enter password")
    expect(fn).toContain("validations: Email must be valid.")
    expect(fn).not.toContain("order")
    expect(fn).not.toContain("F-01")
    expect(renderElementText("other_requirements[id=OR-01]", s.other_requirements[0])).not.toContain("Tuân thủ")
    expect(renderElementText("custom_sections[id=CS01]", s.custom_sections[0])).toBe("Section CS01: Meeting notes\nblocks: Session timeout was discussed.")
    expect(renderElementText("project", s.project)).toBe("Project: Lumen\nvision: Online learning for small training centers.")
  })

  it("cắt ở ELEMENT_TEXT_MAX_CHARS", () => {
    expect(renderElementText("glossary[id=G1]", { id: "G1", term: "X", definition: "y".repeat(10_000) })).toHaveLength(ELEMENT_TEXT_MAX_CHARS)
  })
})

describe("elementDocs + planSync", () => {
  it("mỗi phần tử làm được vị trí một dòng; hash đổi theo chữ và theo model", () => {
    const s = spine()
    const docs = elementDocs(s, "m1")
    expect(docs.map((d) => d.ref)).toEqual(listElements(s).map((e) => e.path))
    expect(docs.find((d) => d.ref === "use_cases[id=UC-01]")).toMatchObject({ entity: "use_cases", section_id: "fixed:2.2.2" })
    expect(textHash("m1", "a")).not.toBe(textHash("m2", "a"))
    expect(textHash("m1", "a")).toBe(textHash("m1", "a"))
  })

  it("chỉ embed phần tử mới / đổi chữ; xoá dòng của phần tử đã xoá; còn lại giữ", () => {
    const s = spine()
    const indexed = elementDocs(s, "m1").map((d) => ({ ref: d.ref, text_hash: d.text_hash }))
    s.use_cases[0]!.description = "Create an account with phone number."
    s.custom_sections = []
    s.glossary.push({ id: "G1", term: "Learner", definition: "A person who studies." } as never)
    const plan = planSync(elementDocs(s, "m1"), indexed)
    expect(plan.embed.map((d) => d.ref)).toEqual(["use_cases[id=UC-01]", "glossary[id=G1]"])
    expect(plan.remove).toEqual(["custom_sections[id=CS01]"])
    expect(plan.keep).toEqual(["project", "functions[id=FR-01]", "other_requirements[id=OR-01]"])
    // đổi model ⇒ embed lại tất cả
    expect(planSync(elementDocs(s, "m2"), indexed).embed).toHaveLength(elementDocs(s, "m2").length)
  })
})

describe("crQueryText", () => {
  it("tiêu đề + mô tả + lệnh gộp + hỏi/đáp đã trả lời + từ khoá C-2", () => {
    const q = crQueryText({
      title: "Tự đăng xuất",
      description: "Đăng xuất khi không thao tác.",
      amendments: [{ text: "Áp dụng cả admin", at: new Date(), after_round: 1 }],
      clarifications: [{ round: 1, questions: ["Bao lâu?", "Ai?"], answers: ["15 phút", ""] }],
      targets: { entity_paths: [], keywords: ["session", "timeout"] }
    })
    expect(q).toBe("Tự đăng xuất\nĐăng xuất khi không thao tác.\nÁp dụng cả admin\nBao lâu? 15 phút\nKeywords: session, timeout")
  })
})
