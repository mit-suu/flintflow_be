import crypto from "node:crypto"
import { describe, expect, it } from "vitest"
import { createSecretBox, isValidSecretBoxKey } from "./secret-box.js"

const newKey = () => crypto.randomBytes(32).toString("base64")

/** Đổi một byte ở phần `index` (1 = iv, 2 = tag, 3 = ciphertext) của bản mã. */
const flipByte = (sealed: string, index: number): string => {
  const parts = sealed.split(".")
  const bytes = Buffer.from(parts[index], "base64url")
  bytes[0] ^= 0x01
  parts[index] = bytes.toString("base64url")
  return parts.join(".")
}

describe("secret-box", () => {
  it("mã hoá rồi giải mã ra đúng chuỗi gốc, kể cả chữ có dấu", () => {
    const box = createSecretBox(newKey())
    const plain = "1//0g-refresh-token-giả-lập ✓"
    const sealed = box.seal(plain)
    expect(sealed).not.toContain(plain)
    expect(sealed.startsWith("v1.")).toBe(true)
    expect(box.open(sealed)).toBe(plain)
  })

  it("hai lần seal cùng một chuỗi cho hai bản mã khác nhau (IV ngẫu nhiên)", () => {
    const box = createSecretBox(newKey())
    expect(box.seal("abc")).not.toBe(box.seal("abc"))
  })

  it.each([
    ["iv", 1],
    ["tag", 2],
    ["ciphertext", 3]
  ])("sửa 1 byte ở %s ⇒ open báo lỗi", (_label, index) => {
    const box = createSecretBox(newKey())
    const sealed = box.seal("refresh-token")
    expect(() => box.open(flipByte(sealed, index))).toThrow()
  })

  it("sai khoá ⇒ open báo lỗi", () => {
    const sealed = createSecretBox(newKey()).seal("refresh-token")
    expect(() => createSecretBox(newKey()).open(sealed)).toThrow()
  })

  it("bản mã sai định dạng ⇒ báo lỗi", () => {
    const box = createSecretBox(newKey())
    expect(() => box.open("khong-phai-ban-ma")).toThrow(/định dạng/)
    expect(() => box.open("v2.a.b.c")).toThrow(/định dạng/)
  })

  it("khoá không đủ 32 byte ⇒ không tạo được box", () => {
    const short = crypto.randomBytes(16).toString("base64")
    expect(isValidSecretBoxKey(short)).toBe(false)
    expect(() => createSecretBox(short)).toThrow(/32 byte/)
    expect(isValidSecretBoxKey(newKey())).toBe(true)
  })
})
