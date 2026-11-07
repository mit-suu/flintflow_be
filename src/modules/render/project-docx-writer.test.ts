import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RenderedDocument } from "./rendered-document.types.js"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { parseDocument } from "../import/parse.service.js"
import { matchProfile } from "../import/profile-match.service.js"
import { buildLayout } from "../import/step-plan.js"
import { readZipEntries } from "./zip.test-helper.js"

const mocks = vi.hoisted(() => ({ project: vi.fn(), profile: vi.fn(), imported: vi.fn(), load: vi.fn(), generic: vi.fn(), template: vi.fn() }))
vi.mock("../project/project.model.js", () => ({ Project: { findById: () => ({ lean: mocks.project }) } }))
vi.mock("../import/template-profile.model.js", () => ({ TemplateProfile: { findOne: () => ({ lean: mocks.profile }) } }))
vi.mock("../import/imported-document.model.js", () => ({ ImportedDocument: { find: (...args: unknown[]) => ({ lean: () => mocks.imported(...args) }) } }))
vi.mock("../doc-version/doc-file.store.js", () => ({ docFileStore: () => ({ load: mocks.load }) }))
vi.mock("./docx-writer.js", () => ({ writeDocx: mocks.generic }))
vi.mock("./template-docx-writer.js", () => ({ writeTemplateDocx: mocks.template }))

import { templateHeadingMap, writeProjectDocx } from "./project-docx-writer.js"

const doc = { projectId: "project", sections: [] } as unknown as RenderedDocument
const templateBytes = readFileSync(new URL("../../../fixtures/fixed-template-fu-it-srs-01.docx", import.meta.url))
let headingMap: ReturnType<typeof matchProfile>["heading_map"] = []
let layout: ReturnType<typeof buildLayout>["layout"] = []

beforeEach(async () => {
  vi.resetAllMocks()
  const parsed = await parseDocument(templateBytes)
  headingMap = matchProfile(parsed.blocks).heading_map
  layout = buildLayout(parsed.blocks.map((b) => ({ ...b, section_id: null })), new Map(headingMap.map((h) => [h.block_id, h.section_id]))).layout
  mocks.project.mockResolvedValue({ template_intent: "fixed", mode: "fpt" })
  mocks.profile.mockResolvedValue({ source_file_ref: "source", heading_map: headingMap, layout })
  mocks.load.mockResolvedValue(templateBytes)
  mocks.imported.mockResolvedValue([{ file_ref: "legacy-source", sha256: createHash("sha256").update(templateBytes).digest("hex") }])
  mocks.template.mockResolvedValue(Buffer.from("filled"))
  mocks.generic.mockResolvedValue(Buffer.from("generic"))
})

describe("writeProjectDocx", () => {
  it("dự án chế độ 3 đã sang mode fpt vẫn dùng đúng file tạo mapping, không dùng upload mới nhất", async () => {
    expect(await writeProjectDocx(doc)).toEqual(Buffer.from("filled"))
    expect(mocks.load).toHaveBeenCalledWith("source")
    expect(mocks.template).toHaveBeenCalledWith(doc, templateBytes, expect.arrayContaining([{ block_id: headingMap.find((h) => h.heading_text === "1.1 Purpose")!.block_id, section_id: "slot:vision" }]), undefined, { stripTemplateText: false })
    expect(mocks.imported).not.toHaveBeenCalled()
    expect(mocks.generic).not.toHaveBeenCalled()
  })

  it("hồ sơ cũ tìm file import đã tạo bố cục, loại upload bị từ chối/chưa xử lý", async () => {
    mocks.profile.mockResolvedValue({ heading_map: headingMap, layout })
    await writeProjectDocx(doc)
    expect(mocks.load).toHaveBeenCalledWith("legacy-source")
    expect(mocks.imported).toHaveBeenCalledWith(expect.objectContaining({ "preflight.status": "accepted", status: { $in: expect.arrayContaining(["drafting", "incomplete"]) } }), expect.anything())
  })

  it.each([null, { heading_map: headingMap, layout: [] }])("mẫu bắt buộc thiếu hồ sơ ⇒ báo lỗi rõ ràng, không âm thầm đổi format", async (profile) => {
    mocks.profile.mockResolvedValue(profile)
    await expect(writeProjectDocx(doc)).rejects.toMatchObject({ statusCode: 409, code: "TEMPLATE_LAYOUT_UNAVAILABLE" })
    expect(mocks.generic).not.toHaveBeenCalled()
  })

  it("file mẫu không đọc được ⇒ báo lỗi, không dựng DOCX mặc định", async () => {
    mocks.load.mockRejectedValue(new Error("missing"))
    await expect(writeProjectDocx(doc)).rejects.toMatchObject({ code: "TEMPLATE_LAYOUT_UNAVAILABLE" })
    expect(mocks.generic).not.toHaveBeenCalled()
  })

  it("bản làm việc (source = draft) của mẫu bắt buộc có watermark DRAFT; baseline giữ nguyên byte của bản điền", async () => {
    mocks.template.mockResolvedValue(templateBytes)
    const headers = (buf: Buffer) => [...readZipEntries(buf)].filter(([name]) => /^word\/header\d+\.xml$/.test(name)).map(([, data]) => data.toString("utf8"))
    const draft = await writeProjectDocx({ ...doc, source: "draft", watermark: "DRAFT" } as RenderedDocument)
    expect(headers(templateBytes)).toEqual([])
    expect(headers(draft).some((xml) => xml.includes('string="DRAFT"'))).toBe(true)
    // Mẫu giữ nguyên: styles / numbering không đổi, chỉ thêm header chứa watermark
    for (const name of ["word/styles.xml", "word/numbering.xml"]) expect(readZipEntries(draft).get(name)).toEqual(readZipEntries(templateBytes).get(name))
    expect(await writeProjectDocx({ ...doc, source: "baseline" } as RenderedDocument)).toBe(templateBytes)
  })

  it("dự án không có mẫu bắt buộc vẫn nhận đúng writer options cũ", async () => {
    mocks.project.mockResolvedValue({ template_intent: null })
    const options = { flagLanguage: "vi" as const, tocEntries: true }
    expect(await writeProjectDocx(doc, options)).toEqual(Buffer.from("generic"))
    expect(mocks.generic).toHaveBeenCalledWith(doc, options)
    expect(mocks.profile).not.toHaveBeenCalled()
  })

  it("heading chưa map/lặp nhận custom id đúng như layout, phần nối không chiếm heading", () => {
    expect(templateHeadingMap([
      { block_id: "B1", heading_text: "Overview", section_id: "unmapped" },
      { block_id: "B2", heading_text: "Reliability", section_id: "fixed:4.2.2" },
      { block_id: "B3", heading_text: "Availability", section_id: "fixed:4.2.2" }
    ], [
      { order: 0, level: 1, heading_text: "Overview", section_id: "custom:C01" },
      { order: 1, level: 2, heading_text: "", section_id: "custom:C02" },
      { order: 2, level: 2, heading_text: "Reliability", section_id: "fixed:4.2.2" },
      { order: 3, level: 2, heading_text: "Availability", section_id: "custom:C03" }
    ])).toEqual([
      { block_id: "B1", section_id: "custom:C01" },
      { block_id: "B2", section_id: "fixed:4.2.2" },
      { block_id: "B3", section_id: "custom:C03" }
    ])
  })
})
