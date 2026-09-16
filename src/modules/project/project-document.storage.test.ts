import { describe, it, expect, vi, beforeEach } from "vitest"

const destroy = vi.hoisted(() => vi.fn())
vi.mock("cloudinary", () => ({ v2: { uploader: { destroy } } }))
vi.mock("../../shared/utils/cloudinary.js", () => ({}))

import { destroyDocumentAsset } from "./project-document.storage.js"

describe("destroyDocumentAsset", () => {
  beforeEach(() => {
    destroy.mockReset()
  })

  it("xoá file raw theo public id", async () => {
    destroy.mockResolvedValue({ result: "ok" })

    await expect(destroyDocumentAsset("flintflow/brief")).resolves.toBe(true)
    expect(destroy).toHaveBeenCalledWith("flintflow/brief", { resource_type: "raw", invalidate: true })
  })

  it("file đã không còn trên Cloudinary vẫn coi là xong", async () => {
    destroy.mockResolvedValue({ result: "not found" })
    await expect(destroyDocumentAsset("flintflow/gone")).resolves.toBe(true)
  })

  it("lỗi Cloudinary chỉ ghi log, không ném", async () => {
    destroy.mockRejectedValue(new Error("network"))
    vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(destroyDocumentAsset("flintflow/brief")).resolves.toBe(false)
  })

  it("không có public id ⇒ không gọi Cloudinary", async () => {
    await expect(destroyDocumentAsset("")).resolves.toBe(false)
    expect(destroy).not.toHaveBeenCalled()
  })
})
