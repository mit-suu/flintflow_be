/**
 * FLF-363 — đổi họ mẫu cũ sang nhãn mới của ngân hàng phần chung.
 *
 * Cách dùng:
 *   npx tsx src/scripts/migrate-template-family.ts --dry-run   # chỉ đếm, không ghi
 *   npx tsx src/scripts/migrate-template-family.ts
 *
 * Việc làm: `templateprofiles.template_family` và `org_templates.template_family` còn `ieee830` / `ieee_features` (FLF-252)
 * ⇒ `ieee29148`. Không bắt buộc: đọc ra đã đổi qua `normalizeTemplateFamily` — script chỉ làm dữ liệu gọn cho truy vấn.
 * `heading_map[].template_section` cũ (`ieee830:1.4`) giữ nguyên — mã nội bộ, không ai đọc lại.
 * Chạy lại an toàn: filter chỉ khớp giá trị cũ.
 */

import mongoose from "mongoose"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"

export interface FamilyStep {
  collection: string
  filter: Record<string, unknown>
  set: Record<string, unknown>
}

const LEGACY = { template_family: { $in: ["ieee830", "ieee_features"] } }

export const TEMPLATE_FAMILY_STEPS: readonly FamilyStep[] = [
  { collection: "templateprofiles", filter: LEGACY, set: { template_family: "ieee29148" } },
  { collection: "org_templates", filter: LEGACY, set: { template_family: "ieee29148" } }
]

const main = async (): Promise<void> => {
  const dryRun = process.argv.includes("--dry-run")
  // Không dùng connectDB: nó còn khởi tạo replica set và tài khoản admin — script không được có tác dụng phụ đó
  await mongoose.connect(env.MONGO_URI)
  console.log(`🟢 Connected to MongoDB${dryRun ? " (dry-run: không ghi)" : ""}`)
  try {
    for (const step of TEMPLATE_FAMILY_STEPS) {
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
