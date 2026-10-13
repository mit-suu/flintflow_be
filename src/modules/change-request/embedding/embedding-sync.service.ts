/**
 * Giữ index embedding (`spine_embeddings`) khớp Spine hiện tại của project: chỉ embed phần tử đổi `text_hash`, xoá dòng
 * của phần tử đã bị xoá, nâng `spine_version` cho dòng không đổi. Gọi sau finalize import (baseline v0) và sau khi C-7
 * ghi CR (`scheduleEmbeddingSync`); backfill bằng `src/scripts/migrate-spine-embeddings.ts`.
 *
 * **Không bao giờ chặn hay làm hỏng luồng chính** — chạy nền (fire-and-forget), không await trong request:
 *   - embed vài trăm phần tử mất vài giây gọi mạng; finalize / duyệt CR đã dài, không cộng thêm độ trễ đó;
 *   - lỗi chỉ ghi log: index là dữ liệu suy diễn, lần đồng bộ sau (hoặc script) dựng lại; C-3 thiếu vector thì
 *     tự rơi về từ khoá;
 *   - mỗi project tối đa **một** lượt đang chạy (cờ trong module): gọi thêm lúc đang chạy ⇒ đánh dấu chạy lại một lần
 *     sau khi xong (gộp lượt), tránh hai lượt upsert cùng phần tử đè nhau.
 * Embedding tắt / thiếu key ⇒ bỏ qua ngay, không đụng DB; Mongo không có `$vectorSearch` ⇒ bỏ qua (không có index để
 * dùng thì embed chỉ tốn tiền).
 */

import mongoose from "mongoose"
import { embeddingAvailable, embeddingModelId, embedTexts } from "../../../shared/ai/embedding/embedding.provider.js"
import * as spineRepository from "../../spine/spine.repository.js"
import { elementDocs, planSync } from "./element-text.js"
import { SpineEmbedding } from "./spine-embedding.model.js"
import { isVectorSearchSupported } from "./vector-search.js"

export interface EmbeddingSyncResult {
  embedded: number
  removed: number
  kept: number
}

/** Đồng bộ một project, chờ xong. `null` = bỏ qua (embedding không dùng được / không có Spine). Lỗi ném ra người gọi. */
export const syncProjectEmbeddings = async (projectId: string): Promise<EmbeddingSyncResult | null> => {
  if (!embeddingAvailable() || !(await isVectorSearchSupported())) return null
  const spine = await spineRepository.get(projectId)
  if (!spine) return null
  const pid = new mongoose.Types.ObjectId(projectId)
  const current = elementDocs(spine, embeddingModelId())
  const indexed = await SpineEmbedding.find({ projectId: pid, kind: "element" }).select("ref text_hash").lean()
  const plan = planSync(current, indexed)

  if (plan.embed.length) {
    const vectors = await embedTexts(
      plan.embed.map((d) => d.text),
      { taskType: "RETRIEVAL_DOCUMENT" }
    )
    await SpineEmbedding.bulkWrite(
      plan.embed.map((d, i) => ({
        updateOne: {
          filter: { projectId: pid, kind: "element", ref: d.ref },
          update: { $set: { entity: d.entity, section_id: d.section_id, spine_version: spine.spine_version, text: d.text, text_hash: d.text_hash, embedding: vectors[i]! } },
          upsert: true
        }
      }))
    )
  }
  if (plan.remove.length) await SpineEmbedding.deleteMany({ projectId: pid, kind: "element", ref: { $in: plan.remove } })
  if (plan.keep.length) await SpineEmbedding.updateMany({ projectId: pid, kind: "element", ref: { $in: plan.keep } }, { $set: { spine_version: spine.spine_version } })
  return { embedded: plan.embed.length, removed: plan.remove.length, kept: plan.keep.length }
}

const inFlight = new Map<string, Promise<void>>()
const again = new Set<string>()

/** Lượt đồng bộ nền đang chạy của project (test / script chờ được); không có ⇒ resolve ngay. */
export const pendingEmbeddingSync = (projectId: string): Promise<void> => inFlight.get(projectId) ?? Promise.resolve()

/** Đồng bộ nền, không chờ, không ném. Embedding không dùng được ⇒ không làm gì. */
export const scheduleEmbeddingSync = (projectId: string): void => {
  if (!embeddingAvailable()) return
  if (inFlight.has(projectId)) {
    again.add(projectId)
    return
  }
  const run = async (): Promise<void> => {
    do {
      again.delete(projectId)
      try {
        const res = await syncProjectEmbeddings(projectId)
        if (res && (res.embedded || res.removed)) console.log(`[embedding] project ${projectId}: embed ${res.embedded}, xoá ${res.removed}, giữ ${res.kept}`)
      } catch (err) {
        console.warn(`[embedding] đồng bộ index embedding lỗi (project ${projectId}) — index giữ bản cũ tới lượt sau: ${err instanceof Error ? err.message : String(err)}`)
      }
    } while (again.has(projectId))
  }
  inFlight.set(
    projectId,
    run().finally(() => inFlight.delete(projectId))
  )
}
