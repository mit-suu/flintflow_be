/**
 * FLF-369 — GET /document trả ảnh dạng tham chiếu (#16), GET /document/image (#38), GET /version (#39) qua HTTP trên Mongo
 * thật: bytes đúng file, vẽ lại ⇒ 409, kiểm thành viên / Viewer / org khác / locale / part; export Word vẫn nhúng ảnh;
 * revision tài liệu không đổi khi chỉ tính lại cờ, đổi khi nội dung hoặc bản dịch đổi.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () => (await import("../helpers/mock-llm.js")).mockLlmRouterModule())

import request from "supertest"
import app from "../../src/app.js"
import { authAs, readFixtureJson, seedFixture, type SeededFixture } from "../setup.js"
import { resetMockLlm } from "../helpers/mock-llm.js"
import { gridFsDiagramStore } from "../../src/modules/diagram/diagram-file.store.js"
import { User } from "../../src/modules/user/user.model.js"
import { Membership, type OrgRole } from "../../src/modules/organization/membership.model.js"
import { formatImageRef, parseImageRef } from "../../src/modules/render/image-ref.js"
import { readZipText } from "../../src/modules/render/zip.test-helper.js"
import { saveTranslations } from "../../src/modules/translation/translation.repository.js"
import { SpineTranslation } from "../../src/modules/translation/spine-translation.model.js"
import { RenderedDocumentCache } from "../../src/modules/render/rendered-document.model.js"
import { _internal } from "../../src/modules/render/assemble.service.js"
import { clearDocumentMemo } from "../../src/modules/render/rendered-document-memo.js"
import * as spineRepository from "../../src/modules/spine/spine.repository.js"

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")

const okDiagramIds = (): string[] =>
  readFixtureJson<{ diagrams: Array<{ id: string; render_status: string }> }>("spine-fixture-19-screens.json")
    .diagrams.filter((d) => d.render_status === "ok")
    .map((d) => d.id)

const api = (projectId: string, token: string) => {
  const base = `/api/v1/projects/${projectId}`
  const auth = { Authorization: `Bearer ${token}` }
  return {
    get: (suffix: string) => request(app).get(`${base}${suffix}`).set(auth),
    post: (suffix: string, body: object = {}) => request(app).post(`${base}${suffix}`).set(auth).send(body),
    patch: (suffix: string, body: object = {}) => request(app).patch(`${base}${suffix}`).set(auth).send(body),
    download: (suffix: string) =>
      request(app)
        .get(`${base}${suffix}`)
        .set(auth)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = []
          res.on("data", (chunk: Buffer) => chunks.push(chunk))
          res.on("end", () => done(null, Buffer.concat(chunks)))
        })
  }
}

const join = async (seeded: SeededFixture, email: string, role: OrgRole) => {
  const user = await User.create({ email, password: "test-password-123", emailVerified: true, name: email.split("@")[0] })
  await Membership.create({ organizationId: seeded.orgId, userId: user._id, role })
  return authAs({ _id: user._id, email, orgId: seeded.orgId })
}

const imagePngs = (doc: { sections: Array<{ blocks: Array<{ type: string; png?: string }> }> }): string[] =>
  doc.sections.flatMap((s) => s.blocks).filter((b) => b.type === "image").map((b) => b.png!)

const imageUrl = (token: string) => `/document/image?ref=${encodeURIComponent(token)}`

let seeded: SeededFixture
let lead: ReturnType<typeof api>

beforeEach(async () => {
  resetMockLlm()
  seeded = await seedFixture("full")
  lead = api(seeded.projectId, seeded.token)
  for (const id of okDiagramIds()) await gridFsDiagramStore.save(seeded.projectId, id, "png", { data: PNG_1X1, contentType: "image/png" })
})

describe("GET /document + /document/image", () => {
  it("ảnh thật là tham chiếu (không base64); tải đúng bytes, cache dài hạn, CSP; export Word vẫn nhúng PNG", async () => {
    const doc = await lead.get("/document?source=draft")
    expect(doc.status, JSON.stringify(doc.body.error)).toBe(200)
    const refs = imagePngs(doc.body.data).filter((png) => parseImageRef(png) !== null)
    expect(refs.length).toBeGreaterThan(0)
    expect(imagePngs(doc.body.data).every((png) => png.startsWith("image-ref:") || png.length < 20_000)).toBe(true)

    const img = await lead.download(imageUrl(refs[0]))
    expect(img.status).toBe(200)
    expect(img.headers["content-type"]).toBe("image/png")
    expect(img.headers["cache-control"]).toContain("immutable")
    expect(img.headers["content-security-policy"]).toContain("default-src 'none'")
    expect(img.headers["x-content-type-options"]).toBe("nosniff")
    expect(Buffer.compare(img.body as Buffer, PNG_1X1)).toBe(0)

    const word = await lead.download("/export/word?source=draft")
    expect(word.status).toBe(200)
    expect(readZipText(word.body as Buffer, "word/_rels/document.xml.rels")).toContain("media/")
  })

  it("vẽ lại (ghi file mới, kể cả cùng bytes) ⇒ tham chiếu cũ 409 IMAGE_CHANGED, tài liệu mới mang tham chiếu mới", async () => {
    const before = imagePngs((await lead.get("/document?source=draft")).body.data).find((png) => png.startsWith("image-ref:"))!
    const { id } = parseImageRef(before)!
    await gridFsDiagramStore.save(seeded.projectId, id, "png", { data: PNG_1X1, contentType: "image/png" })
    const stale = await lead.get(imageUrl(before))
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe("IMAGE_CHANGED")
    const after = imagePngs((await lead.get("/document?source=draft")).body.data)
    expect(after).not.toContain(before)
    expect(after.some((png) => parseImageRef(png)?.id === id)).toBe(true)
  })

  it("tham chiếu không thuộc dự án / sai dạng / locale lạ / part không được tham chiếu ⇒ 404 IMAGE_NOT_FOUND", async () => {
    const hash = "0123456789abcdef"
    for (const token of [
      formatImageRef({ kind: "diagram", id: "D99", hash }),
      formatImageRef({ kind: "diagram", id: okDiagramIds()[0], locale: "vi", hash }), // dự án en: không có bản dịch
      formatImageRef({ kind: "media", id: "word/media/image1.png", hash }),
      "iVBORw0KGgo="
    ]) {
      const res = await lead.get(imageUrl(token))
      expect(res.status, token).toBe(404)
      expect(res.body.error.code).toBe("IMAGE_NOT_FOUND")
    }
  })

  it("Viewer xem được ảnh và /version; org khác ⇒ 404", async () => {
    const token = imagePngs((await lead.get("/document?source=draft")).body.data).find((png) => png.startsWith("image-ref:"))!
    const viewer = api(seeded.projectId, await join(seeded, "viewer@flintflow.test", "viewer"))
    expect((await viewer.download(imageUrl(token))).status).toBe(200)
    expect((await viewer.get("/version")).status).toBe(200)

    const stranger = await seedFixture("minimal")
    const outsider = api(seeded.projectId, stranger.token)
    expect((await outsider.get(imageUrl(token))).status).toBe(404)
    expect((await outsider.get("/version")).status).toBe(404)
  })
})

describe("GET /version", () => {
  it("khớp meta.document_revision của GET /document; tính lại cờ chỉ đổi spine_version; sửa nội dung đổi revision", async () => {
    const v1 = await lead.get("/version")
    expect(v1.status, JSON.stringify(v1.body.error)).toBe(200)
    expect(v1.body.data).toEqual({ spine_version: seeded.spineVersion, document_revision: expect.any(String) })
    const doc = await lead.get("/document?source=draft")
    expect(doc.body.meta.document_revision).toBe(v1.body.data.document_revision)

    const recompute = await lead.post("/flags/recompute")
    expect(recompute.status, JSON.stringify(recompute.body.error)).toBe(200)
    const v2 = (await lead.get("/version")).body.data
    // fixture lưu cờ cũ ⇒ tính lại có ghi (spine_version tăng) mà tài liệu không đổi revision
    expect(v2.spine_version).toBeGreaterThan(v1.body.data.spine_version)
    expect(v2.document_revision).toBe(v1.body.data.document_revision)

    const changed = await lead.post("/changes", { base_version: v2.spine_version, ops: [{ op: "set", path: "actors[id=A01].name", value: "Product Owner", reason: "rename" }] })
    expect(changed.status, JSON.stringify(changed.body.error)).toBe(200)
    const v3 = (await lead.get("/version")).body.data
    expect(v3.spine_version).toBeGreaterThan(v2.spine_version)
    expect(v3.document_revision).not.toBe(v2.document_revision)
  })

  it("dự án tài liệu vi: bản dịch mới (không tăng spine_version) đổi revision; ghi đè bản author cũng đổi; machine trùng thì không", async () => {
    expect((await lead.patch("/document-language", { documentLanguage: "vi" })).status).toBe(200)
    const v1 = (await lead.get("/version")).body.data
    expect(v1.document_revision.endsWith(":vi")).toBe(true)

    await saveTranslations(seeded.projectId, "vi", "en", [{ sourceHash: "h1", text: "Xin chào" }], "machine")
    const v2 = (await lead.get("/version")).body.data
    expect(v2.spine_version).toBe(v1.spine_version)
    expect(v2.document_revision).not.toBe(v1.document_revision)

    // machine ghi trùng hash đã có ⇒ không đổi nội dung ⇒ updatedAt giữ nguyên
    const stamp = (await SpineTranslation.findOne({ sourceHash: "h1" }).lean())!.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    await saveTranslations(seeded.projectId, "vi", "en", [{ sourceHash: "h1", text: "Khác" }], "machine")
    expect((await SpineTranslation.findOne({ sourceHash: "h1" }).lean())!.updatedAt).toEqual(stamp)

    await saveTranslations(seeded.projectId, "vi", "en", [{ sourceHash: "h1", text: "Chào bạn" }], "author")
    const v3 = (await lead.get("/version")).body.data
    expect(v3.document_revision).not.toBe(v2.document_revision)
  })
})

describe("FLF-383 — bản xem đã dịch lưu trong rendered_documents", () => {
  it("GET /document (vi) lưu đúng một hàng bản dịch; tiến trình mới (RAM rỗng) trả y hệt; export Word cùng ngôn ngữ dựng mới, nhúng PNG", async () => {
    expect((await lead.patch("/document-language", { documentLanguage: "vi" })).status).toBe(200)
    const first = await lead.get("/document?source=draft")
    expect(first.status, JSON.stringify(first.body.error)).toBe(200)
    expect(first.body.meta.translation).toMatchObject({ locale: "vi", source_locale: "en" })
    await _internal.flushTranslatedWrites()

    await RenderedDocumentCache.init()
    const index = (await RenderedDocumentCache.collection.indexes()).find((i) => i.name === "projectId_1_view_1_locale_1")
    expect(index).toMatchObject({ unique: true, partialFilterExpression: { locale: { $exists: true } } })
    const rows = await RenderedDocumentCache.find({ projectId: seeded.projectId, locale: { $exists: true } }).lean()
    expect(rows.map((r) => [r.view, r.locale])).toEqual([["draft", "vi"]])
    // Khoá ghi (danh tính từ `getWithIdentity`) cùng dạng khoá đọc (`versionHead.identity` qua `documentVersion`)
    const head = await spineRepository.versionHead(seeded.projectId)
    expect(rows[0].content_key).toBe(head!.identity)
    // Hàng gốc (draft theo spine_version) không lẫn hàng bản dịch
    expect(await RenderedDocumentCache.countDocuments({ projectId: seeded.projectId, locale: { $exists: true }, spine_version: { $exists: true } })).toBe(0)

    clearDocumentMemo()
    spineRepository.clearReadCache()
    const again = await lead.get("/document?source=draft")
    expect(again.status).toBe(200)
    expect(again.body.data).toEqual(first.body.data)
    expect(again.body.meta).toEqual(first.body.meta)

    // Export ở ngôn ngữ mặc định (không `?lang=`) vẫn tải được, nhúng PNG, không ghi thêm hàng bản dịch (không dùng lại bản
    // của GET — chặn ở unit test `assemble.test.ts` "chỉ caller bật reuseTranslated")
    const word = await lead.download("/export/word?source=draft")
    expect(word.status, String(word.body)).toBe(200)
    expect(readZipText(word.body as Buffer, "word/_rels/document.xml.rels")).toContain("media/")
    await _internal.flushTranslatedWrites()
    expect(await RenderedDocumentCache.countDocuments({ projectId: seeded.projectId, locale: { $exists: true } })).toBe(1)
  })
})
