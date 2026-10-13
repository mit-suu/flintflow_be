/**
 * Job nền qua một giao diện chung, hai driver (env `JOB_DRIVER`, docs/background-jobs.md):
 *   - `inline` (mặc định): chạy ngay trong tiến trình gọi, một lần, không retry — đúng hành vi trước khi có queue.
 *     Dev / test / CI không cần Redis.
 *   - `bullmq`: job vào Redis; worker (`src/worker.ts`) nhận, retry có backoff, sống qua lần khởi động lại.
 *
 * Mongo vẫn là nguồn sự thật của trạng thái nghiệp vụ (import `extracting`/`paused`…); queue chỉ quyết định ai chạy
 * và khi nào. Vì vậy processor phải chạy lại được (idempotent): I-4 có `extract_cursor`, finalize hoàn về mốc, embedding
 * so `text_hash`. Lỗi nghiệp vụ (4xx: sai trạng thái, hết credit…) không retry.
 */

import { Queue, QueueEvents, UnrecoverableError, type JobsOptions } from "bullmq"
import { env } from "../../config/env.js"
import { ApiError } from "../utils/api-error.js"
import { getRedis } from "./connection.js"

export const QUEUE_NAMES = ["import", "embedding", "email", "system"] as const
export type QueueName = (typeof QUEUE_NAMES)[number]

/** Tiền tố key Redis (env `QUEUE_PREFIX`) — mỗi môi trường một tiền tố khi dùng chung một Redis. */
export const QUEUE_PREFIX = env.QUEUE_PREFIX

export interface JobContext {
  /** Lần thử thứ mấy (1 = lần đầu). Driver inline luôn là 1. */
  attempt: number
  /** Lần này lỗi thì không còn lượt nào nữa. */
  finalAttempt: boolean
}

export interface JobDef<T> {
  queue: QueueName
  name: string
  process: (data: T, ctx: JobContext) => Promise<unknown>
  /** Lần thử cuối vẫn lỗi (hoặc lỗi không retry) ⇒ đưa nghiệp vụ về trạng thái nhất quán (vd. `paused`). */
  onFinalFailure?: (data: T, err: unknown) => Promise<void>
  /** attempts / backoff / removeOn* của BullMQ. Driver inline bỏ qua (chạy đúng một lần). */
  options?: JobsOptions
  /** Driver inline: người gọi chờ job xong (email OTP — giữ hành vi cũ). Mặc định chạy nền. */
  inlineAwait?: boolean
  /** Job định kỳ: chu kỳ (ms). */
  repeatEveryMs?: number
}

// ─── Registry: worker tra processor theo `queue/name` của job ───────────

const registry = new Map<string, JobDef<unknown>>()
const regKey = (queue: string, name: string) => `${queue}/${name}`

export const defineJob = <T>(def: JobDef<T>): JobDef<T> => {
  registry.set(regKey(def.queue, def.name), def as JobDef<unknown>)
  return def
}

export const findJobDef = (queue: string, name: string): JobDef<unknown> | undefined => registry.get(regKey(queue, name))

export const jobDefs = (): JobDef<unknown>[] => [...registry.values()]

export const usesQueue = (): boolean => env.JOB_DRIVER === "bullmq"

// ─── Chạy processor (chung cho hai driver) ───────────

const noop = () => undefined

/** Lỗi nghiệp vụ (4xx) chạy lại cũng không khá hơn ⇒ không retry. */
const isUnrecoverable = (err: unknown): boolean => err instanceof UnrecoverableError || (err instanceof ApiError && err.statusCode < 500)

export const reportFinalFailure = async <T>(def: JobDef<T>, data: T, err: unknown): Promise<void> => {
  if (!def.onFinalFailure) {
    console.error(`[job ${def.queue}/${def.name}] lỗi:`, err)
    return
  }
  await def.onFinalFailure(data, err).catch((e: unknown) => console.error(`[job ${def.queue}/${def.name}] xử lý lỗi cuối thất bại:`, e))
}

/** Chạy processor; lần cuối lỗi (hoặc lỗi không retry) ⇒ `onFinalFailure` rồi ném tiếp cho driver. */
export const runJob = async <T>(def: JobDef<T>, data: T, ctx: JobContext): Promise<unknown> => {
  try {
    return await def.process(data, ctx)
  } catch (err) {
    const fatal = isUnrecoverable(err)
    if (fatal || ctx.finalAttempt) await reportFinalFailure(def, data, err)
    if (fatal && !(err instanceof UnrecoverableError)) throw new UnrecoverableError(err instanceof Error ? err.message : String(err))
    throw err
  }
}

// ─── Driver inline ───────────

const INLINE_CTX: JobContext = { attempt: 1, finalAttempt: true }
const inlineRunning = new Map<string, Promise<void>>()
const inlineAgain = new Map<string, unknown>()
const inlineKey = (def: JobDef<unknown>, key: string) => `${def.queue}/${key}`

// Không `async`: phải đăng ký vào `inlineRunning` NGAY (không `await` xen giữa kiểm và set) để hai lượt gọi liền nhau
// không cùng chạy.
const enqueueInline = <T>(def: JobDef<T>, data: T, opts: EnqueueOptions): Promise<void> => {
  if (!opts.key) {
    const run = runJob(def, data, INLINE_CTX).then(noop, noop)
    return def.inlineAwait ? run : Promise.resolve()
  }
  const k = inlineKey(def as JobDef<unknown>, opts.key)
  const current = inlineRunning.get(k)
  if (current) {
    if (opts.keepLastIfActive) inlineAgain.set(k, data)
    return def.inlineAwait ? current : Promise.resolve()
  }
  const loop = async (): Promise<void> => {
    let payload = data
    for (;;) {
      await runJob(def, payload, INLINE_CTX).catch(noop)
      if (!inlineAgain.has(k)) return
      payload = inlineAgain.get(k) as T
      inlineAgain.delete(k)
    }
  }
  const run = loop().finally(() => inlineRunning.delete(k))
  inlineRunning.set(k, run)
  return def.inlineAwait ? run : Promise.resolve()
}

// ─── Driver BullMQ ───────────

const ACTIVE_STATES = new Set(["waiting", "active", "delayed", "prioritized", "waiting-children"])

/** Job xong giữ 1 ngày để xem trên Bull Board; job lỗi giữ 7 ngày để điều tra. */
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 }
}

const queues = new Map<QueueName, Queue>()
const queueEvents = new Map<QueueName, QueueEvents>()

export const getQueue = (name: QueueName): Queue => {
  let queue = queues.get(name)
  if (!queue) {
    queue = new Queue(name, { connection: getRedis(), prefix: QUEUE_PREFIX, defaultJobOptions: DEFAULT_JOB_OPTIONS })
    queues.set(name, queue)
  }
  return queue
}

const getQueueEvents = (name: QueueName): QueueEvents => {
  let events = queueEvents.get(name)
  if (!events) {
    // QueueEvents đọc stream bằng lệnh chặn ⇒ kết nối riêng
    events = new QueueEvents(name, { connection: getRedis().duplicate(), prefix: QUEUE_PREFIX })
    queueEvents.set(name, events)
  }
  return events
}

const enqueueBull = async <T>(def: JobDef<T>, data: T, opts: EnqueueOptions): Promise<void> => {
  await getQueue(def.queue).add(def.name, data, {
    ...def.options,
    ...(opts.delayMs ? { delay: opts.delayMs } : {}),
    // Deduplication (không ttl) = tối đa một job cùng key chưa xong; xong rồi key tự gỡ. Khác `jobId` cố định ở chỗ
    // job cũ vẫn được giữ để xem lịch sử mà không chặn lần chạy sau.
    ...(opts.key ? { deduplication: { id: opts.key, ...(opts.keepLastIfActive ? { keepLastIfActive: true } : {}) } } : {})
  })
}

export const closeQueues = async (): Promise<void> => {
  await Promise.all([...queueEvents.values()].map((e) => e.close().catch(noop)))
  await Promise.all([...queues.values()].map((q) => q.close().catch(noop)))
  queueEvents.clear()
  queues.clear()
}

// ─── API dùng trong module nghiệp vụ ───────────

export interface EnqueueOptions {
  /** Khoá chống trùng: đang có job cùng key chưa xong ⇒ không thêm. */
  key?: string
  /** Có `key` và job cùng key ĐANG CHẠY ⇒ chạy thêm một lượt sau khi nó xong (giữ dữ liệu mới nhất). */
  keepLastIfActive?: boolean
  delayMs?: number
}

/** Đưa job vào hàng đợi (inline: chạy nền ngay). Không ném lỗi của processor; chỉ ném khi không đưa được vào Redis. */
export const enqueueJob = <T>(def: JobDef<T>, data: T, opts: EnqueueOptions = {}): Promise<void> =>
  usesQueue() ? enqueueBull(def, data, opts) : enqueueInline(def, data, opts)

export interface StartOptions {
  key: string
  /** Chạy và được chờ TRƯỚC khi trả lời client (bỏ `paused`, ghi mốc…). Lỗi ⇒ `onFinalFailure`, job không chạy. */
  prepare?: () => Promise<void>
}

/**
 * Bắt đầu job độc quyền theo `key` (mỗi import tối đa một job). Trả `false` khi đang có job cùng key — người gọi trả
 * trạng thái hiện tại thay vì chạy lần hai.
 */
export const startJob = async <T>(def: JobDef<T>, data: T, { key, prepare }: StartOptions): Promise<boolean> => {
  if (!usesQueue()) {
    const k = inlineKey(def as JobDef<unknown>, key)
    if (inlineRunning.has(k)) return false
    const prepared = prepare ? prepare() : Promise.resolve()
    const run = prepared
      .then(
        () => runJob(def, data, INLINE_CTX),
        (err: unknown) => reportFinalFailure(def, data, err)
      )
      .then(noop, noop)
      .finally(() => inlineRunning.delete(k))
    inlineRunning.set(k, run)
    await prepared.catch(noop) // lỗi đã đi vào onFinalFailure (⇒ paused); client poll thấy
    return true
  }

  if (await isJobActive(def, key)) return false
  // Hai request song song (bấm đúp, hai instance) cùng thấy "chưa có job" ⇒ chỉ một bên được chạy `prepare`
  const claimKey = `${QUEUE_PREFIX}:claim:${def.queue}:${key}`
  const claimed = await getRedis().set(claimKey, "1", "PX", 60_000, "NX")
  if (!claimed) return false
  try {
    if (prepare) {
      try {
        await prepare()
      } catch (err) {
        await reportFinalFailure(def, data, err)
        return true
      }
    }
    await enqueueBull(def, data, { key })
    return true
  } finally {
    await getRedis().del(claimKey).catch(noop)
  }
}

/** Có job cùng key đang chờ / chạy / chờ retry không. */
export const isJobActive = async <T>(def: JobDef<T>, key: string): Promise<boolean> => {
  if (!usesQueue()) return inlineRunning.has(inlineKey(def as JobDef<unknown>, key))
  const queue = getQueue(def.queue)
  const id = await queue.getDeduplicationJobId(key)
  if (!id) return false
  const job = await queue.getJob(id)
  return job ? ACTIVE_STATES.has(await job.getState()) : false
}

/** Chờ job cùng key xong (thành công hay lỗi đều resolve). Không có ⇒ resolve ngay. */
export const waitForJob = async <T>(def: JobDef<T>, key: string): Promise<void> => {
  if (!usesQueue()) {
    await inlineRunning.get(inlineKey(def as JobDef<unknown>, key))
    return
  }
  const queue = getQueue(def.queue)
  const id = await queue.getDeduplicationJobId(key)
  const job = id ? await queue.getJob(id) : undefined
  if (!job) return
  await job.waitUntilFinished(getQueueEvents(def.queue)).catch(noop)
}

/** Driver inline: job định kỳ bằng `setInterval` (driver bullmq dùng job scheduler — `workers.ts`). */
export const startInlineSchedules = (): void => {
  for (const def of jobDefs()) {
    if (!def.repeatEveryMs) continue
    setInterval(() => void runJob(def, undefined, INLINE_CTX).catch(noop), def.repeatEveryMs)
  }
}
