/**
 * FLF-395 (D12, D13) — dự án mẫu tự do có baseline ⇒ tự lưu khung thành mẫu tổ chức, API + Mongo thật:
 *  A. Finalize 0.1 ⇒ họ mẫu khung (tên theo ngôn ngữ tài liệu) bản 1, dự án gắn bản đó; file khung không có nội dung dự án;
 *     mục BA tự đặt chờ duyệt, chưa vào file.
 *  B. Duyệt (Lead / Analyst; Viewer bị chặn): giữ dạng chung ⇒ dựng lại file, không đổi số bản; "Gợi ý tên chung" gọi AI một lượt.
 *  C. Dự án khác cùng khung ⇒ không lưu thêm, gắn bản có sẵn; khung không đổi ⇒ không thêm bản; khung đổi ⇒ bản 2.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import JSZip from "jszip"
import request from "supertest"
import app from "../../../src/app.js"
import { authAs, seedFixture, type SeededFixture } from "../../setup.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, fakeMode1 } from "../../helpers/mode1.js"
import { fileOf } from "../../helpers/mode1-import-p4.js"
import { p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { makeSrsDocx, SRS_FIXTURE_TEXT } from "../../../src/modules/import/testing/srs-fixture.js"
import { docFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { acceptLatest, uploadImport } from "../../../src/modules/import/import.service.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { finalizeImport } from "../../../src/modules/import/finalize.service.js"
import { OrgTemplate, OrgTemplateVersion } from "../../../src/modules/import/org-library.model.js"
import { autoSaveSkeleton } from "../../../src/modules/import/template-skeleton.service.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { Membership, type OrgRole } from "../../../src/modules/organization/membership.model.js"
import { Notification } from "../../../src/modules/notification/notification.model.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { User } from "../../../src/modules/user/user.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

const SKELETON_PROMPT = "Generic names for custom template headings"
const fakeSuggest = (prompt: string): string | undefined => {
  if (!prompt.includes(SKELETON_PROMPT)) return undefined
  const keys = [...prompt.matchAll(/^(B\d{4,}): /gm)].map((m) => m[1])
  return JSON.stringify({ suggestions: keys.map((key) => ({ key, generic: "9 {Customer name} Integration (AI)", reason: null })) })
}

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = (prompt: string) => fakeSuggest(prompt) ?? fakeMode1(prompt)
})

const H = (token: string) => ({ Authorization: `Bearer ${token}` })
const PROJECT = "Lumen import"
const CUSTOM = styled("u1", `9 ${PROJECT} Integration`) + p("Calls the Lumen ledger API every night.")

let seq = 0
const memberOf = async (orgId: string, role: OrgRole) => {
  seq += 1
  const user = await User.create({ email: `${role}-sk-${seq}-${Date.now()}@flintflow.test`, password: "test-password-123", emailVerified: true })
  await Membership.create({ userId: user._id, organizationId: orgId, role })
  return { userId: String(user._id), token: await authAs({ _id: user._id, email: user.email, orgId }) }
}

/** Upload → I-4 → finalize (baseline 0.1) cho một dự án mới trong org cho trước. */
const finalizedIn = async (seeded: SeededFixture, buffer: Buffer, name = PROJECT): Promise<string> => {
  const projectId = await createMode1Project(seeded, name)
  const doc = await uploadImport(projectId, seeded.userId, fileOf(buffer))
  await acceptLatest(doc, true)
  await runExtraction(projectId, seeded.userId, String(doc._id))
  const before = (await spineRepository.get(projectId))!
  await finalizeImport(projectId, seeded.userId, { import_id: String(doc._id), base_version: before.spine_version })
  return projectId
}

const textOfFile = async (ref: string) => {
  const zip = await JSZip.loadAsync(await docFileStore().load(ref))
  return (await Promise.all(Object.values(zip.files).filter((f) => !f.dir).map((f) => f.async("string")))).join("\n")
}

describe("FLF-395 — tự lưu khung mẫu sau baseline", () => {
  it("A + B. finalize ⇒ khung bản 1, mục riêng chờ duyệt; duyệt giữ dạng chung / gợi ý AI; Viewer bị chặn", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const analyst = await memberOf(lead.orgId, "analyst")
    const viewer = await memberOf(lead.orgId, "viewer")
    const projectId = await finalizedIn(lead, await makeSrsDocx({ extraBody: CUSTOM }))

    const project = (await Project.findById(projectId).lean())!
    expect(project.template_ref).toMatchObject({ version: 1 })
    const family = (await OrgTemplate.findById(project.template_ref!.template_id).lean())!
    expect(family).toMatchObject({ name: `${PROJECT} — template`, latest_version: 1 })
    expect(String(family.skeleton_of)).toBe(projectId)
    const v1 = (await OrgTemplateVersion.findOne({ template_id: family._id, version: 1 }).lean())!
    expect(v1).toMatchObject({ status: "published", visibility: "org" })
    expect(v1.skeleton_hash).toMatch(/^[a-f0-9]{64}$/)
    const text = await textOfFile(v1.file_ref)
    expect(text).not.toContain("Lumen ledger")
    expect(text).not.toContain(`${PROJECT} Integration`)
    for (const sample of Object.values(SRS_FIXTURE_TEXT).filter((s): s is string => typeof s === "string" && s.length > 20).slice(0, 5)) {
      expect(text, sample).not.toContain(sample)
    }

    const pending = await request(app).get(`/api/v1/projects/${projectId}/template-skeleton`).set(H(analyst.token))
    expect(pending.status, JSON.stringify(pending.body.error)).toBe(200)
    expect(pending.body.data).toMatchObject({ version: 1, suggest_credit_cost: 1 })
    // Fixture có sẵn mục riêng "5.9 Team Notes" + mục chứa tên dự án; tên mục khác tên chuẩn (nếu có) cũng chờ duyệt
    const headings = pending.body.data.headings as { key: string; heading_text: string; kind: string; decision: string }[]
    expect(pending.body.data.pending_count).toBe(headings.filter((h) => h.decision === "pending").length)
    expect(pending.body.data.pending_count).toBeGreaterThanOrEqual(2)
    const item = headings.find((h) => h.heading_text.includes("Integration"))!
    expect(item).toMatchObject({ heading_text: `9 ${PROJECT} Integration`, kind: "custom", decision: "pending", suggestion: "9 {Customer name} Integration" })
    expect(headings.find((h) => h.heading_text.includes("Team Notes"))).toMatchObject({ kind: "custom" })
    expect(await Notification.countDocuments({ type: "skeleton_headings_pending", organizationId: lead.orgId })).toBe(2)
    const listed = (await request(app).get(`/api/v1/orgs/${lead.orgId}/templates`).set(H(analyst.token))).body.data[0]
    expect(listed).toMatchObject({ skeleton: true, pending_count: pending.body.data.pending_count, skeleton_source_project_id: projectId })

    const suggested = await request(app).post(`/api/v1/projects/${projectId}/template-skeleton/suggest`).set(H(lead.token))
    expect(suggested.status, JSON.stringify(suggested.body.error)).toBe(200)
    expect(new Set(suggested.body.data.headings.map((h: { suggestion: string }) => h.suggestion))).toEqual(new Set(["9 {Customer name} Integration (AI)"]))

    const denied = await request(app).post(`/api/v1/projects/${projectId}/template-skeleton/decisions`).set(H(viewer.token)).send({ decisions: [{ key: item.key, decision: "keep" }] })
    expect(denied.status).toBe(403)

    // Mục chứa tên dự án ⇒ dạng chung; tên mục khác tên chuẩn ⇒ giữ chữ; mục riêng khác ⇒ bỏ
    const decisions = headings.map((h) =>
      h.key === item.key ? { key: h.key, decision: "generic", generic_text: "9 {Customer name} Integration" } : { key: h.key, decision: h.kind === "wording" ? "keep" : "drop" }
    )
    const decided = await request(app).post(`/api/v1/projects/${projectId}/template-skeleton/decisions`).set(H(analyst.token)).send({ decisions })
    expect(decided.status, JSON.stringify(decided.body.error)).toBe(200)
    expect(decided.body.data).toMatchObject({ version: 1, pending_count: 0 })
    const after = (await OrgTemplateVersion.findOne({ template_id: family._id, version: 1 }).lean())!
    expect(after.file_ref).not.toBe(v1.file_ref)
    expect(after.skeleton_hash).not.toBe(v1.skeleton_hash)
    const rebuilt = await textOfFile(after.file_ref)
    expect(rebuilt).toContain("9 {Customer name} Integration")
    expect(rebuilt).not.toContain("Lumen ledger")
    expect(rebuilt).not.toContain("Team Notes")
    expect(await OrgTemplateVersion.countDocuments({ template_id: family._id })).toBe(1)
  })

  it("C. dự án khác cùng khung ⇒ gắn bản có sẵn; phát hành lại không đổi ⇒ không thêm bản; khung đổi ⇒ bản mới / họ riêng", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const buffer = await makeSrsDocx()
    const first = await finalizedIn(lead, buffer)
    const ref = (await Project.findById(first).lean())!.template_ref!
    const second = await finalizedIn(lead, buffer, "Other bank")
    expect((await Project.findById(second).lean())!.template_ref).toMatchObject({ template_id: ref.template_id, version: ref.version })
    expect(await OrgTemplate.countDocuments({ orgId: lead.orgId })).toBe(1)

    // Phát hành lại, khung không đổi
    const released = (await DocVersion.findOne({ projectId: first }).sort({ createdAt: -1 }).lean())!
    await autoSaveSkeleton(first, lead.userId, released.file_ref)
    expect(await OrgTemplateVersion.countDocuments({ template_id: ref.template_id })).toBe(1)

    // Bản phát hành sau có thêm mục riêng (qua CR) ⇒ khung đổi ⇒ bản 2 của họ khung của dự án
    const changed = await docFileStore().save(await makeSrsDocx({ extraBody: styled("u1", "9 Payroll Notes") + p("Payroll runs monthly.") }), { projectId: first, kind: "version", name: "2.0" })
    await autoSaveSkeleton(first, lead.userId, changed)
    expect((await Project.findById(first).lean())!.template_ref).toMatchObject({ version: 2 })
    expect((await OrgTemplate.findById(ref.template_id).lean())!.latest_version).toBe(2)
    // Dự án kia vẫn theo bản 1, không được báo bản mới (khung tự lưu chỉ thuộc dự án nguồn); nó đổi khung ⇒ có họ khung riêng
    expect((await Project.findById(second).lean())!.template_ref).toMatchObject({ version: 1 })
    expect(await Notification.countDocuments({ type: "template_version_published", organizationId: lead.orgId })).toBe(0)
    const detail = await request(app).get(`/api/v1/projects/${second}`).set(H(lead.token))
    expect(detail.body.data.template_update).toBeNull()
    const otherChange = await docFileStore().save(await makeSrsDocx({ extraBody: styled("u1", "9 Warehouse Notes") + p("x") }), { projectId: second, kind: "version", name: "2.0" })
    await autoSaveSkeleton(second, lead.userId, otherChange)
    const own = (await Project.findById(second).lean())!.template_ref!
    expect(String(own.template_id)).not.toBe(String(ref.template_id))
    expect(String((await OrgTemplate.findById(own.template_id).lean())!.skeleton_of)).toBe(second)
  })

  it("dự án theo mẫu bắt buộc ⇒ không tự lưu khung", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await finalizedIn(lead, await makeSrsDocx())
    await OrgTemplate.deleteMany({ orgId: lead.orgId })
    await Project.updateOne({ _id: projectId }, { $set: { template_intent: "fixed", template_ref: null } })
    const released = (await DocVersion.findOne({ projectId }).sort({ createdAt: -1 }).lean())!
    await autoSaveSkeleton(projectId, lead.userId, released.file_ref)
    expect(await OrgTemplate.countDocuments({ orgId: lead.orgId })).toBe(0)
  })

  it("dự án đang theo mẫu org do Lead đăng ⇒ không tự lưu khung", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await finalizedIn(lead, await makeSrsDocx())
    const own = (await Project.findById(projectId).lean())!.template_ref!
    // Giả lập dự án gắn một mẫu Lead đăng: họ không phải khung của dự án
    await OrgTemplate.updateOne({ _id: own.template_id }, { $set: { skeleton_of: null } })
    const changed = await docFileStore().save(await makeSrsDocx({ extraBody: styled("u1", "9 Payroll Notes") + p("x") }), { projectId, kind: "version", name: "2.0" })
    await autoSaveSkeleton(projectId, lead.userId, changed)
    expect(await OrgTemplateVersion.countDocuments({ template_id: own.template_id })).toBe(1)
    expect(await OrgTemplate.countDocuments({ orgId: lead.orgId })).toBe(1)
  })
})
