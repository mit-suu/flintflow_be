import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "./spine.schema.js"
import { diagramsToRerender, impactOf, impactOfChanges, referrersOf } from "./impact.service.js"
import type { Spine } from "./spine.types.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const load = (file: string): Spine =>
  spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures", file), "utf8"))) as Spine

const FIXTURE = load("spine-fixture-19-screens.json")

const ids = (impact: { sections: { id: string; relation: string }[] }, relation: string): string[] =>
  impact.sections.filter((s) => s.relation === relation).map((s) => s.id).sort()

describe("impactOf — section theo 3 cột bảng §4", () => {
  it("đổi tên actor người dùng: sở hữu fixed:2.1, đọc fixed:2.2.2 + fixed:3.1.3", () => {
    const impact = impactOf(FIXTURE, ["actors[id=A01].name"])

    expect(ids(impact, "owner")).toEqual(["fixed:2.1"])
    expect(ids(impact, "reads")).toEqual(["fixed:2.2.2", "fixed:3.1.3"])
    // Ba section owner+reads là phần user thấy "sẽ thành stale"; suy dẫn là hình + glossary
    expect([...ids(impact, "owner"), ...ids(impact, "reads")]).toHaveLength(3)
    expect(ids(impact, "derived")).toContain("fixed:5.5")
  })

  it("actor không phải human còn kéo theo fixed:1 và sơ đồ context", () => {
    const impact = impactOf(FIXTURE, ["actors[id=A06].name"])

    expect(ids(impact, "owner")).toEqual(["fixed:1", "fixed:2.1"])
    // Hai hình: usecase (mọi actor) và context (chỉ actor ngoài hệ thống)
    expect([...impact.diagrams].sort()).toEqual(["context", "usecase"])
  })

  it("field không ánh xạ section nào (progress) trả rỗng", () => {
    const impact = impactOf(FIXTURE, ["progress.screen_cursor"])
    expect(impact.sections).toEqual([])
    expect(impact.diagrams).toEqual([])
  })

  it("nhiều path gộp lại, quan hệ mạnh nhất thắng", () => {
    const impact = impactOf(FIXTURE, ["actors[id=A01].name", "use_cases[id=UC02].name"])
    // fixed:2.2.2 vừa "đọc" actors vừa "sở hữu" use_cases ⇒ owner thắng
    expect(impact.sections.find((s) => s.id === "fixed:2.2.2")?.relation).toBe("owner")
    expect(impact.fields).toEqual(["actors[id=A01].name", "use_cases[id=UC02].name"])
  })
})

describe("referrersOf — khoá đang trỏ tới phần tử bị đụng", () => {
  it("actor A01 được use case và role trỏ tới", () => {
    const referrers = referrersOf(FIXTURE, new Set(["A01"]))
    expect(referrers.some((r) => r.path === "use_cases[id=UC02].actor_ids[=A01]")).toBe(true)
    expect(referrers.some((r) => r.path === "roles[id=R1].actor_id")).toBe(true)
    expect(referrers.every((r) => r.id === "A01")).toBe(true)
  })

  it("id không ai trỏ tới trả rỗng", () => {
    expect(referrersOf(FIXTURE, new Set(["KHONG-CO"]))).toEqual([])
  })
})

describe("diagramsToRerender — so source_hash trước/sau", () => {
  it("đổi tên actor human: chỉ usecase vẽ lại, context giữ nguyên", () => {
    const after = structuredClone(FIXTURE)
    after.actors[0].name = "Product Owner"
    expect(diagramsToRerender(FIXTURE, after)).toEqual(["usecase"])
  })

  it("đổi mô tả actor: không hình nào vẽ lại (mô tả không lên hình)", () => {
    const after = structuredClone(FIXTURE)
    after.actors[0].description = "Khác hẳn mô tả cũ"
    expect(diagramsToRerender(FIXTURE, after)).toEqual([])
  })

  it("đổi tên actor system: context và usecase cùng vẽ lại", () => {
    const after = structuredClone(FIXTURE)
    const a06 = after.actors.find((a) => a.id === "A06")!
    a06.name = "AI Model Provider"
    expect([...diagramsToRerender(FIXTURE, after)].sort()).toEqual(["context", "usecase"])
  })
})

describe("impactOfChanges", () => {
  it("dùng before/value làm hint nên tra được phần tử đã bị xoá", () => {
    const removed = FIXTURE.actors.find((a) => a.id === "A06")!
    const after = structuredClone(FIXTURE)
    after.actors = after.actors.filter((a) => a.id !== "A06")

    const impact = impactOfChanges(
      FIXTURE,
      [{ path: "actors[id=A06]", before: removed, value: { _absent: true, index: 5 } }],
      after
    )

    // Không còn trong Spine "sau" nhưng hint giữ được kind=system ⇒ vẫn ra fixed:1
    expect(ids(impact, "owner")).toEqual(["fixed:1", "fixed:2.1"])
    expect([...impact.diagrams].sort()).toEqual(["context", "usecase"])
    expect(impact.referrers.every((r) => r.id === "A06")).toBe(true)
  })
})
