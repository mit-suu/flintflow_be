/**
 * FLF-318 — dự án tạo SRS (`fpt`) đã được Lead ký baseline TRƯỚC khi deploy FLF-318 ⇒ chuyển sang mode 1 bằng đúng service
 * chạy sau lượt ký (`convertFromFpt`), để tạo change request được.
 *
 * Cách dùng:
 *   npx tsx src/scripts/migrate-convert-fpt-baselined.ts --dry-run   # chỉ liệt kê, không ghi
 *   npx tsx src/scripts/migrate-convert-fpt-baselined.ts
 *   npm run migrate:spine-embeddings                                 # sau đó: index embedding cho C-3
 *
 * Chạy lại an toàn: dự án đã chuyển không còn `mode = fpt`; lần trước lỗi giữa chừng thì service tự dọn rồi chạy lại.
 * Mã `CR-nnn` cũ của FLF-294 vẫn nằm trong Record of Changes; `CrCounter` dùng chung nên CR mới không trùng mã.
 */

import mongoose from "mongoose"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"
import { convertFromFpt } from "../modules/import/convert-from-fpt.service.js"
import { Project } from "../modules/project/project.model.js"
import { Baseline } from "../modules/spine/baseline.model.js"

/** Dự án `fpt` (hoặc thiếu `mode` — dữ liệu cũ) có ít nhất một baseline Lead ký. */
export const findCandidates = async (): Promise<{ _id: mongoose.Types.ObjectId; name: string; userId: mongoose.Types.ObjectId }[]> => {
  const signed = await Baseline.distinct("projectId", { type: "generated" })
  if (!signed.length) return []
  return Project.find({ _id: { $in: signed }, mode: { $in: ["fpt", null] } }, { name: 1, userId: 1 }).lean()
}

const main = async (): Promise<void> => {
  const dryRun = process.argv.includes("--dry-run")
  // Không dùng connectDB: nó còn khởi tạo replica set và tài khoản admin — script không được có tác dụng phụ đó
  await mongoose.connect(env.MONGO_URI)
  console.log(`🟢 Connected to MongoDB${dryRun ? " (dry-run: không ghi)" : ""}`)
  try {
    const candidates = await findCandidates()
    console.log(`${candidates.length} dự án fpt đã ký baseline chưa chuyển sang mode 1`)
    let ok = 0
    for (const p of candidates) {
      if (dryRun) {
        console.log(`- ${String(p._id)} ${p.name}`)
        continue
      }
      try {
        const result = await convertFromFpt(String(p._id), String(p.userId), { quiet: true })
        if (result) ok += 1
        console.log(`${result ? "✓" : "–"} ${String(p._id)} ${p.name}${result ? ` ⇒ ${result.doc_version} (${result.baseline_id})` : " (bỏ qua)"}`)
      } catch (err) {
        console.error(`✗ ${String(p._id)} ${p.name}:`, err)
      }
    }
    if (!dryRun) console.log(`Đã chuyển ${ok}/${candidates.length} dự án`)
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
