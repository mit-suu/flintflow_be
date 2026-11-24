import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { ELEMENT_CONTEXT_MAX_CHARS, buildChatElementContext, chatSpineIndexFor } from "./chat-element-context.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

describe("buildChatElementContext", () => {
  const uc = FIXTURE.use_cases[4]

  it("câu hỏi nhắc mã use case (mọi cách viết) ⇒ nội dung đầy đủ: mô tả, actor, chức năng, màn liên quan", () => {
    const code = uc.id.replace(/^([A-Za-z]+)0*(\d+)$/, "$1-$2")
    for (const question of [`${uc.id} làm gì?`, `${code} làm gì, qua màn nào?`, `${uc.id.toLowerCase()} gồm những bước nào`]) {
      const text = buildChatElementContext(FIXTURE, question)
      expect(text, question).toContain(`Use case ${uc.id} ${uc.name}`)
      expect(text).toContain("Description:")
      expect(text).toContain("Functions:")
    }
    const text = buildChatElementContext(FIXTURE, `${uc.id} làm gì?`)
    const fn = FIXTURE.functions.find((f) => uc.function_ids.includes(f.id))
    if (fn) {
      expect(text).toContain(`Function ${fn.id} ${fn.name}`)
      expect(text).toContain("Normal flow:")
    }
  })

  it("nhắc chức năng ⇒ luồng thường / bất thường, kiểm tra, quy tắc nghiệp vụ, màn", () => {
    const fn = FIXTURE.functions.find((f) => f.normal.length > 0 && f.screen_id)!
    const text = buildChatElementContext(FIXTURE, `Chức năng ${fn.id} kiểm tra những gì?`)
    expect(text).toContain(`Function ${fn.id} ${fn.name}`)
    expect(text).toContain(`Screen: ${fn.screen_id}`)
    expect(text).toContain("1. ")
  })

  it("nhắc nguyên tên (không có mã) ⇒ vẫn tìm được; nhắc màn ⇒ có luồng đi tiếp và chức năng của màn", () => {
    const screen = FIXTURE.screens.find((s) => s.flow_to.length > 0 && s.name.length >= 4)!
    const text = buildChatElementContext(FIXTURE, `Màn ${screen.name} dẫn tới đâu?`)
    expect(text).toContain(`Screen ${screen.id} ${screen.name}`)
    expect(text).toContain("Leads to:")
  })

  it("không nhắc phần tử nào / chưa có Spine / câu rỗng ⇒ rỗng, prompt dùng chỉ mục như cũ", () => {
    expect(buildChatElementContext(FIXTURE, "Tài liệu này còn thiếu gì?")).toBe("")
    expect(buildChatElementContext(null, "UC01")).toBe("")
    expect(buildChatElementContext(FIXTURE, "  ")).toBe("")
    // số lẻ không phải mã phần tử
    expect(buildChatElementContext(FIXTURE, "Có 5 màn hình")).toBe("")
  })

  it("trần token: nhắc rất nhiều phần tử vẫn không vượt ngân sách", () => {
    const question = FIXTURE.functions.map((f) => f.id).join(" ")
    expect(buildChatElementContext(FIXTURE, question).length).toBeLessThanOrEqual(ELEMENT_CONTEXT_MAX_CHARS)
    const long: Spine = { ...FIXTURE, functions: FIXTURE.functions.map((f) => ({ ...f, description: "x".repeat(10000) })) }
    expect(buildChatElementContext(long, question).length).toBeLessThanOrEqual(ELEMENT_CONTEXT_MAX_CHARS)
  })

  it("chatSpineIndexFor nối khối chi tiết sau chỉ mục khi có phần tử được nhắc, không thì giữ nguyên chỉ mục", () => {
    const plain = chatSpineIndexFor(FIXTURE, "Có bao nhiêu use case?")
    expect(plain).toContain("Use cases:")
    expect(plain).not.toContain("Chi tiết các phần tử")
    const detailed = chatSpineIndexFor(FIXTURE, `${uc.id} làm gì?`)
    expect(detailed.startsWith(plain)).toBe(true)
    expect(detailed).toContain("Chi tiết các phần tử được nhắc trong câu hỏi")
    expect(detailed).toContain(`Use case ${uc.id}`)
  })
})

