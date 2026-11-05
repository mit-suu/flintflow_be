/**
 * Lưu SVG/PNG đã render trong GridFS (bucket `diagram-files`), tên file `<projectId>/<diagramId>.<format>`.
 * Ghi đè = upload bản mới rồi xoá bản cũ, nên người đọc không bao giờ thấy file rỗng.
 *
 * PNG theo ngôn ngữ tài liệu (FLF-265 N1): `<projectId>/<diagramId>.<locale>.<hash>.png` — `hash` là hash nguồn sơ đồ đã
 * dịch (`localized-diagram.service#localizedDiagramHash`). Tên mang hash nên bản nháp và baseline đã ký (nguồn khác nhau)
 * cùng có ảnh mà không ghi đè nhau; mỗi (sơ đồ, ngôn ngữ) giữ `LOCALIZED_VERSIONS_KEPT` bản mới nhất.
 */

import mongoose from "mongoose"

export type DiagramFileFormat = "svg" | "png"

export interface StoredDiagramFile {
  data: Buffer
  contentType: string
  /**
   * Dấu phiên bản của file đã lưu (chỉ có khi đọc ra): đổi mỗi lần file được ghi lại — kể cả vẽ ép ra đúng bytes cũ.
   * Ảnh dạng tham chiếu của GET /document lấy hash từ đây, không cần tải bytes (FLF-369).
   */
  version?: string
}

/** Metadata của file đã lưu, không kèm bytes. */
export interface DiagramFileStat {
  version: string
}

export interface DiagramFileStore {
  save(projectId: string, diagramId: string, format: DiagramFileFormat, file: StoredDiagramFile): Promise<void>
  load(projectId: string, diagramId: string, format: DiagramFileFormat): Promise<StoredDiagramFile | null>
  /** Xoá mọi file (svg, png, PNG theo ngôn ngữ) của một diagram; không có file thì thôi. */
  remove(projectId: string, diagramId: string): Promise<void>
  /** PNG theo ngôn ngữ của một nguồn sơ đồ đã dịch (N1); dọn bản cũ, giữ `LOCALIZED_VERSIONS_KEPT` bản. */
  saveLocalized(projectId: string, diagramId: string, locale: string, hash: string, file: StoredDiagramFile): Promise<void>
  loadLocalized(projectId: string, diagramId: string, locale: string, hash: string): Promise<StoredDiagramFile | null>
  /** Chỉ metadata (không tải bytes) — `null` khi chưa có file. */
  stat(projectId: string, diagramId: string, format: DiagramFileFormat): Promise<DiagramFileStat | null>
  statLocalized(projectId: string, diagramId: string, locale: string, hash: string): Promise<DiagramFileStat | null>
  /**
   * Metadata mọi PNG của dự án trong MỘT truy vấn: tên file tương đối (`<id>.png`, `<id>.<locale>.<hash>.png`) ⇒ stat.
   * Dùng cho GET /document dạng tham chiếu — 60 ảnh là 60 lượt hỏi DB nếu stat từng file.
   */
  statAllPng(projectId: string): Promise<Map<string, DiagramFileStat>>
}

export const DIAGRAM_FILE_FORMATS: readonly DiagramFileFormat[] = ["svg", "png"]

export const DIAGRAM_BUCKET = "diagram-files"

export const CONTENT_TYPES: Readonly<Record<DiagramFileFormat, string>> = { svg: "image/svg+xml", png: "image/png" }

/** Số PNG theo ngôn ngữ giữ lại mỗi (sơ đồ, ngôn ngữ): bản nháp hiện tại + vài nguồn gần đây (baseline đã ký…). */
export const LOCALIZED_VERSIONS_KEPT = 3

export const diagramFileName = (projectId: string, diagramId: string, format: DiagramFileFormat): string =>
  `${projectId}/${diagramId}.${format}`

export const localizedDiagramFileName = (projectId: string, diagramId: string, locale: string, hash: string): string =>
  `${projectId}/${diagramId}.${locale}.${hash}.png`

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Mọi PNG theo ngôn ngữ của một diagram (`locale` không có ⇒ mọi ngôn ngữ). Neo `^` + tiền tố cố định ⇒ dùng được index `filename`. */
const localizedNamePattern = (projectId: string, diagramId: string, locale?: string): RegExp =>
  new RegExp(`^${escapeRegExp(`${projectId}/${diagramId}.`)}${locale ? escapeRegExp(locale) : "[a-z]{2}(-[A-Za-z]+)?"}\\.[0-9a-f]+\\.png$`)

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

const upload = (b: Bucket, filename: string, metadata: Record<string, unknown>, data: Buffer): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const stream = b.openUploadStream(filename, { metadata })
    stream.once("finish", () => resolve())
    stream.once("error", reject)
    stream.end(data)
  })

type GridFile = { _id: unknown; length: number }
const fileVersion = (file: GridFile): string => `${String(file._id)}:${file.length}`

const latestFile = async (b: Bucket, filename: string) => (await b.find({ filename }).sort({ uploadDate: -1, _id: -1 }).limit(1).toArray())[0]

const statFile = async (b: Bucket, filename: string): Promise<DiagramFileStat | null> => {
  const latest = await latestFile(b, filename)
  return latest ? { version: fileVersion(latest) } : null
}

const download = async (b: Bucket, filename: string, fallbackType: string): Promise<StoredDiagramFile | null> => {
  const latest = await latestFile(b, filename)
  if (!latest) return null

  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    b.openDownloadStream(latest._id)
      .on("data", (chunk: Buffer) => chunks.push(chunk))
      .once("end", () => resolve())
      .once("error", reject)
  })
  const stored: unknown = latest.metadata?.contentType
  return { data: Buffer.concat(chunks), contentType: typeof stored === "string" ? stored : fallbackType, version: fileVersion(latest) }
}

/** Tên file cần xoá để mỗi (sơ đồ, ngôn ngữ) còn `kept` tên mới nhất (mới ⇒ cũ); bản trùng tên cũ hơn cũng xoá. */
const outdated = <T extends { filename: string }>(newestFirst: readonly T[], kept: number): T[] => {
  const names = new Set<string>()
  return newestFirst.filter((file) => {
    if (names.has(file.filename)) return true
    if (names.size >= kept) return true
    names.add(file.filename)
    return false
  })
}

export const gridFsDiagramStore: DiagramFileStore = {
  async save(projectId, diagramId, format, file) {
    const b = bucket()
    const filename = diagramFileName(projectId, diagramId, format)
    const previous = await b.find({ filename }).toArray()

    await upload(b, filename, { projectId, diagramId, format, contentType: file.contentType }, file.data)
    for (const old of previous) await deleteQuietly(b, old._id)
  },

  async remove(projectId, diagramId) {
    const b = bucket()
    const filenames = DIAGRAM_FILE_FORMATS.map((format) => diagramFileName(projectId, diagramId, format))
    const files = await b.find({ $or: [{ filename: { $in: filenames } }, { filename: localizedNamePattern(projectId, diagramId) }] }).toArray()
    for (const file of files) await deleteQuietly(b, file._id)
  },

  async load(projectId, diagramId, format) {
    return download(bucket(), diagramFileName(projectId, diagramId, format), CONTENT_TYPES[format])
  },

  async saveLocalized(projectId, diagramId, locale, hash, file) {
    const b = bucket()
    const filename = localizedDiagramFileName(projectId, diagramId, locale, hash)
    await upload(b, filename, { projectId, diagramId, format: "png", locale, hash, contentType: file.contentType }, file.data)
    const files = await b.find({ filename: localizedNamePattern(projectId, diagramId, locale) }).sort({ uploadDate: -1, _id: -1 }).toArray()
    for (const old of outdated(files, LOCALIZED_VERSIONS_KEPT)) await deleteQuietly(b, old._id)
  },

  async loadLocalized(projectId, diagramId, locale, hash) {
    return download(bucket(), localizedDiagramFileName(projectId, diagramId, locale, hash), CONTENT_TYPES.png)
  },

  async stat(projectId, diagramId, format) {
    return statFile(bucket(), diagramFileName(projectId, diagramId, format))
  },

  async statLocalized(projectId, diagramId, locale, hash) {
    return statFile(bucket(), localizedDiagramFileName(projectId, diagramId, locale, hash))
  },

  async statAllPng(projectId) {
    const prefix = `${projectId}/`
    // Cũ trước, mới sau ⇒ bản mới nhất của cùng tên ghi đè
    const files = await bucket()
      .find({ filename: new RegExp(`^${escapeRegExp(prefix)}[^/]+\\.png$`) }, { projection: { filename: 1, length: 1, uploadDate: 1 } })
      .sort({ uploadDate: 1, _id: 1 })
      .toArray()
    return new Map(files.map((f) => [f.filename.slice(prefix.length), { version: fileVersion(f) }]))
  }
}

/** Store trong bộ nhớ — cho test và chạy thử không có Mongo. */
export const createMemoryDiagramStore = (): DiagramFileStore & { files: Map<string, StoredDiagramFile> } => {
  const files = new Map<string, StoredDiagramFile>()
  let writes = 0
  const put = (filename: string, file: StoredDiagramFile): void => {
    files.set(filename, { data: Buffer.from(file.data), contentType: file.contentType, version: `mem${++writes}:${file.data.length}` })
  }
  const stat = (filename: string): DiagramFileStat | null => {
    const file = files.get(filename)
    return file ? { version: file.version! } : null
  }
  return {
    files,
    async save(projectId, diagramId, format, file) {
      put(diagramFileName(projectId, diagramId, format), file)
    },
    async load(projectId, diagramId, format) {
      return files.get(diagramFileName(projectId, diagramId, format)) ?? null
    },
    async stat(projectId, diagramId, format) {
      return stat(diagramFileName(projectId, diagramId, format))
    },
    async statLocalized(projectId, diagramId, locale, hash) {
      return stat(localizedDiagramFileName(projectId, diagramId, locale, hash))
    },
    async statAllPng(projectId) {
      const prefix = `${projectId}/`
      return new Map(
        [...files].filter(([name]) => name.startsWith(prefix) && name.endsWith(".png")).map(([name, file]) => [name.slice(prefix.length), { version: file.version! }])
      )
    },
    async remove(projectId, diagramId) {
      for (const format of DIAGRAM_FILE_FORMATS) files.delete(diagramFileName(projectId, diagramId, format))
      const pattern = localizedNamePattern(projectId, diagramId)
      for (const name of [...files.keys()]) if (pattern.test(name)) files.delete(name)
    },
    async saveLocalized(projectId, diagramId, locale, hash, file) {
      const filename = localizedDiagramFileName(projectId, diagramId, locale, hash)
      // Map giữ thứ tự chèn: xoá rồi chèn lại ⇒ bản vừa lưu là mới nhất
      files.delete(filename)
      put(filename, file)
      const pattern = localizedNamePattern(projectId, diagramId, locale)
      const newestFirst = [...files.keys()].filter((name) => pattern.test(name)).reverse().map((filename) => ({ filename }))
      for (const { filename: old } of outdated(newestFirst, LOCALIZED_VERSIONS_KEPT)) files.delete(old)
    },
    async loadLocalized(projectId, diagramId, locale, hash) {
      return files.get(localizedDiagramFileName(projectId, diagramId, locale, hash)) ?? null
    }
  }
}
