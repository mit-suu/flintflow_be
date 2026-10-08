import { describe, expect, it } from "vitest"
import type { ChangeSummary } from "./pipeline.dto.js"
import {
  FALLBACK_INVITE,
  assumptionSentence,
  composePhaseGateMessage,
  composeStepGateMessage,
  gateActionText,
  gateAssumptionIdsOfRun,
  gateMessageOfRun,
  spokenAssumptionIds,
  stripModelCountSentences
} from "./gate-message.js"

const row = (collection: string, kind: ChangeSummary["kind"] = "add"): ChangeSummary => ({ kind, collection, id: null, title_vi: "x", section_id: null })

/** Chữ nội bộ không được lộ trong tin nhắn cổng dựng tất định. */
const FORBIDDEN = /giả định|Brief|ghi nhận|giai đoạn|bước|Spine|\bB-\d|\bS-\d|web_app|anh\/chị/i

const as = (id: string, text: string): { id: string; text: string } => ({ id, text })

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

  it("đường dự phòng (không notes): giả định mới được nói thành câu 'Tôi tạm hiểu là …'", () => {
    const message = composeStepGateMessage({ summary: [row("project", "update")], newAssumptionTexts: ["Nhân viên dùng máy tính.", "Bệnh nhân dùng điện thoại"] })!
    expect(message).toContain("Tôi tạm hiểu là nhân viên dùng máy tính. Tôi cũng tạm hiểu là bệnh nhân dùng điện thoại.")
    expect(message).toContain("Nếu chỗ nào khác thì bạn nói tôi nhé.")
    expect(message).not.toMatch(FORBIDDEN)
  })

  it("có notes nhưng bỏ sót một điều tạm hiểu ⇒ KHÔNG chèn câu; điều đó rơi khỏi tập được xác nhận", () => {
    const notes = "Tôi đoán nhân viên lễ tân dùng máy tính để nhận bệnh nhân"
    const message = composeStepGateMessage({
      notes,
      summary: [],
      newAssumptionTexts: ["Nhân viên lễ tân dùng máy tính để nhận bệnh nhân", "Bệnh nhân không cần cài app riêng"]
    })!
    expect(message).toBe(notes)
    expect(message).not.toContain("tạm hiểu")
    const spoken = spokenAssumptionIds(message, [as("AS1", "Nhân viên lễ tân dùng máy tính để nhận bệnh nhân"), as("AS2", "Bệnh nhân không cần cài app riêng")])
    expect([...spoken]).toEqual(["AS1"])
  })

  it("notes diễn đạt lại điều đó như điều đang đoán ⇒ dùng nguyên văn, điều đó được xác nhận", () => {
    const notes = "Tôi đoán bệnh nhân đặt lịch qua app điện thoại, còn nhân viên dùng máy tính. Bạn xem giúp nhé."
    expect(composeStepGateMessage({ notes, summary: [], newAssumptionTexts: ["Bệnh nhân đặt lịch qua app điện thoại"] })).toBe(notes)
    expect([...spokenAssumptionIds(notes, [as("AS1", "Bệnh nhân đặt lịch qua app điện thoại")])]).toEqual(["AS1"])
  })

  it("notes kể điều đó như SỰ THẬT trong câu tóm tắt ⇒ chưa tính là đã nói (user không biết đó là điều cần xác nhận)", () => {
    const notes =
      "Tổng quan dự án đã đủ: bệnh viện công cần phần mềm quản lý khám ngoại trú từ đặt lịch đến thanh toán bhyt, bệnh nhân tự đặt lịch và thanh toán trên app/web, còn nhân viên làm trên web. Tôi đoán sẽ có dịch vụ gửi SMS để gọi bệnh nhân chưa cài app — nếu khác bạn cứ nói. Xem lại các điểm này xong thì mình đi tiếp nhé."
    const asFact = "Bệnh nhân chủ yếu dùng app điện thoại để đặt lịch và thanh toán, còn các vai trò nhân viên làm trên web."
    const asHedged = "Sẽ có dịch vụ gửi SMS để gọi bệnh nhân chưa cài app."
    expect([...spokenAssumptionIds(notes, [as("AS3", asFact), as("AS8", asHedged)])]).toEqual(["AS8"])
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

describe("tin cổng nói một lần (FLF-241)", () => {
  // Tin cổng thật của B-0.1, project 6abeb75e5d7e3382e3ceeb19 — 4 câu, câu 3 do server chèn và trùng ý câu 2.
  const notesB01 =
    "Vậy là phần mềm khám ngoại trú cho bệnh viện tỉnh, chạy trên cả web và ứng dụng di động. Tôi đoán hệ thống chỉ phục vụ một bệnh viện, không phải nhiều cơ sở — nếu khác bạn cứ nói nhé. Đúng vậy thì mình đi tiếp."
  const statementB01 = "Hệ thống phục vụ một bệnh viện đa khoa tuyến tỉnh; không bao gồm triển khai liên bệnh viện hoặc nhiều cơ sở"

  it("tin giữ đúng 3 câu của model, không có câu 'Tôi tạm hiểu là …' do server chèn", () => {
    const message = composeStepGateMessage({ notes: notesB01, summary: [], newAssumptionTexts: [statementB01] })!
    expect(message).toBe(notesB01)
    expect(message).not.toContain("Tôi tạm hiểu là")
    expect(message.endsWith("Đúng vậy thì mình đi tiếp.")).toBe(true)
  })

  /**
   * Fixture đo thật, KHÔNG phải mục tiêu: câu đoán của model và câu giả định của chính nó chỉ trùng 8/14 từ nội dung
   * (`overlapRatio` = 0.571), dưới ngưỡng 0.75 ⇒ coi là CHƯA nói. Đo rộng trên 21 giả định của run-1/2/3 cho 0/21, vì
   * `notes` của model hiện không chứa câu đoán cho giả định nó tạo — việc kéo tỉ lệ này lên thuộc luật prompt của
   * `draft-to-ops` (model phải nói ra giả định nó tạo), không được hạ ngưỡng ở đây: sai lệch phải nghiêng về chặt, vì
   * điều rơi lại chỉ `unconfirmed` (S-9.1 gom, cờ đỏ chặn ký baseline) còn xác nhận sai thì user chưa đọc đã bị ghi.
   */
  it("câu đoán trùng dưới ngưỡng ⇒ chưa tính là đã nói, giả định ở lại ngoài tập được xác nhận", () => {
    expect([...spokenAssumptionIds(notesB01, [as("AS1", statementB01)])]).toEqual([])
  })

  /**
   * Phép đo phải theo chiều PHỦ: mẫu số là điều tạm hiểu, không phải câu ngắn hơn. Câu đoán là tập con của điều đó
   * (`overlapRatio` cho 1.0) nhưng bỏ mất chính phần user cần xác nhận ⇒ chưa nói. Nếu tính là đã nói thì chip "Đúng rồi"
   * ghi `confirmed` cho cam kết lưu 10 năm / ràng buộc chỉ tiền mặt mà tin chưa bao giờ nhắc.
   */
  it("câu đoán chỉ nói MỘT PHẦN điều tạm hiểu ⇒ chưa tính là đã nói", () => {
    const partial: [string, string][] = [
      ["Tôi đoán hồ sơ khám được lưu theo quy định.", "Hồ sơ khám lưu tối thiểu 10 năm theo quy định."],
      ["Tôi tạm hiểu là bệnh nhân thanh toán khi tới khám.", "Bệnh nhân thanh toán khi tới khám, chỉ tiền mặt tại quầy."],
      [
        "Tôi tạm hiểu là bệnh nhân tự đặt lịch qua app điện thoại.",
        "Bệnh nhân tự đặt lịch qua app điện thoại, lễ tân đặt hộ trên web và thu tiền tại quầy."
      ]
    ]
    for (const [notes, statement] of partial) expect([...spokenAssumptionIds(notes, [as("AS1", statement)])], statement).toEqual([])
  })

  it("câu đoán nói đủ nội dung, thêm chi tiết ⇒ vẫn tính là đã nói", () => {
    const notes = "Tôi đoán hồ sơ khám lưu tối thiểu 10 năm theo quy định của Bộ Y tế."
    expect([...spokenAssumptionIds(notes, [as("AS1", "Hồ sơ khám lưu tối thiểu 10 năm theo quy định.")])]).toEqual(["AS1"])
  })

  it("hai câu trùng gần hết từ nhưng TRÁI CHIỀU phủ định ⇒ không tính là đã nói", () => {
    const notes = "Tôi đoán hệ thống chỉ phục vụ một bệnh viện tuyến tỉnh, một cơ sở duy nhất."
    const statement = "Hệ thống không phục vụ một bệnh viện tuyến tỉnh, một cơ sở duy nhất"
    expect([...spokenAssumptionIds(notes, [as("AS1", statement)])]).toEqual([])
  })

  it("nguyên văn nằm trong câu đoán nhưng câu phủ định nó ở phía sau ⇒ không tính là đã nói (cả điều ngắn lẫn điều dài)", () => {
    expect([...spokenAssumptionIds("Tôi tạm hiểu là có thanh toán online là chưa cần ở bản đầu.", [as("AS1", "Có thanh toán online.")])]).toEqual([])
    const long = "Bệnh nhân đặt lịch khám qua ứng dụng điện thoại"
    expect([...spokenAssumptionIds(`Tôi đoán ${long.toLowerCase()} là không cần thiết.`, [as("AS1", long)])]).toEqual([])
    // Đối chứng: cùng câu nhưng khẳng định ⇒ vẫn là đã nói
    expect([...spokenAssumptionIds("Tôi tạm hiểu là có thanh toán online.", [as("AS1", "Có thanh toán online.")])]).toEqual(["AS1"])
    expect([...spokenAssumptionIds(`Tôi đoán ${long.toLowerCase()}.`, [as("AS1", long)])]).toEqual(["AS1"])
  })

  it("câu không mang dấu hiệu đoán ⇒ không tính là đã nói, dù trùng nguyên văn", () => {
    const notes = "Bệnh nhân đặt lịch qua app điện thoại, còn nhân viên dùng máy tính."
    expect([...spokenAssumptionIds(notes, [as("AS1", "Bệnh nhân đặt lịch qua app điện thoại")])]).toEqual([])
  })

  it("chữ giống dấu hiệu đoán khi bỏ dấu ('tới lấy', 'tới đoạn') không tính là đã nói", () => {
    const notes = "Bệnh nhân tới lấy số ở quầy rồi đến tới đoạn khám. Bạn xem giúp nhé."
    expect([...spokenAssumptionIds(notes, [as("AS1", "Bệnh nhân tới lấy số ở quầy rồi đến khám")])]).toEqual([])
  })

  it("notes diễn đạt lại bằng chữ không dấu vẫn tính là đã nói", () => {
    const notes = "Toi doan ca web va app dien thoai la hai kenh song song. Neu khac ban cu noi."
    expect([...spokenAssumptionIds(notes, [as("AS1", "Cả web và app điện thoại như hai kênh song song")])]).toEqual(["AS1"])
  })

  it("điều quá ngắn (dưới ngưỡng từ nội dung) chỉ tính khi câu đoán chứa nguyên văn nó", () => {
    expect([...spokenAssumptionIds("Tôi đoán quầy thu ngân có 2-3 quầy.", [as("AS1", "Quầy thu ngân có 2-3 quầy")])]).toEqual(["AS1"])
    expect([...spokenAssumptionIds("Tôi đoán quầy thu ngân đủ dùng.", [as("AS1", "Quầy thu ngân có 2-3 quầy")])]).toEqual([])
  })

  it("tin rỗng hoặc điều không có từ nội dung ⇒ không xác nhận gì", () => {
    expect([...spokenAssumptionIds(undefined, [as("AS1", "Dùng trên web")])]).toEqual([])
    expect([...spokenAssumptionIds("Tôi đoán vậy.", [as("AS1", "   ")])]).toEqual([])
  })

  it("dùng text_vi khi có, vì tin cổng viết bằng ngôn ngữ user", () => {
    const notes = "Tôi đoán bệnh nhân tự đặt lịch qua app điện thoại nhé."
    const spoken = spokenAssumptionIds(notes, [{ id: "AS1", text: "Patients book appointments on the mobile app", text_vi: "Bệnh nhân tự đặt lịch qua app điện thoại" }])
    expect([...spoken]).toEqual(["AS1"])
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

  it("giữ nguyên từ viết tắt ở đầu câu", () => {
    expect(assumptionSentence(["SMS gửi qua nhà mạng"])).toMatch(/^Tôi tạm hiểu là SMS gửi/)
  })

  it("statement đã tự mang chủ ngữ hoặc dấu hiệu đoán ⇒ không bọc tiền tố, không ra câu hai chủ ngữ", () => {
    expect(assumptionSentence(["Tôi suy ra SMS là kênh dự phòng cho bệnh nhân chưa cài app"])).toBe(
      "Tôi suy ra SMS là kênh dự phòng cho bệnh nhân chưa cài app. Nếu chỗ nào khác thì bạn nói tôi nhé."
    )
    expect(assumptionSentence(["Tôi tạm hiểu là hồ sơ lưu 10 năm"])).toBe("Tôi tạm hiểu là hồ sơ lưu 10 năm. Nếu chỗ nào khác thì bạn nói tôi nhé.")
    expect(assumptionSentence(["Tôi suy ra A", "Hồ sơ lưu 10 năm"])).toBe("Tôi suy ra A. Tôi cũng tạm hiểu là hồ sơ lưu 10 năm. Nếu chỗ nào khác thì bạn nói tôi nhé.")
  })
})

describe("composePhaseGateMessage", () => {
  const COUNT = (n: number): string => `Còn ${n} điều tôi tạm hiểu nữa, mình rà ở phần tổng kết.`

  it("còn điều chưa nói ⇒ đúng MỘT câu đếm, không liệt kê từng điều", () => {
    const message = composePhaseGateMessage({ lastMessage: "Xong phần mục tiêu.", unspokenCount: 1 })!
    expect(message).toBe(`Xong phần mục tiêu. ${COUNT(1)}`)
    expect(message).not.toMatch(FORBIDDEN)
  })

  it("một câu đếm bất kể N lớn bao nhiêu — không còn 8 câu nối nhau", () => {
    const message = composePhaseGateMessage({ lastMessage: "Xong.", unspokenCount: 8 })!
    expect(message).toBe(`Xong. ${COUNT(8)}`)
    expect(message.match(/tạm hiểu/g)).toHaveLength(1)
  })

  it("câu đếm đứng TRƯỚC lời mời đi tiếp của bước cuối", () => {
    const message = composePhaseGateMessage({ lastMessage: "Xong phần rủi ro rồi. Bạn ổn thì mình đi tiếp nhé.", unspokenCount: 2 })!
    expect(message).toBe(`Xong phần rủi ro rồi. ${COUNT(2)} Bạn ổn thì mình đi tiếp nhé.`)
    expect(message.endsWith("đi tiếp nhé.")).toBe(true)
  })

  it("không còn điều nào chưa nói ⇒ tin của bước cuối nguyên văn", () => {
    expect(composePhaseGateMessage({ lastMessage: "Xong.", unspokenCount: 0 })).toBe("Xong.")
  })

  it("chỉ có một trong hai vẫn ra tin; không có cả hai ⇒ undefined", () => {
    expect(composePhaseGateMessage({ unspokenCount: 3 })).toBe(COUNT(3))
    expect(composePhaseGateMessage({ unspokenCount: 0 })).toBeUndefined()
  })

  /**
   * Chuỗi thật của cổng B-1.6, project 6abed2d5697c47469d6fbb40 (01/10 21:44): model tự viết câu đếm "Còn 6 điều…" trong
   * `notes` (số nó đoán) rồi server thêm câu đếm thật "Còn 4 điều…" ⇒ tin hiện ra hai câu đếm đá nhau. Chỉ server được
   * đếm; câu của model bị bỏ, không cộng thêm.
   */
  it("model tự viết câu đếm ⇒ bỏ câu đó, giữ đúng một câu đếm với số của Spine", () => {
    const notes =
      "Phần định nghĩa dự án đã đủ: bài toán xếp hàng và nhập BHYT tay, ba vai chính, phạm vi bản đầu và cách đo thành công. Còn 6 điều tôi tạm hiểu nữa, mình rà ở phần tổng kết. Bạn xem qua, ổn thì mình chốt phần định nghĩa dự án nhé."
    const message = composePhaseGateMessage({ lastMessage: notes, unspokenCount: 4 })!
    expect(message.match(/Còn \d+ điều tôi tạm hiểu/g)).toHaveLength(1)
    expect(message).toContain(COUNT(4))
    expect(message).not.toContain("Còn 6")
    // Lời mời của model vẫn là câu cuối: "xem qua / chốt phần" cũng là lời mời, không chỉ "đi tiếp"
    expect(message.endsWith("Bạn xem qua, ổn thì mình chốt phần định nghĩa dự án nhé.")).toBe(true)
  })

  it("model viết câu đếm nhưng không còn điều nào chưa nói ⇒ câu đó vẫn bị bỏ, tin không có câu đếm", () => {
    const notes = "Xong phần rủi ro. Còn ba điều tôi tạm hiểu nữa, mình rà ở phần tổng kết. Bạn xem lại giúp nhé."
    const message = composePhaseGateMessage({ lastMessage: notes, unspokenCount: 0 })!
    expect(message).toBe("Xong phần rủi ro. Bạn xem lại giúp nhé.")
  })

  it("câu đếm của model gõ không dấu / có từ đệm mở đầu vẫn bị lọc", () => {
    for (const notes of [
      "Xong phần rủi ro. Con 3 dieu toi tam hieu nua, minh ra o phan tong ket. Bạn xem qua nhé.",
      "Xong phần rủi ro. Vẫn còn 3 điều tôi tạm hiểu, mình rà sau. Bạn xem qua nhé."
    ]) {
      const message = composePhaseGateMessage({ lastMessage: notes, unspokenCount: 2 })!
      expect(message.match(/con \d+ dieu/gi), notes).toBeNull()
      expect(message, notes).toContain(COUNT(2))
      expect(message.endsWith("Bạn xem qua nhé."), notes).toBe(true)
    }
  })

  /**
   * Nếu đo "tin đã nói những điều nào" TRƯỚC khi bỏ câu đếm của model, điều chỉ được nhắc trong câu đó bị tính là đã nói,
   * rồi câu đó biến mất khỏi tin ⇒ `new_assumptions` chứa id tin cuối cùng không hề nói. Đo phải chạy sau khi lọc.
   */
  it("điều chỉ được nhắc trong câu đếm của model ⇒ không tính là đã nói", () => {
    const notes =
      "Tôi đã dựng xong phần mục tiêu. Còn 3 điều tôi tạm hiểu là bệnh nhân tự đặt lịch qua app điện thoại, lễ tân đặt hộ trên web và thu tiền tại quầy. Bạn xem qua, ổn thì mình đi tiếp nhé."
    const cleaned = stripModelCountSentences(notes)
    expect(cleaned).not.toContain("Còn 3 điều")
    expect([...spokenAssumptionIds(cleaned, [as("AS1", "Bệnh nhân tự đặt lịch qua app điện thoại.")])]).toEqual([])
  })

  it("notes chỉ có một câu và nó là lời mời ⇒ câu đếm vẫn đứng trước lời mời", () => {
    const message = composePhaseGateMessage({ lastMessage: "Bạn xem qua, ổn thì mình đi tiếp nhé.", unspokenCount: 2 })!
    expect(message).toBe(`${COUNT(2)} Bạn xem qua, ổn thì mình đi tiếp nhé.`)
  })

  it("câu đếm không tự biến thành điều 'đã nói' (không trùng ý giả định nào)", () => {
    const message = composePhaseGateMessage({ lastMessage: "Xong.", unspokenCount: 3 })!
    expect([...spokenAssumptionIds(message, [as("AS1", "Hồ sơ khám và dữ liệu bệnh nhân lưu tối thiểu 10 năm")])]).toEqual([])
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

describe("gateMessageOfRun", () => {
  it("lấy tin cổng của bước lẻ", () => {
    expect(gateMessageOfRun({ gate_payload: { message_vi: "Tôi đã ghi ba nhóm người dùng." } })).toBe("Tôi đã ghi ba nhóm người dùng.")
  })

  it("bước cuối giai đoạn ưu tiên tin cả giai đoạn — đúng tin user đọc trên thẻ", () => {
    const run = { gate_payload: { message_vi: "tin của bước" }, phase_gate: { message_vi: "tin của cả giai đoạn" } }
    expect(gateMessageOfRun(run)).toBe("tin của cả giai đoạn")
  })

  it("không có tin thì không ghi gì — tin rỗng hay thiếu đều là null", () => {
    expect(gateMessageOfRun(null)).toBeNull()
    expect(gateMessageOfRun({})).toBeNull()
    expect(gateMessageOfRun({ gate_payload: null, phase_gate: null })).toBeNull()
    expect(gateMessageOfRun({ gate_payload: { message_vi: "   " } })).toBeNull()
    expect(gateMessageOfRun({ gate_payload: { message_vi: 42 } })).toBeNull()
  })

  it("phase_gate không có tin ⇒ rơi về tin của bước, không trả null", () => {
    expect(gateMessageOfRun({ gate_payload: { message_vi: "tin của bước" }, phase_gate: {} })).toBe("tin của bước")
  })
})

describe("gateAssumptionIdsOfRun", () => {
  const brief = (id: string) => ({ id, text: id })

  it("cổng bước: lấy id trong new_assumptions của gate_payload", () => {
    expect([...gateAssumptionIdsOfRun({ gate_payload: { new_assumptions: [brief("AS1"), brief("AS3")] } })]).toEqual(["AS1", "AS3"])
  })

  it("bước cuối giai đoạn ưu tiên danh sách của cổng giai đoạn — đúng thẻ user đang đọc", () => {
    const run = { gate_payload: { new_assumptions: [brief("AS1")] }, phase_gate: { new_assumptions: [brief("AS2"), brief("AS9")] } }
    expect([...gateAssumptionIdsOfRun(run)]).toEqual(["AS2", "AS9"])
  })

  it("cổng giai đoạn nói danh sách rỗng là nói rỗng, không rơi về cổng bước", () => {
    const run = { gate_payload: { new_assumptions: [brief("AS1")] }, phase_gate: { new_assumptions: [] } }
    expect([...gateAssumptionIdsOfRun(run)]).toEqual([])
  })

  it("không có lượt chạy / không có payload / danh sách sai hình ⇒ tập rỗng, không điều nào chốt được", () => {
    expect([...gateAssumptionIdsOfRun(null)]).toEqual([])
    expect([...gateAssumptionIdsOfRun({})]).toEqual([])
    expect([...gateAssumptionIdsOfRun({ gate_payload: null, phase_gate: null })]).toEqual([])
    expect([...gateAssumptionIdsOfRun({ gate_payload: {} })]).toEqual([])
    expect([...gateAssumptionIdsOfRun({ gate_payload: { new_assumptions: "AS1" } })]).toEqual([])
  })

  it("phần tử thiếu id hoặc id không phải chuỗi bị bỏ, phần còn lại vẫn tính", () => {
    const run = { gate_payload: { new_assumptions: [brief("AS1"), { text: "không có id" }, { id: 7 }, null] } }
    expect([...gateAssumptionIdsOfRun(run)]).toEqual(["AS1"])
  })
})

/**
 * FLF-260: phiên tiếng Anh có `notes` tiếng Anh. Dò sót lời đoán tiếng Anh thì `new_assumptions` rỗng, không điều nào được
 * xác nhận và cờ đỏ `unconfirmed_assumption` chặn ký baseline.
 */
describe("FLF-260: tin cổng tiếng Anh", () => {
  /** Chữ nội bộ không được lộ trong tin dựng tất định tiếng Anh. */
  const FORBIDDEN_EN = /assumption|brief|phase|\bstep|spine|\bB-\d|\bS-\d|web_app/i
  const COUNT_EN = (n: number): string =>
    n === 1 ? "There's 1 more thing I'm assuming; we'll go over it in the summary." : `There are ${n} more things I'm assuming; we'll go over them in the summary.`
  const INVITE_EN = "Have a look, and if it all looks right we'll move on."

  describe("dò lời đoán tiếng Anh", () => {
    it("câu đoán kèm đuôi 'tell me if not' ⇒ tính là đã nói, kể cả khi điều đó có dấu chấm cuối", () => {
      const notes = "I'm assuming staff use desktop computers — tell me if not."
      expect([...spokenAssumptionIds(notes, [as("AS1", "Staff use desktop computers")])]).toEqual(["AS1"])
      expect([...spokenAssumptionIds(notes, [as("AS1", "Staff use desktop computers.")])]).toEqual(["AS1"])
    })

    it("mọi dấu hiệu đoán tiếng Anh đều nhận; nháy cong như nháy thẳng", () => {
      const statement = "Staff use desktop computers at the front desk"
      for (const notes of [
        "I assume staff use desktop computers at the front desk.",
        "I’m guessing staff use desktop computers at the front desk.",
        "I suppose staff use desktop computers at the front desk.",
        "I presume staff use desktop computers at the front desk.",
        "I've assumed staff use desktop computers at the front desk.",
        "My guess is that staff use desktop computers at the front desk.",
        "Staff probably use desktop computers at the front desk.",
        "Staff use desktop computers at the front desk; if that's wrong, say so.",
        "Staff use desktop computers at the front desk — let me know if anything is off.",
        "Correct me if I'm wrong, but staff use desktop computers at the front desk."
      ])
        expect([...spokenAssumptionIds(notes, [as("AS1", statement)])], notes).toEqual(["AS1"])
    })

    it("diễn lại + đuôi 'tell me if not': chữ 'not' của lời mời không đảo chiều phủ định của nội dung", () => {
      const notes = "I'm assuming reception staff check patients in on desktop computers — tell me if not."
      expect([...spokenAssumptionIds(notes, [as("AS1", "Reception staff use desktop computers to check patients in.")])]).toEqual(["AS1"])
      // Chiều ngược lại: câu khẳng định không được khớp điều PHỦ ĐỊNH nhờ chữ "not" của lời mời
      const affirmative = "I'm assuming patients need to install an app to book — tell me if not."
      expect([...spokenAssumptionIds(affirmative, [as("AS2", "Patients do not need to install an app to book")])]).toEqual([])
    })

    it("phủ định viết gọn ('don't', 'cannot') vẫn được tính chiều phủ định", () => {
      const statement = "Patients need to install an app to book appointments"
      expect([...spokenAssumptionIds("I'm assuming patients don't need to install an app to book appointments.", [as("AS1", statement)])]).toEqual([])
      expect([...spokenAssumptionIds("I'm assuming patients cannot install an app to book appointments.", [as("AS1", "Patients can install an app to book appointments")])]).toEqual([])
      // Cùng chiều phủ định, một bên viết gọn một bên viết đủ, kèm đuôi "tell me if not" ⇒ vẫn là đã nói
      const notes = "I'm assuming patients don't need to install an app to book appointments — tell me if not."
      expect([...spokenAssumptionIds(notes, [as("AS2", "Patients do not need to install an app to book appointments.")])]).toEqual(["AS2"])
    })

    it("so nguyên văn theo cụm trọn từ: bỏ dấu chấm cuối không làm 'web' khớp vào giữa 'website'", () => {
      expect([...spokenAssumptionIds("I'm assuming patients book on the website.", [as("AS1", "Web.")])]).toEqual([])
      expect([...spokenAssumptionIds("I'm assuming patients book on the web — tell me if not.", [as("AS1", "On the web.")])]).toEqual(["AS1"])
      expect([...spokenAssumptionIds("Tôi đoán bạn dùng trên website.", [as("AS1", "Dùng trên web")])]).toEqual([])
    })

    it("câu kể như sự thật, 'I'm supposed to', hoặc chỉ nói MỘT PHẦN điều tạm hiểu ⇒ chưa nói", () => {
      expect([...spokenAssumptionIds("Patients book appointments on the mobile app, while staff work on the web.", [as("AS1", "Patients book appointments on the mobile app")])]).toEqual([])
      expect([...spokenAssumptionIds("I'm supposed to note that staff use desktop computers.", [as("AS1", "Staff use desktop computers")])]).toEqual([])
      expect([...spokenAssumptionIds("I'm assuming records are kept as the law requires.", [as("AS1", "Records are kept for at least 10 years as the law requires.")])]).toEqual([])
    })
  })

  describe("câu đếm tiếng Anh", () => {
    it("câu đếm model tự viết bị bỏ; giữ đúng một câu đếm của server, đứng trước lời mời cuối", () => {
      const notes = "Risks are covered. There are 6 more things I'm assuming, which we'll review later. Take a look and we'll continue."
      expect(composePhaseGateMessage({ lastMessage: notes, unspokenCount: 4, language: "en" })).toBe(
        `Risks are covered. ${COUNT_EN(4)} Take a look and we'll continue.`
      )
    })

    it("các kiểu câu đếm tiếng Anh khác cũng bị lọc; câu thường có số thì giữ", () => {
      for (const sentence of [
        "3 more assumptions will come up in the summary.",
        "I'm also assuming 5 more things we'll check at the end.",
        "There are two other things I've assumed; we'll go through them later.",
        "Four assumptions left for the summary.",
        "There’s one more thing I’m assuming; we’ll go over it in the summary.",
        COUNT_EN(3)
      ])
        expect(stripModelCountSentences(`Risks are covered. ${sentence} Take a look.`), sentence).toBe("Risks are covered. Take a look.")
      expect(stripModelCountSentences("I added two more use cases. Take a look.")).toBe("I added two more use cases. Take a look.")
    })

    it("điều chỉ được nhắc trong câu đếm tiếng Anh của model ⇒ không tính là đã nói", () => {
      const notes = "The goals are in place. There are 3 more things I'm assuming: patients book through the mobile app and pay at the counter. Have a look."
      const cleaned = stripModelCountSentences(notes)
      expect(cleaned).toBe("The goals are in place. Have a look.")
      expect([...spokenAssumptionIds(cleaned, [as("AS1", "Patients book through the mobile app and pay at the counter")])]).toEqual([])
    })

    it("câu đếm chia số ít/nhiều; không có lời mời cuối thì nối sau; câu đếm không tự thành điều 'đã nói'", () => {
      expect(composePhaseGateMessage({ lastMessage: "Done with the goals.", unspokenCount: 1, language: "en" })).toBe(`Done with the goals. ${COUNT_EN(1)}`)
      expect(composePhaseGateMessage({ lastMessage: "Risks are covered. Patients pay at the counter.", unspokenCount: 2, language: "en" })).toBe(
        `Risks are covered. Patients pay at the counter. ${COUNT_EN(2)}`
      )
      expect(composePhaseGateMessage({ unspokenCount: 2, language: "en" })).toBe(COUNT_EN(2))
      const message = composePhaseGateMessage({ lastMessage: "Done.", unspokenCount: 3, language: "en" })!
      expect([...spokenAssumptionIds(message, [as("AS1", "Records and patient data are kept for at least 10 years")])]).toEqual([])
      expect(message).not.toMatch(FORBIDDEN_EN)
    })

    it("lời mời tiếng Anh thường gặp đều được nhận là lời mời cuối", () => {
      for (const invite of [
        "If this looks right, we'll move on.",
        "Let me know if anything is off.",
        "Have a look, and we'll go ahead.",
        "If you agree, we'll lock this in.",
        "Please review it and we'll continue.",
        "Tell me what you think."
      ]) {
        const message = composePhaseGateMessage({ lastMessage: `Risks are covered. ${invite}`, unspokenCount: 2, language: "en" })
        expect(message, invite).toBe(`Risks are covered. ${COUNT_EN(2)} ${invite}`)
      }
    })
  })

  describe("đường dự phòng tiếng Anh (không notes)", () => {
    it("có notes ⇒ vẫn dùng nguyên văn, bất kể language", () => {
      expect(composeStepGateMessage({ notes: "  I'm guessing you use the web.  ", summary: [row("actors")], language: "en" })).toBe("I'm guessing you use the web.")
    })

    it("tóm tắt chia số ít/nhiều, nối bằng 'and', kết bằng lời mời tiếng Anh", () => {
      expect(composeStepGateMessage({ summary: [row("use_cases"), row("use_cases"), row("actors", "update")], language: "en" })).toBe(
        `I've updated 2 new use cases and 1 actor. ${INVITE_EN}`
      )
      expect(composeStepGateMessage({ summary: [row("screens", "update"), row("screens"), row("glossary")], language: "en" })).toBe(
        `I've updated 2 screens and 1 new glossary term. ${INVITE_EN}`
      )
      expect(composeStepGateMessage({ summary: [row("project", "update"), row("project", "update")], language: "en" })).toBe(
        `I've updated the system overview. ${INVITE_EN}`
      )
    })

    it("quá 4 nhóm ⇒ phần còn lại gộp vào danh sách; giả định / sổ quyết định không được kể; không lộ chữ nội bộ", () => {
      const summary = ["use_cases", "actors", "screens", "roles", "functions", "nfrs", "assumptions", "decisions"].map((c) => row(c))
      const message = composeStepGateMessage({ summary, language: "en" })!
      expect(message).toBe(`I've updated 1 new use case, 1 new actor, 1 new screen, 1 new role and 2 other parts. ${INVITE_EN}`)
      expect(message).not.toMatch(FORBIDDEN_EN)
    })

    it("giả định mới nói bằng 'I'm (also) assuming …' và chính tin đó tính là đã nói mọi điều", () => {
      const texts = ["Staff use desktop computers at the front desk.", "Patients book on their phones"]
      const message = composeStepGateMessage({ summary: [row("project", "update")], newAssumptionTexts: texts, language: "en" })!
      expect(message).toBe(
        `I've updated the system overview. I'm assuming staff use desktop computers at the front desk. I'm also assuming patients book on their phones. If anything is different, let me know. ${INVITE_EN}`
      )
      expect(message).not.toMatch(FORBIDDEN_EN)
      expect([...spokenAssumptionIds(message, [as("AS1", texts[0]), as("AS2", texts[1])])]).toEqual(["AS1", "AS2"])
    })

    it("chỉ có giả định ⇒ chỉ câu tạm hiểu, không lời mời 'have a look'", () => {
      expect(composeStepGateMessage({ summary: [], newAssumptionTexts: ["The clinic has a single site"], language: "en" })).toBe(
        "I'm assuming the clinic has a single site. If anything is different, let me know."
      )
    })

    it("assumptionSentence tiếng Anh: câu đã tự mang chủ ngữ hoặc dấu hiệu đoán giữ nguyên văn; giữ từ viết tắt; rỗng ⇒ null", () => {
      expect(assumptionSentence(["I'd say SMS is a backup channel", "We keep records for 10 years", "Staff probably work on desktops", "SMS goes through the carrier"], "en")).toBe(
        "I'd say SMS is a backup channel. We keep records for 10 years. Staff probably work on desktops. I'm also assuming SMS goes through the carrier. If anything is different, let me know."
      )
      expect(assumptionSentence(["  ", "."], "en")).toBeNull()
    })

    it("tin dự phòng tiếng Anh vào cổng giai đoạn ⇒ câu đếm đứng trước lời mời cuối", () => {
      const changed = composeStepGateMessage({ summary: [row("actors")], language: "en" })!
      expect(composePhaseGateMessage({ lastMessage: changed, unspokenCount: 2, language: "en" })).toBe(`I've updated 1 new actor. ${COUNT_EN(2)} ${INVITE_EN}`)
      const assumed = composeStepGateMessage({ summary: [], newAssumptionTexts: ["The clinic has a single site"], language: "en" })!
      expect(composePhaseGateMessage({ lastMessage: assumed, unspokenCount: 1, language: "en" })).toBe(
        `I'm assuming the clinic has a single site. ${COUNT_EN(1)} If anything is different, let me know.`
      )
    })

    it("thiếu language ⇒ tiếng Việt như trước", () => {
      const input = { summary: [row("use_cases")], newAssumptionTexts: ["Dùng trên web"] }
      expect(composeStepGateMessage(input)).toBe(composeStepGateMessage({ ...input, language: "vi" }))
      expect(composeStepGateMessage(input)).toContain(FALLBACK_INVITE)
      expect(composePhaseGateMessage({ unspokenCount: 2 })).toBe("Còn 2 điều tôi tạm hiểu nữa, mình rà ở phần tổng kết.")
      expect(assumptionSentence(["Dùng trên web"])).toBe(assumptionSentence(["Dùng trên web"], "vi"))
    })
  })
})
