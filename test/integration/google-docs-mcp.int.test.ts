/**
 * MCP server Google Docs (contract #47) qua HTTP thật: JSON-RPC Streamable HTTP stateless sau `authMiddleware →
 * requireActiveAccount`. Google (OAuth + Docs API) được mock.
 */
import crypto from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { env } from "../../src/config/env.js"
import { loadSampleDoc } from "../../src/modules/google/docs-mcp/docs-test-fixture.js"
import { seedFixture, type SeededFixture } from "../setup.js"

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"
const MCP_URL = "/api/v1/mcp/google-docs"

const google = vi.hoisted(() => ({
  getToken: vi.fn(),
  verifyIdToken: vi.fn(),
  getAccessToken: vi.fn(),
  documents: { get: vi.fn(), batchUpdate: vi.fn() }
}))

vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn(function OAuth2Client() {
    return {
      getToken: google.getToken,
      verifyIdToken: google.verifyIdToken,
      revokeToken: vi.fn(),
      credentials: {},
      setCredentials() {},
      getAccessToken: google.getAccessToken
    }
  })
}))
vi.mock("@googleapis/docs", () => ({ docs: vi.fn(() => ({ documents: google.documents })) }))

const rpc = (seeded: SeededFixture | null, method: string, params: Record<string, unknown> = {}, id = 1) => {
  const req = request(app).post(MCP_URL).set("Accept", "application/json, text/event-stream").send({ jsonrpc: "2.0", id, method, params })
  return seeded ? req.set("Authorization", `Bearer ${seeded.token}`) : req
}

const toolText = (res: { body: { result: { content: Array<{ text: string }>; isError?: boolean } } }) => ({
  isError: Boolean(res.body.result.isError),
  data: JSON.parse(res.body.result.content[0].text)
})

const connectGoogle = async (seeded: SeededFixture) => {
  google.getToken.mockResolvedValue({ tokens: { scope: `openid email ${DRIVE_SCOPE}`, refresh_token: "refresh", id_token: "id" } })
  google.verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: "sub", email: "owner@gmail.com" }) })
  const res = await request(app).post("/api/v1/integrations/google/connect").set("Authorization", `Bearer ${seeded.token}`).send({ code: "c" })
  expect(res.status).toBe(200)
}

beforeEach(() => {
  vi.clearAllMocks()
  env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com"
  env.GOOGLE_CLIENT_SECRET = "test-client-secret"
  env.GOOGLE_TOKEN_ENC_KEY = crypto.randomBytes(32).toString("base64")
  google.getAccessToken.mockResolvedValue({ token: "access" })
  google.documents.get.mockResolvedValue({ data: loadSampleDoc() })
})

describe("POST /api/v1/mcp/google-docs", () => {
  it("initialize + tools/list chạy được kể cả khi chưa nối Google; tool đọc khi chưa nối ⇒ GOOGLE_RECONNECT_REQUIRED", async () => {
    const seeded = await seedFixture("minimal")
    const init = await rpc(seeded, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "inspector", version: "1.0.0" }
    })
    expect(init.status).toBe(200)
    expect(init.body.result.serverInfo.name).toBe("flintflow-google-docs")

    const list = await rpc(seeded, "tools/list")
    expect(list.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "get_outline",
      "insert_text",
      "read_section",
      "replace_text",
      "search_text"
    ])

    const call = await rpc(seeded, "tools/call", { name: "get_outline", arguments: { documentId: "doc-srs-1" } })
    expect(toolText(call)).toMatchObject({ isError: true, data: { error: { code: "GOOGLE_RECONNECT_REQUIRED" } } })
    expect(google.documents.get).not.toHaveBeenCalled()
  })

  it("đã nối Google ⇒ get_outline đọc tài liệu bằng quyền của chính người gọi", async () => {
    const seeded = await seedFixture("minimal")
    await connectGoogle(seeded)
    const call = await rpc(seeded, "tools/call", { name: "get_outline", arguments: { documentId: "doc-srs-1" } })
    const result = toolText(call)
    expect(result.isError).toBe(false)
    expect(result.data).toMatchObject({ title: "SRS Ticket Booking", revisionId: "rev-1" })
    expect(result.data.headings).toHaveLength(6)
  })

  it("không có token ⇒ 401; tắt tích hợp ⇒ 503 GOOGLE_INTEGRATION_DISABLED; GET ⇒ 405", async () => {
    expect((await rpc(null, "tools/list")).status).toBe(401)

    const seeded = await seedFixture("minimal")
    env.GOOGLE_CLIENT_SECRET = ""
    const disabled = await rpc(seeded, "tools/list")
    expect(disabled.status).toBe(503)
    expect(disabled.body.error.code).toBe("GOOGLE_INTEGRATION_DISABLED")

    const get = await request(app).get(MCP_URL).set("Authorization", `Bearer ${seeded.token}`)
    expect(get.status).toBe(405)
  })
})
