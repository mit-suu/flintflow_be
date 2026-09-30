import { describe, expect, it } from "vitest"
import type { ChangeSummary } from "./pipeline.dto.js"
import { FALLBACK_INVITE, assumptionSentence, composePhaseGateMessage, composeStepGateMessage, gateActionText } from "./gate-message.js"

const row = (collection: string, kind: ChangeSummary["kind"] = "add"): ChangeSummary => ({ kind, collection, id: null, title_vi: "x", section_id: null })

/** Chữ nội bộ không được lộ trong tin nhắn cổng dựng tất định. */
const FORBIDDEN = /giả định|Brief|ghi nhận|giai đoạn|bước|Spine|\bB-\d|\bS-\d|web_app|anh\/chị/i

describe("composeStepGateMessage", () => {
  it("có notes ⇒ dùng nguyên văn (đã cắt khoảng trắng)", () => {
    expect(composeStepGateMessage({ notes: "  Tôi đoán bạn dùng web.  ", summary: [row("actors")] })).toBe("Tôi đoán bạn dùng web.")
  })

  it("thiếu notes ⇒ dựng từ summary bằng câu thường, kết bằng lời mời", () => {
    const message = composeStepGateMessage({ notes: null, summary: [row("use_cases"), row("use_cases"), row("actors", "update")] })!
    expect(message).toBe(`Tôi đã cập nhật 2 use case mới và actor. ${FALLBACK_INVITE}`)
    expect(message).not.toMatch(FORBIDDEN)
  })

  it("không kể giả định / sổ quyết định là nội dung, và không lộ chữ 'ghi chú Brief'", () => {
    const message = composeStepGateMessage({ notes: "", summary: [row("assumptions"), row("decisions"), row("addendum", "update")] })!
    expect(message).toContain("ghi chú")
    expect(message).not.toMatch(FORBIDDEN)
  })

  it("giả định mới được nói thành câu 'Tôi tạm hiểu là …' khi phải dựng tin", () => {
    const message = composeStepGateMessage({ summary: [row("project", "update")], newAssumptionTexts: ["Nhân viên dùng máy tính.", "Bệnh nhân dùng điện thoại"] })!
    expect(message).toContain("Tôi tạm hiểu là nhân viên dùng máy tính. Tôi cũng tạm hiểu là bệnh nhân dùng điện thoại.")
    expect(message).toContain("Nếu chỗ nào khác thì bạn nói tôi nhé.")
    expect(message).not.toMatch(FORBIDDEN)
  })

  it("có notes nhưng bỏ sót một điều tạm hiểu ⇒ nối câu nói điều đó (chip xác nhận đúng những gì được nói)", () => {
    const message = composeStepGateMessage({
      notes: "Tôi đoán nhân viên lễ tân dùng máy tính để nhận bệnh nhân",
      summary: [],
      newAssumptionTexts: ["Nhân viên lễ tân dùng máy tính để nhận bệnh nhân", "Bệnh nhân không cần cài app riêng"]
    })!
    expect(message.startsWith("Tôi đoán nhân viên lễ tân dùng máy tính để nhận bệnh nhân.")).toBe(true)
    expect(message).toContain("Tôi tạm hiểu là bệnh nhân không cần cài app riêng.")
    expect(message).not.toContain("Tôi cũng tạm hiểu")
    expect(message).not.toMatch(/giả định/i)
  })

  it("notes đã nói điều đó như điều đang đoán (diễn đạt lại vẫn trùng đủ từ) ⇒ dùng nguyên văn, không nói lặp", () => {
    const notes = "Tôi đoán bệnh nhân đặt lịch qua app điện thoại, còn nhân viên dùng máy tính. Bạn xem giúp nhé."
    expect(composeStepGateMessage({ notes, summary: [], newAssumptionTexts: ["Bệnh nhân đặt lịch qua app điện thoại"] })).toBe(notes)
  })

  it("notes kể điều đó như SỰ THẬT trong câu tóm tắt ⇒ vẫn thêm câu 'Tôi tạm hiểu…' riêng", () => {
    const notes =
      "Tổng quan dự án đã đủ: bệnh viện công cần phần mềm quản lý khám ngoại trú từ đặt lịch đến thanh toán bhyt, bệnh nhân tự đặt lịch và thanh toán trên app/web, còn nhân viên làm trên web. Tôi đoán sẽ có dịch vụ gửi SMS để gọi bệnh nhân chưa cài app — nếu khác bạn cứ nói. Xem lại các điểm này xong thì mình đi tiếp nhé."
    const as3 = "Bệnh nhân chủ yếu dùng app điện thoại để đặt lịch và thanh toán, còn các vai trò nhân viên làm trên web."
    const as8 = "Sẽ có dịch vụ gửi SMS (mua hoặc qua nhà cung cấp) để gửi thông báo cho bệnh nhân chưa cài app."
    const message = composePhaseGateMessage({ lastMessage: notes, unconfirmedTexts: [as3, as8] })!
    expect(message).toContain("Tôi tạm hiểu là bệnh nhân chủ yếu dùng app điện thoại để đặt lịch và thanh toán, còn các vai trò nhân viên làm trên web.")
    expect(message).not.toContain("tạm hiểu là sẽ có dịch vụ gửi SMS")
    expect(message.endsWith("Xem lại các điểm này xong thì mình đi tiếp nhé.")).toBe(true)
  })

  it("không có gì để nói (không notes, không thay đổi, không giả định) ⇒ undefined", () => {
    expect(composeStepGateMessage({ summary: [] })).toBeUndefined()
    expect(composeStepGateMessage({ notes: "   ", summary: [row("assumptions")] })).toBeUndefined()
  })

  it("chỉ có giả định, không thay đổi ⇒ chỉ câu tạm hiểu, không lời mời 'xem giúp'", () => {
    const message = composeStepGateMessage({ summary: [], newAssumptionTexts: ["Dùng trên web"] })!
    expect(message).toBe("Tôi tạm hiểu là dùng trên web. Nếu chỗ nào khác thì bạn nói tôi nhé.")
  })
})

describe("assumptionSentence", () => {
  it("nói MỌI điều, mỗi điều một câu ngắn, không cắt '(và N điều khác)'", () => {
    const sentence = assumptionSentence(["a.", "b", "c", "d", "e"])!
    expect(sentence).toBe("Tôi tạm hiểu là a. Tôi cũng tạm hiểu là b. Tôi cũng tạm hiểu là c. Tôi cũng tạm hiểu là d. Tôi cũng tạm hiểu là e. Nếu chỗ nào khác thì bạn nói tôi nhé.")
    expect(sentence).not.toMatch(/điều nhỏ khác|điều khác/)
  })

  it("rỗng ⇒ null", () => {
    expect(assumptionSentence([])).toBeNull()
    expect(assumptionSentence(["  ", "."])).toBeNull()
  })
})

describe("composePhaseGateMessage", () => {
  it("ghép tin bước cuối với điều còn tạm hiểu từ các bước trước", () => {
    expect(composePhaseGateMessage({ lastMessage: "Xong phần mục tiêu.", unconfirmedTexts: ["Bệnh nhân tự đặt lịch"] })).toBe(
      "Xong phần mục tiêu. Tôi tạm hiểu là bệnh nhân tự đặt lịch. Nếu chỗ nào khác thì bạn nói tôi nhé."
    )
  })

  it("điều đã được bước cuối nói (như điều đang đoán) trong lastMessage thì không nhắc lại", () => {
    const message = composePhaseGateMessage({ lastMessage: "Tôi đoán bệnh nhân tự đặt lịch qua app điện thoại nhé.", unconfirmedTexts: ["Bệnh nhân tự đặt lịch qua app điện thoại", "Không gửi SMS nhắc lịch"] })!
    expect(message.match(/tạm hiểu/g)).toHaveLength(1)
    expect(message).toContain("Tôi tạm hiểu là không gửi SMS nhắc lịch.")
  })

  it("nhiều điều từ nhiều bước im lặng ⇒ tất cả đều được nói", () => {
    const texts = ["a1 x", "b2 y", "c3 z", "d4 w", "e5 v", "f6 u"]
    const message = composePhaseGateMessage({ lastMessage: "Xong.", unconfirmedTexts: texts })!
    for (const t of texts) expect(message).toContain(t)
  })

  it("chỉ có một trong hai vẫn ra tin; không có cả hai ⇒ undefined", () => {
    expect(composePhaseGateMessage({ lastMessage: "Xong.", unconfirmedTexts: [] })).toBe("Xong.")
    expect(composePhaseGateMessage({ unconfirmedTexts: ["A"] })).toMatch(/^Tôi tạm hiểu là A\./)
    expect(composePhaseGateMessage({ unconfirmedTexts: [] })).toBeUndefined()
  })
})

describe("điều tạm hiểu đứng trước lời mời đi tiếp, không nói hai lần", () => {
  it("nối câu tạm hiểu TRƯỚC câu mời cuối của notes", () => {
    const message = composeStepGateMessage({
      notes: "Tôi thấy nhân viên dùng máy tính. Nếu ổn thì mình đi tiếp nhé.",
      summary: [],
      newAssumptionTexts: ["Bệnh nhân không cần cài app riêng"]
    })!
    expect(message).toBe("Tôi thấy nhân viên dùng máy tính. Tôi tạm hiểu là bệnh nhân không cần cài app riêng. Nếu ổn thì mình đi tiếp nhé.")
    expect(message.endsWith("đi tiếp nhé.")).toBe(true)
  })

  it("chữ giống dấu hiệu đoán khi bỏ dấu ('tới lấy', 'đến tới đoạn') không tính là đã nói", () => {
    const notes = "Bệnh nhân tới lấy số ở quầy rồi đến tới đoạn khám. Bạn xem giúp nhé."
    const message = composeStepGateMessage({ notes, summary: [], newAssumptionTexts: ["Bệnh nhân tới lấy số ở quầy rồi đến khám"] })!
    expect(message).toContain("Tôi tạm hiểu là bệnh nhân tới lấy số ở quầy rồi đến khám.")
  })

  it("notes diễn đạt lại (bỏ dấu, đổi từ nối) vẫn tính là đã nói", () => {
    const notes = "Toi doan ca web va app dien thoai la hai kenh song song. Neu khac ban cu noi."
    expect(composeStepGateMessage({ notes, summary: [], newAssumptionTexts: ["Cả web và app điện thoại như hai kênh song song"] })).toBe(notes)
  })

  it("cổng cuối giai đoạn cũng chèn trước lời mời cuối của bước cuối", () => {
    const message = composePhaseGateMessage({ lastMessage: "Xong phần rủi ro rồi. Bạn ổn thì mình đi tiếp nhé.", unconfirmedTexts: ["Kênh báo là app và SMS"] })!
    expect(message).toBe("Xong phần rủi ro rồi. Tôi tạm hiểu là kênh báo là app và SMS. Bạn ổn thì mình đi tiếp nhé.")
  })

  it("giữ nguyên từ viết tắt ở đầu câu", () => {
    expect(assumptionSentence(["SMS gửi qua nhà mạng"])).toMatch(/^Tôi tạm hiểu là SMS gửi/)
  })
})

describe("gateActionText", () => {
  it("chỉ lưu chữ của user, không tiền tố", () => {
    expect(gateActionText({ action: "accept" })).toBe("Đúng rồi, đi tiếp")
    expect(gateActionText({ action: "revision", note: "  à không, cả web và app " })).toBe("à không, cả web và app")
    expect(gateActionText({ action: "accept_as_is", note: "" })).toBe("Đúng rồi, đi tiếp")
    expect(gateActionText({ action: "accept_as_is", note: "cứ vậy đi" })).toBe("cứ vậy đi")
    expect(gateActionText({ action: "regenerate" })).not.toMatch(/bước/)
  })
})
