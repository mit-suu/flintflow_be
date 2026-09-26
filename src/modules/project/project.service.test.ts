import { describe, it, expect, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => {
  const deleteMany = () => vi.fn(async (_filter: unknown) => ({ deletedCount: 1 }))
  return {
    Project: { findOneAndDelete: vi.fn(), findOneAndUpdate: vi.fn(), create: vi.fn(), find: vi.fn(), findOne: vi.fn() },
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
    destroyDocumentAsset: vi.fn(async () => true)
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

    expect(mocks.Project.create).toHaveBeenCalledWith({ organizationId: ORG, userId: USER, name: "FlintFlow", domain: null, status: "active", mode: "fpt" })
    expect(mocks.getOrCreate).toHaveBeenCalledWith(PROJECT, { name: "FlintFlow", domain: null })
  })

  it("mode import (mode 1) vẫn tạo Spine rỗng làm chỉ mục", async () => {
    mocks.Project.create.mockResolvedValue({ id: PROJECT })

    await projectService.createProject(ORG, USER, "Lumen SRS", "E-learning", "import")

    expect(mocks.Project.create).toHaveBeenCalledWith({ organizationId: ORG, userId: USER, name: "Lumen SRS", domain: "E-learning", status: "active", mode: "import" })
    expect(mocks.getOrCreate).toHaveBeenCalledWith(PROJECT, { name: "Lumen SRS", domain: "E-learning" })
  })

  it("mode customer_template chưa hỗ trợ ⇒ 501 NOT_IMPLEMENTED, không tạo gì", async () => {
    await expect(projectService.createProject(ORG, USER, "X", "", "customer_template")).rejects.toMatchObject({ statusCode: 501, code: "NOT_IMPLEMENTED" })
    expect(mocks.Project.create).not.toHaveBeenCalled()
    expect(mocks.getOrCreate).not.toHaveBeenCalled()
  })
})
