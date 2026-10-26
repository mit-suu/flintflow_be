/**
 * Preflight + 3 nhánh stamp (I-1, nút 1.2–1.3) ở tầng service trên Mongo thật — plan §8.2 `preflight.test.ts`
 * (phần cần DB; kiểm file thuần ở `src/modules/import/preflight.test.ts`). FLF-172 P4.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import mongoose from "mongoose"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, fakeMode1 } from "../../helpers/mode1.js"
import { fileOf, importFinalized } from "../../helpers/mode1-import-p4.js"
import { seedFixture } from "../../setup.js"
import { uploadImport } from "../../../src/modules/import/import.service.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { DocxPackage, writeStamp } from "../../../src/modules/docx-ooxml/index.js"
import { makeDocx, p } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { docFileStore } from "../../../src/modules/doc-version/doc-file.store.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const project = async () => {
  const seeded = await seedFixture("minimal")
  return { projectId: await createMode1Project(seeded), userId: seeded.userId }
}
const stamped = async (projectId: string, buf?: Buffer) => {
  const pkg = await DocxPackage.load(buf ?? (await makeSrsDocx()))
  await writeStamp(pkg, { project_id: projectId, version: "0.3", source: "cr_revision" })
  return pkg.toBuffer()
}
/** Ví của org sở hữu project — CV bị chặn ở I-1 không được tốn một credit nào. */
const creditBalanceOf = async (projectId: string): Promise<number> => {
  const project = await mongoose.connection.db!.collection("projects").findOne({ _id: new mongoose.Types.ObjectId(projectId) })
  const wallet = await mongoose.connection.db!.collection("creditwallets").findOne({ organizationId: project!.organizationId })
  return (wallet?.balance as number | undefined) ?? -1
}
const sourceFiles = async (projectId: string) =>
  mongoose.connection.db!.collection("source-docs.files").countDocuments({ "metadata.projectId": projectId })

describe("preflight — FLF-331 nhận diện SRS", () => {
  it("upload CV ⇒ IMPORT_FILE_REJECTED với NOT_SRS, bản ghi preflight_rejected, không lưu file, không parse, credit không đổi", async () => {
    const { projectId, userId } = await project()
    const before = await creditBalanceOf(projectId)
    const cv = await makeDocx({
      body: [p("NGUYEN VAN A"), p("Senior Backend Developer"), p("Work Experience"), p("2021–2024: FPT Software — billing services."), p("Education"), p("FPT University, Software Engineering"), p("Skills"), p("Node.js, TypeScript, Docker"), p("Hobbies: football")].join("")
    })
    const err = await uploadImport(projectId, userId, fileOf(cv)).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: "IMPORT_FILE_REJECTED" })
    const meta = (err as { meta: { issues: { code: string }[] } }).meta
    expect(meta.issues.map((i) => i.code)).toEqual(["NOT_SRS"])

    const doc = await ImportedDocument.findOne({ projectId }).lean()
    expect(doc).toMatchObject({ status: "preflight_rejected", file_ref: null })
    expect(doc!.preflight.document_kind?.kind).toBe("not_srs")
    expect(await DocBlock.countDocuments({ projectId })).toBe(0)
    expect(await sourceFiles(projectId)).toBe(0)
    expect(await creditBalanceOf(projectId)).toBe(before)
  })
})

describe("preflight — 3 nhánh stamp", () => {
  it("không stamp ⇒ awaiting_latest_confirm, lưu file gốc, chưa parse", async () => {
    const { projectId, userId } = await project()
    const doc = await uploadImport(projectId, userId, fileOf(await makeSrsDocx()))
    expect(doc).toMatchObject({ status: "awaiting_latest_confirm", stamp: null, confirmed_latest_at: null })
    expect(doc.preflight.status).toBe("accepted")
    expect(await DocBlock.countDocuments({ projectId })).toBe(0)
    expect((await docFileStore().load(doc.file_ref!)).length).toBeGreaterThan(0)
    expect(await sourceFiles(projectId)).toBe(1)
  })

  it("stamp đúng project (chưa có baseline) ⇒ coi như đã xác nhận, parse ngay", async () => {
    const { projectId, userId } = await project()
    const doc = await uploadImport(projectId, userId, fileOf(await stamped(projectId)))
    expect(doc.stamp).toMatchObject({ project_id: projectId, version: "0.3" })
    expect(doc.confirmed_latest_at).toBeInstanceOf(Date)
    expect(doc.status).toBe("extracting")
    expect(await DocBlock.countDocuments({ projectId })).toBeGreaterThan(20)
  })

  it("stamp đúng project sau baseline ⇒ /import từ chối, phải đi nhánh re-upload (2D)", async () => {
    const { projectId, userId } = await importFinalized()
    const v = (await DocVersion.findOne({ projectId }).lean())!
    await expect(uploadImport(projectId, userId, fileOf(await docFileStore().load(v.file_ref)))).rejects.toMatchObject({
      code: "IMPORT_INVALID_STATE",
      statusCode: 409
    })
  })

  it("stamp của project khác ⇒ 422 IMPORT_STAMP_FOREIGN_PROJECT, không tạo bản ghi, không lưu file", async () => {
    const { projectId, userId } = await project()
    const foreign = "66f0000000000000000000ff"
    await expect(uploadImport(projectId, userId, fileOf(await stamped(foreign)))).rejects.toMatchObject({
      code: "IMPORT_STAMP_FOREIGN_PROJECT",
      statusCode: 422,
      meta: { stamp: { project_id: foreign } }
    })
    expect(await ImportedDocument.countDocuments({ projectId })).toBe(0)
    expect(await sourceFiles(projectId)).toBe(0)
  })
})

describe("preflight — từ chối", () => {
  it("Track Changes tác giả lạ ⇒ bản ghi preflight_rejected kèm issue có vị trí, không lưu file", async () => {
    const { projectId, userId } = await project()
    const bad = await makeDocx({ body: p("A") + `<w:p><w:del w:id="1" w:author="Nguyen Van A"><w:r><w:delText>B</w:delText></w:r></w:del><w:r><w:t>C</w:t></w:r></w:p>` })
    await expect(uploadImport(projectId, userId, fileOf(bad))).rejects.toMatchObject({ code: "IMPORT_FILE_REJECTED", statusCode: 422 })
    const rec = (await ImportedDocument.findOne({ projectId }).lean())!
    expect(rec).toMatchObject({ status: "preflight_rejected", file_ref: null, preflight: { status: "rejected" } })
    expect(rec.preflight.issues[0]).toMatchObject({ code: "FOREIGN_TRACK_CHANGE", location: { block_ord: 1 } })
    expect(await sourceFiles(projectId)).toBe(0)
  })

  it("không phải docx (đuôi .docx nhưng là .doc) ⇒ từ chối theo nội dung, không theo đuôi", async () => {
    const { projectId, userId } = await project()
    const legacy = Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(64), Buffer.from("WordDocument", "utf16le")])
    await expect(uploadImport(projectId, userId, fileOf(legacy, "SRS.docx"))).rejects.toMatchObject({
      code: "IMPORT_FILE_REJECTED",
      meta: { issues: [{ code: "LEGACY_DOC", location: null }] }
    })
  })

  it("Track Changes/comment author CR-003 ⇒ nhận", async () => {
    const { projectId, userId } = await project()
    const ok = await makeDocx({ body: p("A") + `<w:p><w:ins w:id="1" w:author="CR-003"><w:r><w:t>B</w:t></w:r></w:ins></w:p>` })
    const doc = await uploadImport(projectId, userId, fileOf(ok))
    expect(doc.preflight).toMatchObject({ status: "accepted", issues: [] })
  })
})
