import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Change, Spine } from "../spine/spine.types.js"
import { editedSections, sectionKeyResolver, TEMPLATE_MIGRATION_TXN_PREFIX } from "./edited-since.js"
import type { Follower, OldHeading } from "./pair-sections.js"

const APPLIED = new Date("2026-11-10T10:00:00.000Z")

const spine = (): Spine => {
  const s = createEmptySpine({ name: "Lumen" })
  s.custom_sections.push({ id: "c1", heading: "Team Notes", level: 2, blocks: [], source: "import" })
  s.use_cases.push({ id: "UC01", name: "Register", actor_ids: [], function_ids: [], description: "", includes: [], extends: [] })
  return s
}

let seq = 0
const change = (path: string, at: string, value: unknown = "x", txn = `t${seq}`): Change => ({ projectId: "p1", seq: ++seq, txn, op: "set", path, before: null, value, reason: null, at, by: "u1", step_id: null })

const old: OldHeading[] = [
  { key: "fixed:1", heading_text: "1 Overview", level: 1, section_id: "fixed:1" },
  { key: "custom:c1", heading_text: "Team Notes", level: 2, section_id: "custom:c1" }
]
const followers: Follower[] = []
const resolve = sectionKeyResolver(old, followers)

describe("editedSections", () => {
  it("chỉ tính Change ghi sau applied_at, gom theo mục, đếm ký tự theo giá trị cuối của mỗi path", () => {
    const r = editedSections(
      [
        change("custom_sections[id=c1].heading", "2026-11-10T09:00:00.000Z", "trước mốc"),
        change("custom_sections[id=c1].heading", "2026-11-11T08:00:00.000Z", "abc"),
        change("custom_sections[id=c1].heading", "2026-11-12T08:00:00.000Z", "abcdef"),
        change("project.vision", "2026-11-11T09:00:00.000Z", "twelve chars")
      ],
      spine(),
      APPLIED,
      resolve
    )
    expect(r.unattributed).toBe(0)
    expect(r.sections).toEqual([
      { key: "custom:c1", changes: 2, last_at: "2026-11-12T08:00:00.000Z", chars: 6 },
      { key: "fixed:1", changes: 1, last_at: "2026-11-11T09:00:00.000Z", chars: 12 }
    ])
  })

  it("Change do chính lần đổi mẫu ghi và Change không thuộc section nào bị bỏ", () => {
    const r = editedSections(
      [change("custom_sections[id=c1].heading", "2026-11-11T08:00:00.000Z", "x", `${TEMPLATE_MIGRATION_TXN_PREFIX}abc`), change("flags[id=F1].status", "2026-11-11T08:00:00.000Z"), change("progress.percent", "2026-11-11T08:00:00.000Z")],
      spine(),
      APPLIED,
      resolve
    )
    expect(r).toEqual({ sections: [], unattributed: 0 })
  })

  it("phần tử tính cho mục khung cha; section không gắn được vào mục nào thì đếm vào unattributed", () => {
    const owners = sectionKeyResolver(
      [{ key: "fixed:2.2.2", heading_text: "2.2.2 UC", level: 3, section_id: "fixed:2.2.2" }],
      [{ old_key: "function:FN01", kind: "element", parent_old_key: "fixed:2.2.2" }]
    )
    expect(owners("fixed:2.2.2")).toBe("fixed:2.2.2")
    expect(owners("function:FN01")).toBe("fixed:2.2.2")
    expect(owners("fixed:9.9")).toBeNull()

    const s = spine()
    const edit = change("use_cases[id=UC01].name", "2026-11-11T08:00:00.000Z", "Sign up")
    expect(editedSections([edit], s, APPLIED, owners).sections).toMatchObject([{ key: "fixed:2.2.2", changes: 1, chars: 7 }])
    expect(editedSections([edit], s, APPLIED, () => null)).toEqual({ sections: [], unattributed: 1 })
  })
})
