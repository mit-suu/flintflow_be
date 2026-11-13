import { describe, it, expect } from "vitest"
import { ApiError } from "../../shared/utils/api-error.js"
import { checkReferenceTokens, DOCUMENT_TOO_LONG, PROJECT_DOCUMENT_QUOTA_EXCEEDED } from "./document-token-limit.js"

const base = { file: "bien-ban.docx", perUpload: 100, perProject: 300 }

const errorOf = (fn: () => void): ApiError => {
  try {
    fn()
  } catch (err) {
    if (err instanceof ApiError) return err
    throw err
  }
  throw new Error("không throw")
}

describe("FLF-405 checkReferenceTokens", () => {
  it("dưới cả hai trần ⇒ qua; đúng bằng trần vẫn qua", () => {
    expect(() => checkReferenceTokens({ ...base, tokenCount: 100, used: 200 })).not.toThrow()
  })

  it("vượt trần một lần tải ⇒ 413 DOCUMENT_TOO_LONG kèm số token + trần, gợi ý tách file", () => {
    const err = errorOf(() => checkReferenceTokens({ ...base, tokenCount: 101, used: 0 }))
    expect(err.statusCode).toBe(413)
    expect(err.code).toBe(DOCUMENT_TOO_LONG)
    expect(err.meta).toEqual({ file: "bien-ban.docx", token_count: 101, limit: 100 })
    expect(err.message).toContain("tách file hoặc chỉ giữ phần liên quan")
  })

  it("tổng dự án vượt ⇒ 413 PROJECT_DOCUMENT_QUOTA_EXCEEDED kèm used + limit", () => {
    const err = errorOf(() => checkReferenceTokens({ ...base, tokenCount: 50, used: 260 }))
    expect(err.statusCode).toBe(413)
    expect(err.code).toBe(PROJECT_DOCUMENT_QUOTA_EXCEEDED)
    expect(err.meta).toEqual({ file: "bien-ban.docx", token_count: 50, used: 260, limit: 300 })
    expect(err.message).toContain("chỉ giữ phần liên quan")
  })

  it("vượt cả hai ⇒ báo trần một lần tải trước", () => {
    expect(errorOf(() => checkReferenceTokens({ ...base, tokenCount: 500, used: 300 })).code).toBe(DOCUMENT_TOO_LONG)
  })
})
