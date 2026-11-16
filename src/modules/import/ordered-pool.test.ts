import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runOrdered, type PoolRead, type PoolStop } from "./ordered-pool.js"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Trễ đọc theo phần tử — phần tử sau đọc xong trước phần tử trước. */
const DELAYS = [40, 5, 25, 1, 30, 10, 2, 15]

const track = () => {
  const log = { started: [] as number[], committed: [] as number[], active: 0, peak: 0 }
  const read =
    (fail?: (i: number) => PoolRead<string> | Error | undefined) =>
    async (_: number, i: number): Promise<PoolRead<string>> => {
      log.started.push(i)
      log.active++
      log.peak = Math.max(log.peak, log.active)
      await sleep(DELAYS[i % DELAYS.length])
      log.active--
      const forced = fail?.(i)
      if (forced instanceof Error) throw forced
      return forced ?? { ok: true, value: `v${i}` }
    }
  const commit = async (_: number, value: string, i: number): Promise<void> => {
    expect(value).toBe(`v${i}`)
    log.committed.push(i)
  }
  return { log, read, commit }
}

const items = Array.from({ length: 8 }, (_, i) => i)

/** Chạy pool trên fake timers ⇒ thứ tự đọc xong chỉ phụ thuộc `DELAYS`, không phụ thuộc tải máy. */
const runFake: typeof runOrdered = (...args) => {
  const run = runOrdered(...args)
  run.catch(() => undefined)
  return vi.runAllTimersAsync().then(() => run)
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("runOrdered — đọc song song, ghép theo thứ tự (FLF-392)", () => {
  it("đọc xong lộn xộn ⇒ ghép đúng thứ tự; không vượt giới hạn đồng thời; lấy phần tử theo thứ tự", async () => {
    const { log, read, commit } = track()
    const res = await runFake(items, 3, { read: read(), commit, stop: { aborted: false } })
    expect(res.committed).toBe(8)
    expect(log.committed).toEqual(items)
    expect(log.started).toEqual(items)
    expect(log.peak).toBe(3)
  })

  it("limit 1 ⇒ tuần tự: đọc rồi ghép từng phần tử", async () => {
    const { log, read, commit } = track()
    await runFake(items, 1, { read: read(), commit, stop: { aborted: false } })
    expect(log.peak).toBe(1)
    expect(log.committed).toEqual(items)
  })

  it("không có phần tử ⇒ không đọc, không ghép", async () => {
    const { log, read, commit } = track()
    expect(await runFake([], 4, { read: read(), commit, stop: { aborted: false } })).toEqual({ committed: 0 })
    expect(log.started).toEqual([])
  })

  it("`{ ok: false }` ⇒ bật stop, không lấy phần tử mới; lượt đang bay chạy xong; tiền tố sẵn vẫn ghép, phần sau không", async () => {
    const { log, read, commit } = track()
    const stop: PoolStop = { aborted: false }
    const res = await runFake(items, 3, { read: read((i) => (i === 3 ? { ok: false } : undefined)), commit, stop })
    expect(stop.aborted).toBe(true)
    expect(res.committed).toBe(3)
    expect(log.committed).toEqual([0, 1, 2])
    // 0, 1, 2 bắt đầu cùng lúc; 1 xong (5ms) ⇒ lấy 3; 3 hỏng (1ms) ⇒ không lấy thêm, 0 và 2 vẫn chạy xong rồi được ghép
    expect(log.started).toEqual([0, 1, 2, 3])
    expect(log.active).toBe(0)
  })

  it("`read` ném lỗi ⇒ chờ mọi worker dừng rồi mới ném; không phần tử mới nào bắt đầu sau lỗi", async () => {
    const { log, read, commit } = track()
    const stop: PoolStop = { aborted: false }
    let startedAtError = -1
    const boom = new Error("disk full")
    await expect(
      runFake(items, 3, {
        read: read((i) => {
          if (i !== 1) return undefined
          startedAtError = log.started.length
          return boom
        }),
        commit,
        stop
      })
    ).rejects.toBe(boom)
    expect(stop.aborted).toBe(true)
    expect(log.active).toBe(0)
    expect(log.started).toHaveLength(startedAtError)
    // Lỗi (không phải dừng thường) ⇒ không ghép gì thêm, kể cả phần tử 0 đọc xong sau đó; job thử lại sẽ ghép
    expect(log.committed).toEqual([])
  })

  it("`commit` ném lỗi ⇒ dừng, không ghép tiếp, ném lại lỗi sau khi worker dừng", async () => {
    const { log, read } = track()
    const stop: PoolStop = { aborted: false }
    const committed: number[] = []
    await expect(
      runFake(items, 2, {
        read: read(),
        commit: async (_, __, i) => {
          if (i === 2) throw new Error("save failed")
          committed.push(i)
        },
        stop
      })
    ).rejects.toThrow("save failed")
    expect(committed).toEqual([0, 1])
    expect(stop.aborted).toBe(true)
    expect(log.active).toBe(0)
  })

  it("stop bật từ ngoài (người dùng Dừng) ⇒ worker không lấy phần tử mới", async () => {
    const { log, read, commit } = track()
    const stop: PoolStop = { aborted: false }
    const res = await runFake(items, 2, {
      read: async (item, i) => {
        if (i === 2) stop.aborted = true
        return read()(item, i)
      },
      commit,
      stop
    })
    expect(log.started).toEqual([0, 1, 2])
    expect(res.committed).toBe(3)
  })
})
