/**
 * Hoàn tác một lần đổi mẫu đã `applied` (D14): chỉ khi **chưa có Change nào ghi sau nó** ngoài của chính lần đổi mẫu (cờ / tiến độ tính lại không
 * tính; waiver của BA thì tính). Đã có CR sau ⇒ 409 `TEMPLATE_MIGRATION_REVERT_BLOCKED` — dùng đổi mẫu ngược.
 *
 * `applied → reverting → reverted`: chiếm `reverting` trước (chặn CR / release chen vào — `migration-guard`), rồi chạy `runUndo`: đảo Change Spine
 * của lần đổi mẫu (một lô `…:undo`, có khoá lạc quan theo version lúc kiểm, nhận ra qua `txn`) → khôi phục profile + file nền + `template_ref` +
 * `template_intent` + `documentLanguage` từ snapshot → xoá file nền mới. Mỗi bước idempotent: chết giữa chừng ⇒ job phục hồi chạy tiếp `reverting`.
 * `restoreFromSnapshot` là cùng việc cho lần áp dụng kẹt (`apply_failed`), kết thúc ở `failed`.
 */
import { randomUUID } from "node:crypto"
import { ensureTemplateMigrationCr, revertTemplateMigrationChanges } from "../change-request/write.service.js"
import { TemplateProfile } from "../import/template-profile.model.js"
import { Project } from "../project/project.model.js"
import { TransactionRejectedError } from "../spine/op-engine.js"
import * as spineRepository from "../spine/spine.repository.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { isDerivedChange, isMigrationTxn, migrationTxn } from "./apply-plan.js"
import { cleanupArtifacts, recomputeFlags } from "./apply.service.js"
import { changesAfter, hasNewerApplied } from "./precheck.js"
import { assertNoMigrationRunning } from "./migration-guard.js"
import { TemplateMigration, stateUpdate, type ITemplateMigration } from "./template-migration.model.js"
import { invalidState, load, toDto, type MigrationContext, type MigrationDto } from "./template-migration.service.js"

export const REVERT_BLOCKED = "TEMPLATE_MIGRATION_REVERT_BLOCKED"

interface UndoOptions {
  /** `reverted` (hoàn tác bình thường) hoặc `failed` (khôi phục từ snapshot sau khi áp dụng kẹt). */
  finalState: "reverted" | "failed"
  /** Hoàn tác thường chặn khi đã có Change sau; khôi phục từ snapshot (áp dụng kẹt) thì không — nó đảo đúng phần của chính lần đổi mẫu. */
  checkLater?: boolean
}

/**
 * Chạy (hoặc chạy tiếp) phần việc của hoàn tác trên migration đang giữ trạng thái `reverting` / `apply_failed`. Idempotent.
 * Ném `ApiError 409 REVERT_BLOCKED` khi có Change sau hoặc op engine không đảo được; chưa ghi gì thì người gọi trả trạng thái cũ.
 */
export const runUndo = async (doc: ITemplateMigration, userId: string, options: UndoOptions): Promise<ITemplateMigration> => {
  const projectId = String(doc.projectId)
  const id = String(doc._id)
  const undoTxn = migrationTxn(id, "undo")
  const all = await spineRepository.listChanges(projectId)
  const mine = all.filter((c) => isMigrationTxn(c.txn, id))
  const alreadyUndone = mine.some((c) => c.txn === undoTxn)

  if (!alreadyUndone) {
    const forward = mine.filter((c) => c.txn !== undoTxn)
    // Mốc "sau lần đổi mẫu": seq lớn nhất của Change do nó ghi; không ghi gì thì theo thời điểm áp dụng
    const lastSeq = forward.reduce((m, c) => Math.max(m, c.seq), 0)
    if (options.checkLater !== false && doc.applied_at) {
      const later = changesAfter(doc, all)
      if (later.length) {
        throw new ApiError(409, "Tài liệu đã có thay đổi sau lần đổi mẫu này nên không hoàn tác được. Hãy đổi mẫu ngược để giữ các thay đổi đó.", REVERT_BLOCKED, { changes_after: later.length, use: "reverse_migration" })
      }
    }
    if (forward.length) {
      // Cờ / tiến độ tính lại sau đó có thể trỏ vào mục riêng do đổi mẫu thêm ⇒ đảo cùng (rồi tính lại)
      const firstSeq = forward.reduce((m, c) => Math.min(m, c.seq), Infinity)
      const set = [...forward, ...all.filter((c) => c.seq >= firstSeq && !isMigrationTxn(c.txn, id) && isDerivedChange(c))]
      const crId = doc.spine_cr_id ?? (await ensureTemplateMigrationCr(projectId, id, userId, "Hoàn tác đổi mẫu"))
      const head = await spineRepository.versionHead(projectId)
      try {
        // Khoá lạc quan theo version vừa kiểm: ai ghi chen vào giữa ⇒ 409, chưa đảo gì
        await revertTemplateMigrationChanges(projectId, set, { crId, txn: undoTxn, ...(head ? { baseVersion: head.spine_version } : {}) })
      } catch (err) {
        if (err instanceof TransactionRejectedError) {
          throw new ApiError(409, "Không đảo được các thay đổi của lần đổi mẫu này.", REVERT_BLOCKED, { violations: err.violations.map((v) => ({ rule: v.rule, path: v.path ?? null, message: v.message })) })
        }
        throw err
      }
    }
  }

  await restoreFromSnapshot(doc)
  const failures = await cleanupArtifacts(doc)
  const done = await TemplateMigration.findOneAndUpdate(
    { _id: doc._id, state: { $in: ["reverting", "apply_failed"] } },
    { $set: stateUpdate(options.finalState, { reverted_at: new Date(), apply_token: null, applying_heartbeat: null }), ...(failures.length ? { $push: { warnings: { $each: failures } } } : {}) },
    { returnDocument: "after" }
  )
  await recomputeFlags(projectId, doc.spine_cr_id ?? "template-migration")
  return done ?? (await TemplateMigration.findById(doc._id))!
}

/** Khôi phục profile + project từ snapshot. Snapshot không chứa bản sao Spine: flow2 giữ từ profile hiện tại, mốc nguyên vẹn lấy từ migration trước. */
const restoreFromSnapshot = async (doc: ITemplateMigration): Promise<void> => {
  const projectId = String(doc.projectId)
  const snap = doc.snapshot
  if (!snap) throw new ApiError(409, "Lần đổi mẫu này không có ảnh chụp để khôi phục.", "TEMPLATE_MIGRATION_NO_SNAPSHOT")
  if (snap.profile) {
    const current = (await TemplateProfile.findOne({ projectId }, { flow2_entry_spine: 1 }).lean()) as { flow2_entry_spine?: unknown } | null
    await TemplateProfile.replaceOne({ projectId }, { ...snap.profile, flow2_entry_spine: current?.flow2_entry_spine ?? null, migrated_base_spine: null, migrated_base_migration_id: snap.prior_anchor_migration_id ?? null }, { upsert: true })
  } else await TemplateProfile.deleteOne({ projectId })
  await Project.updateOne(
    { _id: projectId },
    {
      $set: { template_ref: snap.template_ref, template_intent: snap.template_intent, ...(snap.document_language ? { documentLanguage: snap.document_language } : {}) },
      ...(snap.document_language ? {} : { $unset: { documentLanguage: 1 } })
    }
  )
}

const claimUndo = async (ctx: MigrationContext, id: string, from: "applied" | "apply_failed"): Promise<ITemplateMigration> => {
  const doc = await TemplateMigration.findOneAndUpdate(
    { _id: id, projectId: ctx.projectId, orgId: ctx.orgId, state: from },
    { $set: stateUpdate(from === "applied" ? "reverting" : "apply_failed", { apply_token: randomUUID(), applying_heartbeat: new Date() }) },
    { returnDocument: "after" }
  )
  if (doc) return doc
  throw invalidState((await load(ctx, id)).state, [from])
}

export const revertMigration = async (ctx: MigrationContext, id: string): Promise<MigrationDto> => {
  const loaded = await load(ctx, id)
  if (loaded.state !== "applied") throw invalidState(loaded.state, ["applied"])
  if (!loaded.snapshot || !loaded.applied_at) throw new ApiError(409, "Lần đổi mẫu này không có ảnh chụp để hoàn tác.", "TEMPLATE_MIGRATION_NO_SNAPSHOT")
  if (await hasNewerApplied(loaded)) {
    throw new ApiError(409, "Đã có lần đổi mẫu khác sau lần này nên chỉ hoàn tác được lần đổi mẫu mới nhất.", REVERT_BLOCKED, { reason: "not_latest" })
  }
  // `reverting` là trạng thái mở: chỉ một lần đổi mẫu mở mỗi dự án
  const open = await TemplateMigration.findOne({ projectId: ctx.projectId, open: true }, { _id: 1, state: 1 }).lean()
  if (open) throw new ApiError(409, "Dự án đang có một lần đổi mẫu chưa xong. Hoàn tất hoặc huỷ lần đó trước khi hoàn tác.", "TEMPLATE_MIGRATION_OPEN", { migration_id: String(open._id), state: open.state })
  await assertNoMigrationRunning(ctx.projectId)
  const doc = await claimUndo(ctx, id, "applied")
  // Kiểm lại sau khi chiếm: một lần đổi mẫu khác áp dụng xong giữa lúc kiểm và lúc chiếm
  if (await hasNewerApplied(doc)) {
    await TemplateMigration.updateOne({ _id: doc._id, state: "reverting" }, { $set: stateUpdate("applied", { apply_token: null, applying_heartbeat: null }) })
    throw new ApiError(409, "Đã có lần đổi mẫu khác sau lần này nên chỉ hoàn tác được lần đổi mẫu mới nhất.", REVERT_BLOCKED, { reason: "not_latest" })
  }
  try {
    return await toDto(await runUndo(doc, ctx.actor.userId, { finalState: "reverted" }))
  } catch (err) {
    // Chưa đảo Spine (bị chặn / chen ngang) ⇒ về `applied` như cũ; đã đảo thì giữ `reverting` cho phục hồi chạy tiếp
    const undone = await spineRepository.listChanges(ctx.projectId).then((cs) => cs.some((c) => c.txn === migrationTxn(id, "undo")))
    if (!undone) await TemplateMigration.updateOne({ _id: doc._id, state: "reverting" }, { $set: stateUpdate("applied", { apply_token: null, applying_heartbeat: null }) })
    throw err
  }
}

/** Lần áp dụng kẹt (`apply_failed`): đảo Change của nó + khôi phục snapshot → `failed` (đóng, giải phóng chỗ của dự án). */
export const restoreMigration = async (ctx: MigrationContext, id: string): Promise<MigrationDto> => {
  await load(ctx, id)
  const doc = await claimUndo(ctx, id, "apply_failed")
  return toDto(await runUndo(doc, ctx.actor.userId, { finalState: "failed", checkLater: false }))
}
