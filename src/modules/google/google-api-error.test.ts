import { describe, expect, it } from "vitest"
import { ApiError } from "../../shared/utils/api-error.js"
import { googleErrorStatus, isInvalidGrant, toGoogleApiError } from "./google-api-error.js"

/** Lỗi dạng gaxios: `response.status` + `response.data.error.errors[].reason`. */
const gaxios = (status: number, reason?: string) =>
  Object.assign(new Error(`HTTP ${status}`), {
    status,
    response: { status, data: { error: reason ? { code: status, errors: [{ reason }] } : { code: status } } }
  })

const code = (err: unknown) => (err as ApiError).code

describe("toGoogleApiError", () => {
  it("401 và invalid_grant ⇒ GOOGLE_RECONNECT_REQUIRED", () => {
    expect(code(toGoogleApiError(gaxios(401)))).toBe("GOOGLE_RECONNECT_REQUIRED")
    const grant = Object.assign(new Error("invalid_grant"), { response: { status: 400, data: { error: "invalid_grant" } } })
    expect(isInvalidGrant(grant)).toBe(true)
    expect(code(toGoogleApiError(grant))).toBe("GOOGLE_RECONNECT_REQUIRED")
  })

  it("403 do hết hạn mức / dung lượng và 429 ⇒ 503 GOOGLE_DRIVE_QUOTA_EXCEEDED, không phải bị cấm", () => {
    for (const err of [gaxios(403, "storageQuotaExceeded"), gaxios(403, "userRateLimitExceeded"), gaxios(429)]) {
      expect(toGoogleApiError(err)).toMatchObject({ statusCode: 503, code: "GOOGLE_DRIVE_QUOTA_EXCEEDED" })
    }
  })

  it("403 khác ⇒ GOOGLE_FILE_FORBIDDEN; 404 ⇒ GOOGLE_FILE_NOT_FOUND", () => {
    expect(toGoogleApiError(gaxios(403, "insufficientFilePermissions"))).toMatchObject({ statusCode: 403, code: "GOOGLE_FILE_FORBIDDEN" })
    expect(toGoogleApiError(gaxios(404, "notFound"))).toMatchObject({ statusCode: 404, code: "GOOGLE_FILE_NOT_FOUND" })
  })

  it("lỗi mạng / 5xx giữ nguyên; ApiError giữ nguyên", () => {
    const network = new Error("ECONNRESET")
    expect(toGoogleApiError(network)).toBe(network)
    const server = gaxios(500)
    expect(toGoogleApiError(server)).toBe(server)
    const api = new ApiError(409, "x", "X")
    expect(toGoogleApiError(api)).toBe(api)
  })

  it("googleErrorStatus đọc được cả `response.status`, `status` và `code` số", () => {
    expect(googleErrorStatus({ response: { status: 404 } })).toBe(404)
    expect(googleErrorStatus({ status: 403 })).toBe(403)
    expect(googleErrorStatus({ code: 429 })).toBe(429)
    expect(googleErrorStatus({ code: "ECONNRESET" })).toBeUndefined()
    expect(googleErrorStatus(null)).toBeUndefined()
  })
})
