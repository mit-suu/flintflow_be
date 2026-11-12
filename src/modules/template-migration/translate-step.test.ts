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

/** Executor giả: dịch bằng provider mock (tiền tố ngôn ngữ đích), đếm lượt gọi và ghi prompt để kiểm thứ tự tên → thân. */
const executorOf = (calls: string[]): TranslateDocumentExecutor =>
  async (input) => {
    const items = JSON.parse(String(input.promptVariables?.items)) as { key: string; text: string | string[] }[]
    calls.push(items.map((i) => i.key).join("|"))
    const prompt = `You translate a batch into English.\nItems:\n${JSON.stringify(items)}`
    return { data: { items: mockTranslateItems(prompt) }, cost: 2 } as never
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
  })

  it("chạy lại với bản dịch đã lưu ⇒ không gọi AI lần hai (không trừ credit); lô đầu lỗi ⇒ ném và phần đã có được lưu theo lô", async () => {
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

  it("filter chỉ dịch các đơn vị được chọn (đổi ngược chỉ dịch mục đã sửa được giữ); lô không có bản dịch hợp lệ ⇒ ném, không ghi gì", async () => {
    const calls: string[] = []
    const result = await translateForMigration({ projectId: "p1", userId: "u1", spine: spine(), source: "vi", target: "en", filter: (u) => u.key === "project.vision", executor: executorOf(calls) })
    expect(result.ops.map((o) => o.path)).toEqual(["project.vision"])

    const empty: TranslateDocumentExecutor = async () => ({ data: { items: [] }, cost: 2 }) as never
    await expect(translateForMigration({ projectId: "p1", userId: "u1", spine: spine(), source: "vi", target: "en", executor: empty })).rejects.toMatchObject({ code: "TEMPLATE_MIGRATION_TRANSLATION_FAILED" })
  })
})
