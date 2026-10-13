/**
 * Driver bullmq với Redis thật — chỉ chạy khi có `TEST_REDIS_URL` (vd. `docker run -p 6390:6379 redis:7-alpine` rồi
 * `TEST_REDIS_URL=redis://localhost:6390 npx vitest run src/shared/queue`). Kiểm những gì driver inline không chứng minh
 * được: chống trùng qua Redis, retry có backoff, gộp lượt khi đang chạy, worker nhận job.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  if (!process.env.TEST_REDIS_URL) return
  process.env.JOB_DRIVER = "bullmq"
  process.env.REDIS_URL = process.env.TEST_REDIS_URL
})

const { defineJob, enqueueJob, getQueue, isJobActive, startJob, waitForJob, closeQueues } = await import("./job-runner.js")
const { startWorkers, stopWorkers } = await import("./workers.js")
const { closeRedis, getRedis } = await import("./connection.js")

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}
const until = async (check: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("hết thời gian chờ")
    await new Promise((r) => setTimeout(r, 25))
  }
}

const run = Date.now().toString(36)

describe.skipIf(!process.env.TEST_REDIS_URL)("job-runner — driver bullmq (Redis thật)", () => {
  beforeAll(async () => {
    await getQueue("system").obliterate({ force: true })
    await startWorkers()
  })
  afterAll(async () => {
    await stopWorkers()
    await getQueue("system").obliterate({ force: true })
    await closeQueues()
    await closeRedis()
  })

  it("startJob: một key một job — lượt thứ hai khi đang chạy trả false; xong thì key được gỡ", async () => {
    const gate = deferred()
    const process = vi.fn(() => gate.promise)
    const job = defineJob<{ n: number }>({ queue: "system", name: `exclusive-${run}`, process })

    expect(await startJob(job, { n: 1 }, { key: `ex-${run}` })).toBe(true)
    expect(await startJob(job, { n: 2 }, { key: `ex-${run}` })).toBe(false)
    await until(() => process.mock.calls.length === 1)
    expect(await isJobActive(job, `ex-${run}`)).toBe(true)

    gate.resolve()
    await waitForJob(job, `ex-${run}`)
    expect(await isJobActive(job, `ex-${run}`)).toBe(false)
    expect(process).toHaveBeenCalledTimes(1)
    // Xong rồi ⇒ chạy lại được
    expect(await startJob(job, { n: 3 }, { key: `ex-${run}` })).toBe(true)
    await waitForJob(job, `ex-${run}`)
  })

  it("lỗi tạm thời ⇒ retry; lần sau thành công thì không gọi onFinalFailure", async () => {
    let calls = 0
    const onFinalFailure = vi.fn(async () => undefined)
    const job = defineJob<{ n: number }>({
      queue: "system",
      name: `retry-${run}`,
      options: { attempts: 3, backoff: { type: "fixed", delay: 50 } },
      process: async (_d, ctx) => {
        calls++
        if (ctx.attempt < 3) throw new Error(`lỗi mạng lần ${ctx.attempt}`)
      },
      onFinalFailure
    })
    await startJob(job, { n: 1 }, { key: `rt-${run}` })
    await until(() => calls === 3)
    await waitForJob(job, `rt-${run}`)
    expect(onFinalFailure).not.toHaveBeenCalled()
  })

  it("hết lượt retry ⇒ onFinalFailure đúng một lần", async () => {
    const onFinalFailure = vi.fn(async () => undefined)
    const job = defineJob<{ n: number }>({
      queue: "system",
      name: `fail-${run}`,
      options: { attempts: 2, backoff: { type: "fixed", delay: 50 } },
      process: async () => Promise.reject(new Error("vẫn lỗi")),
      onFinalFailure
    })
    await startJob(job, { n: 1 }, { key: `fl-${run}` })
    await until(() => onFinalFailure.mock.calls.length === 1)
    await waitForJob(job, `fl-${run}`)
    expect(onFinalFailure).toHaveBeenCalledTimes(1)
  })

  it("keepLastIfActive: gọi dồn khi đang chạy ⇒ thêm đúng một lượt với dữ liệu mới nhất", async () => {
    const gate = deferred()
    const seen: number[] = []
    const job = defineJob<{ n: number }>({
      queue: "system",
      name: `coalesce-${run}`,
      process: async ({ n }) => {
        seen.push(n)
        if (n === 1) await gate.promise
      }
    })
    const key = `co-${run}`
    await enqueueJob(job, { n: 1 }, { key, keepLastIfActive: true })
    await until(() => seen.length === 1)
    await enqueueJob(job, { n: 2 }, { key, keepLastIfActive: true })
    await enqueueJob(job, { n: 3 }, { key, keepLastIfActive: true })
    gate.resolve()
    await until(() => seen.length === 2)
    await new Promise((r) => setTimeout(r, 300))
    expect(seen).toEqual([1, 3])
  })

  it("Redis thật sự được dùng (không lùi về inline)", async () => {
    expect(await getRedis().ping()).toBe("PONG")
  })
})
