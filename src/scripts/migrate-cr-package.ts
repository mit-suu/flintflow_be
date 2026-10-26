/**
 * FLF-330 — CR kiểu GitHub: Lead không duyệt từng CR nữa. CR đang `in_review` (chờ duyệt từng group theo luồng cũ)
 * quay về `ready_to_submit` để BA **xác nhận** lại (xác nhận = ghi ngay vào bản nháp); group chưa quyết về `pending`.
 * Group đã bị từ chối một phần: vị trí của group đó đặt `not_related` để không bị ghi khi BA xác nhận (Lead đã nói không).
 *
 * Cách dùng:
 *   npm run migrate:cr-package -- --dry-run   # mặc định: chỉ đếm
 *   npm run migrate:cr-package -- --apply
 *
 * Chạy lại an toàn: chỉ khớp CR còn `in_review`. Không đụng Spine, không đụng khoá phần tử (CR vẫn giữ khoá như khi chờ).
 */

import mongoose from "mongoose"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"
import { ChangeRequest } from "../modules/change-request/change-request.model.js"
import { ChangeGroup, type IChangeGroup } from "../modules/change-request/change-group.model.js"
import { ChangeLocation } from "../modules/change-request/change-location.model.js"

export interface CrPackagePlan {
  cr_id: string
  /** Vị trí thuộc group Lead đã từ chối ⇒ `not_related`, không ghi khi BA xác nhận. */
  unrelated_location_ids: string[]
  /** Group về `pending` (đã duyệt / còn chờ) — BA xác nhận lại là ghi cả. */
  reset_group_ids: string[]
}

/** Hàm thuần: kế hoạch cho một CR `in_review` từ các group của nó. */
export const planCrPackage = (crId: string, groups: readonly Pick<IChangeGroup, "group_id" | "decision" | "location_ids">[]): CrPackagePlan => ({
  cr_id: crId,
  unrelated_location_ids: groups.filter((g) => g.decision === "rejected").flatMap((g) => g.location_ids),
  reset_group_ids: groups.filter((g) => g.decision !== "rejected").map((g) => g.group_id)
})

const main = async (): Promise<void> => {
  const apply = process.argv.includes("--apply")
  await mongoose.connect(env.MONGO_URI)
  console.log(`🟢 Connected to MongoDB${apply ? "" : " (dry-run: không ghi, thêm --apply để ghi)"}`)
  try {
    const crs = await ChangeRequest.find({ status: "in_review" }).select("projectId cr_id").lean()
    let moved = 0
    for (const cr of crs) {
      const groups = await ChangeGroup.find({ projectId: cr.projectId, cr_id: cr.cr_id }).lean()
      const plan = planCrPackage(cr.cr_id, groups)
      moved += 1
      if (!apply) continue
      if (plan.unrelated_location_ids.length) {
        await ChangeLocation.updateMany(
          { projectId: cr.projectId, cr_id: cr.cr_id, location_id: { $in: plan.unrelated_location_ids } },
          { $set: { conclusion: "not_related", reason: "Lead đã từ chối nhóm này trước FLF-330", group_id: null } }
        )
        await ChangeGroup.deleteMany({ projectId: cr.projectId, cr_id: cr.cr_id, decision: "rejected" })
      }
      await ChangeGroup.updateMany({ projectId: cr.projectId, cr_id: cr.cr_id, group_id: { $in: plan.reset_group_ids } }, { $set: { decision: "pending", reason: null, decided_by: null, decided_at: null } })
      await ChangeRequest.updateOne({ _id: cr._id }, { $set: { status: "ready_to_submit", submitted_at: null } })
    }
    console.log(`${apply ? "Đã chuyển" : "Sẽ chuyển"} ${moved} CR in_review về ready_to_submit (BA xác nhận lại là ghi vào bản nháp)`)
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
