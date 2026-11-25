/**
 * FLF-466 phase 01 — CR đã nằm trong `cr_ids` của một bản phát hành cũ chuyển `written` → `released` (BF §4).
 * CR giả của đổi mẫu cũ (`written`, không thuộc bản phát hành nào) để nguyên.
 *
 * Cách dùng:
 *   npm run migrate:cr-released -- --dry-run   # chỉ đếm (mặc định khi không có --apply)
 *   npm run migrate:cr-released -- --apply
 * Chạy lại an toàn: CR đã `released` không khớp bộ lọc.
 */

import mongoose from "mongoose"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"
import { ChangeRequest } from "../modules/change-request/change-request.model.js"
import { DocVersion } from "../modules/doc-version/doc-version.model.js"

const main = async (): Promise<void> => {
  const apply = process.argv.includes("--apply")
  await mongoose.connect(env.MONGO_URI)
  console.log(`🟢 Connected to MongoDB${apply ? "" : " (dry-run: không ghi, thêm --apply để ghi)"}`)
  try {
    let moved = 0
    for await (const rel of DocVersion.find({ kind: "release", "cr_ids.0": { $exists: true } }, { projectId: 1, cr_ids: 1 }).lean()) {
      const filter = { projectId: rel.projectId, cr_id: { $in: rel.cr_ids }, status: "written" as const }
      if (apply) moved += (await ChangeRequest.updateMany(filter, { $set: { status: "released" } })).modifiedCount
      else moved += await ChangeRequest.countDocuments(filter)
    }
    console.log(`${apply ? "Đã chuyển" : "Sẽ chuyển"} ${moved} CR sang "đã phát hành"`)
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
