/**
 * `screens[].flow_to` đổi từ mảng id màn đích (`string[]`) sang mảng cạnh `{ to, trigger?, guard? }`. Dọn collection
 * `spines` cho khớp schema mới.
 *
 * Cách dùng (BACKUP TRƯỚC: `mongodump --uri "$MONGO_URI" --collection spines --out <dir>`):
 *   npm run migrate:flow-edges -- --dry-run   # chỉ đếm (mặc định khi không có --apply / --revert)
 *   npm run migrate:flow-edges -- --apply     # "S02" ⇒ { to: "S02" }
 *   npm run migrate:flow-edges -- --revert    # { to } ⇒ "S02" (mất trigger / guard) — chạy TRƯỚC khi lùi image về bản cũ
 *
 * Ngoại lệ có chủ đích của coding-rules §3.3 (ghi ngoài op engine): nội dung Spine không đổi nghĩa (cạnh cũ chưa có
 * trigger / guard), nên không tăng `spine_version`, không tạo change. Code mới đọc được cả hai dạng (`legacy-flow.ts`) —
 * migration chỉ là dọn dẹp, chạy lúc nào cũng được. Ghi bằng pipeline update CAS theo `(_id, spine_version)`: doc đang có
 * người ghi ⇒ bỏ qua, chạy lại làm tiếp. Baseline snapshot và lịch sử `changes` KHÔNG bị viết lại — dạng cũ ở đó được
 * chuyển lúc đọc, vĩnh viễn.
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
  /** Số cạnh `flow_to` cần đổi trong các doc đó. */
  edges: number
  /** Doc đã ghi (0 khi dry-run). */
  updated: number
  /** Doc bị bỏ qua vì `spine_version` đổi giữa lúc đọc và lúc ghi. */
  skipped: number
  /** Chỉ `revert`: cạnh đang có trigger / guard — sẽ mất chữ. */
  labelled: number
}

const isString = { $eq: [{ $type: "$$f" }, "string"] }

const mapFlow = (inner: object) => [
  {
    $set: {
      screens: {
        $map: {
          input: "$screens",
          as: "s",
          in: { $mergeObjects: ["$$s", { flow_to: { $map: { input: { $ifNull: ["$$s.flow_to", []] }, as: "f", in: inner } } }] }
        }
      }
    }
  }
]

const TO_EDGES = mapFlow({ $cond: [isString, { to: "$$f" }, "$$f"] })
const TO_IDS = mapFlow({ $cond: [isString, "$$f", "$$f.to"] })

interface RawScreen {
  flow_to?: unknown[]
}

export const migrateFlowEdges = async (mode: MigrationMode): Promise<MigrationReport> => {
  const collection = SpineModel.collection
  const report: MigrationReport = { mode, docs: 0, edges: 0, updated: 0, skipped: 0, labelled: 0 }
  const cursor = collection.find({ "screens.flow_to.0": { $exists: true } }, { projection: { _id: 1, spine_version: 1, screens: 1 } })
  for await (const doc of cursor) {
    const flows = ((doc.screens ?? []) as RawScreen[]).flatMap((s) => s.flow_to ?? [])
    const target = flows.filter((f) => (mode === "revert" ? typeof f === "object" && f !== null : typeof f === "string"))
    if (target.length === 0) continue
    report.docs += 1
    report.edges += target.length
    if (mode === "revert") report.labelled += target.filter((f) => "trigger" in (f as object) || "guard" in (f as object)).length
    if (mode === "dry-run") continue
    const result = await collection.updateOne({ _id: doc._id, spine_version: doc.spine_version }, mode === "apply" ? TO_EDGES : TO_IDS)
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
    const r = await migrateFlowEdges(mode)
    const verb = mode === "dry-run" ? "Sẽ chuyển" : mode === "apply" ? "Đã chuyển" : "Đã trả về dạng id"
    console.log(`${verb} ${r.edges} cạnh flow_to ở ${r.docs} Spine (ghi ${r.updated}, bỏ qua vì đang có người ghi ${r.skipped})`)
    if (r.skipped > 0) console.log("⚠️  Còn doc bị bỏ qua — chạy lại lệnh để làm tiếp.")
    if (r.labelled > 0) console.warn(`⚠️  ${r.labelled} cạnh có trigger / guard sẽ mất chữ khi trả về dạng id.`)
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
