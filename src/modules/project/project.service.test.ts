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

import * as projectService from "./project.service.js"

const PROJECT = "64b000000000000000000001"
const USER = "64b000000000000000000002"

describe("deleteProject", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSpine.mockResolvedValue({ diagrams: [{ id: "D01" }, { id: "D02" }] })
  })

  it("hard: xoá mọi collection theo project, file sơ đồ và asset Cloudinary", async () => {
    mocks.Project.findOneAndDelete.mockResolvedValue({ _id: PROJECT })

    await expect(projectService.deleteProject(PROJECT, USER, true)).resolves.toEqual({ _id: PROJECT, status: "deleted" })

    for (const model of [mocks.ChatSession, mocks.ProjectDocument, mocks.Spine, mocks.Change, mocks.Baseline, mocks.Usage, mocks.RenderedDocumentCache]) {
      expect(model.deleteMany).toHaveBeenCalledWith({ projectId: PROJECT })
    }
    expect(mocks.removeDiagram.mock.calls).toEqual([[PROJECT, "D01"], [PROJECT, "D02"]])
    expect(mocks.destroyDocumentAsset.mock.calls).toEqual([["flintflow/brief"], ["flintflow/notes"]])
  })

  it("hard: lỗi xoá file sơ đồ không làm hỏng việc xoá project", async () => {
    mocks.Project.findOneAndDelete.mockResolvedValue({ _id: PROJECT })
    mocks.removeDiagram.mockRejectedValueOnce(new Error("gridfs down"))
    vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(projectService.deleteProject(PROJECT, USER, true)).resolves.toMatchObject({ status: "deleted" })
    expect(mocks.removeDiagram).toHaveBeenCalledTimes(2)
  })

  it("hard: project không thuộc user ⇒ 404, không xoá gì", async () => {
    mocks.Project.findOneAndDelete.mockResolvedValue(null)

    await expect(projectService.deleteProject(PROJECT, USER, true)).rejects.toMatchObject({ statusCode: 404, code: "PROJECT_NOT_FOUND" })
    expect(mocks.Spine.deleteMany).not.toHaveBeenCalled()
    expect(mocks.destroyDocumentAsset).not.toHaveBeenCalled()
  })

  it("mặc định chỉ archive, không đụng dữ liệu", async () => {
    mocks.Project.findOneAndUpdate.mockResolvedValue({ _id: PROJECT, status: "archived" })

    await expect(projectService.deleteProject(PROJECT, USER)).resolves.toMatchObject({ status: "archived" })
    expect(mocks.Project.findOneAndUpdate).toHaveBeenCalledWith({ _id: PROJECT, userId: USER }, { status: "archived" }, { new: true })
    expect(mocks.Spine.deleteMany).not.toHaveBeenCalled()
  })
})

describe("createProject", () => {
  beforeEach(() => vi.clearAllMocks())

  it("chỉ lưu metadata, tạo Spine rỗng kèm tên/domain", async () => {
    mocks.Project.create.mockResolvedValue({ id: PROJECT })

    await projectService.createProject(USER, "FlintFlow", "fpt_template", "")

    expect(mocks.Project.create).toHaveBeenCalledWith({
      userId: USER,
      name: "FlintFlow",
      domain: null,
      status: "active",
      sourceMode: "fpt_template"
    })
    expect(mocks.getOrCreate).toHaveBeenCalledWith(PROJECT, { name: "FlintFlow", domain: null })
  })

  it.each(["edit_srs", "fpt_template", "customer_template"] as const)("lưu đúng sourceMode %s", async (mode) => {
    mocks.Project.create.mockResolvedValue({ id: PROJECT })

    await projectService.createProject(USER, "FlintFlow", mode)

    expect(mocks.Project.create).toHaveBeenCalledWith(expect.objectContaining({ sourceMode: mode }))
  })
})
