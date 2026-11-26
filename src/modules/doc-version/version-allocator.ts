/**
 * Cấp số version tài liệu mode 1 nguyên tử (FLF-466, red-team #4). Số kế tiếp = `nextMinor` / `nextMajor` của version mới nhất; nếu
 * hai đường ghi (CR, đổi mẫu, vẽ lại màn, phát hành) cùng đọc "mới nhất" rồi cùng ghi thì một bên gặp E11000 ở chỉ mục unique
 * `(projectId, version)` — sau khi đã render + lưu file — hoặc tệ hơn ra `1.4` sau `2.0`. Cách làm: khoá thuê (lease) theo dự án
 * trong Mongo — chỉ một đường ghi giữ khoá, đọc "mới nhất" **trong** khoá, nên số cấp ra luôn nối tiếp số đã ghi. Chỉ mục unique
 * vẫn là lưới an toàn cuối. Khoá tự hết hạn (`LEASE_MS`) nên tiến trình chết giữa chừng không kẹt dự án.
 */

import { randomUUID } from "node:crypto"
import mongoose, { Schema } from "mongoose"
import { ApiError } from "../../shared/utils/api-error.js"
import { Mode1Error } from "../import/mode1.errors.js"
import type { IDocVersion } from "./doc-version.model.js"
import { latestDocVersion } from "./doc-version.service.js"
import { nextMajor, nextMinor } from "./versioning.js"

export const DOC_VERSION_BUSY = "DOC_VERSION_BUSY"

interface IDocVersionLock {
  projectId: mongoose.Types.ObjectId
  token: string
  expires_at: Date
}

const lockSchema = new Schema<IDocVersionLock>({
  projectId: { type: Schema.Types.ObjectId, required: true, unique: true },
  token: { type: String, required: true },
  expires_at: { type: Date, required: true }
})

export const DocVersionLock = mongoose.models.DocVersionLock ?? mongoose.model<IDocVersionLock>("DocVersionLock", lockSchema)

/** Một lượt ghi tối đa chừng này (render + lưu file + ghi Spine); quá hạn ⇒ khoá bị lượt khác lấy. */
export const LEASE_MS = 2 * 60_000
/** Chờ khoá tối đa chừng này rồi báo bận. */
export const WAIT_MS = 30_000
const POLL_MS = 100

export type VersionBump = "minor" | "major"

/** Hàm thuần: số version kế tiếp sau `latest`. */
export const nextVersionAfter = (latest: string, bump: VersionBump): string => (bump === "minor" ? nextMinor(latest) : nextMajor(latest))

export interface VersionSlot {
  /** Version mới nhất lúc cấp số (`based_on` của version sắp ghi). */
  latest: IDocVersion
  /** Số được cấp — không ai khác nhận cùng số trong lúc khoá còn giữ. */
  next: string
}

export interface AllocatorOptions {
  waitMs?: number
  leaseMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const isDuplicateKey = (err: unknown): boolean => typeof err === "object" && err !== null && (err as { code?: number }).code === 11000

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const acquire = async (projectId: string, token: string, options: AllocatorOptions): Promise<void> => {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? sleepFor
  const deadline = now() + (options.waitMs ?? WAIT_MS)
  for (;;) {
    try {
      // Khoá chưa có ⇒ tạo; đã có mà hết hạn ⇒ chiếm; còn hạn ⇒ bộ lọc không khớp, upsert đụng chỉ mục unique ⇒ E11000 = bận
      await DocVersionLock.findOneAndUpdate(
        { projectId, expires_at: { $lt: new Date(now()) } },
        { $set: { token, expires_at: new Date(now() + (options.leaseMs ?? LEASE_MS)) } },
        { upsert: true }
      )
      return
    } catch (err) {
      if (!isDuplicateKey(err)) throw err
    }
    if (now() >= deadline) {
      throw new ApiError(409, "Dự án đang ghi một phiên bản tài liệu khác. Thử lại sau giây lát.", DOC_VERSION_BUSY)
    }
    await sleep(POLL_MS)
  }
}

/**
 * Chạy `fn` khi giữ khoá cấp số của dự án. `bump` = `minor` (CR, thay đổi hệ thống) hoặc `major` (phát hành). Chưa có version nào ⇒
 * `DOC_VERSION_NOT_FOUND` (không có gì để nối tiếp). Lỗi trong `fn` vẫn nhả khoá.
 */
export const withVersionSlot = async <T>(projectId: string, bump: VersionBump, fn: (slot: VersionSlot) => Promise<T>, options: AllocatorOptions = {}): Promise<T> => {
  const token = randomUUID()
  await acquire(projectId, token, options)
  try {
    const latest = await latestDocVersion(projectId)
    if (!latest) throw new Mode1Error("DOC_VERSION_NOT_FOUND", "Chưa có version tài liệu nào để nối tiếp")
    return await fn({ latest, next: nextVersionAfter(latest.version, bump) })
  } finally {
    await DocVersionLock.deleteOne({ projectId, token }).catch((e: unknown) => console.warn("[version-allocator] nhả khoá lỗi (tự hết hạn):", e instanceof Error ? e.message : e))
  }
}
