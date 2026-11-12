/**
 * FLF-410 — mockup màn theo theme dự án, qua Mongo thật:
 * - `PATCH /projects/:id/screen-theme`: chỉ Lead / Analyst, validate, đổi theme ⇒ mockup đã vẽ được vẽ lại từ spec đã lưu,
 *   KHÔNG gọi model, KHÔNG trừ credit.
 * - `screen-mockups` (dự án import có ảnh gốc): ước tính credit, kiểm credit trước khi chạy, bật / tắt / bật lại không gọi
 *   model lại, "tất cả" bỏ qua màn đã đúng kiểu, kiểu ảnh gốc không đọc được ⇒ kiểu chuẩn, màu ảnh gốc vào theme.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Project } from "../../src/modules/project/project.model.js"
import { Membership, type OrgRole } from "../../src/modules/organization/membership.model.js"
import { AiActionLog } from "../../src/modules/admin/ai-action-log.model.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"
import { renderDiagram } from "../../src/modules/diagram/diagram.service.js"
import { TemplateProfile } from "../../src/modules/import/template-profile.model.js"
import { loadFunctionOriginals } from "../../src/modules/diagram/screen-originals.js"
import * as spineRepository from "../../src/modules/spine/spine.repository.js"
import * as mockups from "../../src/modules/diagram/screen-mockup.service.js"
import * as runs from "../../src/modules/diagram/screen-mockup-runs.js"
import { ScreenMockupRun } from "../../src/modules/diagram/screen-mockup-run.model.js"
import mongoose from "mongoose"
import type { MockupDeps } from "../../src/modules/diagram/screen-mockup.service.js"
import type { FunctionOriginalLite } from "../../src/modules/diagram/screen-originals.js"
import type { ScreenEnvelope } from "../../src/modules/diagram/screen-spec.js"
import { SIGNUP_SPEC } from "../../src/modules/diagram/screen-spec.samples.js"
import { screenSpecOf } from "../../src/modules/diagram/renderers/screen-mockup.js"
import { authAs, seedFixture, type SeededFixture } from "../setup.js"

const bearer = (token: string) => ({ Authorization: "Bearer " + token })

const join = async (orgId: string, email: string, role: OrgRole) => {
  const user = await User.create({ email, password: "test-password-123", emailVerified: true })
  await Membership.create({ organizationId: orgId, userId: user._id, role })
  return authAs({ _id: user._id, email, orgId })
}

let seeded: SeededFixture

beforeEach(async () => {
  seeded = await seedFixture("full")
})

const envelope = (extra: Partial<ScreenEnvelope> = {}): ScreenEnvelope => ({ spec: { ...SIGNUP_SPEC, platforms: ["web", "mobile"] }, screenImages: null, primaryColor: null, ...extra })

const patchTheme = (token: string, body: unknown) => request(app).patch(`/api/v1/projects/${seeded.projectId}/screen-theme`).set(bearer(token)).send(body as object)

describe("PATCH /projects/:id/screen-theme", () => {
  it("GET dự án trả theme mặc định; Lead đổi ⇒ 200, chuẩn hoá domain", async () => {
    const one = await request(app).get(`/api/v1/projects/${seeded.projectId}`).set(bearer(seeded.token))
    expect(one.body.data.screenTheme).toEqual({ primaryColor: null, domain: null, platforms: null })
    const res = await patchTheme(seeded.token, { primaryColor: "#e4572e", domain: "https://Shop.TechMart.vn/home" })
    expect(res.status).toBe(200)
    expect(res.body.data.screenTheme).toEqual({ primaryColor: "#E4572E", domain: "shop.techmart.vn", platforms: null })
  })

  it("Viewer ⇒ 403; body sai ⇒ 400; không ghi", async () => {
    const viewer = await join(seeded.orgId, "viewer@flintflow.test", "viewer")
    expect((await patchTheme(viewer, { primaryColor: "#000000" })).status).toBe(403)
    for (const body of [{}, { primaryColor: "red" }, { platforms: [] }, { domain: "not a host" }, { primaryColor: "#000000", x: 1 }]) {
      const res = await patchTheme(seeded.token, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.code).toBe("VALIDATION_ERROR")
    }
    expect((await Project.findById(seeded.projectId).lean())?.screenTheme?.primaryColor).toBeNull()
  })

  it("đổi màu / nền tảng ⇒ mockup vẽ lại từ spec, 0 lượt AI, ví không đổi, spine_version tăng", async () => {
    const drawLayout = vi.fn(async () => envelope())
    await renderDiagram(seeded.projectId, "screen_layout", "S01", { by: seeded.userId, deps: { drawLayout } })
    const before = await spineRepository.get(seeded.projectId)
    const wallet = await CreditWallet.findOne({ organizationId: seeded.orgId }).lean()
    const logs = await AiActionLog.countDocuments({})

    expect((await patchTheme(seeded.token, { primaryColor: "#2E7D5B", platforms: ["web", "mobile"] })).status).toBe(200)
    const after = await spineRepository.get(seeded.projectId)
    const layouts = after!.diagrams.filter((d) => d.kind === "screen_layout" && d.owner_id === "S01")
    expect(layouts).toHaveLength(2)
    expect(layouts.every((d) => d.source.includes("#2E7D5B"))).toBe(true)
    expect(after!.spine_version).toBeGreaterThan(before!.spine_version)
    expect(drawLayout).toHaveBeenCalledTimes(1)
    expect(await AiActionLog.countDocuments({})).toBe(logs)
    expect((await CreditWallet.findOne({ organizationId: seeded.orgId }).lean())?.balance).toBe(wallet?.balance)
  })
})

// ─── ảnh gốc dự án import ───────────────────────────────────────

/** Mục nguyên văn: S01 có 2 ảnh màn hình (web + mobile) + một sơ đồ; S05 có một ảnh không chú thích. */
const ORIGINALS = (spineFns: { id: string; screen_id: string | null; order: number }[]): FunctionOriginalLite[] => {
  const first = (screen: string) => spineFns.filter((f) => f.screen_id === screen).sort((a, b) => a.order - b.order)[0].id
  const img = (ref: string, text: string) => ({ kind: "image" as const, text, rows: null, image_ref: ref })
  const para = (text: string) => ({ kind: "paragraph" as const, text, rows: null, image_ref: null })
  return [
    { section_id: `function:${first("S01")}`, blocks: [para("Login form."), img("word/media/a.png", "Figure 3: Login sequence diagram"), img("word/media/b.png", "Figure 4: Login screen layout (web)"), img("word/media/c.png", "Figure 5: Login mockup (mobile)")] },
    { section_id: `function:${first("S05")}`, blocks: [para("Dashboard."), img("word/media/d.png", "")] }
  ]
}

/** Nguyên văn file của dự án import (như finalize ghi) — mọi đường vẽ đọc cùng nguồn. */
const seedOriginals = async () => {
  const spine = (await spineRepository.get(seeded.projectId))!
  const sections = ORIGINALS(spine.functions)
  await TemplateProfile.create({ projectId: seeded.projectId, doc_version: "0.1", function_originals: sections.map((o) => ({ ...o, blocks: [...o.blocks], source_hash: "x" })) })
}

const depsWith = async (overrides: Partial<MockupDeps> = {}) => {
  const render = vi.fn<MockupDeps["render"]>((projectId, screenIds, userId, onDrawn, loadOriginal) =>
    mockups.renderScreenMockups(projectId, screenIds, userId, onDrawn, loadOriginal, async ({ screenId }) => envelope(screenId === "S01" ? { primaryColor: "#E4572E" } : {}))
  )
  const deps: MockupDeps = {
    originals: loadFunctionOriginals,
    loadImage: async () => ({ mime: "image/png", data: "AAAA" }),
    render,
    available: async () => 100,
    cost: async () => 1,
    ...overrides
  }
  return { deps, render }
}

const states = async () => (await Project.findById(seeded.projectId).lean())?.screenMockups ?? []

describe("screen-mockups (dự án import có ảnh gốc)", () => {
  beforeEach(seedOriginals)

  it("ước tính: mọi màn có ảnh gốc, credit = số lượt AI; màn không có ảnh ⇒ 400", async () => {
    const { deps } = await depsWith()
    expect(await mockups.estimate(seeded.projectId, seeded.orgId, { mode: "system", scope: "all" }, deps)).toEqual({ screens: 2, ai_calls: 2, credits: 2, reenable: 0, groups: { draw: ["S01", "S05"], reenable: [], skip: [] } })
    await expect(mockups.estimate(seeded.projectId, seeded.orgId, { mode: "system", scope: "screen", screen_id: "S07" }, deps)).rejects.toMatchObject({ statusCode: 400, code: "SCREEN_HAS_NO_ORIGINAL" })
    await expect(mockups.estimate(seeded.projectId, seeded.orgId, { mode: "system", scope: "screen", screen_id: "S99" }, deps)).rejects.toMatchObject({ statusCode: 404 })
  })

  it("bật một màn ⇒ thay mọi ảnh có chú thích màn hình; tắt rồi bật lại ⇒ 0 lượt AI; màu ảnh gốc vào theme khi chưa chọn", async () => {
    const { deps, render } = await depsWith()
    const first = await mockups.run(seeded.projectId, seeded.orgId, seeded.userId, { mode: "system", scope: "screen", screen_id: "S01" }, deps)
    expect(first).toMatchObject({ done: ["S01"], failed: [], fell_back_to_system: [] })
    expect(render).toHaveBeenCalledTimes(1)
    expect(await states()).toEqual([{ screen_id: "S01", mode: "system", enabled: true, image_indexes: [1, 2] }])
    expect((await Project.findById(seeded.projectId).lean())?.screenTheme?.primaryColor).toBe("#E4572E")
    // màu vừa vào theme ⇒ mockup đã vẽ lại bằng màu đó
    const layouts = (await spineRepository.get(seeded.projectId))!.diagrams.filter((d) => d.owner_id === "S01" && d.kind === "screen_layout")
    expect(layouts.every((d) => d.source.includes("#E4572E"))).toBe(true)

    expect(await mockups.disable(seeded.projectId, seeded.orgId, { scope: "screen", screen_id: "S01" }, deps)).toEqual({ disabled: ["S01"] })
    expect((await states())[0].enabled).toBe(false)
    const again = await mockups.run(seeded.projectId, seeded.orgId, seeded.userId, { mode: "system", scope: "screen", screen_id: "S01" }, deps)
    expect(again.done).toEqual(["S01"])
    expect(render).toHaveBeenCalledTimes(1)
    expect((await states())[0].enabled).toBe(true)
  })

  it("'tất cả' bỏ qua màn đã đúng kiểu; ví thiếu ⇒ 402 kèm số credit, không vẽ màn nào", async () => {
    const { deps, render } = await depsWith()
    await mockups.run(seeded.projectId, seeded.orgId, seeded.userId, { mode: "system", scope: "screen", screen_id: "S01" }, deps)
    // Mỗi màn đúng một nhóm, cộng lại = tổng: S01 đã là mockup chuẩn ⇒ bỏ qua
    expect(await mockups.estimate(seeded.projectId, seeded.orgId, { mode: "system", scope: "all" }, deps)).toMatchObject({
      screens: 2,
      ai_calls: 1,
      credits: 1,
      groups: { draw: ["S05"], reenable: [], skip: ["S01"] }
    })

    const broke = await depsWith({ available: async () => 0 })
    await expect(mockups.run(seeded.projectId, seeded.orgId, seeded.userId, { mode: "system", scope: "all" }, broke.deps)).rejects.toMatchObject({
      statusCode: 402,
      code: "INSUFFICIENT_CREDITS",
      meta: { required: 1, available: 0 }
    })
    expect(broke.render).not.toHaveBeenCalled()

    const all = await mockups.run(seeded.projectId, seeded.orgId, seeded.userId, { mode: "system", scope: "all" }, deps)
    expect(all.done).toEqual(["S05"])
    expect(render).toHaveBeenLastCalledWith(seeded.projectId, ["S05"], seeded.userId, expect.any(Function), expect.any(Function))
    // ảnh không chú thích ⇒ ảnh đầu tiên
    expect((await states()).find((s) => s.screen_id === "S05")?.image_indexes).toEqual([0])
  })

  it("kiểu ảnh gốc: ảnh không đọc được ⇒ kiểu chuẩn; màu đã chọn ⇒ chỉ gợi ý", async () => {
    await Project.updateOne({ _id: seeded.projectId }, { $set: { "screenTheme.primaryColor": "#3F5591" } })
    const { deps } = await depsWith({ loadImage: async () => null })
    const res = await mockups.run(seeded.projectId, seeded.orgId, seeded.userId, { mode: "original", scope: "screen", screen_id: "S01" }, deps)
    expect(res.fell_back_to_system).toEqual(["S01"])
    expect((await states())[0].mode).toBe("system")

    const readable = await depsWith()
    const original = await mockups.run(seeded.projectId, seeded.orgId, seeded.userId, { mode: "original", scope: "screen", screen_id: "S01" }, readable.deps)
    expect(original).toMatchObject({ done: ["S01"], suggested_color: "#E4572E" })
    expect((await Project.findById(seeded.projectId).lean())?.screenTheme?.primaryColor).toBe("#3F5591")
    const svg = (await spineRepository.get(seeded.projectId))!.diagrams.find((d) => d.owner_id === "S01" && d.kind === "screen_layout")!.source
    expect(screenSpecOf(svg)?.mode).toBe("original")
  })

  it("HTTP: Viewer ⇒ 403; body sai ⇒ 400; GET không mode ⇒ tóm tắt", async () => {
    const viewer = await join(seeded.orgId, "viewer2@flintflow.test", "viewer")
    const url = `/api/v1/projects/${seeded.projectId}/screen-mockups`
    expect((await request(app).post(url).set(bearer(viewer)).send({ mode: "system", scope: "all" })).status).toBe(403)
    for (const body of [{ mode: "system", scope: "screen" }, { mode: "x", scope: "all" }, { mode: "system", scope: "all", extra: 1 }])
      expect((await request(app).post(url).set(bearer(seeded.token)).send(body)).status, JSON.stringify(body)).toBe(400)
    // Ảnh gốc của màn: file import không có trong test ⇒ 404 rõ mã
    const original = await request(app).get(`${url}/S01/original`).set(bearer(seeded.token))
    expect(original.status).toBe(404)
    expect(original.body.error.code).toBe("SCREEN_HAS_NO_ORIGINAL")
    const summary = await request(app).get(url).set(bearer(seeded.token))
    expect(summary.status).toBe(200)
    expect(summary.body.data).toMatchObject({ with_original: 2, using_mockup: 0 })
  })
})

describe("screen-mockups chạy nền (dừng, tiến độ, một lượt mỗi dự án)", () => {
  beforeEach(seedOriginals)

  it("startRun trả ngay (tiến độ chờ), lượt chạy xong ⇒ done; đang chạy ⇒ 409; GET trả lượt gần nhất", async () => {
    const { deps } = await depsWith()
    let scheduled: string | null = null
    const view = await runs.startRun(seeded.projectId, seeded.orgId, seeded.userId, { mode: "system", scope: "all" }, deps, async (runId) => {
      scheduled = runId
    })
    expect(view).toMatchObject({ status: "running", total: 2, completed: 0, pending: ["S01", "S05"], stopping: false })
    await expect(runs.startRun(seeded.projectId, seeded.orgId, seeded.userId, { mode: "system", scope: "all" }, deps, async () => undefined)).rejects.toMatchObject({
      statusCode: 409,
      code: "SCREEN_MOCKUP_RUNNING"
    })
    await runs.executeRun(scheduled!, seeded.orgId, deps)
    expect(await runs.getRun(seeded.projectId, seeded.orgId)).toMatchObject({ status: "done", completed: 2, done: ["S01", "S05"], pending: [] })
  })

  it("Dừng: màn đang vẽ vẽ nốt, màn còn lại không vẽ (không gọi model, không trừ credit), vẫn giữ ảnh gốc", async () => {
    const { deps, render } = await depsWith()
    // Người dùng bấm Dừng trong lúc màn đầu đang vẽ
    const stopAfterFirst: MockupDeps = {
      ...deps,
      render: async (...args) => {
        await render(...args)
        await runs.cancelRun(seeded.projectId, seeded.orgId)
      }
    }
    await runs.startRun(seeded.projectId, seeded.orgId, seeded.userId, { mode: "system", scope: "all" }, stopAfterFirst, (runId, orgId) => runs.executeRun(runId, orgId, stopAfterFirst))
    expect(render).toHaveBeenCalledTimes(1)
    const after = await runs.getRun(seeded.projectId, seeded.orgId)
    expect(after).toMatchObject({ status: "cancelled", done: ["S01"], completed: 1, pending: [] })
    expect((await states()).find((s) => s.screen_id === "S01")?.enabled).toBe(true)
    // S05 đã ghi trạng thái lúc chuẩn bị nhưng chưa có mockup ⇒ tài liệu vẫn dùng ảnh gốc (layout-sections cần hình svg)
    const s05 = (await spineRepository.get(seeded.projectId))!.diagrams.filter((d) => d.owner_id === "S05" && d.kind === "screen_layout")
    expect(s05).toEqual([])
  })

  it("lượt running không cập nhật quá STALE_MS ⇒ interrupted, lượt mới chạy được", async () => {
    const { deps } = await depsWith()
    const view = await runs.startRun(seeded.projectId, seeded.orgId, seeded.userId, { mode: "system", scope: "all" }, deps, async () => undefined)
    await ScreenMockupRun.collection.updateOne({ _id: new mongoose.Types.ObjectId(view.run_id) }, { $set: { updatedAt: new Date(Date.now() - runs.STALE_MS - 1000) } })
    expect((await runs.getRun(seeded.projectId, seeded.orgId))?.status).toBe("interrupted")
    await expect(runs.startRun(seeded.projectId, seeded.orgId, seeded.userId, { mode: "system", scope: "all" }, deps, async () => undefined)).resolves.toMatchObject({ status: "running" })
  })

  it("hàng đợi không phản hồi (Redis tắt) ⇒ 503 sau SCHEDULE_TIMEOUT_MS, lượt đóng, màn trả về như cũ, lượt sau chạy được", async () => {
    const { deps } = await depsWith()
    const never = () => new Promise<void>(() => undefined)
    await expect(runs.startRun(seeded.projectId, seeded.orgId, seeded.userId, { mode: "system", scope: "screen", screen_ids: ["S01"] }, deps, never)).rejects.toMatchObject({
      statusCode: 503,
      code: "SCREEN_MOCKUP_QUEUE_UNAVAILABLE"
    })
    expect((await runs.getRun(seeded.projectId, seeded.orgId))?.status).toBe("cancelled")
    expect((await states()).find((s) => s.screen_id === "S01")?.enabled).toBe(false)
    await expect(runs.startRun(seeded.projectId, seeded.orgId, seeded.userId, { mode: "system", scope: "all" }, deps, async () => undefined)).resolves.toMatchObject({ status: "running" })
  }, 15000)

  it("HTTP: POST ⇒ 202; GET …/run; cancel chỉ Lead/Analyst", async () => {
    const viewer = await join(seeded.orgId, "viewer3@flintflow.test", "viewer")
    const base = `/api/v1/projects/${seeded.projectId}/screen-mockups`
    expect((await request(app).get(`${base}/run`).set(bearer(seeded.token))).body.data).toBeNull()
    expect((await request(app).post(`${base}/run/cancel`).set(bearer(viewer))).status).toBe(403)
  })
})
