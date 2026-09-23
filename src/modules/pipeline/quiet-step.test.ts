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

describe("isQuietStep (R1)", () => {
  it("bước không hỏi, không cờ đỏ mới, không giả định ⇒ tự Accept", () => {
    expect(isQuietStep(input())).toMatchObject({ quiet: true })
  })

  it("mọi lý do khiến user cần nhìn đều chặn tự Accept", () => {
    expect(isQuietStep(input({ asked: true })).quiet).toBe(false)
    expect(isQuietStep(input({ redDelta: 2 })).quiet).toBe(false)
    expect(isQuietStep(input({ renderFailed: true })).quiet).toBe(false)
    expect(isQuietStep(input({ phaseTerminal: true })).quiet).toBe(false)
    expect(isQuietStep(input({ newAssumptions: [{ id: "AS1", text: "Giữ chỗ 15 phút" }] })).quiet).toBe(false)
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
