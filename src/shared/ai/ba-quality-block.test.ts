import fs from "node:fs"
import path from "node:path"
import { describe, it, expect } from "vitest"
import { getPromptsDir } from "../../config/paths.js"
import { getSkillsDir } from "./prompt-assets.js"
import { getPromptTemplate } from "./prompt-registry.service.js"
import { ActionType } from "./ai-action.types.js"

/**
 * FLF-449 N2: luật chất lượng (a)–(d) của business flow (nguyên tắc 10) phải tới model ở MỌI prompt phân tích. Loader chỉ
 * nạp thân SKILL.md (+ `prompt_references` của chính skill) và prompt phẳng, không có file dùng chung giữa các skill ⇒ luật
 * là một block có mốc chép y hệt vào từng file, và test này chặn hai bản trôi lệch im lặng (như `skill-voice-block.test.ts`).
 * Sửa một bản mà quên bản khác ⇒ đỏ.
 */
const BA_QUALITY_START = "<!-- ba-quality:shared:start -->"
const BA_QUALITY_END = "<!-- ba-quality:shared:end -->"

const SKILLS = [
  "action/elicit-loop",
  "action/apply-change-op",
  "action/review-section",
  "action/extract-requirements",
  "action/import-semantic-check",
  "action/import-cross-check",
  "content/brief-analysis",
  "content/product-brief",
  "content/prioritization"
] as const

const FILES: readonly { name: string; file: string }[] = [
  ...SKILLS.map((skill) => ({ name: skill, file: path.join(getSkillsDir(), ...skill.split("/"), "SKILL.md") })),
  { name: "prompts/chat.md", file: path.join(getPromptsDir(), "chat.md") }
]

const read = (file: string): string => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")

const sharedBlockOf = (name: string, file: string): string => {
  const text = read(file)
  const start = text.indexOf(BA_QUALITY_START)
  const end = text.indexOf(BA_QUALITY_END)
  expect(start, `${name}: thiếu mốc ${BA_QUALITY_START}`).toBeGreaterThanOrEqual(0)
  expect(end, `${name}: thiếu mốc ${BA_QUALITY_END}`).toBeGreaterThan(start)
  expect(text.indexOf(BA_QUALITY_START, start + 1), `${name}: block xuất hiện hai lần`).toBe(-1)
  return text.slice(start + BA_QUALITY_START.length, end)
}

describe("block luật chất lượng dùng chung (FLF-449 N2)", () => {
  it("giống nhau từng byte ở 9 SKILL.md phân tích và chat.md", () => {
    const [first, ...rest] = FILES.map(({ name, file }) => ({ name, block: sharedBlockOf(name, file) }))
    for (const { name, block } of rest) expect(block, `${name} lệch với ${first.name}`).toBe(first.block)
  })

  it("không rỗng và ngắn (≤ 12 dòng) - xoá nội dung giữa hai mốc không làm test xanh", () => {
    const block = sharedBlockOf(FILES[0].name, FILES[0].file).trim()
    const lines = block.split("\n").filter((l) => l.trim() !== "")
    expect(block.length).toBeGreaterThan(400)
    expect(lines.length).toBeGreaterThanOrEqual(5)
    expect(lines.length).toBeLessThanOrEqual(12)
  })

  it("mang đủ bốn luật (a)–(d) và cặp ví dụ đạt / không đạt của business flow", () => {
    const block = sharedBlockOf(FILES[0].name, FILES[0].file)
    for (const rule of ["(a)", "(b)", "(c)", "(d)"]) expect(block, rule).toContain(rule)
    expect(block).toContain("verbatim")
    expect(block).toContain("Never ask what is already answered")
    expect(block).toContain("Fails: \"nên cân nhắc bảo mật\"")
    expect(block).toContain("Passes: \"màn đối soát hiện số tiền, nên chỉ cho vai Kế toán xem\"")
  })

  it("luật (c) theo chốt 03 #3: chỉ khuyến nghị khi chắc chắn, kèm lý do + căn cứ; không chắc thì không khuyến nghị", () => {
    const block = sharedBlockOf(FILES[0].name, FILES[0].file)
    expect(block).toContain("Recommend only when you are sure")
    expect(block).toContain("states its reason and that basis")
    expect(block).toContain("with no recommendation")
  })

  it("không em dash, không chữ FPT trong block (chữ AI sinh ra theo nó)", () => {
    const block = sharedBlockOf(FILES[0].name, FILES[0].file)
    expect(block).not.toContain("—")
    expect(block).not.toMatch(/FPT/)
  })

  it("block tới được model: có trong template của skill hành động và của chat", async () => {
    for (const actionType of [ActionType.ELICIT, ActionType.REVIEW, ActionType.CHANGE_INSTRUCTION, ActionType.EXTRACT_REQUIREMENTS, ActionType.IMPORT_SEMANTIC_CHECK, ActionType.IMPORT_CROSS_CHECK, ActionType.CHAT]) {
      const { template } = await getPromptTemplate(actionType)
      expect(template, String(actionType)).toContain(BA_QUALITY_START)
      expect(template, String(actionType)).toContain("Recommend only when you are sure")
    }
  })
})
