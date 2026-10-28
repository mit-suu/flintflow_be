import { describe, expect, it } from "vitest"
import { ApiError } from "../../shared/utils/api-error.js"
import { AiActionError } from "../../shared/ai/ai-action.types.js"
import { isAiErrorCode, runErrorOf, toPipelineErrorCode } from "./pipeline-error-code.js"

describe("pipeline-error-code (FLF-332)", () => {
  it("toPipelineErrorCode: mã trong bảng giữ nguyên; 429 ⇒ RATE_LIMIT_EXCEEDED; provider 5xx ⇒ AI_PROVIDER_ERROR; 400 ⇒ VALIDATION_ERROR; khác ⇒ NOT_IMPLEMENTED", () => {
    expect(toPipelineErrorCode(new AiActionError(402, "hết credit", "INSUFFICIENT_CREDIT"))).toBe("INSUFFICIENT_CREDIT")
    expect(toPipelineErrorCode(new AiActionError(429, "quá nhanh", "GLM_RATE_LIMIT"))).toBe("RATE_LIMIT_EXCEEDED")
    expect(toPipelineErrorCode(new AiActionError(502, "provider", "GLM_EMPTY_OUTPUT"))).toBe("AI_PROVIDER_ERROR")
    expect(toPipelineErrorCode(new ApiError(400, "đầu vào", "BAD_INPUT"))).toBe("VALIDATION_ERROR")
    expect(toPipelineErrorCode(new Error("boom"))).toBe("NOT_IMPLEMENTED")
  })

  it("runErrorOf: AiActionError không còn thành UNKNOWN — cùng mã với sự kiện SSE để run-state biết lượt gãy vì AI", () => {
    expect(runErrorOf(new AiActionError(503, "Nhà cung cấp AI lỗi", "GLM_ERROR")).code).toBe("AI_PROVIDER_ERROR")
    expect(runErrorOf(new ApiError(409, "lệch version", "SPINE_VERSION_CONFLICT")).code).toBe("SPINE_VERSION_CONFLICT")
    expect(runErrorOf(new Error("raw provider text")).code).toBe("UNKNOWN")
  })

  it("isAiErrorCode: provider / hạn mức / thực thi / parse là AI lỗi; hết credit và xung đột version thì không", () => {
    for (const code of ["AI_PROVIDER_ERROR", "RATE_LIMIT_EXCEEDED", "AI_EXECUTION_FAILED", "PARSE_FAILED", "SCHEMA_MISMATCH"]) expect(isAiErrorCode(code)).toBe(true)
    for (const code of ["INSUFFICIENT_CREDIT", "SPINE_VERSION_CONFLICT", "UNKNOWN", null, undefined]) expect(isAiErrorCode(code)).toBe(false)
  })
})
