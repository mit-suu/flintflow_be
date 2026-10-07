/**
 * FLF-260 — ngôn ngữ trả lời của pipeline qua HTTP thật: Mongo in-memory, provider giả ở tầng `callLLM`.
 *
 * - `/run` mở bằng tin tiếng Anh ⇒ phiên ghi `reply_language: "en"`, mọi prompt của lượt kết thúc bằng khối English.
 * - `/gate` revision: ghi chú cổng không phải tin để đoán ⇒ phiên giữ ngôn ngữ; lượt soạn lại và lời xác nhận theo phiên.
 * - `/phases/:phase/run`: tin mở giai đoạn ghi lên phiên, các bước đọc lại ngôn ngữ phiên ở cửa vào (đường unit test không
 *   thấy được vì không nối Mongo).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () => (await import("../helpers/mock-llm.js")).mockLlmRouterModule())

import app from "../../src/app.js"
import { parseSse, seedFixture, type SeededFixture } from "../setup.js"
import { detectCall, mockOverrides, resetMockLlm } from "../helpers/mock-llm.js"
import { spineVersionOf, startAt } from "../helpers/pipeline.js"
import { ChatSession } from "../../src/modules/project/chat-session.model.js"
import { replyLanguageDirective } from "../../src/shared/i18n/reply-language.js"

/** Prompt đã gửi model, theo thứ tự gọi, kèm loại lượt gọi. */
const prompts: { kind: string; text: string }[] = []

beforeEach(() => {
  resetMockLlm()
  prompts.length = 0
  mockOverrides.next = (prompt) => {
    prompts.push({ kind: detectCall(prompt).kind, text: prompt })
    return undefined
  }
})

const endsWithDirective = (language: "vi" | "en") => (text: string) => text.endsWith(`\n\n${replyLanguageDirective(language)}`)

const runHttp = async (seeded: SeededFixture, path: string, body: Record<string, unknown>) => {
  const res = await request(app)
    .post(`/api/v1/projects/${seeded.projectId}/${path}`)
    .set("Authorization", `Bearer ${seeded.token}`)
    .send({ session_id: seeded.sessionId, base_version: await spineVersionOf(app, seeded), ...body })
  expect(res.status, res.text).toBe(200)
  return parseSse(res.text ?? "") as Array<Record<string, unknown> & { type: string }>
}

const sessionOf = async (seeded: SeededFixture) => ChatSession.findById(seeded.sessionId).lean()

describe("FLF-260 pipeline — ngôn ngữ trả lời qua HTTP", () => {
  it("/run mở bằng tin tiếng Anh ⇒ phiên ghi en, prompt hỏi và soạn đều kết thúc bằng khối English", { timeout: 60_000 }, async () => {
    const seeded = await seedFixture("minimal", { mutate: startAt("S-3.1") })
    const events = await runHttp(seeded, "steps/S-3.1/run", { message: "We need to describe who uses the booking system" })

    expect(events.at(-1)?.type, JSON.stringify(events.at(-1))).toBe("gate_ready")
    expect((await sessionOf(seeded))?.reply_language).toBe("en")
    expect(prompts.some((p) => p.kind === "draft")).toBe(true)
    expect(prompts.map((p) => p.text).every(endsWithDirective("en"))).toBe(true)
  })

  it("/gate revision ghi chú tiếng Việt ⇒ phiên vẫn en, lượt soạn lại theo phiên, lời xác nhận dựng bằng tiếng Anh", { timeout: 60_000 }, async () => {
    const seeded = await seedFixture("minimal", { mutate: startAt("S-3.1") })
    await runHttp(seeded, "steps/S-3.1/run", { message: "We need to describe who uses the booking system" })
    prompts.length = 0
    // Lượt soạn lại không viết `notes` ⇒ server tự dựng lời xác nhận từ tóm tắt thay đổi
    mockOverrides.next = (prompt) => {
      const kind = detectCall(prompt).kind
      prompts.push({ kind, text: prompt })
      if (kind !== "draft") return undefined
      return JSON.stringify({ ops: [{ op: "add", path: "actors[]", value: { id: "A42", name: "Accountant", kind: "human", description: "Checks the invoices" } }] })
    }

    const gate = await request(app)
      .post(`/api/v1/projects/${seeded.projectId}/steps/S-3.1/gate`)
      .set("Authorization", `Bearer ${seeded.token}`)
      .send({ session_id: seeded.sessionId, action: "revision", note: "Thêm actor kế toán giúp tôi", base_version: await spineVersionOf(app, seeded) })
    expect(gate.status, JSON.stringify(gate.body.error)).toBe(200)

    expect(gate.body.data.message_vi).toBe("I've updated 1 new actor. Have a look, and if it all looks right we'll move on.")
    expect(prompts.filter((p) => p.kind === "draft").map((p) => p.text).every(endsWithDirective("en"))).toBe(true)
    const session = await sessionOf(seeded)
    expect(session?.reply_language).toBe("en")
    // Ghi chú cổng vẫn vào lịch sử như lời user — chỉ không được dùng để đoán ngôn ngữ
    expect(session?.messages.some((m) => m.role === "user" && m.content === "Thêm actor kế toán giúp tôi")).toBe(true)
  })

  it("/phases/:phase/run mở bằng tin tiếng Anh ⇒ phỏng vấn đầu giai đoạn và bước đầu đều nhận khối English", { timeout: 60_000 }, async () => {
    // Duyệt chặt: S-3.1 là cổng thật, chuỗi dừng ở đó (op-case của S-3.2 cần id do S-1.2/S-2.x sinh — không có ở fixture này)
    const seeded = await seedFixture("minimal", {
      mutate: (spine) => {
        startAt("S-3.1")(spine)
        ;(spine.project as Record<string, unknown>).review_mode = "strict"
      }
    })
    const events = await runHttp(seeded, "phases/S-3/run", { message: "Please list the actors and what each of them needs" })

    expect(events.some((e) => e.type === "error"), JSON.stringify(events.find((e) => e.type === "error"))).toBe(false)
    expect(events.find((e) => e.type === "gate_ready")?.step_id).toBe("S-3.1")
    expect((await sessionOf(seeded))?.reply_language).toBe("en")
    // Lượt hỏi gộp dùng ngôn ngữ đoán từ tin mở giai đoạn; bước S-3.1 không đoán lại tin đó mà đọc ngôn ngữ phiên
    expect(prompts.some((p) => p.kind === "elicit")).toBe(true)
    expect(prompts.some((p) => p.kind === "draft")).toBe(true)
    expect(prompts.map((p) => p.text).every(endsWithDirective("en"))).toBe(true)
  })

  it("phiên đã là en, /run không kèm tin ⇒ vẫn soạn bằng tiếng Anh (ngôn ngữ phiên dính qua các lượt)", { timeout: 60_000 }, async () => {
    const seeded = await seedFixture("minimal", { mutate: startAt("S-3.1") })
    await ChatSession.updateOne({ _id: seeded.sessionId }, { $set: { reply_language: "en" } })
    await runHttp(seeded, "steps/S-3.1/run", {})

    expect(prompts.length).toBeGreaterThan(0)
    expect(prompts.map((p) => p.text).every(endsWithDirective("en"))).toBe(true)
    expect((await sessionOf(seeded))?.reply_language).toBe("en")
  })
})
