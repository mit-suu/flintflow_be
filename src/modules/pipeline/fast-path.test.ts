import { describe, expect, it } from "vitest"
import type { Decision, Spine } from "../spine/spine.types.js"
import { FAST_PATH_PHASES, elicitPolicyFor, interviewBudget, interviewGuidance, interviewProjection, keepConflictsOnly, NO_QUESTION_ACK_EN, NO_QUESTION_ACK_VI, noQuestionAck, reconcileReply, trimTailQuestion, withoutQuestions } from "./fast-path.js"
import { MAX_QUESTIONS_PER_TURN } from "./question-shape.js"
import { createEmptySpine } from "../spine/spine.repository.js"

const decision = (topic_key: string, answer: string): Decision => ({
  id: `DC-${topic_key}`,
  topic_key,
  question: "?",
  answer,
  step_id: "B-1",
  at: "2026-09-30T00:00:00.000Z",
  superseded_by: null
})
const ledger = (...decisions: Decision[]): Spine => ({ decisions }) as unknown as Spine
const q = (topic_key: string, conflict?: string) => ({ question: `Câu về ${topic_key}?`, topic_key, options: [], ...(conflict ? { conflict } : {}) })

describe("elicitPolicyFor", () => {
  it("chỉ B-1 là fast path", () => {
    expect([...FAST_PATH_PHASES]).toEqual(["B-1"])
  })
  it("ngoài fast path ⇒ normal dù có tin user hay không", () => {
    expect(elicitPolicyFor({ phase: "S-6", hasUserMessage: false })).toBe("normal")
    expect(elicitPolicyFor({ phase: "B-2", hasUserMessage: true })).toBe("normal")
  })
  it("B-1: không tin user ⇒ skip; có tin user ⇒ conflict_only", () => {
    expect(elicitPolicyFor({ phase: "B-1", hasUserMessage: false })).toBe("skip")
    expect(elicitPolicyFor({ phase: "B-1", hasUserMessage: true })).toBe("conflict_only")
  })
})

describe("keepConflictsOnly", () => {
  const spine = ledger(decision("uptime", "99%"))
  it("giữ câu conflict trên chủ đề đã chốt; bỏ câu thường và conflict trên chủ đề chưa chốt", () => {
    const out = keepConflictsOnly(spine, [q("uptime", "user nói 99.9%"), q("uptime"), q("data_retention", "mâu thuẫn"), q("payment_method")])
    expect(out.questions.map((x) => x.topic_key)).toEqual(["uptime"])
    expect(out.dropped.map((x) => x.topic_key)).toEqual(["uptime", "data_retention", "payment_method"])
  })
  it("chuẩn hoá alias chủ đề (availability ⇒ uptime) và coi conflict rỗng là không có", () => {
    expect(keepConflictsOnly(spine, [q("availability", "khác")]).questions).toHaveLength(1)
    expect(keepConflictsOnly(spine, [{ ...q("uptime"), conflict: "  " }]).questions).toHaveLength(0)
  })
})

describe("interviewBudget", () => {
  it("internal ⇒ 2; còn lại (kể cả chưa biết) ⇒ trần một lượt", () => {
    expect(interviewBudget("internal")).toBe(2)
    expect(interviewBudget("production")).toBe(MAX_QUESTIONS_PER_TURN)
    expect(interviewBudget("regulated")).toBe(MAX_QUESTIONS_PER_TURN)
    expect(interviewBudget(null)).toBe(MAX_QUESTIONS_PER_TURN)
  })
})

describe("interviewProjection / interviewGuidance (B-1)", () => {
  const spine = createEmptySpine({ name: "Đặt lịch", domain: null })
  spine.project.stakes = "regulated"

  it("projection hợp có project:…stakes và gốc luôn đọc của vòng hỏi", () => {
    const keys = Object.keys(interviewProjection(spine, "B-1"))
    expect(keys.some((k) => k.startsWith("project:") && k.includes("stakes"))).toBe(true)
    expect(keys).toContain("business_rules:id,statement")
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("guidance: mỗi bước một dòng '<label_en>: <description>', không lộ mã bước", () => {
    const lines = interviewGuidance(spine, "B-1").split("\n")
    expect(lines).toHaveLength(6)
    expect(lines[0]).toMatch(/^Product Vision, Problem & Opportunity: .+/)
    expect(lines.join("\n")).not.toMatch(/B-1\.\d/)
  })
})

describe("reconcileReply", () => {
  it("không bỏ câu nào ⇒ giữ nguyên lời AI", () => {
    expect(reconcileReply("Mình đã đọc. Bạn lưu bao lâu?", [], ["Bạn lưu bao lâu?"])).toBe("Mình đã đọc. Bạn lưu bao lâu?")
  })
  it("bỏ mà không còn câu nào ⇒ lời nhận tin không có câu hỏi", () => {
    const reply = reconcileReply("Mình đã đọc. Bạn lưu hồ sơ bao lâu?", ["Bạn lưu hồ sơ bao lâu?"], [])
    expect(reply).toBe(NO_QUESTION_ACK_VI)
    expect(reply).not.toContain("?")
  })
  it("còn câu được hỏi ⇒ cắt câu hỏi khớp câu bị bỏ (không dấu, không phân biệt hoa thường), giữ câu còn được hỏi", () => {
    const reply = reconcileReply(
      "Mình đã đọc rồi. Bạn có muốn đặt lịch trên web không? BẠN LƯU HỒ SƠ Ở KHO LẠNH KHÔNG?",
      ["Bạn có muốn lưu hồ sơ ở kho lạnh không?"],
      ["Bạn có muốn đặt lịch trên web không?"]
    )
    expect(reply).toBe("Mình đã đọc rồi. Bạn có muốn đặt lịch trên web không?")
  })
  it("câu hỏi trong lời AI giống câu còn được hỏi hơn câu bị bỏ ⇒ giữ", () => {
    const same = "Bạn có muốn nhắc lịch không?"
    expect(reconcileReply(`Ok. ${same}`, [same], [same])).toBe(`Ok. ${same}`)
  })
  it("cắt hết chỉ còn câu hỏi bị bỏ ⇒ lời nhận tin; câu không phải câu hỏi không bị cắt", () => {
    expect(reconcileReply("Bạn lưu hồ sơ bao lâu?", ["Bạn lưu hồ sơ bao lâu?"], ["Bạn dùng điện thoại nào?"])).toBe(NO_QUESTION_ACK_VI)
    expect(reconcileReply("Mình sẽ lưu hồ sơ bao lâu tuỳ bạn.", ["Bạn lưu hồ sơ bao lâu?"], ["Bạn dùng điện thoại nào?"])).toBe("Mình sẽ lưu hồ sơ bao lâu tuỳ bạn.")
  })
})

describe("trimTailQuestion: câu hỏi đuôi tính vào trần câu hỏi", () => {
  const asked = [{ question: "Bạn muốn giảm thời gian chờ xuống bao nhiêu?" }, { question: "Bệnh nhân đặt lịch qua kênh nào?" }]
  it("đã hỏi đủ ngân sách (thẻ) mà lời AI còn kết bằng câu hỏi lạ ⇒ cắt câu đó; số thập phân không bị coi là hết câu", () => {
    expect(trimTailQuestion("Quy trình thanh toán hai kênh nghe hợp lý. Tôi sẽ viết theo hướng đó, bạn thấy hợp lý chứ?", asked, 2)).toBe(
      "Quy trình thanh toán hai kênh nghe hợp lý."
    )
    expect(trimTailQuestion("Tầm 1.000 ca mỗi ngày là mức tôi lấy. Bạn thấy ổn chứ?", asked, 2)).toBe("Tầm 1.000 ca mỗi ngày là mức tôi lấy.")
  })
  it("chưa đủ ngân sách, hoặc câu cuối là câu đang hỏi, hoặc không kết bằng '?' ⇒ giữ nguyên", () => {
    const tail = "Ok. Bạn thấy hợp lý chứ?"
    expect(trimTailQuestion(tail, asked.slice(0, 1), 2)).toBe(tail)
    const inline = "Ok. Bệnh nhân đặt lịch qua kênh nào?"
    expect(trimTailQuestion(inline, asked, 2)).toBe(inline)
    const plain = "Ok. Tôi sẽ viết theo hướng đó."
    expect(trimTailQuestion(plain, asked, 2)).toBe(plain)
  })
  it("câu inline chỉ có trong lời AI: số câu hỏi trong lời ≤ số câu inline ⇒ không cắt dù model viết lại khác chữ", () => {
    const inlineAsked = [{ question: "Bạn muốn giảm thời gian chờ xuống bao nhiêu?", inline: true }, { question: "Bệnh nhân đặt lịch qua kênh nào?", inline: true }]
    const reply = "Ok. Còn về thời gian, mức nào là chấp nhận được với bạn? Và về việc hẹn khám, bệnh nhân sẽ dùng gì để đặt?"
    expect(trimTailQuestion(reply, inlineAsked, 2)).toBe(reply)
    // Ba câu hỏi mà chỉ hai câu inline ⇒ câu đuôi thứ ba bị cắt
    expect(trimTailQuestion(`${reply} Bạn thấy hợp lý chứ?`, inlineAsked, 2)).toBe(reply)
  })
  it("cắt hết chỉ còn câu hỏi ⇒ lời nhận tin cố định", () => {
    expect(trimTailQuestion("Bạn thấy hợp lý chứ?", asked, 2)).toBe(NO_QUESTION_ACK_VI)
  })
})

describe("withoutQuestions: lời AI của lượt đóng phỏng vấn", () => {
  it("bỏ mọi câu hỏi, giữ phần ghi nhận", () => {
    expect(withoutQuestions("Tính năng bác sĩ bấm nút rất hợp lý. Vậy bạn đo thành công bằng gì? Tôi sẽ tự đoán phần còn lại.")).toBe(
      "Tính năng bác sĩ bấm nút rất hợp lý. Tôi sẽ tự đoán phần còn lại."
    )
  })

  it("không có câu hỏi ⇒ giữ nguyên; toàn câu hỏi ⇒ lời nhận tin cố định", () => {
    expect(withoutQuestions("Tôi ghi nhận rồi.")).toBe("Tôi ghi nhận rồi.")
    expect(withoutQuestions("Bạn đo thành công bằng gì?")).toBe(NO_QUESTION_ACK_VI)
    expect(withoutQuestions("")).toBe(NO_QUESTION_ACK_VI)
  })
})

describe("FLF-260: lời nhận tin theo ngôn ngữ trả lời", () => {
  const asked = [{ question: "How much should the waiting time drop?" }, { question: "Which channel do patients book through?" }]

  it("noQuestionAck: thiếu hoặc 'vi' ⇒ câu tiếng Việt cũ; 'en' ⇒ câu tiếng Anh, không có câu hỏi", () => {
    expect(noQuestionAck()).toBe(NO_QUESTION_ACK_VI)
    expect(noQuestionAck("vi")).toBe(NO_QUESTION_ACK_VI)
    expect(noQuestionAck("en")).toBe(NO_QUESTION_ACK_EN)
    expect(NO_QUESTION_ACK_EN).not.toContain("?")
  })

  it("reconcileReply / trimTailQuestion / withoutQuestions: cắt hết ⇒ lời nhận tin tiếng Anh", () => {
    expect(reconcileReply("How long do you keep records?", ["How long do you keep records?"], [], "en")).toBe(NO_QUESTION_ACK_EN)
    expect(reconcileReply("How long do you keep records?", ["How long do you keep records?"], ["Which phones do patients use?"], "en")).toBe(NO_QUESTION_ACK_EN)
    expect(trimTailQuestion("Does that sound reasonable?", asked, 2, "en")).toBe(NO_QUESTION_ACK_EN)
    expect(withoutQuestions("How do you measure success?", "en")).toBe(NO_QUESTION_ACK_EN)
    expect(withoutQuestions("", "en")).toBe(NO_QUESTION_ACK_EN)
  })

  it("lời tiếng Anh vẫn được cắt câu hỏi như tiếng Việt; phần còn lại giữ nguyên văn", () => {
    expect(
      reconcileReply("Got it. Do you want web booking? DO YOU KEEP RECORDS IN COLD STORAGE?", ["Do you want to keep records in cold storage?"], ["Do you want web booking?"], "en")
    ).toBe("Got it. Do you want web booking?")
    expect(trimTailQuestion("Two payment channels make sense. I'll write it that way, does that sound reasonable?", asked, 2, "en")).toBe(
      "Two payment channels make sense."
    )
    expect(withoutQuestions("A doctor call button makes sense. So how do you measure success? I'll guess the rest.", "en")).toBe(
      "A doctor call button makes sense. I'll guess the rest."
    )
  })

  it("lời không bị cắt thì giữ nguyên dù phiên tiếng Anh", () => {
    expect(reconcileReply("I've read it. How long do you keep records?", [], ["How long do you keep records?"], "en")).toBe("I've read it. How long do you keep records?")
    expect(trimTailQuestion("Ok. Does that sound reasonable?", asked.slice(0, 1), 2, "en")).toBe("Ok. Does that sound reasonable?")
    expect(withoutQuestions("Noted.", "en")).toBe("Noted.")
  })
})
