/**
 * FLF-413 — mẫu FPT Report3 có khung `3.2 <<Feature Name 1>> › 3.2.1 <<Function Name 1>>, 3.2.2 <<Function Name 2>>`,
 * `3.3 <<Feature Name 2>>`. Accept S-4.1 ⇒ tính năng / chức năng thật lấp vào khung (giữ id khung), khung thừa bỏ, phần dư
 * lặp heading theo khung; bản in không còn `<<…>>` ở heading.
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
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { applyTransaction } from "../../../src/modules/spine/op-engine.js"
import type { Op } from "../../../src/modules/spine/op.types.js"
import { parseDocument } from "../../../src/modules/import/parse.service.js"
import { readZipText } from "../../../src/modules/render/zip.test-helper.js"
import { isTemplateFrame, withFrameRenumber } from "../../../src/modules/spine/template-frames.js"
import { gate } from "../../../src/modules/pipeline/gate.service.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const REPORT3_TEMPLATE = new URL("../../../fixtures/fpt-report3-blank-template.docx", import.meta.url)
const H = (s: SeededFixture) => ({ Authorization: `Bearer ${s.token}` })

const setupReport3 = async () => {
  const seeded = await seedFixture("minimal", { balance: 5000 })
  const created = await request(app).post("/api/v1/projects").set(H(seeded)).send({ name: "Report3 frames", has_srs_file: true, complete_to_standard: false })
  expect(created.status, JSON.stringify(created.body.error)).toBe(201)
  const projectId = String(created.body.data._id)
  const uploaded = await request(app).post(`/api/v1/projects/${projectId}/import`).set(H(seeded)).attach("file", await readFile(REPORT3_TEMPLATE), "SRS.docx")
  expect(uploaded.status, JSON.stringify(uploaded.body.error)).toBe(201)
  const importId = String(uploaded.body.data.import.id)
  await acceptLatest((await ImportedDocument.findById(importId))!, true)
  await runExtraction(projectId, seeded.userId, importId)
  await startFinalize(projectId, seeded.userId, { import_id: importId, base_version: (await spineRepository.get(projectId))!.spine_version })
  await waitForFinalize(importId)
  return { seeded, projectId }
}

/** Bản nháp S-4.1 của model (mock): `features` tính năng, mỗi tính năng một màn + `perFeature` chức năng màn. */
const draftS41 = async (projectId: string, userId: string, features: number, perFeature: number) => {
  const spine = (await spineRepository.get(projectId))!
  const ops: Op[] = [{ op: "set", path: "steps[id=S-4.1].status", value: "in_progress" }]
  for (let i = 1; i <= features; i++) {
    ops.push({ op: "add", path: "features[]", value: { id: `RF${i}`, name: `Booking Area ${i}`, order: i - 1 } })
    ops.push({
      op: "add",
      path: "screens[]",
      value: { id: `RS${i}`, feature_id: `RF${i}`, name: `Booking Screen ${i}`, description: "", flow_to: [], is_popup: false, tabs: [], primary_function_id: null, queue_order: i, detail_status: "pending" }
    })
    for (let j = 1; j <= perFeature; j++) {
      ops.push({
        op: "add",
        path: "functions[]",
        value: { id: `RFN${i}${j}`, screen_id: `RS${i}`, feature_id: `RF${i}`, order: j - 1, name: `Book Slot ${i}.${j}`, trigger: "User clicks Book.", description: "Books a slot.", normal: ["User picks a slot."], abnormal: [], validations: [], business_rule_ids: [], priority: "must" }
      })
    }
  }
  return applyTransaction(projectId, { base_version: spine.spine_version, by: userId, step_id: "S-4.1", reason: "mock S-4.1 draft", ops: withFrameRenumber(spine, ops) })
}

const exportWord = async (projectId: string, seeded: SeededFixture): Promise<Buffer> => {
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
  return res.body as Buffer
}

describe("FLF-413 - khung tính năng / chức năng của mẫu Report3", () => {
  it("import tạo phần tử khung; accept S-4.1 lấp khung theo thứ tự file, khung thừa bỏ, phần dư lặp heading", async () => {
    const { seeded, projectId } = await setupReport3()
    const imported = (await spineRepository.get(projectId))!
    expect(imported.features.filter(isTemplateFrame).length).toBeGreaterThanOrEqual(2)

    await draftS41(projectId, seeded.userId, 3, 3)
    const drafted = (await spineRepository.get(projectId))!
    await gate(projectId, "S-4.1", seeded.userId, { action: "accept", base_version: drafted.spine_version })

    const spine = (await spineRepository.get(projectId))!
    expect(spine.features.some(isTemplateFrame)).toBe(false)
    const ordered = [...spine.features].sort((a, b) => a.order - b.order)
    expect(ordered.map((f) => f.name)).toEqual(["Booking Area 1", "Booking Area 2", "Booking Area 3"])
    // Tính năng 1, 2 giữ id khung của mẫu; tính năng 3 dư giữ id riêng
    const frameIds = imported.features.filter(isTemplateFrame).map((f) => f.id)
    expect(ordered.slice(0, 2).map((f) => f.id)).toEqual(frameIds.slice(0, 2))
    expect(ordered[2].id).toBe("RF3")
    // Màn trỏ đúng id khung
    expect(spine.screens.find((s) => s.id === "RS1")?.feature_id).toBe(frameIds[0])

    const exported = await exportWord(projectId, seeded)
    const headings = (await parseDocument(exported)).blocks.filter((b) => b.kind === "heading").map((b) => b.text)
    expect(headings.some((t) => /<<\s*(Feature|Function) Name/i.test(t))).toBe(false)
    // Khung giữ số gõ tay của mẫu; phần dư lặp theo định dạng khung (3.2.3, 3.4…)
    const chapter3 = headings.slice(headings.findIndex((t) => t.startsWith("3.2 ")), headings.findIndex((t) => t.startsWith("4.")))
    expect(chapter3).toEqual(["3.2 Booking Area 1", "3.2.1 Book Slot 1.1", "3.2.2 Book Slot 1.2", "3.2.3 Book Slot 1.3", "3.3 Booking Area 2", "3.3.1 Book Slot 2.1", "3.3.2 Book Slot 2.2", "3.3.3 Book Slot 2.3", "3.4 Booking Area 3", "3.4.1 Book Slot 3.1", "3.4.2 Book Slot 3.2", "3.4.3 Book Slot 3.3"])
    const at = (name: string) => headings.findIndex((t) => t.includes(name))
    expect(at("Booking Area 1")).toBeGreaterThan(0)
    expect(at("Book Slot 1.1")).toBeGreaterThan(at("Booking Area 1"))
    expect(at("Booking Area 2")).toBeGreaterThan(at("Book Slot 1.3"))
    expect(at("Booking Area 3")).toBeGreaterThan(at("Booking Area 2"))
    // Mục lục đánh dấu cập nhật khi mở file
    expect(readZipText(exported, "word/settings.xml")).toMatch(/updateFields/)

    // Sửa sau (01 §3.6): xoá tính năng đang ở khung 3.3 ⇒ heading khung bỏ; thêm tính năng mới ⇒ heading lặp theo khung, không lấp lại khung
    const second = frameIds[1]
    const removeOps: Op[] = [
      ...spine.functions.filter((f) => f.feature_id === second).map((f) => ({ op: "remove" as const, path: `functions[id=${f.id}]` })),
      ...spine.screens.filter((s) => s.feature_id === second).map((s) => ({ op: "remove" as const, path: `screens[id=${s.id}]` })),
      { op: "remove", path: `features[id=${second}]` },
      { op: "add", path: "features[]", value: { id: "RF9", name: "Loyalty Area", order: 9 } },
      { op: "add", path: "functions[]", value: { id: "RFN91", screen_id: null, feature_id: "RF9", order: 0, name: "Grant Points", trigger: "Nightly job.", description: "Grants points.", normal: ["System grants points."], abnormal: [], validations: [], business_rule_ids: [], priority: "should" } },
      { op: "renumber", path: "features[]" }
    ]
    await applyTransaction(projectId, { base_version: spine.spine_version, by: seeded.userId, step_id: null, reason: "CR", ops: removeOps })
    const afterCr = (await parseDocument(await exportWord(projectId, seeded))).blocks.filter((b) => b.kind === "heading").map((b) => b.text)
    expect(afterCr.some((t) => t.includes("Booking Area 2") || /<<\s*Feature Name/i.test(t))).toBe(false)
    const crAt = (name: string) => afterCr.findIndex((t) => t.includes(name))
    expect(crAt("Loyalty Area")).toBeGreaterThan(crAt("Booking Area 3"))
    expect(crAt("Grant Points")).toBeGreaterThan(crAt("Loyalty Area"))
  }, 180000)

  it("ít tính năng hơn khung ⇒ khung thừa bỏ khỏi Spine và bản in", async () => {
    const { seeded, projectId } = await setupReport3()
    const imported = (await spineRepository.get(projectId))!
    await draftS41(projectId, seeded.userId, 1, 1)
    const drafted = (await spineRepository.get(projectId))!
    await gate(projectId, "S-4.1", seeded.userId, { action: "accept", base_version: drafted.spine_version })
    const spine = (await spineRepository.get(projectId))!
    expect(spine.features.map((f) => f.name)).toEqual(["Booking Area 1"])
    // P4: hướng dẫn / kế hoạch step của khung đã bỏ không còn trong TemplateProfile
    const dropped = imported.features.filter((f) => isTemplateFrame(f) && !spine.features.some((g) => g.id === f.id)).map((f) => `feature:${f.id}`)
    expect(dropped.length).toBeGreaterThan(0)
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    expect((profile.template_context ?? []).some((c) => dropped.includes(c.section_id))).toBe(false)
    expect(profile.step_plan.some((p) => p.section_ids.some((id) => dropped.includes(id)))).toBe(false)

    const headings = (await parseDocument(await exportWord(projectId, seeded))).blocks.filter((b) => b.kind === "heading").map((b) => b.text)
    expect(headings.some((t) => /<<\s*Feature Name/i.test(t))).toBe(false)
    expect(headings.filter((t) => t.includes("Booking Area 1"))).toHaveLength(1)
  }, 180000)
})
