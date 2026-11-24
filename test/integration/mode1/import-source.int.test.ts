/**
 * `GET /projects/:id/import/source` - chữ gốc của file theo mục cho màn đọc file: đúng thứ tự trong file, bảng thành hàng,
 * ETag + 304, người ngoài không đọc được.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import { readFile } from "node:fs/promises"
import request from "supertest"
import app from "../../../src/app.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { seedFixture, type SeededFixture } from "../../setup.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const WRITTEN_SRS = new URL("../../../fixtures/existing-srs-fu-student-portal.docx", import.meta.url)
const H = (s: SeededFixture) => ({ Authorization: `Bearer ${s.token}` })

const createProject = async (seeded: SeededFixture): Promise<string> => {
  const created = await request(app).post("/api/v1/projects").set(H(seeded)).send({ name: "Warehouse XYZ", has_srs_file: true })
  expect(created.status, JSON.stringify(created.body.error)).toBe(201)
  return String(created.body.data._id)
}

const upload = async () => {
  const seeded = await seedFixture("minimal", { balance: 5000 })
  const projectId = await createProject(seeded)
  const uploaded = await request(app).post(`/api/v1/projects/${projectId}/import`).set(H(seeded)).attach("file", await readFile(WRITTEN_SRS), "SRS.docx")
  expect(uploaded.status, JSON.stringify(uploaded.body.error)).toBe(201)
  return { seeded, projectId, importId: String(uploaded.body.data.import.id) }
}

interface SourceSection {
  section_id: string
  title: string
  level: number
  blocks: { block_id: string; kind: string; text: string }[]
}

describe("GET /import/source", () => {
  it("trả chữ gốc theo mục đúng thứ tự file, không có ô / hàng bảng rời; ETag + If-None-Match cho 304", async () => {
    const { seeded, projectId, importId } = await upload()
    const url = `/api/v1/projects/${projectId}/import/source`
    const res = await request(app).get(url).set(H(seeded))
    expect(res.status).toBe(200)
    expect(res.body.data.import_id).toBe(importId)
    const sections = res.body.data.sections as SourceSection[]
    expect(sections.length).toBeGreaterThan(1)
    const blocks = sections.flatMap((s) => s.blocks)
    expect(blocks.every((b) => b.kind !== "table_cell" && b.kind !== "table_row")).toBe(true)
    expect(sections.every((s) => s.title.trim().length > 0)).toBe(true)

    // trong từng mục, block theo thứ tự `anchor.ordinal` của file
    const stored = await DocBlock.find({ projectId }).sort({ "anchor.ordinal": 1 }).select("block_id").lean()
    const order = new Map(stored.map((b, i) => [b.block_id, i]))
    for (const s of sections) {
      const own = s.blocks.map((b) => order.get(b.block_id)!)
      expect(own.every((o) => o !== undefined)).toBe(true)
      expect([...own].sort((a, b) => a - b)).toEqual(own)
    }
    const table = blocks.find((b) => b.kind === "table")
    if (table) expect(table.text.split("\n").every((line) => line.startsWith("| "))).toBe(true)

    const etag = res.headers.etag
    expect(etag).toBeTruthy()
    const again = await request(app).get(url).set(H(seeded)).set("If-None-Match", etag)
    expect(again.status).toBe(304)
    const stale = await request(app).get(url).set(H(seeded)).set("If-None-Match", '"khac"')
    expect(stale.status).toBe(200)
  })

  it("chưa upload thì 404 IMPORT_NOT_FOUND; không đăng nhập thì 401", async () => {
    const seeded = await seedFixture("minimal", { balance: 5000 })
    const projectId = await createProject(seeded)
    const empty = await request(app).get(`/api/v1/projects/${projectId}/import/source`).set(H(seeded))
    expect(empty.status).toBe(404)
    expect(empty.body.error.code).toBe("IMPORT_NOT_FOUND")
    expect((await request(app).get(`/api/v1/projects/${projectId}/import/source`)).status).toBe(401)
  })
})
