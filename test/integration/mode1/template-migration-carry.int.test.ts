/**
 * Đổi mẫu liên tiếp bản 1 → bản 2: mục của bản 1 để trống mà bản 2 ghép "khớp" vẫn giữ cờ đỏ chặn phát hành,
 * và câu cờ gọi mục bằng heading của mẫu hiện tại.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import request from "supertest"
import app from "../../../src/app.js"
import { seedFixture, type SeededFixture } from "../../setup.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, fakeMode1 } from "../../helpers/mode1.js"
import { fileOf } from "../../helpers/mode1-import-p4.js"
import { p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { acceptLatest, uploadImport } from "../../../src/modules/import/import.service.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { finalizeImport } from "../../../src/modules/import/finalize.service.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import type { MigrationDto } from "../../../src/modules/template-migration/template-migration.service.js"

vi.setConfig({ testTimeout: 120_000 })

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const H = (token: string) => ({ Authorization: `Bearer ${token}` })
const OPERATING = styled("u1", "6 Operating Environment") + p("[Describe the operating environment.]")
const V1 = OPERATING + styled("u1", "7 Document Conventions") + p("[Describe conventions.]")
const V2 = OPERATING + styled("u1", "8 Data Retention") + p("[Describe how long data is kept.]")

const baselined = async (seeded: SeededFixture): Promise<string> => {
  const projectId = await createMode1Project(seeded, "Lumen carry")
  const doc = await uploadImport(projectId, seeded.userId, fileOf(await makeSrsDocx()))
  await acceptLatest(doc, true)
  await runExtraction(projectId, seeded.userId, String(doc._id))
  const before = (await spineRepository.get(projectId))!
  await finalizeImport(projectId, seeded.userId, { import_id: String(doc._id), base_version: before.spine_version })
  return projectId
}

const publish = async (token: string, orgId: string, file: Buffer, templateId?: string): Promise<string> => {
  const base = `/api/v1/orgs/${orgId}/templates`
  const req = request(app).post(templateId ? `${base}/${templateId}/versions` : base).set(H(token)).attach("file", file, "Mau.docx")
  const draft = await (templateId ? req : req.field("name", "Mẫu ngân hàng"))
  expect(draft.status, JSON.stringify(draft.body.error)).toBe(201)
  const id = draft.body.data.template_id as string
  expect((await request(app).post(`${base}/${id}/versions/${draft.body.data.version}/publish`).set(H(token)).send({})).status).toBe(200)
  return id
}

const migrate = async (token: string, projectId: string, body: object): Promise<MigrationDto> => {
  const url = `/api/v1/projects/${projectId}/template-migrations`
  const started = await request(app).post(url).set(H(token)).send(body)
  expect(started.status, JSON.stringify(started.body.error)).toBe(201)
  const id = started.body.data.id as string
  await request(app).post(`${url}/${id}/confirm-mapping`).set(H(token))
  const dto = (await request(app).get(`${url}/${id}`).set(H(token))).body.data as MigrationDto
  const items = [...dto.groups.extra, ...dto.groups.conflict]
  const decisions = dto.undecided.map((d) => {
    const item = items.find((i) => i.id === d)!
    const safe = item.choices.filter((c) => !item.ai_choices.includes(c) && !c.startsWith("move_to:"))
    return { id: d, choice: safe.find((c) => c === "keep_custom") ?? safe[0] }
  })
  if (decisions.length) expect((await request(app).patch(`${url}/${id}/decisions`).set(H(token)).send({ decisions })).status).toBe(200)
  expect((await request(app).post(`${url}/${id}/ready`).set(H(token))).status).toBe(200)
  const applied = await request(app).post(`${url}/${id}/apply`).set(H(token))
  expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
  return applied.body.data as MigrationDto
}

const openMissingFlags = async (projectId: string) => {
  spineRepository.clearReadCache()
  const spine = (await spineRepository.get(projectId))!
  return spine.flags.filter((f) => f.rule_id === "template_section_migration_missing" && !f.resolved_at)
}

describe("đổi mẫu liên tiếp — mục thiếu", () => {
  it("mục trống của bản 1 vẫn bị chặn sau khi sang bản 2; câu cờ dùng heading của mẫu hiện tại", async () => {
    const lead = await seedFixture("minimal", { balance: 1000 })
    const projectId = await baselined(lead)
    const templateId = await publish(lead.token, lead.orgId, await makeSrsDocx({ extraBody: V1 }))
    await migrate(lead.token, projectId, { template_id: templateId, version: 1 })

    const afterV1 = await openMissingFlags(projectId)
    const operating = afterV1.find((f) => /Operating Environment/.test(f.message))
    expect(operating, JSON.stringify(afterV1.map((f) => f.message))).toBeTruthy()
    expect(afterV1.map((f) => f.message).join("\n")).not.toMatch(/Mục mục|một mục của tài liệu/)

    await publish(lead.token, lead.orgId, await makeSrsDocx({ extraBody: V2 }), templateId)
    await migrate(lead.token, projectId, { template_id: templateId, version: 2 })

    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    expect(profile.migration_missing_sections).toContain(operating!.section_id)
    const afterV2 = await openMissingFlags(projectId)
    const messages = afterV2.map((f) => f.message).join("\n")
    expect(afterV2.some((f) => f.section_id === operating!.section_id), messages).toBe(true)
    expect(messages).toContain('"6 Operating Environment"')
    expect(messages).toContain('"8 Data Retention"')
    expect(messages).not.toMatch(/Other Requirements|Mục mục|một mục của tài liệu/)
  })
})
