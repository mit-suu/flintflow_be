import { describe, expect, it } from "vitest"
import type { Decision, Spine } from "../spine/spine.types.js"
import { ALWAYS_GATE, conflictsWithLedger, isQuietStep, type QuietInput } from "./quiet-step.js"

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

  it("FLF-220: bước đã hỏi và user đã trả lời ⇒ Cuối giai đoạn không dừng giữa phase; Mọi bước vẫn dừng", () => {
    expect(isQuietStep(input({ asked: true, reviewMode: "fast" })).quiet).toBe(true)
    expect(isQuietStep(input({ asked: true, reviewMode: "balanced" })).quiet).toBe(true)
    expect(isQuietStep(input({ asked: true, reviewMode: "strict" })).quiet).toBe(false)
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
