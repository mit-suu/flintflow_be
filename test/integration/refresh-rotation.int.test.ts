/**
 * FLF-475: khoảng ân hạn cho REUSE DETECTION ở `rotateSession` (`src/shared/auth/session.service.ts`).
 *
 * Lỗi gốc (plan-fix-08): phản hồi `/auth/refresh` bị mất giữa đường (F5 liên tục, request song song từ
 * nhiều tab/agent không chia khoá Web Locks) khiến refresh token CŨ bị gửi lại sau khi đã xoay. Code cũ
 * coi đây là đánh cắp token và thu hồi MỌI phiên của user. Bản sửa này:
 *   - cho một khoảng ân hạn (`REFRESH_REUSE_GRACE_MS`, mặc định 30s) sau khi xoay: gửi lại token cũ
 *     trong khoảng này được xoay tiếp bình thường, không đăng xuất ai;
 *   - quá khoảng ân hạn mới coi là reuse THẬT, và chỉ thu hồi HỌ phiên (`familyId`) của token đó, không
 *     đụng phiên ở thiết bị/agent khác của cùng user;
 *   - phiên tạo trước bản sửa này (không có `familyId`) vẫn giữ hành vi cũ khi gặp reuse: thu hồi mọi
 *     phiên của user (an toàn, không migrate).
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import mongoose from "mongoose"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Session } from "../../src/shared/auth/session.model.js"
import { hashToken, signRefreshToken } from "../../src/shared/auth/jwt.util.js"
import * as sessionService from "../../src/shared/auth/session.service.js"

/** Lấy giá trị cookie `name` từ header `set-cookie` của một response supertest. */
const cookieValue = (res: request.Response, name: string): string => {
  const setCookies = (res.headers["set-cookie"] as unknown as string[] | undefined) ?? []
  const raw = setCookies.find((c) => c.startsWith(`${name}=`))
  if (!raw) throw new Error(`Không thấy cookie ${name} trong set-cookie`)
  return raw.split(";")[0].slice(name.length + 1)
}

const login = async (email: string) => {
  await User.create({ email, password: "Password123!", emailVerified: true })
  const res = await request(app).post("/api/v1/auth/login").send({ email, password: "Password123!" })
  expect(res.status).toBe(200)
  return {
    accessToken: res.body.data.accessToken as string,
    refreshToken: cookieValue(res, "refreshToken")
  }
}

const refreshWith = (refreshToken: string) =>
  request(app).post("/api/v1/auth/refresh").set("Cookie", `refreshToken=${refreshToken}`)

describe("Refresh rotation — khoảng ân hạn REUSE DETECTION (FLF-475)", () => {
  it("Cho người dùng vừa refresh R0 thành R1, Khi gửi lại R0 trong khoảng ân hạn, Thì nhận 200 với cặp token mới, phiên thiết bị khác vẫn dùng được, R1 không dùng lại được sau khoảng ân hạn", async () => {
    const { refreshToken: r0 } = await login("grace-main@flintflow.test")
    const other = await login("grace-other-device@flintflow.test")

    // Lượt refresh đầu: R0 -> R1
    const first = await refreshWith(r0)
    expect(first.status).toBe(200)
    const r1 = cookieValue(first, "refreshToken")
    expect(r1).not.toBe(r0)

    // Phản hồi của lượt đầu "bị mất" — trình duyệt gửi lại đúng R0 ngay sau đó, vẫn trong khoảng ân hạn.
    const second = await refreshWith(r0)
    expect(second.status).toBe(200)
    const r2 = cookieValue(second, "refreshToken")
    expect(r2).not.toBe(r0)
    expect(r2).not.toBe(r1)

    // Không ai bị đăng xuất: phiên ở thiết bị khác vẫn dùng accessToken cũ của nó bình thường.
    const otherMe = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${other.accessToken}`)
    expect(otherMe.status).toBe(200)

    // Cặp token mới nhất (R2) vẫn dùng tiếp được.
    const third = await refreshWith(r2)
    expect(third.status).toBe(200)

    // Giả lập đã quá khoảng ân hạn cho R1 (phiên trung gian đã bị xoay tiếp): sửa `rotatedAt` trong DB
    // lùi về quá xa — gửi lại R1 giờ phải là reuse THẬT, không còn lọt nhánh ân hạn.
    await Session.updateOne({ tokenHash: hashToken(r1) }, { rotatedAt: new Date(Date.now() - 10 * 60 * 1000) })
    const reuseR1 = await refreshWith(r1)
    expect(reuseR1.status).toBe(401)
    expect(reuseR1.body.error.code).toBe("TOKEN_REUSE_DETECTED")

    // Thiết bị khác (họ phiên khác) vẫn không bị ảnh hưởng bởi reuse thật ở họ phiên của r0/r1/r2.
    const otherMeAfter = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${other.accessToken}`)
    expect(otherMeAfter.status).toBe(200)
  })

  it("Cho hai request refresh cùng R0 gửi song song, Khi cả hai xong, Thì cả hai đều 200 và không phiên nào của user bị thu hồi oan", async () => {
    const { refreshToken: r0 } = await login("concurrent@flintflow.test")
    const other = await login("concurrent-other-device@flintflow.test")

    const [resA, resB] = await Promise.all([refreshWith(r0), refreshWith(r0)])

    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)
    const rA = cookieValue(resA, "refreshToken")
    const rB = cookieValue(resB, "refreshToken")
    expect(rA).not.toBe(rB)

    // Thiết bị khác không bị đăng xuất vì cuộc đua song song của thiết bị kia.
    const otherMe = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${other.accessToken}`)
    expect(otherMe.status).toBe(200)

    // Cả rA và rB đều còn dùng tiếp được: trong lúc xử lý race, một trong hai phiên (X hoặc Y) lại bị
    // xoay tiếp bởi nhánh "thua" của chính request kia — nhưng vẫn trong khoảng ân hạn, nên lượt gửi lại
    // bằng rA hay rB sau đó đều được đi tiếp theo chuỗi `replacedBy` tới phiên "lá" hiện tại, không ai bị
    // chặn 401 vì đã dùng một token "cũ hơn một nấc" trong CHÍNH cuộc đua của mình.
    const followA = await refreshWith(rA)
    const followB = await refreshWith(rB)
    expect(followA.status).toBe(200)
    expect(followB.status).toBe(200)
  })

  it("Cho R0 đã xoay quá khoảng ân hạn, Khi gửi lại R0, Thì 401 TOKEN_REUSE_DETECTED, mọi phiên cùng familyId bị thu hồi, phiên ở thiết bị khác (họ khác) vẫn dùng được", async () => {
    const { refreshToken: r0 } = await login("stale-reuse@flintflow.test")
    const other = await login("stale-reuse-other-device@flintflow.test")

    const rotated = await refreshWith(r0)
    expect(rotated.status).toBe(200)
    const r1 = cookieValue(rotated, "refreshToken")

    // Quá khoảng ân hạn: lùi rotatedAt của phiên R0 (đã xoay) về quá xa.
    await Session.updateOne({ tokenHash: hashToken(r0) }, { rotatedAt: new Date(Date.now() - 10 * 60 * 1000) })

    const reuse = await refreshWith(r0)
    expect(reuse.status).toBe(401)
    expect(reuse.body.error.code).toBe("TOKEN_REUSE_DETECTED")

    // Cả họ phiên (gồm R1, phiên đang hiệu lực) bị thu hồi theo.
    const r1Session = await Session.findOne({ tokenHash: hashToken(r1) })
    expect(r1Session?.isRevoked).toBe(true)
    const r1Reuse = await refreshWith(r1)
    expect(r1Reuse.status).toBe(401)

    // Thiết bị khác (họ phiên khác hẳn) không bị đụng tới.
    const otherMe = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${other.accessToken}`)
    expect(otherMe.status).toBe(200)
  })

  it("Cho người dùng đã đăng xuất bằng R0, Khi gửi lại R0 (trong hay ngoài khoảng ân hạn), Thì 401, không lọt nhánh ân hạn", async () => {
    const { refreshToken: r0 } = await login("logged-out-reuse@flintflow.test")

    const logoutRes = await request(app).post("/api/v1/auth/logout").set("Cookie", `refreshToken=${r0}`)
    expect(logoutRes.status).toBe(200)

    // Gửi lại ngay (sẽ là "trong khoảng ân hạn" nếu tính theo thời gian) — nhưng đây là đăng xuất, không
    // phải xoay, nên `rotatedAt` vẫn null và không được đi nhánh ân hạn.
    const reuseImmediately = await refreshWith(r0)
    expect(reuseImmediately.status).toBe(401)

    const session = await Session.findOne({ tokenHash: hashToken(r0) })
    expect(session?.rotatedAt ?? null).toBeNull()

    // Gửi lại lần nữa (chắc chắn ngoài khoảng ân hạn theo thời gian thực) vẫn 401.
    const reuseAgain = await refreshWith(r0)
    expect(reuseAgain.status).toBe(401)
  })

  it("Cho R0 vừa xoay sang R1 rồi user bấm Đăng xuất mọi thiết bị, Khi gửi lại R0 trong khoảng ân hạn, Thì 401 SESSION_REVOKED, không cấp token mới", async () => {
    const { refreshToken: r0 } = await login("logout-all-grace@flintflow.test")

    const rotated = await refreshWith(r0)
    expect(rotated.status).toBe(200)
    const accessTokenAfterRotate = rotated.body.data.accessToken as string

    const logoutAllRes = await request(app)
      .post("/api/v1/auth/logout-all")
      .set("Authorization", `Bearer ${accessTokenAfterRotate}`)
    expect(logoutAllRes.status).toBe(200)

    // R1 (phiên hiện tại của họ) đã bị logout-all thu hồi. Gửi lại R0 (vẫn trong khoảng ân hạn tính theo
    // thời gian) phải báo phiên đã kết thúc, không cấp token mới, không coi là reuse để thu hồi thêm.
    const reuse = await refreshWith(r0)
    expect(reuse.status).toBe(401)
    expect(reuse.body.error.code).toBe("SESSION_REVOKED")
    expect(reuse.body.data).toBeNull()
  })
})

describe("session.service.rotateSession — chuỗi replacedBy & phiên cũ không có familyId (FLF-475)", () => {
  it("Chuỗi replacedBy nhiều nấc trong khoảng ân hạn đi tới đúng phiên mới nhất của họ", async () => {
    const user = await User.create({ email: "chain@flintflow.test", password: "Password123!", emailVerified: true })
    const userId = String(user._id)
    const email = user.email

    // `rotateSession` kiểm chữ ký JWT trước khi đọc DB — cần refresh token thật, không phải chuỗi tuỳ ý.
    const r0 = signRefreshToken({ userId, email })
    const r1 = signRefreshToken({ userId, email })
    const r2 = signRefreshToken({ userId, email })
    const r3 = signRefreshToken({ userId, email })
    const future = new Date(Date.now() + 60 * 60 * 1000)

    // R0 -> R1 -> R2 -> R3, mỗi nấc đều trong khoảng ân hạn: R0..R2 đã bị xoay (`rotatedAt` gần đây,
    // `replacedBy` trỏ đúng nấc kế); chỉ R3 (phiên "lá") còn hiệu lực.
    const s0 = await sessionService.createSession(userId, r0, future)
    const s1 = await sessionService.createSession(userId, r1, future, undefined, undefined, null, null, s0.familyId)
    const s2 = await sessionService.createSession(userId, r2, future, undefined, undefined, null, null, s0.familyId)
    const s3 = await sessionService.createSession(userId, r3, future, undefined, undefined, null, null, s0.familyId)

    const recent = new Date()
    await Session.updateOne({ _id: s0._id }, { isRevoked: true, rotatedAt: recent, replacedBy: s1._id })
    await Session.updateOne({ _id: s1._id }, { isRevoked: true, rotatedAt: recent, replacedBy: s2._id })
    await Session.updateOne({ _id: s2._id }, { isRevoked: true, rotatedAt: recent, replacedBy: s3._id })
    // s3 còn hiệu lực (isRevoked: false, không replacedBy) — đúng là phiên "lá".

    // Dùng R0 (xoay từ lâu rồi, nhưng vẫn trong khoảng ân hạn) để lần theo chuỗi 3 nấc tới R3.
    const result = await sessionService.rotateSession(r0, "chain-new-refresh-token", future)
    expect(result.userId).toBe(userId)

    const newSession = await Session.findById(new mongoose.Types.ObjectId(result.sessionId))
    expect(newSession).not.toBeNull()
    expect(String(newSession?.familyId)).toBe(String(s0.familyId))

    // s3 (phiên lá) đã bị xoay tiếp thành phiên mới, không còn ai khác bị thu hồi oan.
    const s3After = await Session.findById(s3._id)
    expect(s3After?.isRevoked).toBe(true)
    expect(String(s3After?.replacedBy)).toBe(result.sessionId)
  })

  it("Phiên cũ không có familyId (tạo trước FLF-475) vẫn thu hồi mọi phiên của user khi gặp reuse thật", async () => {
    const user = await User.create({ email: "legacy@flintflow.test", password: "Password123!", emailVerified: true })
    const userId = String(user._id)
    const future = new Date(Date.now() + 60 * 60 * 1000)

    // Phiên "cũ" tạo trước bản sửa này: ghi thẳng vào DB, không có familyId (bỏ qua createSession vì
    // hàm đó luôn gán familyId mặc định cho phiên mới).
    const legacyRefreshToken = signRefreshToken({ userId, email: user.email })
    await Session.create({
      userId: new mongoose.Types.ObjectId(userId),
      tokenHash: hashToken(legacyRefreshToken),
      expiresAt: future,
      isRevoked: true // đã bị thu hồi từ trước (mô phỏng reuse thật, không phải vừa xoay)
    })

    // Một phiên khác còn sống của CÙNG user, cũng không có familyId (toàn bộ dữ liệu cũ trước migrate).
    const otherLegacyToken = "legacy-refresh-token-other-device"
    const otherLegacySession = await Session.create({
      userId: new mongoose.Types.ObjectId(userId),
      tokenHash: hashToken(otherLegacyToken),
      expiresAt: future,
      isRevoked: false
    })

    await expect(sessionService.rotateSession(legacyRefreshToken, "legacy-new-token", future)).rejects.toMatchObject({
      code: "TOKEN_REUSE_DETECTED"
    })

    // Giữ hành vi cũ: không có familyId để khoanh họ ⇒ thu hồi MỌI phiên của user, kể cả phiên khác còn sống.
    const otherAfter = await Session.findById(otherLegacySession._id)
    expect(otherAfter?.isRevoked).toBe(true)
  })
})
