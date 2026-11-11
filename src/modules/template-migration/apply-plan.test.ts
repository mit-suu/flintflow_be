import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Change, Spine } from "../spine/spine.types.js"
import { addCustomOps, choiceOf, customIdAllocator, deleteOps, isMigrationTxn, migrationTxn, selectReverseChanges, withSnapshotContinuations } from "./apply-plan.js"
import type { PlannedLayoutEntry } from "./build-base-file.js"
import type { MigrationGroups } from "./classify.js"
import type { Follower, OldHeading } from "./pair-sections.js"

const spine = (): Spine => {
  const s = createEmptySpine({ name: "Lumen" })
  s.custom_sections.push({ id: "CS01", heading: "Legacy", level: 2, blocks: [], source: "import" }, { id: "CS02", heading: "", level: 3, blocks: [], source: "import" }, { id: "CS03", heading: "Keep me", level: 2, blocks: [], source: "import" })
  return s
}

const groups = (extra: MigrationGroups["extra"], edited: MigrationGroups["edited_since"] = []): MigrationGroups => ({ matched: [], missing: [], extra, conflict: [], edited_since: edited, structure_only_dropped: [], restored_from_snapshot: null })
const extraItem = (old_key: string, follower_keys: string[] = []): MigrationGroups["extra"][number] => ({ id: `e:${old_key}`, old_key, heading_text: old_key, section_id: old_key, follower_keys, choices: ["keep_custom", "delete"], ai_choices: [], decision_required: true })
const editedItem = (old_key: string): MigrationGroups["edited_since"][number] => ({ id: `s:${old_key}`, old_key, heading_text: old_key, changes: 1, last_at: "", chars: 1, choices: ["keep", "discard"], default: "keep" })

const old: OldHeading[] = [
  { key: "fixed:1", heading_text: "1 Overview", level: 1, section_id: "fixed:1" },
  { key: "custom:CS01", heading_text: "Legacy", level: 2, section_id: "custom:CS01" },
  { key: "custom:CS02", heading_text: "", level: 3, section_id: "custom:CS02" },
  { key: "custom:CS03", heading_text: "Keep me", level: 2, section_id: "custom:CS03" }
]

describe("txn của lần đổi mẫu", () => {
  it("nhận ra đúng lô của lần đổi mẫu, kể cả lô đảo / hoàn tác, không nhầm id khác", () => {
    expect(migrationTxn("abc")).toBe("template-migration:abc")
    expect(migrationTxn("abc", "revert")).toBe("template-migration:abc:revert")
    for (const t of ["template-migration:abc", "template-migration:abc:revert", "template-migration:abc:undo"]) expect(isMigrationTxn(t, "abc")).toBe(true)
    for (const t of ["template-migration:abcd", "template-migration:xyz", "cr-1"]) expect(isMigrationTxn(t, "abc")).toBe(false)
  })
})

describe("deleteOps / addCustomOps", () => {
  it("chỉ mục riêng (custom:*) chọn delete bị xoá khỏi Spine, kèm phần nối; mục khung giữ dữ liệu; mục đã mất không xoá lại", () => {
    const doc = { groups: groups([extraItem("custom:CS01", ["custom:CS02"]), extraItem("fixed:1")]), decisions: [{ id: "e:custom:CS01", choice: "delete" }, { id: "e:fixed:1", choice: "drop_from_print" }] }
    expect(deleteOps(doc, old, spine()).map((o) => o.path)).toEqual(["custom_sections[id=CS01]", "custom_sections[id=CS02]"])
    const gone = spine()
    gone.custom_sections = gone.custom_sections.filter((c) => c.id !== "CS01")
    expect(deleteOps(doc, old, gone).map((o) => o.path)).toEqual(["custom_sections[id=CS02]"])
    expect(deleteOps({ ...doc, decisions: [{ id: "e:custom:CS01", choice: "keep_custom" }] }, old, spine())).toEqual([])
  })

  it("xoá heading nhóm có phần tử đi theo: không xoá phần nối của phần tử (mục rỗng \"—\" sau đổi ngược — test tay 11/11)", () => {
    const tree: OldHeading[] = [
      { key: "custom:CS10", heading_text: "II. Software Requirement Specification", level: 1, section_id: "custom:CS10" },
      { key: "custom:CS11", heading_text: "", level: 1, section_id: "custom:CS11" },
      { key: "feature:F1", heading_text: "3.2 Authentication", level: 2, section_id: "feature:F1" },
      { key: "function:FN1", heading_text: "3.2.1 Log in", level: 3, section_id: "function:FN1" },
      { key: "custom:CS12", heading_text: "", level: 3, section_id: "custom:CS12" }
    ]
    const state = { custom_sections: ["CS10", "CS11", "CS12"].map((id) => ({ id, heading: "", level: 1, blocks: [], source: "manual" as const })) } as unknown as Spine
    const doc = { groups: groups([extraItem("custom:CS10", ["custom:CS11", "feature:F1", "function:FN1", "custom:CS12"])]), decisions: [{ id: "e:custom:CS10", choice: "delete" }] }
    expect(deleteOps(doc, tree, state).map((o) => o.path)).toEqual(["custom_sections[id=CS10]", "custom_sections[id=CS11]"])
  })

  it("cấp id CS kế tiếp và dựng op thêm mục riêng trống", () => {
    const next = customIdAllocator(spine())
    expect([next(), next()]).toEqual(["CS04", "CS05"])
    expect(addCustomOps([{ section_id: "custom:CS04", heading_text: "Môi trường", level: 12 }])).toEqual([
      expect.objectContaining({ op: "add", path: "custom_sections[]", value: { id: "CS04", heading: "Môi trường", level: 9, blocks: [], source: "manual" } })
    ])
  })
})

describe("selectReverseChanges", () => {
  const PRIOR = "p1"
  const APPLIED = new Date("2026-11-10T10:00:00.000Z")
  let seq = 0
  const ch = (path: string, txn: string, at: string): Change => ({ projectId: "x", seq: ++seq, txn, op: "set", path, before: "a", value: "b", reason: null, at, by: "u", step_id: null })
  const followers: Follower[] = []

  it("đảo Change của đổi mẫu trước + sửa của mục discard; giữ mục keep; bỏ Change trước mốc; cờ tính lại sau đổi mẫu đảo cùng", () => {
    seq = 0
    const migOwn = ch("custom_sections[id=CS01].heading", migrationTxn(PRIOR), "2026-11-10T09:59:00.000Z")
    const migKept = ch("custom_sections[id=CS03].heading", migrationTxn(PRIOR), "2026-11-10T09:59:00.000Z")
    const flag = ch("flags[id=FL1].section_id", "t-flag", "2026-11-10T10:00:01.000Z")
    const userDiscard = ch("custom_sections[id=CS01].heading", "t1", "2026-11-11T08:00:00.000Z")
    const userKeep = ch("custom_sections[id=CS03].heading", "t2", "2026-11-11T08:00:00.000Z")
    const earlier = ch("project.vision", "t0", "2026-11-09T08:00:00.000Z")
    const doc = { groups: groups([], [editedItem("custom:CS01"), editedItem("custom:CS03")]), decisions: [{ id: "s:custom:CS01", choice: "discard" }] }
    const out = selectReverseChanges({ doc, priorId: PRIOR, priorAppliedAt: APPLIED, oldHeadings: old, followers, spine: spine(), changes: [earlier, migOwn, migKept, flag, userDiscard, userKeep] })
    expect(out.keepKeys).toEqual(new Set(["custom:CS03"]))
    const picked = out.changes.map((c) => c.seq)
    expect(picked).toEqual(expect.arrayContaining([migOwn.seq, flag.seq, userDiscard.seq]))
    expect(picked).not.toContain(migKept.seq)
    expect(picked).not.toContain(userKeep.seq)
    expect(picked).not.toContain(earlier.seq)
  })

  it("choiceOf lấy mặc định của nhóm khi chưa có quyết định", () => {
    const d = { groups: groups([], [editedItem("x")]), decisions: [] }
    expect(choiceOf(d, "s:x")).toBe("keep")
    expect(choiceOf(d, "nope")).toBeNull()
  })
})

describe("withSnapshotContinuations", () => {
  it("đặt lại phần nối (heading rỗng) ngay sau mục đứng trước nó trong layout cũ", () => {
    const entry = (section_id: string, heading_text: string): PlannedLayoutEntry => ({ heading_text, level: 1, section_id, kind: "target", new_key: null, old_key: null, missing: false, guidance: null })
    const out = withSnapshotContinuations([entry("fixed:1", "1 Overview"), entry("custom:CS01", "Legacy"), entry("custom:CS03", "Keep me")], old)
    expect(out.map((e) => `${e.section_id}|${e.heading_text}`)).toEqual(["fixed:1|1 Overview", "custom:CS01|Legacy", "custom:CS02|", "custom:CS03|Keep me"])
  })
})
