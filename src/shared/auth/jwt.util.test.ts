import { describe, expect, it } from "vitest"
import { hashToken, signRefreshToken, verifyRefreshToken } from "./jwt.util.js"

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
