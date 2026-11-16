import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  requireVersion: vi.fn(), list: vi.fn(), loadBaseline: vi.fn(), render: vi.fn(),
  load: vi.fn(), save: vi.fn(), update: vi.fn(), profile: vi.fn(), baseline: vi.fn(), refs: vi.fn(), versionFind: vi.fn(), resolveCurrent: vi.fn()
}))
vi.mock("./doc-version.service.js", () => ({ requireDocVersion: m.requireVersion, listDocVersions: m.list, fileBlocksOfVersion: vi.fn() }))
vi.mock("./doc-version.model.js", () => ({ DocVersion: { updateOne: m.update, find: m.versionFind } }))
vi.mock("../spine/baseline.model.js", () => ({ Baseline: { findOne: m.baseline } }))
vi.mock("../spine/spine.repository.js", () => ({ listBaselineRefs: m.refs }))
vi.mock("./doc-file.store.js", () => ({ docFileStore: () => ({ load: m.load, save: m.save, remove: vi.fn() }) }))
vi.mock("../render/assemble.service.js", () => ({ loadBaselineSpine: m.loadBaseline }))
vi.mock("../render/project-docx-writer.js", () => ({ loadFixedTemplateContext: m.resolveCurrent }))
vi.mock("./render-version.js", () => ({ renderVersionFile: m.render }))
vi.mock("../spine/spine.schema.js", () => ({ spineSchema: { safeParse: (value: unknown) => ({ success: !!value, data: value }) } }))
vi.mock("../project/project.model.js", () => ({ TEMPLATE_INTENTS: ["fixed", "free"], Project: { findById: () => ({ lean: async () => ({ template_intent: "fixed" }) }) } }))
vi.mock("../import/template-profile.model.js", () => ({ TemplateProfile: { findOne: m.profile } }))
vi.mock("../import/convert-from-fpt.service.js", () => ({ CONVERT_STAMP_SOURCE: "convert" }))
vi.mock("../translation/translation.service.js", () => ({ assertTranslationComplete: vi.fn(), documentLanguageUnavailable: vi.fn(), projectLanguages: vi.fn() }))
vi.mock("../docx-ooxml/index.js", () => ({
  DocxPackage: { load: async (data: Buffer) => ({ toBuffer: async () => data }) },
  addDraftWatermark: vi.fn(), readStamp: async () => null, writeStamp: vi.fn()
}))

import { addDraftWatermark } from "../docx-ooxml/index.js"
import { downloadVersion } from "./versions.service.js"
import { captureTemplateSourceBinding, resolveFixedBaselineBinding, FIXED_TEMPLATE_RENDERER_REVISION } from "./template-source-binding.js"

const binding = { source_file_ref: "original-upload", source_sha256: "sha", layout: [{ section_id: "old-layout" }] }
const base = { _id: "version-id", version: "0.1", kind: "imported", file_ref: "old-generic", baseline_ref: "BL001", createdAt: new Date(), cr_ids: [], based_on: null }

beforeEach(() => {
  vi.clearAllMocks()
  m.list.mockResolvedValue([base])
  m.save.mockResolvedValue("new-cache")
  m.render.mockResolvedValue(Buffer.from("fixed-template"))
  m.loadBaseline.mockResolvedValue({ historical: true })
})

describe("fixed version downloads", () => {
  it("renders the historical baseline with its saved source and caches separately", async () => {
    m.requireVersion.mockResolvedValue({ ...base, template_source: binding })
    const out = await downloadVersion("project", "Demo", "0.1", "auto")
    expect(out.data.toString()).toBe("fixed-template")
    expect(m.loadBaseline).toHaveBeenCalledWith("project", "BL001")
    expect(m.render).toHaveBeenCalledWith("project", "Demo", { historical: true }, expect.objectContaining({ templateSource: binding }))
    expect(m.update).toHaveBeenCalledWith({ _id: "version-id" }, { $set: { fixed_render_cache: { revision: FIXED_TEMPLATE_RENDERER_REVISION, file_ref: "new-cache" } } })
    expect(m.load).not.toHaveBeenCalledWith("old-generic")
    expect(m.profile).not.toHaveBeenCalled()
  })

  it("uses the CR snapshot and never substitutes a current or baseline Spine", async () => {
    m.requireVersion.mockResolvedValue({ ...base, kind: "cr_revision", baseline_ref: null, template_source: binding, spine_snapshot: { cr: "historical" } })
    await downloadVersion("project", "Demo", "0.1", "auto")
    expect(m.render).toHaveBeenCalledWith("project", "Demo", { cr: "historical" }, expect.anything())
    expect(m.loadBaseline).not.toHaveBeenCalled()
  })

  it("fails explicitly when the historical snapshot of a bound version is unavailable", async () => {
    m.requireVersion.mockResolvedValue({ ...base, kind: "cr_revision", baseline_ref: null, template_source: binding })
    await expect(downloadVersion("project", "Demo", "0.1", "auto")).rejects.toMatchObject({ code: "TEMPLATE_LAYOUT_UNAVAILABLE" })
    expect(m.render).not.toHaveBeenCalled()
    expect(m.profile).not.toHaveBeenCalled()
  })

  it("bản chưa phát hành (0.1) của mẫu bắt buộc tải về có watermark DRAFT; file gốc / bản đánh dấu thì không", async () => {
    m.requireVersion.mockResolvedValue({ ...base, template_source: binding, original_ref: "original" })
    m.load.mockImplementation(async (ref: string) => Buffer.from(ref))
    await downloadVersion("project", "Demo", "0.1", "auto")
    expect(addDraftWatermark).toHaveBeenCalledTimes(1)
    vi.mocked(addDraftWatermark).mockClear()
    await downloadVersion("project", "Demo", "0.1", "original")
    expect(addDraftWatermark).not.toHaveBeenCalled()
  })

  it("reuses only the current renderer revision artifact", async () => {
    m.requireVersion.mockResolvedValue({ ...base, template_source: binding, fixed_render_cache: { revision: FIXED_TEMPLATE_RENDERER_REVISION, file_ref: "cache" } })
    m.load.mockResolvedValue(Buffer.from("cached"))
    expect((await downloadVersion("project", "Demo", "0.1", "auto")).data.toString()).toBe("cached")
    expect(m.load).toHaveBeenCalledWith("cache")
    expect(m.render).not.toHaveBeenCalled()
  })

  it("keeps original and tracked downloads on their stored artifacts", async () => {
    m.requireVersion.mockResolvedValue({ ...base, original_ref: "original", tracked_file_ref: "tracked" })
    m.load.mockImplementation(async (ref: string) => Buffer.from(ref))
    expect((await downloadVersion("project", "Demo", "0.1", "original")).data.toString()).toBe("original")
    expect((await downloadVersion("project", "Demo", "0.1", "tracked")).data.toString()).toBe("tracked")
    expect(m.render).not.toHaveBeenCalled()
  })
})


describe("đường in theo từng version", () => {
  it("version không có binding (dự án tự do / FPT phát hành trước khi đổi mẫu) tải đúng file đã lưu dù dự án giờ là mẫu bắt buộc", async () => {
    m.requireVersion.mockResolvedValue({ ...base, kind: "release", version: "1.0", file_ref: "stored-1.0", clean_file_ref: "clean-1.0", template_source: null })
    m.list.mockResolvedValue([{ ...base, kind: "release", version: "1.0" }])
    m.load.mockImplementation(async (ref: string) => Buffer.from(ref))
    const out = await downloadVersion("project", "Demo", "1.0", "auto")
    expect(out.data.toString()).toBe("clean-1.0")
    expect(m.render).not.toHaveBeenCalled()
    expect(m.profile).not.toHaveBeenCalled()
  })

  it("version có binding in lại bằng mốc của chính nó, không đọc profile hiện tại", async () => {
    const anchored = { ...binding, fidelity_anchor: { source_based: true, by_id: false, spine: null } }
    m.requireVersion.mockResolvedValue({ ...base, template_source: anchored })
    await downloadVersion("project", "Demo", "0.1", "auto")
    expect(m.render).toHaveBeenCalledWith("project", "Demo", { historical: true }, expect.objectContaining({ templateSource: anchored }))
    expect(m.profile).not.toHaveBeenCalled()
  })
})

describe("captureTemplateSourceBinding", () => {
  it("captures a detached verified current binding when a legacy profile lacks its source reference", async () => {
    m.profile.mockReturnValue({ lean: async () => ({ heading_map: [{ block_id: "B1" }], layout: [{ section_id: "old" }] }) })
    const recovered = { ...binding, heading_map: [{ block_id: "B1" }], layout: [{ section_id: "repaired" }] }
    m.resolveCurrent.mockResolvedValue({ binding: recovered })
    const captured = await captureTemplateSourceBinding("project")
    expect(m.resolveCurrent).toHaveBeenCalledWith("project")
    expect(captured).toMatchObject(recovered)
    expect(captured?.fidelity_anchor).toBeTruthy()
    recovered.layout[0].section_id = "changed after capture"
    expect(captured?.layout[0].section_id).toBe("repaired")
    expect(captured?.source_file_ref).toBe("original-upload")
    expect(captured?.source_sha256).toBe("sha")
    expect(m.load).not.toHaveBeenCalled()
  })

  it("propagates unavailable or ambiguous current-source recovery without guessing", async () => {
    m.profile.mockReturnValue({ lean: async () => ({ heading_map: [{}], layout: [{}] }) })
    m.resolveCurrent.mockRejectedValue(Object.assign(new Error("Ambiguous source"), { code: "TEMPLATE_LAYOUT_UNAVAILABLE" }))
    await expect(captureTemplateSourceBinding("project")).rejects.toMatchObject({ code: "TEMPLATE_LAYOUT_UNAVAILABLE" })
    expect(m.load).not.toHaveBeenCalled()
  })

  it("captures raw source SHA and a detached mapping snapshot", async () => {
    const profile = { source_file_ref: "raw", heading_map: [{ block_id: "B1" }], table_map: [], layout: [{ section_id: "old" }], language: "en", template_family: "fpt" }
    m.profile.mockReturnValue({ lean: async () => profile })
    m.load.mockResolvedValue(Buffer.from("abc"))
    const captured = await captureTemplateSourceBinding("project")
    expect(captured?.source_sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    profile.layout[0].section_id = "new"
    expect(captured?.layout[0].section_id).toBe("old")
    expect(m.resolveCurrent).not.toHaveBeenCalled()
  })

  it("rejects bytes that no longer match the mapped source SHA", async () => {
    m.profile.mockReturnValue({ lean: async () => ({ ...binding, heading_map: [{}], source_sha256: "different" }) })
    m.load.mockResolvedValue(Buffer.from("abc"))
    await expect(captureTemplateSourceBinding("project")).rejects.toMatchObject({ code: "TEMPLATE_LAYOUT_UNAVAILABLE" })
    expect(m.resolveCurrent).not.toHaveBeenCalled()
  })
})


describe("resolveFixedBaselineBinding", () => {
  const baselineId = "650000000000000000000001"
  beforeEach(() => {
    m.refs.mockResolvedValue([{ id: "BL001", snapshot_ref: baselineId }])
    m.baseline.mockResolvedValue({ _id: baselineId, snapshot: { historical: true } })
    m.versionFind.mockReturnValue({ lean: async () => [{ ...base, template_source: binding }] })
  })

  it.each([undefined, "BL001", baselineId])("resolves the selected baseline (%s) through its unique version", async (id) => {
    expect(await resolveFixedBaselineBinding("project", id)).toBe(binding)
    expect(m.baseline).toHaveBeenCalledWith({ projectId: "project", ...(id ? { _id: baselineId } : {}) }, null, { lean: true, sort: { at: -1 } })
    expect(m.versionFind).toHaveBeenCalledWith({ projectId: "project", baseline_ref: { $in: [baselineId, "BL001"] } })
    expect(m.profile).not.toHaveBeenCalled()
  })

  it.each([[], [{ ...base }], [{ ...base, template_source: binding }, { ...base, template_source: binding }]].map((versions) => ({ versions })))("rejects absent, unbound, or ambiguous versions", async ({ versions }) => {
    m.versionFind.mockReturnValue({ lean: async () => versions })
    await expect(resolveFixedBaselineBinding("project", "BL001")).rejects.toMatchObject({ code: "TEMPLATE_LAYOUT_UNAVAILABLE" })
    expect(m.profile).not.toHaveBeenCalled()
    expect(m.resolveCurrent).not.toHaveBeenCalled()
  })
})
