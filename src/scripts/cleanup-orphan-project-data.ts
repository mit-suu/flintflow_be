/**
 * Dọn dữ liệu mồ côi của dự án đã bị xoá cứng (bug QLHS #1–#2): xoá cứng cũ xoá bản ghi `projects` TRƯỚC rồi mới dọn, dọn lỗi
 * giữa chừng (Spine cũ không qua zod) ⇒ chat, Spine, changes, stepruns… còn nguyên mà dự án đã mất. Purge cũ cũng bỏ sót
 * `stepruns`, `spineembeddings`, `spinelocks`.
 *
 * Cách dùng (mặc định CHỈ ĐẾM, không ghi):
 *   npx tsx src/scripts/cleanup-orphan-project-data.ts                       # liệt kê mồ côi theo collection
 *   npx tsx src/scripts/cleanup-orphan-project-data.ts --project <id>        # chỉ xét một projectId
 *   npx tsx src/scripts/cleanup-orphan-project-data.ts --apply [--project <id>]  # xoá thật
 *
 * "Mồ côi" = `projectId` không còn bản ghi nào trong `projects` (kể cả dự án đã xoá mềm — chúng vẫn khôi phục được nên
 * KHÔNG đụng). Chỉ dọn collection trong `projectScopedModels()` (cùng danh sách `purgeProject` dùng); file GridFS / Cloudinary
 * của dự án mồ côi không dọn ở đây.
 */

import mongoose from "mongoose"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"
import { projectScopedModels } from "../modules/project/project-scoped-models.js"

/** Phần model script cần — tách ra để test không cần Mongo. */
export interface OrphanSource {
  modelName: string
  distinct(field: "projectId"): PromiseLike<unknown[]>
  countDocuments(filter: Record<string, unknown>): PromiseLike<number>
}

export interface OrphanReport {
  modelName: string
  projectIds: string[]
  documents: number
}

/**
 * Với mỗi collection: các `projectId` không nằm trong `existing` và số document của chúng. `only` (nếu có) giới hạn vào
 * một projectId. Collection không có mồ côi không xuất hiện trong kết quả.
 */
export const findOrphans = async (
  sources: readonly OrphanSource[],
  existing: ReadonlySet<string>,
  only: string | null = null
): Promise<OrphanReport[]> => {
  const reports: OrphanReport[] = []
  for (const source of sources) {
    const ids = (await source.distinct("projectId"))
      // Document thiếu `projectId` (dữ liệu hỏng) không thuộc dự án nào — không phải mồ côi của dự án đã xoá
      .filter((id) => id !== null && id !== undefined)
      .map((id) => String(id))
      .filter((id) => !existing.has(id) && (only === null || id === only))
    if (ids.length === 0) continue
    const documents = await source.countDocuments({ projectId: { $in: ids.map(toObjectIdOrRaw) } })
    reports.push({ modelName: source.modelName, projectIds: ids, documents })
  }
  return reports
}

const toObjectIdOrRaw = (id: string): unknown => (mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : id)

const argValue = (name: string): string | null => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? (process.argv[index + 1] ?? null) : null
}

const main = async (): Promise<void> => {
  const apply = process.argv.includes("--apply")
  const only = argValue("--project")
  // Không dùng connectDB: nó còn khởi tạo replica set và tài khoản admin — script không được có tác dụng phụ đó
  await mongoose.connect(env.MONGO_URI)
  console.log(`🟢 Connected to MongoDB${apply ? "" : " (dry-run: chỉ đếm, thêm --apply để xoá)"}`)
  try {
    // Đọc thẳng collection: model `Project` tự ẩn dự án đã xoá mềm, mà dự án xoá mềm KHÔNG phải mồ côi
    const projectIds = await mongoose.connection.collection("projects").distinct("_id")
    const existing = new Set(projectIds.map((id) => String(id)))
    const reports = await findOrphans(projectScopedModels() as unknown as OrphanSource[], existing, only)
    if (reports.length === 0) console.log("Không có dữ liệu mồ côi.")
    for (const report of reports) {
      console.log(`${report.modelName}: ${report.documents} document của ${report.projectIds.length} dự án đã mất`)
    }
    if (!apply) return
    for (const report of reports) {
      const model = projectScopedModels().find((m) => m.modelName === report.modelName)
      if (!model) continue
      const result = await model.deleteMany({ projectId: { $in: report.projectIds.map(toObjectIdOrRaw) } })
      console.log(`${report.modelName}: đã xoá ${result.deletedCount}`)
    }
  } finally {
    await mongoose.disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
