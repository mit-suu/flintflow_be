/**
 * Chuẩn bị đổi mẫu (xuôi / ngược) — API + Mongo thật:
 *  A. Điều kiện bắt đầu: chưa baseline / bản nháp chờ Lead duyệt / mẫu org khác / dự án org khác / Viewer ⇒ lỗi rõ; mỗi dự án một lần đổi mẫu mở.
 *  B. Mẫu org (mọi bản): ghép mục + 4 nhóm; phần tử không vào nhóm thừa; sửa cặp / quyết định validate theo dữ liệu đã lưu (400);
 *     ready ghim spine_version + sha; huỷ; chặn xoá bản mẫu đích khi lần đổi mẫu còn mở.
 *  C. File tải lên: Analyst ⇒ bản riêng của dự án (không hiện thư viện, không đăng được); Lead đăng lên org.
 *  D. Mẫu khác ngôn ngữ ⇒ cần dịch + ước tính credit.
 *  E. Đổi ngược: đích = mẫu trước của lần đổi gần nhất ⇒ nhóm "đã sửa sau lần đổi mẫu", Giữ hết / Hoàn tác hết.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import request from "supertest"
import app from "../../../src/app.js"
import { authAs, seedFixture, type SeededFixture } from "../../setup.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, fakeMode1 } from "../../helpers/mode1.js"
import { fileOf } from "../../helpers/mode1-import-p4.js"
import { p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { docFileStore, setDocFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { markReady } from "../../../src/modules/template-migration/template-migration.service.js"
import { acceptLatest, uploadImport } from "../../../src/modules/import/import.service.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { finalizeImport } from "../../../src/modules/import/finalize.service.js"
import { OrgTemplate, OrgTemplateVersion } from "../../../src/modules/import/org-library.model.js"
import { Membership, type OrgRole } from "../../../src/modules/organization/membership.model.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { Change } from "../../../src/modules/spine/change.model.js"
import { Spine } from "../../../src/modules/spine/spine.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { TemplateMigration } from "../../../src/modules/template-migration/template-migration.model.js"
import type { MigrationDto } from "../../../src/modules/template-migration/template-migration.service.js"
import { User } from "../../../src/modules/user/user.model.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const H = (token: string) => ({ Authorization: `Bearer ${token}` })
const EXTRA = styled("u1", "6 Operating Environment") + p("[Describe the operating environment.]") + styled("u1", "7 Document Conventions") + p("[Describe conventions.]")
const LEGACY = styled("u1", "9 Legacy Gateway") + p("Nightly batch to the legacy gateway.")
const VI_SENTENCE = "Hệ thống cho phép người dùng đăng nhập và quản lý khoá học trực tuyến một cách thuận tiện."
const VI_BODY = styled("u1", "6 Môi trường vận hành") + Array.from({ length: 30 }, () => p(VI_SENTENCE)).join("")

let seq = 0
const memberOf = async (orgId: string, role: OrgRole) => {
  seq += 1
  const user = await User.create({ email: `${role}-tm-${seq}-${Date.now()}@flintflow.test`, password: "test-password-123", emailVerified: true })
  await Membership.create({ userId: user._id, organizationId: orgId, role })
  return { userId: String(user._id), token: await authAs({ _id: user._id, email: user.email, orgId }) }
}

/** Upload → I-4 → finalize (baseline 0.1) cho một dự án mới của org. */
const baselinedProject = async (seeded: SeededFixture, buffer: Buffer): Promise<string> => {
  const projectId = await createMode1Project(seeded, "Lumen import")
  const doc = await uploadImport(projectId, seeded.userId, fileOf(buffer))
  await acceptLatest(doc, true)
  await runExtraction(projectId, seeded.userId, String(doc._id))
  const before = (await spineRepository.get(projectId))!
  await finalizeImport(projectId, seeded.userId, { import_id: String(doc._id), base_version: before.spine_version })
  return projectId
}

/** Lead tải mẫu lên thư viện và đăng (không sửa mapping) ⇒ `template_id`. */
const publishTemplate = async (lead: { token: string }, orgId: string, name: string, file: Buffer, templateId?: string): Promise<string> => {
  const base = `/api/v1/orgs/${orgId}/templates`
  const req = request(app).post(templateId ? `${base}/${templateId}/versions` : base).set(H(lead.token)).attach("file", file, "Mau.docx")
  const draft = await (templateId ? req : req.field("name", name))
  expect(draft.status, JSON.stringify(draft.body.error)).toBe(201)
  const id = draft.body.data.template_id as string
  const published = await request(app).post(`${base}/${id}/versions/${draft.body.data.version}/publish`).set(H(lead.token)).send({})
  expect(published.status, JSON.stringify(published.body.error)).toBe(200)
  return id
}

const startUrl = (projectId: string) => `/api/v1/projects/${projectId}/template-migrations`
const startWith = (token: string, projectId: string, body: object) => request(app).post(startUrl(projectId)).set(H(token)).send(body)
const migrationUrl = (projectId: string, id: string, suffix = "") => `${startUrl(projectId)}/${id}${suffix}`

/** Chọn lựa chọn an toàn (không cần AI) cho mọi mục bắt buộc còn thiếu quyết định. */
const decideAll = async (token: string, projectId: string, dto: MigrationDto) => {
  const items = [...dto.groups.extra, ...dto.groups.conflict]
  const decisions = dto.undecided.map((id) => {
    const item = items.find((i) => i.id === id)!
    const choice = item.choices.find((c) => !item.ai_choices.includes(c) && !c.startsWith("move_to:")) ?? item.choices[0]
    return { id, choice }
  })
  return request(app).patch(migrationUrl(projectId, dto.id, "/decisions")).set(H(token)).send({ decisions })
}

describe("đổi mẫu — chuẩn bị", () => {
  it("A. chưa baseline / chờ Lead duyệt / mẫu org khác / dự án org khác / Viewer ⇒ lỗi rõ; mỗi dự án một lần đổi mẫu mở", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const viewer = await memberOf(lead.orgId, "viewer")
    const other = await seedFixture("minimal", { balance: 1000 })
    const foreignTemplate = await publishTemplate(other, other.orgId, "Mẫu org khác", await makeSrsDocx({ extraBody: EXTRA }))
    const ownTemplate = await publishTemplate(lead, lead.orgId, "Mẫu của mình", await makeSrsDocx({ extraBody: EXTRA }))

    // Chưa có baseline (D5)
    const noBaseline = await startWith(lead.token, lead.projectId, { template_id: ownTemplate, version: 1 })
    expect(noBaseline.status).toBe(409)
    expect(noBaseline.body.error.code).toBe("TEMPLATE_MIGRATION_NO_BASELINE")

    const projectId = await baselinedProject(lead, await makeSrsDocx())

    // Bản nháp đang chờ Lead duyệt ⇒ khoá
    const head = (await spineRepository.get(projectId))!
    await Spine.updateOne({ projectId }, { $set: { baseline_submission: { status: "pending", submitted_by: lead.userId, submitted_at: new Date().toISOString(), spine_version: head.spine_version, decided_by: null, decided_at: null, reason: null, rejection_comment_ids: [] } } })
    spineRepository.clearReadCache()
    const locked = await startWith(lead.token, projectId, { template_id: ownTemplate, version: 1 })
    expect(locked.status).toBe(409)
    expect(locked.body.error.code).toBe("DRAFT_LOCKED")
    await Spine.updateOne({ projectId }, { $set: { baseline_submission: null } })
    spineRepository.clearReadCache()

    // Mẫu của org khác ⇒ 404; id lạ ⇒ 400; bản không có ⇒ 404
    expect((await startWith(lead.token, projectId, { template_id: foreignTemplate, version: 1 })).status).toBe(404)
    expect((await startWith(lead.token, projectId, { template_id: ownTemplate, version: 9 })).status).toBe(404)
    expect((await startWith(lead.token, projectId, { template_id: "x", version: 1 })).status).toBe(400)

    // Dự án của org khác ⇒ 404; Viewer ⇒ 403
    expect((await startWith(other.token, projectId, { template_id: foreignTemplate, version: 1 })).status).toBe(404)
    const asViewer = await startWith(viewer.token, projectId, { template_id: ownTemplate, version: 1 })
    expect(asViewer.status).toBe(403)
    expect((await request(app).get(startUrl(projectId)).set(H(viewer.token))).status).toBe(403)
    expect(await TemplateMigration.countDocuments({ projectId })).toBe(0)

    // Một lần đổi mẫu mở mỗi dự án
    const first = await startWith(lead.token, projectId, { template_id: ownTemplate, version: 1 })
    expect(first.status, JSON.stringify(first.body.error)).toBe(201)
    const second = await startWith(lead.token, projectId, { template_id: ownTemplate, version: 1 })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe("TEMPLATE_MIGRATION_OPEN")
    expect(second.body.meta).toMatchObject({ migration_id: first.body.data.id })
    // Dự án khác org không đọc được lần đổi mẫu này
    expect((await request(app).get(migrationUrl(projectId, first.body.data.id)).set(H(other.token))).status).toBe(404)
  })

  it("B. ghép mục + 4 nhóm; phần tử không vào nhóm thừa; id lạ ⇒ 400; ready ghim spine_version; chặn xoá bản mẫu đích khi còn mở", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await baselinedProject(lead, await makeSrsDocx({ extraBody: LEGACY }))
    const templateId = await publishTemplate(lead, lead.orgId, "Mẫu ngân hàng", await makeSrsDocx({ extraBody: EXTRA }))
    // Bản 2 bỏ mục "Document Conventions"
    await publishTemplate(lead, lead.orgId, "Mẫu ngân hàng", await makeSrsDocx({ extraBody: styled("u1", "6 Operating Environment") + p("[Describe.]") }), templateId)

    const started = await startWith(lead.token, projectId, { template_id: templateId, version: 1 })
    expect(started.status, JSON.stringify(started.body.error)).toBe(201)
    const dto = started.body.data as MigrationDto
    expect(dto).toMatchObject({ state: "mapping_review", direction: "forward", reverse_of: null, to: { template_id: templateId, version: 1 }, language: { needs_translation: false } })

    // 4 nhóm: mục riêng của dự án không có ở mẫu ⇒ thừa (Team Notes có ở cả hai ⇒ ghép theo chữ); mục riêng của mẫu ⇒ thiếu; khung cùng id ⇒ khớp
    expect(dto.groups.matched.length).toBeGreaterThan(5)
    expect(dto.groups.extra.map((e) => e.heading_text).join("|")).toContain("Legacy Gateway")
    expect(dto.groups.missing.map((m) => m.heading_text).join("|")).toContain("Operating Environment")
    expect(dto.groups.missing.find((m) => m.heading_text.includes("Operating Environment"))).toMatchObject({ needs_content: true, guidance: "Describe the operating environment." })
    // Heading phần tử (tính năng / chức năng) đi theo mục cha, không vào thừa
    expect(dto.pairing.followers.filter((f) => f.kind === "element").length).toBeGreaterThan(0)
    expect(dto.groups.extra.filter((e) => /^(feature|function):/.test(e.section_id))).toEqual([])
    expect(dto.pairing.pairs.every((p) => !/^(feature|function):/.test(p.old_key))).toBe(true)

    const url = (suffix = "") => migrationUrl(projectId, dto.id, suffix)
    const patch = (suffix: string, body: object) => request(app).patch(url(suffix)).set(H(lead.token)).send(body)

    // Sửa cặp: id ngoài dữ liệu đã lưu ⇒ 400, không đổi gì
    expect((await patch("/pairs", { pairs: [{ old_key: "custom:khong-co", new_key: null }] })).status).toBe(400)
    expect((await patch("/pairs", { pairs: [{ old_key: dto.pairing.pairs[0].old_key, new_key: "n999" }] })).status).toBe(400)
    // Chưa qua bước rà mapping ⇒ chưa nhận quyết định
    const early = await patch("/decisions", { decisions: [{ id: dto.groups.extra[0].id, choice: "delete" }] })
    expect(early.status).toBe(409)
    expect(early.body.error.code).toBe("TEMPLATE_MIGRATION_INVALID_STATE")

    // Ghép tay: bỏ cặp của một mục khớp ⇒ mục đó thành thừa
    const victim = dto.groups.matched.find((m) => m.old_key === "fixed:1")!
    const unpaired = await patch("/pairs", { pairs: [{ old_key: victim.old_key, new_key: null }] })
    expect(unpaired.status, JSON.stringify(unpaired.body.error)).toBe(200)
    expect((unpaired.body.data as MigrationDto).groups.extra.map((e) => e.old_key)).toContain(victim.old_key)

    expect((await request(app).post(url("/confirm-mapping")).set(H(lead.token))).body.data.state).toBe("decisions")
    const current = (await request(app).get(url()).set(H(lead.token))).body.data as MigrationDto
    expect(current.undecided.length).toBeGreaterThan(0)

    // Quyết định: id không thuộc nhóm nào, id mục khớp (không nhận quyết định), lựa chọn của nhóm khác ⇒ 400
    const extra = current.groups.extra[0]
    for (const bad of [
      { id: "e:custom:khong-co", choice: "delete" },
      { id: current.groups.matched[0].id, choice: "keep" },
      { id: extra.id, choice: "keep" },
      { id: extra.id, choice: "move_to:n999" }
    ]) {
      const res = await patch("/decisions", { decisions: [bad] })
      expect(res.status, JSON.stringify(bad)).toBe(400)
    }
    expect((await patch("/decisions", { batch: "keep_all" })).status).toBe(400) // đổi xuôi không có nhóm "đã sửa"

    // Còn mục chưa quyết định ⇒ chưa ready
    const notReady = await request(app).post(url("/ready")).set(H(lead.token))
    expect(notReady.status).toBe(409)
    expect(notReady.body.error.code).toBe("TEMPLATE_MIGRATION_UNDECIDED")
    expect(notReady.body.meta.undecided).toEqual(current.undecided)

    const decided = await decideAll(lead.token, projectId, current)
    expect(decided.status, JSON.stringify(decided.body.error)).toBe(200)
    expect((decided.body.data as MigrationDto).undecided).toEqual([])

    const ready = await request(app).post(url("/ready")).set(H(lead.token))
    expect(ready.status, JSON.stringify(ready.body.error)).toBe(200)
    const spineNow = (await spineRepository.get(projectId))!
    expect(ready.body.data).toMatchObject({ state: "ready", prepared_spine_version: spineNow.spine_version })
    expect(ready.body.data.prepared_source_sha256).toMatch(/^[a-f0-9]{64}$/)
    // Đã ready ⇒ không sửa cặp / quyết định nữa
    expect((await patch("/pairs", { pairs: [{ old_key: victim.old_key, new_key: null }] })).status).toBe(409)

    // Chặn xoá bản / họ mẫu đang là đích của lần đổi mẫu chưa kết thúc
    const lib = `/api/v1/orgs/${lead.orgId}/templates/${templateId}`
    for (const res of [await request(app).delete(`${lib}/versions/1`).set(H(lead.token)), await request(app).delete(lib).set(H(lead.token))]) {
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe("ORG_TEMPLATE_IN_USE_BY_MIGRATION")
    }
    // Bản khác của họ xoá được
    expect((await request(app).delete(`${lib}/versions/2`).set(H(lead.token))).status).toBe(200)

    // Huỷ trước applying ⇒ mở lại chỗ; xoá được bản đích
    const cancelled = await request(app).post(url("/cancel")).set(H(lead.token))
    expect(cancelled.body.data.state).toBe("cancelled")
    expect((await request(app).post(url("/cancel")).set(H(lead.token))).status).toBe(409)
    expect((await request(app).delete(`${lib}/versions/1`).set(H(lead.token))).status).toBe(200)
    expect((await TemplateMigration.findById(dto.id).lean())!.open).toBe(false)
  })

  it("C. file tải lên: Analyst ⇒ bản riêng của dự án (không hiện thư viện, không đăng được); Lead đăng lên org", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const analyst = await memberOf(lead.orgId, "analyst")
    const original = await makeSrsDocx()
    const projectId = await baselinedProject(lead, original)
    const file = await makeSrsDocx({ extraBody: EXTRA })
    const upload = (token: string, fields: Record<string, string> = {}, buffer = file) => {
      const req = request(app).post(startUrl(projectId)).set(H(token)).attach("file", buffer, "Mau moi.docx")
      return Object.entries(fields).reduce((r, [k, v]) => r.field(k, v), req)
    }

    // Analyst không đăng lên org được (chặn trước khi lưu file), file trùng với mẫu đang theo ⇒ 409
    const denied = await upload(analyst.token, { publish_to_org: "true", name: "Lậu" })
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
    expect(await OrgTemplateVersion.countDocuments({ orgId: lead.orgId, visibility: "org", "source_file.name": "Mau moi.docx" })).toBe(0)
    expect((await upload(analyst.token, {}, original)).body.error?.code).toBe("TEMPLATE_MIGRATION_SAME_TEMPLATE")

    const own = await upload(analyst.token)
    expect(own.status, JSON.stringify(own.body.error)).toBe(201)
    expect(own.body.data.to).toMatchObject({ visibility: "project", version: 1 })
    expect(own.body.data.groups.missing.map((m: { heading_text: string }) => m.heading_text).join("|")).toContain("Operating Environment")
    const stored = (await OrgTemplateVersion.findOne({ template_id: own.body.data.to.template_id }).lean())!
    expect(stored).toMatchObject({ visibility: "project", status: "published" })
    expect(String(stored.project_id)).toBe(projectId)
    // Không hiện ở thư viện của bất kỳ vai trò nào, không tính là bản mới nhất của họ
    for (const token of [analyst.token, lead.token]) {
      expect((await request(app).get(`/api/v1/orgs/${lead.orgId}/templates`).set(H(token))).body.data.some((t: { id: string }) => t.id === own.body.data.to.template_id)).toBe(false)
    }
    expect((await OrgTemplate.findById(stored.template_id).lean())!.latest_version).toBe(0)
    await request(app).post(migrationUrl(projectId, own.body.data.id, "/cancel")).set(H(analyst.token))

    // Lead đăng lên thư viện org
    const published = await upload(lead.token, { publish_to_org: "true", name: "Mẫu khách A" })
    expect(published.status, JSON.stringify(published.body.error)).toBe(201)
    expect(published.body.data.to).toMatchObject({ visibility: "org", name: "Mẫu khách A", version: 1 })
    const library = (await request(app).get(`/api/v1/orgs/${lead.orgId}/templates`).set(H(analyst.token))).body.data as { name: string; latest_version: number }[]
    expect(library.find((t) => t.name === "Mẫu khách A")).toMatchObject({ latest_version: 1 })
  })

  it("D. mẫu khác ngôn ngữ ⇒ cần dịch + ước tính credit (chưa dịch gì)", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await baselinedProject(lead, await makeSrsDocx())
    const same = await publishTemplate(lead, lead.orgId, "Mẫu EN", await makeSrsDocx({ extraBody: EXTRA }))
    const vi = await publishTemplate(lead, lead.orgId, "Mẫu VI", await makeSrsDocx({ extraBody: VI_BODY }))
    const balance = async () => (await import("../../../src/modules/credits/credit-wallet.model.js")).CreditWallet.findOne({ organizationId: lead.orgId }).lean()
    const before = await balance()

    const en = await startWith(lead.token, projectId, { template_id: same, version: 1 })
    expect(en.body.data.language).toEqual({ source: "en", target: "en", needs_translation: false, switches_document_language: false })
    expect(en.body.data.credit_estimate.translation.credits).toBe(0)
    await request(app).post(migrationUrl(projectId, en.body.data.id, "/cancel")).set(H(lead.token))

    const res = await startWith(lead.token, projectId, { template_id: vi, version: 1 })
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    expect(res.body.data.language).toEqual({ source: "en", target: "vi", needs_translation: true, switches_document_language: false })
    expect(res.body.data.credit_estimate.translation.chars).toBeGreaterThan(0)
    expect(res.body.data.credit_estimate.translation.credits).toBeGreaterThan(0)
    expect(res.body.data.credit_estimate.total).toBe(res.body.data.credit_estimate.translation.credits)
    expect(await balance()).toMatchObject({ balance: before!.balance, reserved: before!.reserved })
  })

  it("E. đổi ngược: đích = mẫu trước của lần đổi gần nhất ⇒ nhóm đã sửa sau lần đổi mẫu; Giữ hết / Hoàn tác hết", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await baselinedProject(lead, await makeSrsDocx())
    const before = (await Project.findById(projectId).lean())!.template_ref!
    const templateId = await publishTemplate(lead, lead.orgId, "Mẫu mới", await makeSrsDocx({ extraBody: EXTRA }))

    // Lần đổi xuôi sang mẫu mới, coi như vừa áp dụng xong
    const forward = await startWith(lead.token, projectId, { template_id: templateId, version: 1 })
    expect(forward.status, JSON.stringify(forward.body.error)).toBe(201)
    const appliedAt = new Date()
    await TemplateMigration.updateOne({ _id: forward.body.data.id }, { $set: { state: "applied", open: false, applied_at: appliedAt } })
    await Project.updateOne({ _id: projectId }, { $set: { template_ref: { template_id: templateId, version: 1 } } })

    // Sửa tài liệu sau lần đổi mẫu: mục 1 (Product Overview)
    const seqNow = ((await Change.findOne({ projectId }).sort({ seq: -1 }).lean())?.seq ?? 0) + 1
    await Change.create({ projectId, seq: seqNow, txn: "cr-edit-1", op: "set", path: "project.vision", before: "cũ", value: "Tầm nhìn mới của dự án", reason: "sửa", at: new Date(appliedAt.getTime() + 5_000), by: lead.userId, step_id: null })
    spineRepository.clearReadCache()

    const reverse = await startWith(lead.token, projectId, { template_id: String(before.template_id), version: before.version })
    expect(reverse.status, JSON.stringify(reverse.body.error)).toBe(201)
    const dto = reverse.body.data as MigrationDto
    expect(dto).toMatchObject({ direction: "reverse", reverse_of: forward.body.data.id })
    expect(dto.groups.edited_since.map((e) => e.old_key)).toEqual(["fixed:1"])
    expect(dto.groups.edited_since[0]).toMatchObject({ default: "keep", changes: 1, choices: ["keep", "discard"] })
    expect(dto.groups.restored_from_snapshot).toBeGreaterThan(0)
    // Mục đã sửa không còn ở nhóm khớp
    expect(dto.groups.matched.map((m) => m.old_key)).not.toContain("fixed:1")

    const url = (suffix = "") => migrationUrl(projectId, dto.id, suffix)
    expect((await request(app).post(url("/confirm-mapping")).set(H(lead.token))).status).toBe(200)
    const discard = await request(app).patch(url("/decisions")).set(H(lead.token)).send({ batch: "discard_all" })
    expect(discard.status, JSON.stringify(discard.body.error)).toBe(200)
    expect((discard.body.data as MigrationDto).decisions).toContainEqual({ id: "s:fixed:1", choice: "discard" })
    const keep = await request(app).patch(url("/decisions")).set(H(lead.token)).send({ batch: "keep_all" })
    expect((keep.body.data as MigrationDto).decisions).toContainEqual({ id: "s:fixed:1", choice: "keep" })
    // Quyết định lẻ cho mục đã sửa: chỉ keep | discard
    expect((await request(app).patch(url("/decisions")).set(H(lead.token)).send({ decisions: [{ id: "s:fixed:1", choice: "delete" }] })).status).toBe(400)

    // Sửa thêm giữa lúc chuẩn bị ⇒ danh sách mục đã sửa không còn đúng ⇒ không ready
    expect((await decideAll(lead.token, projectId, keep.body.data)).status).toBe(200)
    await Change.create({ projectId, seq: seqNow + 1, txn: "cr-edit-2", op: "set", path: "project.vision", before: "a", value: "b", reason: "sửa", at: new Date(appliedAt.getTime() + 10_000), by: lead.userId, step_id: null })
    spineRepository.clearReadCache()
    const stale = await request(app).post(url("/ready")).set(H(lead.token))
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe("TEMPLATE_MIGRATION_STALE")
  })

  it("F. hai lần bắt đầu cùng lúc ⇒ đúng một thành công; chỗ được giải phóng ở mọi trạng thái kết thúc; mẫu đích có cấp heading", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const analyst = await memberOf(lead.orgId, "analyst")
    const projectId = await baselinedProject(lead, await makeSrsDocx())
    const templateId = await publishTemplate(lead, lead.orgId, "Mẫu song song", await makeSrsDocx({ extraBody: EXTRA }))

    // Mẫu org: một 201, một 409, đúng một bản ghi mở
    const [a, b] = await Promise.all([startWith(lead.token, projectId, { template_id: templateId, version: 1 }), startWith(analyst.token, projectId, { template_id: templateId, version: 1 })])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    expect(await TemplateMigration.countDocuments({ projectId, open: true })).toBe(1)
    const winner = [a, b].find((r) => r.status === 201)!.body.data as MigrationDto
    expect(winner.to.headings.every((h) => typeof h.level === "number")).toBe(true)
    await request(app).post(migrationUrl(projectId, winner.id, "/cancel")).set(H(lead.token))

    // File tải lên: bên thua dọn sạch bản riêng của mình, không để mồ côi
    const file = await makeSrsDocx({ extraBody: EXTRA + p("race") })
    const upload = (token: string) => request(app).post(startUrl(projectId)).set(H(token)).attach("file", file, "Mau race.docx")
    const [c, d] = await Promise.all([upload(lead.token), upload(analyst.token)])
    expect([c.status, d.status].sort()).toEqual([201, 409])
    expect(await TemplateMigration.countDocuments({ projectId, open: true })).toBe(1)
    expect(await OrgTemplateVersion.countDocuments({ orgId: lead.orgId, visibility: "project", project_id: projectId })).toBe(1)

    // Mọi trạng thái kết thúc đều không còn mở
    const open = (await TemplateMigration.findOne({ projectId, open: true }).lean())!
    const { stateUpdate } = await import("../../../src/modules/template-migration/template-migration.model.js")
    for (const state of ["applied", "failed", "cancelled"] as const) {
      await TemplateMigration.updateOne({ _id: open._id }, { $set: stateUpdate(state) })
      expect((await TemplateMigration.findById(open._id).lean())!.open).toBe(false)
    }
  })

  it("G. họ ẩn của dự án không vào thư viện / không nhắm tới được; file nền không đọc được ⇒ 503; ready không đè lên thay đổi chen giữa", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const analyst = await memberOf(lead.orgId, "analyst")
    const projectA = await baselinedProject(lead, await makeSrsDocx())
    const projectB = await baselinedProject(lead, await makeSrsDocx({ extraBody: LEGACY }))
    const libraryTemplate = await publishTemplate(lead, lead.orgId, "Mẫu thật", await makeSrsDocx({ extraBody: EXTRA }))

    // Analyst tải file cho dự án A ⇒ họ ẩn của A
    const file = await makeSrsDocx({ extraBody: EXTRA + p("hidden") })
    const own = await request(app).post(startUrl(projectA)).set(H(analyst.token)).attach("file", file, "Mau A.docx")
    expect(own.status, JSON.stringify(own.body.error)).toBe(201)
    const hiddenId = own.body.data.to.template_id as string
    expect(String((await OrgTemplate.findById(hiddenId).lean())!.project_id)).toBe(projectA)

    // Hơn 100 họ ẩn (uses cao hơn) không đẩy mẫu thật khỏi thư viện
    await OrgTemplate.insertMany(Array.from({ length: 101 }, (_, i) => ({ orgId: lead.orgId, name: `ẩn ${i}`, created_by: lead.userId, latest_version: 0, uses: 1000, project_id: projectA })))
    const listed = (await request(app).get(`/api/v1/orgs/${lead.orgId}/templates`).set(H(lead.token))).body.data as { id: string }[]
    expect(listed.map((t) => t.id)).toContain(libraryTemplate)
    expect(listed.some((t) => t.id === hiddenId)).toBe(false)

    // Họ ẩn của A: dự án B không đăng vào / không đổi sang được; route thư viện không thấy
    const publishInto = await request(app).post(startUrl(projectB)).set(H(lead.token)).field("publish_to_org", "true").field("template_id", hiddenId).attach("file", file, "Mau B.docx")
    expect(publishInto.status).toBe(404)
    expect((await startWith(lead.token, projectB, { template_id: hiddenId, version: 1 })).status).toBe(404)
    expect((await request(app).post(`/api/v1/orgs/${lead.orgId}/templates/${hiddenId}/versions`).set(H(lead.token)).attach("file", file, "x.docx")).status).toBe(404)
    expect((await request(app).get(`/api/v1/orgs/${lead.orgId}/templates/${hiddenId}/versions/1`).set(H(lead.token))).status).toBe(404)
    expect(await OrgTemplateVersion.countDocuments({ template_id: hiddenId })).toBe(1)
    // Chính dự án A vẫn dùng lại được họ ẩn của mình
    expect(await OrgTemplate.countDocuments({ orgId: lead.orgId, project_id: projectA, name: /mẫu tải lên/ })).toBe(1)
    await request(app).post(migrationUrl(projectA, own.body.data.id, "/cancel")).set(H(lead.token))
    const again = await request(app).post(startUrl(projectA)).set(H(analyst.token)).attach("file", await makeSrsDocx({ extraBody: EXTRA + p("hidden 2") }), "Mau A2.docx")
    expect(again.status, JSON.stringify(again.body.error)).toBe(201)
    expect(again.body.data.to).toMatchObject({ template_id: hiddenId, version: 2 })
    await request(app).post(migrationUrl(projectA, again.body.data.id, "/cancel")).set(H(lead.token))

    // File nền không đọc được và hồ sơ chưa có dấu sha ⇒ 503, không ghim dấu của buffer rỗng
    const profile = (await TemplateProfile.findOne({ projectId: projectB }).lean())!
    await TemplateProfile.updateOne({ projectId: projectB }, { $set: { source_sha256: null } })
    const store = docFileStore()
    const restore = setDocFileStore(new Proxy(store, { get: (t, k) => (k === "load" ? async (ref: string) => { if (ref === profile.source_file_ref) throw new Error("storage down"); return t.load(ref) } : Reflect.get(t, k)) }))
    try {
      const down = await startWith(lead.token, projectB, { template_id: libraryTemplate, version: 1 })
      expect(down.status).toBe(503)
      expect(down.body.error.code).toBe("TEMPLATE_MIGRATION_SOURCE_UNAVAILABLE")
      expect(await TemplateMigration.countDocuments({ projectId: projectB })).toBe(0)
    } finally {
      restore()
      await TemplateProfile.updateOne({ projectId: projectB }, { $set: { source_sha256: profile.source_sha256 ?? null } })
    }

    // ready: bản ghi đổi giữa lúc kiểm và lúc chuyển trạng thái ⇒ 409, không sang ready
    const started = await startWith(lead.token, projectB, { template_id: libraryTemplate, version: 1 })
    expect(started.status, JSON.stringify(started.body.error)).toBe(201)
    const dto = started.body.data as MigrationDto
    await request(app).post(migrationUrl(projectB, dto.id, "/confirm-mapping")).set(H(lead.token))
    expect((await decideAll(lead.token, projectB, (await request(app).get(migrationUrl(projectB, dto.id)).set(H(lead.token))).body.data)).status).toBe(200)
    const realHead = spineRepository.versionHead
    const spy = vi.spyOn(spineRepository, "versionHead").mockImplementationOnce(async (id: string) => {
      // Người khác đổi quyết định đúng lúc markReady đang kiểm
      await TemplateMigration.updateOne({ _id: dto.id }, { $set: { warnings: ["đổi giữa chừng"] } })
      return realHead(id)
    })
    try {
      await expect(markReady({ projectId: projectB, orgId: lead.orgId, actor: { userId: lead.userId, role: "lead" } }, dto.id)).rejects.toMatchObject({ statusCode: 409, code: "TEMPLATE_MIGRATION_INVALID_STATE" })
    } finally {
      spy.mockRestore()
    }
    expect((await TemplateMigration.findById(dto.id).lean())!.state).toBe("decisions")
  })
})
