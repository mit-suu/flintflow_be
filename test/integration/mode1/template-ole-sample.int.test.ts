/**
 * FLF-419 — mẫu FPT Report3: dưới `3.1.5 Entity Relationship Diagram` hình ERD mẫu là OLE nhúng (`w:object`). Dự án mới theo
 * khung mẫu có thực thể ⇒ bản in phải bỏ hình mẫu và in nội dung thật, không huỷ cả bản in (`TEMPLATE_LAYOUT_UNAVAILABLE`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import { readFile } from "node:fs/promises"
import request from "supertest"
import app from "../../../src/app.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { seedFixture, type SeededFixture } from "../../setup.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { acceptLatest } from "../../../src/modules/import/import.service.js"
import { startFinalize, waitForFinalize } from "../../../src/modules/import/finalize-jobs.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { applyTransaction } from "../../../src/modules/spine/op-engine.js"
import { readZipText } from "../../../src/modules/render/zip.test-helper.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const REPORT3_TEMPLATE = new URL("../../../fixtures/fpt-report3-blank-template.docx", import.meta.url)
const H = (s: SeededFixture) => ({ Authorization: `Bearer ${s.token}` })

describe("FLF-419 - hình mẫu OLE của khung mẫu", () => {
  it("Report3 có thực thể ở 3.1.5 ⇒ xuất Word được, hình ERD mẫu (OLE) bị bỏ, bảng thực thể in", async () => {
    const seeded = await seedFixture("minimal", { balance: 5000 })
    const created = await request(app).post("/api/v1/projects").set(H(seeded)).send({ name: "Report3 OLE", has_srs_file: true, complete_to_standard: false })
    expect(created.status, JSON.stringify(created.body.error)).toBe(201)
    const projectId = String(created.body.data._id)
    const uploaded = await request(app).post(`/api/v1/projects/${projectId}/import`).set(H(seeded)).attach("file", await readFile(REPORT3_TEMPLATE), "SRS.docx")
    expect(uploaded.status, JSON.stringify(uploaded.body.error)).toBe(201)
    const importId = String(uploaded.body.data.import.id)
    await acceptLatest((await ImportedDocument.findById(importId))!, true)
    await runExtraction(projectId, seeded.userId, importId)
    await startFinalize(projectId, seeded.userId, { import_id: importId, base_version: (await spineRepository.get(projectId))!.spine_version })
    await waitForFinalize(importId)

    const spine = (await spineRepository.get(projectId))!
    await applyTransaction(projectId, {
      base_version: spine.spine_version,
      by: seeded.userId,
      step_id: null,
      reason: "S-4.5 mock",
      ops: [
        { op: "add", path: "entities[]", value: { id: "E01", name: "Court Booking FLF419", description: "A court slot booked by a customer.", relations: [], attributes: [{ name: "slot start", kind: "plain", required: true }], feature_ids: [] } }
      ]
    })

    const res = await request(app)
      .get(`/api/v1/projects/${projectId}/export/word?source=draft`)
      .set(H(seeded))
      .buffer(true)
      .parse((r, callback) => {
        const chunks: Buffer[] = []
        r.on("data", (chunk: Buffer) => chunks.push(chunk))
        r.on("end", () => callback(null, Buffer.concat(chunks)))
      })
    expect(res.status, String(res.body)).toBe(200)
    const xml = readZipText(res.body as Buffer, "word/document.xml")
    expect(xml).toContain("Court Booking FLF419")
    // Hình ERD mẫu là OLE duy nhất của mẫu dưới 3.1.5 — đã bỏ
    const at = xml.indexOf("Entity Relationship Diagram")
    const next = xml.indexOf("Court Booking FLF419", at)
    expect(xml.slice(at, next)).not.toContain("<w:object")
  }, 180000)
})
