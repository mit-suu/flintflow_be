/**
 * FLF-265 phase 2 — lớp bản dịch qua HTTP trên Mongo thật:
 * `GET /projects/:id/translations/status` (mọi vai trò, không gọi model) và `POST /projects/:id/translations/run`
 * (Lead / Analyst, mỗi lô một lượt `translate_document` qua `executeAiAction` thật — giữ / trừ / nhả credit thật,
 * provider giả ở tầng `callLLM`). Kèm luật ghi của repository: `author` đè `machine`, `machine` không đè `author`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import request from "supertest"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () =>
  (await import("../helpers/mock-llm.js")).mockLlmRouterModule()
)

import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Project } from "../../src/modules/project/project.model.js"
import { Membership, type OrgRole } from "../../src/modules/organization/membership.model.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"
import { Spine } from "../../src/modules/spine/spine.model.js"
import { SpineTranslation } from "../../src/modules/translation/spine-translation.model.js"
import { TranslationGlossary } from "../../src/modules/translation/translation-glossary.model.js"
import { TranslationRunLock } from "../../src/modules/translation/translation-run-lock.model.js"
import * as translationRepository from "../../src/modules/translation/translation.repository.js"
import { hashSource } from "../../src/modules/translation/translation-units.js"
import { translationRunResponseSchema, translationStatusResponseSchema } from "../../src/modules/pipeline/pipeline.dto.js"
import { authAs, seedFixture, type SeededFixture } from "../setup.js"
import { mockCalls, mockOverrides, resetMockLlm } from "../helpers/mock-llm.js"

const bearer = (token: string) => ({ Authorization: "Bearer " + token })

const join = async (orgId: string, email: string, role: OrgRole) => {
  const user = await User.create({ email, password: "test-password-123", emailVerified: true })
  await Membership.create({ organizationId: orgId, userId: user._id, role })
  return authAs({ _id: user._id, email, orgId })
}

const BATCH_PROMPT = "You translate a batch of texts"

/** Provider giả cho `translate_document`: đọc lô trong prompt, "dịch" bằng tiền tố `[vi] `. */
const echoTranslate = (prompt: string): string | undefined => {
  if (!prompt.includes(BATCH_PROMPT)) return undefined
  const items = JSON.parse(prompt.slice(prompt.lastIndexOf("Items:") + "Items:".length).trim()) as { key: string; text: string | string[] }[]
  return JSON.stringify({ items: items.map(({ key, text }) => ({ key, text: Array.isArray(text) ? text.map((t) => `[vi] ${t}`) : `[vi] ${text}` })) })
}

const status = (projectId: string, token: string) => request(app).get(`/api/v1/projects/${projectId}/translations/status`).set(bearer(token))
const run = (projectId: string, token: string, body: unknown = {}) =>
  request(app).post(`/api/v1/projects/${projectId}/translations/run`).set(bearer(token)).send(body as object)

const wallet = async (orgId: string) => CreditWallet.findOne({ organizationId: orgId }).lean()

let seeded: SeededFixture

beforeEach(async () => {
  resetMockLlm()
  seeded = await seedFixture("full")
})

const useVietnamese = () => Project.updateOne({ _id: seeded.projectId }, { documentLanguage: "vi" })

describe("GET /projects/:id/translations/status", () => {
  it("dự án en (mặc định) ⇒ total 0; Viewer đọc được; không gọi model", async () => {
    const viewer = await join(seeded.orgId, "viewer@flintflow.test", "viewer")
    const res = await status(seeded.projectId, viewer)
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data).toEqual({ locale: "en", source_locale: "en", total: 0, missing: 0, batches: 0, estimated_credits: 0 })
    expect(mockCalls).toHaveLength(0)
  })

  it("dự án vi ⇒ đếm đơn vị, ước tính lô / credit theo giá translate_document", async () => {
    await useVietnamese()
    const res = await status(seeded.projectId, seeded.token)
    expect(res.status).toBe(200)
    const data = translationStatusResponseSchema.parse(res.body.data)
    expect(data).toMatchObject({ locale: "vi", source_locale: "en" })
    expect(data.total).toBeGreaterThan(500)
    expect(data.missing).toBe(data.total)
    expect(data.batches).toBeGreaterThan(5)
    expect(data.estimated_credits).toBe(data.batches * 2)
    expect(mockCalls).toHaveLength(0)
    expect((await wallet(seeded.orgId))?.balance).toBe(1000)
  })

  it("dự án org khác ⇒ 404 PROJECT_NOT_FOUND", async () => {
    const other = await seedFixture("minimal")
    const res = await status(other.projectId, seeded.token)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND")
  })
})

describe("POST /projects/:id/translations/run", () => {
  it("Viewer ⇒ 403 ORG_ROLE_FORBIDDEN, không gọi model, không ghi", async () => {
    await useVietnamese()
    const viewer = await join(seeded.orgId, "viewer@flintflow.test", "viewer")
    const res = await run(seeded.projectId, viewer)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
    expect(mockCalls).toHaveLength(0)
    expect(await SpineTranslation.countDocuments()).toBe(0)
  })

  it("Lead dịch max_batches lô: lưu machine, trừ 2 credit / lô, status giảm đúng, Spine không đổi", async () => {
    await useVietnamese()
    mockOverrides.next = echoTranslate
    const before = (await status(seeded.projectId, seeded.token)).body.data
    const spineBefore = await Spine.findOne({ projectId: seeded.projectId }).lean()

    const res = await run(seeded.projectId, seeded.token, { max_batches: 2 })

    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    const data = translationRunResponseSchema.parse(res.body.data)
    expect(data.credits_used).toBe(4)
    expect(data.translated).toBeGreaterThan(0)
    expect(data.translated + data.remaining).toBe(before.missing)
    expect(mockCalls).toHaveLength(2)

    const w = await wallet(seeded.orgId)
    expect(w?.balance).toBe(996)
    expect(w?.reserved).toBe(0)

    const rows = await SpineTranslation.find({ projectId: seeded.projectId }).lean()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.origin === "machine" && r.locale === "vi" && r.sourceLocale === "en")).toBe(true)
    expect(rows.every((r) => (Array.isArray(r.text) ? r.text.every((t) => t.startsWith("[vi] ")) : r.text.startsWith("[vi] ")))).toBe(true)

    const after = (await status(seeded.projectId, seeded.token)).body.data
    expect(after.missing).toBe(data.remaining)

    const spineAfter = await Spine.findOne({ projectId: seeded.projectId }).lean()
    expect(spineAfter?.spine_version).toBe(spineBefore?.spine_version)
    expect(spineAfter?.actors).toEqual(spineBefore?.actors)
    // Glossary tự động: term_native của fixture ⇒ seed
    expect(await TranslationGlossary.findOne({ projectId: seeded.projectId, term: "Spine" }).lean()).toMatchObject({ translation: "Xương sống SRS", origin: "seed" })
  })

  it("Analyst chạy được; body sai ⇒ 400 VALIDATION_ERROR", async () => {
    await useVietnamese()
    mockOverrides.next = echoTranslate
    const analyst = await join(seeded.orgId, "analyst@flintflow.test", "analyst")
    for (const body of [{ max_batches: 0 }, { max_batches: 11 }, { max_batches: 2, extra: true }]) {
      const bad = await run(seeded.projectId, analyst, body)
      expect(bad.status, JSON.stringify(body)).toBe(400)
      expect(bad.body.error.code).toBe("VALIDATION_ERROR")
    }
    const ok = await run(seeded.projectId, analyst, { max_batches: 1 })
    expect(ok.status).toBe(200)
    expect(ok.body.data.credits_used).toBe(2)
  })

  it("dự án en ⇒ không dịch gì, không gọi model", async () => {
    const res = await run(seeded.projectId, seeded.token)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ translated: 0, remaining: 0, credits_used: 0 })
    expect(mockCalls).toHaveLength(0)
  })

  it("model trả JSON hỏng ⇒ lỗi, không ghi gì, credit được nhả", async () => {
    await useVietnamese()
    mockOverrides.next = (prompt) => (prompt.includes(BATCH_PROMPT) ? "không phải JSON" : undefined)

    const res = await run(seeded.projectId, seeded.token, { max_batches: 1 })

    expect(res.status, JSON.stringify(res.body.error)).toBe(422)
    expect(res.body.error.code).toBe("PARSE_FAILED")
    expect(await SpineTranslation.countDocuments()).toBe(0)
    expect(await TranslationRunLock.countDocuments()).toBe(0)
    const w = await wallet(seeded.orgId)
    expect(w?.balance).toBe(1000)
    expect(w?.reserved).toBe(0)
  })

  it("lô có một item rỗng / null ⇒ không hỏng cả lô: các item còn lại được lưu, đơn vị lỗi giữ 'thiếu'", async () => {
    await useVietnamese()
    let sent = 0
    mockOverrides.next = (prompt) => {
      const echoed = echoTranslate(prompt)
      if (echoed === undefined) return undefined
      const { items } = JSON.parse(echoed) as { items: { key: string; text: unknown }[] }
      sent = items.length
      return JSON.stringify({ items: items.map((item, i) => (i === 0 ? { ...item, text: "" } : i === 1 ? { ...item, text: null } : item)) })
    }

    const res = await run(seeded.projectId, seeded.token, { max_batches: 1 })

    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data.credits_used).toBe(2)
    expect(sent).toBeGreaterThan(2)
    expect(res.body.data.translated).toBeGreaterThanOrEqual(sent - 2)
    expect(await SpineTranslation.countDocuments()).toBe(sent - 2)
  })

  it("hết credit giữa chừng ⇒ dừng, trả phần đã dịch; hết ngay lô đầu ⇒ 402 INSUFFICIENT_CREDIT", async () => {
    await useVietnamese()
    mockOverrides.next = echoTranslate
    await CreditWallet.updateOne({ organizationId: seeded.orgId }, { balance: 3 })

    const partial = await run(seeded.projectId, seeded.token, { max_batches: 5 })
    expect(partial.status, JSON.stringify(partial.body.error)).toBe(200)
    expect(partial.body.data.credits_used).toBe(2)
    expect(partial.body.data.translated).toBeGreaterThan(0)
    expect(partial.body.data.remaining).toBeGreaterThan(0)
    expect(await SpineTranslation.countDocuments()).toBeGreaterThan(0)
    // Lô thứ hai hụt credit không để lại phần giữ chỗ
    expect(await wallet(seeded.orgId)).toMatchObject({ balance: 1, reserved: 0 })

    const broke = await run(seeded.projectId, seeded.token)
    expect(broke.status).toBe(402)
    expect(broke.body.error.code).toBe("INSUFFICIENT_CREDIT")
    expect(await wallet(seeded.orgId)).toMatchObject({ balance: 1, reserved: 0 })
  })

  it("model trả items rỗng ⇒ trừ 2 credit của lô đó rồi dừng, không gọi lô sau", async () => {
    await useVietnamese()
    mockOverrides.next = (prompt) => (prompt.includes(BATCH_PROMPT) ? JSON.stringify({ items: [] }) : undefined)

    const res = await run(seeded.projectId, seeded.token, { max_batches: 5 })

    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data).toMatchObject({ translated: 0, credits_used: 2 })
    expect(res.body.data.remaining).toBeGreaterThan(0)
    expect(mockCalls).toHaveLength(1)
    expect(await SpineTranslation.countDocuments()).toBe(0)
    expect(await wallet(seeded.orgId)).toMatchObject({ balance: 998, reserved: 0 })
  })

  it("lượt khác đang giữ khoá ⇒ 409 TRANSLATION_RUNNING, không gọi model; khoá quá hạn ⇒ chiếm lại được", async () => {
    await useVietnamese()
    mockOverrides.next = echoTranslate
    const token = await translationRepository.acquireRunLock(seeded.projectId, "vi")
    expect(token).toBeTruthy()
    expect(await translationRepository.acquireRunLock(seeded.projectId, "vi")).toBeNull()

    const busy = await run(seeded.projectId, seeded.token, { max_batches: 1 })
    expect(busy.status).toBe(409)
    expect(busy.body.error.code).toBe("TRANSLATION_RUNNING")
    expect(mockCalls).toHaveLength(0)
    expect((await wallet(seeded.orgId))?.balance).toBe(1000)

    // Tiến trình giữ khoá chết: quá hạn ⇒ lượt mới chạy được và nhả khoá khi xong
    await TranslationRunLock.updateOne({ projectId: seeded.projectId, locale: "vi" }, { lockedUntil: new Date(Date.now() - 1000) })
    const ok = await run(seeded.projectId, seeded.token, { max_batches: 1 })
    expect(ok.status, JSON.stringify(ok.body.error)).toBe(200)
    expect(ok.body.data.credits_used).toBe(2)
    expect(await TranslationRunLock.countDocuments({ projectId: seeded.projectId })).toBe(0)
    // Mã khoá cũ không nhả được khoá của lượt khác
    const fresh = await translationRepository.acquireRunLock(seeded.projectId, "vi")
    await translationRepository.releaseRunLock(seeded.projectId, "vi", token!)
    expect(await TranslationRunLock.countDocuments({ projectId: seeded.projectId })).toBe(1)
    await translationRepository.releaseRunLock(seeded.projectId, "vi", fresh!)
    expect(await TranslationRunLock.countDocuments({ projectId: seeded.projectId })).toBe(0)
  })

  it("dự án org khác ⇒ 404 PROJECT_NOT_FOUND, không gọi model", async () => {
    const other = await seedFixture("minimal")
    await Project.updateOne({ _id: other.projectId }, { documentLanguage: "vi" })
    mockOverrides.next = echoTranslate
    const res = await run(other.projectId, seeded.token)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND")
    expect(mockCalls).toHaveLength(0)
  })
})

describe("translation.repository trên Mongo thật", () => {
  it("machine chỉ chèn (không đè author / machine có trước); author đè machine", async () => {
    const { projectId } = seeded
    const a = hashSource("Log in")
    const b = hashSource("Log out")
    await translationRepository.saveTranslations(projectId, "vi", "en", [{ sourceHash: a, text: "Bản author" }], "author")
    await translationRepository.saveTranslations(projectId, "vi", "en", [{ sourceHash: a, text: "Bản máy" }, { sourceHash: b, text: "Đăng xuất" }], "machine")
    await translationRepository.saveTranslations(projectId, "vi", "en", [{ sourceHash: b, text: "Máy lần hai" }], "machine")

    let found = await translationRepository.findByHashes(projectId, "vi", [a, b, hashSource("missing")])
    expect(found.get(a)).toMatchObject({ text: "Bản author", origin: "author" })
    expect(found.get(b)).toMatchObject({ text: "Đăng xuất", origin: "machine" })
    expect(found.size).toBe(2)

    await translationRepository.saveTranslations(projectId, "vi", "en", [{ sourceHash: b, text: ["Đăng", "xuất"] }], "author")
    found = await translationRepository.findByHashes(projectId, "vi", [b])
    expect(found.get(b)).toMatchObject({ text: ["Đăng", "xuất"], origin: "author" })
    expect(await SpineTranslation.countDocuments({ projectId })).toBe(2)
    // Ngôn ngữ khác tách riêng
    expect((await translationRepository.findByHashes(projectId, "en", [a])).size).toBe(0)
  })

  it("glossary: seed đè, model chỉ chèn", async () => {
    const { projectId } = seeded
    await translationRepository.upsertGlossary(projectId, "vi", [{ term: "Order", translation: "Lệnh" }], "model")
    await translationRepository.upsertGlossary(projectId, "vi", [{ term: "Order", translation: "Đơn hàng" }], "seed")
    await translationRepository.upsertGlossary(projectId, "vi", [{ term: "Order", translation: "Lệnh mới" }, { term: "Cart", translation: "Giỏ" }], "model")
    expect((await translationRepository.loadGlossary(projectId, "vi")).sort((x, y) => x.term.localeCompare(y.term))).toEqual([
      { term: "Cart", translation: "Giỏ" },
      { term: "Order", translation: "Đơn hàng" }
    ])
    // replace (tên từ bản dịch đang thắng): đè model, không đè seed
    await translationRepository.upsertGlossary(projectId, "vi", [{ term: "Order", translation: "Lệnh" }, { term: "Cart", translation: "Giỏ hàng" }], "model", true)
    expect((await translationRepository.loadGlossary(projectId, "vi")).sort((x, y) => x.term.localeCompare(y.term))).toEqual([
      { term: "Cart", translation: "Giỏ hàng" },
      { term: "Order", translation: "Đơn hàng" }
    ])
  })

  it("xoá cứng dự án ⇒ xoá cả bản dịch và glossary dịch", async () => {
    await translationRepository.saveTranslations(seeded.projectId, "vi", "en", [{ sourceHash: hashSource("x"), text: "y" }], "machine")
    await translationRepository.upsertGlossary(seeded.projectId, "vi", [{ term: "Order", translation: "Đơn hàng" }], "seed")
    await translationRepository.acquireRunLock(seeded.projectId, "vi")
    const res = await request(app).delete(`/api/v1/projects/${seeded.projectId}?hard=true`).set(bearer(seeded.token))
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(await SpineTranslation.countDocuments({ projectId: seeded.projectId })).toBe(0)
    expect(await TranslationGlossary.countDocuments({ projectId: seeded.projectId })).toBe(0)
    expect(await TranslationRunLock.countDocuments({ projectId: seeded.projectId })).toBe(0)
  })
})
