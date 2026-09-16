/**
 * baseline-export (T22) — endpoint 16–20 qua HTTP trên Mongo thật: assemble → document → export Word,
 * baseline bị chặn bởi cờ đỏ / ký được khi sạch, tài liệu và file Word của baseline.
 * PNG sơ đồ được nạp sẵn vào GridFS (test không có PlantUML).
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { readFixtureJson, seedFixture, type SeededFixture } from "../setup.js"
import { assembleResponseSchema, baselineResponseSchema, baselinesResponseSchema } from "../../src/modules/pipeline/pipeline.dto.js"
import { renderedDocumentSchema } from "../../src/modules/render/rendered-document.schema.js"
import { gridFsDiagramStore } from "../../src/modules/diagram/diagram-file.store.js"
import { Notification } from "../../src/modules/notification/notification.model.js"

/** PNG 1×1 hợp lệ — đủ để writer đo kích thước và nhúng ảnh. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
)

const seedDiagramPngs = async (seeded: SeededFixture): Promise<number> => {
  const spine = readFixtureJson<{ diagrams: Array<{ id: string; render_status: string }> }>("spine-fixture-19-screens.json")
  const ok = spine.diagrams.filter((d) => d.render_status === "ok")
  for (const d of ok) await gridFsDiagramStore.save(seeded.projectId, d.id, "png", { data: PNG_1X1, contentType: "image/png" })
  return ok.length
}

const client = (seeded: SeededFixture) => {
  const auth = { Authorization: `Bearer ${seeded.token}` }
  const base = `/api/v1/projects/${seeded.projectId}`
  return {
    get: (suffix: string) => request(app).get(`${base}${suffix}`).set(auth),
    post: (suffix: string, body: object = {}) => request(app).post(`${base}${suffix}`).set(auth).send(body),
    /** Tải file nhị phân (không bọc envelope). */
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

const expectDocx = (res: { status: number; headers: Record<string, string>; body: unknown }) => {
  expect(res.status).toBe(200)
  expect(res.headers["content-type"]).toContain("officedocument.wordprocessingml.document")
  expect(res.headers["content-disposition"]).toContain("attachment")
  const file = res.body as Buffer
  // .docx là zip: chữ ký "PK"
  expect(file.subarray(0, 2).toString()).toBe("PK")
  expect(file.length).toBeGreaterThan(1000)
}

describe("chưa assemble / còn cờ đỏ", () => {
  it("document và export Word ⇒ 409 NO_WORKING_DRAFT kèm hint S-8.2", async () => {
    const seeded = await seedFixture("minimal")
    const api = client(seeded)

    const doc = await api.get("/document?source=draft")
    expect(doc.status).toBe(409)
    expect(doc.body.error.code).toBe("NO_WORKING_DRAFT")
    expect(doc.body.meta).toEqual({ hint: "S-8.2" })

    const word = await api.get("/export/word?source=draft")
    expect(word.status).toBe(409)
  })

  it("POST /baseline còn cờ đỏ ⇒ 422 BASELINE_BLOCKED liệt kê cờ; không tạo baseline", async () => {
    const seeded = await seedFixture("minimal")
    const api = client(seeded)

    const res = await api.post("/baseline", { base_version: seeded.spineVersion })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe("BASELINE_BLOCKED")
    expect((res.body.meta.flags as unknown[]).length).toBeGreaterThan(0)

    const list = await api.get("/baselines")
    expect(baselinesResponseSchema.parse(list.body.data)).toEqual([])
  })

  it("assemble khi PNG sơ đồ chưa có ⇒ 200 nhưng không cache (review C3) ⇒ document vẫn 409", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)

    const assemble = await api.post("/assemble", { base_version: seeded.spineVersion })
    expect(assemble.status).toBe(200)
    expect((await api.get("/document?source=draft")).body.error.code).toBe("NO_WORKING_DRAFT")
  })
})

describe("fixture 19 màn đủ ảnh sơ đồ", () => {
  it("assemble → document draft → export Word; base_version lệch ⇒ 409", async () => {
    const seeded = await seedFixture("full")
    expect(await seedDiagramPngs(seeded)).toBeGreaterThan(0)
    const api = client(seeded)

    const stale = await api.post("/assemble", { base_version: seeded.spineVersion + 1 })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe("SPINE_VERSION_CONFLICT")

    const assemble = await api.post("/assemble", { base_version: seeded.spineVersion })
    expect(assemble.status, JSON.stringify(assemble.body.error)).toBe(200)
    const assembled = assembleResponseSchema.parse(assemble.body.data)
    expect(assembled.sections).toBeGreaterThan(100)

    const doc = await api.get("/document?source=draft")
    expect(doc.status, JSON.stringify(doc.body.error)).toBe(200)
    const rendered = renderedDocumentSchema.parse(doc.body.data)
    expect(rendered.projectId).toBe(seeded.projectId)
    expect(rendered.sections.length).toBeGreaterThanOrEqual(assembled.sections)

    expectDocx(await api.download("/export/word?source=draft"))
  })

  it("0 cờ đỏ ⇒ POST /baseline 201 v1.0; GET /baselines; document + Word của baseline; notification baseline_created", async () => {
    const seeded = await seedFixture("full")
    await seedDiagramPngs(seeded)
    const api = client(seeded)

    const created = await api.post("/baseline", { base_version: seeded.spineVersion })
    expect(created.status, JSON.stringify(created.body.error)).toBe(201)
    const baseline = baselineResponseSchema.parse(created.body.data)
    expect(baseline.version).toBe("v1.0")
    expect(baseline.waived_count).toBe(0)

    const again = await api.post("/baseline", { base_version: seeded.spineVersion })
    expect(again.status).toBe(409)

    const list = baselinesResponseSchema.parse((await api.get("/baselines")).body.data)
    expect(list.map((b) => b.id)).toEqual([baseline.id])

    // `baseline_id` của /document, /export/word hiện là `_id` Mongo (= `snapshot_ref`), KHÔNG phải `id` "BL001"
    // mà /baseline(s) trả — lệch hợp đồng T15↔T19, ghi docs/spec-gaps.md (T22). Test theo hành vi hiện tại.
    const doc = await api.get(`/document?source=baseline&baseline_id=${baseline.snapshot_ref}`)
    expect(doc.status, JSON.stringify(doc.body.error)).toBe(200)
    renderedDocumentSchema.parse(doc.body.data)
    expectDocx(await api.download(`/export/word?source=baseline&baseline_id=${baseline.snapshot_ref}`))

    const missing = await api.get("/document?source=baseline&baseline_id=650000000000000000000999")
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe("BASELINE_NOT_FOUND")

    expect(await Notification.countDocuments({ userId: seeded.userId, type: "baseline_created" })).toBe(1)
  })
})
