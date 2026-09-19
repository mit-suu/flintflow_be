import { describe, it, expect, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => ({
  Folder: { find: vi.fn(), findOneAndDelete: vi.fn(), exists: vi.fn() },
  Project: { aggregate: vi.fn(), updateMany: vi.fn() }
}))

vi.mock("./folder.model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./folder.model.js")>()),
  Folder: mocks.Folder
}))
vi.mock("../project/project.model.js", () => ({ Project: mocks.Project }))

import * as folderService from "./folder.service.js"
import { CreateFolderSchema, UpdateFolderSchema } from "./folder.validation.js"

const USER = "64b000000000000000000002"
const F1 = "64b0000000000000000000f1"
const F2 = "64b0000000000000000000f2"
const AT = new Date("2026-09-19T03:00:00.000Z")

describe("listFolders", () => {
  beforeEach(() => vi.clearAllMocks())

  it("gắn projectCount theo folder, folder rỗng = 0", async () => {
    mocks.Folder.find.mockReturnValue({
      sort: () => ({
        lean: async () => [
          { _id: F2, name: "Khách B", color: "blue", createdAt: AT, updatedAt: AT },
          { _id: F1, name: "Khách A", color: "violet", createdAt: AT, updatedAt: AT }
        ]
      })
    })
    mocks.Project.aggregate.mockResolvedValue([{ _id: F1, count: 3 }])

    const folders = await folderService.listFolders(USER)

    expect(folders.map((f) => [f.name, f.projectCount])).toEqual([["Khách B", 0], ["Khách A", 3]])
    expect(mocks.Folder.find).toHaveBeenCalledWith({ userId: USER })
  })
})

describe("deleteFolder", () => {
  beforeEach(() => vi.clearAllMocks())

  it("nhả dự án ra ngoài rồi mới xoá folder (không xoá dự án)", async () => {
    mocks.Folder.exists.mockResolvedValue({ _id: F1 })
    mocks.Folder.findOneAndDelete.mockResolvedValue({ _id: F1 })
    mocks.Project.updateMany.mockResolvedValue({ modifiedCount: 2 })

    await expect(folderService.deleteFolder(USER, F1)).resolves.toEqual({ _id: F1, releasedProjects: 2 })
    expect(mocks.Project.updateMany).toHaveBeenCalledWith({ userId: USER, folderId: F1 }, { $set: { folderId: null } })
  })

  it("folder không thuộc user hoặc id sai ⇒ 404 FOLDER_NOT_FOUND, không đụng dự án", async () => {
    mocks.Folder.exists.mockResolvedValue(null)
    await expect(folderService.deleteFolder(USER, F1)).rejects.toMatchObject({ statusCode: 404, code: "FOLDER_NOT_FOUND" })
    await expect(folderService.deleteFolder(USER, "khong-phai-id")).rejects.toMatchObject({ statusCode: 404 })
    expect(mocks.Project.updateMany).not.toHaveBeenCalled()
  })
})

describe("folder validation", () => {
  it("tạo: trim tên, màu mặc định violet; tên rỗng/quá 60 hoặc màu lạ bị chặn", () => {
    expect(CreateFolderSchema.parse({ name: "  Khách A " })).toEqual({ name: "Khách A", color: "violet" })
    expect(CreateFolderSchema.safeParse({ name: "   " }).success).toBe(false)
    expect(CreateFolderSchema.safeParse({ name: "x".repeat(61) }).success).toBe(false)
    expect(CreateFolderSchema.safeParse({ name: "A", color: "black" }).success).toBe(false)
  })

  it("sửa: cần ít nhất name hoặc color", () => {
    expect(UpdateFolderSchema.safeParse({}).success).toBe(false)
    expect(UpdateFolderSchema.parse({ color: "green" })).toEqual({ color: "green" })
  })
})
