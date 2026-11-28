import { describe, it, expect, vi } from "vitest"
import { elicitSchema } from "../../shared/ai/response-parser.js"
import { answerText, answeredTopics, chatReplyQuestionId, currentBatch, indexOfQuestion, questionIdsFor, shapeChatQuestions, shapeOptions, shapeQuestions, splitNumberedAnswer, verifiedDecisionUpdates, verifiedExcerpt, type ModelQuestion } from "./question-shape.js"

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

  it("FLF-260: bỏ cả option 'Khác' model viết bằng tiếng Anh, giữ nhãn khuyến nghị tiếng Anh", () => {
    expect(shapeOptions(opts("Web (Recommended)", "Others", "Mobile", "Another option", "Other options…", "Other option:", "Custom…")).map((o) => o.label)).toEqual([
      "Web (Recommended)",
      "Mobile"
    ])
  })

  it("FLF-260: 'Custom' trơn là phương án thật - không lọc, kể cả khi được khuyến nghị", () => {
    expect(shapeOptions(opts("Default theme (Recommended)", "Custom")).map((o) => o.label)).toEqual(["Default theme (Recommended)", "Custom"])
    expect(shapeOptions(opts("Custom (Recommended)", "Standard")).map((o) => o.label)).toEqual(["Custom (Recommended)", "Standard"])
    expect(shapeOptions(opts("Standard", "Custom", "Premium")).map((o) => o.label)).toEqual(["Standard", "Custom", "Premium"])
  })

  it("FLF-260: giữ option tiếng Anh chỉ chứa 'other' / 'custom' như một phần của câu", () => {
    expect(shapeOptions(opts("Other staff", "Custom reports", "Others (please specify)")).map((o) => o.label)).toEqual(["Other staff", "Custom reports"])
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

  it("model phát quá trần ⇒ giữ 4 câu VÀ ghi log số câu bị bỏ kèm chủ đề của chúng", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    try {
      const { asked } = shapeQuestions(["A", "B", "C", "D", "E", "F"].map((t) => q(t)))
      expect(asked).toHaveLength(4)
      expect(info).toHaveBeenCalledTimes(1)
      const line = String(info.mock.calls[0][0])
      expect(line).toContain("bỏ 2 câu")
      expect(line).toContain("e")
      expect(line).toContain("f")
    } finally {
      info.mockRestore()
    }
  })

  it("đúng trần hoặc ít hơn ⇒ không log gì", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    try {
      shapeQuestions(["A", "B", "C", "D", ""].map((t) => q(t)))
      expect(info).not.toHaveBeenCalled()
    } finally {
      info.mockRestore()
    }
  })

  it("câu mở không mang options/multiple; header cắt ≤ 12 ký tự", () => {
    const [open] = shapeQuestions([q("Mô tả quy trình đặt lịch?", { multiple: true, header: "  Quy trình đặt lịch  " })]).questions
    expect(open).toMatchObject({ text: "Mô tả quy trình đặt lịch?", header: "Quy trình…" })
    const h = (header: string) => shapeQuestions([q("Hỏi?", { header })]).questions[0]?.header
    expect(h("Dịch vụ ngoài")).toBe("Dịch vụ…")
    expect(h("Quy tắc quan trọng")).toBe("Quy tắc…")
    expect(h("Uptime")).toBe("Uptime")
    expect(h("Khôngcókhoảngtrắng")).toBe("Khôngcókhoả…")
    expect(Array.from(h("Hoả̉ng lâu dài hơn nhiều")!).length).toBeLessThanOrEqual(12)
    expect(h("   ")).toBeUndefined()
    expect(open.options).toBeUndefined()
    expect(open).not.toHaveProperty("multiple")
    const [card] = shapeQuestions([q("Uptime?", { options: opts("99.9% (Khuyến nghị)", "99%"), multiple: false, header: "Uptime" })]).questions
    expect(card).toEqual({ id: card.id, text: "Uptime?", header: "Uptime", options: opts("99.9% (Khuyến nghị)", "99%"), multiple: false })
  })
})

describe("một lượt một loại câu (FLF-355)", () => {
  const mixed = [
    { question: "Nền tảng?", options: opts("Web", "Mobile"), topic_key: "form_factor" },
    { question: "Ai duyệt lịch hẹn?", options: [], topic_key: "approver" },
    { question: "Tuân thủ?", options: opts("Nội bộ", "Nội bộ và pháp luật"), topic_key: "stakes" }
  ]

  it("lượt trộn ⇒ FE chỉ nhận nhóm cùng loại với câu đầu; `asked` giữ đủ để hỏi tiếp, id theo chủ đề không đổi", () => {
    const { asked, questions } = shapeQuestions(mixed)
    expect(questions.map((x) => x.id)).toEqual(["Q_form_factor", "Q_stakes"])
    expect(asked.map((x) => x.topic_key)).toEqual(["form_factor", "approver", "stakes"])
    const { now, later } = currentBatch(asked)
    expect(now.map((x) => x.topic_key)).toEqual(["form_factor", "stakes"])
    expect(later.map((x) => x.topic_key)).toEqual(["approver"])
    expect(shapeQuestions(later).questions).toEqual([{ id: "Q_approver", text: "Ai duyệt lịch hẹn?" }])
  })

  it("câu đầu là câu mở ⇒ lượt này hỏi câu mở trước, câu chọn để sau", () => {
    const { questions } = shapeQuestions([mixed[1], mixed[0]])
    expect(questions.map((x) => x.id)).toEqual(["Q_approver"])
  })

  it("câu có lựa chọn còn < 2 option sau khi lọc thành câu mở ⇒ tính theo loại sau khi lọc", () => {
    const { questions } = shapeQuestions([mixed[0], { question: "Kênh?", options: opts("Online", "Khác…"), topic_key: "channel" }])
    expect(questions.map((x) => x.id)).toEqual(["Q_form_factor"])
  })

  it("lượt một loại ⇒ không có gì để sau", () => {
    expect(currentBatch([mixed[0], mixed[2]]).later).toEqual([])
    expect(currentBatch([]).now).toEqual([])
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

describe("inline (FLF-232)", () => {
  it("câu mở đã hỏi trong lời AI mang inline: true tới hợp đồng; câu có lựa chọn không bao giờ inline", () => {
    const { questions, asked } = shapeQuestions([
      { question: "Quy trình đặt lịch hiện nay thế nào?", options: [], topic_key: "booking_flow", inline: true },
      { question: "Cần bao nhiêu người dùng?", options: [{ label: "50" }, { label: "200" }], topic_key: "concurrent_users", inline: true },
      { question: "Ai duyệt?", options: [], topic_key: "approver" }
    ])
    expect(questions[0]).toMatchObject({ id: "Q_booking_flow", inline: true })
    expect(questions[1]).toMatchObject({ id: "Q_approver" })
    expect(questions[1]).not.toHaveProperty("inline")
    // câu có lựa chọn chờ lượt sau (FLF-355), cũng không inline
    expect(shapeQuestions([asked[1]]).questions[0]).not.toHaveProperty("inline")
    // giữ trên câu đang chờ để lượt chat sau vẫn dựng lại đúng
    expect(asked[0].inline).toBe(true)
  })
})

describe("elicitSchema - inline (FLF-232)", () => {
  it("nhận inline boolean; thiếu hoặc null ⇒ không có; câu dạng chuỗi trơn vẫn parse", () => {
    const parsed = elicitSchema.parse({
      reply: "ok",
      questions: [{ question: "a?", topic_key: "a", inline: true }, { question: "b?", topic_key: "b", inline: null }, { question: "c?" }, "d?"]
    })
    const inlines = parsed.questions.map((item) => (item as { inline?: boolean }).inline)
    expect(inlines).toEqual([true, undefined, undefined, undefined])
  })
})

describe("FLF-449: thẻ phương án qua shapeQuestions", () => {
  const card = (extra: Partial<ModelQuestion> = {}) =>
    q("Kênh nhắc lịch?", {
      topic_key: "reminder_channel",
      recommendation_reason: "Bạn nói bệnh nhân lớn tuổi ít dùng ứng dụng",
      options: [
        { label: "SMS (Khuyến nghị)", recommended: true, pros: ["Ai cũng nhận được"], cons: ["Tốn phí mỗi tin"], risks: ["Giả định số điện thoại đúng"] },
        { label: "Zalo", pros: ["Miễn phí"] }
      ],
      ...extra
    })

  it("giữ ưu / nhược / rủi ro, cờ và lý do khuyến nghị tới hợp đồng gửi FE", () => {
    const { questions, asked } = shapeQuestions([card()])
    expect(questions[0].recommendation_reason).toBe("Bạn nói bệnh nhân lớn tuổi ít dùng ứng dụng")
    expect(questions[0].options).toEqual(card().options)
    // shape lại câu đang chờ (run-state) không làm rơi gì
    expect(shapeQuestions(asked).questions).toEqual(questions)
  })

  it("phương án được khuyến nghị bị lọc ⇒ lý do không còn trỏ vào đâu, bỏ", () => {
    const named = q("Tên hệ thống?", {
      topic_key: "system_name",
      recommendation_reason: "Gần với tên phòng khám",
      options: [{ label: "Minh An System (Khuyến nghị)", recommended: true }, { label: "CarePoint" }, { label: "MediBook" }]
    })
    const { questions } = shapeQuestions([named])
    expect(questions[0].options?.map((o) => o.label)).toEqual(["CarePoint", "MediBook"])
    expect(questions[0].recommendation_reason).toBeUndefined()
  })

  it("noIdeaYet ⇒ bỏ cờ, đuôi và lý do; ghi log thay vì bỏ im", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const { questions } = shapeQuestions([card()], { noIdeaYet: true })
    expect(questions[0].options).toEqual([
      { label: "SMS", pros: ["Ai cũng nhận được"], cons: ["Tốn phí mỗi tin"], risks: ["Giả định số điện thoại đúng"] },
      { label: "Zalo", pros: ["Miễn phí"] }
    ])
    expect(questions[0].recommendation_reason).toBeUndefined()
    expect(info).toHaveBeenCalledWith(expect.stringContaining("recommendation_dropped scope=no_idea_yet reason=no_idea_yet count=1 topics=reminder_channel"))
    info.mockRestore()
  })

  it("run-state cũ: chỉ có đuôi, không cờ, không lý do ⇒ giữ nguyên như trước", () => {
    const { questions } = shapeQuestions([q("Uptime?", { options: opts("99.9% (Khuyến nghị)", "99%") })])
    expect(questions[0].options).toEqual(opts("99.9% (Khuyến nghị)", "99%"))
    expect(questions[0].recommendation_reason).toBeUndefined()
  })

  it("chat Discovery giữ trường mới", () => {
    const [chat] = shapeChatQuestions([{ question: "Nền tảng?", recommendation_reason: "r", options: [{ label: "Web (Khuyến nghị)", pros: ["Không cần cài"] }, "Mobile"] }])
    expect(chat).toEqual({ question: "Nền tảng?", options: [{ label: "Web (Khuyến nghị)", pros: ["Không cần cài"], recommended: true }, { label: "Mobile" }], multiple: false, recommendation_reason: "r" })
  })

  it("elicitSchema → shapeQuestions: tin cũ chỉ có đuôi (Khuyến nghị) vẫn đọc được thành thẻ", () => {
    const parsed = elicitSchema.parse({ reply: "Ok", questions: [{ question: "Uptime?", topic_key: "uptime", options: ["99.9% (Khuyến nghị)", "99%"] }] })
    const { questions } = shapeQuestions(parsed.questions)
    expect(questions[0].options?.map((o) => o.label)).toEqual(["99.9%", "99%"])
  })
})

describe("verifiedDecisionUpdates (FLF-472, 5b)", () => {
  const dc = (over: Record<string, unknown> = {}) => ({
    id: "DC01",
    topic_key: "external_partners",
    question: "Đối tác ngoài nào nối API?",
    answer: "Chỉ VNPay và MoMo",
    step_id: "S-1",
    at: "2026-11-01T00:00:00.000Z",
    superseded_by: null,
    ...over
  })
  const spine = { decisions: [dc()] } as never
  const message = "À không, GHN và GHTK cũng nối API nhé"

  it("khoá không có trong sổ ⇒ bỏ", () => {
    expect(verifiedDecisionUpdates(spine, [{ topic_key: "shipping", answer: "GHN và GHTK cũng nối API" }], message)).toEqual([])
  })

  it("trích đoạn không phải chữ của tin ⇒ bỏ", () => {
    expect(verifiedDecisionUpdates(spine, [{ topic_key: "external_partners", answer: "Thêm GHN, GHTK" }], message)).toEqual([])
  })

  it("hợp lệ (khoá chuẩn hoá được, trích đoạn nguyên văn) ⇒ trả mục đính chính", () => {
    expect(verifiedDecisionUpdates(spine, [{ topic_key: "External Partners", answer: "GHN và GHTK cũng nối API" }], message)).toEqual([
      { topic_key: "external_partners", question: "Đối tác ngoài nào nối API?", answer: "GHN và GHTK cũng nối API", correction: true }
    ])
  })

  it("trùng đáp án đang có, chủ đề đang chờ, hoặc quyết định đã bị thay thế ⇒ bỏ", () => {
    expect(verifiedDecisionUpdates(spine, [{ topic_key: "external_partners", answer: "chỉ vnpay và momo" }], "Chỉ VNPay và MoMo")).toEqual([])
    expect(verifiedDecisionUpdates(spine, [{ topic_key: "external_partners", answer: "GHN và GHTK cũng nối API" }], message, ["external_partners"])).toEqual([])
    expect(verifiedDecisionUpdates({ decisions: [dc({ superseded_by: "DC02" })] } as never, [{ topic_key: "external_partners", answer: "GHN và GHTK cũng nối API" }], message)).toEqual([])
  })
})
