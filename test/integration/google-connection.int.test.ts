/**
 * Kết nối Google qua HTTP trên Mongo thật: nối, xem trạng thái, lấy access token, ngắt kết nối; refresh token chỉ
 * nằm trong DB dưới dạng đã mã hoá và không bao giờ ra response. Google được mock ở `google-auth-library`.
 */
import crypto from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { env } from "../../src/config/env.js"
import { GoogleConnection } from "../../src/modules/google/google-connection.model.js"
import { seedFixture, type SeededFixture } from "../setup.js"

const DRIVE = "https://www.googleapis.com/auth/drive.file"

const google = vi.hoisted(() => ({
  getToken: vi.fn(),
  verifyIdToken: vi.fn(),
  revokeToken: vi.fn(),
  getAccessToken: vi.fn()
}))

vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn(function OAuth2Client() {
    const client = {
      ...google,
      credentials: {} as Record<string, unknown>,
      setCredentials(creds: Record<string, unknown>) {
        client.credentials = { ...creds }
      },
      async getAccessToken() {
        const result = await google.getAccessToken()
        client.credentials = { ...client.credentials, access_token: result.token, expiry_date: result.expiry }
        return result
      }
    }
    return client
  })
}))

const as = (seeded: SeededFixture) => ({ Authorization: `Bearer ${seeded.token}` })
const BASE = "/api/v1/integrations/google"

const givenConsent = (scope = `openid email ${DRIVE}`) => {
  google.getToken.mockResolvedValue({ tokens: { scope, refresh_token: "refresh-secret-123", id_token: "id-token" } })
  google.verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: "google-sub", email: "drive.owner@gmail.com" }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com"
  env.GOOGLE_CLIENT_SECRET = "test-client-secret"
  env.GOOGLE_TOKEN_ENC_KEY = crypto.randomBytes(32).toString("base64")
})

describe("integrations/google", () => {
  it("nối → status → access token → ngắt kết nối", async () => {
    const seeded = await seedFixture("minimal")
    expect((await request(app).get(`${BASE}/status`).set(as(seeded))).body.data).toEqual({
      status: "disconnected",
      email: null,
      connectedAt: null
    })

    givenConsent()
    const connected = await request(app).post(`${BASE}/connect`).set(as(seeded)).send({ code: "auth-code" })
    expect(connected.status).toBe(200)
    expect(connected.body.data).toMatchObject({ status: "connected", email: "drive.owner@gmail.com" })
    expect(JSON.stringify(connected.body)).not.toContain("refresh-secret-123")

    // Trong Mongo chỉ có bản mã
    const stored = await GoogleConnection.findOne({ userId: seeded.userId }).select("+refreshTokenSealed").lean()
    expect(stored?.refreshTokenSealed).toBeTruthy()
    expect(stored?.refreshTokenSealed).not.toContain("refresh-secret-123")

    const status = await request(app).get(`${BASE}/status`).set(as(seeded))
    expect(status.body.data).toMatchObject({ status: "connected", email: "drive.owner@gmail.com" })

    google.getAccessToken.mockResolvedValue({ token: "access-abc", expiry: 1_900_000_000_000 })
    const token = await request(app).get(`${BASE}/access-token`).set(as(seeded))
    expect(token.status).toBe(200)
    expect(token.headers["cache-control"]).toBe("no-store")
    expect(token.body.data).toEqual({ accessToken: "access-abc", expiresAt: 1_900_000_000_000 })
    expect(JSON.stringify(token.body)).not.toContain("refresh-secret-123")

    google.revokeToken.mockResolvedValue({})
    const removed = await request(app).delete(BASE).set(as(seeded))
    expect(removed.status).toBe(200)
    expect(removed.body.data.status).toBe("disconnected")
    expect(google.revokeToken).toHaveBeenCalledWith("refresh-secret-123")
    expect(await GoogleConnection.countDocuments({ userId: seeded.userId })).toBe(0)
  })

  it("thiếu quyền drive.file ⇒ 400 GOOGLE_CONSENT_INCOMPLETE; code rỗng ⇒ 400 VALIDATION_ERROR", async () => {
    const seeded = await seedFixture("minimal")
    givenConsent("openid email")
    const res = await request(app).post(`${BASE}/connect`).set(as(seeded)).send({ code: "auth-code" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("GOOGLE_CONSENT_INCOMPLETE")

    const empty = await request(app).post(`${BASE}/connect`).set(as(seeded)).send({ code: " " })
    expect(empty.status).toBe(400)
    expect(empty.body.error.code).toBe("VALIDATION_ERROR")
  })

  it("body dạng form (CSRF từ trang khác site) ⇒ 415, không gọi Google", async () => {
    const seeded = await seedFixture("minimal")
    givenConsent()
    const res = await request(app).post(`${BASE}/connect`).set(as(seeded)).type("form").send({ code: "auth-code" })
    expect(res.status).toBe(415)
    expect(res.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE")
    expect(google.getToken).not.toHaveBeenCalled()
  })

  it("Google thu hồi quyền ⇒ 401 GOOGLE_RECONNECT_REQUIRED, status thành reconnect_required", async () => {
    const seeded = await seedFixture("minimal")
    givenConsent()
    await request(app).post(`${BASE}/connect`).set(as(seeded)).send({ code: "auth-code" })

    google.getAccessToken.mockRejectedValue(Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } }))
    const res = await request(app).get(`${BASE}/access-token`).set(as(seeded))
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe("GOOGLE_RECONNECT_REQUIRED")
    expect((await request(app).get(`${BASE}/status`).set(as(seeded))).body.data.status).toBe("reconnect_required")
  })

  it("mỗi user chỉ thấy kết nối của mình", async () => {
    const owner = await seedFixture("minimal")
    const other = await seedFixture("minimal")
    givenConsent()
    await request(app).post(`${BASE}/connect`).set(as(owner)).send({ code: "auth-code" })

    expect((await request(app).get(`${BASE}/status`).set(as(other))).body.data.status).toBe("disconnected")
    const token = await request(app).get(`${BASE}/access-token`).set(as(other))
    expect(token.status).toBe(401)
    expect(token.body.error.code).toBe("GOOGLE_RECONNECT_REQUIRED")
  })

  it("thiếu secret ⇒ 503 GOOGLE_INTEGRATION_DISABLED; không token ⇒ 401", async () => {
    const seeded = await seedFixture("minimal")
    env.GOOGLE_CLIENT_SECRET = ""
    const res = await request(app).get(`${BASE}/status`).set(as(seeded))
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe("GOOGLE_INTEGRATION_DISABLED")

    expect((await request(app).get(`${BASE}/status`)).status).toBe(401)
  })
})
