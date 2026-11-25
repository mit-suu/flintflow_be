import { describe, it, expect, vi } from "vitest"
import type { Diagram } from "../spine/spine.types.js"
import { autoRerenderTargets, mockupIdsStaleNow } from "./step-runner.service.js"

const diagram = (id: string, kind: Diagram["kind"], owner: string | null = null): Diagram =>
  ({ id, kind, section: "function:FN001", owner_kind: owner ? "screen" : null, owner_id: owner, format: "puml", source: "", render_status: "ok", source_hash: "h", rendered_at: null }) as unknown as Diagram

describe("autoRerenderTargets (FLF-489)", () => {
  it("mockup lạc hậu từ trước bước thì không vẽ lại; mockup lạc hậu do bước này thì có", () => {
    const m1 = diagram("D1", "screen_layout", "S01")
    const m2 = diagram("D2", "screen_layout", "S02")
    expect(autoRerenderTargets([m1, m2], new Set(["D1"]), new Set())).toEqual([{ kind: "screen_layout", owner_id: "S02" }])
  })

  it("sơ đồ tuần tự lạc hậu từ trước vẫn được vẽ lại, gộp đích trùng", () => {
    const s1 = diagram("D3", "sequence")
    const s2 = diagram("D4", "sequence")
    expect(autoRerenderTargets([s1, s2], new Set(["D3", "D4"]), new Set())).toEqual([{ kind: "sequence", owner_id: null }])
  })

  it("kind step đã vẽ thì bỏ như cũ", () => {
    expect(autoRerenderTargets([diagram("D5", "erd"), diagram("D3", "sequence")], new Set(), new Set(["erd"]))).toEqual([{ kind: "sequence", owner_id: null }])
  })
})

const stale = vi.hoisted(() => ({ list: [] as unknown[] }))
vi.mock("../diagram/render-context.js", () => ({ loadRenderContext: async () => ({}) }))
vi.mock("../diagram/diagram.service.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), staleRenderedDiagrams: () => stale.list }))

describe("mockupIdsStaleNow (FLF-489: dùng chung cho step chạy chính và cổng revision / regenerate)", () => {
  it("chỉ lấy id mockup màn hình lạc hậu, bỏ sơ đồ loại khác", async () => {
    stale.list = [diagram("D1", "screen_layout", "S01"), diagram("D3", "sequence")]
    expect([...(await mockupIdsStaleNow("p1", {} as never))]).toEqual(["D1"])
  })
})
