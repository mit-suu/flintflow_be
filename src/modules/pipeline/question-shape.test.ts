import { describe, it, expect } from "vitest"
import { elicitSchema } from "../../shared/ai/response-parser.js"
import { answerText, answeredTopics, chatReplyQuestionId, indexOfQuestion, questionIdsFor, shapeChatQuestions, shapeOptions, shapeQuestions, splitNumberedAnswer, verifiedExcerpt, type ModelQuestion } from "./question-shape.js"

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
  it("tối đa 4 câu/lượt; id ổn định theo topic_key (FLF-221)", () => {
    const { asked, questions } = shapeQuestions(["A", "B", "", "C", "D", "E"].map((t) => q(t)))
    expect(asked).toHaveLength(4)
    expect(questions.map((x) => x.id)).toEqual(questionIdsFor(asked))
    expect(questions.map((x) => x.id)).toEqual(asked.map((a) => `Q_${a.topic_key}`))
    expect(questions.map((x) => x.text)).toEqual(["A", "B", "C", "D"])
  })

  it("câu mở không mang options/multiple; header cắt ≤ 12 ký tự", () => {
    const { questions } = shapeQuestions([
      q("Mô tả quy trình đặt lịch?", { multiple: true, header: "  Quy trình đặt lịch  " }),
      q("Uptime?", { options: opts("99.9% (Khuyến nghị)", "99%"), multiple: false, header: "Uptime" })
    ])
    expect(questions[0]).toMatchObject({ text: "Mô tả quy trình đặt lịch?", header: "Quy trình đặ" })
    expect(questions[0].options).toBeUndefined()
    expect(questions[1]).toEqual({ id: questions[1].id, text: "Uptime?", header: "Uptime", options: opts("99.9% (Khuyến nghị)", "99%"), multiple: false })
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

describe("FLF-221: shapeQuestions khi user chưa có ý tưởng", () => {
  const input = [
    {
      question: "Bạn muốn làm cho ai?",
      topic_key: "audience",
      options: [
        { label: "Cho khách hàng", description: "b" },
        { label: "Cho chính mình (Khuyến nghị)", description: "a" }
      ]
    }
  ]

  it("noIdeaYet ⇒ bỏ đuôi (Khuyến nghị), giữ nguyên thứ tự option", () => {
    const { questions } = shapeQuestions(input, { noIdeaYet: true })
    expect(questions[0].options?.map((o) => o.label)).toEqual(["Cho khách hàng", "Cho chính mình"])
  })

  it("proseOnly ⇒ không còn option nào", () => {
    const { questions, asked } = shapeQuestions(input, { noIdeaYet: true, proseOnly: true })
    expect(questions[0].options).toBeUndefined()
    expect(asked[0].options).toEqual([])
  })

  it("mặc định giữ nhãn khuyến nghị như cũ", () => {
    const { questions } = shapeQuestions(input)
    expect(questions[0].options?.[1].label).toBe("Cho chính mình (Khuyến nghị)")
  })
})

describe("FLF-221: id câu hỏi theo topic_key", () => {
  const asked = [
    { question: "Uptime?", topic_key: "uptime", options: [] },
    { question: "Kênh báo?", topic_key: "channel", options: [] },
    { question: "Kênh báo 2?", topic_key: "channel", options: [] }
  ]
  it("id theo chủ đề, trùng chủ đề thêm hậu tố; tra được cả id cũ theo vị trí", () => {
    expect(questionIdsFor(asked)).toEqual(["Q_uptime", "Q_channel", "Q_channel_2"])
    expect(indexOfQuestion(asked, "Q_channel")).toBe(1)
    expect(indexOfQuestion(asked, "Q3")).toBe(2)
    expect(indexOfQuestion(asked, "Q9")).toBe(-1)
  })

  it("câu mở chốt qua chat ghi sổ dù câu mở khác chưa trả lời", () => {
    const answers = [{ question_id: "Q_uptime", answer: "99%" }]
    expect(answeredTopics(asked, answers)).toEqual([])
    expect(answeredTopics(asked, answers, new Set(["Q_uptime"]))).toEqual([{ topic_key: "uptime", question: "Uptime?", answer: "99%" }])
  })
})

describe("splitNumberedAnswer / verifiedExcerpt", () => {
  it("tách theo số đầu dòng, nối dòng tiếp theo, bỏ chữ trước số đầu", () => {
    const out = splitNumberedAnswer("Trả lời nhé:\n1. Lễ tân\n2) 99%\ncó thể hơn\n3. ")
    expect([...out.entries()]).toEqual([[0, "Lễ tân"], [1, "99% có thể hơn"]])
  })

  it("không đánh số ⇒ rỗng", () => {
    expect(splitNumberedAnswer("Lễ tân, 99%").size).toBe(0)
  })

  it("trích đoạn chỉ nhận khi là chuỗi con (bỏ khác biệt khoảng trắng, hoa/thường)", () => {
    expect(verifiedExcerpt("giảm  HÀNG chờ", "Mục tiêu là giảm hàng\nchờ")).toBe("giảm  HÀNG chờ")
    expect(verifiedExcerpt("dưới 15 phút", "càng sớm càng tốt")).toBeUndefined()
    expect(verifiedExcerpt("  ", "abc")).toBeUndefined()
  })
})
