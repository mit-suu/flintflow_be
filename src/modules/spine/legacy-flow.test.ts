import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { edgeTo, legacyFlowEdge, normalizeFlowAt } from "./legacy-flow.js"
import { planRevert, planTransaction } from "./op-engine.js"
import { findDeadReferences } from "./reference-fields.js"
import { resolve } from "./path-resolver.js"
import { spineSchema } from "./spine.schema.js"
import type { Change, Spine } from "./spine.types.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))
const txn = (ops: unknown[]) => ({ ops, by: "u", txn: "t" }) as unknown as Parameters<typeof planTransaction>[1]
const flowOf = (spine: Spine, id: string) => spine.screens.find((s) => s.id === id)!.flow_to

describe("legacyFlowEdge / normalizeFlowAt", () => {
  it("chuỗi ⇒ { to }; trigger / guard rỗng, null hay toàn khoảng trắng bị bỏ, chữ được cắt trắng", () => {
    expect(legacyFlowEdge("S02")).toEqual({ to: "S02" })
    expect(legacyFlowEdge({ to: "S02", trigger: "  ", guard: null })).toEqual({ to: "S02" })
    expect(legacyFlowEdge({ to: "S02", trigger: " Submit ", guard: "OTP valid" })).toEqual({ to: "S02", trigger: "Submit", guard: "OTP valid" })
    expect(legacyFlowEdge(5)).toBe(5)
  })

  it("theo path: cả mảng, một cạnh, cả màn, gốc; path khác giữ nguyên", () => {
    expect(normalizeFlowAt("screens[id=S01].flow_to", ["S02"])).toEqual([{ to: "S02" }])
    expect(normalizeFlowAt("screens[id=S01].flow_to[]", "S02")).toEqual({ to: "S02" })
    expect(normalizeFlowAt("screens[]", { id: "S9", flow_to: ["S02"] })).toEqual({ id: "S9", flow_to: [{ to: "S02" }] })
    expect(normalizeFlowAt("$", { screens: [{ id: "S9", flow_to: ["S02"] }] })).toEqual({ screens: [{ id: "S9", flow_to: [{ to: "S02" }] }] })
    expect(normalizeFlowAt("actors[id=A01].name", "x")).toBe("x")
    expect(edgeTo({ to: "S2" })).toBe("S2")
    expect(edgeTo("S2")).toBe("S2")
  })
})

describe("spineSchema đọc Spine cũ", () => {
  it("flow_to là mảng chuỗi ⇒ mảng { to }, schema vẫn strict", () => {
    const old = structuredClone(FIXTURE) as unknown as { screens: { flow_to: unknown[] }[] }
    old.screens.forEach((s) => (s.flow_to = s.flow_to.map((e) => (e as { to: string }).to)))
    const parsed = spineSchema.parse(old)
    expect(parsed.screens[0].flow_to).toEqual(FIXTURE.screens[0].flow_to.map((e) => ({ to: e.to })))
    const extra = structuredClone(FIXTURE) as unknown as { screens: { flow_to: unknown[] }[] }
    extra.screens[0].flow_to = [{ to: "S02", foo: 1 }]
    expect(spineSchema.safeParse(extra).success).toBe(false)
  })
})

describe("op engine với flow_to dạng cạnh", () => {
  it("path chọn cạnh theo khoá `to`; path cũ [=S] vẫn chọn đúng cạnh", () => {
    expect(resolve(FIXTURE, "screens[id=S01].flow_to[to=S02]")).toMatchObject({ kind: "element", value: { to: "S02", trigger: "Click Register" } })
    expect(resolve(FIXTURE, "screens[id=S01].flow_to[=S02]")).toMatchObject({ kind: "element", value: { to: "S02" } })
  })

  it("sửa trigger / guard theo khoá; không được đổi `to`", () => {
    const plan = planTransaction(FIXTURE, txn([{ op: "set", path: "screens[id=S01].flow_to[to=S02].trigger", value: "Tap Register" }]), { startSeq: 1 })
    expect(flowOf(plan.spine, "S01").find((e) => e.to === "S02")).toEqual({ to: "S02", trigger: "Tap Register" })
    expect(() => planTransaction(FIXTURE, txn([{ op: "set", path: "screens[id=S01].flow_to[to=S02].to", value: "S03" }]), { startSeq: 1 })).toThrow()
  })

  it("add nhận cạnh object hoặc chuỗi cũ; thêm trùng màn đích bị từ chối", () => {
    const plan = planTransaction(
      FIXTURE,
      txn([
        { op: "add", path: "screens[id=S04].flow_to[]", value: { to: "S01", trigger: "Back", guard: "Session expired" } },
        { op: "add", path: "screens[id=S06].flow_to[]", value: "S02" }
      ]),
      { startSeq: 1 }
    )
    expect(flowOf(plan.spine, "S04")).toContainEqual({ to: "S01", trigger: "Back", guard: "Session expired" })
    expect(flowOf(plan.spine, "S06")).toContainEqual({ to: "S02" })
    expect(plan.changes.some((c) => c.path === "screens[id=S04].flow_to[to=S01]")).toBe(true)
    expect(() => planTransaction(FIXTURE, txn([{ op: "add", path: "screens[id=S01].flow_to[]", value: { to: "S02" } }]), { startSeq: 1 })).toThrow()
  })

  it("set cả mảng bằng danh sách id cũ giữ trigger / guard của cạnh đã có và bỏ trùng màn đích", () => {
    const plan = planTransaction(FIXTURE, txn([{ op: "set", path: "screens[id=S01].flow_to", value: ["S02", "S03", "S02"] }]), { startSeq: 1 })
    expect(flowOf(plan.spine, "S01")).toEqual([FIXTURE.screens[0].flow_to[0], FIXTURE.screens[0].flow_to[1]])
  })

  it("xoá màn ⇒ cascade gỡ cạnh có `to` = màn đó; không còn khoá chết; undo khôi phục cạnh kèm trigger", () => {
    const plan = planTransaction(FIXTURE, txn([{ op: "remove", path: "screens[id=S08]" }]), { startSeq: 1 })
    expect(flowOf(plan.spine, "S07").map((e) => e.to)).not.toContain("S08")
    expect(findDeadReferences(plan.spine).filter((h) => h.targetId === "S08")).toEqual([])
    const changes = plan.changes.map((c, i) => ({ ...c, seq: i + 1 }) as unknown as Change)
    const reverted = planRevert(plan.spine, changes, { by: "u", startSeq: 100 })
    expect(flowOf(reverted.spine, "S07").find((e) => e.to === "S08")).toEqual(FIXTURE.screens.find((s) => s.id === "S07")!.flow_to.find((e) => e.to === "S08"))
  })

  it("bất biến: `to` trỏ màn không tồn tại là khoá chết", () => {
    const broken = structuredClone(FIXTURE)
    broken.screens[0].flow_to.push({ to: "S99", trigger: "x" })
    expect(findDeadReferences(broken).map((h) => h.refPath)).toEqual(["screens[id=S01].flow_to[to=S99]"])
  })
})
