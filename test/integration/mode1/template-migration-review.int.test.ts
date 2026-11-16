/**
 * Sửa sau review phase 5 — API + Mongo thật:
 *  R1  CR / release không ghi được khi migration `applying` / `reverting`.
 *  R2  Phục hồi chạy tiếp quá số lần ⇒ `apply_failed`, báo người tạo; "khôi phục từ snapshot" đảo Change + trả profile.
 *  R3  Chạy tiếp ghi Spine có khoá lạc quan: Spine bị ghi chen ⇒ 409, không ghi op cũ đè lên.
 *  R4  `revertable` + lý do; waiver của BA chặn hoàn tác, cờ tính lại thì không; `reverting` bị phục hồi chạy tiếp; hoàn tác cần không có lần đổi mẫu mở.
 *  R5  Snapshot không chứa bản sao Spine; binding version tham chiếu migration (không nhúng Spine).
 *  R6  Ngôn ngữ của version cũ (dự án chuyển từ FPT) lấy từ snapshot của lần đổi mẫu đầu sau version.
 *  R7  Đổi ngược làm gãy liên kết: `broken_links` báo trước, áp dụng 409 liệt kê; chọn lại thì áp dụng được.
 *  R8  Tải version cũ sau dịch VI → EN: nhãn + chữ nguyên.
 *  R9  Dự án chuyển từ FPT: mẫu khác ngôn ngữ chỉ đổi ngôn ngữ tài liệu, không dịch Spine, không credit.
 *  R10 Mục khung thừa: không có lựa chọn xoá dữ liệu, `drop_from_print` giữ dữ liệu + không cờ "mẫu không có mục này".
 *  R11 AI (D8): move_to vào mục có cấu trúc sinh op qua CR template_migration, trừ credit đúng giá; AI không chuyển được ⇒ giữ mục riêng.
 *  R12 Sửa mapping của file mẫu tải lên.
 *  R13 Mẫu trước của dự án từng theo mẫu tự do: bản riêng, chọn được làm đích đổi ngược.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import mongoose from "mongoose"
import request from "supertest"
import app from "../../../src/app.js"
import { authAs, seedFixture, type SeededFixture } from "../../setup.js"
import { crToReady, importedProject, resetCrMock } from "../../helpers/mode1-cr-p4.js"
import { createMode1Project } from "../../helpers/mode1.js"
import { mockOverrides } from "../../helpers/mock-llm.js"
import { fileOf } from "../../helpers/mode1-import-p4.js"
import { mockTranslateItems } from "../../../src/shared/ai/providers/mock.provider.js"
import { makeDocx, p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { DocxPackage, readBlocks } from "../../../src/modules/docx-ooxml/index.js"
import { docFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { release } from "../../../src/modules/doc-version/release.service.js"
import { convertedLanguages } from "../../../src/modules/doc-version/render-version.js"
import { acceptLatest, uploadImport } from "../../../src/modules/import/import.service.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { finalizeImport } from "../../../src/modules/import/finalize.service.js"
import { OrgTemplateVersion } from "../../../src/modules/import/org-library.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { Membership, type OrgRole } from "../../../src/modules/organization/membership.model.js"
import { Notification } from "../../../src/modules/notification/notification.model.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { Change } from "../../../src/modules/spine/change.model.js"
import { applyTransaction } from "../../../src/modules/spine/op-engine.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { applyMigration, writeSpine } from "../../../src/modules/template-migration/apply.service.js"
import { recoverApplyingMigration, recoverStuckMigrations } from "../../../src/modules/template-migration/recover-applying.js"
import { TemplateMigration } from "../../../src/modules/template-migration/template-migration.model.js"
import type { MigrationDto } from "../../../src/modules/template-migration/template-migration.service.js"
import { TEMPLATE_MIGRATION_TXN_PREFIX } from "../../../src/modules/template-migration/edited-since.js"
import { User } from "../../../src/modules/user/user.model.js"

const H = (token: string) => ({ Authorization: `Bearer ${token}` })
const EXTRA = styled("u1", "6 Operating Environment") + p("[Describe the operating environment.]")
const LEGACY = styled("u1", "9 Legacy Gateway") + p("Nightly batch to the legacy gateway.")
const VI_SENTENCE = "Hệ thống cho phép người dùng đăng nhập và quản lý khoá học trực tuyến một cách thuận tiện."
const VI_BODY = styled("u1", "6 Môi trường vận hành") + Array.from({ length: 30 }, () => p(VI_SENTENCE)).join("")
const ASSUMPTIONS = styled("u1", "7 Assumptions") + p("[List the assumptions.]")

/** Trả lời AI giả cho bước giải quyết (D8): thêm một yêu cầu khác từ chữ của mục; `aiMode` đổi hành vi theo test. */
const ai = { mode: "add" as "add" | "empty" }

beforeEach(() => {
  resetCrMock()
  const route = mockOverrides.next!
  mockOverrides.next = (prompt) => {
    if (prompt.includes("You translate a batch")) return JSON.stringify({ items: mockTranslateItems(prompt) })
    if (prompt.includes("Resolve one template-migration item")) {
      return JSON.stringify(
        ai.mode === "add"
          ? { ops: [{ op: "add", path: "other_requirements[]", value: { kind: "assumption", statement: "Nightly batch to the legacy gateway." } }], choice: null, notes: null }
          : { ops: [], choice: null, notes: "Cannot map" }
      )
    }
    return route(prompt)
  }
  ai.mode = "add"
})

const url = (projectId: string, id = "", suffix = "") => `/api/v1/projects/${projectId}/template-migrations${id ? `/${id}` : ""}${suffix}`

const publishTemplate = async (token: string, orgId: string, file: Buffer): Promise<string> => {
  const base = `/api/v1/orgs/${orgId}/templates`
  const draft = await request(app).post(base).set(H(token)).attach("file", file, "Mau.docx").field("name", `Mẫu ${Math.random().toString(36).slice(2, 7)}`)
  expect(draft.status, JSON.stringify(draft.body.error)).toBe(201)
  const id = draft.body.data.template_id as string
  expect((await request(app).post(`${base}/${id}/versions/${draft.body.data.version}/publish`).set(H(token)).send({})).status).toBe(200)
  return id
}

type Choose = (id: string, choices: string[], aiChoices: string[]) => string | undefined

const decide = async (token: string, projectId: string, id: string, choose?: Choose): Promise<MigrationDto> => {
  const dto = (await request(app).get(url(projectId, id)).set(H(token))).body.data as MigrationDto
  const items = [...dto.groups.extra, ...dto.groups.conflict]
  const decisions = dto.undecided.map((d) => {
    const item = items.find((i) => i.id === d)!
    const safe = item.choices.filter((c) => !item.ai_choices.includes(c) && !c.startsWith("move_to:"))
    return { id: d, choice: choose?.(d, item.choices, item.ai_choices) ?? safe.find((c) => c === "delete" || c === "drop_from_print") ?? safe[0] }
  })
  if (decisions.length) expect((await request(app).patch(url(projectId, id, "/decisions")).set(H(token)).send({ decisions })).status).toBe(200)
  return (await request(app).get(url(projectId, id)).set(H(token))).body.data as MigrationDto
}

const startReady = async (token: string, projectId: string, body: object, choose?: Choose): Promise<MigrationDto> => {
  const started = await request(app).post(url(projectId)).set(H(token)).send(body)
  expect(started.status, JSON.stringify(started.body.error)).toBe(201)
  const id = started.body.data.id as string
  await request(app).post(url(projectId, id, "/confirm-mapping")).set(H(token))
  await decide(token, projectId, id, choose)
  const ready = await request(app).post(url(projectId, id, "/ready")).set(H(token))
  expect(ready.status, JSON.stringify(ready.body.error)).toBe(200)
  return ready.body.data as MigrationDto
}

const migrate = async (token: string, projectId: string, templateId: string, choose?: Choose): Promise<string> => {
  const ready = await startReady(token, projectId, { template_id: templateId, version: 1 }, choose)
  const applied = await request(app).post(url(projectId, ready.id, "/apply")).set(H(token))
  expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
  return ready.id
}

const baselinedProject = async (seeded: SeededFixture, buffer: Buffer): Promise<string> => {
  const projectId = await createMode1Project(seeded, "Lumen import")
  const doc = await uploadImport(projectId, seeded.userId, fileOf(buffer))
  await acceptLatest(doc, true)
  await runExtraction(projectId, seeded.userId, String(doc._id))
  const before = (await spineRepository.get(projectId))!
  await finalizeImport(projectId, seeded.userId, { import_id: String(doc._id), base_version: before.spine_version })
  return projectId
}

const ctxOf = (seeded: SeededFixture, projectId: string) => ({ projectId, orgId: seeded.orgId, actor: { userId: seeded.userId, role: "lead" as OrgRole } })
const balanceOf = async (orgId: string) => (await CreditWallet.findOne({ organizationId: orgId }).lean())!.balance
const crash = (at: string) => (step: string) => {
  if (step === at) throw new Error("tiến trình chết")
}

describe("rào ghi bản nháp khi đang đổi mẫu (R1)", () => {
  it("CR xác nhận / release bị 409 khi migration applying hoặc reverting; hết trạng thái đó thì ghi bình thường", async () => {
    const { seeded, projectId, c } = await importedProject()
    const templateId = await publishTemplate(seeded.token, seeded.orgId, await makeSrsDocx({ extraBody: EXTRA }))
    const id = await migrate(seeded.token, projectId, templateId)
    const { cr } = await crToReady(c)

    for (const state of ["applying", "reverting"] as const) {
      await TemplateMigration.updateOne({ _id: id }, { $set: { state, open: true } })
      const submit = await c.post(`${cr}/submit`)
      expect(submit.status, state).toBe(409)
      expect(submit.body.error.code).toBe("TEMPLATE_MIGRATION_APPLYING")
      await expect(release(projectId, seeded.userId, await c.spineVersion())).rejects.toMatchObject({ statusCode: 409, code: "TEMPLATE_MIGRATION_APPLYING" })
    }
    expect(await Change.countDocuments({ projectId, by: /^CR-/, op: "set", path: /nfrs/ })).toBe(0)

    await TemplateMigration.updateOne({ _id: id }, { $set: { state: "applied", open: false } })
    const submit = await c.post(`${cr}/submit`)
    expect(submit.status, JSON.stringify(submit.body.error)).toBe(200)
  })
})

describe("phục hồi kẹt (R2, R3)", () => {
  it("R2. chạy tiếp lỗi quá số lần ⇒ apply_failed + thông báo; khôi phục từ snapshot đảo Spine, trả profile, đóng migration", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await baselinedProject(lead, await makeSrsDocx({ extraBody: LEGACY }))
    const templateId = await publishTemplate(lead.token, lead.orgId, await makeSrsDocx({ extraBody: EXTRA }))
    const profileBefore = (await TemplateProfile.findOne({ projectId }).lean())!
    const spineBefore = (await spineRepository.get(projectId))!
    const ready = await startReady(lead.token, projectId, { template_id: templateId, version: 1 })
    await expect(applyMigration(ctxOf(lead, projectId), ready.id, { afterStep: crash("spine"), recoverOnError: false })).rejects.toThrow()
    // Phá dữ liệu của bước profile ⇒ chạy tiếp luôn lỗi
    await TemplateMigration.updateOne({ _id: ready.id }, { $set: { new_profile: null } })

    for (let i = 1; i <= 5; i++) await expect(recoverApplyingMigration(ready.id, { force: true }), `lần ${i}`).rejects.toThrow()
    expect(await recoverApplyingMigration(ready.id, { force: true })).toBe("failed")
    let m = (await TemplateMigration.findById(ready.id).lean())!
    expect(m).toMatchObject({ state: "apply_failed", open: true, apply_token: null })
    expect(await Notification.countDocuments({ userId: lead.userId, type: "template_migration_failed" })).toBe(1)
    // Job định kỳ không còn đụng tới nó
    expect(await recoverStuckMigrations()).toEqual({ applied: 0, ready: 0, failed: 0 })

    const restored = await request(app).post(url(projectId, ready.id, "/restore")).set(H(lead.token))
    expect(restored.status, JSON.stringify(restored.body)).toBe(200)
    expect(restored.body.data.state).toBe("failed")
    m = (await TemplateMigration.findById(ready.id).lean())!
    expect(m.open).toBe(false)
    spineRepository.clearReadCache()
    expect((await spineRepository.get(projectId))!.custom_sections.length).toBe(spineBefore.custom_sections.length)
    const profileAfter = (await TemplateProfile.findOne({ projectId }).lean())!
    expect(profileAfter.source_file_ref).toBe(profileBefore.source_file_ref)
    expect(profileAfter.layout).toEqual(profileBefore.layout)
    await expect(docFileStore().load(m.new_base_file_ref!)).rejects.toBeTruthy()
    // Chỗ của dự án đã mở lại
    expect((await request(app).post(url(projectId)).set(H(lead.token)).send({ template_id: templateId, version: 1 })).status).toBe(201)
  })

  it("R3. chạy tiếp ghi Spine có khoá lạc quan: Spine bị ghi chen sau khi lập kế hoạch ⇒ 409, không ghi op cũ đè lên", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await baselinedProject(lead, await makeSrsDocx({ extraBody: LEGACY }))
    const templateId = await publishTemplate(lead.token, lead.orgId, await makeSrsDocx({ extraBody: EXTRA }))
    const ready = await startReady(lead.token, projectId, { template_id: templateId, version: 1 })
    await expect(applyMigration(ctxOf(lead, projectId), ready.id, { afterStep: crash("file"), recoverOnError: false })).rejects.toThrow()
    spineRepository.clearReadCache()
    const head = (await spineRepository.get(projectId))!
    await applyTransaction(projectId, { base_version: head.spine_version, ops: [{ op: "set", path: "project.vision", value: "Sửa chen giữa" }], by: "CR-920", reason: "CR-920", step_id: null })
    spineRepository.clearReadCache()
    const doc = (await TemplateMigration.findById(ready.id))!
    expect(doc.spine_plan?.ops?.length).toBeGreaterThan(0)
    await expect(writeSpine(doc, lead.userId)).rejects.toMatchObject({ code: spineRepository.SPINE_VERSION_CONFLICT })
    expect(await Change.countDocuments({ projectId, txn: { $regex: `^${TEMPLATE_MIGRATION_TXN_PREFIX}` } })).toBe(0)
    expect((await spineRepository.get(projectId))!.project.vision).toBe("Sửa chen giữa")
    // Chưa ghi gì ⇒ phục hồi trả về ready
    expect(await recoverApplyingMigration(ready.id, { force: true })).toBe("ready")
  })
})

describe("hoàn tác: revertable, waiver, reverting (R4)", () => {
  it("revertable + lý do; cờ tính lại không chặn, waiver của BA chặn; có lần đổi mẫu mở ⇒ 409; reverting bị phục hồi chạy tiếp", async () => {
    const { seeded, projectId } = await importedProject()
    const before = (await Project.findById(projectId).lean())!.template_ref!
    const templateId = await publishTemplate(seeded.token, seeded.orgId, await makeSrsDocx({ extraBody: EXTRA }))
    const id = await migrate(seeded.token, projectId, templateId)
    const list = async () => (await request(app).get(url(projectId)).set(H(seeded.token))).body.data as { id: string; revertable: boolean | null; revert_blocked_reason: string | null; previous_template: { template_id: string; version: number; visibility: string } | null }[]
    const latest = async () => (await list()).find((m) => m.id === id)!

    expect(await latest()).toMatchObject({ revertable: true, revert_blocked_reason: null, previous_template: { template_id: String(before.template_id), version: before.version } })
    expect((await request(app).get(url(projectId, id)).set(H(seeded.token))).body.data).toMatchObject({ revertable: true, revert_blocked_reason: null })

    const nextSeq = async () => ((await Change.findOne({ projectId }).sort({ seq: -1 }).lean())?.seq ?? 0) + 1
    const flagChange = async (reason: string) => {
      await Change.create({ projectId, seq: await nextSeq(), txn: `t-${reason}`, op: "set", path: "flags[id=FL900].waived_by_user", before: false, value: true, reason, at: new Date(), by: seeded.userId, step_id: null })
      spineRepository.clearReadCache()
    }
    await flagChange("Mở cờ template_section_empty")
    expect(await latest()).toMatchObject({ revertable: true })
    await flagChange("Waive template_section_absent")
    expect(await latest()).toMatchObject({ revertable: false, revert_blocked_reason: "has_later_changes" })
    expect((await request(app).post(url(projectId, id, "/revert")).set(H(seeded.token))).body.error.code).toBe("TEMPLATE_MIGRATION_REVERT_BLOCKED")
    await Change.deleteOne({ projectId, txn: "t-Waive template_section_absent" })
    spineRepository.clearReadCache()

    // Có lần đổi mẫu khác đang mở ⇒ không hoàn tác được
    const other = await request(app).post(url(projectId)).set(H(seeded.token)).send({ template_id: String(before.template_id), version: before.version })
    expect(other.status, JSON.stringify(other.body.error)).toBe(201)
    expect(await latest()).toMatchObject({ revertable: false, revert_blocked_reason: "migration_open" })
    const open = await request(app).post(url(projectId, id, "/revert")).set(H(seeded.token))
    expect(open.status).toBe(409)
    expect(open.body.error.code).toBe("TEMPLATE_MIGRATION_OPEN")
    await request(app).post(url(projectId, other.body.data.id, "/cancel")).set(H(seeded.token))

    // `reverting` bỏ dở (tiến trình chết sau khi chiếm): job phục hồi chạy tiếp hoàn tác
    await TemplateMigration.updateOne({ _id: id }, { $set: { state: "reverting", open: true, applying_heartbeat: new Date(Date.now() - 3_600_000) } })
    expect(await recoverStuckMigrations()).toEqual({ applied: 1, ready: 0, failed: 0 })
    const m = (await TemplateMigration.findById(id).lean())!
    expect(m).toMatchObject({ state: "reverted", open: false })
    expect(String((await Project.findById(projectId).lean())!.template_ref!.template_id)).toBe(String(before.template_id))
  })
})

describe("kích thước dữ liệu (R5)", () => {
  it("snapshot không chứa bản sao Spine; binding version tham chiếu migration, hoàn tác trả mốc của migration trước", async () => {
    const { seeded, projectId, c } = await importedProject()
    const templateId = await publishTemplate(seeded.token, seeded.orgId, await makeSrsDocx({ extraBody: EXTRA }))
    const id = await migrate(seeded.token, projectId, templateId)
    const m = (await TemplateMigration.findById(id).lean())!
    expect(m.snapshot!.profile).toBeTruthy()
    expect(m.snapshot!.profile).not.toHaveProperty("flow2_entry_spine")
    expect(m.snapshot!.profile).not.toHaveProperty("migrated_base_spine")
    expect(m.anchor_spine).toBeTruthy()
    // Profile chỉ giữ id migration (không chép Spine — trần 16MB); mốc nằm ở migration
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    expect(profile.migrated_base_spine ?? null).toBeNull()
    expect(String(profile.migrated_base_migration_id)).toBe(id)

    const { cr } = await crToReady(c)
    expect((await c.post(`${cr}/submit`)).status).toBe(200)
    const v = (await DocVersion.findOne({ projectId }).sort({ createdAt: -1 }).lean())!
    const anchor = (v.template_source as { fidelity_anchor?: { ref?: unknown; spine?: unknown } } | null)?.fidelity_anchor
    expect(anchor?.ref).toEqual({ kind: "migration", id })
    expect(anchor?.spine).toBeUndefined()

    expect((await request(app).post(url(projectId, id, "/revert")).set(H(seeded.token))).status).toBe(409) // có CR sau
  })

  it("hoàn tác trả lại mốc của migration trước (profile chỉ đổi id)", async () => {
    const { seeded, projectId } = await importedProject()
    const templateId = await publishTemplate(seeded.token, seeded.orgId, await makeSrsDocx({ extraBody: EXTRA }))
    const id = await migrate(seeded.token, projectId, templateId)
    expect((await request(app).post(url(projectId, id, "/revert")).set(H(seeded.token))).status).toBe(200)
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    expect(profile.migrated_base_migration_id ?? null).toBeNull()
    expect(profile.migrated_base_spine ?? null).toBeNull()
  })
})

describe("ngôn ngữ của version cũ (R6)", () => {
  it("dự án chuyển từ FPT: version chưa có `languages` lấy ngôn ngữ từ snapshot của lần đổi mẫu đầu sau version", async () => {
    const { projectId } = await importedProject()
    await Project.updateOne({ _id: projectId }, { $set: { converted_from: "fpt", documentLanguage: "en" } })
    const createdAt = new Date("2026-11-01T00:00:00Z")
    expect((await convertedLanguages(projectId, createdAt))?.locale).toBe("en")
    await TemplateMigration.collection.insertOne({ projectId: new mongoose.Types.ObjectId(projectId), applied_at: new Date("2026-11-05T00:00:00Z"), snapshot: { document_language: "vi" } })
    await Project.updateOne({ _id: projectId }, { $set: { documentLanguage: "en" } })
    // Version tạo trước lần đổi mẫu: ngôn ngữ lúc đó (snapshot = vi), dù hiện tại là en; version tạo sau ⇒ ngôn ngữ hiện tại
    expect((await convertedLanguages(projectId, createdAt))?.locale).toBe("vi")
    expect((await convertedLanguages(projectId, new Date("2026-11-09T00:00:00Z")))?.locale).toBe("en")
  })
})

describe("đổi ngược: liên kết gãy (R7)", () => {
  it("broken_links báo trước ở GET; áp dụng 409 LINKS_BROKEN liệt kê; chọn Giữ hết ⇒ hết báo + áp dụng được", async () => {
    const { seeded, projectId } = await importedProject()
    const before = (await Project.findById(projectId).lean())!.template_ref!
    const templateId = await publishTemplate(seeded.token, seeded.orgId, await makeSrsDocx({ extraBody: EXTRA }))
    const forward = await migrate(seeded.token, projectId, templateId)

    // Hai CR sau lần đổi mẫu: thêm tác nhân (mục 2.1), rồi use case trỏ tới tác nhân đó (mục 2.2.2)
    spineRepository.clearReadCache()
    let head = (await spineRepository.get(projectId))!
    const actor = { ...structuredClone(head.actors[0]), name: "Auditor" } as Record<string, unknown>
    delete actor.id
    const first = await applyTransaction(projectId, { base_version: head.spine_version, ops: [{ op: "add", path: "actors[]", value: actor }], by: "CR-930", reason: "CR-930", step_id: null })
    const newActor = first.spine.actors.find((a) => a.name === "Auditor")!
    const uc = { ...structuredClone(head.use_cases[0]), name: "Audit trail", actor_ids: [newActor.id], includes: [], extends: [], function_ids: [] } as Record<string, unknown>
    delete uc.id
    head = (await spineRepository.get(projectId))!
    await applyTransaction(projectId, { base_version: head.spine_version, ops: [{ op: "add", path: "use_cases[]", value: uc }], by: "CR-931", reason: "CR-931", step_id: null })
    spineRepository.clearReadCache()

    const reverse = await request(app).post(url(projectId)).set(H(seeded.token)).send({ template_id: String(before.template_id), version: before.version })
    expect(reverse.status, JSON.stringify(reverse.body.error)).toBe(201)
    const rid = reverse.body.data.id as string
    await request(app).post(url(projectId, rid, "/confirm-mapping")).set(H(seeded.token))
    const dto = (await request(app).get(url(projectId, rid)).set(H(seeded.token))).body.data as MigrationDto
    const actors = dto.groups.edited_since.find((e) => e.old_key === "fixed:2.1")
    const useCases = dto.groups.edited_since.find((e) => e.old_key === "fixed:2.2.2")
    expect(actors && useCases, JSON.stringify(dto.groups.edited_since.map((e) => e.old_key))).toBeTruthy()

    // Hoàn tác mục tác nhân nhưng giữ use case ⇒ use case trỏ tới tác nhân đã mất
    const patch = (decisions: { id: string; choice: string }[]) => request(app).patch(url(projectId, rid, "/decisions")).set(H(seeded.token)).send({ decisions })
    expect((await patch([{ id: actors!.id, choice: "discard" }, { id: useCases!.id, choice: "keep" }])).status).toBe(200)
    await decide(seeded.token, projectId, rid)
    const broken = (await request(app).get(url(projectId, rid)).set(H(seeded.token))).body.data as MigrationDto
    expect(broken.broken_links.length).toBeGreaterThan(0)
    expect(broken.broken_links[0]).toMatchObject({ rule: expect.any(String), message: expect.any(String) })
    expect((await request(app).post(url(projectId, rid, "/ready")).set(H(seeded.token))).status).toBe(200)
    const blocked = await request(app).post(url(projectId, rid, "/apply")).set(H(seeded.token))
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe("TEMPLATE_MIGRATION_LINKS_BROKEN")
    expect(blocked.body.meta.violations.length).toBeGreaterThan(0)
    expect((await TemplateMigration.findById(rid).lean())!.state).toBe("ready")
    spineRepository.clearReadCache()
    expect((await spineRepository.get(projectId))!.use_cases.some((u) => u.name === "Audit trail")).toBe(true)

    // Giữ cả hai ⇒ hết báo, áp dụng được (quay về ready → decisions để đổi quyết định)
    await TemplateMigration.updateOne({ _id: rid }, { $set: { state: "decisions", open: true } })
    expect((await patch([{ id: actors!.id, choice: "keep" }])).status).toBe(200)
    expect(((await request(app).get(url(projectId, rid)).set(H(seeded.token))).body.data as MigrationDto).broken_links).toEqual([])
    expect((await request(app).post(url(projectId, rid, "/ready")).set(H(seeded.token))).status).toBe(200)
    const ok = await request(app).post(url(projectId, rid, "/apply")).set(H(seeded.token))
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    void forward
  })
})

describe("tải version cũ sau dịch (R8)", () => {
  it("version 0.1 tải lại sau khi đổi mẫu VI có dịch Spine: chữ + nhãn giữ nguyên (tiếng Anh)", async () => {
    const { seeded, projectId, c } = await importedProject()
    const textsOf = async (): Promise<string[]> => {
      const res = await c.get("/versions/0.1/download").buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = []
        r.on("data", (d: Buffer) => chunks.push(d))
        r.on("end", () => cb(null, Buffer.concat(chunks)))
      })
      expect(res.status).toBe(200)
      return (await readBlocks(await DocxPackage.load(res.body as Buffer))).map((b) => b.text)
    }
    const before = await textsOf()
    expect(before.some((t) => /Record of Changes/i.test(t))).toBe(true)
    const templateId = await publishTemplate(seeded.token, seeded.orgId, await makeSrsDocx({ extraBody: VI_BODY }))
    const id = await migrate(seeded.token, projectId, templateId)
    expect((await TemplateMigration.findById(id).lean())!.translated).toBe(true)
    const after = await textsOf()
    expect(after).toEqual(before)
    expect(after.some((t) => /Record of Changes/i.test(t))).toBe(true)
    expect(after.join("\n")).not.toMatch(/\[vi\]/)
  })
})

describe("dự án chuyển từ FPT (R9)", () => {
  it("mẫu khác ngôn ngữ ⇒ chỉ đổi ngôn ngữ tài liệu: không dịch Spine, không credit, không đặt nền nguyên văn", async () => {
    const { seeded, projectId } = await importedProject()
    await Project.updateOne({ _id: projectId }, { $set: { converted_from: "fpt" } })
    const visionBefore = (await spineRepository.get(projectId))!.project.vision
    const templateId = await publishTemplate(seeded.token, seeded.orgId, await makeSrsDocx({ extraBody: VI_BODY }))
    const startBalance = await balanceOf(seeded.orgId)
    const ready = await startReady(seeded.token, projectId, { template_id: templateId, version: 1 })
    expect(ready.language).toMatchObject({ source: "en", target: "vi", needs_translation: false, switches_document_language: true })
    expect(ready.credit_estimate.total).toBe(0)

    const applied = await request(app).post(url(projectId, ready.id, "/apply")).set(H(seeded.token))
    expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
    const m = (await TemplateMigration.findById(ready.id).lean())!
    expect(m).toMatchObject({ translated: false, language_switch_only: true })
    expect(m.translated_units).toEqual([])
    expect(await balanceOf(seeded.orgId)).toBe(startBalance)
    spineRepository.clearReadCache()
    expect((await spineRepository.get(projectId))!.project.vision).toBe(visionBefore)
    expect((await Project.findById(projectId).lean())!.documentLanguage).toBe("vi")
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    expect(profile.language).toBe("vi")
    expect(profile.migrated_base_at ?? null).toBeNull()
    // Không có lượt dịch nào đi qua provider
    expect(await Change.countDocuments({ projectId, txn: `${TEMPLATE_MIGRATION_TXN_PREFIX}${ready.id}`, path: /^project\./ })).toBe(0)
  })
})

describe("mục khung thừa (R10)", () => {
  /** Mẫu rút gọn: không có mục 2.2.x (use case), 3.x, 4.x — các mục khung đó của dự án không còn chỗ ở mẫu. */
  const SHORT_STYLES =
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="u1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="u2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style>'
  const shortTemplate = () =>
    makeDocx({ styles: SHORT_STYLES, body: styled("u1", "1 Product Overview") + p("[Purpose.]") + styled("u1", "2 User Requirements") + styled("u2", "2.1 Actors") + p("[Actors.]") })

  it("không có lựa chọn xoá dữ liệu; drop_from_print giữ dữ liệu trong Spine và không bắn template_section_absent; hoàn tác đưa mục về", async () => {
    const { seeded, projectId } = await importedProject()
    const templateId = await publishTemplate(seeded.token, seeded.orgId, await shortTemplate())
    const started = await request(app).post(url(projectId)).set(H(seeded.token)).send({ template_id: templateId, version: 1 })
    expect(started.status, JSON.stringify(started.body.error)).toBe(201)
    const id = started.body.data.id as string
    await request(app).post(url(projectId, id, "/confirm-mapping")).set(H(seeded.token))
    const dto = (await request(app).get(url(projectId, id)).set(H(seeded.token))).body.data as MigrationDto
    const extra = dto.groups.extra.find((e) => e.old_key === "fixed:2.2.2")!
    expect(extra, JSON.stringify(dto.groups.extra.map((e) => e.old_key))).toBeTruthy()
    expect(extra.choices).toContain("drop_from_print")
    expect(extra.choices).not.toContain("delete")
    const patch = (choice: string) => request(app).patch(url(projectId, id, "/decisions")).set(H(seeded.token)).send({ decisions: [{ id: extra.id, choice }] })
    expect((await patch("delete")).status).toBe(400)
    expect((await patch("drop_from_print")).status).toBe(200)
    await decide(seeded.token, projectId, id)
    expect((await request(app).post(url(projectId, id, "/ready")).set(H(seeded.token))).status).toBe(200)
    const useCasesBefore = (await spineRepository.get(projectId))!.use_cases.length
    expect(useCasesBefore).toBeGreaterThan(0)
    const applied = await request(app).post(url(projectId, id, "/apply")).set(H(seeded.token))
    expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)

    spineRepository.clearReadCache()
    const spine = (await spineRepository.get(projectId))!
    expect(spine.use_cases.length).toBe(useCasesBefore)
    expect(spine.flags.some((f) => f.rule_id === "template_section_absent" && f.section_id === "fixed:2.2.2" && f.resolved_at === null)).toBe(false)
    expect((await TemplateProfile.findOne({ projectId }).lean())!.layout.some((l) => l.section_id === "fixed:2.2.2")).toBe(false)
    expect((await request(app).post(url(projectId, id, "/revert")).set(H(seeded.token))).status).toBe(200)
    expect((await TemplateProfile.findOne({ projectId }).lean())!.layout.some((l) => l.section_id === "fixed:2.2.2")).toBe(true)
  })
})

describe("AI cho lựa chọn của BA (R11)", () => {
  const choose: Choose = (_id, choices, aiChoices) => aiChoices.find((c) => c.startsWith("move_to:")) ?? choices.find((c) => c === "keep_custom")

  it("move_to vào mục có cấu trúc: AI sinh op qua CR template_migration, mục riêng cũ bị xoá, credit trừ đúng giá một lượt", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await baselinedProject(lead, await makeSrsDocx({ extraBody: LEGACY }))
    const templateId = await publishTemplate(lead.token, lead.orgId, await makeSrsDocx({ extraBody: ASSUMPTIONS }))
    const started = await request(app).post(url(projectId)).set(H(lead.token)).send({ template_id: templateId, version: 1 })
    const id = started.body.data.id as string
    await request(app).post(url(projectId, id, "/confirm-mapping")).set(H(lead.token))
    const dto = await decide(lead.token, projectId, id, choose)
    const legacy = dto.groups.extra.find((e) => /Legacy/.test(e.heading_text))!
    expect(legacy.ai_choices.length, JSON.stringify(legacy)).toBeGreaterThan(0)
    expect(dto.decisions.find((d) => d.id === legacy.id)!.choice).toMatch(/^move_to:/)
    expect(dto.credit_estimate.structural_moves.count).toBe(1)
    const ready = await request(app).post(url(projectId, id, "/ready")).set(H(lead.token))
    expect(ready.status, JSON.stringify(ready.body.error)).toBe(200)

    const before = await balanceOf(lead.orgId)
    const applied = await request(app).post(url(projectId, id, "/apply")).set(H(lead.token))
    expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
    const charged = before - (await balanceOf(lead.orgId))
    expect(charged).toBeGreaterThanOrEqual(1)
    expect(charged).toBeLessThanOrEqual(ready.body.data.credit_estimate.structural_moves.credits)
    const m = (await TemplateMigration.findById(id).lean())!
    expect(m.resolved_items).toHaveLength(1)
    spineRepository.clearReadCache()
    const spine = (await spineRepository.get(projectId))!
    expect(spine.other_requirements.some((o) => /legacy gateway/i.test(o.statement))).toBe(true)
    expect(spine.custom_sections.some((cs) => /Legacy/.test(cs.heading))).toBe(false)
    // Op đi qua đường CR template_migration
    expect(await Change.countDocuments({ projectId, txn: `${TEMPLATE_MIGRATION_TXN_PREFIX}${id}`, path: /other_requirements/ })).toBeGreaterThan(0)
  })

  it("AI không chuyển được ⇒ giữ thành mục riêng, có cảnh báo, không mất chữ", async () => {
    ai.mode = "empty"
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await baselinedProject(lead, await makeSrsDocx({ extraBody: LEGACY }))
    const templateId = await publishTemplate(lead.token, lead.orgId, await makeSrsDocx({ extraBody: ASSUMPTIONS }))
    const ready = await startReady(lead.token, projectId, { template_id: templateId, version: 1 }, choose)
    const applied = await request(app).post(url(projectId, ready.id, "/apply")).set(H(lead.token))
    expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
    spineRepository.clearReadCache()
    const spine = (await spineRepository.get(projectId))!
    expect(spine.custom_sections.some((cs) => /Legacy/.test(cs.heading))).toBe(true)
    expect(spine.other_requirements.some((o) => /legacy gateway/i.test(o.statement))).toBe(false)
  })
})

describe("sửa mapping file mẫu tải lên (R12)", () => {
  it("Analyst sửa heading → mục khi mapping_review; ghép + phân nhóm lại; mẫu org khoá; id sai 400", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const analyst = await User.create({ email: `analyst-map-${Date.now()}@flintflow.test`, password: "test-password-123", emailVerified: true })
    await Membership.create({ userId: analyst._id, organizationId: lead.orgId, role: "analyst" })
    const token = await authAs({ _id: analyst._id, email: analyst.email, orgId: lead.orgId })
    const projectId = await baselinedProject(lead, await makeSrsDocx())
    const started = await request(app).post(url(projectId)).set(H(token)).attach("file", await makeSrsDocx({ extraBody: EXTRA }), "Mau.docx")
    expect(started.status, JSON.stringify(started.body.error)).toBe(201)
    const id = started.body.data.id as string
    const dto = started.body.data as MigrationDto
    const target = dto.to.headings.find((h) => /Operating Environment/.test(h.heading_text))!
    expect(dto.groups.missing.find((m) => m.new_key === target.key)!.section_id).not.toBe("unmapped")

    const edit = (body: object, tk = token) => request(app).patch(url(projectId, id, "/mapping")).set(H(tk)).send(body)
    expect((await edit({ edits: [{ key: "n9999", section_id: "unmapped" }] })).status).toBe(400)
    expect((await edit({ edits: [{ key: target.key, section_id: "fixed:no-such" }] })).status).toBe(400)
    expect((await edit({ edits: [] })).status).toBe(400)
    const edited = await edit({ edits: [{ key: target.key, section_id: "unmapped" }] })
    expect(edited.status, JSON.stringify(edited.body.error)).toBe(200)
    const after = edited.body.data as MigrationDto
    expect(after.to.headings.find((h) => h.key === target.key)!.section_id).toBe("unmapped")
    expect(after.groups.missing.find((m) => m.new_key === target.key)!.section_id).toBe("unmapped")
    const stored = (await OrgTemplateVersion.findOne({ template_id: after.to.template_id, version: after.to.version }).lean())!
    expect(stored.headings[Number(target.key.slice(1))].section_id).toBe("unmapped")

    // Sau khi qua bước rà mapping thì không sửa nữa
    await request(app).post(url(projectId, id, "/confirm-mapping")).set(H(token))
    expect((await edit({ edits: [{ key: target.key, section_id: "unmapped" }] })).status).toBe(409)

    // Mẫu org (Lead đã rà lúc đăng) ⇒ khoá
    await request(app).post(url(projectId, id, "/cancel")).set(H(token))
    const orgTemplate = await publishTemplate(lead.token, lead.orgId, await makeSrsDocx({ extraBody: EXTRA + p("org") }))
    const org = await request(app).post(url(projectId)).set(H(token)).send({ template_id: orgTemplate, version: 1 })
    const locked = await request(app).patch(url(projectId, org.body.data.id, "/mapping")).set(H(token)).send({ edits: [{ key: "n0", section_id: "unmapped" }] })
    expect(locked.status).toBe(409)
    expect(locked.body.error.code).toBe("TEMPLATE_MIGRATION_MAPPING_LOCKED")
  })
})

describe("mẫu trước của dự án từng theo mẫu tự do (R13)", () => {
  it("áp dụng đăng ký bản riêng cho file nền cũ; previous_template trả về; start nhận nó làm đích đổi ngược", async () => {
    const { seeded, projectId } = await importedProject()
    await Project.updateOne({ _id: projectId }, { $unset: { template_ref: 1 } })
    const templateId = await publishTemplate(seeded.token, seeded.orgId, await makeSrsDocx({ extraBody: EXTRA }))
    const id = await migrate(seeded.token, projectId, templateId)
    const list = (await request(app).get(url(projectId)).set(H(seeded.token))).body.data as { id: string; previous_template: { template_id: string; version: number; visibility: string; name: string } | null }[]
    const previous = list.find((m) => m.id === id)!.previous_template!
    expect(previous).toMatchObject({ visibility: "project", version: 1 })
    expect(previous.name).toBeTruthy()
    const version = (await OrgTemplateVersion.findOne({ template_id: previous.template_id, version: previous.version }).lean())!
    expect(version).toMatchObject({ visibility: "project", status: "published" })
    expect(String(version.project_id)).toBe(projectId)

    const reverse = await request(app).post(url(projectId)).set(H(seeded.token)).send({ template_id: previous.template_id, version: previous.version })
    expect(reverse.status, JSON.stringify(reverse.body.error)).toBe(201)
    expect(reverse.body.data).toMatchObject({ direction: "reverse", reverse_of: id })
  })
})

describe("review cuối (R14–R19)", () => {
  it("R14. chỉ hoàn tác được lần đổi mẫu mới nhất: A → B rồi hoàn tác A ⇒ 409 not_latest, profile / template_ref của B nguyên vẹn", async () => {
    const { seeded, projectId } = await importedProject()
    const first = await publishTemplate(seeded.token, seeded.orgId, await makeSrsDocx({ extraBody: EXTRA }))
    const second = await publishTemplate(seeded.token, seeded.orgId, await makeSrsDocx({ extraBody: EXTRA + p("second template") }))
    const a = await migrate(seeded.token, projectId, first)
    const b = await migrate(seeded.token, projectId, second)
    const res = await request(app).post(url(projectId, a, "/revert")).set(H(seeded.token))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("TEMPLATE_MIGRATION_REVERT_BLOCKED")
    expect(res.body.meta).toMatchObject({ reason: "not_latest" })
    expect((await TemplateMigration.findById(a).lean())!.state).toBe("applied")
    expect(String((await Project.findById(projectId).lean())!.template_ref!.template_id)).toBe(second)
    expect((await request(app).post(url(projectId, b, "/revert")).set(H(seeded.token))).status).toBe(200)
  })

  it("R15. apply_failed vẫn chặn CR / phát hành; huỷ từ apply_failed = khôi phục từ snapshot, mở lại chỗ của dự án", async () => {
    const { seeded, projectId, c } = await importedProject()
    const templateId = await publishTemplate(seeded.token, seeded.orgId, await makeSrsDocx({ extraBody: EXTRA }))
    const ready = await startReady(seeded.token, projectId, { template_id: templateId, version: 1 })
    await expect(applyMigration(ctxOf(seeded, projectId), ready.id, { afterStep: crash("spine"), recoverOnError: false })).rejects.toThrow()
    await TemplateMigration.updateOne({ _id: ready.id }, { $set: { new_profile: null } })
    for (let i = 0; i < 5; i++) await expect(recoverApplyingMigration(ready.id, { force: true })).rejects.toThrow()
    expect(await recoverApplyingMigration(ready.id, { force: true })).toBe("failed")

    const { cr } = await crToReady(c)
    const blocked = await c.post(`${cr}/submit`)
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe("TEMPLATE_MIGRATION_APPLYING")
    expect(blocked.body.meta).toMatchObject({ state: "apply_failed" })

    const cancelled = await request(app).post(url(projectId, ready.id, "/cancel")).set(H(seeded.token))
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200)
    expect(cancelled.body.data.state).toBe("failed")
    expect((await TemplateMigration.findById(ready.id).lean())!.open).toBe(false)
    expect((await c.post(`${cr}/submit`)).status).toBe(200)
  })

  it("R16. mọi đường ghi bản nháp đều bị rào: waive / keep cờ, gói duyệt, chuyển comment thành CR, chuyển từ FPT", async () => {
    const { seeded, projectId } = await importedProject()
    const flags = await import("../../../src/modules/spine/flags.service.js")
    const pkg = await import("../../../src/modules/doc-version/review-package.service.js")
    const comments = await import("../../../src/modules/comment/comment.service.js")
    const convert = await import("../../../src/modules/import/convert-from-fpt.service.js")
    await TemplateMigration.collection.insertOne({ projectId: new mongoose.Types.ObjectId(projectId), state: "applying", open: true })
    const expectBlocked = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ statusCode: 409, code: "TEMPLATE_MIGRATION_APPLYING" })
    const actor = { projectId, projectName: "x", orgId: seeded.orgId, userId: seeded.userId, role: "lead" } as never
    await expectBlocked(flags.waive(projectId, "FL001", "lý do", seeded.userId))
    await expectBlocked(flags.keep(projectId, "FL001", "lý do", seeded.userId))
    await expectBlocked(pkg.submitPackage(actor, 1))
    await expectBlocked(pkg.requestChanges(actor, { base_version: 1, reason: "x" }))
    await expectBlocked(comments.assertConvertible(projectId, "C001"))
    await expectBlocked(convert.convertFromFpt(projectId, seeded.userId))
  })

  it("R17. kết quả AI đã lưu bị xoá khi BA đổi quyết định / cặp (không dùng lại op sai đích)", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await baselinedProject(lead, await makeSrsDocx({ extraBody: LEGACY }))
    const templateId = await publishTemplate(lead.token, lead.orgId, await makeSrsDocx({ extraBody: ASSUMPTIONS }))
    const started = await request(app).post(url(projectId)).set(H(lead.token)).send({ template_id: templateId, version: 1 })
    const id = started.body.data.id as string
    const stored = [{ id: "e:x", original_choice: "move_to:n1", source_hash: "h", choice: "move_to:n1", ops: [], removed_custom_ids: [], notes: null }]
    const seedStored = () => TemplateMigration.updateOne({ _id: id }, { $set: { resolved_items: stored } })
    const left = async () => (await TemplateMigration.findById(id).lean())!.resolved_items.length

    await seedStored()
    const pair = (started.body.data as MigrationDto).pairing.pairs[0]
    expect((await request(app).patch(url(projectId, id, "/pairs")).set(H(lead.token)).send({ pairs: [{ old_key: pair.old_key, new_key: pair.new_key }] })).status).toBe(200)
    expect(await left()).toBe(0)

    await request(app).post(url(projectId, id, "/confirm-mapping")).set(H(lead.token))
    await seedStored()
    const dto = (await request(app).get(url(projectId, id)).set(H(lead.token))).body.data as MigrationDto
    const item = dto.groups.extra[0]
    expect((await request(app).patch(url(projectId, id, "/decisions")).set(H(lead.token)).send({ decisions: [{ id: item.id, choice: "keep_custom" }] })).status).toBe(200)
    expect(await left()).toBe(0)
  })

  it("R18. Spine đổi trong khe giữa kiểm lại và chiếm áp dụng ⇒ 409 stale, trả về bước phân nhóm, chưa ghi gì", async () => {
    const { seeded, projectId } = await importedProject()
    const templateId = await publishTemplate(seeded.token, seeded.orgId, await makeSrsDocx({ extraBody: EXTRA }))
    const ready = await startReady(seeded.token, projectId, { template_id: templateId, version: 1 })
    const bump = async (step: string) => {
      if (step !== "claimed") return
      spineRepository.clearReadCache()
      const head = (await spineRepository.get(projectId))!
      await applyTransaction(projectId, { base_version: head.spine_version, ops: [{ op: "set", path: "project.vision", value: "Sửa trong khe" }], by: "CR-940", reason: "CR-940", step_id: null })
      spineRepository.clearReadCache()
    }
    await expect(applyMigration(ctxOf(seeded, projectId), ready.id, { afterStep: bump })).rejects.toMatchObject({ statusCode: 409, code: "TEMPLATE_MIGRATION_STALE" })
    const m = (await TemplateMigration.findById(ready.id).lean())!
    expect(m).toMatchObject({ state: "decisions", new_base_file_ref: null, prepared_spine_version: null })
    expect(await Change.countDocuments({ projectId, txn: { $regex: `^${TEMPLATE_MIGRATION_TXN_PREFIX}` } })).toBe(0)
  })

  it("R19. mục khung thiếu không đo được (fixed:4.2.4) chỉ coi là đã viết khi mảng nuôi nó có thêm dữ liệu sau đổi mẫu", async () => {
    const { projectId } = await importedProject()
    const { ruleProfileOf } = await import("../../../src/modules/import/mode1-guard.js")
    await Project.updateOne({ _id: projectId }, { $set: { template_intent: "fixed" } })
    // Mốc lúc đổi mẫu = Spine hiện tại (mảng nfrs đã có sẵn dữ liệu): chỉ phần thêm SAU mốc mới tính là đã viết
    const anchorSpine = (await spineRepository.get(projectId))!
    const inserted = await TemplateMigration.collection.insertOne({ projectId: new mongoose.Types.ObjectId(projectId), state: "applied", anchor_spine: { nfrs: anchorSpine.nfrs, glossary: anchorSpine.glossary, custom_sections: anchorSpine.custom_sections } })
    await TemplateProfile.updateOne({ projectId }, { $set: { migrated_base_migration_id: inserted.insertedId, migration_missing_sections: ["fixed:4.2.4"], migrated_base_at: new Date(), layout: [{ order: 0, heading_text: "4.2.4 Security", level: 3, section_id: "fixed:4.2.4" }] } })
    const filled = async () => [...((await ruleProfileOf(projectId))?.templateFilled ?? [])]
    expect(await filled()).not.toContain("fixed:4.2.4")
    spineRepository.clearReadCache()
    const head = (await spineRepository.get(projectId))!
    await applyTransaction(projectId, { base_version: head.spine_version, ops: [{ op: "add", path: "nfrs[]", value: { category: "other", kind: "descriptive", statement: "Data is encrypted at rest.", priority: "must" } }], by: "CR-941", reason: "CR-941", step_id: null })
    spineRepository.clearReadCache()
    expect(await filled()).toContain("fixed:4.2.4")
  })
})
