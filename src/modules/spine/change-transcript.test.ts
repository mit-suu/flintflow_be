import { describe, it, expect, vi } from "vitest"

vi.mock("../project/chat-session.model.js", () => ({ ChatSession: { findById: vi.fn() } }))

import { formatChatHistory, previewPayload, recordChangeTurn } from "./change-transcript.js"
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
    expect(payload).toMatchObject({ kind: "change_preview", preview_id: "pv" })
    expect(payload.reply).toContain("1 thay đổi")
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
