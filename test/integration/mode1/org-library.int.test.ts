/**
 * FLF-278 trên FLF-335/336 — mẫu cấp tổ chức, API + Mongo thật:
 *  A. Lưu file mẫu + mapping đã xác nhận ⇒ dự án khác của tổ chức dùng lại: import từ chính file, mapping áp sẵn, đi thẳng
 *     tới trích dữ liệu (không qua 1.5); tổ chức khác không thấy; Viewer chỉ xem.
 *  B. Trang Thư viện: phân trang, tìm không dấu, sắp xếp.
 *  C. Admin xem heading mẫu bắt buộc thành mục riêng.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import mongoose from "mongoose"
import request from "supertest"
import app from "../../../src/app.js"
import { authAs, seedFixture } from "../../setup.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, fakeMode1 } from "../../helpers/mode1.js"
import { fileOf } from "../../helpers/mode1-import-p4.js"
import { p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { acceptLatest, patchMapping, uploadImport } from "../../../src/modules/import/import.service.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { OrgTemplate } from "../../../src/modules/import/org-library.model.js"
import { Membership } from "../../../src/modules/organization/membership.model.js"
import { User } from "../../../src/modules/user/user.model.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const H = (token: string) => ({ Authorization: `Bearer ${token}` })
const EXTRA = styled("u1", "6 Operating Environment") + p("[Describe the operating environment.]") + styled("u1", "7 Document Conventions") + p("[Describe conventions.]")

/**
 * Dự án import + upload mẫu (FLF-343: tách file ngay ⇒ `extracting`) + BA đổi một heading — mapping sửa tay chỉ còn ở bản ghi
 * cũ `mapping_review`, nên đưa bản ghi về đó để giữ đúng tình huống "mapping BA đã xác nhận" của mẫu tổ chức.
 */
const mappedProject = async (seeded: Awaited<ReturnType<typeof seedFixture>>) => {
  const projectId = await createMode1Project(seeded)
  const doc = await uploadImport(projectId, seeded.userId, fileOf(await makeSrsDocx({ extraBody: EXTRA })))
  await acceptLatest(doc, true)
  await ImportedDocument.updateOne({ _id: doc._id }, { $set: { status: "mapping_review" } })
  const profile = (await TemplateProfile.findOne({ projectId }))!
  const conventions = profile.heading_map.find((h) => h.heading_text.includes("Document Conventions"))!
  await patchMapping(projectId, { import_id: String(doc._id), headings: [{ block_id: conventions.block_id, section_id: "unmapped" }], tables: [], confirm_all: true })
  return { projectId, importId: String(doc._id) }
}

const viewerOf = async (orgId: string) => {
  const user = await User.create({ email: `viewer-${Date.now()}@flintflow.test`, password: "test-password-123", emailVerified: true })
  await Membership.create({ userId: user._id, organizationId: orgId, role: "viewer" })
  return authAs({ _id: user._id, email: user.email, orgId })
}

describe("FLF-278 - mẫu và thư viện nội dung của tổ chức (luồng import)", () => {
  it("A. lưu mẫu + mapping ⇒ dự án khác dùng lại, mapping áp sẵn, bỏ qua xác nhận; tổ chức khác không dùng được", async () => {
    const owner = await seedFixture("minimal", { balance: 1000 })
    const first = await mappedProject(owner)
    const saved = await request(app).post(`/api/v1/projects/${first.projectId}/import/save-to-org`).set(H(owner.token)).send({ name: "Mẫu ngân hàng" })
    expect(saved.status, JSON.stringify(saved.body.error)).toBe(201)
    expect(saved.body.data).toMatchObject({ name: "Mẫu ngân hàng", uses: 0 })
    expect(saved.body.data.heading_count).toBeGreaterThan(5)

    const listed = await request(app).get(`/api/v1/orgs/${owner.orgId}/templates`).set(H(owner.token))
    expect(listed.body.data.map((t: { id: string }) => t.id)).toEqual([saved.body.data.id])

    const second = await createMode1Project(owner, "Bank app 2")
    const used = await request(app).post(`/api/v1/projects/${second}/import/from-org`).set(H(owner.token)).send({ org_template_id: saved.body.data.id, intent: "fixed" })
    expect(used.status, JSON.stringify(used.body.error)).toBe(201)
    const doc = (await ImportedDocument.findOne({ projectId: second }).sort({ createdAt: -1 }))!
    // Không hỏi "bản mới nhất", không qua 1.5 — mapping BA đã xác nhận ở dự án trước áp sẵn
    expect(doc.status).toBe("extracting")
    expect(String(doc.org_template_id)).toBe(saved.body.data.id)
    const fresh = (await TemplateProfile.findOne({ projectId: second }).lean())!
    const original = (await TemplateProfile.findOne({ projectId: first.projectId }).lean())!
    expect(fresh.heading_map.map((h) => [h.heading_text, h.section_id])).toEqual(original.heading_map.map((h) => [h.heading_text, h.section_id]))
    expect(fresh.heading_map.every((h) => h.confirmed)).toBe(true)
    expect((await OrgTemplate.findById(saved.body.data.id))!.uses).toBe(1)

    const viewer = await viewerOf(owner.orgId)
    expect((await request(app).get(`/api/v1/orgs/${owner.orgId}/templates`).set(H(viewer))).status).toBe(200)
    expect((await request(app).delete(`/api/v1/orgs/${owner.orgId}/templates/${saved.body.data.id}`).set(H(viewer))).status).toBe(403)

    const stranger = await seedFixture("minimal")
    const theirs = await createMode1Project(stranger)
    const foreign = await request(app).post(`/api/v1/projects/${theirs}/import/from-org`).set(H(stranger.token)).send({ org_template_id: saved.body.data.id })
    expect(foreign.status).toBe(404)
    expect(foreign.body.error.code).toBe("ORG_TEMPLATE_NOT_FOUND")

    expect((await request(app).delete(`/api/v1/orgs/${owner.orgId}/templates/${saved.body.data.id}`).set(H(owner.token))).status).toBe(200)
    expect(await OrgTemplate.countDocuments({ orgId: owner.orgId })).toBe(0)
  })

  it("B. trang Thư viện: phân trang, tìm không dấu theo tên / file, sắp xếp; không có page ⇒ danh sách cũ", async () => {
    const owner = await seedFixture("minimal")
    const names = ["Ngân hàng số", "Bệnh viện HIS", "Logistics", "Ăn uống", "Bảo hiểm"]
    await OrgTemplate.insertMany(
      names.map((name, i) => ({
        orgId: owner.orgId,
        name,
        source_file: { name: i === 2 ? "kho van ngan hang.docx" : `f${i}.docx`, size: 1, sha256: "0".repeat(63) + String(i) },
        file_ref: `x/${i}`,
        headings: [{ heading_text: "Intro", section_id: "fixed:1" }],
        created_by: owner.userId,
        uses: i,
        createdAt: new Date(2026, 0, i + 1)
      }))
    )
    const list = (query: string) => request(app).get(`/api/v1/orgs/${owner.orgId}/templates${query}`).set(H(owner.token))

    const first = await list("?page=1&limit=2")
    expect(first.status, JSON.stringify(first.body.error)).toBe(200)
    expect(first.body.data.map((t: { name: string }) => t.name)).toEqual(["Bảo hiểm", "Ăn uống"])
    expect(first.body.meta).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 })
    expect((await list("?page=3&limit=2")).body.data.map((t: { name: string }) => t.name)).toEqual(["Ngân hàng số"])

    // Gõ không dấu khớp tên có dấu và cả tên file
    const search = await list("?page=1&q=ngan%20hang&sort=recent")
    expect(search.body.data.map((t: { name: string }) => t.name)).toEqual(["Logistics", "Ngân hàng số"])
    expect(search.body.meta.total).toBe(2)

    const byName = await list("?page=1&sort=name")
    expect(byName.body.data.map((t: { name: string }) => t.name)).toEqual(["Ăn uống", "Bảo hiểm", "Bệnh viện HIS", "Logistics", "Ngân hàng số"])

    const legacy = await list("")
    expect(legacy.body.data).toHaveLength(5)
    expect(legacy.body.meta).toBeUndefined()
    expect((await list("?page=0")).status).toBe(400)
  })

  it("C. admin xem heading mẫu bắt buộc thành mục riêng còn trống", async () => {
    const owner = await seedFixture("minimal", { balance: 1000 })
    const { projectId } = await mappedProject(owner)
    await mongoose.connection.db!.collection("projects").updateOne({ _id: new mongoose.Types.ObjectId(projectId) }, { $set: { template_intent: "fixed" } })
    await TemplateProfile.updateOne({ projectId }, { $set: { layout: [{ order: 0, heading_text: "7 Document Conventions", level: 1, section_id: "custom:CS01" }] } })
    const adminUser = await User.create({ email: "admin-gaps@flintflow.test", password: "test-password-123", role: "admin", emailVerified: true })
    const admin = await authAs({ _id: adminUser._id, email: adminUser.email, role: "admin" })
    expect((await request(app).get("/api/v1/admin/template-gaps").set(H(owner.token))).status).toBe(403)
    const gaps = await request(app).get("/api/v1/admin/template-gaps?limit=5").set(H(admin))
    expect(gaps.status, JSON.stringify(gaps.body.error)).toBe(200)
    expect(gaps.body.data.rows).toEqual([{ key: "document conventions", samples: ["7 Document Conventions"], projects: 1, empty: 1, suggested_destination: null }])
    // FLF-404: phân trang sau khi gom — trang vượt quá thì rỗng, meta vẫn đếm toàn bộ
    expect(gaps.body.meta).toEqual({ page: 1, limit: 5, total: 1, totalPages: 1 })
    const beyond = await request(app).get("/api/v1/admin/template-gaps?page=2&limit=5").set(H(admin))
    expect(beyond.body.data.rows).toEqual([])
    expect(beyond.body.data.projects).toBe(1)
    expect(beyond.body.meta.total).toBe(1)
  })
})
