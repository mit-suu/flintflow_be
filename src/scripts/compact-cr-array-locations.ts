/**
 * Rút gọn vị trí "thêm mới" (`arr[]`) của change request lưu trước FLF-308, chạy một lần.
 *
 * Cách dùng:
 *   npm run migrate:cr-array-locations -- --dry-run   # chỉ đếm vị trí + số byte bớt được, không ghi
 *   npm run migrate:cr-array-locations                # ghi thật
 *
 * Vì sao cần: trước FLF-308 vị trí `arr[]` chép cả mảng vào `proposal.old_text` và `new_text` (dự án upload: `functions[]`
 * 111 KB, `screens[]` 35 KB × 2). Mỗi request CR tải hết từ Mongo ⇒ 340 KB / CR, hơn 10 s qua mạng chậm tới Atlas.
 * Bản ghi mới đã gọn (`snapshotOf`); script đưa bản ghi cũ về đúng dạng đó.
 *
 * Không mất gì: `base_hash = sha256(old_text cũ)` ⇒ `unchangedSince` so `sha256(hiện tại)` với nó, cùng kết quả với so
 * `old_text` cũ. `new_text` chỉ còn phần tử thêm (`shownTexts`, như FE đang hiện). Không đụng Spine.
 */
import { pathToFileURL } from "node:url"
import { shownTexts } from "../modules/change-request/change-request.service.js"
import { isArrayPath, sha256 } from "../modules/change-request/spine-location.js"

export interface LegacyLocation {
  path: string
  proposal: { old_text: string; new_text: string | null; base_hash?: string | null } | null
}

/** `$set` cho một vị trí cũ; `null` khi không cần (không phải `arr[]`, chưa có đề xuất, đã ở dạng mới). */
export const compactSet = (loc: LegacyLocation): Record<string, string | null> | null => {
  const p = loc.proposal
  if (!p || !isArrayPath(loc.path) || p.base_hash || p.old_text === "[]") return null
  const shown = shownTexts(loc.path, p)
  return { "proposal.old_text": shown.old_text, "proposal.new_text": shown.new_text, "proposal.base_hash": sha256(p.old_text) }
}

const main = async (): Promise<void> => {
  const dryRun = process.argv.slice(2).includes("--dry-run")
  const [{ default: mongoose }, { env }] = await Promise.all([import("mongoose"), import("../config/env.js")])
  // Không dùng connectDB: nó còn khởi tạo replica set và tài khoản admin — script không được có tác dụng phụ đó
  await mongoose.connect(env.MONGO_URI)
  console.log(`🟢 Connected to MongoDB${dryRun ? " (dry-run: không ghi)" : ""}`)
  try {
    const col = mongoose.connection.collection("changelocations")
    const cursor = col.find(
      { path: /\[\]$/, proposal: { $ne: null }, "proposal.old_text": { $ne: "[]" } },
      { projection: { path: 1, cr_id: 1, location_id: 1, "proposal.old_text": 1, "proposal.new_text": 1, "proposal.base_hash": 1 } }
    )
    let count = 0
    let saved = 0
    for await (const doc of cursor) {
      const set = compactSet(doc as unknown as LegacyLocation)
      if (!set) continue
      const p = (doc as unknown as LegacyLocation).proposal!
      const before = p.old_text.length + (p.new_text?.length ?? 0)
      const after = set["proposal.old_text"]!.length + (set["proposal.new_text"]?.length ?? 0)
      count += 1
      saved += before - after
      console.log(`  - ${doc.cr_id} ${doc.location_id} ${doc.path}: ${before} → ${after} ký tự`)
      if (!dryRun) await col.updateOne({ _id: doc._id }, { $set: set })
    }
    console.log(`${dryRun ? "Dry-run: sẽ rút gọn" : "Đã rút gọn"} ${count} vị trí, bớt ${saved} ký tự.`)
  } finally {
    await mongoose.disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("❌ Rút gọn vị trí CR lỗi:", err)
    process.exit(1)
  })
}
