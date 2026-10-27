/**
 * FLF-339 — `diagrams[]` đổi `puml` → `source` + `format` (`puml` | `svg`). Dọn collection `spines` cho khớp schema mới.
 *
 * Cách dùng (BACKUP TRƯỚC: `mongodump --uri "$MONGO_URI" --collection spines --out <dir>`):
 *   npm run migrate:diagram-source -- --dry-run   # chỉ đếm (mặc định khi không có --apply / --revert)
 *   npm run migrate:diagram-source -- --apply     # { puml } ⇒ { format: "puml", source }
 *   npm run migrate:diagram-source -- --revert    # ngược lại — chạy TRƯỚC khi lùi image về bản chưa có FLF-339
 *
 * Ngoại lệ có chủ đích của coding-rules §3.3 (ghi ngoài op engine): nội dung Spine không đổi, chỉ đổi tên field, nên
 * không tăng `spine_version`, không tạo change (một change "đổi tên field" trên mọi project chỉ làm rác lịch sử, và
 * undo của nó vô nghĩa). Code mới đọc được cả hai dạng (`legacy-diagram.ts`) — migration chỉ là dọn dẹp, chạy lúc nào
 * cũng được. Ghi bằng pipeline update CAS theo `(_id, spine_version)`: doc đang có người ghi ⇒ bỏ qua, chạy lại làm tiếp.
 * Baseline snapshot và lịch sử `changes` KHÔNG bị viết lại — dạng cũ ở đó được chuyển lúc đọc, vĩnh viễn.
 */

import mongoose from "mongoose"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"
import { Spine as SpineModel } from "../modules/spine/spine.model.js"

export type MigrationMode = "dry-run" | "apply" | "revert"

export interface MigrationReport {
  mode: MigrationMode
  /** Doc cần đổi. */
  docs: number
  /** Số phần tử `diagrams[]` trong các doc đó. */
  diagrams: number
  /** Doc đã ghi (0 khi dry-run). */
  updated: number
  /** Doc bị bỏ qua vì `spine_version` đổi giữa lúc đọc và lúc ghi. */
  skipped: number
  /** Chỉ `revert`: hình `format = svg` — code cũ không vẽ được, sẽ thành nguồn PlantUML hỏng (`render_error`). */
  svg: number
}

const TO_SOURCE = [
  {
    $set: {
      diagrams: {
        $map: {
          input: "$diagrams",
          as: "d",
          in: { $mergeObjects: ["$$d", { source: { $ifNull: ["$$d.source", "$$d.puml"] }, format: { $ifNull: ["$$d.format", "puml"] } }] }
        }
      }
    }
  },
  { $unset: "diagrams.puml" }
]

const TO_PUML = [
  { $set: { diagrams: { $map: { input: "$diagrams", as: "d", in: { $mergeObjects: ["$$d", { puml: { $ifNull: ["$$d.source", ""] } }] } } } } },
  { $unset: ["diagrams.source", "diagrams.format"] }
]

interface RawDiagram {
  format?: string
}

export const migrateDiagramSource = async (mode: MigrationMode): Promise<MigrationReport> => {
  const collection = SpineModel.collection
  const filter = mode === "revert" ? { "diagrams.source": { $exists: true } } : { "diagrams.puml": { $exists: true } }
  const report: MigrationReport = { mode, docs: 0, diagrams: 0, updated: 0, skipped: 0, svg: 0 }
  const cursor = collection.find(filter, { projection: { _id: 1, spine_version: 1, diagrams: 1 } })
  for await (const doc of cursor) {
    const diagrams = (doc.diagrams ?? []) as RawDiagram[]
    report.docs += 1
    report.diagrams += diagrams.length
    if (mode === "revert") report.svg += diagrams.filter((d) => d.format === "svg").length
    if (mode === "dry-run") continue
    const result = await collection.updateOne({ _id: doc._id, spine_version: doc.spine_version }, mode === "apply" ? TO_SOURCE : TO_PUML)
    if (result.modifiedCount === 1) report.updated += 1
    else report.skipped += 1
  }
  return report
}

const modeOf = (argv: readonly string[]): MigrationMode => (argv.includes("--revert") ? "revert" : argv.includes("--apply") ? "apply" : "dry-run")

const main = async (): Promise<void> => {
  const mode = modeOf(process.argv)
  await mongoose.connect(env.MONGO_URI)
  console.log(`🟢 Connected to MongoDB (${mode}${mode === "dry-run" ? ": không ghi, thêm --apply để ghi" : ""})`)
  try {
    const r = await migrateDiagramSource(mode)
    const verb = mode === "dry-run" ? "Sẽ chuyển" : mode === "apply" ? "Đã chuyển" : "Đã trả về dạng puml"
    console.log(`${verb} ${r.diagrams} diagram ở ${r.docs} Spine (ghi ${r.updated}, bỏ qua vì đang có người ghi ${r.skipped})`)
    if (r.skipped > 0) console.log("⚠️  Còn doc bị bỏ qua — chạy lại lệnh để làm tiếp.")
    if (r.svg > 0) console.warn(`⚠️  ${r.svg} hình format=svg: code cũ không vẽ được — sẽ thành cờ render_error cho tới khi vẽ lại.`)
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
