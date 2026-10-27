import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "../../spine/spine.schema.js"
import type { Spine } from "../../spine/spine.types.js"
import { FIXED_SECTION_ID_LIST } from "../../spine/section-registry.js"
import { DIAGRAM_KINDS, allTargets, renderKind } from "./index.js"

/**
 * Bảng Kinds trong `action/plantuml-conventions` là hợp đồng chung cho mọi renderer.
 * Test này giữ bảng và code khớp nhau: kind nào đang có renderer thì phải có dòng trong bảng,
 * và section mà renderer gắn cho sơ đồ phải đúng cột `SRS section`. Kind chỉ có trong bảng
 * (chưa có renderer) là đích của ticket ghi ở cột Ticket — ticket đó thêm renderer và test ký pháp.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "../../../..")
const SKILL = fs.readFileSync(path.join(ROOT, "assets/skills/action/plantuml-conventions/SKILL.md"), "utf8")
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures/spine-fixture-19-screens.json"), "utf8")))

interface KindRow { section: string; kind: string; owner_kind: string; path: string }

/** Đọc bảng dưới `## Kinds`; bỏ dấu `\|` (ký tự `|` trong ô) trước khi tách cột. */
const kindRows = (md: string): KindRow[] => {
  const block = md.split(/^## Kinds$/m)[1]!.split(/^## /m)[0]!
  const lines = block.split("\n").filter((l) => l.startsWith("|")).slice(2)
  return lines.map((l) => {
    const cells = l.replace(/\\\|/g, "/").split("|").slice(1, -1).map((c) => c.trim().replace(/`/g, ""))
    return { section: cells[0]!, kind: cells[2]!, owner_kind: cells[3]!, path: cells[5]! }
  })
}

/** `function:<primary_function_id>` ⇒ /^function:[^:]+$/ — phần `<…>` là id bất kỳ. */
const sectionPattern = (section: string): RegExp =>
  new RegExp(`^${section.split(/<[^>]+>/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^:]+")}$`)

const ROWS = kindRows(SKILL)
const rowOf = (kind: string): KindRow | undefined => ROWS.find((r) => r.kind === kind)

describe("plantuml-conventions — bảng Kinds khớp renderer", () => {
  it("đủ 8 kind, không trùng; owner_kind và path thuộc tập đã chốt", () => {
    expect(ROWS.map((r) => r.kind)).toEqual(["context", "usecase", "screen_flow", "erd", "class", "sequence", "state_machine", "screen_layout"])
    for (const r of ROWS) {
      expect(r.owner_kind, r.kind).toMatch(/^(null|feature|function|entity|screen)\b/)
      expect(["puml", "svg"], r.kind).toContain(r.path)
    }
  })

  it("section cố định trong bảng có trong section-registry", () => {
    for (const r of ROWS.filter((x) => x.section.startsWith("fixed:"))) expect(FIXED_SECTION_ID_LIST, r.kind).toContain(r.section)
    for (const r of ROWS.filter((x) => !x.section.startsWith("fixed:"))) expect(r.section, r.kind).toMatch(/^(feature|function):<\w+>$/)
  })

  it("mọi kind đang có renderer đều có dòng trong bảng", () => {
    for (const kind of DIAGRAM_KINDS) expect(rowOf(kind), kind).toBeDefined()
  })

  it("section renderer gắn cho từng sơ đồ đúng cột SRS section (fixture 19 màn)", () => {
    const targets = allTargets(FIXTURE)
    expect(targets.length).toBeGreaterThan(0)
    for (const t of targets) {
      for (const part of renderKind(FIXTURE, t.kind, t.owner_id)) {
        expect(part.section, `${t.kind}:${t.owner_id}`).toMatch(sectionPattern(rowOf(t.kind)!.section))
      }
    }
  })
})
