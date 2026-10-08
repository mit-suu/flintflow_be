/**
 * UC-49 Comment on SRS Content — qua HTTP trên Mongo thật: ghim comment vào section / block của bản đang đọc, Viewer
 * chỉ comment trên bản đã phát hành (BR-27), trả lời, Analyst/Lead "Resolve", thông báo in-app cho Analyst/Lead, và
 * "Create CR from comment" (mode 1, sau baseline v0) ⇒ comment `converted` kèm mã CR.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () => (await import("../helpers/mock-llm.js")).mockLlmRouterModule())

import request from "supertest"
import app from "../../src/app.js"
import { authAs, seedFixture, type SeededFixture } from "../setup.js"
import { mockOverrides, resetMockLlm } from "../helpers/mock-llm.js"
import { createMode1Project, fakeMode1, mode1Api } from "../helpers/mode1.js"
import { makeSrsDocx } from "../../src/modules/import/testing/srs-fixture.js"
import { User } from "../../src/modules/user/user.model.js"
import { Membership, type OrgRole } from "../../src/modules/organization/membership.model.js"
import { Notification } from "../../src/modules/notification/notification.model.js"
import { changeRequestDetailSchema } from "../../src/modules/change-request/change-request.dto.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = (p) => fakeMode1(p)
})

const join = async (seeded: SeededFixture, email: string, role: OrgRole) => {
  const user = await User.create({ email, password: "test-password-123", emailVerified: true, name: email.split("@")[0] })
  await Membership.create({ organizationId: seeded.orgId, userId: user._id, role })
  return { userId: String(user._id), token: await authAs({ _id: user._id, email, orgId: seeded.orgId }) }
}

const api = (projectId: string, token: string) => {
  const base = `/api/v1/projects/${projectId}`
  const auth = { Authorization: `Bearer ${token}` }
  return {
    get: (suffix: string) => request(app).get(`${base}${suffix}`).set(auth),
    post: (suffix: string, body: object = {}) => request(app).post(`${base}${suffix}`).set(auth).send(body)
  }
}

/** Section đầu tiên có nội dung của bản đang đọc — làm chỗ ghim. */
const firstSection = async (c: ReturnType<typeof api>, query = "") => {
  const res = await c.get(`/document${query}`)
  expect(res.status, JSON.stringify(res.body.error)).toBe(200)
  const sections = res.body.data.sections as Array<{ id: string; number: string; heading: string; blocks: unknown[] }>
  const section = sections.find((s) => !s.id.startsWith("group:") && s.blocks.length > 0)
  expect(section).toBeDefined()
  return section!
}

describe("UC-49 — comment trên bản nháp (mode 2)", () => {
  let seeded: SeededFixture
  let lead: ReturnType<typeof api>
  let analyst: { userId: string; c: ReturnType<typeof api> }
  let viewer: ReturnType<typeof api>

  beforeEach(async () => {
    seeded = await seedFixture("minimal")
    lead = api(seeded.projectId, seeded.token)
    const a = await join(seeded, "analyst@flintflow.test", "analyst")
    analyst = { userId: a.userId, c: api(seeded.projectId, a.token) }
    viewer = api(seeded.projectId, (await join(seeded, "viewer@flintflow.test", "viewer")).token)
  })

  it("Lead ghim comment vào một block ⇒ 201 CM-001, nhãn/đoạn trích do server dựng; Analyst nhận thông báo", async () => {
    const section = await firstSection(lead)
    const res = await lead.post("/comments", {
      version: { source: "draft" },
      anchor: { section_id: section.id, block_index: 0 },
      text: "  Cần nói rõ ai được huỷ đặt chỗ.  "
    })
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    expect(res.body.data).toMatchObject({
      comment_id: "CM-001",
      version: { source: "draft", baseline_id: null, label: "draft" },
      anchor: { section_id: section.id, block_index: 0 },
      author_role: "lead",
      text: "Cần nói rõ ai được huỷ đặt chỗ.",
      status: "open",
      cr_id: null,
      replies: []
    })
    expect(res.body.data.anchor.label).toContain(section.heading)
    expect(res.body.data.anchor.label).toContain("Block 1")

    const notes = await Notification.find({ type: "comment_posted" }).lean()
    expect(notes.map((n) => String(n.userId))).toEqual([analyst.userId])
    expect(notes[0].link).toBe(`/projects/${seeded.projectId}/view?comment=CM-001`)
    expect(String(notes[0].organizationId)).toBe(seeded.orgId)

    const second = await analyst.c.post("/comments", { version: { source: "draft" }, anchor: { section_id: section.id }, text: "Ghim cả section" })
    expect(second.status).toBe(201)
    expect(second.body.data).toMatchObject({ comment_id: "CM-002", anchor: { block_index: null, label: `${section.number} ${section.heading}`.trim() } })
  })

  it("text trống / quá 2000 ký tự ⇒ 400; chỗ ghim không có trong bản đang đọc ⇒ 422 COMMENT_ANCHOR_NOT_FOUND", async () => {
    const section = await firstSection(lead)
    const empty = await lead.post("/comments", { version: { source: "draft" }, anchor: { section_id: section.id }, text: "   " })
    expect(empty.status).toBe(400)
    expect(empty.body.error.code).toBe("VALIDATION_ERROR")

    const long = await lead.post("/comments", { version: { source: "draft" }, anchor: { section_id: section.id }, text: "x".repeat(2001) })
    expect(long.status).toBe(400)

    for (const anchor of [{ section_id: "fixed:999" }, { section_id: section.id, block_index: 9999 }]) {
      const res = await lead.post("/comments", { version: { source: "draft" }, anchor, text: "Ở đâu?" })
      expect(res.status, JSON.stringify(anchor)).toBe(422)
      expect(res.body.error.code).toBe("COMMENT_ANCHOR_NOT_FOUND")
    }
  })

  it("Viewer comment trên bản nháp ⇒ 403 COMMENT_VERSION_FORBIDDEN; chưa có baseline ⇒ 404 BASELINE_NOT_FOUND", async () => {
    const section = await firstSection(lead)
    const draft = await viewer.post("/comments", { version: { source: "draft" }, anchor: { section_id: section.id }, text: "Góp ý" })
    expect(draft.status).toBe(403)
    expect(draft.body.error.code).toBe("COMMENT_VERSION_FORBIDDEN")

    const baseline = await viewer.post("/comments", { version: { source: "baseline" }, anchor: { section_id: section.id }, text: "Góp ý" })
    expect(baseline.status).toBe(404)
    expect(baseline.body.error.code).toBe("BASELINE_NOT_FOUND")
  })

  it("mọi vai trò trả lời được; Viewer không Resolve được; Analyst Resolve ⇒ ẩn khỏi danh sách mặc định, Resolve lần hai ⇒ 409", async () => {
    const section = await firstSection(lead)
    await lead.post("/comments", { version: { source: "draft" }, anchor: { section_id: section.id }, text: "Câu hỏi về phạm vi" })

    const reply = await viewer.post("/comments/CM-001/replies", { text: "Tôi cũng thắc mắc" })
    expect(reply.status, JSON.stringify(reply.body.error)).toBe(201)
    expect(reply.body.data.replies).toMatchObject([{ author_role: "viewer", text: "Tôi cũng thắc mắc", author: { name: "viewer" } }])

    const viewerResolve = await viewer.post("/comments/CM-001/resolve")
    expect(viewerResolve.status).toBe(403)
    expect(viewerResolve.body.error.code).toBe("ORG_ROLE_FORBIDDEN")

    const resolved = await analyst.c.post("/comments/CM-001/resolve")
    expect(resolved.status).toBe(200)
    expect(resolved.body.data).toMatchObject({ status: "resolved", handled_by: { name: "analyst" } })

    expect((await viewer.get("/comments")).body.data).toEqual([])
    const all = await viewer.get("/comments?status=all")
    expect(all.body.data.map((c: { comment_id: string }) => c.comment_id)).toEqual(["CM-001"])

    const again = await lead.post("/comments/CM-001/resolve")
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe("COMMENT_NOT_OPEN")

    const missing = await lead.post("/comments/CM-404/replies", { text: "?" })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe("COMMENT_NOT_FOUND")
  })

  it("trả lời ⇒ báo tác giả + người đã trả lời (trừ người vừa viết); Resolve ⇒ báo tác giả, tự Resolve comment của mình thì không", async () => {
    const section = await firstSection(lead)
    const viewerUser = await join(seeded, "viewer2@flintflow.test", "viewer")
    const viewer2 = api(seeded.projectId, viewerUser.token)
    await lead.post("/comments", { version: { source: "draft" }, anchor: { section_id: section.id }, text: "Câu hỏi về phạm vi" })
    await Notification.deleteMany({})
    const recipients = async (type: string) =>
      (await Notification.find({ type }).lean()).map((n) => String(n.userId)).sort()

    // Viewer trả lời ⇒ chỉ tác giả (Lead) được báo
    await viewer2.post("/comments/CM-001/replies", { text: "Phạm vi gồm cả huỷ?" })
    expect(await recipients("comment_replied")).toEqual([seeded.userId])

    // Analyst trả lời ⇒ Lead (tác giả) + Viewer (đã trả lời), không báo chính Analyst
    await Notification.deleteMany({})
    await analyst.c.post("/comments/CM-001/replies", { text: "Có, gồm cả huỷ." })
    expect(await recipients("comment_replied")).toEqual([seeded.userId, viewerUser.userId].sort())
    const note = await Notification.findOne({ type: "comment_replied", userId: viewerUser.userId }).lean()
    expect(note?.link).toBe(`/projects/${seeded.projectId}/view?comment=CM-001`)
    expect(note?.body).toContain("Có, gồm cả huỷ.")
    expect(String(note?.organizationId)).toBe(seeded.orgId)

    // Analyst Resolve comment của Lead ⇒ báo Lead
    await analyst.c.post("/comments/CM-001/resolve")
    expect(await recipients("comment_resolved")).toEqual([seeded.userId])

    // Lead tự Resolve comment của mình ⇒ không báo ai
    await lead.post("/comments", { version: { source: "draft" }, anchor: { section_id: section.id }, text: "Tự ghi chú" })
    await Notification.deleteMany({})
    expect((await lead.post("/comments/CM-002/resolve")).status).toBe(200)
    expect(await recipients("comment_resolved")).toEqual([])
  })

  it("người ngoài org không đọc được comment của project", async () => {
    const outsider = await seedFixture("minimal", { email: "outsider@flintflow.test" })
    const res = await api(seeded.projectId, outsider.token).get("/comments")
    expect(res.status).toBe(404)
  })
})

describe("UC-49 — Viewer comment trên baseline, Analyst chuyển thành change request (mode 1)", () => {
  it("Viewer ghim trên 0.0 ⇒ Analyst tạo CR từ comment ⇒ comment converted + báo tác giả; chuyển lần hai ⇒ 409", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    const c = mode1Api(seeded, projectId)
    const id = (await c.upload(await makeSrsDocx())).body.data.import.id as string
    await c.post("/import/confirm-latest", { import_id: id })
    await c.extractAndWait(id)
    await c.patch("/import/fields", { import_id: id, confirm_all: true })
    const fin = await c.post("/import/finalize", { import_id: id, base_version: await c.spineVersion() })
    expect(fin.status, JSON.stringify(fin.body.error)).toBe(200)

    const viewerUser = await join(seeded, "viewer@flintflow.test", "viewer")
    const viewer = api(projectId, viewerUser.token)
    const analyst = api(projectId, (await join(seeded, "analyst@flintflow.test", "analyst")).token)

    const baselines = (await viewer.get("/baselines")).body.data as Array<{ id: string; version: string }>
    expect(baselines.length).toBeGreaterThan(0)
    const section = await firstSection(viewer, `?source=baseline&baseline_id=${baselines[0].id}`)

    const posted = await viewer.post("/comments", {
      version: { source: "baseline", baseline_id: baselines[0].id },
      anchor: { section_id: section.id },
      text: "Thời gian phản hồi 2 giây là quá chậm."
    })
    expect(posted.status, JSON.stringify(posted.body.error)).toBe(201)
    expect(posted.body.data.version).toMatchObject({ source: "baseline", label: baselines[0].version })

    // Viewer không tạo CR được dù gửi comment_id
    const crBody = {
      title: "Phản hồi nhanh hơn",
      description: "Thời gian phản hồi 2 giây là quá chậm.",
      source: { kind: "viewer_comment", ref: "CM-001" },
      requester: "viewer",
      comment_id: "CM-001"
    }
    expect((await viewer.post("/change-requests", crBody)).status).toBe(403)

    const wrongSource = await analyst.post("/change-requests", { ...crBody, source: { kind: "verbal", ref: null } })
    expect(wrongSource.status).toBe(400)

    const created = await analyst.post("/change-requests", crBody)
    expect(created.status, JSON.stringify(created.body.error)).toBe(201)
    const crId = changeRequestDetailSchema.parse(created.body.data).change_request.cr_id

    const list = await viewer.get("/comments?status=all")
    expect(list.body.data[0]).toMatchObject({ comment_id: "CM-001", status: "converted", cr_id: crId })

    const note = await Notification.findOne({ type: "comment_converted" }).lean()
    expect(String(note?.userId)).toBe(viewerUser.userId)
    expect(note?.title).toContain(crId)

    const again = await analyst.post("/change-requests", crBody)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe("COMMENT_NOT_OPEN")
  })
})
