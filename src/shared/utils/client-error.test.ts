import { describe, expect, it } from "vitest"
import { z } from "zod"
import { ApiError } from "./api-error.js"
import { AiActionError } from "../ai/ai-action.types.js"
import {
  AI_BAD_OUTPUT_MESSAGE,
  AI_NOT_CONFIGURED_MESSAGE,
  AI_OVERLOADED_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  CHANGE_DUPLICATE_MESSAGE,
  CHANGE_INVALID_RESULT_MESSAGE,
  CHANGE_TARGET_NOT_FOUND_MESSAGE,
  CorsRejectedError,
  GENERIC_BAD_REQUEST_MESSAGE,
  GENERIC_SERVER_MESSAGE,
  toClientError
} from "./client-error.js"
import { GENERIC_VALIDATION_MESSAGE } from "./validation-message.js"

const withProps = (message: string, props: Record<string, unknown>, name?: string): Error => {
  const err = new Error(message)
  if (name) err.name = name
  return Object.assign(err, props)
}

describe("toClientError (FLF-247)", () => {
  it("ApiError giữ nguyên status, code, câu và meta", () => {
    const err = new ApiError(409, "Bước S-4.2 đang chạy ở một request khác", "STEP_NOT_RUNNABLE", { run_id: "r1" })
    expect(toClientError(err)).toEqual({
      status: 409,
      code: "STEP_NOT_RUNNABLE",
      message: "Bước S-4.2 đang chạy ở một request khác",
      meta: { run_id: "r1" }
    })
  })

  it("lô op bị từ chối ⇒ câu theo luật vi phạm, path op chỉ ở meta", () => {
    const rejected = (rule: string) =>
      Object.assign(new ApiError(422, `Không resolve được path actors[id=A03].name ($new1)`, "OP_INVALID"), {
        violations: [{ rule, message: "actors[id=A03] không tồn tại", path: "actors[id=A03].name" }],
        referrers: []
      })
    const notFound = toClientError(rejected("path_not_resolved"))
    expect(notFound.status).toBe(422)
    expect(notFound.code).toBe("OP_INVALID")
    expect(notFound.message).toBe(CHANGE_TARGET_NOT_FOUND_MESSAGE)
    expect(notFound.meta).toEqual({
      violations: [{ rule: "path_not_resolved", message: "actors[id=A03] không tồn tại", path: "actors[id=A03].name" }],
      referrers: []
    })
    expect(toClientError(rejected("duplicate_id")).message).toBe(CHANGE_DUPLICATE_MESSAGE)
    expect(toClientError(rejected("schema_invalid")).message).toBe(CHANGE_INVALID_RESULT_MESSAGE)
  })

  it("AiActionError giữ status + code; câu theo nhóm lỗi, không text của provider", () => {
    const cases: [AiActionError, string][] = [
      [new AiActionError(502, "GLM không trả nội dung (finish_reason=length, max_tokens=4096)", "GLM_EMPTY_OUTPUT"), AI_UNAVAILABLE_MESSAGE],
      [new AiActionError(500, "Request failed with status code 500", "GEMINI_ERROR"), AI_UNAVAILABLE_MESSAGE],
      [new AiActionError(504, "Gemini gemini-3.5-flash không trả lời kịp (timeout)", "GEMINI_TIMEOUT"), AI_UNAVAILABLE_MESSAGE],
      [new AiActionError(500, "boom", "AI_EXECUTION_FAILED"), AI_UNAVAILABLE_MESSAGE],
      [new AiActionError(429, "Resource has been exhausted", "RATE_LIMIT_EXCEEDED"), AI_OVERLOADED_MESSAGE],
      [new AiActionError(503, "The model is overloaded", "GEMINI_OVERLOADED"), AI_OVERLOADED_MESSAGE],
      [new AiActionError(422, "AI response is not valid JSON for action 'draft'", "PARSE_FAILED"), AI_BAD_OUTPUT_MESSAGE],
      [new AiActionError(422, "Gemini response was truncated (MAX_TOKENS reached)", "RESPONSE_TRUNCATED"), AI_BAD_OUTPUT_MESSAGE],
      [new AiActionError(500, "Gemini API key is missing. Set GEMINI_API_KEY in environment.", "GEMINI_KEY_MISSING"), AI_NOT_CONFIGURED_MESSAGE],
      [new AiActionError(500, "Set MODAL_PROXY_TOKEN_ID", "MODAL_CREDENTIALS_MISSING"), AI_NOT_CONFIGURED_MESSAGE],
      [new AiActionError(500, "Provider x không hỗ trợ", "AI_PROVIDER_UNSUPPORTED"), AI_NOT_CONFIGURED_MESSAGE],
      [new AiActionError(500, "Thiếu MODAL_BASE_URL", "AI_PROVIDER_NOT_CONFIGURED"), AI_NOT_CONFIGURED_MESSAGE],
      [new AiActionError(500, "ledger lệch", "CREDIT_LEDGER_INCONSISTENT"), GENERIC_SERVER_MESSAGE]
    ]
    for (const [err, message] of cases) {
      const client = toClientError(err)
      expect(client, err.code).toMatchObject({ status: err.statusCode, code: err.code, message })
    }
  })

  it("AiActionError: hết credit giữ câu gốc + số credit ở meta; lỗi provider chỉ đưa logId", () => {
    const credit = new AiActionError(402, "Không đủ credit. Yêu cầu: 5 credit, Khả dụng: 2 credit.", "INSUFFICIENT_CREDIT", { cost: 5, available: 2 })
    expect(toClientError(credit)).toEqual({ status: 402, code: "INSUFFICIENT_CREDIT", message: credit.message, meta: { cost: 5, available: 2 } })

    const provider = new AiActionError(500, "raw", "GEMINI_ERROR", { error: { message: "raw provider body" }, logId: "log1" })
    expect(toClientError(provider).meta).toEqual({ logId: "log1" })
    expect(toClientError(new AiActionError(499, "Lượt gọi model bị huỷ (client đã đóng kết nối)", "AI_CALL_ABORTED")).message).toBe("Lượt chạy đã bị huỷ.")
  })

  it("lỗi body-parser", () => {
    expect(toClientError(withProps("Unexpected token } in JSON at position 3", { type: "entity.parse.failed", status: 400 }))).toEqual({
      status: 400,
      code: "BAD_REQUEST",
      message: "Dữ liệu gửi lên không đọc được. Vui lòng thử lại."
    })
    expect(toClientError(withProps("request entity too large", { type: "entity.too.large", status: 413 }))).toEqual({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "Dữ liệu gửi lên quá lớn."
    })
  })

  it("lỗi multer", () => {
    expect(toClientError(withProps("File too large", { code: "LIMIT_FILE_SIZE" }, "MulterError"))).toEqual({
      status: 413,
      code: "FILE_TOO_LARGE",
      message: "File quá lớn so với giới hạn cho phép."
    })
    expect(toClientError(withProps("Unexpected field", { code: "LIMIT_UNEXPECTED_FILE" }, "MulterError"))).toMatchObject({
      status: 400,
      code: "UPLOAD_FAILED"
    })
  })

  it("lỗi Mongoose / Mongo", () => {
    expect(toClientError(withProps('Cast to ObjectId failed for value "abc"', { kind: "ObjectId" }, "CastError"))).toEqual({
      status: 400,
      code: "INVALID_ID",
      message: "Đường dẫn hoặc mã định danh không hợp lệ."
    })
    expect(toClientError(withProps("E11000 duplicate key error collection: users index: email_1", { code: 11000 }, "MongoServerError"))).toEqual({
      status: 409,
      code: "DUPLICATE",
      message: "Dữ liệu này đã tồn tại."
    })
    expect(toClientError(withProps("User validation failed: email: Path `email` is required.", {}, "ValidationError"))).toEqual({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Dữ liệu không hợp lệ."
    })
  })

  it("ZodError lọt tới handler ⇒ 400 với câu của validationMessage", () => {
    const parsed = z.object({ base_version: z.number() }).safeParse({})
    if (parsed.success) throw new Error("phải trượt")
    expect(toClientError(parsed.error)).toMatchObject({ status: 400, code: "VALIDATION_ERROR", message: GENERIC_VALIDATION_MESSAGE })
  })

  it("CORS ⇒ 403 CORS_FORBIDDEN, không lộ origin", () => {
    expect(toClientError(new CorsRejectedError("https://evil.example"))).toEqual({
      status: 403,
      code: "CORS_FORBIDDEN",
      message: "Yêu cầu không được phép từ địa chỉ này."
    })
  })

  it("lỗi lạ ⇒ 500 câu chung; status < 500 có sẵn thì giữ status nhưng vẫn câu chung", () => {
    expect(toClientError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toEqual({
      status: 500,
      code: "INTERNAL_SERVER_ERROR",
      message: GENERIC_SERVER_MESSAGE
    })
    expect(toClientError(new Error("Không tìm thấy Spine của project"))).toMatchObject({ status: 500, message: GENERIC_SERVER_MESSAGE })
    expect(toClientError("boom")).toMatchObject({ status: 500, code: "INTERNAL_SERVER_ERROR" })
    expect(toClientError(withProps("Not Found", { status: 404 }))).toEqual({ status: 404, code: "NOT_FOUND", message: GENERIC_BAD_REQUEST_MESSAGE })
    expect(toClientError(withProps("weird", { statusCode: 418 }))).toEqual({ status: 418, code: "BAD_REQUEST", message: GENERIC_BAD_REQUEST_MESSAGE })
    expect(toClientError(withProps("upstream", { statusCode: 502 }))).toMatchObject({ status: 500, code: "INTERNAL_SERVER_ERROR" })
  })
})
