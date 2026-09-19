/**
 * Gán `sourceMode = "fpt_template"` cho dự án tạo trước khi có field này.
 *
 * Cách dùng (BACKUP collection `projects` trước khi chạy trên DB dùng chung):
 *   mongodump --uri "$MONGO_URI" --collection projects --out backups/<ngày>
 *   npm run migrate:source-mode -- --dry-run   # chỉ đếm, không ghi
 *   npm run migrate:source-mode
 *
 * Luồng cũ (onboarding → tạo dự án chỉ có tên → pipeline trên mẫu FPT) chính là Flow 2.1, nên
 * dự án cũ = `fpt_template`. Chỉ đụng document chưa có field ⇒ chạy lại là idempotent.
 * Phải chạy TRƯỚC khi deploy code có `sourceMode: required`, nếu không save dự án cũ sẽ lỗi validate.
 */
import { pathToFileURL } from "node:url"
import type { ProjectSourceMode } from "../modules/project/project.model.js"

export const LEGACY_SOURCE_MODE: ProjectSourceMode = "fpt_template"
export const MISSING_SOURCE_MODE_FILTER = { sourceMode: { $exists: false } } as const

/** Phần tối thiểu của collection Mongo mà script cần — đủ để test bằng collection giả. */
export interface ProjectCollectionLike {
  countDocuments(filter: typeof MISSING_SOURCE_MODE_FILTER): Promise<number>
  updateMany(
    filter: typeof MISSING_SOURCE_MODE_FILTER,
    update: { $set: { sourceMode: ProjectSourceMode } }
  ): Promise<{ modifiedCount: number }>
}

/** Trả số dự án đã (hoặc sẽ, khi dry-run) được gán mode. */
export const migrateProjectSourceMode = async (
  projects: ProjectCollectionLike,
  { dryRun = false }: { dryRun?: boolean } = {}
): Promise<number> => {
  if (dryRun) return projects.countDocuments(MISSING_SOURCE_MODE_FILTER)
  const result = await projects.updateMany(MISSING_SOURCE_MODE_FILTER, { $set: { sourceMode: LEGACY_SOURCE_MODE } })
  return result.modifiedCount
}

const main = async (): Promise<void> => {
  const dryRun = process.argv.includes("--dry-run")
  const [{ default: mongoose }, { env }] = await Promise.all([import("mongoose"), import("../config/env.js")])

  // Không dùng connectDB: nó còn khởi tạo replica set và tài khoản admin — script không được có tác dụng phụ đó
  await mongoose.connect(env.MONGO_URI)
  try {
    const count = await migrateProjectSourceMode(mongoose.connection.collection("projects"), { dryRun })
    console.log(
      dryRun
        ? `🔎 Dry-run: ${count} dự án chưa có sourceMode sẽ được gán "${LEGACY_SOURCE_MODE}"`
        : `✅ Đã gán sourceMode "${LEGACY_SOURCE_MODE}" cho ${count} dự án`
    )
  } finally {
    await mongoose.disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("❌ Migration lỗi:", err)
    process.exit(1)
  })
}
