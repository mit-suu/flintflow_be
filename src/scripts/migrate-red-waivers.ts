/**
 * FLF-329 — cờ đỏ không waive được (BR-04). Waiver cũ trên cờ đỏ chuyển thành "giữ nguyên + lý do":
 * giữ nguyên lý do đã gõ vào `kept_reason`, bỏ `waived_by_user` / `waive_reason` / `waived_at_version`. Cờ vẫn mở
 * (nó vốn đã chặn baseline từ FLF-275), chỉ đổi cách hiển thị: FE không còn liệt kê nó ở tab "Đã bỏ qua".
 *
 * Cách dùng:
 *   npm run migrate:red-waivers -- --dry-run   # chỉ đếm, không ghi (mặc định khi không có cờ --apply)
 *   npm run migrate:red-waivers -- --apply
 *
 * Ghi qua op engine (`applyTransaction`) chứ không `updateOne` thẳng — coding-rules §3.3; mỗi project một lô, `by` là
 * tài khoản hệ thống. Chạy lại an toàn: Spine không còn cờ đỏ `waived_by_user` thì không có op nào.
 */

import mongoose from "mongoose"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"
import { Spine as SpineModel } from "../modules/spine/spine.model.js"
import { applyTransaction } from "../modules/spine/op-engine.js"
import type { Op } from "../modules/spine/op.types.js"
import type { Flag } from "../modules/spine/spine.types.js"

export const MIGRATION_ACTOR = "system:migrate-red-waivers"

/** Hàm thuần: cờ đỏ đang mở mà còn `waived_by_user` ⇒ op chuyển sang giữ nguyên + lý do. */
export const planRedWaiverOps = (flags: readonly Flag[], at: string = new Date().toISOString()): Op[] =>
  flags
    .filter((f) => f.level === "red" && f.resolved_at === null && f.waived_by_user)
    .flatMap((f): Op[] => {
      const path = (field: string) => `flags[id=${f.id}].${field}`
      const reason = "FLF-329: cờ đỏ không waive được — chuyển waiver cũ thành giữ nguyên + lý do"
      return [
        { op: "set", path: path("kept_reason"), value: f.kept_reason ?? f.waive_reason, reason },
        { op: "set", path: path("kept_by"), value: f.kept_by ?? MIGRATION_ACTOR, reason },
        { op: "set", path: path("kept_at"), value: f.kept_at ?? at, reason },
        { op: "set", path: path("waived_by_user"), value: false, reason },
        { op: "set", path: path("waive_reason"), value: null, reason },
        { op: "set", path: path("waived_at_version"), value: null, reason }
      ]
    })

const main = async (): Promise<void> => {
  const apply = process.argv.includes("--apply")
  await mongoose.connect(env.MONGO_URI)
  console.log(`🟢 Connected to MongoDB${apply ? "" : " (dry-run: không ghi, thêm --apply để ghi)"}`)
  try {
    const cursor = SpineModel.find({ flags: { $elemMatch: { level: "red", resolved_at: null, waived_by_user: true } } }, { projectId: 1, spine_version: 1, flags: 1 }).lean()
    let projects = 0
    let flagsMoved = 0
    for await (const doc of cursor) {
      const ops = planRedWaiverOps(doc.flags as Flag[])
      if (ops.length === 0) continue
      projects += 1
      flagsMoved += ops.length / 6
      if (apply) {
        await applyTransaction(String(doc.projectId), { base_version: doc.spine_version, ops, by: MIGRATION_ACTOR, reason: "FLF-329 migrate red waivers", step_id: null })
      }
    }
    console.log(`${apply ? "Đã chuyển" : "Sẽ chuyển"} ${flagsMoved} cờ đỏ đã waive ở ${projects} dự án sang giữ nguyên + lý do`)
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
