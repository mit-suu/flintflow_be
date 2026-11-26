/**
 * UC-85 / UC-88 - đề xuất lưu cấu trúc dự án thành mẫu tổ chức, API + Mongo thật:
 *  A. Analyst tạo baseline ⇒ đề xuất (chưa vào thư viện), AI đổi tên riêng; chỉ tác giả thấy thẻ; Send to Lead ⇒ Lead duyệt ⇒
 *     mẫu khung trong thư viện (file không có nội dung dự án), dự án nguồn theo bản đó, người gửi được báo.
 *  B. Lead tác giả: Save to library ⇒ đăng thẳng. Don't save / Reject ⇒ cùng cấu trúc không đề xuất lại.
 *  C. Dự án khác cùng khung ⇒ theo bản có sẵn, không đề xuất; khung đổi ⇒ đề xuất mới thay đề xuất cũ.
 *  D. Lead lưu cấu trúc bất cứ lúc nào; thiếu credit ⇒ không đề xuất; dự án theo mẫu Lead đăng cùng cấu trúc ⇒ không đề xuất.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import JSZip from "jszip"
import request from "supertest"
import app from "../../../src/app.js"
import { authAs, seedFixture, type SeededFixture } from "../../setup.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, fakeMode1 } from "../../helpers/mode1.js"
import { fileOf, runExtraction } from "../../helpers/mode1-import-p4.js"
import { p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { makeSrsDocx, SRS_FIXTURE_TEXT } from "../../../src/modules/import/testing/srs-fixture.js"
import { docFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { acceptLatest, uploadImport } from "../../../src/modules/import/import.service.js"
import { finalizeImport } from "../../../src/modules/import/finalize.service.js"
import { OrgTemplate, OrgTemplateVersion } from "../../../src/modules/import/org-library.model.js"
import { TemplateProposal } from "../../../src/modules/import/template-proposal.model.js"
import { proposeTemplateFromBaseline } from "../../../src/modules/import/template-skeleton.service.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { Membership, type OrgRole } from "../../../src/modules/organization/membership.model.js"
import { Notification } from "../../../src/modules/notification/notification.model.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { User } from "../../../src/modules/user/user.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

const PROJECT = "Lumen import"
const SKELETON_PROMPT = "Generic names for custom template headings"

/** AI giả: tên dự án ⇒ `{Customer name}`; mục ghi chú nội bộ ⇒ bỏ; mục khác giữ nguyên. */
const fakeSuggest = (prompt: string): string | undefined => {
  if (!prompt.includes(SKELETON_PROMPT)) return undefined
  const items = [...prompt.matchAll(/^(B\d{4,}): (.+)$/gm)].map((m) => ({ key: m[1], heading: m[2] }))
  return JSON.stringify({
    suggestions: items.map(({ key, heading }) =>
      heading.includes("Team Notes") ? { key, generic: null, reason: "Internal notes" } : { key, generic: heading.replace(PROJECT, "{Customer name}"), reason: null }
    )
  })
}

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = (prompt: string) => fakeSuggest(prompt) ?? fakeMode1(prompt)
})

const H = (token: string) => ({ Authorization: `Bearer ${token}` })
const CUSTOM = styled("u1", `9 ${PROJECT} Integration`) + p("Calls the Lumen ledger API every night.")

let seq = 0
const memberOf = async (orgId: string, role: OrgRole) => {
  seq += 1
  const user = await User.create({ email: `${role}-sk-${seq}-${Date.now()}@flintflow.test`, password: "test-password-123", emailVerified: true })
  await Membership.create({ userId: user._id, organizationId: orgId, role })
  return { userId: String(user._id), token: await authAs({ _id: user._id, email: user.email, orgId }) }
}

/** Upload → I-4 → finalize (baseline 0.1) cho một dự án mới trong org; `authorId` = người tạo baseline. */
const finalizedIn = async (seeded: SeededFixture, buffer: Buffer, name = PROJECT, authorId = seeded.userId): Promise<string> => {
  const projectId = await createMode1Project(seeded, name)
  const doc = await uploadImport(projectId, authorId, fileOf(buffer))
  await acceptLatest(doc, true)
  await runExtraction(projectId, authorId, String(doc._id))
  const before = (await spineRepository.get(projectId))!
  await finalizeImport(projectId, authorId, { import_id: String(doc._id), base_version: before.spine_version })
  return projectId
}

const textOfFile = async (ref: string) => {
  const zip = await JSZip.loadAsync(await docFileStore().load(ref))
  return (await Promise.all(Object.values(zip.files).filter((f) => !f.dir).map((f) => f.async("string")))).join("\n")
}

const latestFile = async (projectId: string) => (await DocVersion.findOne({ projectId }).sort({ createdAt: -1 }).lean())!.file_ref

describe("UC-85 / UC-88 - đề xuất mẫu từ dự án", () => {
  it("A. Analyst: đề xuất chưa vào thư viện, AI đổi tên riêng; Send to Lead ⇒ Lead duyệt ⇒ mẫu khung, dự án theo mẫu", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const analyst = await memberOf(lead.orgId, "analyst")
    const viewer = await memberOf(lead.orgId, "viewer")
    const projectId = await finalizedIn(lead, await makeSrsDocx({ extraBody: CUSTOM }), PROJECT, analyst.userId)

    // Chưa vào thư viện, dự án chưa theo mẫu nào
    expect(await OrgTemplate.countDocuments({ orgId: lead.orgId })).toBe(0)
    expect((await Project.findById(projectId).lean())!.template_ref ?? null).toBeNull()

    const card = await request(app).get(`/api/v1/projects/${projectId}/template-proposal`).set(H(analyst.token))
    expect(card.status, JSON.stringify(card.body.error)).toBe(200)
    expect(card.body.data).toMatchObject({ status: "proposed", project_name: PROJECT, created_by: { id: analyst.userId } })
    const replaced = card.body.data.replaced_names as { original: string; generic: string | null }[]
    expect(replaced).toContainEqual(expect.objectContaining({ original: `9 ${PROJECT} Integration`, generic: "9 {Customer name} Integration" }))
    expect(replaced).toContainEqual(expect.objectContaining({ generic: null }))
    expect(card.body.data.headings).toContain("9 {Customer name} Integration")
    // Chỉ tác giả baseline thấy thẻ
    expect((await request(app).get(`/api/v1/projects/${projectId}/template-proposal`).set(H(lead.token))).body.data).toBeNull()

    // Viewer không gửi được; Analyst gửi
    expect((await request(app).post(`/api/v1/projects/${projectId}/template-proposal/send`).set(H(viewer.token))).status).toBe(403)
    const sent = await request(app).post(`/api/v1/projects/${projectId}/template-proposal/send`).set(H(analyst.token))
    expect(sent.status, JSON.stringify(sent.body.error)).toBe(200)
    expect(sent.body.data.status).toBe("sent")
    expect(await Notification.countDocuments({ type: "template_proposal_submitted", userId: lead.userId })).toBe(1)

    // Analyst không xem được danh sách duyệt; Lead thấy đề xuất
    expect((await request(app).get(`/api/v1/orgs/${lead.orgId}/template-proposals`).set(H(analyst.token))).status).toBe(403)
    const list = await request(app).get(`/api/v1/orgs/${lead.orgId}/template-proposals`).set(H(lead.token))
    expect(list.body.data).toHaveLength(1)
    const proposalId = list.body.data[0].id as string

    const approved = await request(app).post(`/api/v1/orgs/${lead.orgId}/template-proposals/${proposalId}/approve`).set(H(lead.token))
    expect(approved.status, JSON.stringify(approved.body.error)).toBe(200)
    expect(approved.body.data).toMatchObject({ status: "approved", version: 1 })

    const project = (await Project.findById(projectId).lean())!
    expect(project.template_ref).toMatchObject({ version: 1 })
    const family = (await OrgTemplate.findById(project.template_ref!.template_id).lean())!
    expect(family).toMatchObject({ name: `${PROJECT} - template`, latest_version: 1 })
    expect(String(family.skeleton_of)).toBe(projectId)
    const v1 = (await OrgTemplateVersion.findOne({ template_id: family._id, version: 1 }).lean())!
    expect(v1).toMatchObject({ status: "published", visibility: "org" })
    const text = await textOfFile(v1.file_ref)
    expect(text).toContain("9 {Customer name} Integration")
    expect(text).not.toContain("Lumen ledger")
    expect(text).not.toContain("Team Notes")
    for (const sample of Object.values(SRS_FIXTURE_TEXT).filter((s): s is string => typeof s === "string" && s.length > 20).slice(0, 5)) {
      expect(text, sample).not.toContain(sample)
    }
    expect(await Notification.countDocuments({ type: "template_proposal_approved", userId: analyst.userId })).toBe(1)
    // Duyệt lần hai ⇒ 409
    expect((await request(app).post(`/api/v1/orgs/${lead.orgId}/template-proposals/${proposalId}/approve`).set(H(lead.token))).status).toBe(409)
  })

  it("B. Lead: Save to library đăng thẳng; Don't save ⇒ cùng cấu trúc không đề xuất lại", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const saved = await finalizedIn(lead, await makeSrsDocx({ extraBody: CUSTOM }))
    // Lead không "gửi cho Lead"
    expect((await request(app).post(`/api/v1/projects/${saved}/template-proposal/send`).set(H(lead.token))).status).toBe(403)
    const save = await request(app).post(`/api/v1/projects/${saved}/template-proposal/save`).set(H(lead.token))
    expect(save.status, JSON.stringify(save.body.error)).toBe(200)
    expect(save.body.data).toMatchObject({ status: "approved", version: 1 })
    expect((await Project.findById(saved).lean())!.template_ref).toMatchObject({ version: 1 })

    // Don't save ⇒ phát hành lại cùng cấu trúc không có thẻ
    const declinedProject = await finalizedIn(lead, await makeSrsDocx({ extraBody: styled("u1", "9 Payroll Notes") + p("x") }), "Payroll")
    const declined = await request(app).post(`/api/v1/projects/${declinedProject}/template-proposal/decline`).set(H(lead.token))
    expect(declined.body.data.status).toBe("declined")
    await proposeTemplateFromBaseline(declinedProject, lead.userId, await latestFile(declinedProject))
    expect((await request(app).get(`/api/v1/projects/${declinedProject}/template-proposal`).set(H(lead.token))).body.data).toBeNull()
  })

  it("B2. Reject ⇒ người gửi được báo; cùng cấu trúc không đề xuất lại", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const analyst = await memberOf(lead.orgId, "analyst")
    const rejectedProject = await finalizedIn(lead, await makeSrsDocx({ extraBody: styled("u1", "9 Warehouse Notes") + p("x") }), "Warehouse", analyst.userId)
    await request(app).post(`/api/v1/projects/${rejectedProject}/template-proposal/send`).set(H(analyst.token))
    const pid = (await TemplateProposal.findOne({ project_id: rejectedProject }).lean())!._id
    const rejected = await request(app).post(`/api/v1/orgs/${lead.orgId}/template-proposals/${pid}/reject`).set(H(lead.token))
    expect(rejected.body.data.status).toBe("rejected")
    expect(await Notification.countDocuments({ type: "template_proposal_rejected", userId: analyst.userId })).toBe(1)
    await proposeTemplateFromBaseline(rejectedProject, analyst.userId, await latestFile(rejectedProject))
    expect(await TemplateProposal.countDocuments({ project_id: rejectedProject })).toBe(1)
  })

  it("C. dự án khác cùng khung ⇒ theo bản có sẵn; khung đổi ⇒ đề xuất mới thay đề xuất cũ", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const buffer = await makeSrsDocx()
    const first = await finalizedIn(lead, buffer)
    await request(app).post(`/api/v1/projects/${first}/template-proposal/save`).set(H(lead.token))
    const ref = (await Project.findById(first).lean())!.template_ref!

    const second = await finalizedIn(lead, buffer, "Other bank")
    expect((await Project.findById(second).lean())!.template_ref).toMatchObject({ template_id: ref.template_id, version: ref.version })
    expect(await TemplateProposal.countDocuments({ project_id: second })).toBe(0)

    // Phát hành lại không đổi khung ⇒ không đề xuất
    await proposeTemplateFromBaseline(first, lead.userId, await latestFile(first))
    expect(await TemplateProposal.countDocuments({ project_id: first })).toBe(1)

    // Khung đổi hai lần ⇒ đề xuất sau thay đề xuất trước
    const v2 = await docFileStore().save(await makeSrsDocx({ extraBody: styled("u1", "9 Payroll Notes") + p("x") }), { projectId: first, kind: "version", name: "2.0" })
    await proposeTemplateFromBaseline(first, lead.userId, v2)
    const v3 = await docFileStore().save(await makeSrsDocx({ extraBody: styled("u1", "9 Audit Notes") + p("x") }), { projectId: first, kind: "version", name: "3.0" })
    await proposeTemplateFromBaseline(first, lead.userId, v3)
    const statuses = (await TemplateProposal.find({ project_id: first }).sort({ createdAt: 1 }).lean()).map((x) => x.status)
    expect(statuses).toEqual(["approved", "superseded", "proposed"])
    // Lưu ⇒ bản 2 của họ khung của dự án
    await request(app).post(`/api/v1/projects/${first}/template-proposal/save`).set(H(lead.token))
    expect((await Project.findById(first).lean())!.template_ref).toMatchObject({ version: 2 })
  })

  it("D. Lead lưu bất cứ lúc nào; thiếu credit ⇒ không đề xuất; theo mẫu Lead đăng cùng cấu trúc ⇒ không đề xuất", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const analyst = await memberOf(lead.orgId, "analyst")
    const projectId = await finalizedIn(lead, await makeSrsDocx({ extraBody: CUSTOM }), PROJECT, analyst.userId)

    // Analyst không dùng lối "lưu bất cứ lúc nào"; Lead thì có khi chưa có đề xuất mở cùng cấu trúc
    expect((await request(app).post(`/api/v1/projects/${projectId}/template-proposal`).set(H(analyst.token))).status).toBe(403)
    const pending = await request(app).post(`/api/v1/projects/${projectId}/template-proposal`).set(H(lead.token))
    expect(pending.status).toBe(409)
    expect(pending.body.meta).toMatchObject({ reason: "pending" })
    await TemplateProposal.deleteMany({ project_id: projectId })
    const created = await request(app).post(`/api/v1/projects/${projectId}/template-proposal`).set(H(lead.token))
    expect(created.status, JSON.stringify(created.body.error)).toBe(201)
    expect(created.body.data).toMatchObject({ status: "proposed", created_by: { id: lead.userId } })

    // Hết credit ⇒ AI không chạy ⇒ không đề xuất (baseline không bị chặn)
    const broke = await finalizedIn(lead, await makeSrsDocx({ extraBody: styled("u1", `9 ${PROJECT} Billing`) + p("x") }), "Broke")
    await TemplateProposal.deleteMany({ project_id: broke })
    await CreditWallet.updateMany({ organizationId: lead.orgId }, { $set: { balance: 0 } })
    await proposeTemplateFromBaseline(broke, lead.userId, await latestFile(broke))
    expect(await TemplateProposal.countDocuments({ project_id: broke })).toBe(0)
    await CreditWallet.updateMany({ organizationId: lead.orgId }, { $set: { balance: 1000 } })

    // Dự án theo mẫu do Lead đăng, cấu trúc trùng ⇒ không đề xuất
    await request(app).post(`/api/v1/projects/${projectId}/template-proposal/save`).set(H(lead.token))
    const own = (await Project.findById(projectId).lean())!.template_ref!
    await OrgTemplate.updateOne({ _id: own.template_id }, { $set: { skeleton_of: null } })
    await proposeTemplateFromBaseline(projectId, lead.userId, await latestFile(projectId))
    expect(await TemplateProposal.countDocuments({ project_id: projectId, status: "proposed" })).toBe(0)
  })
})
