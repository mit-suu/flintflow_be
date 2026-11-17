import { describe, it, expect, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => {
  const deleteMany = () => vi.fn(async (_filter: unknown) => ({ deletedCount: 1 }))
  return {
    Project: { findOneAndDelete: vi.fn(), findOneAndUpdate: vi.fn(), exists: vi.fn(), deleteOne: vi.fn(), create: vi.fn(), find: vi.fn(), findOne: vi.fn(), countDocuments: vi.fn(async () => 0) },
    /** Thứ tự gọi trong `purgeProject`: dọn dữ liệu xong mới xoá bản ghi dự án (QLHS #1). */
    order: [] as string[],
    // UC-16: gói active của org — null ⇒ Free
    subscriptionPlan: vi.fn(async (): Promise<{ plan: string } | null> => null),
    ChatSession: { deleteMany: deleteMany() },
    ProjectDocument: {
      deleteMany: deleteMany(),
      find: vi.fn(() => ({ select: () => ({ lean: async () => [{ cloudinaryPublicId: "flintflow/brief" }, { cloudinaryPublicId: "flintflow/notes" }] }) }))
    },
    // QLHS #1: purge đọc Spine thô (`findOne().select().lean()`), không qua zod
    spineRaw: vi.fn(async (): Promise<unknown> => ({ diagrams: [{ id: "D01" }, { id: "D02" }] })),
    Spine: { deleteMany: deleteMany(), findOne: vi.fn() },
    Change: { deleteMany: deleteMany() },
    Baseline: { deleteMany: deleteMany() },
    Usage: { deleteMany: deleteMany() },
    RenderedDocumentCache: { deleteMany: deleteMany() },
    getSpine: vi.fn(),
    getOrCreate: vi.fn(),
    removeDiagram: vi.fn(async () => {}),
    removeDocFiles: vi.fn(async () => {}),
    // Mode 1 (FLF-171)
    ImportedDocument: { deleteMany: deleteMany() },
    DocBlock: { deleteMany: deleteMany() },
    TemplateProfile: { deleteMany: deleteMany(), updateOne: vi.fn() },
    ExtractionDraft: { deleteMany: deleteMany() },
    FieldAnchor: { deleteMany: deleteMany() },
    ReuploadDiff: { deleteMany: deleteMany() },
    DocVersion: { deleteMany: deleteMany() },
    ChangeRequest: { deleteMany: deleteMany() },
    CrCounter: { deleteMany: deleteMany() },
    ChangeLocation: { deleteMany: deleteMany() },
    ChangeGroup: { deleteMany: deleteMany() },
    // FLF-265: lớp bản dịch
    SpineTranslation: { deleteMany: deleteMany() },
    TranslationGlossary: { deleteMany: deleteMany() },
    TranslationRunLock: { deleteMany: deleteMany() },
    // Comment + đổi mẫu (FLF-422)
    Comment: { deleteMany: deleteMany() },
    CommentCounter: { deleteMany: deleteMany() },
    TemplateMigration: { deleteMany: deleteMany() },
    // QLHS #2 + collection theo dự án còn sót
    StepRun: { deleteMany: deleteMany() },
    AutoPass: { deleteMany: deleteMany() },
    SpineLock: { deleteMany: deleteMany() },
    SpineEmbedding: { deleteMany: deleteMany() },
    RequirementExtraction: { deleteMany: deleteMany() },
    ScreenMockupRun: { deleteMany: deleteMany() },
    ProjectDocumentChunk: { deleteMany: deleteMany() },
    RequirementSource: { deleteMany: deleteMany() },
    GoogleDocLink: { deleteMany: deleteMany() },
    destroyDocumentAsset: vi.fn(async () => true),
    // FLF-265: ngôn ngữ tài khoản — null = chưa chọn
    accountLocaleOf: vi.fn(async (_userId: string): Promise<"vi" | "en" | null> => null)
  }
})

vi.mock("./project.model.js", () => ({ Project: mocks.Project, WITH_DELETED: { withDeleted: true } }))
vi.mock("./chat-session.model.js", () => ({ ChatSession: mocks.ChatSession }))
vi.mock("./project-document.model.js", () => ({ ProjectDocument: mocks.ProjectDocument }))
vi.mock("./project-document.storage.js", () => ({ destroyDocumentAsset: mocks.destroyDocumentAsset }))
vi.mock("../spine/spine.model.js", () => ({ Spine: mocks.Spine }))
vi.mock("../spine/change.model.js", () => ({ Change: mocks.Change }))
vi.mock("../spine/baseline.model.js", () => ({ Baseline: mocks.Baseline }))
vi.mock("../spine/usage.model.js", () => ({ Usage: mocks.Usage }))
vi.mock("../render/rendered-document.model.js", () => ({ RenderedDocumentCache: mocks.RenderedDocumentCache }))
vi.mock("../spine/spine.repository.js", () => ({ get: mocks.getSpine, getOrCreate: mocks.getOrCreate }))
vi.mock("../diagram/diagram-file.store.js", () => ({ gridFsDiagramStore: { remove: mocks.removeDiagram } }))
vi.mock("../import/imported-document.model.js", () => ({ ImportedDocument: mocks.ImportedDocument }))
vi.mock("../import/doc-block.model.js", () => ({ DocBlock: mocks.DocBlock }))
vi.mock("../import/template-profile.model.js", () => ({ TemplateProfile: mocks.TemplateProfile }))
vi.mock("../import/extraction-draft.model.js", () => ({ ExtractionDraft: mocks.ExtractionDraft }))
vi.mock("../import/field-anchor.model.js", () => ({ FieldAnchor: mocks.FieldAnchor }))
vi.mock("../import/reupload-diff.model.js", () => ({ ReuploadDiff: mocks.ReuploadDiff }))
vi.mock("../doc-version/doc-version.model.js", () => ({ DocVersion: mocks.DocVersion }))
vi.mock("../doc-version/doc-file.store.js", () => ({ docFileStore: () => ({ removeProject: mocks.removeDocFiles }) }))
vi.mock("../change-request/change-request.model.js", () => ({ ChangeRequest: mocks.ChangeRequest, CrCounter: mocks.CrCounter }))
vi.mock("../change-request/change-location.model.js", () => ({ ChangeLocation: mocks.ChangeLocation }))
vi.mock("../change-request/change-group.model.js", () => ({ ChangeGroup: mocks.ChangeGroup }))
vi.mock("../translation/spine-translation.model.js", () => ({ SpineTranslation: mocks.SpineTranslation }))
vi.mock("../translation/translation-glossary.model.js", () => ({ TranslationGlossary: mocks.TranslationGlossary }))
vi.mock("../translation/translation-run-lock.model.js", () => ({ TranslationRunLock: mocks.TranslationRunLock }))
vi.mock("../comment/comment.model.js", () => ({ Comment: mocks.Comment, CommentCounter: mocks.CommentCounter }))
vi.mock("../template-migration/template-migration.model.js", () => ({ TemplateMigration: mocks.TemplateMigration }))
vi.mock("../pipeline/run-state.model.js", () => ({ StepRun: mocks.StepRun }))
vi.mock("../pipeline/auto-pass.model.js", () => ({ AutoPass: mocks.AutoPass }))
vi.mock("../change-request/spine-lock.model.js", () => ({ SpineLock: mocks.SpineLock }))
vi.mock("../change-request/embedding/spine-embedding.model.js", () => ({ SpineEmbedding: mocks.SpineEmbedding }))
vi.mock("../change-request/requirement-extraction.model.js", () => ({ RequirementExtraction: mocks.RequirementExtraction }))
vi.mock("../diagram/screen-mockup-run.model.js", () => ({ ScreenMockupRun: mocks.ScreenMockupRun }))
vi.mock("./project-document-chunk.model.js", () => ({ ProjectDocumentChunk: mocks.ProjectDocumentChunk }))
vi.mock("./requirement-source.model.js", () => ({ RequirementSource: mocks.RequirementSource }))
vi.mock("../google/google-doc-link.model.js", () => ({ GoogleDocLink: mocks.GoogleDocLink }))
vi.mock("../credits/subscription.model.js", () => ({ Subscription: { findOne: () => ({ select: () => ({ lean: mocks.subscriptionPlan }) }) } }))
vi.mock("../user/account-locale.js", () => ({ accountLocaleOf: mocks.accountLocaleOf }))

import * as projectService from "./project.service.js"

const PROJECT = "64b000000000000000000001"
const USER = "64b000000000000000000002"
// task-26 Pha 4: dự án thuộc về org, USER chỉ còn là người tạo.
const ORG = "64b00000000000000000000f"

describe("deleteProject", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.order.length = 0
    mocks.spineRaw.mockResolvedValue({ diagrams: [{ id: "D01" }, { id: "D02" }] })
    mocks.Spine.findOne.mockImplementation(() => ({ select: () => ({ lean: mocks.spineRaw }) }))
    mocks.Spine.deleteMany.mockImplementation(async () => {
      mocks.order.push("purge")
      return { deletedCount: 1 }
    })
    mocks.Project.deleteOne.mockImplementation(() => ({
      setOptions: vi.fn(async () => {
        mocks.order.push("deleteProject")
        return { deletedCount: 1 }
      })
    }))
  })

  /** `purgeProject` tìm dự án bằng `exists(...).setOptions(WITH_DELETED)` (FLF-401: thấy cả dự án đã xoá mềm). */
  const purgeFinds = (project: unknown) => mocks.Project.exists.mockReturnValue({ setOptions: vi.fn(async () => project) })

  it("FLF-401 hard (nút Xoá vĩnh viễn): chỉ xoá mềm — đặt deletedAt + deletedBy, không dọn collection / file nào", async () => {
    mocks.Project.findOneAndUpdate.mockResolvedValue({ _id: PROJECT })

    await expect(projectService.deleteProject(PROJECT, ORG, true, USER)).resolves.toEqual({ _id: PROJECT, status: "deleted" })
    expect(mocks.Project.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: PROJECT, organizationId: ORG },
      { $set: { deletedAt: expect.any(Date), deletedBy: USER } },
      { new: true }
    )
    expect(mocks.Project.findOneAndDelete).not.toHaveBeenCalled()
    for (const model of [mocks.ChatSession, mocks.ProjectDocument, mocks.Spine, mocks.Change, mocks.DocVersion, mocks.SpineTranslation, mocks.Comment, mocks.CommentCounter, mocks.TemplateMigration]) {
      expect(model.deleteMany).not.toHaveBeenCalled()
    }
    expect(mocks.removeDocFiles).not.toHaveBeenCalled()
    expect(mocks.removeDiagram).not.toHaveBeenCalled()
    expect(mocks.destroyDocumentAsset).not.toHaveBeenCalled()
  })

  it("purgeProject (xoá tổ chức): xoá mọi collection theo project, file sơ đồ và asset Cloudinary", async () => {
    purgeFinds({ _id: PROJECT })

    await expect(projectService.purgeProject(PROJECT, ORG)).resolves.toBe(true)

    for (const model of [mocks.ChatSession, mocks.ProjectDocument, mocks.Spine, mocks.Change, mocks.Baseline, mocks.Usage, mocks.RenderedDocumentCache]) {
      expect(model.deleteMany).toHaveBeenCalledWith({ projectId: PROJECT })
    }
    // Mode 1: mọi collection + file .docx trong GridFS
    for (const model of [mocks.ImportedDocument, mocks.DocBlock, mocks.TemplateProfile, mocks.ExtractionDraft, mocks.FieldAnchor, mocks.ReuploadDiff, mocks.DocVersion, mocks.ChangeRequest, mocks.CrCounter, mocks.ChangeLocation, mocks.ChangeGroup]) {
      expect(model.deleteMany).toHaveBeenCalledWith({ projectId: PROJECT })
    }
    // FLF-265: bản dịch + glossary dịch + khoá lượt dịch
    for (const model of [mocks.SpineTranslation, mocks.TranslationGlossary, mocks.TranslationRunLock]) {
      expect(model.deleteMany).toHaveBeenCalledWith({ projectId: PROJECT })
    }
    // Comment + đổi mẫu (FLF-422)
    for (const model of [mocks.Comment, mocks.CommentCounter, mocks.TemplateMigration]) {
      expect(model.deleteMany).toHaveBeenCalledWith({ projectId: PROJECT })
    }
    // QLHS #2: lượt chạy bước, khoá CR, vector… và các collection theo dự án khác
    for (const model of [mocks.StepRun, mocks.AutoPass, mocks.SpineLock, mocks.SpineEmbedding, mocks.RequirementExtraction, mocks.ScreenMockupRun, mocks.ProjectDocumentChunk, mocks.RequirementSource, mocks.GoogleDocLink]) {
      expect(model.deleteMany).toHaveBeenCalledWith({ projectId: PROJECT })
    }
    expect(mocks.removeDocFiles).toHaveBeenCalledWith(PROJECT)
    expect(mocks.removeDiagram.mock.calls).toEqual([[PROJECT, "D01"], [PROJECT, "D02"]])
    expect(mocks.destroyDocumentAsset.mock.calls).toEqual([["flintflow/brief"], ["flintflow/notes"]])
    // QLHS #1: dọn dữ liệu trước, xoá bản ghi dự án sau
    expect(mocks.order).toEqual(["purge", "deleteProject"])
    expect(mocks.Project.deleteOne).toHaveBeenCalledWith({ _id: PROJECT, organizationId: ORG })
    expect(mocks.Project.findOneAndDelete).not.toHaveBeenCalled()
  })

  it("purgeProject QLHS #1: đọc Spine thô (không qua zod) — Spine cũ sai schema vẫn xoá được, file sơ đồ vẫn dọn", async () => {
    purgeFinds({ _id: PROJECT })
    mocks.spineRaw.mockResolvedValue({ assumptions: [{ statement_vi: "x".repeat(400) }], diagrams: [{ id: "D09" }, { id: 5 }] })

    await expect(projectService.purgeProject(PROJECT, ORG)).resolves.toBe(true)

    expect(mocks.getSpine).not.toHaveBeenCalled()
    expect(mocks.removeDiagram.mock.calls).toEqual([[PROJECT, "D09"]])
    expect(mocks.order).toEqual(["purge", "deleteProject"])
  })

  it("purgeProject QLHS #1: dọn lỗi giữa chừng ⇒ KHÔNG xoá bản ghi dự án (còn xoá lại được, không mồ côi)", async () => {
    purgeFinds({ _id: PROJECT })
    mocks.Change.deleteMany.mockRejectedValueOnce(new Error("mongo down"))

    await expect(projectService.purgeProject(PROJECT, ORG)).rejects.toThrow("mongo down")
    expect(mocks.Project.deleteOne).not.toHaveBeenCalled()
  })

  it("purgeProject: lỗi xoá file sơ đồ không làm hỏng việc xoá project", async () => {
    purgeFinds({ _id: PROJECT })
    mocks.removeDiagram.mockRejectedValueOnce(new Error("gridfs down"))
    vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(projectService.purgeProject(PROJECT, ORG)).resolves.toBe(true)
    expect(mocks.removeDiagram).toHaveBeenCalledTimes(2)
  })

  it("purgeProject: không có dự án ⇒ false, không xoá gì", async () => {
    purgeFinds(null)

    await expect(projectService.purgeProject(PROJECT, ORG)).resolves.toBe(false)
    expect(mocks.Spine.deleteMany).not.toHaveBeenCalled()
    expect(mocks.destroyDocumentAsset).not.toHaveBeenCalled()
  })

  it("hard: project không thuộc org ⇒ 404, không đánh dấu gì", async () => {
    mocks.Project.findOneAndUpdate.mockResolvedValue(null)

    await expect(projectService.deleteProject(PROJECT, ORG, true)).rejects.toMatchObject({ statusCode: 404, code: "PROJECT_NOT_FOUND" })
    expect(mocks.Spine.deleteMany).not.toHaveBeenCalled()
  })

  it("mặc định chỉ archive, không đụng dữ liệu", async () => {
    mocks.Project.findOneAndUpdate.mockResolvedValue({ _id: PROJECT, status: "archived" })

    await expect(projectService.deleteProject(PROJECT, ORG)).resolves.toMatchObject({ status: "archived" })
    expect(mocks.Project.findOneAndUpdate).toHaveBeenCalledWith({ _id: PROJECT, organizationId: ORG }, { status: "archived" }, { new: true })
    expect(mocks.Spine.deleteMany).not.toHaveBeenCalled()
  })
})

describe("createProject", () => {
  beforeEach(() => vi.clearAllMocks())

  it("chỉ lưu metadata, tạo Spine rỗng kèm tên/domain", async () => {
    mocks.Project.create.mockResolvedValue({ id: PROJECT })

    await projectService.createProject(ORG, USER, "FlintFlow", "")

    // FLF-265: mode 2 luôn lưu ngôn ngữ tài liệu — tài khoản chưa chọn ⇒ en
    expect(mocks.Project.create).toHaveBeenCalledWith({ organizationId: ORG, userId: USER, name: "FlintFlow", domain: null, status: "active", mode: "fpt", start_kind: "new", has_required_template: false, template_intent: null, documentLanguage: "en" })
    expect(mocks.getOrCreate).toHaveBeenCalledWith(PROJECT, { name: "FlintFlow", domain: null })
  })

  it("mode import (mode 1) vẫn tạo Spine rỗng làm chỉ mục", async () => {
    mocks.Project.create.mockResolvedValue({ id: PROJECT })

    await projectService.createProject(ORG, USER, "Lumen SRS", "E-learning", "import")

    expect(mocks.Project.create).toHaveBeenCalledWith({ organizationId: ORG, userId: USER, name: "Lumen SRS", domain: "E-learning", status: "active", mode: "import", start_kind: "existing", has_required_template: null, template_intent: null })
    expect(mocks.getOrCreate).toHaveBeenCalledWith(PROJECT, { name: "Lumen SRS", domain: "E-learning" })
  })

  it("đủ trần số dự án của gói ⇒ 402 PLAN_LIMIT_PROJECTS, không tạo gì; chỉ đếm dự án chưa xoá", async () => {
    mocks.Project.countDocuments.mockResolvedValueOnce(3)

    await expect(projectService.createProject(ORG, USER, "Thứ tư", "")).rejects.toMatchObject({ statusCode: 402, code: "PLAN_LIMIT_PROJECTS" })
    expect(mocks.Project.countDocuments).toHaveBeenCalledWith({ organizationId: ORG, status: { $ne: "archived" } })
    expect(mocks.Project.create).not.toHaveBeenCalled()
  })

  it("gói Pro ⇒ trần 50", async () => {
    mocks.subscriptionPlan.mockResolvedValueOnce({ plan: "pro" })
    mocks.Project.countDocuments.mockResolvedValueOnce(3)
    mocks.Project.create.mockResolvedValue({ id: PROJECT })

    await projectService.createProject(ORG, USER, "Thứ tư", "")
    expect(mocks.Project.create).toHaveBeenCalled()
  })

  it("FLF-335: source quyết định mode - mới không mẫu ⇒ fpt; mới có mẫu bắt buộc ⇒ import + fixed; có sẵn ⇒ import; client cũ customer_template không còn 501", async () => {
    expect(projectService.resolveProjectStart("fpt", { source: "new", has_required_template: false })).toEqual({ mode: "fpt", start_kind: "new", has_required_template: false, template_intent: null })
    expect(projectService.resolveProjectStart("fpt", { source: "new", has_required_template: true })).toEqual({ mode: "import", start_kind: "new", has_required_template: true, template_intent: "fixed" })
    expect(projectService.resolveProjectStart("fpt", { source: "existing" })).toEqual({ mode: "import", start_kind: "existing", has_required_template: null, template_intent: null })
    // `source` thắng `mode` client cũ gửi kèm
    expect(projectService.resolveProjectStart("import", { source: "new", has_required_template: false }).mode).toBe("fpt")
    expect(projectService.resolveProjectStart("customer_template")).toEqual({ mode: "import", start_kind: "new", has_required_template: true, template_intent: "fixed" })

    mocks.Project.create.mockResolvedValue({ id: PROJECT })
    await projectService.createProject(ORG, USER, "Mẫu khách", "", "fpt", undefined, "vi", { source: "new", has_required_template: true })
    // Tải mẫu lên ⇒ ngôn ngữ theo file, không lưu documentLanguage
    expect(mocks.Project.create).toHaveBeenCalledWith(expect.objectContaining({ mode: "import", start_kind: "new", has_required_template: true, template_intent: "fixed" }))
    expect(mocks.Project.create.mock.calls[0][0]).not.toHaveProperty("documentLanguage")
    expect(mocks.getOrCreate).toHaveBeenCalled()
  })
})

describe("resolveProjectStart - hộp Tạo dự án hai ô", () => {
  it("không SRS ⇒ fpt; có SRS ⇒ import + fixed; có SRS + tick Bổ sung ⇒ import + free; has_srs_file thắng source / mode", () => {
    expect(projectService.resolveProjectStart("fpt", { has_srs_file: false })).toEqual({ mode: "fpt", start_kind: "new", has_required_template: false, template_intent: null })
    expect(projectService.resolveProjectStart("fpt", { has_srs_file: true })).toEqual({ mode: "import", start_kind: "existing", has_required_template: null, template_intent: "fixed" })
    expect(projectService.resolveProjectStart("fpt", { has_srs_file: true, complete_to_standard: false }).template_intent).toBe("fixed")
    expect(projectService.resolveProjectStart("fpt", { has_srs_file: true, complete_to_standard: true })).toEqual({ mode: "import", start_kind: "existing", has_required_template: null, template_intent: "free" })
    // Tick khi không có file: vô nghĩa ⇒ vẫn chế độ 2
    expect(projectService.resolveProjectStart("fpt", { has_srs_file: false, complete_to_standard: true }).mode).toBe("fpt")
    expect(projectService.resolveProjectStart("import", { has_srs_file: false, source: "existing" }).mode).toBe("fpt")
    expect(projectService.resolveProjectStart("fpt", { has_srs_file: true, source: "new", has_required_template: false }).mode).toBe("import")
  })
})

describe("createProject - ngôn ngữ tài liệu (FLF-265)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.Project.create.mockResolvedValue({ id: PROJECT })
  })

  const stored = () => (mocks.Project.create.mock.calls[0] as unknown as [Record<string, unknown>])[0]

  it("body gửi giá trị ⇒ lưu đúng giá trị, không đọc tài khoản", async () => {
    await projectService.createProject(ORG, USER, "Lumen", undefined, "fpt", undefined, "vi")

    expect(stored().documentLanguage).toBe("vi")
    expect(mocks.accountLocaleOf).not.toHaveBeenCalled()
  })

  it("thiếu ⇒ lấy ngôn ngữ tài khoản (User.locale) của người tạo", async () => {
    mocks.accountLocaleOf.mockResolvedValueOnce("vi")

    await projectService.createProject(ORG, USER, "Lumen")

    expect(mocks.accountLocaleOf).toHaveBeenCalledWith(USER)
    expect(stored().documentLanguage).toBe("vi")
  })

  it("thiếu và tài khoản chưa chọn (accountLocaleOf null) ⇒ en", async () => {
    await projectService.createProject(ORG, USER, "Lumen")

    expect(stored().documentLanguage).toBe("en")
  })

  it("mode import bỏ qua giá trị gửi lên, không lưu field (ngôn ngữ theo file upload)", async () => {
    await projectService.createProject(ORG, USER, "Lumen SRS", undefined, "import", undefined, "vi")

    expect(stored()).not.toHaveProperty("documentLanguage")
    expect(mocks.accountLocaleOf).not.toHaveBeenCalled()
  })
})

describe("setDocumentLanguage (FLF-265)", () => {
  beforeEach(() => vi.clearAllMocks())

  const existing = (value: { mode: string } | null) =>
    mocks.Project.findOne.mockReturnValueOnce({ select: () => ({ lean: async () => value }) })

  it("ghi field, lọc theo org và loại dự án mode 1 ngay trong lệnh ghi", async () => {
    mocks.Project.findOneAndUpdate.mockResolvedValueOnce({ _id: PROJECT, documentLanguage: "vi" })

    await expect(projectService.setDocumentLanguage(PROJECT, ORG, "vi")).resolves.toMatchObject({ documentLanguage: "vi" })
    expect(mocks.Project.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: PROJECT, organizationId: ORG, $or: [{ mode: { $ne: "import" } }, { converted_from: "fpt" }] },
      { documentLanguage: "vi" },
      { new: true }
    )
    expect(mocks.Project.findOne).not.toHaveBeenCalled()
    expect(mocks.TemplateProfile.updateOne).not.toHaveBeenCalled()
  })

  it("FLF-318: dự án tạo SRS đã chuyển sang mode 1 vẫn đổi được; TemplateProfile.language đổi theo", async () => {
    mocks.Project.findOneAndUpdate.mockResolvedValueOnce({ _id: PROJECT, mode: "import", converted_from: "fpt", documentLanguage: "vi" })
    await expect(projectService.setDocumentLanguage(PROJECT, ORG, "vi")).resolves.toMatchObject({ converted_from: "fpt" })
    expect(mocks.TemplateProfile.updateOne).toHaveBeenCalledWith({ projectId: PROJECT }, { $set: { language: "vi" } })
  })

  it("dự án của org khác ⇒ 404 PROJECT_NOT_FOUND", async () => {
    mocks.Project.findOneAndUpdate.mockResolvedValueOnce(null)
    existing(null)

    await expect(projectService.setDocumentLanguage(PROJECT, ORG, "vi")).rejects.toMatchObject({ statusCode: 404, code: "PROJECT_NOT_FOUND" })
    expect(mocks.Project.findOne).toHaveBeenCalledWith({ _id: PROJECT, organizationId: ORG })
  })

  it("id sai định dạng ⇒ 404, không chạm DB", async () => {
    await expect(projectService.setDocumentLanguage("khong-phai-id", ORG, "vi")).rejects.toMatchObject({ statusCode: 404, code: "PROJECT_NOT_FOUND" })
    expect(mocks.Project.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it("dự án mode 1 ⇒ 409 DOCUMENT_LANGUAGE_LOCKED", async () => {
    mocks.Project.findOneAndUpdate.mockResolvedValueOnce(null)
    existing({ mode: "import" })

    await expect(projectService.setDocumentLanguage(PROJECT, ORG, "en")).rejects.toMatchObject({
      statusCode: 409,
      code: projectService.DOCUMENT_LANGUAGE_LOCKED
    })
  })
})
