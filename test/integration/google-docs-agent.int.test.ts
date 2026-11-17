/**
 * Trợ lý Google Docs (contract #48–#50) qua HTTP trên Mongo thật: model (giả, chạy theo kịch bản) gọi tool MCP; tool ghi chỉ
 * tạo đề xuất — kể cả khi model cố gửi `dryRun: false`. Google Doc chỉ đổi khi người dùng bấm Áp dụng. Credit: 2 / tin nhắn,
 * hoàn khi lỗi. Google (OAuth + Docs API) và model AI được mock.
 */
import crypto from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test"
import app from "../../src/app.js"
import { env } from "../../src/config/env.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"
import { User } from "../../src/modules/user/user.model.js"
import { Membership } from "../../src/modules/organization/membership.model.js"
import { GooglePendingAction } from "../../src/modules/google/docs-agent/pending-action.model.js"
import { loadSampleDoc } from "../../src/modules/google/docs-mcp/docs-test-fixture.js"
import { authAs, parseSse, seedFixture, type SeededFixture } from "../setup.js"

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"

type StreamChunk = Record<string, unknown>
const usage = { inputTokens: { total: 100, noCache: 100 }, outputTokens: { total: 20, text: 20 } }
const toolStep = (calls: Array<[string, Record<string, unknown>]>): StreamChunk[] => [
  { type: "stream-start", warnings: [] },
  ...calls.map(([toolName, input], i) => ({ type: "tool-call", toolCallId: `call-${i}-${toolName}`, toolName, input: JSON.stringify(input) })),
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage }
]
const textStep = (text: string): StreamChunk[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage }
]

const h = vi.hoisted(() => ({
  steps: [] as Array<Array<Record<string, unknown>> | Error>,
  getToken: vi.fn(),
  verifyIdToken: vi.fn(),
  getAccessToken: vi.fn(),
  documents: { get: vi.fn(), batchUpdate: vi.fn() }
}))

vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn(function OAuth2Client() {
    return {
      getToken: h.getToken,
      verifyIdToken: h.verifyIdToken,
      revokeToken: vi.fn(),
      credentials: {},
      setCredentials() {},
      getAccessToken: h.getAccessToken
    }
  })
}))
vi.mock("@googleapis/docs", () => ({ docs: vi.fn(() => ({ documents: h.documents })) }))
vi.mock("../../src/shared/ai/providers/ai-sdk.provider.js", () => ({
  getAiSdkModel: () =>
    new MockLanguageModelV3({
      doStream: async () => {
        const next = h.steps.shift()
        if (!next) throw new Error("model gọi thêm bước ngoài kịch bản")
        if (next instanceof Error) throw next
        return { stream: convertArrayToReadableStream(next as never[]) }
      }
    })
}))

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const base = (seeded: SeededFixture) => `/api/v1/projects/${seeded.projectId}/google-docs/agent`

const connectGoogle = async (seeded: SeededFixture) => {
  h.getToken.mockResolvedValue({ tokens: { scope: `openid email ${DRIVE_SCOPE}`, refresh_token: "refresh", id_token: "id" } })
  h.verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: "sub", email: "owner@gmail.com" }) })
  expect((await request(app).post("/api/v1/integrations/google/connect").set(auth(seeded.token)).send({ code: "c" })).status).toBe(200)
}

const send = (seeded: SeededFixture, body: Record<string, unknown>, token = seeded.token) =>
  request(app)
    .post(`${base(seeded)}/messages/stream`)
    .set(auth(token))
    .send({ documentId: "doc-srs-1", ...body })
    .buffer(true)
    .parse((res, done) => {
      let text = ""
      res.setEncoding("utf8")
      res.on("data", (chunk: string) => (text += chunk))
      res.on("end", () => done(null, text))
    })

const balance = async (seeded: SeededFixture) =>
  (await CreditWallet.findOne({ organizationId: seeded.orgId }).lean())!.balance

beforeEach(() => {
  vi.clearAllMocks()
  h.steps.length = 0
  env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com"
  env.GOOGLE_CLIENT_SECRET = "test-client-secret"
  env.GOOGLE_TOKEN_ENC_KEY = crypto.randomBytes(32).toString("base64")
  h.getAccessToken.mockResolvedValue({ token: "access" })
  h.documents.get.mockResolvedValue({ data: loadSampleDoc() })
})

describe("trợ lý Google Docs", () => {
  it("đọc qua tool, tool ghi chỉ thành đề xuất (kể cả khi model đòi dryRun: false); trừ 2 credit; Áp dụng mới ghi", async () => {
    const seeded = await seedFixture("minimal")
    await connectGoogle(seeded)
    const before = await balance(seeded)
    h.steps.push(
      toolStep([["get_outline", { documentId: "doc-srs-1" }]]),
      toolStep([["read_section", { documentId: "doc-srs-1", heading: "Use cases" }]]),
      // Model cố ghi thật và trỏ sang tài liệu khác — lớp bọc phải ép xem trước + ghim đúng tài liệu
      toolStep([["replace_text", { documentId: "doc-khac", find: "Đặt vé", replace: "Mua vé", dryRun: false, expectedRevisionId: "rev-1" }]]),
      textStep("Mình đã tạo một đề xuất thay chữ.")
    )

    const res = await send(seeded, { message: "Đổi 'Đặt vé' thành 'Mua vé'", history: [{ role: "user", content: "chào" }, { role: "assistant", content: "chào bạn" }] })
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toContain("text/event-stream")
    const events = parseSse(res.body as string)
    expect(events.filter((e) => e.type === "tool-call").map((e) => [e.name, e.args])).toEqual([
      ["get_outline", {}],
      ["read_section", { heading: "Use cases" }],
      ["replace_text", {}]
    ])
    const finish = events.find((e) => e.type === "finish") as { data: { reply: string; pending_actions: Array<Record<string, unknown>> }; cost: number }
    expect(finish.data.reply).toBe("Mình đã tạo một đề xuất thay chữ.")
    expect(finish.cost).toBe(2)
    expect(finish.data.pending_actions).toHaveLength(1)
    const action = finish.data.pending_actions[0] as { id: string; tool: string; documentId: string; args: Record<string, unknown>; preview: Record<string, unknown> }
    expect(action).toMatchObject({ tool: "replace_text", documentId: "doc-srs-1", args: { find: "Đặt vé", replace: "Mua vé" }, preview: { matches: 2 } })
    expect(action.args).not.toHaveProperty("dryRun")

    // Chưa có lượt ghi nào vào Google Doc; credit trừ đúng 2
    expect(h.documents.batchUpdate).not.toHaveBeenCalled()
    expect(h.documents.get.mock.calls.every(([arg]) => arg.documentId === "doc-srs-1")).toBe(true)
    expect(await balance(seeded)).toBe(before - 2)

    // Áp dụng ⇒ ghi thật kèm revision lúc xem trước; miễn phí; áp dụng lần nữa ⇒ 404
    h.documents.batchUpdate.mockResolvedValue({ data: { replies: [{ replaceAllText: { occurrencesChanged: 2 } }], writeControl: { requiredRevisionId: "rev-2" } } })
    const applied = await request(app).post(`${base(seeded)}/actions/${action.id}/apply`).set(auth(seeded.token))
    expect(applied.status).toBe(200)
    expect(applied.body.data).toMatchObject({ applied: true, documentId: "doc-srs-1", revisionId: "rev-2" })
    expect(h.documents.batchUpdate.mock.calls[0][0]).toMatchObject({ documentId: "doc-srs-1", requestBody: { writeControl: { requiredRevisionId: "rev-1" } } })
    expect(await balance(seeded)).toBe(before - 2)
    const again = await request(app).post(`${base(seeded)}/actions/${action.id}/apply`).set(auth(seeded.token))
    expect(again.status).toBe(404)
    expect(again.body.error.code).toBe("PENDING_ACTION_NOT_FOUND")
  })

  it("tài liệu đổi sau khi xem trước ⇒ Áp dụng trả 409 GOOGLE_DOC_CHANGED, đề xuất còn để bỏ qua", async () => {
    const seeded = await seedFixture("minimal")
    await connectGoogle(seeded)
    h.steps.push(toolStep([["insert_text", { afterHeading: "Business Rules", text: "BR02: Hoàn vé trước 24 giờ." }]]), textStep("Đã đề xuất."))
    const events = parseSse((await send(seeded, { message: "Thêm luật hoàn vé" })).body as string)
    const actionId = (events.find((e) => e.type === "finish") as { data: { pending_actions: Array<{ id: string }> } }).data.pending_actions[0].id

    h.documents.get.mockResolvedValue({ data: { ...loadSampleDoc(), revisionId: "rev-9" } })
    const res = await request(app).post(`${base(seeded)}/actions/${actionId}/apply`).set(auth(seeded.token))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("GOOGLE_DOC_CHANGED")
    expect(h.documents.batchUpdate).not.toHaveBeenCalled()

    const dismissed = await request(app).post(`${base(seeded)}/actions/${actionId}/dismiss`).set(auth(seeded.token))
    expect(dismissed.body.data).toEqual({ dismissed: true, actionId })
    expect(await GooglePendingAction.countDocuments()).toBe(0)
  })

  it("đề xuất của người khác / id rác ⇒ 404; Viewer ⇒ 403", async () => {
    const seeded = await seedFixture("minimal")
    await connectGoogle(seeded)
    h.steps.push(toolStep([["insert_text", { atEnd: true, text: "Phụ lục B" }]]), textStep("ok"))
    const events = parseSse((await send(seeded, { message: "Thêm phụ lục" })).body as string)
    const actionId = (events.find((e) => e.type === "finish") as { data: { pending_actions: Array<{ id: string }> } }).data.pending_actions[0].id

    const teammate = await User.create({ email: "analyst-gd@flintflow.test", password: "test-password-123", emailVerified: true })
    await Membership.create({ organizationId: seeded.orgId, userId: teammate._id, role: "analyst" })
    const teammateToken = await authAs({ _id: teammate._id, email: "analyst-gd@flintflow.test", orgId: seeded.orgId })
    expect((await request(app).post(`${base(seeded)}/actions/${actionId}/apply`).set(auth(teammateToken))).status).toBe(404)
    expect((await request(app).post(`${base(seeded)}/actions/not-an-id/dismiss`).set(auth(seeded.token))).status).toBe(404)

    const viewer = await User.create({ email: "viewer-gda@flintflow.test", password: "test-password-123", emailVerified: true })
    await Membership.create({ organizationId: seeded.orgId, userId: viewer._id, role: "viewer" })
    const viewerToken = await authAs({ _id: viewer._id, email: "viewer-gda@flintflow.test", orgId: seeded.orgId })
    const res = await send(seeded, { message: "x" }, viewerToken)
    expect(res.status).toBe(403)
  })

  it("chưa nối Google ⇒ 401 JSON trước khi mở luồng, không trừ credit", async () => {
    const seeded = await seedFixture("minimal")
    const before = await balance(seeded)
    const res = await send(seeded, { message: "Đọc mục 2" })
    expect(res.status).toBe(401)
    expect(JSON.parse(res.body as string).error.code).toBe("GOOGLE_RECONNECT_REQUIRED")
    expect(await balance(seeded)).toBe(before)
  })

  it("model lỗi giữa chừng ⇒ sự kiện error, hoàn credit, không giữ credit treo", async () => {
    const seeded = await seedFixture("minimal")
    await connectGoogle(seeded)
    const before = await balance(seeded)
    h.steps.push(toolStep([["get_outline", { documentId: "doc-srs-1" }]]), new Error("provider overloaded"))

    const events = parseSse((await send(seeded, { message: "Tóm tắt" })).body as string)
    expect(events.at(-1)).toMatchObject({ type: "error" })
    expect(await balance(seeded)).toBe(before)
    const wallet = await CreditWallet.findOne({ organizationId: seeded.orgId }).lean()
    expect(wallet!.reserved).toBe(0)
  })

  it("body sai ⇒ 400 VALIDATION_ERROR; history quá 12 tin ⇒ 400", async () => {
    const seeded = await seedFixture("minimal")
    const empty = await send(seeded, { message: "  " })
    expect(empty.status).toBe(400)
    const history = Array.from({ length: 13 }, () => ({ role: "user", content: "x" }))
    expect((await send(seeded, { message: "x", history })).status).toBe(400)
  })
})
