/**
 * Phục hồi lần đổi mẫu kẹt ở `applying` / `reverting` (tiến trình chết / lỗi giữa chừng). Idempotent — chạy lại bao nhiêu lần cũng ra cùng kết quả:
 *
 *  - `applying`, đã có Change của lần đổi mẫu trong Spine (hoặc cờ bước Spine) ⇒ Spine đã đổi, đường lùi không còn: chạy tiếp từ bước dở —
 *    ghi nốt các lô Spine chưa có (nhận ra qua `txn`, có khoá lạc quan), ghi profile + project, `applied`.
 *  - `applying`, chưa có Change nào ⇒ bản nháp còn nguyên: bỏ file nền mới + bản riêng vừa đăng ký, trả về `ready`.
 *  - `reverting` ⇒ chạy tiếp hoàn tác (`runUndo`, idempotent theo txn `:undo`).
 * Mỗi lần phục hồi lấy token mới của migration (lượt chậm đang chạy bị thay thế, không ghi chồng) và tăng `apply_attempts`; chạy tiếp quá
 * `MAX_RECOVERY_ATTEMPTS` lần vẫn không xong ⇒ `apply_failed` (giữ snapshot, báo người tạo) chờ "khôi phục từ snapshot" — không kẹt vĩnh viễn.
 */
import { randomUUID } from "node:crypto"
import { notify } from "../notification/notification.service.js"
import { TemplateMigration, stateUpdate, type ITemplateMigration } from "./template-migration.model.js"
import { finalizeApplied, hasSpineWrites, rollbackToReady, writeProfileAndProject, writeSpine } from "./apply.service.js"
import { runUndo } from "./revert.service.js"

export type RecoverOutcome = "applied" | "ready" | "reverted" | "failed" | "pending" | "skipped"

/** Lần áp dụng im lặng quá lâu mới bị coi là kẹt (job định kỳ không giẫm lên lần đang chạy thật). */
export const STUCK_AFTER_MS = 10 * 60_000
export const MAX_RECOVERY_ATTEMPTS = 5

const takeOver = (id: string, state: "applying" | "reverting"): Promise<ITemplateMigration | null> =>
  TemplateMigration.findOneAndUpdate({ _id: id, state }, { $set: { apply_token: randomUUID(), applying_heartbeat: new Date() }, $inc: { apply_attempts: 1 } }, { returnDocument: "after" })

const markApplyFailed = async (doc: ITemplateMigration, reason: string): Promise<void> => {
  await TemplateMigration.updateOne({ _id: doc._id, state: "applying" }, { $set: stateUpdate("apply_failed", { apply_token: null, applying_heartbeat: null }), $push: { warnings: reason } })
  await notify(String(doc.created_by), {
    type: "template_migration_failed",
    title: "Đổi mẫu bị kẹt",
    body: "Lần đổi mẫu không hoàn tất được sau nhiều lần thử. Mở lần đổi mẫu và chọn khôi phục từ snapshot.",
    organizationId: String(doc.orgId),
    link: `/projects/${String(doc.projectId)}`,
    meta: { migration_id: String(doc._id), project_id: String(doc.projectId) }
  }).catch((e: unknown) => console.error("[TemplateMigration] không gửi được thông báo kẹt:", e instanceof Error ? e.message : e))
}

export const recoverApplyingMigration = async (id: string, options: { force?: boolean; now?: Date } = {}): Promise<RecoverOutcome> => {
  const current = await TemplateMigration.findById(id)
  if (!current || (current.state !== "applying" && current.state !== "reverting")) return "skipped"
  const now = options.now ?? new Date()
  if (!options.force && current.applying_heartbeat && now.getTime() - current.applying_heartbeat.getTime() < STUCK_AFTER_MS) return "skipped"

  const doc = await takeOver(id, current.state)
  if (!doc) return "skipped"

  if (doc.state === "reverting") {
    if (doc.apply_attempts > MAX_RECOVERY_ATTEMPTS) {
      await TemplateMigration.updateOne({ _id: doc._id, state: "reverting" }, { $set: stateUpdate("apply_failed", { apply_token: null }), $push: { warnings: "Hoàn tác không xong sau nhiều lần thử" } })
      return "failed"
    }
    await runUndo(doc, String(doc.created_by), { finalState: "reverted" })
    return "reverted"
  }

  if (!(await hasSpineWrites(doc))) {
    await rollbackToReady(doc)
    return "ready"
  }
  if (doc.apply_attempts > MAX_RECOVERY_ATTEMPTS) {
    await markApplyFailed(doc, `Chạy tiếp lần đổi mẫu thất bại ${doc.apply_attempts - 1} lần`)
    return "failed"
  }
  try {
    await writeSpine(doc, String(doc.created_by))
    await TemplateMigration.updateOne({ _id: doc._id, apply_token: doc.apply_token }, { $set: { "apply_steps.spine": true, spine_written_at: doc.spine_written_at ?? new Date() } })
    const fresh = (await TemplateMigration.findById(id))!
    await writeProfileAndProject(fresh)
    const done = await finalizeApplied(fresh, new Date())
    return done.state === "applied" ? "applied" : "pending"
  } catch (error) {
    // Spine đã bị ghi chen (409 khoá lạc quan) hoặc lỗi lặp lại: lượt sau thử tiếp, quá giới hạn ⇒ apply_failed
    console.error(`[TemplateMigration] chạy tiếp lần đổi mẫu ${id} lỗi (lần ${doc.apply_attempts}):`, error instanceof Error ? error.message : error)
    throw error
  }
}

export const recoverStuckMigrations = async (options: { now?: Date } = {}): Promise<{ applied: number; ready: number; failed: number }> => {
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS)
  const stuck = await TemplateMigration.find({ state: { $in: ["applying", "reverting"] }, $or: [{ applying_heartbeat: null }, { applying_heartbeat: { $lt: cutoff } }] }, { _id: 1 }).lean()
  const out = { applied: 0, ready: 0, failed: 0 }
  for (const { _id } of stuck) {
    try {
      const outcome = await recoverApplyingMigration(String(_id), { now })
      if (outcome === "applied" || outcome === "reverted") out.applied++
      else if (outcome === "ready") out.ready++
      else if (outcome === "failed") out.failed++
    } catch (error) {
      out.failed++
      console.error(`[TemplateMigration] phục hồi lần đổi mẫu ${String(_id)} lỗi, thử lại ở lượt sau:`, error instanceof Error ? error.message : error)
    }
  }
  return out
}
