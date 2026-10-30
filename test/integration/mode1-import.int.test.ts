/**
 * Mode 1 — import phần tất định qua HTTP trên Mongo thật (FLF-171, P2 2B): upload + preflight + 3 nhánh stamp,
 * xác nhận bản mới nhất, tách block + profile, xác nhận mapping; project mode khác ⇒ PROJECT_MODE_MISMATCH.
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { seedFixture, type SeededFixture } from "../setup.js"
import { DocxPackage, writeStamp } from "../../src/modules/docx-ooxml/index.js"
import { makeDocx, p, table } from "../../src/modules/docx-ooxml/testing/make-docx.js"
import { makeSrsDocx } from "../../src/modules/import/testing/srs-fixture.js"
import { getImportResponseSchema, importStateResponseSchema, importRejectedMetaSchema } from "../../src/modules/import/import.dto.js"
import { DocBlock } from "../../src/modules/import/doc-block.model.js"
import { IMPORT_MAX_FILE_BYTES } from "../../src/modules/import/import.constants.js"
import { Project } from "../../src/modules/project/project.model.js"
import { createMode1Project } from "../helpers/mode1.js"

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
  it("FLF-343: file không stamp ⇒ tách block + profile ngay ⇒ extracting chưa chạy (màn báo credit); Bắt đầu không xác nhận bản mới nhất ⇒ IMPORT_NEEDS_LATEST_CONFIRM", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    const c = api(seeded, projectId)

    const up = await c.upload(await makeSrsDocx(), "SRS_Lumen tiếng Việt.docx")
    expect(up.status, JSON.stringify(up.body.error)).toBe(201)
    const uploaded = importStateResponseSchema.parse(up.body.data).import
    expect(uploaded).toMatchObject({ status: "extracting", original_name: "SRS_Lumen tiếng Việt.docx", stamp: null, confirmed_latest_at: null, extract_cursor: null })

    const view = getImportResponseSchema.parse((await c.get()).body.data)
    expect(view.blocks_count).toBeGreaterThan(20)
    expect(view.profile?.heading_map.find((h) => h.heading_text === "2.1 Actors")?.section_id).toBe("fixed:2.1")
    // màn báo credit một lần: I-4 + kiểm tra AI (chưa gọi AI nào)
    expect(view.credit_estimate).toMatchObject({ check_calls: expect.any(Number) })
    expect(view.credit_estimate!.ai_calls).toBeGreaterThanOrEqual(view.credit_estimate!.check_calls!)
    const blocks = await DocBlock.find({ projectId, doc_version: "0.1" }).sort({ "anchor.ordinal": 1 }).lean()
    expect(blocks[0]).toMatchObject({ block_id: "B0001", kind: "heading", section_id: "fixed:1", anchor: { bookmark: "_ff_B0001" } })
    expect((await Project.findById(projectId).lean())?.import_state).toBe("extracting")

    // Bắt đầu mà bỏ tick "bản mới nhất" ⇒ không chạy, cùng câu từ chối như trước
    const early = await c.post("/import/extract", { import_id: uploaded.id })
    expect(early.status).toBe(409)
    expect(early.body.error.code).toBe("IMPORT_NEEDS_LATEST_CONFIRM")
    expect(early.body.meta).toEqual({ import_id: uploaded.id })
    const still = getImportResponseSchema.parse((await c.get()).body.data).import!
    expect(still).toMatchObject({ status: "extracting", confirmed_latest_at: null, extract_cursor: null })

    // bước xác nhận riêng không còn cho file mới
    const again = await c.post("/import/confirm-latest", { import_id: uploaded.id })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe("IMPORT_INVALID_STATE")
  })

  it("FLF-343: heading không style ⇒ không dừng ở mapping_review — mục độ tin thấp tự nhận (giữ độ tin, auto_confirmed)", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    const c = api(seeded, projectId)
    const up = await c.upload(await makeSrsDocx({ numberedOnly: true }))
    expect(up.body.data.import.status).toBe("extracting")

    const view = getImportResponseSchema.parse((await c.get()).body.data)
    const low = view.profile!.heading_map.filter((h) => h.confidence < 0.8)
    expect(low.length).toBeGreaterThan(0)
    expect(low.every((h) => h.confirmed && h.auto_confirmed)).toBe(true)
    expect(view.profile!.heading_map.filter((h) => h.confidence >= 0.8).every((h) => !h.auto_confirmed)).toBe(true)
    // PATCH mapping chỉ còn cho bản ghi cũ ở mapping_review
    const notes = view.profile!.heading_map.find((h) => h.heading_text === "5.9 Team Notes")!
    const late = await c.patch("/import/mapping", { import_id: up.body.data.import.id, headings: [{ block_id: notes.block_id, section_id: "fixed:5.4" }] })
    expect(late.status).toBe(409)
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

  it("giới hạn 40 MB: file hơi quá cỡ ⇒ preflight FILE_TOO_LARGE nêu MB + cách nén ảnh; quá gấp đôi ⇒ 413 meta.max_mb", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    const c = api(seeded, projectId)
    const over = await c.upload(Buffer.alloc(IMPORT_MAX_FILE_BYTES + 1024 * 1024))
    expect(over.status).toBe(422)
    const issue = importRejectedMetaSchema.parse(over.body.meta).issues[0]
    expect(issue.code).toBe("FILE_TOO_LARGE")
    expect(issue.message).toContain("41 MB")
    expect(issue.message).toContain("giới hạn 40 MB")
    expect(issue.message).toContain("Compress Pictures")

    const huge = await c.upload(Buffer.alloc(IMPORT_MAX_FILE_BYTES * 2 + 1))
    expect(huge.status).toBe(413)
    expect(huge.body.error.code).toBe("FILE_TOO_LARGE")
    expect(huge.body.error.message).toContain("40 MB")
    expect(huge.body.meta).toMatchObject({ max_mb: 40 })
  })

  it("FLF-252: Record of Changes đọc ngay lúc tách file ⇒ GET /import trả về để wizard cho xem/sửa; cột bảng có dữ liệu mẫu", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    const c = api(seeded, projectId)
    const recordOfChanges = [
      ["Date", "A*\nM, D", "In charge", "Change Description"],
      ["29/07/2026", "A", "QuynhTTN", "Added User Requirements section"]
    ]
    const up = await c.upload(await makeSrsDocx({ recordOfChanges }))
    const importId = importStateResponseSchema.parse(up.body.data).import.id
    const profile = getImportResponseSchema.parse((await c.get()).body.data).profile!
    expect(profile.record_of_changes).toEqual([
      { date: "29/07/2026", version: "", change_type: "A", in_charge: "QuynhTTN", description: "Added User Requirements section" }
    ])
    // bảng Record of Changes không vào bước map cột; bảng tác nhân mang dữ liệu mẫu
    expect(profile.table_map.some((t) => t.header === "Change Description")).toBe(false)
    expect(profile.table_map.find((t) => t.header === "Actor")).toMatchObject({ field_path: "actors[].name", samples: ["Learner", "Admin"] })
  })

  it("bảng có ô tiêu đề cột trống ⇒ upload + tách block vẫn chạy, cột đó có header rỗng (FLF-179)", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    const c = api(seeded, projectId)
    // Bảng ở mục có trích (2.2.2) — bảng dưới heading nhóm không vào bước map cột (FLF-251)
    const body = p("2.2.2 Use Case Descriptions") + table([["Use Case ID", "", "Actor"], ["UC-01", "Register", "Learner"]])
    const up = await c.upload(await makeDocx({ body }))
    expect(up.status, JSON.stringify(up.body.error)).toBe(201)
    const importId = importStateResponseSchema.parse(up.body.data).import.id
    expect(importStateResponseSchema.parse(up.body.data).import.status).toBe("extracting")
    const profile = getImportResponseSchema.parse((await c.get()).body.data).profile!
    expect(profile.table_map.map((t) => t.header)).toEqual(["Use Case ID", "", "Actor"])
  })
})
