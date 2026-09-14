import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "./spine.schema.js"
import {
  FIXED_SECTION_IDS,
  REFERENCE_FIELDS,
  buildIdIndex,
  findDeadReferences,
  iterateReferences,
  sectionKeyExists
} from "./reference-fields.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const load = (file: string) =>
  spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures", file), "utf8")))

const FIXTURE = load("spine-fixture-19-screens.json")

describe("REFERENCE_FIELDS", () => {
  it("đủ 24 field của srs-spine.md §4.1, không trùng", () => {
    expect(REFERENCE_FIELDS).toHaveLength(24)
    expect(new Set(REFERENCE_FIELDS.map((f) => f.path)).size).toBe(24)
  })

  it("mọi field đều được iterate trên fixture đầy đủ (trừ flags rỗng)", () => {
    const seen = new Set([...iterateReferences(FIXTURE)].map((h) => h.field.path))
    const expected = REFERENCE_FIELDS.map((f) => f.path).filter((p) => p !== "flags[].section_id")
    for (const p of expected) {
      if (p === "progress.screen_queue[]") continue // fixture ở S-9, queue rỗng
      expect(seen.has(p), p).toBe(true)
    }
  })
})

describe("iterateReferences / findDeadReferences", () => {
  it("fixture 19 màn và fixture minimal không có khoá chết", () => {
    expect(findDeadReferences(FIXTURE)).toEqual([])
    expect(findDeadReferences(load("spine-fixture-minimal.json"))).toEqual([])
  })

  it("refPath concrete theo khoá", () => {
    const paths = [...iterateReferences(FIXTURE)].map((h) => h.refPath)
    expect(paths).toContain("use_cases[id=UC01].actor_ids[=A08]")
    expect(paths).toContain("screens[id=S01].feature_id")
    expect(paths).toContain("sections[id=function:FN034]")
    expect(paths).toContain("progress.screen_cursor")
    expect(paths.some((p) => /^steps\[id=S-5\.\d@S07\]$/.test(p))).toBe(true)
  })

  it("xoá actor A08 thẳng tay (không qua engine) ⇒ khoá chết ở UC01, UC03", () => {
    const broken = structuredClone(FIXTURE)
    broken.actors = broken.actors.filter((a) => a.id !== "A08")
    expect(findDeadReferences(broken).map((h) => h.refPath).sort()).toEqual([
      "use_cases[id=UC01].actor_ids[=A08]",
      "use_cases[id=UC03].actor_ids[=A08]"
    ])
  })

  it("assumptions[].path chết khi phần tử đích không còn", () => {
    const broken = structuredClone(FIXTURE)
    broken.nfrs = broken.nfrs.filter((n) => n.id !== "N05")
    expect(findDeadReferences(broken).map((h) => h.refPath)).toContain("assumptions[id=AS01].path")
  })

  it("steps @nonscreen không phải khoá màn", () => {
    const hits = [...iterateReferences(FIXTURE)].filter((h) => h.field.path === "steps[].id")
    expect(hits.some((h) => h.targetId === "nonscreen")).toBe(false)
  })
})

describe("sectionKeyExists", () => {
  it("fixed thuộc template; feature/function theo dữ liệu", () => {
    const index = buildIdIndex(FIXTURE)
    expect(FIXED_SECTION_IDS).toHaveLength(20)
    expect(sectionKeyExists(index, "fixed:4.2.4")).toBe(true)
    expect(sectionKeyExists(index, "fixed:9.9")).toBe(false)
    expect(sectionKeyExists(index, "feature:F1")).toBe(true)
    expect(sectionKeyExists(index, "function:FN999")).toBe(false)
    expect(sectionKeyExists(index, "bogus")).toBe(false)
  })
})
