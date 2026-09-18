/**
 * Mode 1 — import phần tất định qua HTTP trên Mongo thật (FLF-171, P2 2B): upload + preflight + 3 nhánh stamp,
 * xác nhận bản mới nhất, tách block + profile, xác nhận mapping; project mode khác ⇒ PROJECT_MODE_MISMATCH.
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { seedFixture, type SeededFixture } from "../setup.js"
import { DocxPackage, writeStamp } from "../../src/modules/docx-ooxml/index.js"
import { makeDocx, p } from "../../src/modules/docx-ooxml/testing/make-docx.js"
import { makeSrsDocx } from "../../src/modules/import/testing/srs-fixture.js"
import { getImportResponseSchema, importStateResponseSchema, importRejectedMetaSchema } from "../../src/modules/import/import.dto.js"
import { DocBlock } from "../../src/modules/import/doc-block.model.js"
import { Project } from "../../src/modules/project/project.model.js"

export const createMode1Project = async (seeded: SeededFixture): Promise<string> => {
  const res = await request(app)
    .post("/api/v1/projects")
    .set("Authorization", `Bearer ${seeded.token}`)
    .send({ name: "Lumen import", mode: "import" })
  expect(res.status, JSON.stringify(res.body.error)).toBe(201)
  return String(res.body.data._id)
}

const api = (seeded: SeededFixture, projectId: string) => {
  const auth = { Authorization: `Bearer ${seeded.token}` }
  const base = `/api/v1/projects/${projectId}`
  return {
    upload: (buf: Buffer, name = "SRS_Lumen.docx") => request(app).post(`${base}/import`).set(auth).attach("file", buf, name),
    get: () => request(app).get(`${base}/import`).set(auth),
    post: (suffix: string, body: object) => request(app).post(`${base}${suffix}`).set(auth).send(body),
    patch: (suffix: string, body: object) => request(app).patch(`${base}${suffix}`).set(auth).send(body)
  }
}

describe("mode 1 import — upload, preflight, parse, mapping", () => {
  it("file không stamp ⇒ chờ xác nhận; xác nhận ⇒ tách block + profile ⇒ extracting", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    const c = api(seeded, projectId)

    const up = await c.upload(await makeSrsDocx(), "SRS_Lumen tiếng Việt.docx")
    expect(up.status, JSON.stringify(up.body.error)).toBe(201)
    const uploaded = importStateResponseSchema.parse(up.body.data).import
    expect(uploaded).toMatchObject({ status: "awaiting_latest_confirm", original_name: "SRS_Lumen tiếng Việt.docx", stamp: null })

    // bước sau khi chưa xác nhận ⇒ IMPORT_NEEDS_LATEST_CONFIRM
    const early = await c.patch("/import/mapping", { import_id: uploaded.id, confirm_all: true })
    expect(early.status).toBe(409)
    expect(early.body.error.code).toBe("IMPORT_NEEDS_LATEST_CONFIRM")
    expect(early.body.meta).toEqual({ import_id: uploaded.id })

    const confirmed = await c.post("/import/confirm-latest", { import_id: uploaded.id })
    expect(confirmed.status, JSON.stringify(confirmed.body.error)).toBe(200)
    expect(confirmed.body.data.import.status).toBe("extracting")

    const view = getImportResponseSchema.parse((await c.get()).body.data)
    expect(view.blocks_count).toBeGreaterThan(20)
    expect(view.profile?.heading_map.find((h) => h.heading_text === "2.1 Actors")?.section_id).toBe("fixed:2.1")
    const blocks = await DocBlock.find({ projectId, doc_version: "0.0" }).sort({ "anchor.ordinal": 1 }).lean()
    expect(blocks[0]).toMatchObject({ block_id: "B0001", kind: "heading", section_id: "fixed:1", anchor: { bookmark: "_ff_B0001" } })
    expect((await Project.findById(projectId).lean())?.import_state).toBe("extracting")

    // confirm lại ⇒ sai trạng thái
    const again = await c.post("/import/confirm-latest", { import_id: uploaded.id })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe("IMPORT_INVALID_STATE")
  })

  it("heading không style ⇒ mapping_review; sửa mapping + confirm_all ⇒ extracting, block đổi section", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    const c = api(seeded, projectId)
    const id = (await c.upload(await makeSrsDocx({ numberedOnly: true }))).body.data.import.id as string
    const confirmed = await c.post("/import/confirm-latest", { import_id: id })
    expect(confirmed.body.data.import.status).toBe("mapping_review")

    const view = getImportResponseSchema.parse((await c.get()).body.data)
    const notes = view.profile!.heading_map.find((h) => h.heading_text === "5.9 Team Notes")!
    const bad = await c.patch("/import/mapping", { import_id: id, headings: [{ block_id: notes.block_id, section_id: "fixed:9.9" }] })
    expect(bad.status).toBe(409)

    const partial = await c.patch("/import/mapping", { import_id: id, headings: [{ block_id: notes.block_id, section_id: "fixed:5.4" }] })
    expect(partial.status, JSON.stringify(partial.body.error)).toBe(200)
    expect(partial.body.data.import.status).toBe("mapping_review")
    const noteBody = await DocBlock.findOne({ projectId, text: "Internal notes that do not belong to the template." }).lean()
    expect(noteBody?.section_id).toBe("fixed:5.4")

    const done = await c.patch("/import/mapping", { import_id: id, confirm_all: true })
    expect(done.body.data.import.status).toBe("extracting")
    const after = getImportResponseSchema.parse((await c.get()).body.data)
    expect(after.profile!.heading_map.every((h) => h.confirmed)).toBe(true)
  })

  it("preflight từ chối ⇒ 422 kèm issues, bản ghi preflight_rejected; upload lại được", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    const c = api(seeded, projectId)
    const foreign = await makeDocx({
      body: p("A") + `<w:p><w:ins w:id="1" w:author="Nguyen Van A"><w:r><w:t>B</w:t></w:r></w:ins></w:p>`
    })
    const res = await c.upload(foreign)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe("IMPORT_FILE_REJECTED")
    const meta = importRejectedMetaSchema.parse(res.body.meta)
    expect(meta.issues[0]).toMatchObject({ code: "FOREIGN_TRACK_CHANGE", location: { block_ord: 1 } })
    expect(getImportResponseSchema.parse((await c.get()).body.data).import?.status).toBe("preflight_rejected")

    const ok = await c.upload(await makeSrsDocx())
    expect(ok.status).toBe(201)
  })

  it("stamp của project khác ⇒ 422 IMPORT_STAMP_FOREIGN_PROJECT; stamp đúng project ⇒ parse ngay", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    const c = api(seeded, projectId)
    const stamped = async (project: string) => {
      const pkg = await DocxPackage.load(await makeSrsDocx())
      await writeStamp(pkg, { project_id: project, version: "v0.3", source: "baseline" })
      return pkg.toBuffer()
    }
    const other = await c.upload(await stamped("66f0000000000000000000ff"))
    expect(other.status).toBe(422)
    expect(other.body.error.code).toBe("IMPORT_STAMP_FOREIGN_PROJECT")
    expect(other.body.meta.stamp.project_id).toBe("66f0000000000000000000ff")

    const own = await c.upload(await stamped(projectId))
    expect(own.status).toBe(201)
    expect(own.body.data.import).toMatchObject({ status: "extracting", stamp: { project_id: projectId } })
    expect(own.body.data.import.confirmed_latest_at).not.toBeNull()
  })

  it("project mode fpt ⇒ 409 PROJECT_MODE_MISMATCH; project người khác ⇒ 404", async () => {
    const seeded = await seedFixture("minimal")
    const res = await request(app).get(`/api/v1/projects/${seeded.projectId}/import`).set("Authorization", `Bearer ${seeded.token}`)
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: { code: "PROJECT_MODE_MISMATCH" }, meta: { mode: "fpt", expected: "import" } })

    const stranger = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    const denied = await request(app).get(`/api/v1/projects/${projectId}/import`).set("Authorization", `Bearer ${stranger.token}`)
    expect(denied.status).toBe(404)
  })

  it("thiếu file ⇒ 400", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    const res = await request(app).post(`/api/v1/projects/${projectId}/import`).set("Authorization", `Bearer ${seeded.token}`)
    expect(res.status).toBe(400)
  })
})
