/**
 * Mode 1 v2 (FLF-186) — dọn index + dữ liệu chết của thời CR-theo-block, cho DB đã chạy P2–P4.
 *
 * Cách dùng:
 *   npx tsx src/scripts/migrate-mode1-v2-indexes.ts --dry-run       # chỉ in việc sẽ làm
 *   npx tsx src/scripts/migrate-mode1-v2-indexes.ts                 # chỉ đụng INDEX (an toàn, đủ để hết lỗi E11000)
 *   npx tsx src/scripts/migrate-mode1-v2-indexes.ts --clean-data    # thêm: XOÁ vị trí CR bản cũ + bỏ field chết
 *
 * Vì sao cần: V4 đổi vị trí CR từ block docx sang **phần tử Spine** (`path`). Mongoose tạo index mới nhưng
 * **không bao giờ xoá index cũ**, nên `changelocations` còn `projectId_1_cr_id_1_block_id_1` UNIQUE. Vị trí V4 không
 * có `block_id` ⇒ mọi document coi như `block_id: null` ⇒ C-3 chết từ vị trí thứ hai với
 * `E11000 duplicate key … dup key: { …, block_id: null }` (gặp thật 2026-09-20).
 *
 * Mặc định chỉ đụng index vì đó là thứ đang chặn người dùng, và xoá index thì tạo lại được. Xoá document /
 * `$unset` field là một chiều nên phải tự gọi `--clean-data`.
 *
 * Unique index `(projectId, cr_id, path)` chỉ tạo được khi **không còn vị trí bản cũ** (chúng không có `path`, từ
 * document thứ hai trong cùng CR là trùng `null`). Còn sót ⇒ script báo và bỏ qua, không tự xoá dữ liệu của ai.
 */

import mongoose from "mongoose"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"

/** Index của bản CR-theo-block, không còn trong schema nào. */
export const DEAD_INDEXES: readonly { collection: string; index: string }[] = [
  { collection: "changelocations", index: "projectId_1_cr_id_1_block_id_1" },
  { collection: "docblocks", index: "projectId_1_locked_by_cr_1" }
]

/** Index V4 đang dùng — tạo lại phòng khi DB cũ chưa có (mongoose chỉ tạo khi model được nạp). */
export const REQUIRED_INDEXES: readonly { collection: string; key: Record<string, 1>; unique: boolean }[] = [
  { collection: "changelocations", key: { projectId: 1, cr_id: 1, location_id: 1 }, unique: true },
  { collection: "changelocations", key: { projectId: 1, cr_id: 1, path: 1 }, unique: true },
  { collection: "spinelocks", key: { projectId: 1, path: 1 }, unique: true }
]

/** Field của bản theo block — giữ lại chỉ gây hiểu nhầm. Chỉ bỏ khi `--clean-data`. */
export const DEAD_FIELDS: readonly { collection: string; fields: string[] }[] = [
  { collection: "changelocations", fields: ["block_id", "block"] },
  { collection: "docblocks", fields: ["locked_by_cr"] }
]

/** Vị trí CR bản cũ: không có `path` nên V4 không đọc được — C-3 chạy lại sẽ sinh vị trí mới thay thế. */
export const LEGACY_LOCATIONS = { collection: "changelocations", filter: { path: { $exists: false } } } as const

const main = async (): Promise<void> => {
  const dryRun = process.argv.includes("--dry-run")
  const cleanData = process.argv.includes("--clean-data")
  // Không dùng connectDB: nó còn khởi tạo replica set và tài khoản admin — script không được có tác dụng phụ đó
  await mongoose.connect(env.MONGO_URI)
  console.log(`🟢 Connected to MongoDB${dryRun ? " (dry-run: không ghi)" : ""}${cleanData ? " (--clean-data: xoá cả dữ liệu cũ)" : ""}`)
  const db = mongoose.connection.db!
  const has = async (name: string): Promise<boolean> => (await db.listCollections({ name }).toArray()).length > 0
  const hasIndex = async (collection: string, name: string): Promise<boolean> =>
    (await db.collection(collection).indexes()).some((i) => i.name === name)

  try {
    // 1. Index chết — thủ phạm của E11000
    for (const { collection, index } of DEAD_INDEXES) {
      if (!(await has(collection)) || !(await hasIndex(collection, index))) continue
      if (dryRun) console.log(`${collection}: sẽ xoá index ${index}`)
      else {
        await db.collection(collection).dropIndex(index)
        console.log(`${collection}: đã xoá index ${index}`)
      }
    }

    // 2. Dữ liệu bản cũ (chỉ khi được gọi tên)
    const legacyCount = (await has(LEGACY_LOCATIONS.collection)) ? await db.collection(LEGACY_LOCATIONS.collection).countDocuments(LEGACY_LOCATIONS.filter) : 0
    if (cleanData && legacyCount) {
      if (dryRun) console.log(`${LEGACY_LOCATIONS.collection}: sẽ XOÁ ${legacyCount} vị trí CR bản cũ (không có path)`)
      else {
        const res = await db.collection(LEGACY_LOCATIONS.collection).deleteMany(LEGACY_LOCATIONS.filter)
        console.log(`${LEGACY_LOCATIONS.collection}: đã xoá ${res.deletedCount} vị trí CR bản cũ`)
      }
    }

    // 3. Index đang dùng — unique theo path cần sạch vị trí bản cũ trước
    for (const { collection, key, unique } of REQUIRED_INDEXES) {
      if (!(await has(collection))) continue
      const name = Object.keys(key)
        .map((k) => `${k}_1`)
        .join("_")
      if (await hasIndex(collection, name)) continue
      const blocked = "path" in key && legacyCount > 0 && !(cleanData && !dryRun)
      if (blocked) {
        console.log(`${collection}: BỎ QUA index ${name} — còn ${legacyCount} vị trí bản cũ không có path. Chạy lại với --clean-data để xoá chúng.`)
        continue
      }
      if (dryRun) console.log(`${collection}: sẽ tạo index ${name}${unique ? " (unique)" : ""}`)
      else {
        await db.collection(collection).createIndex(key, { unique })
        console.log(`${collection}: đã tạo index ${name}${unique ? " (unique)" : ""}`)
      }
    }

    // 4. Field chết (chỉ khi được gọi tên)
    if (cleanData) {
      for (const { collection, fields } of DEAD_FIELDS) {
        if (!(await has(collection))) continue
        const filter = { $or: fields.map((f) => ({ [f]: { $exists: true } })) }
        const count = await db.collection(collection).countDocuments(filter)
        if (!count) continue
        if (dryRun) console.log(`${collection}: sẽ bỏ ${fields.join(", ")} khỏi ${count} document`)
        else {
          const res = await db.collection(collection).updateMany(filter, { $unset: Object.fromEntries(fields.map((f) => [f, ""])) })
          console.log(`${collection}: đã bỏ ${fields.join(", ")} khỏi ${res.modifiedCount} document`)
        }
      }
    } else if (legacyCount) {
      console.log(`Còn ${legacyCount} vị trí CR bản cũ và field theo block — chạy lại với --clean-data để dọn nốt (một chiều).`)
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
