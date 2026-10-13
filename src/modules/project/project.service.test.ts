import { describe, it, expect, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => {
  const deleteMany = () => vi.fn(async (_filter: unknown) => ({ deletedCount: 1 }))
  return {
    Project: { findOneAndDelete: vi.fn(), findOneAndUpdate: vi.fn(), create: vi.fn(), find: vi.fn(), findOne: vi.fn(), countDocuments: vi.fn(async () => 0) },
    // UC-16: gói active của org — null ⇒ Free
    subscriptionPlan: vi.fn(async (): Promise<{ plan: string } | null> => null),
    ChatSession: { deleteMany: deleteMany() },
    ProjectDocument: {
      deleteMany: deleteMany(),
      find: vi.fn(() => ({ select: () => ({ lean: async () => [{ cloudinaryPublicId: "flintflow/brief" }, { cloudinaryPublicId: "flintflow/notes" }] }) }))
    },
    Spine: { deleteMany: deleteMany() },
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
    TemplateProfile: { deleteMany: deleteMany() },
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
    destroyDocumentAsset: vi.fn(async () => true),
    // FLF-265: ngôn ngữ tài khoản — null = chưa chọn
    accountLocaleOf: vi.fn(async (_userId: string): Promise<"vi" | "en" | null> => null)
  }
})

vi.mock("./project.model.js", () => ({ Project: mocks.Project }))
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
    mocks.getSpine.mockResolvedValue({ diagrams: [{ id: "D01" }, { id: "D02" }] })
  })

  it("hard: xoá mọi collection theo project, file sơ đồ và asset Cloudinary", async () => {
    mocks.Project.findOneAndDelete.mockResolvedValue({ _id: PROJECT })

    await expect(projectService.deleteProject(PROJECT, ORG, true)).resolves.toEqual({ _id: PROJECT, status: "deleted" })

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
    expect(mocks.removeDocFiles).toHaveBeenCalledWith(PROJECT)
    expect(mocks.removeDiagram.mock.calls).toEqual([[PROJECT, "D01"], [PROJECT, "D02"]])
    expect(mocks.destroyDocumentAsset.mock.calls).toEqual([["flintflow/brief"], ["flintflow/notes"]])
  })

  it("hard: lỗi xoá file sơ đồ không làm hỏng việc xoá project", async () => {
    mocks.Project.findOneAndDelete.mockResolvedValue({ _id: PROJECT })
    mocks.removeDiagram.mockRejectedValueOnce(new Error("gridfs down"))
    vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(projectService.deleteProject(PROJECT, ORG, true)).resolves.toMatchObject({ status: "deleted" })
    expect(mocks.removeDiagram).toHaveBeenCalledTimes(2)
  })

  it("hard: project không thuộc user ⇒ 404, không xoá gì", async () => {
    mocks.Project.findOneAndDelete.mockResolvedValue(null)

    await expect(projectService.deleteProject(PROJECT, ORG, true)).rejects.toMatchObject({ statusCode: 404, code: "PROJECT_NOT_FOUND" })
    expect(mocks.Spine.deleteMany).not.toHaveBeenCalled()
    expect(mocks.destroyDocumentAsset).not.toHaveBeenCalled()
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
    expect(mocks.Project.create).toHaveBeenCalledWith({ organizationId: ORG, userId: USER, name: "FlintFlow", domain: null, status: "active", mode: "fpt", documentLanguage: "en" })
    expect(mocks.getOrCreate).toHaveBeenCalledWith(PROJECT, { name: "FlintFlow", domain: null })
  })

  it("mode import (mode 1) vẫn tạo Spine rỗng làm chỉ mục", async () => {
    mocks.Project.create.mockResolvedValue({ id: PROJECT })

    await projectService.createProject(ORG, USER, "Lumen SRS", "E-learning", "import")

    expect(mocks.Project.create).toHaveBeenCalledWith({ organizationId: ORG, userId: USER, name: "Lumen SRS", domain: "E-learning", status: "active", mode: "import" })
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

  it("mode customer_template chưa hỗ trợ ⇒ 501 NOT_IMPLEMENTED, không tạo gì", async () => {
    await expect(projectService.createProject(ORG, USER, "X", "", "customer_template")).rejects.toMatchObject({ statusCode: 501, code: "NOT_IMPLEMENTED" })
    expect(mocks.Project.create).not.toHaveBeenCalled()
    expect(mocks.getOrCreate).not.toHaveBeenCalled()
  })
})

describe("createProject — ngôn ngữ tài liệu (FLF-265)", () => {
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
      { _id: PROJECT, organizationId: ORG, mode: { $ne: "import" } },
      { documentLanguage: "vi" },
      { new: true }
    )
    expect(mocks.Project.findOne).not.toHaveBeenCalled()
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
