/**
 * FLF-466 phase 08 — đưa dự án dev / demo đang dở về trạng thái hợp lệ sau khi đổi thứ tự S-1 trước B-2 (BF §1.1):
 * `B-1 → S-1.1…S-1.4 → B-2.1 → B-2.2 → B-2.3 (Approve Brief) → S-2`.
 *
 * KHÔNG giữ hai thứ tự song song: thứ tự mới nằm ở `PHASES` + `assets/step-registry.json`; script chỉ sửa TRẠNG THÁI step:
 *
 * | Trạng thái dự án cũ                                              | Hành vi                                             |
 * | ---------------------------------------------------------------- | --------------------------------------------------- |
 * | Chưa B-2.x nào accepted, S-1 chưa xong (đang ở B-1 / B-2.1 chưa)  | Không đổi step; chỉ đặt lại con trỏ về S-1.x         |
 * | Có B-2.x đã accepted (vd B-2.1 xong, B-2.2 chưa), S-1 chưa xong  | Mở lại MỌI B-2.x đã accepted về `pending`: S-1 chạy trước, B-2 rà lại sau (giả định S-1.3 sinh ra phải qua B-2.1; Approve Brief phải đến SAU S-1) |
 * | S-1 xong (accepted / skipped hết)                                 | Không đổi (đã hợp lệ theo thứ tự mới)                |
 * | S-1 chưa xong mà đã có step từ S-2 trở đi accepted                 | Không tự sửa — in cảnh báo để xử lý tay             |
 *
 * Cách dùng (BACKUP trước: `--apply` luôn ghi bản sao Spine bị đổi ra `--backup-dir`, mặc định `tmp/migrate-s1-order-<thời điểm>`;
 * vẫn nên mongodump DB trước khi chạy thật):
 *   npm run migrate:s1-order -- --dry-run     # chỉ liệt kê (mặc định khi không có --apply)
 *   npm run migrate:s1-order -- --apply [--backup-dir=<thư mục>]
 * Chạy lại an toàn: dự án đã hợp lệ không sinh op.
 */

import fs from "node:fs"
import path from "node:path"
import mongoose from "mongoose"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"
import { applyTransaction } from "../modules/spine/op-engine.js"
import * as spineRepository from "../modules/spine/spine.repository.js"
import { Spine as SpineModel } from "../modules/spine/spine.model.js"
import type { Op } from "../modules/spine/op.types.js"
import type { Spine } from "../modules/spine/spine.types.js"
import { isRegisteredStep, nextStep } from "../modules/pipeline/step-registry.js"

export const MIGRATION_ACTOR = "system:migrate-s1-order"

const S1_STEPS = ["S-1.1", "S-1.2", "S-1.3", "S-1.4"] as const
const B2_STEPS = ["B-2.1", "B-2.2", "B-2.3"] as const
const DONE = new Set(["accepted", "skipped"])
/** Phase từ S-2 trở đi (đã qua Approve Brief). */
const LATER_PHASE = /^S-([2-9])\./

export type S1OrderAction = "none" | "reset_b2" | "fix_pointer" | "manual"

export interface S1OrderPlan {
  action: S1OrderAction
  /** Step B-2 được mở lại về `pending`. */
  reopened: string[]
  ops: Op[]
  reason: string
}

const statusOf = (spine: Pick<Spine, "steps">, id: string): string => spine.steps.find((s) => s.id === id)?.status ?? "pending"

/** Hàm thuần: kế hoạch đưa một Spine về trạng thái hợp lệ của thứ tự S-1 trước B-2. */
export const planS1OrderMigration = (spine: Spine): S1OrderPlan => {
  const s1Done = S1_STEPS.every((id) => !isRegisteredStep(id) || DONE.has(statusOf(spine, id)))
  if (s1Done) return { action: "none", reopened: [], ops: [], reason: "S-1 đã xong - hợp lệ theo thứ tự mới" }

  const laterAccepted = spine.steps.some((s) => LATER_PHASE.test(s.id) && s.status === "accepted")
  if (laterAccepted) return { action: "manual", reopened: [], ops: [], reason: "S-1 chưa xong nhưng đã có step từ S-2 accepted - xử lý tay" }

  const reopened = B2_STEPS.filter((id) => statusOf(spine, id) === "accepted")
  const ops: Op[] = reopened.flatMap((id): Op[] => [
    { op: "set", path: `steps[id=${id}].status`, value: "pending" },
    { op: "set", path: `steps[id=${id}].first_seq`, value: null },
    { op: "set", path: `steps[id=${id}].last_seq`, value: null },
    { op: "set", path: `steps[id=${id}].accepted_at`, value: null }
  ])

  // Con trỏ theo bước tới lượt (thứ tự mới) trên Spine sau khi mở lại
  const projected: Spine = { ...spine, steps: spine.steps.map((s) => (reopened.includes(s.id as (typeof B2_STEPS)[number]) ? { ...s, status: "pending" as const } : s)) }
  const next = nextStep(projected)
  const phase = next?.phase ?? null
  const step = next?.id ?? null
  if (spine.progress.current_phase !== phase) ops.push({ op: "set", path: "progress.current_phase", value: phase })
  if (spine.progress.current_step !== step) ops.push({ op: "set", path: "progress.current_step", value: step })

  if (reopened.length > 0) return { action: "reset_b2", reopened, ops, reason: `Mở lại ${reopened.join(", ")} (đã accepted trước khi S-1 chạy)` }
  if (ops.length > 0) return { action: "fix_pointer", reopened: [], ops, reason: `Đặt con trỏ về ${step ?? "-"} (S-1 chạy trước B-2)` }
  return { action: "none", reopened: [], ops: [], reason: "Con trỏ đã đúng" }
}

const backupDirFrom = (argv: string[]): string => {
  const given = argv.find((a) => a.startsWith("--backup-dir="))?.slice("--backup-dir=".length)
  return given ?? path.join("tmp", `migrate-s1-order-${new Date().toISOString().replace(/[:.]/g, "-")}`)
}

const main = async (): Promise<void> => {
  const apply = process.argv.includes("--apply")
  const backupDir = backupDirFrom(process.argv)
  await mongoose.connect(env.MONGO_URI)
  console.log(`Connected to MongoDB${apply ? "" : " (dry-run: không ghi, thêm --apply để ghi)"}`)
  try {
    const counts: Record<S1OrderAction, number> = { none: 0, reset_b2: 0, fix_pointer: 0, manual: 0 }
    const ids = (await SpineModel.find({}, { projectId: 1 }).lean()).map((d) => String(d.projectId))
    for (const projectId of ids) {
      const record = await spineRepository.get(projectId)
      if (!record) continue
      const { projectId: _id, ...spine } = record
      const plan = planS1OrderMigration(spine)
      counts[plan.action] += 1
      if (plan.action === "none") continue
      console.log(`${projectId}: ${plan.action} - ${plan.reason}`)
      if (!apply || plan.action === "manual") continue
      fs.mkdirSync(backupDir, { recursive: true })
      fs.writeFileSync(path.join(backupDir, `${projectId}.json`), JSON.stringify(record, null, 2))
      await applyTransaction(projectId, { base_version: record.spine_version, ops: plan.ops, by: MIGRATION_ACTOR, step_id: null, reason: "FLF-466 P08: S-1 trước B-2" })
    }
    console.log(`${apply ? "Đã xử lý" : "Sẽ xử lý"}: ${JSON.stringify(counts)}${apply ? ` (backup: ${backupDir})` : ""}`)
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
