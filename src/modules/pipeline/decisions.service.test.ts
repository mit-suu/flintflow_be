import { describe, expect, it } from "vitest"
import type { Decision, Spine } from "../spine/spine.types.js"
import { activeDecisions, askableFields, decisionOps, filterAskedQuestions, ledgerForPrompt, normalizeTopicKey, sanitizeSuggestions } from "./decisions.service.js"

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
  it("gom từ đồng nghĩa về một khoá - uptime và availability không được thành hai chủ đề", () => {
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
      { question: "Uptime bao nhiêu?", options: [], topic_key: "availability" },
      { question: "Cọc bao nhiêu?", options: [], topic_key: "deposit_amount" }
    ])
    expect(result.questions.map((q) => q.topic_key)).toEqual(["deposit_amount"])
    expect(result.dropped).toEqual([{ topic_key: "uptime", question: "Uptime bao nhiêu?", answer: "99%" }])
  })

  it("model tuyên bố mâu thuẫn thì được hỏi lại", () => {
    const result = filterAskedQuestions(spine, [
      { question: "Uptime 99% hay 99.9%?", options: [], topic_key: "uptime", conflict: "Brief mới nói 99.9%" }
    ])
    expect(result.questions).toHaveLength(1)
    expect(result.dropped).toEqual([])
  })

  it("hai câu cùng chủ đề trong một lượt cũng là hỏi lặp", () => {
    const result = filterAskedQuestions(spineWith([]), [
      { question: "Giữ chỗ bao lâu?", options: [], topic_key: "slot_hold_minutes" },
      { question: "Thời gian giữ slot?", options: [], topic_key: "slot_hold" }
    ])
    expect(result.questions).toHaveLength(1)
    expect(result.dropped).toHaveLength(1)
  })

  it("quyết định đã bị thay thế không còn chặn câu hỏi", () => {
    const superseded = spineWith([decision({ superseded_by: "DC02" })])
    expect(activeDecisions(superseded).size).toBe(0)
    expect(filterAskedQuestions(superseded, [{ question: "Uptime?", options: [], topic_key: "uptime" }]).questions).toHaveLength(1)
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

  it("bỏ đuôi (Khuyến nghị)/(Recommended) - nhãn của thẻ hỏi, không phải giá trị đã chốt", () => {
    expect(decisionOps(spineWith([decision()]), "S-6.1", [{ topic_key: "uptime", question: "Uptime?", answer: "99% (Khuyến nghị)" }])).toEqual([])
    const ops = decisionOps(spineWith([]), "S-6.1", [{ topic_key: "uptime", question: "Uptime?", answer: "99.9% (Recommended)" }])
    expect(ops[0].value).toMatchObject({ answer: "99.9%" })
  })

  it("sổ đưa vào prompt chỉ gồm điều còn hiệu lực", () => {
    const spine = spineWith([decision(), decision({ id: "DC02", topic_key: "deposit_amount", answer: "50.000đ", superseded_by: "DC03" })])
    expect(ledgerForPrompt(spine)).toEqual([{ topic_key: "uptime", question: "Mức uptime mong muốn?", answer: "99%", step_id: "S-1.4" }])
  })
})

describe("sanitizeSuggestions (BUG-30)", () => {
  it("bỏ tên hệ thống có đuôi rỗng nghĩa", () => {
    expect(sanitizeSuggestions("system_name", [{ label: "Minh An Booking (Khuyến nghị)" }, { label: "Minh An Clinic Appointment System" }, { label: "CarePoint App" }])).toEqual([
      { label: "Minh An Booking (Khuyến nghị)" }
    ])
  })

  it("lọc hết thì giữ nguyên bản, và chủ đề khác không bị đụng", () => {
    expect(sanitizeSuggestions("system_name", [{ label: "Clinic System" }])).toEqual([{ label: "Clinic System" }])
    expect(sanitizeSuggestions("uptime", [{ label: "99%" }, { label: "99.9% System" }])).toEqual([{ label: "99%" }, { label: "99.9% System" }])
  })
})

describe("askableFields (FLF-232)", () => {
  const fields = ["project.vision", "project.system_name", "project.form_factor"]

  it("tên hệ thống chỉ được hỏi ở B-2.3; các field khác giữ nguyên ở mọi step", () => {
    expect(askableFields("B-0.1", fields)).toEqual(["project.vision", "project.form_factor"])
    expect(askableFields("B-1.1", fields)).toEqual(["project.vision", "project.form_factor"])
    expect(askableFields("S-2.2", fields)).toEqual(["project.vision", "project.form_factor"])
    expect(askableFields("B-2.3", fields)).toEqual(fields)
  })

  it("FLF-449: trường sổ sách (progress.*, steps.*, sections.*, flags.*) không bao giờ là câu để hỏi", () => {
    expect(askableFields("S-5.1", ["progress.credit_ack_required", "progress.screen_queue", "steps.x", "sections.y", "flags", "screens"])).toEqual(["screens"])
    expect(askableFields("B-2.3", ["progress.credit_ack_required", "project.system_name"])).toEqual(["project.system_name"])
  })
})

describe("P05 - câu đã chốt mà model đặt topic_key khác vẫn bị bỏ", () => {
  it("cùng nội dung (trùng từ ≥ 70%) ⇒ bỏ, kèm câu trả lời đã chốt; câu khác ý ⇒ giữ", () => {
    const spine = spineWith([decision({ topic_key: "school_size", question: "Trường khoảng bao nhiêu học sinh, bao nhiêu lớp?", answer: "800 học sinh, 30 lớp" })])
    const out = filterAskedQuestions(spine, [
      { topic_key: "student_count", question: "Trường khoảng bao nhiêu học sinh và bao nhiêu lớp?" },
      { topic_key: "grade_scale", question: "Điểm ghi theo thang 10 hay thang 4?" }
    ] as never)
    expect(out.dropped).toMatchObject([{ answer: "800 học sinh, 30 lớp" }])
    expect(out.questions.map((q) => q.topic_key)).toEqual(["grade_scale"])
  })
})

describe("FLF-472 (E) - hỏi lại bằng chữ khác nhưng lựa chọn trùng đáp án đã chốt", () => {
  const settled = spineWith([
    decision({ topic_key: "order_completion", question: "Đơn hoàn tất tính khi nào?", answer: "Người mua xác nhận đã nhận hàng" })
  ])
  const opt = (...labels: string[]) => labels.map((label) => ({ label }))

  it("khoá khác + câu diễn đạt khác nhưng có lựa chọn đúng đáp án đã chốt ⇒ bỏ", () => {
    const out = filterAskedQuestions(settled, [
      { topic_key: "transaction_success", question: "Khi nào coi là giao dịch thành công?", options: opt("Người mua xác nhận đã nhận hàng (Khuyến nghị)", "Sau 7 ngày kể từ lúc giao") }
    ] as never)
    expect(out.questions).toEqual([])
    expect(out.dropped).toMatchObject([{ answer: "Người mua xác nhận đã nhận hàng" }])
  })

  it("câu không liên quan dù có lựa chọn trùng đáp án ⇒ giữ", () => {
    const out = filterAskedQuestions(settled, [
      { topic_key: "refund_trigger", question: "Cửa hàng nhận thông báo bằng kênh nào?", options: opt("Người mua xác nhận đã nhận hàng", "Email") }
    ] as never)
    expect(out.questions.map((q) => q.topic_key)).toEqual(["refund_trigger"])
  })

  it("không có lựa chọn nào trùng đáp án đã chốt ⇒ giữ (khác nghĩa hoặc user đổi ý có kèm conflict)", () => {
    const out = filterAskedQuestions(settled, [
      { topic_key: "transaction_success", question: "Khi nào coi là giao dịch thành công?", options: opt("Ngay khi thanh toán", "Sau 7 ngày kể từ lúc giao") }
    ] as never)
    expect(out.questions).toHaveLength(1)
    const withConflict = filterAskedQuestions(settled, [
      { topic_key: "transaction_success", question: "Khi nào coi là giao dịch thành công?", conflict: "user vừa đổi ý", options: opt("Người mua xác nhận đã nhận hàng", "Sau 7 ngày") }
    ] as never)
    expect(withConflict.questions).toHaveLength(1)
  })

  it("đáp án ngắn (dưới 3 từ) cần trùng câu hỏi ≥ 0.35 - lựa chọn 'Có' trùng ngẫu nhiên không bị bỏ", () => {
    const shortDecided = spineWith([decision({ topic_key: "refund", question: "Có hoàn tiền không?", answer: "Có" })])
    const unrelated = filterAskedQuestions(shortDecided, [
      { topic_key: "invoice", question: "Khi nào xuất hoá đơn cho khách?", options: opt("Có", "Không") }
    ] as never)
    expect(unrelated.questions).toHaveLength(1)
    const related = filterAskedQuestions(shortDecided, [
      { topic_key: "refund_again", question: "Có hoàn tiền khi khách huỷ không?", options: opt("Có", "Không") }
    ] as never)
    expect(related.questions).toEqual([])
  })
})

describe("FLF-472 - ledgerForPrompt kèm câu hỏi gốc", () => {
  it("mỗi mục có question (rút gọn khi quá dài); quyết định cũ thiếu câu hỏi vẫn đọc được", () => {
    const long = "x".repeat(300)
    const out = ledgerForPrompt(spineWith([decision(), decision({ id: "DC02", topic_key: "roles", question: long, answer: "A" }), decision({ id: "DC03", topic_key: "old", question: "" })]))
    expect(out[0]).toMatchObject({ topic_key: "uptime", question: "Mức uptime mong muốn?", answer: "99%" })
    expect(out[1].question).toHaveLength(160)
    expect(out[2]).not.toHaveProperty("question")
  })
})

describe("FLF-472 (5b) - decisionOps cho đính chính", () => {
  it("đính chính thay quyết định cũ: dòng cũ superseded_by, dòng mới ghi lý do đính chính", () => {
    const spine = spineWith([decision({ topic_key: "external_partners", answer: "Chỉ VNPay và MoMo" })])
    const ops = decisionOps(spine, "B-1", [{ topic_key: "external_partners", question: "Đối tác ngoài?", answer: "GHN và GHTK cũng nối API", correction: true }])
    expect(ops[0]).toMatchObject({ op: "set", path: "decisions[id=DC01].superseded_by" })
    expect(ops[1]).toMatchObject({ op: "add", path: "decisions[]", reason: "Đính chính external_partners qua chat" })
  })
})
