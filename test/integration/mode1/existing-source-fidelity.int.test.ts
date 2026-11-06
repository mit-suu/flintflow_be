/**
 * Dự án "Upload SRS có sẵn" (cấu trúc FlintFlow lẫn mẫu cố định của công ty), Mongo thật + AI mock:
 *  - chưa sửa gì ⇒ bản 0.1 và `export/word` bản nháp có **chữ y hệt file upload** (bìa, lịch sử, từng mục), chỉ thêm stamp +
 *    watermark DRAFT; bảng lịch sử không có dòng "Import SRS …" / "Baseline 0.1 signed";
 *  - SRS mẫu công ty có field (chú thích hình SEQ) + bookmark `_Ref` không còn làm hỏng cả lượt tạo bản 0.1 (422);
 *  - sau một thay đổi (như CR ghi): chỉ mục bị sửa dựng lại, mục khác giữ nguyên, lịch sử thêm đúng 1 dòng cuối bảng gốc.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import { readFile } from "node:fs/promises"
import request from "supertest"
import app from "../../../src/app.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { seedFixture, type SeededFixture } from "../../setup.js"
import { fileOf } from "../../helpers/mode1-import-p4.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { acceptLatest, uploadImport } from "../../../src/modules/import/import.service.js"
import { startFinalize, waitForFinalize } from "../../../src/modules/import/finalize-jobs.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { downloadVersion } from "../../../src/modules/doc-version/versions.service.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { applyTransaction } from "../../../src/modules/spine/op-engine.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { DocxPackage } from "../../../src/modules/docx-ooxml/index.js"
import { wAll } from "../../../src/modules/docx-ooxml/xml.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const FPT_SRS = new URL("../../../fixtures/existing-srs-fu-student-portal.docx", import.meta.url)
const COMPANY_SRS = new URL("../../../fixtures/company-template-srs-filled.docx", import.meta.url)

/** Đoạn / ô bảng của thân tài liệu theo thứ tự — so chữ (bỏ khác biệt cách ghi ký tự XML). */
const textsOf = async (buffer: Buffer): Promise<string[]> => {
  const xml = await (await DocxPackage.load(buffer)).requireXml("word/document.xml")
  return wAll(xml, "p").map((p) => wAll(p, "t").map((t) => t.textContent ?? "").join("")).filter((t) => t.trim())
}

const headerText = async (buffer: Buffer): Promise<string> => {
  const pkg = await DocxPackage.load(buffer)
  const parts = pkg.partNames().filter((n) => /^word\/header\d+\.xml$/.test(n))
  return (await Promise.all(parts.map(async (n) => (await pkg.requireXml(n)).toString()))).join("")
}

const importExisting = async (source: URL, intent: "free" | "fixed") => {
  const seeded = await seedFixture("minimal", { balance: 5000 })
  const created = await request(app).post("/api/v1/projects").set("Authorization", `Bearer ${seeded.token}`).send({ name: "FU Student Portal", source: "existing" })
  expect(created.status, JSON.stringify(created.body.error)).toBe(201)
  const projectId = String(created.body.data._id)
  const original = await readFile(source)
  const doc = await uploadImport(projectId, seeded.userId, fileOf(original, "SRS.docx"), { intent })
  await acceptLatest(doc, true)
  await runExtraction(projectId, seeded.userId, String(doc._id))
  const version = async () => (await spineRepository.get(projectId))!.spine_version
  await startFinalize(projectId, seeded.userId, { import_id: String(doc._id), base_version: await version() })
  await waitForFinalize(String(doc._id))
  if ((await ImportedDocument.findById(doc._id))!.status === "incomplete") {
    await startFinalize(projectId, seeded.userId, { import_id: String(doc._id), base_version: await version(), complete: true })
    await waitForFinalize(String(doc._id))
  }
  expect((await ImportedDocument.findById(doc._id))!.status).toBe("gap_review")
  return { seeded, projectId, original, version }
}

const exportDraft = async (seeded: SeededFixture, projectId: string): Promise<Buffer> => {
  const res = await request(app)
    .get(`/api/v1/projects/${projectId}/export/word?source=draft`)
    .set("Authorization", `Bearer ${seeded.token}`)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = []
      r.on("data", (c: Buffer) => chunks.push(c))
      r.on("end", () => cb(null, Buffer.concat(chunks)))
    })
  expect(res.status, (res.body as Buffer).toString().slice(0, 300)).toBe(200)
  return res.body as Buffer
}

describe("Upload SRS có sẵn — tải về giống file upload", () => {
  it.each([
    ["cấu trúc FlintFlow (chế độ 1)", FPT_SRS, "free" as const],
    ["mẫu cố định của công ty, có field + bookmark", COMPANY_SRS, "fixed" as const]
  ])("%s: chưa sửa gì ⇒ bản 0.1 và bản nháp có chữ y hệt file upload, kèm watermark DRAFT", async (_label, source, intent) => {
    const { seeded, projectId, original } = await importExisting(source, intent)
    const project = (await Project.findById(projectId).lean())!
    const expected = await textsOf(original)

    const v01 = await downloadVersion(projectId, "FU Student Portal", "0.1", "auto", { project })
    expect(await textsOf(v01.data)).toEqual(expected)
    expect(await headerText(v01.data)).toContain('string="DRAFT"')

    const draft = await exportDraft(seeded, projectId)
    expect(await textsOf(draft)).toEqual(expected)
    const joined = (await textsOf(draft)).join("\n")
    expect(joined).not.toContain("Import SRS")
    expect(joined).not.toMatch(/Baseline 0\.1 signed/)
  })

  it("SRS đủ mục + chọn 'Theo một mẫu cố định': heading tính năng chỉ chứa chức năng con không bị coi là còn trống ⇒ không dừng ở kết quả đọc", async () => {
    const seeded = await seedFixture("minimal", { balance: 5000 })
    const created = await request(app).post("/api/v1/projects").set("Authorization", `Bearer ${seeded.token}`).send({ name: "FU Student Portal", source: "existing" })
    const projectId = String(created.body.data._id)
    const doc = await uploadImport(projectId, seeded.userId, fileOf(await readFile(FPT_SRS), "SRS.docx"), { intent: "fixed" })
    await acceptLatest(doc, true)
    await runExtraction(projectId, seeded.userId, String(doc._id))
    await startFinalize(projectId, seeded.userId, { import_id: String(doc._id), base_version: (await spineRepository.get(projectId))!.spine_version })
    await waitForFinalize(String(doc._id))
    const { getImportView } = await import("../../../src/modules/import/import.service.js")
    const structure = (await getImportView(projectId)).target_structure!
    const missing = structure.sections.filter((s) => s.status === "missing").map((s) => s.title)
    expect(missing, "3.2 Course Registration / 3.3 Attendance… chỉ là heading bao của chức năng con").toEqual([])
    expect((await ImportedDocument.findById(doc._id))!.status).toBe("gap_review")
  })

  it("sau một thay đổi: chỉ mục bị sửa dựng lại, mục khác giữ nguyên, lịch sử thêm đúng 1 dòng cuối bảng gốc", async () => {
    const { seeded, projectId, original, version } = await importExisting(FPT_SRS, "free")
    const spine = (await spineRepository.get(projectId))!
    const rule = spine.business_rules[0]
    expect(rule).toBeTruthy()
    const statement = "Registration closes at 23:59 on the last day of the registration period."
    await applyTransaction(projectId, {
      base_version: await version(), by: seeded.userId, reason: "CR-001 Update registration closing time", step_id: null,
      ops: [{ op: "set", path: `business_rules[id=${rule.id}].statement`, value: statement }]
    })

    const before = await textsOf(original)
    const after = await textsOf(await exportDraft(seeded, projectId))
    expect(after.join("\n")).toContain(statement)
    expect(after.join("\n")).not.toContain(rule.statement)
    // Mọi đoạn của file gốc vẫn còn, trừ đoạn / ô chứa quy tắc cũ
    const removed = before.filter((t) => !after.includes(t))
    expect(removed.every((t) => t.includes(rule.statement) || rule.statement.includes(t))).toBe(true)
    // Lịch sử: đúng một dòng mới (lý do của thay đổi), các dòng gốc giữ nguyên
    expect(after.filter((t) => t.includes("CR-001 Update registration closing time"))).toHaveLength(1)
    expect(after.join("\n")).not.toContain("Import SRS")
  })
})
