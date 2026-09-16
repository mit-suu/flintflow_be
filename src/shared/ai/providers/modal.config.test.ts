/**
 * `modalBaseUrl()` — thiếu cấu hình phải là lỗi ồn ào (T24).
 *
 * Mock hẳn module `env` thay vì dựa vào `process.env`: `env.ts` gọi `dotenv.config()` lúc import, nên
 * một test đọc biến thật sẽ **xanh trên máy có `.env` và đỏ ở CI** — đúng lỗi đã làm đỏ lượt chạy CI
 * đầu tiên của T24.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const envMock = vi.hoisted(() => ({ MODAL_BASE_URL: "" }))
vi.mock("../../../config/env.js", () => ({ env: envMock }))

import { MODAL_BASE_URL_MISSING, modalBaseUrl } from "./modal.config.js"

beforeEach(() => {
  envMock.MODAL_BASE_URL = ""
  delete process.env.MODAL_BASE_URL
})

describe("modalBaseUrl", () => {
  it("không cấu hình ở đâu cả ⇒ ném AI_PROVIDER_NOT_CONFIGURED", () => {
    expect(() => modalBaseUrl()).toThrowError(expect.objectContaining({ code: MODAL_BASE_URL_MISSING, statusCode: 500 }))
  })

  it("chỉ có khoảng trắng cũng coi như chưa cấu hình", () => {
    envMock.MODAL_BASE_URL = "   "
    expect(() => modalBaseUrl()).toThrowError(expect.objectContaining({ code: MODAL_BASE_URL_MISSING }))
  })

  it("lấy từ env đã validate và cắt khoảng trắng", () => {
    envMock.MODAL_BASE_URL = "  https://modal.test/v1  "
    expect(modalBaseUrl()).toBe("https://modal.test/v1")
  })

  it("env rỗng thì đọc process.env — env đóng băng lúc import, script/test đặt biến sau đó", () => {
    process.env.MODAL_BASE_URL = "https://late.test/v1"
    expect(modalBaseUrl()).toBe("https://late.test/v1")
  })

  it("env có giá trị thì thắng process.env", () => {
    envMock.MODAL_BASE_URL = "https://from-env.test/v1"
    process.env.MODAL_BASE_URL = "https://from-process.test/v1"
    expect(modalBaseUrl()).toBe("https://from-env.test/v1")
  })
})
