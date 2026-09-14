/**
 * payment-service.client.ts
 * ─────────────────────────────────────────────────────────────────
 * Client cho `payment_service` dùng chung (VietQR + SePay). FlintFlow không
 * nói chuyện với SePay; chỉ tạo order, đọc trạng thái order và nhận callback.
 * Hợp đồng: claude_plan/PAYMENT_SERVICE_INTEGRATION_GUIDE.md.
 *
 * API key chỉ nằm ở BE — không bao giờ gọi service này từ trình duyệt.
 */
import { env } from "../../config/env.js"
import { ApiError } from "../../shared/utils/api-error.js"

export type PaymentServiceOrderStatus = "pending" | "paid" | "failed" | (string & {})

export interface CreatePaymentOrderInput {
  /** VND, số nguyên dương */
  amount: number
  description: string
  callbackUrl: string
}

export interface CreatePaymentOrderResponse {
  order_id: string
  status: PaymentServiceOrderStatus
  reference_code: string
  payment_description: string
  qr_code_url: string
}

export interface PaymentServiceOrder {
  order_id: string
  client_id: string
  amount: number
  description: string
  reference_code: string
  callback_url: string
  status: PaymentServiceOrderStatus
  sepay_transaction_id: number | null
  created_at: string
  paid_at: string | null
}

export const CALLBACK_PATH = "/api/v1/billing/payment-callback"

export const isPaymentServiceConfigured = (): boolean =>
  Boolean(env.PAYMENT_SERVICE_URL && env.PAYMENT_CLIENT_ID && env.PAYMENT_API_KEY)

export const buildCallbackUrl = (): string => new URL(CALLBACK_PATH, env.APP_PUBLIC_URL).toString()

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  if (!isPaymentServiceConfigured()) {
    throw new ApiError(503, "Cổng thanh toán chưa được cấu hình", "PAYMENT_SERVICE_NOT_CONFIGURED")
  }

  const url = new URL(path, env.PAYMENT_SERVICE_URL).toString()
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "x-client-id": env.PAYMENT_CLIENT_ID,
        "x-api-key": env.PAYMENT_API_KEY
      },
      signal: AbortSignal.timeout(env.PAYMENT_SERVICE_TIMEOUT_MS)
    })
  } catch (error) {
    console.error(`[PaymentService] ${init.method ?? "GET"} ${path} failed:`, error)
    throw new ApiError(502, "Không kết nối được cổng thanh toán", "PAYMENT_SERVICE_UNAVAILABLE")
  }

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>

  if (!response.ok) {
    const upstreamMessage = typeof body.message === "string" ? body.message : `HTTP ${response.status}`
    console.error(`[PaymentService] ${init.method ?? "GET"} ${path} → ${response.status}: ${upstreamMessage}`)

    if (response.status === 404) {
      throw new ApiError(404, "Không tìm thấy order trên cổng thanh toán", "PAYMENT_ORDER_NOT_FOUND")
    }
    // 401 ở đây là lỗi cấu hình client_id/api_key của BE, không phải lỗi đăng nhập
    // của người dùng — không trả 401 để FE không kích hoạt refresh token.
    throw new ApiError(502, "Cổng thanh toán từ chối yêu cầu", "PAYMENT_SERVICE_ERROR")
  }

  return body as T
}

export const createPaymentOrder = (input: CreatePaymentOrderInput) =>
  request<CreatePaymentOrderResponse>("/api/orders", {
    method: "POST",
    body: JSON.stringify({
      amount: input.amount,
      description: input.description,
      callback_url: input.callbackUrl
    })
  })

export const getPaymentOrder = (orderId: string) =>
  request<PaymentServiceOrder>(`/api/orders/${encodeURIComponent(orderId)}`)
