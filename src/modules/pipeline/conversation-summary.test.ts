import { describe, expect, it } from "vitest"
import type { Decision, Spine } from "../spine/spine.types.js"
import { RECENT_TURNS, SUMMARY_MAX_WORDS, buildConversationSummary, formatRecentTurns, messageText, type TranscriptMessage } from "./conversation-summary.js"

const decision = (topic_key: string, answer: string, superseded_by: string | null = null): Decision => ({
  id: `DC-${topic_key}`,
  topic_key,
  question: `${topic_key}?`,
  answer,
  step_id: "B-1.1",
  at: "2026-09-30T00:00:00.000Z",
  superseded_by
})

const spineOf = (project: Partial<Spine["project"]> = {}, decisions: Decision[] = []): Pick<Spine, "project" | "decisions"> => ({
  project: { vision: null, goals: [], ...project } as Spine["project"],
  decisions
})

const chat = (n: number): TranscriptMessage[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "ai", content: `tin ${i + 1}`, step: i < n / 2 ? "B-0.1" : "B-1.1" }))

describe("formatRecentTurns", () => {
  it("lấy đúng 6 tin gần nhất của cả transcript, bất kể step", () => {
    const lines = formatRecentTurns(chat(10)).split("\n")
    expect(lines).toHaveLength(RECENT_TURNS)
    expect(lines[0]).toBe("User: tin 5")
    expect(lines[5]).toBe("AI: tin 10")
  })

  it("tin AI của lượt hỏi (JSON reply + questions) được đọc thành chữ, không lộ JSON", () => {
    const ai: TranscriptMessage = { role: "ai", content: JSON.stringify({ reply: "Hay đấy.", questions: [{ question: "Ai dùng?" }] }) }
    expect(messageText(ai)).toBe("Hay đấy. [đã hỏi: Ai dùng?]")
    expect(formatRecentTurns([ai])).toBe("AI: Hay đấy. [đã hỏi: Ai dùng?]")
  })

  it("JSON hỏng hoặc không đúng dạng thì giữ nguyên chữ", () => {
    expect(messageText({ role: "ai", content: "{không phải json" })).toBe("{không phải json")
    expect(messageText({ role: "ai", content: '{"x":1}' })).toBe('{"x":1}')
    expect(messageText({ role: "user", content: '{"reply":"a"}' })).toBe('{"reply":"a"}')
  })

  it("transcript rỗng ⇒ chuỗi rỗng", () => {
    expect(formatRecentTurns([])).toBe("")
  })
})

describe("buildConversationSummary", () => {
  it("chưa có gì ⇒ dấu hiệu rỗng rõ ràng", () => {
    expect(buildConversationSummary(spineOf(), [])).toBe("(chưa có gì)")
  })

  it("gộp ý tưởng, mục tiêu, điều đã chốt (chỉ bản còn hiệu lực) và lời user vừa nói", () => {
    const summary = buildConversationSummary(
      spineOf({ vision: "Đặt lịch khám online", goals: ["Giảm thời gian chờ", "Giảm bỏ hẹn"] }, [
        decision("uptime", "99%"),
        decision("deposit_amount", "30%", "DC-new"),
        decision("deposit_amount", "50.000đ")
      ]),
      [{ role: "user", content: "tầm 200 ca một ngày" }]
    )
    expect(summary).toContain("Ý tưởng: Đặt lịch khám online")
    expect(summary).toContain("Mục tiêu: Giảm thời gian chờ; Giảm bỏ hẹn")
    expect(summary).toContain("uptime = 99%")
    expect(summary).toContain("deposit_amount = 50.000đ")
    expect(summary).not.toContain("30%")
    expect(summary).toContain('"tầm 200 ca một ngày"')
  })

  it("chỉ lấy lời user trong 6 tin gần nhất, tối đa 3 lời", () => {
    const messages: TranscriptMessage[] = Array.from({ length: 12 }, (_, i) => ({ role: "user" as const, content: `lời ${i + 1}` }))
    const summary = buildConversationSummary(spineOf(), messages)
    expect(summary).toContain('"lời 10" / "lời 11" / "lời 12"')
    expect(summary).not.toContain("lời 9")
  })

  it("không vượt trần từ, ý tưởng đứng đầu được giữ", () => {
    const long = Array.from({ length: 400 }, (_, i) => `từ${i}`).join(" ")
    const summary = buildConversationSummary(spineOf({ vision: "Ý tưởng chính", goals: Array.from({ length: 30 }, (_, i) => `mục tiêu số ${i} ${long.slice(0, 80)}`) }), [
      { role: "user", content: long }
    ])
    expect(summary.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(SUMMARY_MAX_WORDS + 1)
    expect(summary.startsWith("Ý tưởng: Ý tưởng chính")).toBe(true)
  })
})
