/**
 * Phát hành / in sau đổi mẫu:
 *  A. Lần ghi CR đầu tiên sau đổi mẫu: bản đánh dấu (Track Changes) chỉ hiện thay đổi nội dung — heading mẫu mới không bị đánh đỏ.
 *  B. Đổi mẫu có dịch ⇒ lần ghi CR sau đó không tạo bản đánh dấu.
 *  C. Version đã phát hành giữ nguyên sau đổi mẫu (bản ghi + file + binding); cờ "bỏ chữ của khung mẫu" của version lấy từ binding / ảnh chụp
 *     của lần đổi mẫu đầu, không từ profile hiện tại.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import request from "supertest"
import app from "../../../src/app.js"
import { crToReview, importedProject, resetCrMock } from "../../helpers/mode1-cr-p4.js"
import { mockOverrides } from "../../helpers/mock-llm.js"
import { mockTranslateItems } from "../../../src/shared/ai/providers/mock.provider.js"
import { p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { DocxPackage, readBlocks } from "../../../src/modules/docx-ooxml/index.js"
import { wAll } from "../../../src/modules/docx-ooxml/xml.js"
import { docFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { stripTemplateTextLegacy, stripTemplateTextNow } from "../../../src/modules/render/strip-template-text.js"
import { TemplateMigration } from "../../../src/modules/template-migration/template-migration.model.js"

const H = (token: string) => ({ Authorization: `Bearer ${token}` })
const EXTRA = styled("u1", "6 Operating Environment") + p("[Describe the operating environment.]")
const VI_SENTENCE = "Hệ thống cho phép người dùng đăng nhập và quản lý khoá học trực tuyến một cách thuận tiện."
const VI_BODY = styled("u1", "6 Môi trường vận hành") + Array.from({ length: 30 }, () => p(VI_SENTENCE)).join("")

beforeEach(() => {
  resetCrMock()
  const route = mockOverrides.next!
  mockOverrides.next = (prompt) => (prompt.includes("You translate a batch") ? JSON.stringify({ items: mockTranslateItems(prompt) }) : route(prompt))
})

const url = (projectId: string, id = "", suffix = "") => `/api/v1/projects/${projectId}/template-migrations${id ? `/${id}` : ""}${suffix}`

const publishTemplate = async (token: string, orgId: string, file: Buffer): Promise<string> => {
  const base = `/api/v1/orgs/${orgId}/templates`
  const draft = await request(app).post(base).set(H(token)).attach("file", file, "Mau.docx").field("name", "Mẫu mới")
  expect(draft.status, JSON.stringify(draft.body.error)).toBe(201)
  const id = draft.body.data.template_id as string
  expect((await request(app).post(`${base}/${id}/versions/${draft.body.data.version}/publish`).set(H(token)).send({})).status).toBe(200)
  return id
}

const migrate = async (token: string, projectId: string, templateId: string): Promise<string> => {
  const started = await request(app).post(url(projectId)).set(H(token)).send({ template_id: templateId, version: 1 })
  expect(started.status, JSON.stringify(started.body.error)).toBe(201)
  const id = started.body.data.id as string
  await request(app).post(url(projectId, id, "/confirm-mapping")).set(H(token))
  const dto = (await request(app).get(url(projectId, id)).set(H(token))).body.data
  const items = [...dto.groups.extra, ...dto.groups.conflict] as { id: string; choices: string[]; ai_choices: string[] }[]
  const decisions = (dto.undecided as string[]).map((d) => {
    const item = items.find((i) => i.id === d)!
    const safe = item.choices.filter((c) => !item.ai_choices.includes(c) && !c.startsWith("move_to:"))
    return { id: d, choice: safe[0] }
  })
  if (decisions.length) await request(app).patch(url(projectId, id, "/decisions")).set(H(token)).send({ decisions })
  expect((await request(app).post(url(projectId, id, "/ready")).set(H(token))).status).toBe(200)
  const applied = await request(app).post(url(projectId, id, "/apply")).set(H(token))
  expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
  return id
}

const markedText = async (ref: string): Promise<string[]> => {
  const pkg = await DocxPackage.load(await docFileStore().load(ref))
  const doc = await pkg.requireXml("word/document.xml")
  return [...wAll(doc, "ins"), ...wAll(doc, "del")].map((m) => m.textContent ?? "")
}

describe("phát hành sau đổi mẫu", () => {
  it("A. CR đầu tiên sau đổi mẫu ⇒ bản đánh dấu chỉ hiện thay đổi nội dung, heading của mẫu mới không bị đánh dấu", async () => {
    const { seeded, projectId, c } = await importedProject()
    const templateId = await publishTemplate(seeded.token, seeded.orgId, await makeSrsDocx({ extraBody: EXTRA }))
    await migrate(seeded.token, projectId, templateId)

    const { crId } = await crToReview(c)
    const v = (await DocVersion.findOne({ projectId, cr_ids: crId }).lean())!
    expect(v.tracked_file_ref).toBeTruthy()
    const marks = await markedText(v.tracked_file_ref!)
    expect(marks.length).toBeGreaterThan(0)
    expect(marks.join("\n")).not.toContain("Operating Environment")
    expect(marks.join("\n")).not.toContain("Describe the operating environment")
    // Nội dung CR vẫn được đánh dấu
    expect(marks.join("\n")).toMatch(/second/)
  })

  it("B. đổi mẫu có dịch ⇒ CR sau đó không tạo bản đánh dấu", async () => {
    const { seeded, projectId, c } = await importedProject()
    const templateId = await publishTemplate(seeded.token, seeded.orgId, await makeSrsDocx({ extraBody: VI_BODY }))
    const id = await migrate(seeded.token, projectId, templateId)
    expect((await TemplateMigration.findById(id).lean())!.translated).toBe(true)
    const { crId } = await crToReview(c)
    const v = (await DocVersion.findOne({ projectId, cr_ids: crId }).lean())!
    expect(v.tracked_file_ref ?? null).toBeNull()
  })

  it("C. version đã phát hành nguyên vẹn sau đổi mẫu; cờ bỏ chữ khung mẫu lấy từ ảnh chụp của lần đổi mẫu đầu, không từ profile hiện tại", async () => {
    const { seeded, projectId } = await importedProject()
    const before = await DocVersion.find({ projectId }).lean()
    const bytesBefore = await Promise.all(before.map(async (v) => (await docFileStore().load(v.file_ref)).toString("base64")))
    const templateId = await publishTemplate(seeded.token, seeded.orgId, await makeSrsDocx({ extraBody: EXTRA }))
    const id = await migrate(seeded.token, projectId, templateId)

    const after = await DocVersion.find({ projectId }).lean()
    expect(after.map((v) => [v.version, v.file_ref, v.template_source ?? null])).toEqual(before.map((v) => [v.version, v.file_ref, v.template_source ?? null]))
    expect(await Promise.all(after.map(async (v) => (await docFileStore().load(v.file_ref)).toString("base64")))).toEqual(bytesBefore)

    // Dự án này từng là khung mẫu để điền (structure_preview.kind = template) ở profile trước lần đổi mẫu
    const migration = (await TemplateMigration.findById(id).lean())!
    const snapshotProfile = migration.snapshot!.profile as { structure_preview?: unknown } | null
    await TemplateMigration.updateOne({ _id: id }, { $set: { "snapshot.profile.structure_preview": { summary: { kind: "template" } } } })
    await Project.updateOne({ _id: projectId }, { $set: { template_intent: "fixed", start_kind: "existing" } })
    expect(snapshotProfile).toBeTruthy()
    // Profile hiện tại (sau đổi mẫu) không còn là khung mẫu: nếu đọc từ đây thì kết quả đổi
    await TemplateProfile.updateOne({ projectId }, { $set: { structure_preview: null } })
    // Binding cũ (chưa có cờ) ⇒ theo snapshot của lần đổi mẫu đầu: in lại đúng như lúc ghi version
    expect(await stripTemplateTextLegacy(projectId)).toBe(true)
    // Bản in HIỆN TẠI sau đổi mẫu giữ chữ hướng dẫn của mẫu đích (mục thiếu hiện trống kèm hướng dẫn)
    expect(await stripTemplateTextNow(projectId)).toBe(false)
    // Chưa từng đổi mẫu ⇒ đọc profile hiện tại như cũ
    await TemplateProfile.updateOne({ projectId }, { $set: { migrated_base_at: null, structure_preview: { summary: { kind: "template" } } } })
    expect(await stripTemplateTextNow(projectId)).toBe(true)
    expect(await stripTemplateTextLegacy(projectId)).toBe(true)
    await TemplateProfile.updateOne({ projectId }, { $set: { structure_preview: { summary: { kind: "written" } } } })
    expect(await stripTemplateTextNow(projectId)).toBe(false)
    void readBlocks
  })
})
