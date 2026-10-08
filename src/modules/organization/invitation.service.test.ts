import { describe, it, expect } from "vitest"
import { generateCode, hashCode, invitationState, normalizeCode, ROLE_LABELS } from "./invitation.service.js"
import { INVITABLE_ROLES } from "./invitation.model.js"

const at = (offsetMs: number) => new Date(Date.now() + offsetMs)

describe("mã mời (UC-08/UC-09)", () => {
  it("không chứa ký tự dễ đọc nhầm (0 O 1 I L)", () => {
    const sample = Array.from({ length: 50 }, () => generateCode(20)).join("")
    expect(sample).not.toMatch(/[01OIL]/)
  })

  it("mã sinh ra đủ dài và khác nhau", () => {
    expect(generateCode(10)).toHaveLength(10)
    const many = new Set(Array.from({ length: 200 }, () => generateCode()))
    expect(many.size).toBe(200)
  })

  it("gõ tay kiểu nào cũng ra cùng một hash", () => {
    const code = generateCode()
    const typed = code.toLowerCase().replace(/(.{4})/, "$1-")
    expect(normalizeCode(typed)).toBe(code)
    expect(hashCode(typed)).toBe(hashCode(code))
  })

  it("hash chứ không lưu mã thô", () => {
    const code = "ABCD234567"
    expect(hashCode(code)).toHaveLength(64)
    expect(hashCode(code)).not.toContain(code)
  })
})

describe("trạng thái mã mời là giá trị suy diễn", () => {
  it("còn hạn, chưa dùng, chưa thu hồi ⇒ pending", () => {
    expect(invitationState({ expiresAt: at(60_000) })).toBe("pending")
  })

  it("quá hạn ⇒ expired", () => {
    expect(invitationState({ expiresAt: at(-1) })).toBe("expired")
  })

  it("đã dùng ⇒ accepted, kể cả khi còn hạn", () => {
    expect(invitationState({ expiresAt: at(60_000), acceptedAt: new Date() })).toBe("accepted")
  })

  it("thu hồi thắng mọi trạng thái khác", () => {
    expect(
      invitationState({ expiresAt: at(60_000), acceptedAt: new Date(), revokedAt: new Date() })
    ).toBe("revoked")
  })
})

describe("vai trò mời được", () => {
  it("chỉ Analyst và Viewer, có nhãn hiển thị cho cả hai", () => {
    expect([...INVITABLE_ROLES]).toEqual(["analyst", "viewer"])
    for (const role of INVITABLE_ROLES) expect(ROLE_LABELS[role]).toBeTruthy()
  })
})
