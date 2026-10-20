import { describe, it, expect, vi } from "vitest"

vi.mock("../project/chat-session.model.js", () => ({ ChatSession: { findById: vi.fn() } }))

import { clarificationRounds, formatChatContext, formatChatHistory, previewPayload, recordChangeTurn } from "./change-transcript.js"
import type { IChatMessage, IChatSession } from "../project/chat-session.model.js"
import type { ChangePreviewResult } from "./change.service.js"

const msg = (role: IChatMessage["role"], content: string, step = "S-2.1"): IChatMessage => ({ role, content, step, createdAt: new Date() })

describe("formatChatHistory", () => {
  it("tin AI dạng JSON ⇒ chỉ lấy reply; giữ đúng thứ tự cũ → mới", () => {
    const text = formatChatHistory([
      msg("user", "đổi tên admin"),
      msg("ai", JSON.stringify({ kind: "change_clarification", reply: "A01 hay A03?" }))
    ])
    expect(text).toBe("User: đổi tên admin\nAI: A01 hay A03?")
  })

  it("chỉ lấy đuôi phiên", () => {
    const messages = Array.from({ length: 20 }, (_, i) => msg("user", `m${i}`))
    const lines = formatChatHistory(messages).split("\n")
    expect(lines).toHaveLength(12)
    expect(lines[11]).toBe("User: m19")
  })
})

describe("clarificationRounds — FLF-299", () => {
  const ask = (q: string) => msg("ai", JSON.stringify({ kind: "change_clarification", reply: q }))

  it("đếm câu hỏi làm rõ liên tiếp ở cuối phiên, bỏ qua tin user", () => {
    expect(clarificationRounds([msg("user", "thêm popup xác nhận"), ask("Thao tác nào?"), msg("user", "chỉ thao tác xóa"), ask("Màn nào?")])).toBe(2)
    expect(clarificationRounds([msg("user", "thêm popup"), ask("Thao tác nào?"), msg("user", "chỉ xóa")])).toBe(1)
  })

  it("dừng ở tin AI khác (yêu cầu trước đã khép); phiên rỗng ⇒ 0", () => {
    const applied = msg("ai", JSON.stringify({ kind: "change_applied", reply: "Đã áp dụng" }))
    expect(clarificationRounds([ask("Cũ?"), applied, msg("user", "đổi tên admin")])).toBe(0)
    expect(clarificationRounds([msg("ai", "Xin chào"), msg("user", "x")])).toBe(0)
    expect(clarificationRounds([])).toBe(0)
  })
})

describe("previewPayload", () => {
  const base: ChangePreviewResult = { ok: true, txn: "t", base_version: 1, ops: [], changes: [], violations: [], referrers: [] }

  it("clarification ⇒ change_clarification", () => {
    expect(previewPayload({ ...base, ok: false, clarification: "A01 hay A03?" })).toEqual({ kind: "change_clarification", reply: "A01 hay A03?" })
  })

  it("preview có thay đổi ⇒ change_preview kèm số thay đổi", () => {
    const payload = previewPayload({
      ...base,
      changes: [{ op: "set", path: "actors[id=A01].name", before: "A", value: "B", reason: null }],
      preview_id: "pv"
    })
    expect(payload).toMatchObject({ kind: "change_preview", preview_id: "pv", change_count: 1 })
    expect(payload.reply).toContain("1 thay đổi")
  })

  it("FLF-298: notes (vd use case mới chưa có màn hình) nối vào câu trả lời", () => {
    const payload = previewPayload({
      ...base,
      changes: [{ op: "add", path: "use_cases[]", before: null, value: {}, reason: null }],
      preview_id: "pv",
      notes: 'Use case mới "Send Absence Warning" chưa gắn chức năng nào'
    })
    expect(String(payload.reply).split("\n")).toEqual([expect.stringContaining("1 thay đổi"), 'Use case mới "Send Absence Warning" chưa gắn chức năng nào'])
  })

  it("FLF-244: không lưu mảng changes/impact/violations vào transcript", () => {
    const payload = previewPayload({
      ...base,
      changes: [{ op: "set", path: "actors[id=A01].name", before: "A", value: "B", reason: null }],
      impact: { fields: [], sections: [], diagrams: [], referrers: [] },
      preview_id: "pv"
    })
    expect(payload).not.toHaveProperty("changes")
    expect(payload).not.toHaveProperty("impact")
    expect(payload).not.toHaveProperty("violations")
  })

  it("FLF-260: language en ⇒ câu tiếng Anh (số ít / số nhiều); mặc định giữ nguyên câu tiếng Việt", () => {
    const change: ChangePreviewResult["changes"][number] = { op: "set", path: "actors[id=A01].name", before: "A", value: "B", reason: null }
    const one: ChangePreviewResult = { ...base, changes: [change], preview_id: "pv", branch: "dependent" }
    const two: ChangePreviewResult = { ...one, changes: [change, change] }

    expect(previewPayload(one, "en").reply).toBe('Built a preview of 1 change — review it, then press "Áp dụng" (Apply) to save.')
    expect(previewPayload(two, "en").reply).toBe('Built a preview of 2 changes — review it, then press "Áp dụng" (Apply) to save.')
    expect(previewPayload(base, "en").reply).toBe("Nothing in the document needs to change for this request.")
    expect(previewPayload(two).reply).toBe("Đã dựng bản xem trước 2 thay đổi — xem rồi bấm Áp dụng để ghi.")
    expect(previewPayload(two, "vi").reply).toBe(previewPayload(two).reply)
    expect(previewPayload(base).reply).toBe("Không tìm thấy chỗ nào cần đổi theo lệnh này.")
    // Chỉ câu đổi theo ngôn ngữ — các field FE đọc (kind, preview_id, branch, change_count) giữ nguyên
    expect({ ...previewPayload(two, "en"), reply: null }).toEqual({ ...previewPayload(two), reply: null })
    // Câu hỏi làm rõ đã đúng ngôn ngữ từ change.service ⇒ giữ nguyên văn
    expect(previewPayload({ ...base, ok: false, clarification: "Which actor do you mean?" }, "en")).toEqual({
      kind: "change_clarification",
      reply: "Which actor do you mean?"
    })
  })
})

describe("formatChatContext (FLF-244)", () => {
  const spine = { project: { vision: "Đặt lịch cắt tóc", goals: ["Giảm khách chờ"] }, decisions: [], addendum: [] } as unknown as Parameters<typeof formatChatContext>[1]

  it("không có Spine ⇒ đúng bằng formatChatHistory", () => {
    const messages = [msg("user", "a"), msg("ai", "b")]
    expect(formatChatContext(messages, null)).toBe(formatChatHistory(messages))
  })

  it("có Spine ⇒ tóm tắt đứng trước đuôi; lời user đã trôi khỏi đuôi vào tóm tắt", () => {
    const messages = Array.from({ length: 14 }, (_, i) => msg("user", `m${i}`))
    const text = formatChatContext(messages, spine)
    expect(text.startsWith("Tóm tắt hội thoại trước: Ý tưởng: Đặt lịch cắt tóc")).toBe(true)
    expect(text).toContain('"m1"')
    const [, tail] = text.split("\n\n")
    expect(tail.split("\n")).toHaveLength(12)
  })

  it("Spine chưa có gì để tóm tắt ⇒ chỉ đuôi", () => {
    const empty = { project: { vision: null, goals: [] }, decisions: [], addendum: [] } as unknown as Parameters<typeof formatChatContext>[1]
    expect(formatChatContext([msg("user", "a")], empty)).toBe("User: a")
  })
})

describe("recordChangeTurn", () => {
  it("ghi tin user + tin AI, step theo tin cuối phiên", async () => {
    const save = vi.fn(async () => undefined)
    const session = { messages: [msg("ai", "xin chào", "S-3.1")], save } as unknown as IChatSession

    await recordChangeTurn(session, "đổi tên A01", { kind: "change_applied", reply: "Đã áp dụng 1 thay đổi" })

    expect(session.messages).toHaveLength(3)
    expect(session.messages[1]).toMatchObject({ role: "user", content: "đổi tên A01", step: "S-3.1" })
    expect(JSON.parse(session.messages[2].content)).toMatchObject({ kind: "change_applied" })
    expect(save).toHaveBeenCalledTimes(1)
  })
})
