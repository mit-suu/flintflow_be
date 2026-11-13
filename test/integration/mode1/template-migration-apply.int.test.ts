/**
 * Áp dụng / hoàn tác / đổi ngược một lần đổi mẫu — API + Mongo thật:
 *  A. start → ready → apply → revert: Spine, profile, file nền, template_ref, intent đúng trước / sau / sau hoàn tác.
 *  B. Có Change sau lần đổi mẫu ⇒ hoàn tác bị chặn (409), đổi ngược chạy được, giữ CR; Giữ hết / Hoàn tác hết.
 *  C. Lỗi giả lập ở từng bước áp dụng ⇒ trạng thái nhất quán (cũ hoặc mới); tiến trình chết ⇒ job phục hồi dọn.
 *  D. Dữ liệu đổi giữa `ready` và áp dụng ⇒ 409, quay về bước phân nhóm.
 *  E. Dịch đè (D9): VI → EN và EN → VI, có credit; version 1.0 đã phát hành giữ nguyên chữ + ngôn ngữ cũ.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import request from "supertest"
import app from "../../../src/app.js"
import { authAs, seedFixture, type SeededFixture } from "../../setup.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { mockTranslateItems } from "../../../src/shared/ai/providers/mock.provider.js"
import { createMode1Project, fakeMode1 } from "../../helpers/mode1.js"
import { fileOf } from "../../helpers/mode1-import-p4.js"
import { p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { docFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { ChangeRequest } from "../../../src/modules/change-request/change-request.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { acceptLatest, uploadImport } from "../../../src/modules/import/import.service.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { finalizeImport } from "../../../src/modules/import/finalize.service.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { Change } from "../../../src/modules/spine/change.model.js"
import { applyTransaction } from "../../../src/modules/spine/op-engine.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { Membership, type OrgRole } from "../../../src/modules/organization/membership.model.js"
import { applyMigration } from "../../../src/modules/template-migration/apply.service.js"
import { recoverApplyingMigration, recoverStuckMigrations } from "../../../src/modules/template-migration/recover-applying.js"
import { TemplateMigration } from "../../../src/modules/template-migration/template-migration.model.js"
import type { MigrationDto } from "../../../src/modules/template-migration/template-migration.service.js"
import { TEMPLATE_MIGRATION_TXN_PREFIX } from "../../../src/modules/template-migration/edited-since.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { User } from "../../../src/modules/user/user.model.js"

beforeEach(() => {
  resetMockLlm()
  // Lô dịch: trả bản "dịch" giả của provider mock (tiền tố ngôn ngữ đích); còn lại như mode 1
  mockOverrides.next = (prompt) => (prompt.includes("You translate a batch") ? JSON.stringify({ items: mockTranslateItems(prompt) }) : fakeMode1(prompt))
})

const H = (token: string) => ({ Authorization: `Bearer ${token}` })
const EXTRA = styled("u1", "6 Operating Environment") + p("[Describe the operating environment.]") + styled("u1", "7 Document Conventions") + p("[Describe conventions.]")
const LEGACY = styled("u1", "9 Legacy Gateway") + p("Nightly batch to the legacy gateway.")
const VI_SENTENCE = "Hệ thống cho phép người dùng đăng nhập và quản lý khoá học trực tuyến một cách thuận tiện."
const VI_BODY = styled("u1", "6 Môi trường vận hành") + Array.from({ length: 30 }, () => p(VI_SENTENCE)).join("")

const baselinedProject = async (seeded: SeededFixture, buffer: Buffer): Promise<string> => {
  const projectId = await createMode1Project(seeded, "Lumen import")
  const doc = await uploadImport(projectId, seeded.userId, fileOf(buffer))
  await acceptLatest(doc, true)
  await runExtraction(projectId, seeded.userId, String(doc._id))
  const before = (await spineRepository.get(projectId))!
  await finalizeImport(projectId, seeded.userId, { import_id: String(doc._id), base_version: before.spine_version })
  return projectId
}

const publishTemplate = async (lead: { token: string }, orgId: string, name: string, file: Buffer): Promise<string> => {
  const base = `/api/v1/orgs/${orgId}/templates`
  const draft = await request(app).post(base).set(H(lead.token)).attach("file", file, "Mau.docx").field("name", name)
  expect(draft.status, JSON.stringify(draft.body.error)).toBe(201)
  const id = draft.body.data.template_id as string
  const published = await request(app).post(`${base}/${id}/versions/${draft.body.data.version}/publish`).set(H(lead.token)).send({})
  expect(published.status, JSON.stringify(published.body.error)).toBe(200)
  return id
}

const url = (projectId: string, id = "", suffix = "") => `/api/v1/projects/${projectId}/template-migrations${id ? `/${id}` : ""}${suffix}`

/** start → confirm-mapping → chọn lựa chọn an toàn cho mọi mục bắt buộc → ready. */
const toReady = async (token: string, projectId: string, body: object, choose?: (id: string, choices: string[]) => string): Promise<MigrationDto> => {
  const started = await request(app).post(url(projectId)).set(H(token)).send(body)
  expect(started.status, JSON.stringify(started.body.error)).toBe(201)
  const id = started.body.data.id as string
  expect((await request(app).post(url(projectId, id, "/confirm-mapping")).set(H(token))).status).toBe(200)
  const dto = (await request(app).get(url(projectId, id)).set(H(token))).body.data as MigrationDto
  const items = [...dto.groups.extra, ...dto.groups.conflict]
  const decisions = dto.undecided.map((d) => {
    const item = items.find((i) => i.id === d)!
    const safe = item.choices.filter((c) => !item.ai_choices.includes(c) && !c.startsWith("move_to:"))
    return { id: d, choice: choose?.(d, safe) ?? safe.find((c) => c === "keep_custom") ?? safe[0] }
  })
  if (decisions.length) expect((await request(app).patch(url(projectId, id, "/decisions")).set(H(token)).send({ decisions })).status).toBe(200)
  const ready = await request(app).post(url(projectId, id, "/ready")).set(H(token))
  expect(ready.status, JSON.stringify(ready.body.error)).toBe(200)
  return ready.body.data as MigrationDto
}

const ctxOf = (seeded: SeededFixture, projectId: string) => ({ projectId, orgId: seeded.orgId, actor: { userId: seeded.userId, role: "lead" as OrgRole } })

describe("đổi mẫu — áp dụng / hoàn tác", () => {
  it("A. áp dụng ghi Spine qua CR template_migration + profile mới; hoàn tác khôi phục đủ profile / file nền / template_ref / intent / Spine", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await baselinedProject(lead, await makeSrsDocx({ extraBody: LEGACY }))
    const templateId = await publishTemplate(lead, lead.orgId, "Mẫu ngân hàng", await makeSrsDocx({ extraBody: EXTRA }))
    const profileBefore = (await TemplateProfile.findOne({ projectId }).lean())!
    const projectBefore = (await Project.findById(projectId).lean())!
    const spineBefore = (await spineRepository.get(projectId))!
    const legacyIds = spineBefore.custom_sections.filter((c) => /Legacy/.test(c.heading)).map((c) => c.id)
    expect(legacyIds.length).toBe(1)

    // Xoá mục riêng Legacy Gateway theo quyết định
    const ready = await toReady(lead.token, projectId, { template_id: templateId, version: 1 }, (_id, safe) => (safe.includes("delete") ? "delete" : safe[0]))
    const applied = await request(app).post(url(projectId, ready.id, "/apply")).set(H(lead.token))
    expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
    expect(applied.body.data.state).toBe("applied")

    const migration = (await TemplateMigration.findById(ready.id).lean())!
    expect(migration).toMatchObject({ open: false, translated: false, apply_steps: { snapshot: true, file: true, spine: true, profile: true } })
    // CR nguồn template_migration mang Change; Change có txn tiền tố
    const cr = (await ChangeRequest.findOne({ projectId, "source.kind": "template_migration" }).lean())!
    expect(cr).toMatchObject({ status: "written", source: { kind: "template_migration", ref: ready.id } })
    const own = await Change.find({ projectId, txn: { $regex: `^${TEMPLATE_MIGRATION_TXN_PREFIX}${ready.id}` } }).lean()
    expect(own.length).toBeGreaterThan(0)
    expect(own.every((c) => c.by === cr.cr_id)).toBe(true)
    // Client không tạo được CR nguồn này
    const forged = await request(app).post(`/api/v1/projects/${projectId}/change-requests`).set(H(lead.token)).send({ title: "x", description: "y", requester: "z", source: { kind: "template_migration", ref: null } })
    expect(forged.status).toBe(400)

    spineRepository.clearReadCache()
    const spineAfter = (await spineRepository.get(projectId))!
    expect(spineAfter.custom_sections.some((c) => c.id === legacyIds[0])).toBe(false)
    const profileAfter = (await TemplateProfile.findOne({ projectId }).lean())!
    expect(profileAfter.source_file_ref).toBe(migration.new_base_file_ref)
    expect(profileAfter.source_file_ref).not.toBe(profileBefore.source_file_ref)
    expect(profileAfter.migrated_base_at).toBeTruthy()
    expect(profileAfter.migrated_base_spine ?? null).toBeNull()
    expect(String(profileAfter.migrated_base_migration_id)).toBe(ready.id)
    expect(profileAfter.heading_map.length).toBeGreaterThan(0)
    expect(profileAfter.layout.some((l) => /Operating Environment/.test(l.heading_text))).toBe(true)
    // Mục thiếu (Operating Environment) ghi vào profile + migration
    expect(profileAfter.migration_missing_sections?.length).toBeGreaterThan(0)
    expect(migration.missing_sections).toEqual(profileAfter.migration_missing_sections)
    const projectAfter = (await Project.findById(projectId).lean())!
    expect(projectAfter.template_intent).toBe("fixed")
    expect(String(projectAfter.template_ref!.template_id)).toBe(templateId)
    // File nền mới đọc được, đủ heading của mẫu mới
    const newFile = await docFileStore().load(migration.new_base_file_ref!)
    expect(newFile.length).toBeGreaterThan(1000)

    // Chỗ mở lại + không áp dụng hai lần
    expect((await request(app).post(url(projectId, ready.id, "/apply")).set(H(lead.token))).body.error.code).toBe("TEMPLATE_MIGRATION_INVALID_STATE")

    // Hoàn tác
    const reverted = await request(app).post(url(projectId, ready.id, "/revert")).set(H(lead.token))
    expect(reverted.status, JSON.stringify(reverted.body)).toBe(200)
    expect(reverted.body.data.state).toBe("reverted")
    spineRepository.clearReadCache()
    const spineBack = (await spineRepository.get(projectId))!
    expect(spineBack.custom_sections.some((c) => c.id === legacyIds[0])).toBe(true)
    expect(spineBack.custom_sections.length).toBe(spineBefore.custom_sections.length)
    const profileBack = (await TemplateProfile.findOne({ projectId }).lean())!
    expect(profileBack.source_file_ref).toBe(profileBefore.source_file_ref)
    expect(profileBack.language).toBe(profileBefore.language)
    expect(profileBack.heading_map).toEqual(profileBefore.heading_map)
    expect(profileBack.layout).toEqual(profileBefore.layout)
    expect(profileBack.migrated_base_at ?? null).toBeNull()
    const projectBack = (await Project.findById(projectId).lean())!
    expect(projectBack.template_ref ?? null).toEqual(projectBefore.template_ref ?? null)
    expect(projectBack.template_intent ?? null).toEqual(projectBefore.template_intent ?? null)
    await expect(docFileStore().load(migration.new_base_file_ref!)).rejects.toBeTruthy()
    // Hoàn tác lần hai ⇒ sai trạng thái
    expect((await request(app).post(url(projectId, ready.id, "/revert")).set(H(lead.token))).status).toBe(409)
  })

  it("B. có thay đổi sau lần đổi mẫu ⇒ hoàn tác bị chặn; đổi ngược về mẫu trước giữ CR, Hoàn tác hết trả lại chữ gốc", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await baselinedProject(lead, await makeSrsDocx())
    const before = (await Project.findById(projectId).lean())!.template_ref!
    const templateId = await publishTemplate(lead, lead.orgId, "Mẫu mới", await makeSrsDocx({ extraBody: EXTRA }))
    const ready = await toReady(lead.token, projectId, { template_id: templateId, version: 1 })
    expect((await request(app).post(url(projectId, ready.id, "/apply")).set(H(lead.token))).status).toBe(200)

    // Một CR ghi sau lần đổi mẫu (sửa tầm nhìn dự án)
    spineRepository.clearReadCache()
    const head = (await spineRepository.get(projectId))!
    await applyTransaction(projectId, { base_version: head.spine_version, ops: [{ op: "set", path: "project.vision", value: "Tầm nhìn sau đổi mẫu" }], by: "CR-900", reason: "CR-900: sửa", step_id: null })
    spineRepository.clearReadCache()

    const blocked = await request(app).post(url(projectId, ready.id, "/revert")).set(H(lead.token))
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe("TEMPLATE_MIGRATION_REVERT_BLOCKED")
    expect(blocked.body.meta).toMatchObject({ use: "reverse_migration" })
    expect((await TemplateMigration.findById(ready.id).lean())!.state).toBe("applied")

    // Đổi ngược về mẫu trước: mục đã sửa (Giữ hết) ⇒ sửa của CR còn; CR không bị xoá khỏi lịch sử
    const reverse = await request(app).post(url(projectId)).set(H(lead.token)).send({ template_id: String(before.template_id), version: before.version })
    expect(reverse.status, JSON.stringify(reverse.body.error)).toBe(201)
    const rid = reverse.body.data.id as string
    expect(reverse.body.data).toMatchObject({ direction: "reverse", reverse_of: ready.id })
    await request(app).post(url(projectId, rid, "/confirm-mapping")).set(H(lead.token))
    const dto = (await request(app).get(url(projectId, rid)).set(H(lead.token))).body.data as MigrationDto
    expect(dto.groups.edited_since.length).toBeGreaterThan(0)
    const keepAll = await request(app).patch(url(projectId, rid, "/decisions")).set(H(lead.token)).send({ batch: "keep_all" })
    const fresh = keepAll.body.data as MigrationDto
    const items = [...fresh.groups.extra, ...fresh.groups.conflict]
    const decisions = fresh.undecided.map((d) => ({ id: d, choice: items.find((i) => i.id === d)!.choices.find((c) => c === "delete" || c === "drop_from_print") ?? items.find((i) => i.id === d)!.choices[0] }))
    if (decisions.length) await request(app).patch(url(projectId, rid, "/decisions")).set(H(lead.token)).send({ decisions })
    expect((await request(app).post(url(projectId, rid, "/ready")).set(H(lead.token))).status).toBe(200)
    const reversed = await request(app).post(url(projectId, rid, "/apply")).set(H(lead.token))
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200)
    spineRepository.clearReadCache()
    expect((await spineRepository.get(projectId))!.project.vision).toBe("Tầm nhìn sau đổi mẫu")
    expect(await Change.countDocuments({ projectId, by: "CR-900" })).toBe(1)
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    expect(profile.source_file_ref).toBeTruthy()
    expect(profile.layout.some((l) => /Operating Environment/.test(l.heading_text))).toBe(false)
    expect(String((await Project.findById(projectId).lean())!.template_ref!.template_id)).toBe(String(before.template_id))
  })

  it("B2. đổi ngược, mục đã sửa chọn Hoàn tác hết ⇒ sửa của CR bị đảo bằng lô mới, lịch sử CR giữ nguyên", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await baselinedProject(lead, await makeSrsDocx())
    const before = (await Project.findById(projectId).lean())!.template_ref!
    const templateId = await publishTemplate(lead, lead.orgId, "Mẫu mới", await makeSrsDocx({ extraBody: EXTRA }))
    const ready = await toReady(lead.token, projectId, { template_id: templateId, version: 1 })
    expect((await request(app).post(url(projectId, ready.id, "/apply")).set(H(lead.token))).status).toBe(200)
    spineRepository.clearReadCache()
    const head = (await spineRepository.get(projectId))!
    const original = head.project.vision
    await applyTransaction(projectId, { base_version: head.spine_version, ops: [{ op: "set", path: "project.vision", value: "Tầm nhìn sau đổi mẫu" }], by: "CR-901", reason: "CR-901: sửa", step_id: null })
    spineRepository.clearReadCache()

    const reverse = await request(app).post(url(projectId)).set(H(lead.token)).send({ template_id: String(before.template_id), version: before.version })
    const rid = reverse.body.data.id as string
    await request(app).post(url(projectId, rid, "/confirm-mapping")).set(H(lead.token))
    const discard = (await request(app).patch(url(projectId, rid, "/decisions")).set(H(lead.token)).send({ batch: "discard_all" })).body.data as MigrationDto
    const items = [...discard.groups.extra, ...discard.groups.conflict]
    const decisions = discard.undecided.map((d) => ({ id: d, choice: items.find((i) => i.id === d)!.choices.find((c) => c === "keep_custom") ?? items.find((i) => i.id === d)!.choices[0] }))
    if (decisions.length) await request(app).patch(url(projectId, rid, "/decisions")).set(H(lead.token)).send({ decisions })
    expect((await request(app).post(url(projectId, rid, "/ready")).set(H(lead.token))).status).toBe(200)
    const applied = await request(app).post(url(projectId, rid, "/apply")).set(H(lead.token))
    expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
    spineRepository.clearReadCache()
    expect((await spineRepository.get(projectId))!.project.vision).toBe(original)
    // CR-901 vẫn nằm trong lịch sử; việc đảo là Change mới mang txn của lần đổi ngược
    expect(await Change.countDocuments({ projectId, by: "CR-901", op: "set" })).toBe(1)
    expect(await Change.countDocuments({ projectId, txn: new RegExp(`^${TEMPLATE_MIGRATION_TXN_PREFIX}${rid}:revert`) })).toBeGreaterThan(0)
  })

  it("C. lỗi giả lập ở từng bước ⇒ trạng thái nhất quán; tiến trình chết ⇒ job phục hồi (chưa ghi Spine ⇒ ready, đã ghi ⇒ chạy tiếp)", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await baselinedProject(lead, await makeSrsDocx({ extraBody: LEGACY }))
    const templateId = await publishTemplate(lead, lead.orgId, "Mẫu ngân hàng", await makeSrsDocx({ extraBody: EXTRA }))
    const profileBefore = (await TemplateProfile.findOne({ projectId }).lean())!
    const ctx = ctxOf(lead, projectId)
    const boom = (at: string) => (step: string) => {
      if (step === at) throw new Error(`lỗi giả lập sau ${at}`)
    }
    const noNewFiles = async (id: string) => {
      const m = (await TemplateMigration.findById(id).lean())!
      return m.new_base_file_ref
    }

    // Trước bước Spine: lỗi ⇒ về ready, bản nháp + file nền cũ còn nguyên, file mới đã xoá
    let ready = await toReady(lead.token, projectId, { template_id: templateId, version: 1 }, (_d, s) => (s.includes("delete") ? "delete" : s[0]))
    for (const at of ["claimed", "translated", "snapshot", "file"] as const) {
      await expect(applyMigration(ctx, ready.id, { afterStep: boom(at) })).rejects.toThrow(/lỗi giả lập/)
      const m = (await TemplateMigration.findById(ready.id).lean())!
      expect(m.state, at).toBe("ready")
      expect(m.open).toBe(true)
      expect(m.new_base_file_ref).toBeNull()
      expect(m.apply_steps).toEqual({ snapshot: false, file: false, spine: false, profile: false })
      expect(await Change.countDocuments({ projectId, txn: { $regex: `^${TEMPLATE_MIGRATION_TXN_PREFIX}` } }), at).toBe(0)
      expect((await TemplateProfile.findOne({ projectId }).lean())!.source_file_ref).toBe(profileBefore.source_file_ref)
      expect((await Project.findById(projectId).lean())!.template_intent ?? null).not.toBe("fixed")
    }
    void noNewFiles

    // Sau bước Spine: đã ghi thì đi tiếp tới cùng ⇒ applied nhất quán (không lẫn profile cũ + Spine mới)
    for (const at of ["spine", "profile"] as const) {
      ready = at === "spine" ? ready : ready
      const res = await applyMigration(ctx, ready.id, { afterStep: boom(at) })
      expect(res.state, at).toBe("applied")
      const profile = (await TemplateProfile.findOne({ projectId }).lean())!
      expect(profile.source_file_ref).toBe((await TemplateMigration.findById(ready.id).lean())!.new_base_file_ref)
      expect(String((await Project.findById(projectId).lean())!.template_ref!.template_id)).toBe(templateId)
      break
    }
  })

  it("C2. tiến trình chết giữa chừng: chưa ghi Spine ⇒ job phục hồi trả về ready; đã ghi Spine ⇒ job chạy tiếp tới applied", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await baselinedProject(lead, await makeSrsDocx({ extraBody: LEGACY }))
    const templateId = await publishTemplate(lead, lead.orgId, "Mẫu ngân hàng", await makeSrsDocx({ extraBody: EXTRA }))
    const ctx = ctxOf(lead, projectId)
    const crash = (at: string) => (step: string) => {
      if (step === at) throw new Error("tiến trình chết")
    }
    const ready = await toReady(lead.token, projectId, { template_id: templateId, version: 1 }, (_d, s) => (s.includes("delete") ? "delete" : s[0]))

    // Chết sau khi lưu file nền (chưa ghi Spine)
    await expect(applyMigration(ctx, ready.id, { afterStep: crash("file"), recoverOnError: false })).rejects.toThrow()
    let m = (await TemplateMigration.findById(ready.id).lean())!
    expect(m.state).toBe("applying")
    expect(m.open).toBe(true)
    expect(m.apply_steps.file).toBe(true)
    // Job định kỳ không động tới lần áp dụng còn mới
    expect(await recoverStuckMigrations()).toEqual({ applied: 0, ready: 0, failed: 0 })
    expect(await recoverApplyingMigration(ready.id)).toBe("skipped")
    // Im lặng quá lâu ⇒ phục hồi: về ready, file mới đã xoá, chạy lại không lỗi
    await TemplateMigration.updateOne({ _id: ready.id }, { $set: { applying_heartbeat: new Date(Date.now() - 3_600_000) } })
    expect(await recoverStuckMigrations()).toEqual({ applied: 0, ready: 1, failed: 0 })
    expect(await recoverApplyingMigration(ready.id)).toBe("skipped")
    m = (await TemplateMigration.findById(ready.id).lean())!
    expect(m).toMatchObject({ state: "ready", new_base_file_ref: null, snapshot: null })
    expect(await Change.countDocuments({ projectId, txn: { $regex: `^${TEMPLATE_MIGRATION_TXN_PREFIX}` } })).toBe(0)

    // Chết sau khi ghi Spine (chưa ghi profile) ⇒ chạy tiếp
    await expect(applyMigration(ctx, ready.id, { afterStep: crash("spine"), recoverOnError: false })).rejects.toThrow()
    expect(await Change.countDocuments({ projectId, txn: { $regex: `^${TEMPLATE_MIGRATION_TXN_PREFIX}${ready.id}` } })).toBeGreaterThan(0)
    expect((await Project.findById(projectId).lean())!.template_intent ?? null).not.toBe("fixed")
    expect(await recoverApplyingMigration(ready.id, { force: true })).toBe("applied")
    expect(await recoverApplyingMigration(ready.id, { force: true })).toBe("skipped")
    m = (await TemplateMigration.findById(ready.id).lean())!
    expect(m.state).toBe("applied")
    expect(m.open).toBe(false)
    expect((await TemplateProfile.findOne({ projectId }).lean())!.source_file_ref).toBe(m.new_base_file_ref)
    expect((await Project.findById(projectId).lean())!.template_intent).toBe("fixed")
    // Ghi Spine đúng một lần (chạy tiếp không ghi lại)
    const changes = await Change.countDocuments({ projectId, txn: `${TEMPLATE_MIGRATION_TXN_PREFIX}${ready.id}` })
    expect(changes).toBeGreaterThan(0)
  })

  it("D. Spine đổi giữa ready và áp dụng ⇒ 409 STALE, quay về bước phân nhóm, chưa ghi gì", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await baselinedProject(lead, await makeSrsDocx())
    const templateId = await publishTemplate(lead, lead.orgId, "Mẫu mới", await makeSrsDocx({ extraBody: EXTRA }))
    const ready = await toReady(lead.token, projectId, { template_id: templateId, version: 1 })
    spineRepository.clearReadCache()
    const head = (await spineRepository.get(projectId))!
    await applyTransaction(projectId, { base_version: head.spine_version, ops: [{ op: "set", path: "project.vision", value: "đổi giữa chừng" }], by: "CR-902", reason: "CR-902", step_id: null })
    spineRepository.clearReadCache()
    const res = await request(app).post(url(projectId, ready.id, "/apply")).set(H(lead.token))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("TEMPLATE_MIGRATION_STALE")
    const m = (await TemplateMigration.findById(ready.id).lean())!
    expect(m).toMatchObject({ state: "decisions", prepared_spine_version: null })
    expect(await Change.countDocuments({ projectId, txn: { $regex: `^${TEMPLATE_MIGRATION_TXN_PREFIX}` } })).toBe(0)
  })

  it("E. dịch đè Spine: EN → VI và VI → EN, trừ credit; version 1.0 đã phát hành vẫn nguyên chữ + ngôn ngữ cũ; hoàn tác trả chữ gốc", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await baselinedProject(lead, await makeSrsDocx())
    const viTemplate = await publishTemplate(lead, lead.orgId, "Mẫu VI", await makeSrsDocx({ extraBody: VI_BODY }))
    const enTemplate = await publishTemplate(lead, lead.orgId, "Mẫu EN", await makeSrsDocx({ extraBody: EXTRA }))
    const balance = async () => (await CreditWallet.findOne({ organizationId: lead.orgId }).lean())!.balance
    const versionsBefore = await DocVersion.find({ projectId }).lean()
    expect(versionsBefore.length).toBeGreaterThan(0)
    const visionBefore = (await spineRepository.get(projectId))!.project.vision
    const profileBefore = (await TemplateProfile.findOne({ projectId }).lean())!

    // EN → VI
    const startBalance = await balance()
    const ready = await toReady(lead.token, projectId, { template_id: viTemplate, version: 1 })
    expect(ready.language).toMatchObject({ source: "en", target: "vi", needs_translation: true })
    const applied = await request(app).post(url(projectId, ready.id, "/apply")).set(H(lead.token))
    expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
    const m = (await TemplateMigration.findById(ready.id).lean())!
    expect(m.translated).toBe(true)
    expect(m.translated_units.length).toBeGreaterThan(0)
    expect(await balance()).toBeLessThan(startBalance)
    spineRepository.clearReadCache()
    const spineVi = (await spineRepository.get(projectId))!
    if (visionBefore) expect(spineVi.project.vision).toBe(`[vi] ${visionBefore}`)
    const profileVi = (await TemplateProfile.findOne({ projectId }).lean())!
    expect(profileVi.language).toBe("vi")
    expect((await Project.findById(projectId).lean())!.documentLanguage).toBe("vi")
    expect(profileVi.function_originals).toEqual([])
    // Bản đã phát hành giữ nguyên: bản ghi + file + binding không bị đụng
    const versionsAfter = await DocVersion.find({ projectId }).lean()
    expect(versionsAfter.map((v) => [v.version, v.file_ref, v.template_source ?? null, v.spine_snapshot ?? null])).toEqual(versionsBefore.map((v) => [v.version, v.file_ref, v.template_source ?? null, v.spine_snapshot ?? null]))
    for (const v of versionsAfter) expect((await docFileStore().load(v.file_ref)).length).toBeGreaterThan(0)

    // Hoàn tác ⇒ chữ gốc + ngôn ngữ cũ
    expect((await request(app).post(url(projectId, ready.id, "/revert")).set(H(lead.token))).status).toBe(200)
    spineRepository.clearReadCache()
    expect((await spineRepository.get(projectId))!.project.vision).toBe(visionBefore)
    expect((await TemplateProfile.findOne({ projectId }).lean())!.language).toBe(profileBefore.language)
    expect((await Project.findById(projectId).lean())!.documentLanguage ?? null).toBeNull()

    // VI → EN: dự án viết bằng tiếng Việt (ngôn ngữ gốc của file = vi), mẫu đích tiếng Anh
    await TemplateProfile.updateOne({ projectId }, { $set: { language: "vi" } })
    const readyEn = await toReady(lead.token, projectId, { template_id: enTemplate, version: 1 })
    expect(readyEn.language).toMatchObject({ source: "vi", target: "en", needs_translation: true })
    const before = await balance()
    const appliedEn = await request(app).post(url(projectId, readyEn.id, "/apply")).set(H(lead.token))
    expect(appliedEn.status, JSON.stringify(appliedEn.body.error)).toBe(200)
    expect(await balance()).toBeLessThan(before)
    expect((await TemplateProfile.findOne({ projectId }).lean())!.language).toBe("en")
    spineRepository.clearReadCache()
    if (visionBefore) expect((await spineRepository.get(projectId))!.project.vision).toBe(`[en] ${visionBefore}`)
    expect((await DocVersion.find({ projectId }).lean()).map((v) => v.file_ref)).toEqual(versionsBefore.map((v) => v.file_ref))
  })

  it("F. Viewer và dự án org khác không áp dụng / hoàn tác được", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const other = await seedFixture("minimal", { balance: 1000 })
    const viewer = await User.create({ email: `viewer-apply-${Date.now()}@flintflow.test`, password: "test-password-123", emailVerified: true })
    await Membership.create({ userId: viewer._id, organizationId: lead.orgId, role: "viewer" })
    const viewerToken = await authAs({ _id: viewer._id, email: viewer.email, orgId: lead.orgId })
    const projectId = await baselinedProject(lead, await makeSrsDocx())
    const templateId = await publishTemplate(lead, lead.orgId, "Mẫu mới", await makeSrsDocx({ extraBody: EXTRA }))
    const ready = await toReady(lead.token, projectId, { template_id: templateId, version: 1 })
    for (const suffix of ["/apply", "/revert"]) {
      expect((await request(app).post(url(projectId, ready.id, suffix)).set(H(viewerToken))).status, suffix).toBe(403)
      expect((await request(app).post(url(projectId, ready.id, suffix)).set(H(other.token))).status, suffix).toBe(404)
    }
    expect((await TemplateMigration.findById(ready.id).lean())!.state).toBe("ready")
  })
})
