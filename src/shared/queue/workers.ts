/**
 * Worker BullMQ: mỗi queue một Worker, tra processor theo tên job trong registry (`defineJob`). Chạy trong `src/worker.ts`
 * (production: service `worker` riêng) hoặc ngay trong tiến trình API khi `WORKERS_IN_PROCESS=true` (dev).
 */

import { UnrecoverableError, Worker } from "bullmq"
import { env } from "../../config/env.js"
import { closeRedis, getRedis } from "./connection.js"
import { QUEUE_NAMES, QUEUE_PREFIX, closeQueues, findJobDef, getQueue, jobDefs, reportFinalFailure, runJob, type QueueName } from "./job-runner.js"

/**
 * `lockDuration`: worker gia hạn khoá mỗi nửa chu kỳ trong lúc job chạy; tiến trình chết ⇒ hết khoá ⇒ job "stalled" và
 * được đưa lại hàng đợi cho worker khác. Import parse docx có thể chặn event loop vài giây nên để rộng tay.
 */
const WORKER_CONFIG: Record<QueueName, { concurrency: number; lockDuration: number }> = {
  import: { concurrency: env.JOB_IMPORT_CONCURRENCY, lockDuration: 120_000 },
  // Một lượt / lần: các lượt đồng bộ embedding không bao giờ upsert đè nhau
  embedding: { concurrency: 1, lockDuration: 60_000 },
  email: { concurrency: 5, lockDuration: 30_000 },
  // `topup-resume` chờ job finalize xong (vài phút) ⇒ chừa chỗ cho job định kỳ
  system: { concurrency: 4, lockDuration: 60_000 }
}

let workers: Worker[] = []

export const startWorkers = async (): Promise<void> => {
  if (workers.length) return
  for (const name of QUEUE_NAMES) {
    const { concurrency, lockDuration } = WORKER_CONFIG[name]
    const worker = new Worker(
      name,
      async (job) => {
        const def = findJobDef(name, job.name)
        if (!def) throw new UnrecoverableError(`Không có processor cho job ${name}/${job.name}`)
        const attempts = job.opts.attempts ?? 1
        const attempt = job.attemptsMade + 1
        return runJob(def, job.data, { attempt, finalAttempt: attempt >= attempts })
      },
      { connection: getRedis(), prefix: QUEUE_PREFIX, concurrency, lockDuration, maxStalledCount: 2 }
    )
    worker.on("failed", (job, err) => {
      if (!job) return
      console.warn(`[worker ${name}] job ${job.name}#${job.id} lỗi (lần ${job.attemptsMade}/${job.opts.attempts ?? 1}): ${err.message}`)
      // Stalled quá số lần cho phép ⇒ BullMQ đánh lỗi mà processor không hề thấy ⇒ tự gọi xử lý lỗi cuối
      const def = findJobDef(name, job.name)
      if (def && /stalled more than allowable limit/i.test(err.message)) void reportFinalFailure(def, job.data, err)
    })
    worker.on("error", (err) => console.error(`[worker ${name}]`, err.message))
    workers.push(worker)
  }
  // Job định kỳ: upsert idempotent ⇒ nhiều worker khởi động cùng lúc vẫn chỉ một lịch
  for (const def of jobDefs()) {
    if (!def.repeatEveryMs) continue
    await getQueue(def.queue).upsertJobScheduler(def.name, { every: def.repeatEveryMs }, { name: def.name, data: {}, opts: def.options ?? {} })
  }
  console.log(`[worker] Đang nhận job: ${QUEUE_NAMES.map((q) => `${q}×${WORKER_CONFIG[q].concurrency}`).join(", ")}`)
}

/** Đóng worker: job đang chạy được chờ xong (hoặc trả lại hàng đợi khi hết khoá). */
export const stopWorkers = async (): Promise<void> => {
  await Promise.all(workers.map((w) => w.close()))
  workers = []
}

/** SIGTERM / SIGINT (docker stop, Ctrl+C) ⇒ đóng worker, queue, Redis rồi thoát. */
export const installGracefulShutdown = (): void => {
  let stopping = false
  const stop = async (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`[worker] Nhận ${signal} — dừng nhận job, chờ job đang chạy…`)
    await stopWorkers().catch((err: unknown) => console.error("[worker] Đóng worker lỗi:", err))
    await closeQueues()
    await closeRedis()
    process.exit(0)
  }
  process.once("SIGTERM", () => void stop("SIGTERM"))
  process.once("SIGINT", () => void stop("SIGINT"))
}
