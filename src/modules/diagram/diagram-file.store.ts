/**
 * Lưu SVG/PNG đã render trong GridFS (bucket `diagram-files`), tên file `<projectId>/<diagramId>.<format>`.
 * Ghi đè = upload bản mới rồi xoá bản cũ, nên người đọc không bao giờ thấy file rỗng.
 */

import mongoose from "mongoose"

export type DiagramFileFormat = "svg" | "png"

export interface StoredDiagramFile {
  data: Buffer
  contentType: string
}

export interface DiagramFileStore {
  save(projectId: string, diagramId: string, format: DiagramFileFormat, file: StoredDiagramFile): Promise<void>
  load(projectId: string, diagramId: string, format: DiagramFileFormat): Promise<StoredDiagramFile | null>
  /** Xoá mọi file (svg, png) của một diagram; không có file thì thôi. */
  remove(projectId: string, diagramId: string): Promise<void>
}

export const DIAGRAM_FILE_FORMATS: readonly DiagramFileFormat[] = ["svg", "png"]

export const DIAGRAM_BUCKET = "diagram-files"

export const CONTENT_TYPES: Readonly<Record<DiagramFileFormat, string>> = { svg: "image/svg+xml", png: "image/png" }

export const diagramFileName = (projectId: string, diagramId: string, format: DiagramFileFormat): string =>
  `${projectId}/${diagramId}.${format}`

const bucket = (): InstanceType<typeof mongoose.mongo.GridFSBucket> => {
  const db = mongoose.connection.db
  if (!db) throw new Error("MongoDB chưa kết nối — không lưu được file diagram")
  return new mongoose.mongo.GridFSBucket(db, { bucketName: DIAGRAM_BUCKET })
}

type Bucket = ReturnType<typeof bucket>

/** Hai lượt render ghi đè cùng lúc có thể cùng xoá một bản cũ — file đã mất là kết quả mong muốn. */
const deleteQuietly = async (b: Bucket, id: Parameters<Bucket["delete"]>[0]): Promise<void> => {
  try {
    await b.delete(id)
  } catch (err) {
    if (!(err instanceof Error && /not found/i.test(err.message))) throw err
  }
}

export const gridFsDiagramStore: DiagramFileStore = {
  async save(projectId, diagramId, format, file) {
    const b = bucket()
    const filename = diagramFileName(projectId, diagramId, format)
    const previous = await b.find({ filename }).toArray()

    await new Promise<void>((resolve, reject) => {
      const upload = b.openUploadStream(filename, { metadata: { projectId, diagramId, format, contentType: file.contentType } })
      upload.once("finish", () => resolve())
      upload.once("error", reject)
      upload.end(file.data)
    })
    for (const old of previous) await deleteQuietly(b, old._id)
  },

  async remove(projectId, diagramId) {
    const b = bucket()
    const filenames = DIAGRAM_FILE_FORMATS.map((format) => diagramFileName(projectId, diagramId, format))
    for (const file of await b.find({ filename: { $in: filenames } }).toArray()) await deleteQuietly(b, file._id)
  },

  async load(projectId, diagramId, format) {
    const b = bucket()
    const [latest] = await b
      .find({ filename: diagramFileName(projectId, diagramId, format) })
      .sort({ uploadDate: -1 })
      .limit(1)
      .toArray()
    if (!latest) return null

    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      b.openDownloadStream(latest._id)
        .on("data", (chunk: Buffer) => chunks.push(chunk))
        .once("end", () => resolve())
        .once("error", reject)
    })
    const stored: unknown = latest.metadata?.contentType
    return { data: Buffer.concat(chunks), contentType: typeof stored === "string" ? stored : CONTENT_TYPES[format] }
  }
}

/** Store trong bộ nhớ — cho test và chạy thử không có Mongo. */
export const createMemoryDiagramStore = (): DiagramFileStore & { files: Map<string, StoredDiagramFile> } => {
  const files = new Map<string, StoredDiagramFile>()
  return {
    files,
    async save(projectId, diagramId, format, file) {
      files.set(diagramFileName(projectId, diagramId, format), { data: Buffer.from(file.data), contentType: file.contentType })
    },
    async load(projectId, diagramId, format) {
      return files.get(diagramFileName(projectId, diagramId, format)) ?? null
    },
    async remove(projectId, diagramId) {
      for (const format of DIAGRAM_FILE_FORMATS) files.delete(diagramFileName(projectId, diagramId, format))
    }
  }
}
