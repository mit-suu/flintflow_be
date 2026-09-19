/**
 * Kho file .docx mode 1 (FLF-172, P4 §8.3) — phần chạy được không cần Mongo: store bộ nhớ, `setDocFileStore`,
 * và nhánh lỗi của store GridFS khi chưa kết nối. Nhánh GridFS thật ở `test/integration/mode1/release.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import mongoose from "mongoose"
import { DocFileNotFoundError, createMemoryDocFileStore, docFileStore, gridFsDocFileStore, setDocFileStore } from "./doc-file.store.js"

describe("createMemoryDocFileStore", () => {
  it("save trả ref dạng ObjectId, load trả bản sao (sửa buffer trả về không đổi file lưu)", async () => {
    const store = createMemoryDocFileStore()
    const data = Buffer.from("docx-bytes")
    const ref = await store.save(data, { projectId: "p1", kind: "upload", name: "SRS.docx" })
    expect(mongoose.isValidObjectId(ref)).toBe(true)
    data.write("XXXX")
    const loaded = await store.load(ref)
    expect(loaded.toString()).toBe("docx-bytes")
    loaded.write("YYYY")
    expect((await store.load(ref)).toString()).toBe("docx-bytes")
    expect(store.files.get(ref)?.meta).toEqual({ projectId: "p1", kind: "upload", name: "SRS.docx" })
  })

  it("load ref không có ⇒ DocFileNotFoundError; remove ref không có không lỗi", async () => {
    const store = createMemoryDocFileStore()
    await expect(store.load("000000000000000000000000")).rejects.toBeInstanceOf(DocFileNotFoundError)
    await expect(store.load("khong-phai-id")).rejects.toThrow(/Không tìm thấy file khong-phai-id/)
    await expect(store.remove("000000000000000000000000")).resolves.toBeUndefined()
  })

  it("removeProject chỉ xoá file của project đó", async () => {
    const store = createMemoryDocFileStore()
    const a1 = await store.save(Buffer.from("a1"), { projectId: "A", kind: "version", name: "0.0" })
    const a2 = await store.save(Buffer.from("a2"), { projectId: "A", kind: "clean", name: "1.0" })
    const b1 = await store.save(Buffer.from("b1"), { projectId: "B", kind: "version", name: "0.0" })
    await store.removeProject("A")
    expect([...store.files.keys()]).toEqual([b1])
    await expect(store.load(a1)).rejects.toBeInstanceOf(DocFileNotFoundError)
    await expect(store.load(a2)).rejects.toBeInstanceOf(DocFileNotFoundError)
  })
})

describe("setDocFileStore", () => {
  it("thay store rồi khôi phục store cũ (mặc định GridFS)", () => {
    expect(docFileStore()).toBe(gridFsDocFileStore)
    const mem = createMemoryDocFileStore()
    const restore = setDocFileStore(mem)
    expect(docFileStore()).toBe(mem)
    const mem2 = createMemoryDocFileStore()
    const restore2 = setDocFileStore(mem2)
    expect(docFileStore()).toBe(mem2)
    restore2()
    expect(docFileStore()).toBe(mem)
    restore()
    expect(docFileStore()).toBe(gridFsDocFileStore)
  })
})

describe("gridFsDocFileStore khi chưa kết nối Mongo", () => {
  it("save/load/removeProject ⇒ lỗi rõ ràng 'MongoDB chưa kết nối'", async () => {
    expect(mongoose.connection.readyState).not.toBe(1)
    await expect(gridFsDocFileStore.save(Buffer.from("x"), { projectId: "p", kind: "upload", name: "a.docx" })).rejects.toThrow(/MongoDB chưa kết nối/)
    await expect(gridFsDocFileStore.load("000000000000000000000000")).rejects.toThrow(/MongoDB chưa kết nối/)
    await expect(gridFsDocFileStore.removeProject("p")).rejects.toThrow(/MongoDB chưa kết nối/)
  })

  it("remove với ref không phải ObjectId ⇒ bỏ qua, không chạm tới Mongo", async () => {
    await expect(gridFsDocFileStore.remove("khong-phai-id")).resolves.toBeUndefined()
    await expect(gridFsDocFileStore.remove("")).resolves.toBeUndefined()
  })

  it("DocFileNotFoundError mang tên + ref trong message", () => {
    const err = new DocFileNotFoundError("abc")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("DocFileNotFoundError")
    expect(err.message).toContain("abc")
  })
})
