/**
 * FLF-466 phase 02 + 04: thay đổi hệ thống (đổi mẫu) thành bản nháp số phụ, hiện trong Gói duyệt, phát hành được; không CR giả; không
 * trùng số version khi ghi đồng thời; gói đã gửi không đổi được; tác giả Track Changes bản nháp CR = `CR-012 (Tên)`; Record of Changes
 * của file phát hành in Version đúng và không có dòng cho đổi mẫu.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import request from "supertest"
import app from "../../../src/app.js"
import { reviewPackageSchema, releaseResponseSchema, versionsResponseSchema } from "../../../src/modules/doc-version/doc-version.dto.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { docFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { recordSystemChange } from "../../../src/modules/doc-version/system-change.service.js"
import { ChangeRequest } from "../../../src/modules/change-request/change-request.model.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { applyTransaction } from "../../../src/modules/spine/op-engine.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project } from "../../helpers/mode1.js"
import { seedFixture } from "../../setup.js"
import { documentXml, importedProject, releaseNow, routeReplaceCr, writeCr, type Mode1Api } from "../../helpers/mode1-release-p4.js"

const H = (token: string) => ({ Authorization: `Bearer ${token}` })
const EXTRA = styled("u1", "6 Operating Environment") + p("[Describe the operating environment.]")
const url = (projectId: string, id = "", suffix = "") => `/api/v1/projects/${projectId}/template-migrations${id ? `/${id}` : ""}${suffix}`

beforeEach(() => {
  resetMockLlm()
  routeReplaceCr("2 seconds", "1 second")
})

const publishTemplate = async (token: string, orgId: string, file: Buffer): Promise<string> => {
  const base = `/api/v1/orgs/${orgId}/templates`
  const draft = await request(app).post(base).set(H(token)).attach("file", file, "Mau.docx").field("name", "Mẫu mới")
  expect(draft.status, JSON.stringify(draft.body.error)).toBe(201)
  const id = draft.body.data.template_id as string
  expect((await request(app).post(`${base}/${id}/versions/${draft.body.data.version}/publish`).set(H(token)).send({})).status).toBe(200)
  return id
}

/** Đổi mẫu tới `applied` (chọn lựa chọn an toàn đầu tiên cho mọi mục cần quyết). */
const migrate = async (token: string, projectId: string, templateId: string): Promise<string> => {
  const started = await request(app).post(url(projectId)).set(H(token)).send({ template_id: templateId, version: 1 })
  expect(started.status, JSON.stringify(started.body.error)).toBe(201)
  const id = started.body.data.id as string
  await request(app).post(url(projectId, id, "/confirm-mapping")).set(H(token))
  const dto = (await request(app).get(url(projectId, id)).set(H(token))).body.data
  const items = [...dto.groups.extra, ...dto.groups.conflict] as { id: string; choices: string[]; ai_choices: string[] }[]
  const decisions = items.map((item) => ({ id: item.id, choice: item.choices.filter((c) => !item.ai_choices.includes(c) && !c.startsWith("move_to:"))[0] }))
  if (decisions.length) await request(app).patch(url(projectId, id, "/decisions")).set(H(token)).send({ decisions })
  expect((await request(app).post(url(projectId, id, "/ready")).set(H(token))).status).toBe(200)
  const applied = await request(app).post(url(projectId, id, "/apply")).set(H(token))
  expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
  return id
}

const pkg = async (c: Mode1Api) => {
  const res = await c.get("/review-package")
  expect(res.status, JSON.stringify(res.body.error)).toBe(200)
  return reviewPackageSchema.parse(res.body.data)
}

const authorsOf = async (ref: string): Promise<string[]> => {
  const xml = await documentXml(await docFileStore().load(ref))
  return [...new Set([...xml.matchAll(/w:author="([^"]+)"/g)].map((m) => m[1]))]
}

/** `withMissing`: mẫu đích có thêm mục "Operating Environment" mà dự án chưa có ⇒ mục thiếu = cờ đỏ chặn gửi / phát hành. */
const setup = async (withMissing = true) => {
  const { seeded, projectId, c } = await importedProject()
  // `withMissing = false` vẫn phải khác byte với file đã import (tránh trùng sha256 ⇒ 409 TEMPLATE_MIGRATION_SAME_TEMPLATE khi cùng giây ZIP)
  const templateId = await publishTemplate(seeded.token, seeded.orgId, await makeSrsDocx({ extraBody: withMissing ? EXTRA : p("[Template v2]") }))
  return { seeded, projectId, c, templateId }
}

describe("đổi mẫu = thay đổi hệ thống thành bản nháp", () => {
  it("đổi mẫu ⇒ một version system_change số phụ kế tiếp (0.2); không có CR giả; Gói hiện system_changes[]; CR sau đó ra 0.3 (không trùng số)", async () => {
    const { seeded, projectId, c, templateId } = await setup()
    const migrationId = await migrate(seeded.token, projectId, templateId)

    const versions = await DocVersion.find({ projectId }).sort({ version: 1 }).lean()
    expect(versions.map((v) => [v.version, v.kind])).toEqual([
      ["0.1", "imported"],
      ["0.2", "system_change"]
    ])
    expect(versions[1]).toMatchObject({ based_on: "0.1", cr_ids: [], baseline_ref: null, system_change: { type: "template_migration", ref: migrationId } })
    expect(versions[1].system_change?.summary).toMatch(/^Đổi mẫu sang /)
    // File in theo mẫu mới + luôn lưu snapshot
    expect(versions[1].spine_snapshot).toBeTruthy()
    expect(await ChangeRequest.countDocuments({ projectId })).toBe(0)

    // API versions trả kind + system_change
    const listed = versionsResponseSchema.parse((await c.get("/versions")).body.data)
    expect(listed[0]).toMatchObject({ version: "0.2", kind: "system_change", system_change: { type: "template_migration", ref: migrationId } })
    expect(listed[1]).toMatchObject({ version: "0.1", system_change: null })

    const only = await pkg(c)
    expect(only.change_requests).toEqual([])
    expect(only.system_changes).toHaveLength(1)
    expect(only.system_changes[0]).toMatchObject({ version: "0.2", type: "template_migration", ref: migrationId })
    expect(only.draft_label).toBe("Bản gốc 0.1 · 1 thay đổi chưa duyệt")

    // CR ghi ngay sau đổi mẫu: số kế tiếp, không trùng; ghi CR không sinh version thừa
    const written = await writeCr(c, "Nhanh hơn", "1 second instead of 2 seconds")
    expect(written).toMatchObject({ crId: "CR-001", version: "0.3" })
    expect((await DocVersion.countDocuments({ projectId }))).toBe(3)
    const both = await pkg(c)
    expect(both.change_requests.map((x) => x.cr_id)).toEqual(["CR-001"])
    expect(both.system_changes.map((s) => s.version)).toEqual(["0.2"])
    expect(both.draft_label).toBe("Bản gốc 0.1 · 2 thay đổi chưa duyệt")
  })

  it("gói chỉ có thay đổi hệ thống: gửi duyệt được (không PACKAGE_EMPTY), bản nháp khoá, Lead phát hành → 1.0 với cr_ids rỗng", async () => {
    const { seeded, projectId, c, templateId } = await setup(false)
    await migrate(seeded.token, projectId, templateId)
    const sent = await c.post("/review-package/submit", { base_version: await c.spineVersion() })
    expect(sent.status, JSON.stringify(sent.body.error)).toBe(200)
    expect((await pkg(c)).status).toBe("pending")

    // Bản nháp đang khoá: không bắt đầu đổi mẫu được
    const blocked = await request(app).post(url(projectId)).set(H(seeded.token)).send({ template_id: templateId, version: 1 })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe("DRAFT_LOCKED")

    const released = await releaseNow(c)
    expect(released.status, JSON.stringify(released.body.error)).toBe(201)
    const body = releaseResponseSchema.parse(released.body.data)
    expect(body.version).toMatchObject({ version: "1.0", kind: "release", based_on: "0.2", cr_ids: [] })
  })

  it("không có gì để gửi (chưa có CR lẫn thay đổi hệ thống) ⇒ PACKAGE_EMPTY", async () => {
    const { c } = await importedProject()
    const sent = await c.post("/review-package/submit", { base_version: await c.spineVersion() })
    expect(sent.status).toBe(409)
    expect(sent.body.error.code).toBe("PACKAGE_EMPTY")
  })

  it("gói đã gửi mà nội dung Spine đổi (đường lách khoá) ⇒ release 409 PACKAGE_CHANGED_AFTER_SUBMIT", async () => {
    const { seeded, projectId, c, templateId } = await setup(false)
    await migrate(seeded.token, projectId, templateId)
    expect((await c.post("/review-package/submit", { base_version: await c.spineVersion() })).status).toBe(200)

    const sneaky = (await spineRepository.get(projectId))!
    await applyTransaction(projectId, { base_version: sneaky.spine_version, by: "test", step_id: null, reason: "sửa lén", ops: [{ op: "set", path: "project.vision", value: "đổi sau khi gửi duyệt" }] })
    spineRepository.clearReadCache()
    const res = await releaseNow(c)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("PACKAGE_CHANGED_AFTER_SUBMIT")
    expect(await DocVersion.countDocuments({ projectId, kind: "release" })).toBe(0)
  })

  it("hai lượt ghi cùng lúc (CR / thay đổi hệ thống khác loại) không bao giờ trùng số version", async () => {
    const { seeded, projectId, c } = await setup()
    const userId = seeded.userId
    const writes = await Promise.all([
      recordSystemChange(projectId, userId, { type: "screen_mockup", ref: "screen-mockup:a", summary: "Vẽ lại bằng mockup 1 màn hình" }),
      recordSystemChange(projectId, userId, { type: "screen_mockup", ref: "screen-mockup:b", summary: "Vẽ lại bằng mockup 2 màn hình" }),
      recordSystemChange(projectId, userId, { type: "screen_mockup", ref: "screen-mockup:c", summary: "Dùng ảnh gốc cho 3 màn hình" })
    ])
    expect(writes.map((w) => w?.version).sort()).toEqual(["0.2", "0.3", "0.4"])
    // Idempotent theo ref: ghi lại cùng ref không sinh version thứ hai
    expect((await recordSystemChange(projectId, userId, { type: "screen_mockup", ref: "screen-mockup:a", summary: "x" }))?.version).toBe(writes.find((w) => w?.system_change?.ref === "screen-mockup:a")?.version)
    expect(await DocVersion.countDocuments({ projectId, kind: "system_change" })).toBe(3)
    const written = await writeCr(c, "Nhanh hơn", "1 second instead of 2 seconds")
    expect(written.version).toBe("0.5")
  })

  it("chưa có baseline (chưa có version nào) ⇒ recordSystemChange không ghi gì", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    expect(await recordSystemChange(projectId, seeded.userId, { type: "screen_mockup", ref: "screen-mockup:x", summary: "x" })).toBeNull()
    expect(await DocVersion.countDocuments({ projectId })).toBe(0)
  })
})

describe("tác giả Track Changes của bản nháp CR", () => {
  it("bản nháp CR mang tác giả 'CR-001 (Tên người ghi)'; bản nháp thay đổi hệ thống mang tên người thực hiện", async () => {
    const { seeded, projectId, c, templateId } = await setup()
    const migrationId = await migrate(seeded.token, projectId, templateId)
    const sys = (await DocVersion.findOne({ projectId, "system_change.ref": migrationId }).lean())!
    await writeCr(c, "Nhanh hơn", "1 second instead of 2 seconds")
    const cr = (await DocVersion.findOne({ projectId, cr_ids: "CR-001" }).lean())!
    expect(cr.tracked_file_ref).toBeTruthy()
    const authors = await authorsOf(cr.tracked_file_ref!)
    expect(authors.length).toBeGreaterThan(0)
    expect(authors.every((a) => /^CR-001 \(.+\)$/.test(a)), authors.join("|")).toBe(true)
    // Bản đổi mẫu (so nội dung): nếu có đánh dấu thì tác giả là người thực hiện, không phải mã CR
    if (sys.tracked_file_ref) for (const a of await authorsOf(sys.tracked_file_ref)) expect(a).not.toMatch(/^CR-\d/)
  })
})
