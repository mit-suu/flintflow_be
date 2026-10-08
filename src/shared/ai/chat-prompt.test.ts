import { describe, expect, it } from "vitest"
import { ActionType } from "./ai-action.types.js"
import { getPromptTemplate, interpolatePrompt } from "./prompt-registry.service.js"
import { replyLanguageDirective, type ReplyLanguage } from "../i18n/reply-language.js"
import { isChangeInstruction } from "../../modules/spine/change.service.js"

/**
 * FLF-260: prompt `chat.md` thật trên đĩa không còn ép tiếng Việt — ngôn ngữ trả lời đến từ khối `## Reply language`
 * mà `buildPrompt` nối cuối prompt khi lời gọi có `AiActionInput.replyLanguage`. Không có khối ⇒ vẫn tiếng Việt.
 */
const VARIABLES = {
  step_name: "overview",
  chat_history: "User: Hello\nAI: Hi, what are you building?",
  input_text: "Can you explain what this document is still missing?",
  documentContext: "## Tài liệu tham khảo\n(không có)"
}

/** Như `buildPrompt`: thế biến vào template rồi nối khối ngôn ngữ trả lời vào cuối. */
const buildChatPrompt = async (language: ReplyLanguage): Promise<{ body: string; prompt: string }> => {
  const { template } = await getPromptTemplate(ActionType.CHAT)
  const body = interpolatePrompt(template, VARIABLES)
  return { body, prompt: `${body}\n\n${replyLanguageDirective(language)}` }
}

describe("chat.md theo ngôn ngữ trả lời (FLF-260)", () => {
  it("thế đủ biến — không còn {{…}} trong prompt", async () => {
    const { prompt } = await buildChatPrompt("en")
    expect(prompt).not.toContain("{{")
    expect(prompt).toContain(VARIABLES.input_text)
  })

  it("bỏ luật cứng 'bằng tiếng Việt': dặn model theo mục ## Reply language, không có mục đó thì tiếng Việt", async () => {
    const { body } = await buildChatPrompt("en")
    expect(body).not.toContain("bằng tiếng Việt")
    expect(body).toContain('mục "## Reply language" cuối prompt; không có mục đó thì viết tiếng Việt')
    // Định dạng trả về cũng dặn như vậy, không chỉ luật 1
    expect(body).toMatch(/Giá trị "reply", "question", "header", "label", "description" viết bằng ngôn ngữ trả lời/)
  })

  it("đuôi khuyến nghị theo mục ## Reply language, vẫn chỉ khuyến nghị khi có căn cứ", async () => {
    const { body } = await buildChatPrompt("en")
    expect(body).toContain('" (Khuyến nghị)" khi trả lời tiếng Việt, " (Recommended)" khi trả')
    expect(body).not.toContain('"<phương án 1> (Khuyến nghị)"')
    expect(body).toContain("**Chỉ khuyến nghị khi có căn cứ**")
  })

  it("ví dụ lệnh sửa có cả hai ngôn ngữ và đều là lệnh sửa thật", async () => {
    const { body } = await buildChatPrompt("en")
    const examples = [...body.matchAll(/\*((?:thêm|add) use case [^*]+)\*/g)].map((m) => m[1])
    expect(examples).toEqual(["thêm use case Nhắc lịch hẹn", "add use case Appointment reminder"])
    for (const example of examples) expect(isChangeInstruction(example), example).toBe(true)
  })

  it("prompt tiếng Anh kết thúc bằng khối English, có đuôi (Recommended)", async () => {
    const { prompt } = await buildChatPrompt("en")
    const directive = replyLanguageDirective("en")
    expect(prompt.endsWith(`\n\n${directive}`)).toBe(true)
    expect(directive).toContain("Reply language: **English**")
    expect(directive).toContain("` (Recommended)`")
  })
})
