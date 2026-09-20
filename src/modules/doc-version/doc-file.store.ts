/**
 * Kho file .docx của mode 1 trong GridFS (bucket `source-docs`): file người dùng upload, bản lưu từng version,
 * bản sạch của release, file re-upload. FLF-171, plan §6 2B (P0 §3 dòng 10: không dùng Cloudinary, không dùng
 * chung bucket `diagram-files`). `file_ref` = `_id` GridFS dạng chuỗi.
 */

import mongoose from "mongoose"

export const DOC_FILE_BUCKET = "source-docs"
export const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

export type DocFileKind = "upload" | "version" | "clean" | "reupload"

export interface DocFileMeta {
  projectId: string
  kind: DocFileKind
  /** Tên hiển thị, vd `SRS_Lumen.docx` hoặc `0.1`. */
  name: string
}

export interface DocFileStore {
  save(data: Buffer, meta: DocFileMeta): Promise<string>
  load(ref: string): Promise<Buffer>
  remove(ref: string): Promise<void>
  /** Xoá mọi file của project (xoá cứng project). */
  removeProject(projectId: string): Promise<void>
}

export class DocFileNotFoundError extends Error {
  constructor(ref: string) {
    super(`Không tìm thấy file ${ref}`)
    this.name = "DocFileNotFoundError"
  }
}

const bucket = (): InstanceType<typeof mongoose.mongo.GridFSBucket> => {
  const db = mongoose.connection.db
  if (!db) throw new Error("MongoDB chưa kết nối — không lưu được file tài liệu")
  return new mongoose.mongo.GridFSBucket(db, { bucketName: DOC_FILE_BUCKET })
}

const toObjectId = (ref: string): mongoose.Types.ObjectId => {
  if (!mongoose.isValidObjectId(ref)) throw new DocFileNotFoundError(ref)
  return new mongoose.Types.ObjectId(ref)
}

const deleteQuietly = async (b: ReturnType<typeof bucket>, id: mongoose.Types.ObjectId): Promise<void> => {
  try {
    await b.delete(id)
  } catch (err) {
    if (!(err instanceof Error && /not found/i.test(err.message))) throw err
  }
}

export const gridFsDocFileStore: DocFileStore = {
  async save(data, meta) {
    const b = bucket()
    const upload = b.openUploadStream(`${meta.projectId}/${meta.kind}/${meta.name}`, {
      metadata: { ...meta, contentType: DOCX_CONTENT_TYPE }
    })
    await new Promise<void>((resolve, reject) => {
      upload.once("finish", () => resolve())
      upload.once("error", reject)
      upload.end(data)
    })
    return String(upload.id)
  },

  async load(ref) {
    const b = bucket()
    const id = toObjectId(ref)
    const [file] = await b.find({ _id: id }).limit(1).toArray()
    if (!file) throw new DocFileNotFoundError(ref)
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      b.openDownloadStream(id)
        .on("data", (chunk: Buffer) => chunks.push(chunk))
        .once("end", () => resolve())
        .once("error", reject)
    })
    return Buffer.concat(chunks)
  },

  async remove(ref) {
    if (!mongoose.isValidObjectId(ref)) return
    await deleteQuietly(bucket(), new mongoose.Types.ObjectId(ref))
  },

  async removeProject(projectId) {
    const b = bucket()
    for (const file of await b.find({ "metadata.projectId": projectId }).toArray()) await deleteQuietly(b, file._id)
  }
}

/** Store trong bộ nhớ — cho unit test. */
export const createMemoryDocFileStore = (): DocFileStore & { files: Map<string, { data: Buffer; meta: DocFileMeta }> } => {
  const files = new Map<string, { data: Buffer; meta: DocFileMeta }>()
  return {
    files,
    async save(data, meta) {
      const ref = new mongoose.Types.ObjectId().toHexString()
      files.set(ref, { data: Buffer.from(data), meta })
      return ref
    },
    async load(ref) {
      const f = files.get(ref)
      if (!f) throw new DocFileNotFoundError(ref)
      return Buffer.from(f.data)
    },
    async remove(ref) {
      files.delete(ref)
    },
    async removeProject(projectId) {
      for (const [ref, f] of files) if (f.meta.projectId === projectId) files.delete(ref)
    }
  }
}

let current: DocFileStore = gridFsDocFileStore

export const docFileStore = (): DocFileStore => current

/** Thay store (test). Trả hàm khôi phục store cũ. */
export const setDocFileStore = (store: DocFileStore): (() => void) => {
  const previous = current
  current = store
  return () => {
    current = previous
  }
}
