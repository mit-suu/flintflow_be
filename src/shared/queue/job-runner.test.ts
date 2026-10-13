/**
 * Driver inline của job-runner (mặc định, không Redis): đúng các bảo đảm mà extract / finalize / embedding dựa vào.
 */
import { describe, expect, it, vi } from "vitest"
import { UnrecoverableError } from "bullmq"
import { ApiError } from "../utils/api-error.js"
import { defineJob, enqueueJob, isJobActive, runJob, startJob, waitForJob } from "./job-runner.js"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

let seq = 0
const def = (overrides: Partial<Parameters<typeof defineJob<{ n: number }>>[0]> = {}) =>
  defineJob<{ n: number }>({ queue: "system", name: `test-${++seq}`, process: async () => undefined, ...overrides })

describe("startJob (inline)", () => {
  it("mỗi key tối đa một job: lượt gọi thứ hai khi đang chạy trả false, không chạy lần hai", async () => {
    const gate = deferred()
    const process = vi.fn(() => gate.promise)
    const job = def({ process })

    expect(await startJob(job, { n: 1 }, { key: "k" })).toBe(true)
    expect(await startJob(job, { n: 2 }, { key: "k" })).toBe(false)
    expect(await isJobActive(job, "k")).toBe(true)

    gate.resolve()
    await waitForJob(job, "k")
    expect(process).toHaveBeenCalledTimes(1)
    expect(await isJobActive(job, "k")).toBe(false)
  })

  it("prepare được chờ trước khi trả; prepare lỗi ⇒ onFinalFailure, processor không chạy", async () => {
    const process = vi.fn(async () => undefined)
    const onFinalFailure = vi.fn(async () => undefined)
    const job = def({ process, onFinalFailure })

    await startJob(job, { n: 1 }, { key: "p", prepare: async () => Promise.reject(new Error("db down")) })
    await waitForJob(job, "p")
    expect(process).not.toHaveBeenCalled()
    expect(onFinalFailure).toHaveBeenCalledWith({ n: 1 }, expect.objectContaining({ message: "db down" }))
  })

  it("processor lỗi ⇒ onFinalFailure một lần (inline không retry), lỗi không lọt ra người gọi", async () => {
    const onFinalFailure = vi.fn(async () => undefined)
    const job = def({ process: async () => Promise.reject(new Error("AI 503")), onFinalFailure })

    await expect(startJob(job, { n: 1 }, { key: "e" })).resolves.toBe(true)
    await waitForJob(job, "e")
    expect(onFinalFailure).toHaveBeenCalledTimes(1)
  })
})

describe("enqueueJob (inline)", () => {
  it("keepLastIfActive: gọi dồn khi đang chạy ⇒ đúng một lượt chạy lại với dữ liệu mới nhất", async () => {
    const gate = deferred()
    const seen: number[] = []
    const job = def({
      process: async ({ n }) => {
        seen.push(n)
        if (n === 1) await gate.promise
      }
    })

    await enqueueJob(job, { n: 1 }, { key: "c", keepLastIfActive: true })
    await enqueueJob(job, { n: 2 }, { key: "c", keepLastIfActive: true })
    await enqueueJob(job, { n: 3 }, { key: "c", keepLastIfActive: true })
    gate.resolve()
    await waitForJob(job, "c")
    expect(seen).toEqual([1, 3])
  })

  it("inlineAwait ⇒ người gọi chờ job xong (email OTP)", async () => {
    const done = vi.fn()
    const job = def({ inlineAwait: true, process: async () => void (await Promise.resolve(), done()) })
    await enqueueJob(job, { n: 1 })
    expect(done).toHaveBeenCalled()
  })
})

describe("runJob", () => {
  it("lỗi tạm thời ở lần chưa cuối ⇒ ném để retry, chưa gọi onFinalFailure", async () => {
    const onFinalFailure = vi.fn(async () => undefined)
    const job = def({ process: async () => Promise.reject(new Error("timeout")), onFinalFailure })
    await expect(runJob(job, { n: 1 }, { attempt: 1, finalAttempt: false })).rejects.toThrow("timeout")
    expect(onFinalFailure).not.toHaveBeenCalled()
  })

  it("lỗi nghiệp vụ 4xx ⇒ không retry (UnrecoverableError) và xử lý lỗi cuối ngay", async () => {
    const onFinalFailure = vi.fn(async () => undefined)
    const job = def({ process: async () => Promise.reject(new ApiError(409, "sai trạng thái", "IMPORT_INVALID_STATE")), onFinalFailure })
    await expect(runJob(job, { n: 1 }, { attempt: 1, finalAttempt: false })).rejects.toBeInstanceOf(UnrecoverableError)
    expect(onFinalFailure).toHaveBeenCalledTimes(1)
  })
})
