import { describe, expect, it, vi } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { TranslateDocumentExecutor } from "../translation/translation-run.service.js"
import { mockTranslateItems } from "../../shared/ai/providers/mock.provider.js"
import { translateForMigration } from "./translate-step.js"

const spine = (): Spine => {
  const s = createEmptySpine({ name: "Lumen" })
  s.project.vision = "Hệ thống cho phép người dùng quản lý khoá học trực tuyến một cách thuận tiện."
  s.actors.push({ id: "A01", name: "Quản trị viên", description: "Người quản lý toàn bộ hệ thống khoá học.", flows_in: [], flows_out: [] } as unknown as Spine["actors"][number])
  return s
}

/** Spine có `n` actor (tên + mô tả ⇒ 2n đơn vị dịch), đủ lớn để một lô hỏng chia đôi được vài lần trong test. */
const spineWithActors = (n: number): Spine => {
  const s = createEmptySpine({ name: "Lumen" })
  for (let i = 1; i <= n; i++) {
    s.actors.push({ id: `A${i}`, name: `Diễn viên số ${i}`, description: `Mô tả vai trò của diễn viên số ${i} trong hệ thống.`, flows_in: [], flows_out: [] } as unknown as Spine["actors"][number])
  }
  return s
}

type Item = { key: string; text: string | string[] }

const sentItemsOf = (input: Parameters<TranslateDocumentExecutor>[0]): Item[] => JSON.parse(String(input.promptVariables?.items)) as Item[]

/** Dịch đúng mọi đơn vị gửi (gắn tiền tố `[en] `) — dùng cho các lô "lành" trong kịch bản thử lại. */
const translateAll = (items: Item[]): Item[] => items.map(({ key, text }) => ({ key, text: typeof text === "string" ? `[en] ${text}` : text.map((t) => (t.trim() ? `[en] ${t}` : t)) }))

const okResult = (items: Item[]): unknown => ({ data: { items }, cost: 2, logId: "log-1", rawText: JSON.stringify({ items }) })

/** Executor giả: dịch bằng provider mock (tiền tố ngôn ngữ đích), đếm lượt gọi và ghi prompt để kiểm thứ tự tên → thân. */
const executorOf = (calls: string[]): TranslateDocumentExecutor =>
  async (input) => {
    const items = sentItemsOf(input)
    calls.push(items.map((i) => i.key).join("|"))
    const prompt = `You translate a batch into English.\nItems:\n${JSON.stringify(items)}`
    return { data: { items: mockTranslateItems(prompt) }, cost: 2, logId: "log-1", rawText: prompt } as never
  }

describe("translateForMigration", () => {
  it("dịch VI → EN: tên phần tử trước thân, op set đúng đường dẫn, tính credit theo lô, không đụng Spine gốc", async () => {
    const calls: string[] = []
    const source = spine()
    const result = await translateForMigration({ projectId: "p1", userId: "u1", spine: source, source: "vi", target: "en", executor: executorOf(calls) })
    expect(calls.length).toBeGreaterThan(0)
    // Tên (actors[...].name) đứng trước thân trong lô đầu
    const first = calls[0].split("|")
    expect(first.indexOf("actors[id=A01].name")).toBeGreaterThanOrEqual(0)
    expect(first.indexOf("actors[id=A01].name")).toBeLessThan(first.indexOf("project.vision"))
    expect(result.credits_used).toBe(calls.length * 2)
    const vision = result.ops.find((o) => o.path === "project.vision")
    expect(vision).toMatchObject({ op: "set", value: `[en] ${source.project.vision}` })
    expect(result.ops.find((o) => o.path === "actors[id=A01].name")).toMatchObject({ value: "[en] Quản trị viên" })
    expect(source.project.vision).not.toMatch(/^\[en\]/)
    expect(result.untranslated_keys).toEqual([])
  })

  it("chạy lại với bản dịch đã lưu ⇒ không gọi AI lần hai (không trừ credit); lỗi nhà cung cấp (không phải 422) ⇒ ném", async () => {
    const calls: string[] = []
    const saved: unknown[] = []
    const first = await translateForMigration({ projectId: "p1", userId: "u1", spine: spine(), source: "vi", target: "en", executor: executorOf(calls), onBatch: async (u) => void saved.push(u) })
    expect(saved.length).toBeGreaterThan(0)
    const again = vi.fn(executorOf([]))
    const second = await translateForMigration({ projectId: "p1", userId: "u1", spine: spine(), source: "vi", target: "en", stored: first.units.map((u) => ({ key: u.key, source_hash: u.source_hash, text: u.text })), executor: again })
    expect(again).not.toHaveBeenCalled()
    expect(second.credits_used).toBe(0)
    expect(second.ops).toEqual(first.ops)

    const failing: TranslateDocumentExecutor = async () => {
      throw new Error("hết credit")
    }
    await expect(translateForMigration({ projectId: "p1", userId: "u1", spine: spine(), source: "vi", target: "en", executor: failing })).rejects.toThrow("hết credit")
  })

  it("filter chỉ dịch các đơn vị được chọn (đổi ngược chỉ dịch mục đã sửa được giữ)", async () => {
    const calls: string[] = []
    const result = await translateForMigration({ projectId: "p1", userId: "u1", spine: spine(), source: "vi", target: "en", filter: (u) => u.key === "project.vision", executor: executorOf(calls) })
    expect(result.ops.map((o) => o.path)).toEqual(["project.vision"])
  })

  it("lô đầu trả items: [] (0 đơn vị hợp lệ), lô nhỏ hơn sau khi chia đôi dịch đúng ⇒ không ném, mọi đơn vị được dịch", async () => {
    const calls: Item[][] = []
    const executor: TranslateDocumentExecutor = async (input) => {
      const items = sentItemsOf(input)
      calls.push(items)
      if (items.length > 5) return okResult([]) as never // lô đầu (8 đơn vị) hỏng hoàn toàn
      return okResult(translateAll(items)) as never // lô đã chia đôi (4 đơn vị) dịch đúng
    }
    const result = await translateForMigration({ projectId: "p1", userId: "u1", spine: spineWithActors(4), source: "vi", target: "en", executor })
    expect(calls.length).toBe(3) // 1 lô hỏng (8) + 2 lô chia đôi (4, 4)
    expect(result.untranslated_keys).toEqual([])
    expect(result.ops.length).toBe(8)
    expect(result.ops.every((o) => typeof o.value === "string" && o.value.startsWith("[en] "))).toBe(true)
  })

  it("một đơn vị luôn hỏng (model không trả key đó) ⇒ untranslated_keys có đúng key đó, ops không có op cho nó, đơn vị khác có op", async () => {
    const BAD_KEY = "actors[id=A2].description"
    const executor: TranslateDocumentExecutor = async (input) => {
      const items = sentItemsOf(input)
      const translated = translateAll(items).filter((i) => i.key !== BAD_KEY)
      return okResult(translated) as never
    }
    const result = await translateForMigration({ projectId: "p1", userId: "u1", spine: spineWithActors(4), source: "vi", target: "en", executor })
    expect(result.untranslated_keys).toEqual([BAD_KEY])
    expect(result.ops.find((o) => o.path === BAD_KEY)).toBeUndefined()
    expect(result.ops.find((o) => o.path === "actors[id=A1].description")).toBeDefined()
  })

  it("executor ném lỗi parse 422 ở lô đầu ⇒ xử lý như lô hỏng, chia đôi thử lại, không ném", async () => {
    let call = 0
    const executor: TranslateDocumentExecutor = async (input) => {
      call++
      if (call === 1) throw Object.assign(new Error("parse lỗi"), { statusCode: 422 })
      return okResult(translateAll(sentItemsOf(input))) as never
    }
    const result = await translateForMigration({ projectId: "p1", userId: "u1", spine: spineWithActors(4), source: "vi", target: "en", executor })
    expect(call).toBe(3) // 1 lô ném 422 (8) + 2 lô chia đôi (4, 4) dịch đúng
    expect(result.untranslated_keys).toEqual([])
    expect(result.ops.length).toBe(8)
  })

  it("executor ném lỗi 402 (hết credit) ⇒ vẫn ném; phần đã dịch trước đó đã được lưu qua onBatch", async () => {
    const saved: unknown[][] = []
    let call = 0
    const executor: TranslateDocumentExecutor = async (input) => {
      call++
      const items = sentItemsOf(input)
      if (call === 1) {
        // lô đầu (12 đơn vị): 6 đơn vị dịch được, 6 đơn vị bị loại ⇒ vào hàng thử lại (chia đôi 3/3)
        const half = items.slice(0, 6)
        return okResult(translateAll(half)) as never
      }
      if (call === 2) return okResult(translateAll(items)) as never // lô con đầu (3 đơn vị) dịch được
      throw Object.assign(new Error("hết credit"), { statusCode: 402 }) // lô con thứ hai: hết credit giữa chừng
    }
    await expect(
      translateForMigration({ projectId: "p1", userId: "u1", spine: spineWithActors(6), source: "vi", target: "en", executor, onBatch: async (u) => void saved.push(u) })
    ).rejects.toMatchObject({ statusCode: 402 })
    expect(saved.length).toBeGreaterThan(0)
    expect(saved[saved.length - 1]?.length).toBeGreaterThan(0)
  })

  it("ngân sách thử lại có trần: lô luôn hỏng hoàn toàn ⇒ tổng lượt gọi bị chặn, không lặp mãi, mọi đơn vị thành untranslated_keys", async () => {
    const calls: Item[][] = []
    const executor: TranslateDocumentExecutor = async (input) => {
      const items = sentItemsOf(input)
      calls.push(items)
      return okResult([]) as never // luôn hỏng, mọi lô
    }
    const result = await translateForMigration({ projectId: "p1", userId: "u1", spine: spineWithActors(6), source: "vi", target: "en", executor })
    expect(calls.length).toBeLessThanOrEqual(5) // bị chặn bởi ngân sách thử lại (tối đa 50% số lô ban đầu, không quá 10 lượt)
    expect(result.untranslated_keys.length).toBe(12)
    expect(result.ops.length).toBe(0)
  })

  it("lô nhận một phần (hơn 5 đơn vị bị loại) ⇒ phần bị loại được chia đôi thử lại và dịch được, không còn bị bỏ âm thầm", async () => {
    let call = 0
    const executor: TranslateDocumentExecutor = async (input) => {
      call++
      const items = sentItemsOf(input)
      if (call === 1) {
        // lô đầu (12 đơn vị): 6 dịch được ngay, 6 bị loại (model không trả) ⇒ thử lại
        return okResult(translateAll(items.slice(0, 6))) as never
      }
      return okResult(translateAll(items)) as never // các lô con sau khi chia đôi (3, 3) dịch đúng
    }
    const result = await translateForMigration({ projectId: "p1", userId: "u1", spine: spineWithActors(6), source: "vi", target: "en", executor })
    expect(call).toBe(3) // 1 lô ban đầu + 2 lô con (3, 3)
    expect(result.untranslated_keys).toEqual([])
    expect(result.ops.length).toBe(12)
  })
})
