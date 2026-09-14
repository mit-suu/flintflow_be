import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "./spine.schema.js"
import type { Spine } from "./spine.types.js"
import {
  DERIVED_SECTION_IDS,
  FIELD_SECTION_MAP,
  FIXED_SECTIONS,
  REQUIRED_FIXED_SECTION_IDS,
  listSections,
  sectionsOfPath,
  stepsOf
} from "./section-registry.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

describe("section registry", () => {
  it("20 section cố định, 18 bắt buộc, 2 dẫn xuất (fixed:I, fixed:5.5)", () => {
    expect(FIXED_SECTIONS).toHaveLength(20)
    expect(REQUIRED_FIXED_SECTION_IDS).toHaveLength(18)
    expect(REQUIRED_FIXED_SECTION_IDS).not.toContain("fixed:4.2.4")
    expect([...DERIVED_SECTION_IDS].sort()).toEqual(["fixed:5.5", "fixed:I"])
  })

  it("bảng field → section có đúng 34 dòng như srs-spine.md §4, key không trùng", () => {
    expect(FIELD_SECTION_MAP).toHaveLength(34)
    expect(new Set(FIELD_SECTION_MAP.map((r) => r.key)).size).toBe(34)
  })

  it("listSections trên fixture: 20 cố định + 6 feature + 89 function, feature/function nằm giữa 3.1.5 và 4.1", () => {
    const ids = listSections(FIXTURE).map((s) => s.id)
    expect(ids).toHaveLength(20 + 6 + 89)
    expect(ids.indexOf("feature:F1")).toBe(ids.indexOf("fixed:3.1.5") + 1)
    expect(ids.indexOf("fixed:4.1")).toBe(ids.length - 10)
    // non-screen function đứng sau function có màn trong cùng feature
    expect(ids.indexOf("function:FN084")).toBeGreaterThan(ids.indexOf("function:FN048"))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("mọi section bắt buộc đều có step sở hữu", () => {
    for (const s of listSections(FIXTURE)) expect(stepsOf(s.id, FIXTURE).length, s.id).toBeGreaterThan(0)
    expect(stepsOf("fixed:2.2.2")).toEqual(["S-3.2", "S-3.3", "S-3.4", "S-3.5"])
    expect(stepsOf("function:FN001", FIXTURE)).toEqual(["S-5.2@S01", "S-5.4@S01"])
    expect(stepsOf("function:FN084", FIXTURE)).toEqual(["S-5.2@nonscreen", "S-5.4@nonscreen"])
    expect(stepsOf("feature:F3")).toEqual(["S-4.1"])
  })
})

describe("sectionsOfPath", () => {
  it("đổi tên actor human: sở hữu 2.1, đọc 2.2.2 + 3.1.3, suy dẫn hình usecase + glossary", () => {
    const human = FIXTURE.actors.find((a) => a.kind === "human")!
    expect(sectionsOfPath(FIXTURE, `actors[id=${human.id}].name`)).toEqual({
      owner: ["fixed:2.1"],
      reads: ["fixed:2.2.2", "fixed:3.1.3"],
      derived: ["fixed:2.2.1", "fixed:5.5"]
    })
  })

  it("actor hệ thống thêm §1 và hình context", () => {
    const system = FIXTURE.actors.find((a) => a.kind === "system")!
    const impact = sectionsOfPath(FIXTURE, `actors[id=${system.id}].name`)
    expect(impact.owner).toEqual(["fixed:1", "fixed:2.1"])
    expect(impact.derived).toContain("fixed:1")
  })

  it("function, validation, abnormal, order", () => {
    expect(sectionsOfPath(FIXTURE, "functions[id=FN001].name")).toEqual({ owner: ["function:FN001"], reads: ["fixed:3.1.2", "fixed:2.2.2"], derived: [] })
    expect(sectionsOfPath(FIXTURE, "functions[id=FN084].name").reads).toContain("fixed:3.1.4")
    expect(sectionsOfPath(FIXTURE, "functions[id=FN001].validations[id=FN001-V1].statement").derived).toEqual(["fixed:5.1"])
    expect(sectionsOfPath(FIXTURE, "functions[id=FN001].abnormal").derived).toEqual(["fixed:5.3"])
    expect(sectionsOfPath(FIXTURE, "functions[id=FN001].order")).toEqual({ owner: [], reads: [], derived: [] })
  })

  it("màn: tên đọc ra function của màn; primary_function_id suy dẫn wireframe của đúng màn", () => {
    const impact = sectionsOfPath(FIXTURE, "screens[id=S07].name")
    expect(impact.owner).toEqual(["fixed:3.1.2"])
    expect(impact.reads).toEqual(expect.arrayContaining(["fixed:3.1.1", "fixed:3.1.3", "function:FN028"]))
    expect(sectionsOfPath(FIXTURE, "screens[id=S07].primary_function_id").derived).toEqual(["function:FN028"])
    expect(sectionsOfPath(FIXTURE, "screens[id=S01].primary_function_id").derived).toEqual([])
    expect(sectionsOfPath(FIXTURE, "screens[id=S07].detail_status")).toEqual({ owner: [], reads: [], derived: [] })
  })

  it("phần tử đã bị xoá dùng before của change; path nội bộ không ra section", () => {
    const removed = { id: "N99", category: "performance", statement: "x", kind: "quantitative", priority: null }
    expect(sectionsOfPath(FIXTURE, "nfrs[id=N99]", { before: removed, value: { _absent: true, index: 3 } }).owner).toEqual(["fixed:4.2.3"])
    for (const p of ["progress.screen_cursor", "steps[id=S-3.1].status", "flags[id=FL001].resolved_at", "addendum[id=AD01].content", "project.working_mode"]) {
      expect(sectionsOfPath(FIXTURE, p), p).toEqual({ owner: [], reads: [], derived: [] })
    }
    expect(sectionsOfPath(FIXTURE, "$").owner).toHaveLength(115)
  })
})
