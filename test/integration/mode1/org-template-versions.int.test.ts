/**
 * FLF-395 — version của mẫu tổ chức, API + Mongo thật:
 *  A. Chỉ Lead đăng mẫu / bản mới (upload ⇒ bản nháp ⇒ rà mapping ⇒ đăng); Analyst bị chặn ở mọi đường, kể cả lưu từ dự án.
 *  B. Dự án theo bản cũ: đăng bản mới ⇒ báo Lead + Analyst (không Viewer), chi tiết project có `template_update` (Viewer không).
 *     Import nhớ bản nên mapping theo đúng bản lúc import.
 *  C. Mẫu / bản của org khác ⇒ 404.
 *  D. Họ mẫu cũ (trước FLF-395) ⇒ bản 1 có `table_map` + `language` khi dùng lần đầu; xoá từng bản, hết bản thì xoá họ.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import request from "supertest"
import app from "../../../src/app.js"
import { authAs, seedFixture } from "../../setup.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, fakeMode1 } from "../../helpers/mode1.js"
import { p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { docFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { OrgTemplate, OrgTemplateVersion } from "../../../src/modules/import/org-library.model.js"
import { orgTemplateHeadings } from "../../../src/modules/import/org-mapping.js"
import { Membership, type OrgRole } from "../../../src/modules/organization/membership.model.js"
import { Notification } from "../../../src/modules/notification/notification.model.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { User } from "../../../src/modules/user/user.model.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const H = (token: string) => ({ Authorization: `Bearer ${token}` })
const EXTRA = styled("u1", "6 Operating Environment") + p("[Describe the operating environment.]") + styled("u1", "7 Document Conventions") + p("[Describe conventions.]")

let memberSeq = 0
const memberOf = async (orgId: string, role: OrgRole) => {
  memberSeq += 1
  const user = await User.create({ email: `${role}-${memberSeq}-${Date.now()}@flintflow.test`, password: "test-password-123", emailVerified: true })
  await Membership.create({ userId: user._id, organizationId: orgId, role })
  return { userId: String(user._id), token: await authAs({ _id: user._id, email: user.email, orgId }) }
}

const uploadTemplate = (token: string, url: string, file: Buffer, name?: string) => {
  const req = request(app).post(url).set(H(token)).attach("file", file, "Mau ngan hang.docx")
  return name ? req.field("name", name) : req
}

describe("FLF-395 — version của mẫu tổ chức", () => {
  it("A. Lead tải mẫu ⇒ bản nháp ⇒ rà mapping ⇒ đăng; Analyst bị chặn mọi đường; bản nháp chỉ Lead thấy", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const analyst = await memberOf(lead.orgId, "analyst")
    const base = `/api/v1/orgs/${lead.orgId}/templates`
    const file = await makeSrsDocx({ extraBody: EXTRA })

    const denied = await uploadTemplate(analyst.token, base, file, "Mẫu lậu")
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
    expect(await OrgTemplate.countDocuments({ orgId: lead.orgId })).toBe(0)

    await User.updateOne({ _id: lead.userId }, { $set: { name: "Lead Hien Thi" } })
    const draft = await uploadTemplate(lead.token, base, file, "Mẫu ngân hàng")
    expect(draft.status, JSON.stringify(draft.body.error)).toBe(201)
    expect(draft.body.data).toMatchObject({ name: "Mẫu ngân hàng", version: 1, status: "draft", published_by: { id: lead.userId, name: "Lead Hien Thi" } })
    const templateId = draft.body.data.template_id as string
    const conventions = (draft.body.data.headings as { index: number; heading_text: string }[]).find((h) => h.heading_text.includes("Document Conventions"))!

    // Bản nháp: Analyst không thấy họ mẫu, không xem / đăng được
    expect((await request(app).get(base).set(H(analyst.token))).body.data).toEqual([])
    expect((await request(app).get(`${base}/${templateId}/versions/1`).set(H(analyst.token))).status).toBe(404)
    expect((await request(app).post(`${base}/${templateId}/versions/1/publish`).set(H(analyst.token)).send({})).status).toBe(403)
    expect((await request(app).get(base).set(H(lead.token))).body.data[0]).toMatchObject({ id: templateId, latest_version: 0, versions: [{ version: 1, status: "draft" }] })

    const badSection = await request(app).post(`${base}/${templateId}/versions/1/publish`).set(H(lead.token)).send({ headings: [{ index: conventions.index, section_id: "nope" }] })
    expect(badSection.status).toBe(400)
    const published = await request(app)
      .post(`${base}/${templateId}/versions/1/publish`)
      .set(H(lead.token))
      .send({ headings: [{ index: conventions.index, section_id: "unmapped" }] })
    expect(published.status, JSON.stringify(published.body.error)).toBe(200)
    expect(published.body.data.headings[conventions.index]).toMatchObject({ section_id: "unmapped" })
    expect((await request(app).post(`${base}/${templateId}/versions/1/publish`).set(H(lead.token)).send({})).status).toBe(409)

    const listed = (await request(app).get(base).set(H(analyst.token))).body.data
    expect(listed).toMatchObject([{ id: templateId, latest_version: 1, skeleton_source_project_id: null, versions: [{ version: 1, status: "published", project_count: 0 }] }])
    // Người đăng: id + tên hiển thị của thành viên org
    expect(listed[0].versions[0].published_by).toEqual({ id: lead.userId, name: "Lead Hien Thi" })
    const stored = (await OrgTemplateVersion.findOne({ template_id: templateId, version: 1 }))!
    expect(stored.table_map.length).toBeGreaterThan(0)
    expect(stored.language).toBe("en")

    // Bản mới của họ có sẵn: Analyst cũng bị chặn
    expect((await uploadTemplate(analyst.token, `${base}/${templateId}/versions`, file)).status).toBe(403)

    // Lưu từ dự án (đường cũ) cũng chỉ Lead
    const projectId = await createMode1Project(lead)
    await request(app).post(`/api/v1/projects/${projectId}/import/from-org`).set(H(lead.token)).send({ org_template_id: templateId })
    const saveDenied = await request(app).post(`/api/v1/projects/${projectId}/import/save-to-org`).set(H(analyst.token)).send({ name: "Lậu" })
    expect(saveDenied.status).toBe(403)
    const saved = await request(app).post(`/api/v1/projects/${projectId}/import/save-to-org`).set(H(lead.token)).send({ name: "x", template_id: templateId })
    expect(saved.status, JSON.stringify(saved.body.error)).toBe(201)
    expect(saved.body.data).toMatchObject({ id: templateId, latest_version: 2 })
    expect((await Project.findById(projectId).lean())!.template_ref).toMatchObject({ version: 2 })
  })

  it("B. đăng bản mới ⇒ báo Lead + Analyst có dự án theo bản cũ (không Viewer); template_update chỉ cho Lead / Analyst; import nhớ bản", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const otherLead = await memberOf(lead.orgId, "lead")
    const analyst = await memberOf(lead.orgId, "analyst")
    const viewer = await memberOf(lead.orgId, "viewer")
    const base = `/api/v1/orgs/${lead.orgId}/templates`
    const file = await makeSrsDocx({ extraBody: EXTRA })

    const v1 = await uploadTemplate(lead.token, base, file, "Mẫu ngân hàng")
    const templateId = v1.body.data.template_id as string
    await request(app).post(`${base}/${templateId}/versions/1/publish`).set(H(lead.token)).send({})

    const projectId = await createMode1Project(lead)
    const used = await request(app).post(`/api/v1/projects/${projectId}/import/from-org`).set(H(lead.token)).send({ org_template_id: templateId })
    expect(used.status, JSON.stringify(used.body.error)).toBe(201)
    const doc = (await ImportedDocument.findOne({ projectId }).sort({ createdAt: -1 }))!
    expect(doc.org_template_version).toBe(1)
    expect((await Project.findById(projectId).lean())!.template_ref).toMatchObject({ version: 1 })
    expect((await request(app).get(`/api/v1/projects/${projectId}`).set(H(lead.token))).body.data.template_update).toBeNull()

    // v2: đổi mapping heading đầu tiên — import cũ vẫn đọc mapping v1
    const v2 = await uploadTemplate(lead.token, `${base}/${templateId}/versions`, file)
    expect(v2.body.data.version).toBe(2)
    const published = await request(app).post(`${base}/${templateId}/versions/2/publish`).set(H(lead.token)).send({ headings: [{ index: 0, section_id: "unmapped" }] })
    expect(published.status, JSON.stringify(published.body.error)).toBe(200)
    const pinned = await orgTemplateHeadings(doc.org_template_id!, doc.org_template_version ?? null)
    expect(pinned![0].section_id).not.toBe("unmapped")

    const notified = await Notification.find({ type: "template_version_published" }).lean()
    expect(notified.map((n) => String(n.userId)).sort()).toEqual([otherLead.userId, analyst.userId].sort())
    expect(notified[0]).toMatchObject({ link: `/projects/${projectId}`, meta: { template_id: templateId, version: 2, project_ids: [projectId] } })

    const update = { template_id: templateId, name: "Mẫu ngân hàng", current_version: 1, latest_version: 2 }
    expect((await request(app).get(`/api/v1/projects/${projectId}`).set(H(analyst.token))).body.data.template_update).toEqual(update)
    expect((await request(app).get(`/api/v1/projects/${projectId}`).set(H(lead.token))).body.data.template_update).toEqual(update)
    expect((await request(app).get(`/api/v1/projects/${projectId}`).set(H(viewer.token))).body.data.template_update).toBeNull()

    // Chọn đúng bản khi tạo dự án (D16)
    const second = await createMode1Project(lead, "Bank app 2")
    await request(app).post(`/api/v1/projects/${second}/import/from-org`).set(H(lead.token)).send({ org_template_id: templateId, version: 1 })
    expect((await Project.findById(second).lean())!.template_ref).toMatchObject({ version: 1 })
    const list = (await request(app).get(base).set(H(lead.token))).body.data[0]
    expect(list.versions.map((v: { version: number; project_count: number }) => [v.version, v.project_count])).toEqual([[2, 0], [1, 2]])
  })

  it("C. mẫu / bản của org khác ⇒ 404 ở mọi endpoint", async () => {
    const owner = await seedFixture("minimal", { balance: 1000 })
    const v1 = await uploadTemplate(owner.token, `/api/v1/orgs/${owner.orgId}/templates`, await makeSrsDocx({ extraBody: EXTRA }), "Mẫu A")
    const templateId = v1.body.data.template_id as string

    const stranger = await seedFixture("minimal")
    const theirs = `/api/v1/orgs/${stranger.orgId}/templates/${templateId}`
    expect((await request(app).get(`${theirs}/versions/1`).set(H(stranger.token))).status).toBe(404)
    expect((await request(app).post(`${theirs}/versions/1/publish`).set(H(stranger.token)).send({})).status).toBe(404)
    expect((await request(app).delete(`${theirs}/versions/1`).set(H(stranger.token))).status).toBe(404)
    expect((await uploadTemplate(stranger.token, `${theirs}/versions`, await makeSrsDocx())).status).toBe(404)
    // Gọi thẳng org của người khác ⇒ membership guard trả 404 (không lộ org)
    expect((await request(app).get(`/api/v1/orgs/${owner.orgId}/templates`).set(H(stranger.token))).status).toBe(404)
    expect(await OrgTemplateVersion.countDocuments({ template_id: templateId })).toBe(1)
  })

  it("D. họ mẫu cũ ⇒ bản 1 khi dùng lần đầu; xoá từng bản trả số dự án, hết bản xoá họ", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const buffer = await makeSrsDocx({ extraBody: EXTRA })
    const fileRef = await docFileStore().save(buffer, { projectId: `org-${lead.orgId}`, kind: "upload", name: "legacy.docx" })
    const legacy = await OrgTemplate.create({
      orgId: lead.orgId,
      name: "Mẫu cũ",
      created_by: lead.userId,
      source_file: { name: "legacy.docx", size: buffer.length, sha256: "a".repeat(64) },
      file_ref: fileRef,
      template_family: "fpt",
      headings: [{ heading_text: "1 Introduction", section_id: "group:1" }]
    })
    const base = `/api/v1/orgs/${lead.orgId}/templates`
    expect((await request(app).get(base).set(H(lead.token))).body.data).toMatchObject([{ id: String(legacy._id), versions: [{ version: 1, status: "published" }] }])

    const projectId = await createMode1Project(lead)
    const used = await request(app).post(`/api/v1/projects/${projectId}/import/from-org`).set(H(lead.token)).send({ org_template_id: String(legacy._id) })
    expect(used.status, JSON.stringify(used.body.error)).toBe(201)
    const v1 = (await OrgTemplateVersion.findOne({ template_id: legacy._id, version: 1 }).lean())!
    expect(v1.headings).toEqual([{ heading_text: "1 Introduction", section_id: "group:1" }])
    expect(v1.table_map.length).toBeGreaterThan(0)
    const family = (await OrgTemplate.findById(legacy._id).lean())!
    expect(family.latest_version).toBe(1)
    // Field cũ giữ để bản deploy cũ còn đọc được; version_seq đánh dấu đã tách
    expect(family.version_seq).toBe(1)
    expect(family.file_ref).toBe(fileRef)

    const analyst = await memberOf(lead.orgId, "analyst")
    const v2 = await uploadTemplate(lead.token, `${base}/${String(legacy._id)}/versions`, buffer)
    expect(v2.body.data.version).toBe(2)
    // Chỉ Lead xoá được bản / mẫu
    expect((await request(app).delete(`${base}/${String(legacy._id)}/versions/1`).set(H(analyst.token))).status).toBe(403)
    expect((await request(app).delete(`${base}/${String(legacy._id)}`).set(H(analyst.token))).status).toBe(403)
    const removed = await request(app).delete(`${base}/${String(legacy._id)}/versions/1`).set(H(lead.token))
    expect(removed.status, JSON.stringify(removed.body.error)).toBe(200)
    expect(removed.body.data).toEqual({ deleted: true, project_count: 1, template_deleted: false })
    expect((await OrgTemplate.findById(legacy._id).lean())!.latest_version).toBe(0)
    // Số đã cấp không bị dùng lại: dự án còn gắn {t, 1} không bị trỏ sang file khác
    const v3 = await uploadTemplate(lead.token, `${base}/${String(legacy._id)}/versions`, buffer)
    expect(v3.body.data.version).toBe(3)
    await request(app).delete(`${base}/${String(legacy._id)}/versions/3`).set(H(lead.token))
    const last = await request(app).delete(`${base}/${String(legacy._id)}/versions/2`).set(H(lead.token))
    expect(last.body.data).toMatchObject({ template_deleted: true })
    expect(await OrgTemplate.countDocuments({ _id: legacy._id })).toBe(0)
  })

  it("E. dự án tải file riêng thay mẫu tổ chức (trước baseline) ⇒ bỏ gắn mẫu, không còn template_update", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const base = `/api/v1/orgs/${lead.orgId}/templates`
    const file = await makeSrsDocx({ extraBody: EXTRA })
    const templateId = (await uploadTemplate(lead.token, base, file, "Mẫu A")).body.data.template_id as string
    await request(app).post(`${base}/${templateId}/versions/1/publish`).set(H(lead.token)).send({})
    const projectId = await createMode1Project(lead)
    await request(app).post(`/api/v1/projects/${projectId}/import/from-org`).set(H(lead.token)).send({ org_template_id: templateId })
    expect((await Project.findById(projectId).lean())!.template_ref).toMatchObject({ version: 1 })

    const own = await request(app).post(`/api/v1/projects/${projectId}/import`).set(H(lead.token)).attach("file", await makeSrsDocx(), "srs.docx")
    expect(own.status, JSON.stringify(own.body.error)).toBe(201)
    expect((await Project.findById(projectId).lean())!.template_ref).toBeNull()
  })
})
