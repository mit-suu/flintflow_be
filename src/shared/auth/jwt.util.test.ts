import { describe, expect, it } from "vitest"
import { hashToken, signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from "./jwt.util.js"

describe("signRefreshToken", () => {
  it("cùng payload, cùng giây ⇒ vẫn ra token (và tokenHash) khác nhau", () => {
    const payload = { userId: "u1", email: "a@b.vn", role: "user" }
    const first = signRefreshToken(payload)
    const second = signRefreshToken(payload)

    expect(first).not.toBe(second)
    expect(hashToken(first)).not.toBe(hashToken(second))
    expect(verifyRefreshToken(second)).toMatchObject(payload)
  })
})

describe("signAccessToken", () => {
  it("bảo toàn sid và orgId trong payload khi giải mã", () => {
    const payload = { userId: "u1", email: "a@b.vn", role: "user", orgId: "org-1", sid: "sess-123" }
    const token = signAccessToken(payload)
    const decoded = verifyAccessToken(token)

    expect(decoded.sid).toBe("sess-123")
    expect(decoded.orgId).toBe("org-1")
    expect(decoded.userId).toBe("u1")
    expect(decoded.email).toBe("a@b.vn")
  })
})

