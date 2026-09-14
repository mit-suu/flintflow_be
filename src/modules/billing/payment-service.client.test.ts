import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { env } from "../../config/env.js"
import {
  buildCallbackUrl,
  createPaymentOrder,
  getPaymentOrder,
  isPaymentServiceConfigured
} from "./payment-service.client.js"

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

describe("payment-service.client", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    env.PAYMENT_SERVICE_URL = "https://payments.example.com"
    env.PAYMENT_CLIENT_ID = "client_test"
    env.PAYMENT_API_KEY = "key_test"
    env.APP_PUBLIC_URL = "https://api.flintflow.test"
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("createPaymentOrder gửi header x-client-id/x-api-key và body theo guide", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        order_id: "o1",
        status: "pending",
        reference_code: "X9GUHMEJYV",
        payment_description: "PSX9GUHMEJYV",
        qr_code_url: "https://vietqr.app/img?des=PSX9GUHMEJYV"
      })
    )

    const order = await createPaymentOrder({
      amount: 49_000,
      description: "FlintFlow pack_100",
      callbackUrl: buildCallbackUrl()
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://payments.example.com/api/orders")
    expect(init.method).toBe("POST")
    expect(init.headers).toMatchObject({ "x-client-id": "client_test", "x-api-key": "key_test" })
    expect(JSON.parse(init.body)).toEqual({
      amount: 49_000,
      description: "FlintFlow pack_100",
      callback_url: "https://api.flintflow.test/api/v1/billing/payment-callback"
    })
    expect(order.payment_description).toBe("PSX9GUHMEJYV")
  })

  it("getPaymentOrder gọi GET /api/orders/:id", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { order_id: "o1", status: "paid" }))

    await expect(getPaymentOrder("o1")).resolves.toMatchObject({ status: "paid" })
    expect(fetchMock.mock.calls[0][0]).toBe("https://payments.example.com/api/orders/o1")
  })

  it("401 từ payment_service thành 502 (lỗi cấu hình BE, không phải lỗi đăng nhập user)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { message: "Unauthorized" }))

    await expect(getPaymentOrder("o1")).rejects.toMatchObject({ statusCode: 502, code: "PAYMENT_SERVICE_ERROR" })
  })

  it("404 giữ nguyên 404", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { message: "Order not found" }))

    await expect(getPaymentOrder("o1")).rejects.toMatchObject({ statusCode: 404 })
  })

  it("lỗi mạng/timeout thành 502 PAYMENT_SERVICE_UNAVAILABLE", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"))

    await expect(getPaymentOrder("o1")).rejects.toMatchObject({
      statusCode: 502,
      code: "PAYMENT_SERVICE_UNAVAILABLE"
    })
  })

  it("thiếu cấu hình thì 503 và không gọi mạng", async () => {
    env.PAYMENT_API_KEY = ""

    expect(isPaymentServiceConfigured()).toBe(false)
    await expect(getPaymentOrder("o1")).rejects.toMatchObject({ statusCode: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
