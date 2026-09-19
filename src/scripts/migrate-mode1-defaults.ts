/**
 * FLF-171 — backfill giá trị mặc định cho dữ liệu có trước mode 1.
 *
 * Cách dùng:
 *   npx tsx src/scripts/migrate-mode1-defaults.ts --dry-run   # chỉ đếm, không ghi
 *   npx tsx src/scripts/migrate-mode1-defaults.ts
 *
 * Việc làm:
 * - `projects` thiếu `mode` ⇒ `mode: "fpt"`, `import_state: null` (project cũ đều là mode 2). Cần để lọc
 *   danh sách theo mode bằng query (default của mongoose chỉ áp khi đọc document, không áp trong filter).
 * - `baselines` (snapshot) thiếu `type` ⇒ `type: "generated"`, `doc_version: null`.
 *
 * KHÔNG ghi `spines.baselines[]`: Spine chỉ được ghi qua op-engine (coding-rules §3.3). Entry cũ đọc ra
 * `generated`/`null` nhờ default của zod + mongoose; entry mới luôn có đủ field.
 * Chạy lại an toàn: filter chỉ khớp document còn thiếu field.
 */

import mongoose from "mongoose"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"

export interface BackfillStep {
  collection: string
  filter: Record<string, unknown>
  set: Record<string, unknown>
}

export const MODE1_BACKFILL_STEPS: readonly BackfillStep[] = [
  { collection: "projects", filter: { mode: { $exists: false } }, set: { mode: "fpt", import_state: null } },
  { collection: "baselines", filter: { type: { $exists: false } }, set: { type: "generated", doc_version: null } }
]

const main = async (): Promise<void> => {
  const dryRun = process.argv.includes("--dry-run")
  // Không dùng connectDB: nó còn khởi tạo replica set và tài khoản admin — script không được có tác dụng phụ đó
  await mongoose.connect(env.MONGO_URI)
  console.log(`🟢 Connected to MongoDB${dryRun ? " (dry-run: không ghi)" : ""}`)
  try {
    for (const step of MODE1_BACKFILL_STEPS) {
      const collection = mongoose.connection.collection(step.collection)
      if (dryRun) {
        console.log(`${step.collection}: sẽ cập nhật ${await collection.countDocuments(step.filter)} document`)
      } else {
        const result = await collection.updateMany(step.filter, { $set: step.set })
        console.log(`${step.collection}: đã cập nhật ${result.modifiedCount} document`)
      }
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
