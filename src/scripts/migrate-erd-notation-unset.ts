/**
 * FLF-418 — `Project.erdNotation` bỏ default `chen`: thiếu field = người dùng chưa chọn, S-4.5 hỏi trong khung chat.
 * Dự án tạo trước FLF-418 đều lưu sẵn `"chen"` (default cũ) nên sẽ không bao giờ được hỏi. Script này gỡ field ở dự án
 * **chưa vẽ ERD** và **chưa trả lời câu hỏi ký pháp** (`decisions[topic_key=erd_notation]`), để S-4.5 hỏi như dự án mới.
 * Chỉ gỡ giá trị `chen`: `crowsfoot` / `idef1x` chỉ có được do người dùng chọn hoặc import đọc từ file ⇒ giữ.
 *
 * Cách dùng:
 *   npm run migrate:erd-notation-unset -- --dry-run   # chỉ đếm (mặc định khi không có --apply)
 *   npm run migrate:erd-notation-unset -- --apply
 *
 * Ghi field của Project (ngoài Spine) nên dùng `updateOne`, không qua op engine. Chạy lại an toàn.
 */

import mongoose from "mongoose"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"
import { Project } from "../modules/project/project.model.js"
import { Spine as SpineModel } from "../modules/spine/spine.model.js"

export const ERD_NOTATION_TOPIC = "erd_notation"

/** Hàm thuần: dự án lưu `chen` mà Spine chưa có ERD và chưa có quyết định ký pháp ⇒ gỡ để được hỏi. */
export const shouldUnsetErdNotation = (
  project: { erdNotation?: unknown },
  spine: { diagrams?: readonly { kind: string }[]; decisions?: readonly { topic_key: string }[] } | null
): boolean =>
  project.erdNotation === "chen" &&
  !(spine?.diagrams ?? []).some((d) => d.kind === "erd") &&
  !(spine?.decisions ?? []).some((d) => d.topic_key === ERD_NOTATION_TOPIC)

const main = async (): Promise<void> => {
  const apply = process.argv.includes("--apply")
  await mongoose.connect(env.MONGO_URI)
  console.log(`🟢 Connected to MongoDB${apply ? "" : " (dry-run: không ghi, thêm --apply để ghi)"}`)
  try {
    const cursor = Project.find({ erdNotation: "chen" }, { _id: 1, erdNotation: 1 }).lean().cursor()
    let unset = 0
    let kept = 0
    for await (const project of cursor) {
      const spine = await SpineModel.findOne({ projectId: project._id }, { "diagrams.kind": 1, "decisions.topic_key": 1 }).lean()
      if (!shouldUnsetErdNotation(project, spine as Parameters<typeof shouldUnsetErdNotation>[1])) {
        kept += 1
        continue
      }
      unset += 1
      if (apply) await Project.updateOne({ _id: project._id }, { $unset: { erdNotation: 1 } })
    }
    console.log(`${apply ? "Đã gỡ" : "Sẽ gỡ"} erdNotation ở ${unset} dự án (S-4.5 sẽ hỏi); giữ nguyên ${kept} dự án đã có ERD hoặc đã chọn`)
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
