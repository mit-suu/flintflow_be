import crypto from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

const DRIVE = "https://www.googleapis.com/auth/drive.file"

const h = vi.hoisted(() => {
  type Row = Record<string, unknown> & { _id: string; userId: string }
  const rows = new Map<string, Row>()

  /** Query giả: `await` được và `.select()` được, như query Mongoose. */
  const query = (value: () => Row | null) => ({
    select() {
      return this
    },
    then(resolve: (v: Row | null) => unknown, reject: (e: unknown) => unknown) {
      return Promise.resolve(value()).then(resolve, reject)
    }
  })

  const GoogleConnection = {
    findOne: vi.fn((filter: { userId: string }) => query(() => rows.get(filter.userId) ?? null)),
    findOneAndUpdate: vi.fn(async (filter: { userId: string }, update: { $set: Record<string, unknown> }) => {
      const row = { _id: `conn-${filter.userId}`, ...(rows.get(filter.userId) ?? {}), userId: filter.userId, ...update.$set }
      rows.set(filter.userId, row)
      return row
    }),
    updateOne: vi.fn(async (filter: { userId: string; revokedAt: null }, update: { $set: Record<string, unknown> }) => {
      const row = rows.get(filter.userId)
      if (row && row.revokedAt === null) Object.assign(row, update.$set)
    }),
    deleteOne: vi.fn(async (filter: { _id: string }) => {
      for (const [key, row] of rows) if (row._id === filter._id) rows.delete(key)
    })
  }

  const client = {
    getToken: vi.fn(),
    verifyIdToken: vi.fn(),
    revokeToken: vi.fn(),
    setCredentials: vi.fn(),
    getAccessToken: vi.fn(),
    credentials: {} as Record<string, unknown>
  }
  client.setCredentials.mockImplementation((creds: Record<string, unknown>) => {
    client.credentials = { ...creds }
  })

  const env = { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_TOKEN_ENC_KEY: "" }
  return { rows, GoogleConnection, client, env }
})

vi.mock("./google-connection.model.js", () => ({ GoogleConnection: h.GoogleConnection }))
vi.mock("../../config/env.js", () => ({ env: h.env }))
vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn(function OAuth2Client() {
    return h.client
  })
}))

const service = await import("./google-auth.service.js")
const { createSecretBox } = await import("../../shared/crypto/secret-box.js")

const USER = "user-1"
const invalidGrant = () => Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } })

const givenGoogleTokens = (tokens: Record<string, unknown>) => {
  h.client.getToken.mockResolvedValue({ tokens })
  h.client.verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: "google-sub", email: "Mitsu@Gmail.com" }) })
}

const fullTokens = { scope: `openid email ${DRIVE}`, refresh_token: "refresh-123", id_token: "id-token" }

beforeEach(() => {
  vi.clearAllMocks()
  h.rows.clear()
  h.client.credentials = {}
  h.env.GOOGLE_CLIENT_SECRET = "secret"
  h.env.GOOGLE_TOKEN_ENC_KEY = crypto.randomBytes(32).toString("base64")
})

describe("isGoogleIntegrationEnabled", () => {
  it("thiếu secret hoặc khoá ⇒ tắt, mọi thao tác trả 503", async () => {
    h.env.GOOGLE_CLIENT_SECRET = ""
    expect(service.isGoogleIntegrationEnabled()).toBe(false)
    await expect(service.getStatus(USER)).rejects.toMatchObject({ statusCode: 503, code: "GOOGLE_INTEGRATION_DISABLED" })

    h.env.GOOGLE_CLIENT_SECRET = "secret"
    h.env.GOOGLE_TOKEN_ENC_KEY = ""
    await expect(service.connect(USER, "code")).rejects.toMatchObject({ code: "GOOGLE_INTEGRATION_DISABLED" })
  })
})

describe("connect", () => {
  it("lưu refresh token đã mã hoá, email chữ thường, trả trạng thái connected", async () => {
    givenGoogleTokens(fullTokens)
    const status = await service.connect(USER, "auth-code")

    expect(h.client.getToken).toHaveBeenCalledWith("auth-code")
    expect(status).toMatchObject({ status: "connected", email: "mitsu@gmail.com" })
    const row = h.rows.get(USER)!
    expect(row.refreshTokenSealed).not.toContain("refresh-123")
    expect(createSecretBox(h.env.GOOGLE_TOKEN_ENC_KEY).open(row.refreshTokenSealed as string)).toBe("refresh-123")
    expect(row).toMatchObject({ googleSub: "google-sub", revokedAt: null, scopes: ["openid", "email", DRIVE] })
  })

  it.each([
    ["thiếu scope drive.file", { ...fullTokens, scope: "openid email" }],
    ["thiếu refresh token (đã đồng ý trước đó)", { ...fullTokens, refresh_token: undefined }],
    ["thiếu id_token", { ...fullTokens, id_token: undefined }]
  ])("%s ⇒ 400 GOOGLE_CONSENT_INCOMPLETE, không lưu gì", async (_label, tokens) => {
    givenGoogleTokens(tokens)
    await expect(service.connect(USER, "code")).rejects.toMatchObject({ statusCode: 400, code: "GOOGLE_CONSENT_INCOMPLETE" })
    expect(h.rows.size).toBe(0)
  })

  it("mã uỷ quyền sai / đã dùng ⇒ 400 GOOGLE_CONSENT_INCOMPLETE; lỗi mạng thì giữ nguyên lỗi", async () => {
    h.client.getToken.mockRejectedValueOnce(invalidGrant())
    await expect(service.connect(USER, "code")).rejects.toMatchObject({ code: "GOOGLE_CONSENT_INCOMPLETE" })

    h.client.getToken.mockRejectedValueOnce(new Error("ECONNRESET"))
    await expect(service.connect(USER, "code")).rejects.toThrow("ECONNRESET")
  })

  it("nối lại sau khi bị thu hồi ⇒ xoá revokedAt", async () => {
    givenGoogleTokens(fullTokens)
    await service.connect(USER, "code")
    h.rows.get(USER)!.revokedAt = new Date()
    expect((await service.getStatus(USER)).status).toBe("reconnect_required")

    await service.connect(USER, "code-2")
    expect((await service.getStatus(USER)).status).toBe("connected")
  })
})

describe("getStatus", () => {
  it("chưa nối ⇒ disconnected", async () => {
    expect(await service.getStatus(USER)).toEqual({ status: "disconnected", email: null, connectedAt: null })
  })
})

describe("getAuthClient / getAccessToken", () => {
  beforeEach(async () => {
    givenGoogleTokens(fullTokens)
    await service.connect(USER, "code")
  })

  it("gắn refresh token đã giải mã và trả access token, không lộ refresh token", async () => {
    h.client.getAccessToken.mockImplementation(async () => {
      Object.assign(h.client.credentials, { access_token: "access-xyz", expiry_date: 1_900_000_000_000 })
      return { token: "access-xyz" }
    })
    const token = await service.getAccessToken(USER)

    expect(h.client.setCredentials).toHaveBeenCalledWith({ refresh_token: "refresh-123" })
    expect(token).toEqual({ accessToken: "access-xyz", expiresAt: 1_900_000_000_000 })
    expect(JSON.stringify(token)).not.toContain("refresh-123")
  })

  it("Google trả invalid_grant ⇒ đánh dấu revokedAt và 401 GOOGLE_RECONNECT_REQUIRED", async () => {
    h.client.getAccessToken.mockRejectedValue(invalidGrant())
    await expect(service.getAuthClient(USER)).rejects.toMatchObject({ statusCode: 401, code: "GOOGLE_RECONNECT_REQUIRED" })
    expect(h.rows.get(USER)!.revokedAt).toBeInstanceOf(Date)
    expect((await service.getStatus(USER)).status).toBe("reconnect_required")

    // Đã đánh dấu ⇒ lần sau báo ngay, không gọi Google nữa
    h.client.getAccessToken.mockClear()
    await expect(service.getAccessToken(USER)).rejects.toMatchObject({ code: "GOOGLE_RECONNECT_REQUIRED" })
    expect(h.client.getAccessToken).not.toHaveBeenCalled()
  })

  it("đổi khoá mã hoá ⇒ không giải mã được ⇒ cần nối lại", async () => {
    h.env.GOOGLE_TOKEN_ENC_KEY = crypto.randomBytes(32).toString("base64")
    await expect(service.getAuthClient(USER)).rejects.toMatchObject({ code: "GOOGLE_RECONNECT_REQUIRED" })
    expect(h.rows.get(USER)!.revokedAt).toBeInstanceOf(Date)
  })

  it("lỗi khác của Google (mạng) ⇒ giữ nguyên, không đánh dấu thu hồi", async () => {
    h.client.getAccessToken.mockRejectedValue(new Error("ETIMEDOUT"))
    await expect(service.getAuthClient(USER)).rejects.toThrow("ETIMEDOUT")
    expect(h.rows.get(USER)!.revokedAt).toBeNull()
  })

  it("chưa nối ⇒ 401 GOOGLE_RECONNECT_REQUIRED", async () => {
    await expect(service.getAuthClient("user-khac")).rejects.toMatchObject({ code: "GOOGLE_RECONNECT_REQUIRED" })
  })
})

describe("disconnect", () => {
  it("thu hồi token phía Google rồi xoá bản ghi", async () => {
    givenGoogleTokens(fullTokens)
    await service.connect(USER, "code")
    h.client.revokeToken.mockResolvedValue({})

    expect(await service.disconnect(USER)).toMatchObject({ status: "disconnected" })
    expect(h.client.revokeToken).toHaveBeenCalledWith("refresh-123")
    expect(h.rows.size).toBe(0)
  })

  it("thu hồi lỗi (mạng, token đã chết) ⇒ vẫn xoá", async () => {
    givenGoogleTokens(fullTokens)
    await service.connect(USER, "code")
    h.client.revokeToken.mockRejectedValue(new Error("network down"))
    vi.spyOn(console, "warn").mockImplementation(() => {})

    await service.disconnect(USER)
    expect(h.rows.size).toBe(0)
  })

  it("chưa nối ⇒ vẫn thành công, không gọi Google", async () => {
    expect(await service.disconnect(USER)).toMatchObject({ status: "disconnected" })
    expect(h.client.revokeToken).not.toHaveBeenCalled()
  })
})
