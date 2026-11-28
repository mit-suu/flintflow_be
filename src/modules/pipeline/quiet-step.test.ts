import { describe, expect, it } from "vitest"
import type { Decision, Spine } from "../spine/spine.types.js"
import { ALWAYS_GATE, chatEditVerdict, conflictsWithLedger, hardGateOf, isQuietStep, touchesOnlySkippedSections, type ChatEditInput, type QuietInput } from "./quiet-step.js"

const spineWith = (decisions: Decision[] = []): Spine => ({ decisions } as unknown as Spine)

const input = (over: Partial<QuietInput> = {}): QuietInput => ({
  templateId: "S-5.3",
  reviewMode: "balanced",
  asked: false,
  redDelta: 0,
  newAssumptions: [],
  renderFailed: false,
  phaseTerminal: false,
  spine: spineWith(),
  ...over
})

describe("FLF-337: mức Chỉ ở mốc chốt, cổng cứng, không hỏi lại phần này", () => {
  const skipping = (sections: string[]): Spine => ({ decisions: [], project: { skip_confirm_sections: sections, system_name: "Lumen" } } as unknown as Spine)

  it("milestones: bước cuối giai đoạn vẫn tự qua; mốc chốt (B-0.1, S-1.1, S-4.1, S-9.4, S-9.5) và Approve Brief B-2.3 luôn dừng", () => {
    expect(isQuietStep(input({ reviewMode: "milestones", phaseTerminal: true, spine: skipping([]) })).quiet).toBe(true)
    for (const step of ["B-0.1", "S-1.1", "S-4.1", "S-9.4", "S-9.5", "B-2.3"]) {
      expect(isQuietStep(input({ reviewMode: "milestones", templateId: step, spine: skipping([]) })).quiet, step).toBe(false)
    }
    // B-2.3 đã có tên hệ thống: Cuối giai đoạn dừng vì là bước cuối giai đoạn; Chỉ ở mốc chốt dừng vì là mốc chốt
    expect(isQuietStep(input({ reviewMode: "fast", templateId: "B-2.3", phaseTerminal: true, spine: skipping([]) })).reason_vi).toContain("cuối giai đoạn")
    expect(isQuietStep(input({ reviewMode: "milestones", templateId: "B-2.3", phaseTerminal: true, spine: skipping([]) })).reason_vi).toContain("mốc chốt")
  })

  it("cổng cứng trong lượt ở mọi mức: cờ đỏ mới, xoá nội dung, lỗi vẽ", () => {
    for (const mode of ["fast", "milestones"] as const) {
      expect(isQuietStep(input({ reviewMode: mode, redDelta: 1, spine: skipping([]) })).quiet, mode).toBe(false)
      expect(isQuietStep(input({ reviewMode: mode, contentRemoved: true, spine: skipping([]) })).reason_vi, mode).toContain("xoá nội dung")
      expect(isQuietStep(input({ reviewMode: mode, renderFailed: true, spine: skipping([]) })).quiet, mode).toBe(false)
    }
  })

  it("không hỏi lại phần này: bước chỉ chạm section đã chọn ⇒ tự qua kể cả Mọi bước và cuối giai đoạn; chạm thêm section khác ⇒ như cũ; có cờ đỏ mới vẫn dừng", () => {
    const only = isQuietStep(input({ reviewMode: "strict", touchedSections: ["fixed:5"], spine: skipping(["fixed:5"]) }))
    expect(only.quiet).toBe(true)
    expect(only.reason_vi).toContain("không hỏi lại")
    expect(isQuietStep(input({ reviewMode: "fast", phaseTerminal: true, touchedSections: ["fixed:5"], spine: skipping(["fixed:5"]) })).quiet).toBe(true)
    expect(isQuietStep(input({ reviewMode: "strict", touchedSections: ["fixed:5", "fixed:2.1"], spine: skipping(["fixed:5"]) })).quiet).toBe(false)
    expect(isQuietStep(input({ reviewMode: "fast", touchedSections: ["fixed:5"], redDelta: 1, spine: skipping(["fixed:5"]) })).quiet).toBe(false)
    // Mốc chốt không bao giờ tự qua
    expect(isQuietStep(input({ reviewMode: "fast", templateId: "S-4.1", touchedSections: ["fixed:5"], spine: skipping(["fixed:5"]) })).quiet).toBe(false)
  })
})

describe("isQuietStep (R1)", () => {
  it("bước không hỏi, không cờ đỏ mới, không giả định ⇒ tự Accept", () => {
    expect(isQuietStep(input())).toMatchObject({ quiet: true })
  })

  // FLF-449 (03-can-chot #1) thay FLF-220: trước đây bước có hỏi vẫn tự qua ở "Cuối giai đoạn"; BF §1.2 "Step tự qua khi
  // không hỏi gì" ⇒ có hỏi thì dừng ở mọi mức duyệt.
  it("FLF-449: bước đã hỏi user trong lượt ⇒ không tự qua ở mọi mức duyệt", () => {
    for (const reviewMode of ["strict", "fast", "balanced", "milestones"] as const) {
      const verdict = isQuietStep(input({ asked: true, reviewMode, spine: { decisions: [], project: { system_name: "Lumen" } } as unknown as Spine }))
      expect(verdict.quiet, reviewMode).toBe(false)
    }
    expect(isQuietStep(input({ asked: true, reviewMode: "fast" })).reason_vi).toContain("đã hỏi")
  })

  it("FLF-449: có hỏi vẫn dừng kể cả khi bước chỉ chạm phần đã chọn không hỏi lại; không hỏi thì tự qua như cũ", () => {
    const spine = { decisions: [], project: { skip_confirm_sections: ["fixed:5"], system_name: "Lumen" } } as unknown as Spine
    expect(isQuietStep(input({ asked: true, reviewMode: "fast", touchedSections: ["fixed:5"], spine })).quiet).toBe(false)
    expect(isQuietStep(input({ asked: true, reviewMode: "strict", touchedSections: ["fixed:5"], spine })).quiet).toBe(false)
    expect(isQuietStep(input({ asked: false, reviewMode: "fast", touchedSections: ["fixed:5"], spine })).quiet).toBe(true)
    expect(isQuietStep(input({ asked: false, reviewMode: "milestones", spine })).quiet).toBe(true)
  })

  it("mọi lý do khiến user cần nhìn đều chặn tự Accept", () => {
    expect(isQuietStep(input({ redDelta: 2 })).quiet).toBe(false)
    expect(isQuietStep(input({ renderFailed: true })).quiet).toBe(false)
    expect(isQuietStep(input({ phaseTerminal: true })).quiet).toBe(false)
  })

  it("bước có field đã chốt ở bước trước ⇒ tự Accept kể cả khi là cổng cuối giai đoạn; Chặt vẫn dừng", () => {
    const settled = isQuietStep(input({ templateId: "B-0.3", phaseTerminal: true, settledEarlier: true }))
    expect(settled.quiet).toBe(true)
    expect(settled.reason_vi).toContain("bước trước")
    expect(isQuietStep(input({ templateId: "B-0.3", phaseTerminal: true, settledEarlier: true, reviewMode: "strict" })).quiet).toBe(false)
  })

  it("balanced cũ xử lý như \"Cuối giai đoạn\": giả định mới không mâu thuẫn không làm dừng giữa phase", () => {
    const assumption = [{ id: "AS1", text: "Giữ chỗ 15 phút" }]
    expect(isQuietStep(input({ reviewMode: "balanced", newAssumptions: assumption })).quiet).toBe(true)
    expect(isQuietStep(input({ reviewMode: "fast", newAssumptions: assumption })).quiet).toBe(true)
    expect(isQuietStep(input({ reviewMode: "strict", newAssumptions: assumption })).quiet).toBe(false)
  })

  it("chế độ Chặt không bao giờ tự Accept; bước luôn cần người cũng vậy", () => {
    expect(isQuietStep(input({ reviewMode: "strict" })).quiet).toBe(false)
    for (const templateId of ALWAYS_GATE) expect(isQuietStep(input({ templateId })).quiet, templateId).toBe(false)
  })

  it("chế độ Nhanh bỏ qua giả định không mâu thuẫn, nhưng vẫn dừng khi giả định trái điều đã chốt", () => {
    const ledger = spineWith([
      { id: "DC01", topic_key: "uptime", question: "Uptime?", answer: "99%", step_id: "S-1.4", at: "2026-09-22T00:00:00.000Z", superseded_by: null }
    ])
    expect(isQuietStep(input({ reviewMode: "fast", newAssumptions: [{ id: "AS1", text: "Giữ chỗ 15 phút" }] })).quiet).toBe(true)
    const conflicting = isQuietStep(
      input({ reviewMode: "fast", spine: ledger, newAssumptions: [{ id: "AS28", text: "Uptime target is 99.5% during business hours" }] })
    )
    expect(conflicting.quiet).toBe(false)
    expect(conflicting.reason_vi).toContain("trái với điều bạn đã chốt")
  })

  it("giả định nhắc lại đúng giá trị đã chốt thì không coi là mâu thuẫn", () => {
    const ledger = spineWith([
      { id: "DC01", topic_key: "uptime", question: "Uptime?", answer: "99%", step_id: "S-1.4", at: "2026-09-22T00:00:00.000Z", superseded_by: null }
    ])
    expect(conflictsWithLedger("Uptime stays at 99% as agreed", ledger)).toBe(false)
    expect(conflictsWithLedger("Uptime target is 99.5%", ledger)).toBe(true)
    expect(conflictsWithLedger("Deposit is 50.000đ", ledger), "chủ đề khác không bị đụng").toBe(false)
  })
})

describe("FLF-232: cổng không báo 'trái điều đã chốt' khi không có mâu thuẫn thật", () => {
  const ledger = spineWith([
    { id: "DC01", topic_key: "system_name", question: "Tên?", answer: "Minh An Booking", step_id: "B-2.3", at: "2026-09-22T00:00:00.000Z", superseded_by: null },
    { id: "DC02", topic_key: "form_factor", question: "Nền tảng?", answer: "Web", step_id: "B-0.1", at: "2026-09-22T00:00:00.000Z", superseded_by: null },
    { id: "DC03", topic_key: "uptime", question: "Uptime?", answer: "99%", step_id: "S-1.4", at: "2026-09-22T00:00:00.000Z", superseded_by: null }
  ])

  it("quyết định bằng chữ (tên, nền tảng) không bao giờ bị coi là mâu thuẫn chỉ vì câu giả định nhắc tới chủ đề", () => {
    expect(conflictsWithLedger("The system is used by clinic staff on desktop computers", ledger)).toBe(false)
    expect(conflictsWithLedger("The form factor is a mobile app for patients", ledger)).toBe(false)
  })

  it("giả định không nêu con số nào thì không thể 'khác số' đã chốt", () => {
    expect(conflictsWithLedger("Uptime is best effort outside business hours", ledger)).toBe(false)
  })

  it("mâu thuẫn số thật vẫn được bắt", () => {
    expect(conflictsWithLedger("Uptime target is 99.9%", ledger)).toBe(true)
  })

  it("giá trị đã chốt có trong bản tiếng Việt của giả định ⇒ không mâu thuẫn; câu trả lời văn xuôi của lượt hỏi gộp không so được", () => {
    expect(conflictsWithLedger({ text: "Uptime target is 99.5% during business hours", text_vi: "Hệ thống sẵn sàng 99% trong giờ làm việc" }, ledger)).toBe(false)
    expect(conflictsWithLedger({ text: "Uptime target is 99.5%", text_vi: "Sẵn sàng 99,5%" }, ledger)).toBe(true)
    const prose = spineWith([
      { id: "DC09", topic_key: "roles", question: "Ai làm gì?", answer: "lễ tân nhận lịch qua điện thoại, bác sĩ khám", step_id: "B-1", at: "2026-09-22T00:00:00.000Z", superseded_by: null }
    ])
    expect(conflictsWithLedger({ text: "Receptionists confirm bookings by phone within 2 hours", text_vi: "Lễ tân xác nhận lịch qua điện thoại" }, prose)).toBe(false)
  })

  it("giả định mới nói bằng chữ ⇒ bước tự Accept, cổng không có tiêu đề mâu thuẫn", () => {
    const verdict = isQuietStep(input({ reviewMode: "fast", spine: ledger, newAssumptions: [{ id: "AS1", text: "The system is used on desktop computers" }] }))
    expect(verdict).toMatchObject({ quiet: true })
    expect(verdict.reason_vi).not.toContain("trái với")
  })
})

describe("FLF-232: B-2.3 hỏi tên hệ thống, không tự Accept khi tên còn null", () => {
  const withName = (name: string | null): Spine => ({ decisions: [], project: { system_name: name } } as unknown as Spine)

  it("tên còn null ⇒ dừng ở mọi chế độ duyệt, có lý do nói về tên", () => {
    for (const reviewMode of ["fast", "balanced", "strict"] as const) {
      const verdict = isQuietStep(input({ templateId: "B-2.3", reviewMode, spine: withName(null) }))
      expect(verdict.quiet, reviewMode).toBe(false)
    }
    expect(isQuietStep(input({ templateId: "B-2.3", reviewMode: "fast", spine: withName(null) })).reason_vi).toContain("tên hệ thống")
  })

  it("đã có tên (project cũ) ⇒ B-2.3 theo luật thường", () => {
    expect(isQuietStep(input({ templateId: "B-2.3", reviewMode: "fast", spine: withName("Minh An Booking") })).quiet).toBe(true)
  })

  it("chỉ B-2.3 bị ràng buộc bởi tên", () => {
    expect(isQuietStep(input({ templateId: "B-2.2", reviewMode: "fast", spine: withName(null) })).quiet).toBe(true)
  })
})

describe("S-1.1 luôn dừng để user soát bản tiếng Anh của tầm nhìn và mục tiêu", () => {
  it("S-1.1 thuộc ALWAYS_GATE: không tự Accept ở mọi chế độ duyệt, lý do nói về bản tiếng Anh", () => {
    expect(ALWAYS_GATE.has("S-1.1")).toBe(true)
    for (const reviewMode of ["fast", "balanced", "strict"] as const) {
      expect(isQuietStep(input({ templateId: "S-1.1", reviewMode })).quiet, reviewMode).toBe(false)
    }
    expect(isQuietStep(input({ templateId: "S-1.1", reviewMode: "fast" })).reason_vi).toContain("tiếng Anh")
  })

  it("S-1.2 (bước kế) vẫn tự Accept được", () => {
    expect(isQuietStep(input({ templateId: "S-1.2", reviewMode: "fast" })).quiet).toBe(true)
  })
})

describe("FLF-432 (FLF-413 #8): bước soạn mà mục của nó còn trống không tự qua", () => {
  it("S-7.3 chỉ trao đổi, mục Messages trống ⇒ dừng ở cổng, kể cả mức Chỉ ở mốc chốt", () => {
    const empty = [{ section_id: "fixed:5.3" }]
    expect(isQuietStep(input({ templateId: "S-7.3", emptySections: empty })).quiet).toBe(false)
    expect(isQuietStep(input({ templateId: "S-7.3", emptySections: empty, reviewMode: "milestones" })).quiet).toBe(false)
    expect(isQuietStep(input({ templateId: "S-7.3", emptySections: empty })).reason_vi).toContain("chưa ghi được nội dung")
  })
  it("mục đã có nội dung ⇒ như cũ", () => {
    expect(isQuietStep(input({ templateId: "S-7.3", emptySections: [] })).quiet).toBe(true)
  })
})

describe("lõi cổng cứng dùng chung với bản sửa qua chat", () => {
  const spineWith2 = (project: Record<string, unknown> = {}): Spine => ({ decisions: [], project } as unknown as Spine)
  const edit = (over: Partial<ChatEditInput> = {}): ChatEditInput => ({
    reviewMode: "balanced",
    touchedSections: ["fixed:2.1"],
    redDelta: 0,
    newAssumptions: [],
    needsPerson: false,
    spine: spineWith2(),
    ...over
  })

  it("hardGateOf: cờ đỏ mới, xoá nội dung, lỗi vẽ, giả định trái điều đã chốt; không có ⇒ null", () => {
    const base = { redDelta: 0, newAssumptions: [], spine: spineWith2() }
    expect(hardGateOf(base)).toBeNull()
    expect(hardGateOf({ ...base, redDelta: 2 })).toEqual({ kind: "red_flags", count: 2 })
    expect(hardGateOf({ ...base, contentRemoved: true })).toEqual({ kind: "content_removed" })
    expect(hardGateOf({ ...base, renderFailed: true })).toEqual({ kind: "render_failed" })
    const decided = { decisions: [{ topic_key: "reliability_uptime", answer: "99%", superseded_by: null }], project: {} } as unknown as Spine
    expect(hardGateOf({ ...base, spine: decided, newAssumptions: [{ id: "a", text: "Uptime is 99.5 percent" }] })).toEqual({ kind: "assumption_conflict", count: 1 })
  })

  it("bước vẫn dùng đúng câu lý do cũ sau khi tách lõi", () => {
    expect(isQuietStep(input({ redDelta: 2 })).reason_vi).toBe("Bước mở thêm 2 cờ đỏ")
    expect(isQuietStep(input({ contentRemoved: true })).reason_vi).toBe("Bước xoá nội dung đã có")
    expect(isQuietStep(input({ renderFailed: true })).reason_vi).toBe("Có sơ đồ vẽ lỗi")
  })

  it("touchesOnlySkippedSections: cần có section và mọi section đều trong danh sách", () => {
    const spine = spineWith2({ skip_confirm_sections: ["fixed:2.1", "fixed:5.1"] })
    expect(touchesOnlySkippedSections(["fixed:2.1", "fixed:5.1"], spine)).toBe(true)
    expect(touchesOnlySkippedSections(["fixed:2.1", "fixed:3.1.2"], spine)).toBe(false)
    expect(touchesOnlySkippedSections([], spine)).toBe(false)
  })

  it("chatEditVerdict: strict dừng, ba mức còn lại tự ghi", () => {
    expect(chatEditVerdict(edit({ reviewMode: "strict" })).quiet).toBe(false)
    for (const reviewMode of ["balanced", "fast", "milestones"] as const) expect(chatEditVerdict(edit({ reviewMode })).quiet, reviewMode).toBe(true)
  })

  it("chatEditVerdict: cổng cứng thắng mọi mức, kể cả 'không hỏi lại'", () => {
    const skipping = spineWith2({ skip_confirm_sections: ["fixed:2.1"] })
    for (const reviewMode of ["strict", "balanced", "fast", "milestones"] as const) {
      expect(chatEditVerdict(edit({ reviewMode, spine: skipping, needsPerson: true })).quiet, `${reviewMode} cần người`).toBe(false)
      expect(chatEditVerdict(edit({ reviewMode, spine: skipping, contentRemoved: true })).reason_vi, `${reviewMode} xoá`).toContain("xoá")
      expect(chatEditVerdict(edit({ reviewMode, spine: skipping, redDelta: 1 })).reason_vi, `${reviewMode} cờ đỏ`).toContain("1 cờ đỏ")
    }
  })

  it("chatEditVerdict: chỉ chạm phần 'không hỏi lại' ⇒ tự ghi ở cả mức strict", () => {
    const skipping = spineWith2({ skip_confirm_sections: ["fixed:2.1"] })
    expect(chatEditVerdict(edit({ reviewMode: "strict", spine: skipping })).quiet).toBe(true)
    expect(chatEditVerdict(edit({ reviewMode: "strict", spine: skipping, touchedSections: ["fixed:2.1", "fixed:3.1.2"] })).quiet).toBe(false)
  })
})
