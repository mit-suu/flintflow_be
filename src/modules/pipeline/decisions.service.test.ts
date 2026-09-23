import { describe, expect, it } from "vitest"
import type { Decision, Spine } from "../spine/spine.types.js"
import { activeDecisions, decisionOps, filterAskedQuestions, ledgerForPrompt, normalizeTopicKey, sanitizeSuggestions } from "./decisions.service.js"

const decision = (over: Partial<Decision> = {}): Decision => ({
  id: "DC01",
  topic_key: "uptime",
  question: "Mức uptime mong muốn?",
  answer: "99%",
  step_id: "S-1.4",
  at: "2026-09-22T10:00:00.000Z",
  superseded_by: null,
  ...over
})

const spineWith = (decisions: Decision[]): Spine => ({ decisions } as unknown as Spine)

describe("normalizeTopicKey", () => {
  it("gom từ đồng nghĩa về một khoá — uptime và availability không được thành hai chủ đề", () => {
    expect(normalizeTopicKey("availability", "")).toBe("uptime")
    expect(normalizeTopicKey("SLA", "")).toBe("uptime")
    expect(normalizeTopicKey("slot_hold", "")).toBe("slot_hold_minutes")
  })

  it("model bỏ trống topic_key ⇒ suy từ chính câu hỏi, không bỏ qua luật", () => {
    expect(normalizeTopicKey(undefined, "Thời gian giữ chỗ là bao lâu?")).toBe("thoi_gian_giu_cho_la_bao_lau")
    expect(normalizeTopicKey("", "")).toBe("unknown")
  })
})

describe("filterAskedQuestions (BUG-21)", () => {
  const spine = spineWith([decision()])

  it("bỏ câu thuộc chủ đề đã chốt và nói rõ giá trị đã chốt", () => {
    const result = filterAskedQuestions(spine, [
      { question: "Uptime bao nhiêu?", suggestedAnswers: [], topic_key: "availability" },
      { question: "Cọc bao nhiêu?", suggestedAnswers: [], topic_key: "deposit_amount" }
    ])
    expect(result.questions.map((q) => q.topic_key)).toEqual(["deposit_amount"])
    expect(result.dropped).toEqual([{ topic_key: "uptime", question: "Uptime bao nhiêu?", answer: "99%" }])
  })

  it("model tuyên bố mâu thuẫn thì được hỏi lại", () => {
    const result = filterAskedQuestions(spine, [
      { question: "Uptime 99% hay 99.9%?", suggestedAnswers: [], topic_key: "uptime", conflict: "Brief mới nói 99.9%" }
    ])
    expect(result.questions).toHaveLength(1)
    expect(result.dropped).toEqual([])
  })

  it("hai câu cùng chủ đề trong một lượt cũng là hỏi lặp", () => {
    const result = filterAskedQuestions(spineWith([]), [
      { question: "Giữ chỗ bao lâu?", suggestedAnswers: [], topic_key: "slot_hold_minutes" },
      { question: "Thời gian giữ slot?", suggestedAnswers: [], topic_key: "slot_hold" }
    ])
    expect(result.questions).toHaveLength(1)
    expect(result.dropped).toHaveLength(1)
  })

  it("quyết định đã bị thay thế không còn chặn câu hỏi", () => {
    const superseded = spineWith([decision({ superseded_by: "DC02" })])
    expect(activeDecisions(superseded).size).toBe(0)
    expect(filterAskedQuestions(superseded, [{ question: "Uptime?", suggestedAnswers: [], topic_key: "uptime" }]).questions).toHaveLength(1)
  })
})

describe("decisionOps", () => {
  it("ghi câu trả lời thành quyết định mới", () => {
    const ops = decisionOps(spineWith([]), "S-1.4", [{ topic_key: "uptime", question: "Uptime?", answer: " 99% " }])
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ op: "add", path: "decisions[]" })
    expect(ops[0].value).toMatchObject({ topic_key: "uptime", answer: "99%", step_id: "S-1.4", superseded_by: null })
  })

  it("user đổi ý ⇒ dòng cũ được đánh dấu thay thế, không bị xoá", () => {
    const ops = decisionOps(spineWith([decision()]), "S-6.1", [{ topic_key: "uptime", question: "Uptime?", answer: "99.9%" }])
    expect(ops[0]).toMatchObject({ op: "set", path: "decisions[id=DC01].superseded_by" })
    expect(ops[1]).toMatchObject({ op: "add", path: "decisions[]" })
    expect((ops[1].value as Decision).id).toBe(ops[0].value)
  })

  it("trả lời trùng giá trị đã chốt ⇒ không ghi gì; câu trả lời rỗng cũng vậy", () => {
    expect(decisionOps(spineWith([decision()]), "S-6.1", [{ topic_key: "uptime", question: "Uptime?", answer: "99%" }])).toEqual([])
    expect(decisionOps(spineWith([]), "S-6.1", [{ topic_key: "uptime", question: "Uptime?", answer: "  " }])).toEqual([])
  })

  it("sổ đưa vào prompt chỉ gồm điều còn hiệu lực", () => {
    const spine = spineWith([decision(), decision({ id: "DC02", topic_key: "deposit_amount", answer: "50.000đ", superseded_by: "DC03" })])
    expect(ledgerForPrompt(spine)).toEqual([{ topic_key: "uptime", answer: "99%", step_id: "S-1.4" }])
  })
})

describe("sanitizeSuggestions (BUG-30)", () => {
  it("bỏ tên hệ thống có đuôi rỗng nghĩa", () => {
    expect(sanitizeSuggestions("system_name", ["Minh An Booking", "Minh An Clinic Appointment System", "CarePoint App"])).toEqual([
      "Minh An Booking"
    ])
  })

  it("lọc hết thì giữ nguyên bản, và chủ đề khác không bị đụng", () => {
    expect(sanitizeSuggestions("system_name", ["Clinic System"])).toEqual(["Clinic System"])
    expect(sanitizeSuggestions("uptime", ["99%", "99.9% System"])).toEqual(["99%", "99.9% System"])
  })
})
