import { describe, it, expect } from "vitest"
import { elicitSchema } from "../../shared/ai/response-parser.js"
import { answerText, answeredTopics, chatReplyQuestionId, shapeChatQuestions, shapeOptions, shapeQuestions, type ModelQuestion } from "./question-shape.js"

const opts = (...labels: string[]) => labels.map((label) => ({ label }))
const q = (question: string, extra: Partial<ModelQuestion> = {}): ModelQuestion & { topic_key: string } => ({
  question,
  options: [],
  topic_key: question.toLowerCase().replace(/\W+/g, "_"),
  ...extra
})

describe("shapeOptions", () => {
  it("bỏ option 'Khác' model tự viết và option trùng", () => {
    expect(shapeOptions(opts("99.9% (Khuyến nghị)", "99%", "Khác…", "Other", "99%")).map((o) => o.label)).toEqual(["99.9% (Khuyến nghị)", "99%"])
  })

  it("giữ option có chữ 'khác' ở giữa", () => {
    expect(shapeOptions(opts("Khác biệt theo vai trò", "Giống nhau")).map((o) => o.label)).toEqual(["Khác biệt theo vai trò", "Giống nhau"])
  })

  it("còn 1 option ⇒ thành câu mở; > 4 ⇒ cắt còn 4", () => {
    expect(shapeOptions(opts("Chỉ một", "Khác"))).toEqual([])
    expect(shapeOptions(opts("A", "B", "C", "D", "E"))).toHaveLength(4)
  })

  it("tên hệ thống vẫn qua luật BUG-30", () => {
    expect(shapeOptions(opts("Minh An Booking", "CarePoint", "Clinic App"), "system_name").map((o) => o.label)).toEqual(["Minh An Booking", "CarePoint"])
  })
})

describe("shapeQuestions", () => {
  it("tối đa 4 câu/lượt, id theo thứ tự còn lại", () => {
    const { asked, questions } = shapeQuestions(["A", "B", "", "C", "D", "E"].map((t) => q(t)))
    expect(asked).toHaveLength(4)
    expect(questions.map((x) => x.id)).toEqual(["Q1", "Q2", "Q3", "Q4"])
    expect(questions.map((x) => x.text)).toEqual(["A", "B", "C", "D"])
  })

  it("câu mở không mang options/multiple; header cắt ≤ 12 ký tự", () => {
    const { questions } = shapeQuestions([
      q("Mô tả quy trình đặt lịch?", { multiple: true, header: "  Quy trình đặt lịch  " }),
      q("Uptime?", { options: opts("99.9% (Khuyến nghị)", "99%"), multiple: false, header: "Uptime" })
    ])
    expect(questions[0]).toEqual({ id: "Q1", text: "Mô tả quy trình đặt lịch?", header: "Quy trình đặ" })
    expect(questions[1]).toEqual({ id: "Q2", text: "Uptime?", header: "Uptime", options: opts("99.9% (Khuyến nghị)", "99%"), multiple: false })
  })
})

describe("elicitSchema (dạng cũ và mới)", () => {
  it("suggestedAnswers cũ map sang options; option object giữ description/preview", () => {
    const parsed = elicitSchema.parse({
      reply: "Ok",
      questions: [
        { question: "Vai trò?", suggestedAnswers: ["Admin", "Staff"], multiple: true },
        { question: "Bố cục?", header: "Bố cục", options: [{ label: "Lưới", description: "Dễ quét", preview: "[ ][ ]" }, { label: "Danh sách", description: null }] },
        "Mô tả nghiệp vụ?"
      ]
    })
    expect(parsed.questions[0].options).toEqual(opts("Admin", "Staff"))
    expect(parsed.questions[1].options).toEqual([{ label: "Lưới", description: "Dễ quét", preview: "[ ][ ]" }, { label: "Danh sách" }])
    expect(parsed.questions[2]).toMatchObject({ question: "Mô tả nghiệp vụ?", options: [] })
  })
})

describe("answerText / answeredTopics", () => {
  it("bỏ đuôi khuyến nghị ở từng lựa chọn", () => {
    expect(answerText("99.9% (Khuyến nghị)")).toBe("99.9%")
    expect(answerText(["Admin (Recommended)", "Staff"])).toBe("Admin, Staff")
  })

  it("câu có lựa chọn luôn ghi sổ; câu mở chỉ ghi khi mỗi câu mở có câu trả lời riêng", () => {
    const asked = [q("Uptime?", { options: opts("99%", "99.9%") }), q("Quy trình?"), q("Chính sách huỷ?")]
    const unsplit = answeredTopics(asked, [
      { question_id: "Q1", answer: "99% (Khuyến nghị)" },
      { question_id: "Q2", answer: "Khách đặt online, huỷ trước 2 giờ" }
    ])
    expect(unsplit).toEqual([{ topic_key: asked[0].topic_key, question: "Uptime?", answer: "99%" }])

    const split = answeredTopics(asked, [
      { question_id: "Q2", answer: "Khách đặt online" },
      { question_id: "Q3", answer: "Huỷ trước 2 giờ" },
      { question_id: "Q9", answer: "lạc" }
    ])
    expect(split.map((a) => a.answer)).toEqual(["Khách đặt online", "Huỷ trước 2 giờ"])
  })
})

describe("shapeChatQuestions (Discovery)", () => {
  it("chuẩn hoá tin nhắn CHAT: dạng cũ, chuỗi trơn, câu mở, rác", () => {
    const shaped = shapeChatQuestions([
      { question: "Nền tảng?", suggestedAnswers: ["Web", "Mobile", "Khác"], multiple: false },
      "Kể thêm về khách hàng?",
      { question: "Một lựa chọn?", options: [{ label: "Duy nhất" }], multiple: true },
      { nonsense: true }
    ])
    expect(shaped).toEqual([
      { question: "Nền tảng?", options: opts("Web", "Mobile"), multiple: false },
      { question: "Kể thêm về khách hàng?" },
      { question: "Một lựa chọn?" }
    ])
    expect(shapeChatQuestions(undefined)).toEqual([])
  })
})

describe("chatReplyQuestionId", () => {
  it("chat gõ thẳng gán cho câu mở đầu tiên, không gán vào câu có lựa chọn", () => {
    expect(chatReplyQuestionId([{ id: "Q1", options: [{ label: "A" }, { label: "B" }] }, { id: "Q2" }])).toBe("Q2")
    expect(chatReplyQuestionId([{ id: "Q1", options: ["A", "B"] }])).toBe("Q1")
    expect(chatReplyQuestionId(null)).toBe("Q1")
  })
})
