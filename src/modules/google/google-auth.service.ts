/**
 * google-auth.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Kết nối tài khoản Google với quyền `drive.file` (luồng auth-code qua popup, `redirect_uri = "postmessage"`).
 * BE giữ refresh token đã mã hoá và cấp `OAuth2Client` / access token cho các tính năng Google Docs.
 *
 * Tách hẳn khỏi đăng nhập Google (`auth.service.ts` `googleAuth`): luồng đó chỉ nhận access token để đọc
 * userinfo, không có refresh token và không có scope Drive.
 *
 * Không bao giờ trả refresh token ra ngoài service này.
 */
import { OAuth2Client, type Credentials } from "google-auth-library"
import { env } from "../../config/env.js"
import { createSecretBox, type SecretBox } from "../../shared/crypto/secret-box.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { GoogleConnection, type IGoogleConnection } from "./google-connection.model.js"
import { isInvalidGrant, reconnectRequired } from "./google-api-error.js"

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"

/** `redirect_uri` của luồng popup auth-code (`useGoogleLogin({ flow: "auth-code" })` ở FE). */
const POPUP_REDIRECT_URI = "postmessage"

export type GoogleConnectionState = "connected" | "disconnected" | "reconnect_required"

export interface GoogleConnectionStatus {
  status: GoogleConnectionState
  email: string | null
  connectedAt: Date | null
}

export interface GoogleAccessToken {
  accessToken: string
  /** Mốc hết hạn (epoch ms) do Google trả, `null` nếu không có. */
  expiresAt: number | null
}

const DISCONNECTED: GoogleConnectionStatus = { status: "disconnected", email: null, connectedAt: null }

export const isGoogleIntegrationEnabled = (): boolean =>
  Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_TOKEN_ENC_KEY)

export const assertGoogleIntegrationEnabled = (): void => {
  if (!isGoogleIntegrationEnabled()) {
    throw new ApiError(503, "Tính năng kết nối Google chưa được bật trên hệ thống.", "GOOGLE_INTEGRATION_DISABLED")
  }
}

const consentIncomplete = () =>
  new ApiError(
    400,
    "Chưa nhận đủ quyền từ Google. Hãy kết nối lại và đồng ý cho FlintFlow truy cập các file trên Google Drive.",
    "GOOGLE_CONSENT_INCOMPLETE"
  )

const secretBox = (): SecretBox => createSecretBox(env.GOOGLE_TOKEN_ENC_KEY)

const createOAuthClient = (): OAuth2Client =>
  new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: POPUP_REDIRECT_URI
  })

const toStatus = (conn: IGoogleConnection): GoogleConnectionStatus => ({
  status: conn.revokedAt ? "reconnect_required" : "connected",
  email: conn.email,
  connectedAt: conn.connectedAt
})

const markRevoked = async (userId: string): Promise<void> => {
  await GoogleConnection.updateOne({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } })
}

export const connect = async (userId: string, code: string): Promise<GoogleConnectionStatus> => {
  assertGoogleIntegrationEnabled()
  const client = createOAuthClient()

  let tokens: Credentials
  try {
    ;({ tokens } = await client.getToken(code))
  } catch (err) {
    // Mã sai / hết hạn / đã dùng ⇒ người dùng làm lại popup; lỗi mạng hay 5xx của Google thì để lên 500
    if (isInvalidGrant(err)) throw consentIncomplete()
    throw err
  }

  const scopes = (tokens.scope ?? "").split(" ").filter(Boolean)
  if (!scopes.includes(DRIVE_FILE_SCOPE) || !tokens.refresh_token || !tokens.id_token) {
    throw consentIncomplete()
  }

  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_CLIENT_ID })
  const payload = ticket.getPayload()
  if (!payload?.sub || !payload.email) throw consentIncomplete()

  const conn = await GoogleConnection.findOneAndUpdate(
    { userId },
    {
      $set: {
        googleSub: payload.sub,
        email: payload.email.toLowerCase(),
        refreshTokenSealed: secretBox().seal(tokens.refresh_token),
        scopes,
        connectedAt: new Date(),
        revokedAt: null
      }
    },
    { upsert: true, returnDocument: "after" }
  )
  return toStatus(conn)
}

export const getStatus = async (userId: string): Promise<GoogleConnectionStatus> => {
  assertGoogleIntegrationEnabled()
  const conn = await GoogleConnection.findOne({ userId })
  return conn ? toStatus(conn) : DISCONNECTED
}

/** Thu hồi quyền phía Google (bỏ qua lỗi) rồi xoá bản ghi. Chưa nối thì vẫn thành công. */
export const disconnect = async (userId: string): Promise<GoogleConnectionStatus> => {
  assertGoogleIntegrationEnabled()
  const conn = await GoogleConnection.findOne({ userId }).select("+refreshTokenSealed")
  if (!conn) return DISCONNECTED

  try {
    await createOAuthClient().revokeToken(secretBox().open(conn.refreshTokenSealed))
  } catch (err) {
    // Token đã chết, đổi khoá mã hoá hay mất mạng: quyền phía Google tự hết hạn, phía FlintFlow vẫn phải xoá
    console.warn("[google] revokeToken thất bại, vẫn xoá kết nối:", err instanceof Error ? err.message : err)
  }
  await GoogleConnection.deleteOne({ _id: conn._id })
  return DISCONNECTED
}

/**
 * `OAuth2Client` đã gắn refresh token và đã lấy sẵn access token. Lấy token ngay ở đây để lỗi `invalid_grant`
 * được đổi thành `GOOGLE_RECONNECT_REQUIRED` tại một chỗ, thay vì nổ ra giữa lời gọi Drive/Docs ở phase sau.
 */
export const getAuthClient = async (userId: string): Promise<OAuth2Client> => {
  assertGoogleIntegrationEnabled()
  const conn = await GoogleConnection.findOne({ userId }).select("+refreshTokenSealed")
  if (!conn || conn.revokedAt) throw reconnectRequired()

  let refreshToken: string
  try {
    refreshToken = secretBox().open(conn.refreshTokenSealed)
  } catch {
    // Khoá mã hoá đã đổi ⇒ bản cũ không đọc được nữa, chỉ còn cách nối lại
    await markRevoked(userId)
    throw reconnectRequired()
  }

  const client = createOAuthClient()
  client.setCredentials({ refresh_token: refreshToken })
  try {
    await client.getAccessToken()
  } catch (err) {
    if (isInvalidGrant(err)) {
      await markRevoked(userId)
      throw reconnectRequired()
    }
    throw err
  }
  return client
}

/** Access token ngắn hạn cho Google Picker ở FE. Không bao giờ kèm refresh token. */
export const getAccessToken = async (userId: string): Promise<GoogleAccessToken> => {
  const client = await getAuthClient(userId)
  const { access_token: accessToken, expiry_date: expiresAt } = client.credentials
  if (!accessToken) throw reconnectRequired()
  return { accessToken, expiresAt: expiresAt ?? null }
}
