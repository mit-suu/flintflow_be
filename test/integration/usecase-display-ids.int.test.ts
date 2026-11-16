/**
 * FLF-420 — bảng use case (2.2.2) in mã liên tục theo thứ tự use case dù id Spine có lỗ / lệch thứ tự; Spine giữ nguyên id.
 * File khách đã viết (chế độ 1) giữ mã của file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../src/shared/ai/providers/llm.router.js", async () => (await import("../helpers/mock-llm.js")).mockLlmRouterModule())
import { readFile } from "node:fs/promises"
import request from "supertest"
import app from "../../src/app.js"
import { mockOverrides, resetMockLlm } from "../helpers/mock-llm.js"
import { fakeMode1 } from "../helpers/mode1.js"
import { seedFixture, type SeededFixture } from "../setup.js"
import * as spineRepository from "../../src/modules/spine/spine.repository.js"
import { runExtraction } from "../../src/modules/import/extract.service.js"
import { acceptLatest } from "../../src/modules/import/import.service.js"
import { startFinalize, waitForFinalize } from "../../src/modules/import/finalize-jobs.js"
import { ImportedDocument } from "../../src/modules/import/imported-document.model.js"
import { applyTransaction } from "../../src/modules/spine/op-engine.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const H = (s: SeededFixture) => ({ Authorization: `Bearer ${s.token}` })

interface Cell { text: string }
interface DocBlock { type: string; header?: Cell[][]; rows?: Cell[][][] }
interface DocSection { id: string; blocks: DocBlock[] }

const text = (cell: Cell[] | undefined) => (cell ?? []).map((r) => r.text).join("").trim()

/** Cột đầu của bảng use case (bảng có cột "Use Case") trong tài liệu. */
const useCaseIdsOf = (sections: DocSection[]): string[] => {
  for (const s of sections) {
    for (const b of s.blocks) {
      if (b.type !== "table" || !b.header) continue
      const headers = b.header.map(text)
      if (!headers.some((h) => /^use case$/i.test(h))) continue
      return (b.rows ?? []).map((row) => text(row[0]))
    }
  }
  return []
}

const draft = async (seeded: SeededFixture, projectId: string): Promise<DocSection[]> => {
  const res = await request(app).get(`/api/v1/projects/${projectId}/document?source=draft`).set(H(seeded))
  expect(res.status, JSON.stringify(res.body.error)).toBe(200)
  return res.body.data.sections as DocSection[]
}

describe("FLF-420 - mã use case hiển thị", () => {
  it("dự án FlintFlow: id lệch thứ tự (UC24 sau UC05) + xoá giữa danh sách ⇒ bảng in UC01…UCn liên tục; Spine giữ id", async () => {
    const seeded = await seedFixture("full")
    const before = (await spineRepository.get(seeded.projectId))!
    const victim = before.use_cases[2]
    // Xoá một use case không bị tham chiếu bắt buộc (cascade gỡ khỏi includes / extends)
    const res = await request(app)
      .post(`/api/v1/projects/${seeded.projectId}/changes`)
      .set(H(seeded))
      .send({ base_version: before.spine_version, ops: [{ op: "remove", path: `use_cases[id=${victim.id}]` }], reason: "FLF-420 test" })
    expect(res.status, JSON.stringify(res.body.error)).toBeLessThan(300)
    const spine = (await spineRepository.get(seeded.projectId))!
    expect(spine.use_cases.some((u) => u.id === victim.id)).toBe(false)

    const printed = useCaseIdsOf(await draft(seeded, seeded.projectId))
    expect(printed).toEqual(spine.use_cases.map((_, i) => `UC${String(i + 1).padStart(2, "0")}`))
    // Spine giữ nguyên id (có lỗ) — chỉ chữ in ra đổi
    expect(spine.use_cases.map((u) => u.id)).toEqual(before.use_cases.filter((u) => u.id !== victim.id).map((u) => u.id))
  }, 120000)

  it("dự án import SRS đã viết (chế độ 1) ⇒ giữ nguyên mã use case của file", async () => {
    const seeded = await seedFixture("minimal", { balance: 5000 })
    const created = await request(app).post("/api/v1/projects").set(H(seeded)).send({ name: "TechMart keep ids", has_srs_file: true, complete_to_standard: false })
    expect(created.status, JSON.stringify(created.body.error)).toBe(201)
    const projectId = String(created.body.data._id)
    const file = await readFile(new URL("../../fixtures/techmart-srs-fpt.docx", import.meta.url))
    const uploaded = await request(app).post(`/api/v1/projects/${projectId}/import`).set(H(seeded)).attach("file", file, "SRS.docx")
    expect(uploaded.status, JSON.stringify(uploaded.body.error)).toBe(201)
    const importId = String(uploaded.body.data.import.id)
    await acceptLatest((await ImportedDocument.findById(importId))!, true)
    await runExtraction(projectId, seeded.userId, importId)
    await startFinalize(projectId, seeded.userId, { import_id: importId, base_version: (await spineRepository.get(projectId))!.spine_version })
    await waitForFinalize(importId)

    const spine = (await spineRepository.get(projectId))!
    const printed = useCaseIdsOf(await draft(seeded, projectId)).filter(Boolean)
    expect(printed.length).toBeGreaterThan(0)
    // Mã in ra là đúng id Spine (mã của file, "UC-01"…), không bị đánh lại; thứ tự theo bảng của file
    const ids = new Set(spine.use_cases.map((u) => u.id))
    expect(printed.every((p) => ids.has(p))).toBe(true)
  }, 180000)
  it("khung mẫu Report3 (chế độ 3): use case FlintFlow cấp có lỗ (UC01, UC05) ⇒ bảng in UC01, UC02", async () => {
    const seeded = await seedFixture("minimal", { balance: 5000 })
    const created = await request(app).post("/api/v1/projects").set(H(seeded)).send({ name: "Report3 ids", has_srs_file: true, complete_to_standard: false })
    expect(created.status, JSON.stringify(created.body.error)).toBe(201)
    const projectId = String(created.body.data._id)
    const file = await readFile(new URL("../../fixtures/fpt-report3-blank-template.docx", import.meta.url))
    const uploaded = await request(app).post(`/api/v1/projects/${projectId}/import`).set(H(seeded)).attach("file", file, "SRS.docx")
    expect(uploaded.status, JSON.stringify(uploaded.body.error)).toBe(201)
    const importId = String(uploaded.body.data.import.id)
    await acceptLatest((await ImportedDocument.findById(importId))!, true)
    await runExtraction(projectId, seeded.userId, importId)
    await startFinalize(projectId, seeded.userId, { import_id: importId, base_version: (await spineRepository.get(projectId))!.spine_version })
    await waitForFinalize(importId)

    const spine = (await spineRepository.get(projectId))!
    const uc = (id: string, name: string) => ({ id, name, actor_ids: ["A01"], function_ids: [], description: `${name}.`, includes: [], extends: [] })
    await applyTransaction(projectId, {
      base_version: spine.spine_version,
      by: seeded.userId,
      step_id: null,
      reason: "S-3 mock",
      ops: [
        { op: "add", path: "actors[]", value: { id: "A01", name: "Customer", kind: "human", description: "Books courts." } },
        { op: "add", path: "use_cases[]", value: uc("UC01", "Book Court") },
        { op: "add", path: "use_cases[]", value: uc("UC05", "Cancel Booking") }
      ]
    })
    expect(useCaseIdsOf(await draft(seeded, projectId))).toEqual(["UC01", "UC02"])
  }, 180000)
})
