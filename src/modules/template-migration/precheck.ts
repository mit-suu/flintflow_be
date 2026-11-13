/**
 * Các phép kiểm chỉ đọc cho FE trước khi bấm Áp dụng / Hoàn tác (không ghi gì, không AI):
 *  - `brokenLinks`: đổi ngược mà bỏ các sửa của mục `discard` làm gãy liên kết — chạy khô đúng `planRevert` của bước áp dụng (cùng bất biến / C-5);
 *  - `changesAfter` / `revertability`: lần đổi mẫu đã áp dụng có hoàn tác được không — cùng luật với `revert.service`.
 * Bước áp dụng / hoàn tác vẫn kiểm lại lúc ghi (409); đây chỉ là báo trước.
 */
import { TransactionRejectedError, planRevert } from "../spine/op-engine.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Change, Spine } from "../spine/spine.types.js"
import { isDerivedChange, isMigrationTxn, selectReverseChanges } from "./apply-plan.js"
import { TemplateMigration, type ITemplateMigration } from "./template-migration.model.js"

export interface BrokenLink {
  rule: string
  path: string | null
  message: string
}

const plain = (record: Spine): Spine => {
  const { projectId: _p, ...spine } = record as Spine & { projectId?: string }
  return spine
}

/** Liên kết gãy nếu áp dụng lần đổi ngược này (rỗng = ổn / không phải đổi ngược / chưa đủ dữ liệu để kiểm). */
export const brokenLinks = async (doc: ITemplateMigration): Promise<BrokenLink[]> => {
  if (doc.direction !== "reverse" || !doc.reverse_of) return []
  if (doc.state !== "decisions" && doc.state !== "ready" && doc.state !== "mapping_review") return []
  const prior = await TemplateMigration.findById(doc.reverse_of, { applied_at: 1 }).lean()
  if (!prior?.applied_at) return []
  const projectId = String(doc.projectId)
  const [record, changes] = await Promise.all([spineRepository.get(projectId), spineRepository.listChanges(projectId)])
  if (!record) return []
  const spine = plain(record as Spine)
  const decisions = doc.decisions.map((d) => ({ id: d.id, choice: d.choice }))
  const { changes: revert } = selectReverseChanges({
    doc: { groups: doc.groups, decisions },
    priorId: String(doc.reverse_of),
    priorAppliedAt: prior.applied_at,
    oldHeadings: doc.from.headings,
    followers: doc.pairing.followers,
    spine,
    changes
  })
  if (!revert.length) return []
  try {
    planRevert(spine, revert, { by: "template-migration", startSeq: 1 })
    return []
  } catch (err) {
    if (err instanceof TransactionRejectedError) return err.violations.map((v) => ({ rule: v.rule, path: v.path ?? null, message: v.message }))
    throw err
  }
}

/** Change ghi sau lần đổi mẫu mà không phải của nó (cờ / tiến độ tính lại không tính; waiver của BA thì tính). */
export const changesAfter = (doc: Pick<ITemplateMigration, "_id" | "applied_at">, all: readonly Change[]): Change[] => {
  const id = String(doc._id)
  const lastSeq = all.filter((c) => isMigrationTxn(c.txn, id)).reduce((m, c) => Math.max(m, c.seq), 0)
  return all.filter((c) => !isMigrationTxn(c.txn, id) && !isDerivedChange(c) && (lastSeq ? c.seq > lastSeq : !!doc.applied_at && Date.parse(c.at) > doc.applied_at.getTime()))
}

/** Có lần đổi mẫu khác đã áp dụng sau lần này (hoàn tác lần cũ sẽ khôi phục snapshot cũ đè lên dữ liệu của lần mới). */
export const hasNewerApplied = async (doc: Pick<ITemplateMigration, "projectId" | "applied_at">): Promise<boolean> =>
  !!doc.applied_at && !!(await TemplateMigration.exists({ projectId: doc.projectId, state: "applied", applied_at: { $gt: doc.applied_at } }))

export type RevertBlockReason = "not_latest" | "migration_open" | "running" | "has_later_changes"

export interface Revertability {
  revertable: boolean
  reason: RevertBlockReason | null
}

/** Hoàn tác được không (theo đúng luật của `revertMigration`): lần đổi mẫu mới nhất đã áp dụng, không có lần đổi mẫu khác đang mở, chưa có Change sau. */
export const revertability = async (doc: ITemplateMigration): Promise<Revertability> => {
  const no = (reason: RevertBlockReason): Revertability => ({ revertable: false, reason })
  if (doc.state !== "applied" || !doc.applied_at) return no("not_latest")
  const [newer, open] = await Promise.all([
    TemplateMigration.exists({ projectId: doc.projectId, state: "applied", applied_at: { $gt: doc.applied_at } }),
    TemplateMigration.findOne({ projectId: doc.projectId, open: true }, { state: 1 }).lean()
  ])
  if (newer) return no("not_latest")
  if (open) return no(open.state === "applying" || open.state === "reverting" ? "running" : "migration_open")
  const all = await spineRepository.listChanges(String(doc.projectId))
  return changesAfter(doc, all).length ? no("has_later_changes") : { revertable: true, reason: null }
}
