/**
 * secret-box.ts
 * ─────────────────────────────────────────────────────────────────
 * Mã hoá hai chiều cho bí mật phải lưu DB rồi đọc lại được (vd refresh token Google). Khác `bcrypt`/hash
 * ở chỗ cần lấy lại bản gốc.
 *
 * AES-256-GCM: mỗi lần `seal` một IV ngẫu nhiên 12 byte, tag xác thực 16 byte ⇒ sửa bất kỳ byte nào của
 * bản mã thì `open` ném lỗi thay vì trả rác. Định dạng lưu: `v1.<iv>.<tag>.<ciphertext>` (base64url), tiền
 * tố phiên bản để sau đổi thuật toán vẫn đọc được bản cũ.
 */
import crypto from "node:crypto"

const ALGORITHM = "aes-256-gcm"
const VERSION = "v1"
const IV_BYTES = 12
const TAG_BYTES = 16
export const SECRET_BOX_KEY_BYTES = 32

export interface SecretBox {
  seal: (plain: string) => string
  open: (sealed: string) => string
}

/** Khoá base64 có đúng 32 byte không — dùng cho cả validate env lẫn `createSecretBox`. */
export const isValidSecretBoxKey = (keyBase64: string): boolean =>
  Buffer.from(keyBase64, "base64").length === SECRET_BOX_KEY_BYTES

export const createSecretBox = (keyBase64: string): SecretBox => {
  const key = Buffer.from(keyBase64, "base64")
  if (key.length !== SECRET_BOX_KEY_BYTES) {
    throw new Error(`secret-box: khoá phải là ${SECRET_BOX_KEY_BYTES} byte base64`)
  }

  const seal = (plain: string): string => {
    const iv = crypto.randomBytes(IV_BYTES)
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
    const tag = cipher.getAuthTag()
    return [VERSION, iv, tag, ciphertext].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".")
  }

  const open = (sealed: string): string => {
    const parts = sealed.split(".")
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error("secret-box: bản mã sai định dạng")
    }
    const [iv, tag, ciphertext] = parts.slice(1).map((part) => Buffer.from(part, "base64url"))
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new Error("secret-box: bản mã sai định dạng")
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    // Tag không khớp (bản mã bị sửa hoặc sai khoá) ⇒ `final()` ném lỗi
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
  }

  return { seal, open }
}
