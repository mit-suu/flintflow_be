/**
 * Hoàn tác CR = CR mới: nghịch đảo Change của CR gốc (hàm thuần), nhận diện "hoàn tác CR-xxx", vị trí đoạn nguyên văn.
 * Vòng ghi → hoàn tác trên DB ở `test/integration/mode1/cr-flow-rules.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { planTransaction } from "../spine/op-engine.js"
import type { Op } from "../spine/op.types.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { buildRevertLocations, parseRevertIntent, type SourceChange } from "./revert-cr.service.js"
import { originalPassageLocations, withOriginalPassages } from "./spine-location.js"
import { previewAfter } from "./propose.service.js"

const base = (): Spine => {
  const s = createEmptySpine({ name: "Lumen" })
  s.actors.push(
    { id: "A01", name: "Learner", kind: "human", description: "Learns.", flows_in: [], flows_out: [] } as never,
    { id: "A02", name: "Admin", kind: "human", description: "Runs it.", flows_in: [], flows_out: [] } as never,
    { id: "A03", name: "Guest", kind: "human", description: "Browses.", flows_in: [], flows_out: [] } as never
  )
  return s
}

/** Áp lô như lúc CR ghi, trả Spine mới + Change (before / value dạng ABSENT như DB). */
const write = (spine: Spine, ops: Op[]): { spine: Spine; changes: SourceChange[] } => {
  const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "CR-014" }, { startSeq: 1 })
  return { spine: plan.spine, changes: plan.changes.map((c) => ({ seq: c.seq, op: c.op, path: c.path, before: c.before, value: c.value })) }
}

const applyLocations = (spine: Spine, locations: ReturnType<typeof buildRevertLocations>["locations"]): Spine =>
  planTransaction(spine, { base_version: spine.spine_version, ops: locations.flatMap((l) => l.proposal.spine_ops) as Op[], by: "CR-015" }, { startSeq: 1 }).spine

const content = (s: Spine) => JSON.stringify({ actors: s.actors })

describe("parseRevertIntent", () => {
  it("nhận 'hoàn tác CR-014' và các cách viết gần", () => {
    expect(parseRevertIntent("hoàn tác CR-014")).toBe("CR-014")
    expect(parseRevertIntent("Hoàn tác lại cr 14 giúp mình")).toBe("CR-014")
    expect(parseRevertIntent("revert CR-007")).toBe("CR-007")
    expect(parseRevertIntent("undo CR-120")).toBe("CR-120")
  })

  it("câu không có ý hoàn tác hoặc không có mã CR ⇒ null", () => {
    expect(parseRevertIntent("đổi tên actor Learner thành Student")).toBeNull()
    expect(parseRevertIntent("hoàn tác thay đổi vừa rồi")).toBeNull()
    expect(parseRevertIntent("CR-014 làm gì")).toBeNull()
  })
})

describe("buildRevertLocations - nghịch đảo Change của CR gốc", () => {
  it("sửa field: hoàn tác đưa nội dung về như trước", () => {
    const s0 = base()
    const done = write(s0, [{ op: "set", path: "actors[id=A01].name", value: "Student" }, { op: "set", path: "actors[id=A01].description", value: "Studies." }])
    const { locations, skipped } = buildRevertLocations(done.spine, "CR-014", done.changes)
    expect(skipped).toEqual([])
    expect(locations).toHaveLength(1)
    expect(locations[0]).toMatchObject({ path: "actors[id=A01]", reason: "Hoàn tác CR-014" })
    // chưa ai sửa tiếp ⇒ nội dung hiện tại khớp lúc CR vừa ghi (old_text = hiện tại)
    expect(locations[0].proposal.old_text).toContain("Student")
    expect(content(applyLocations(done.spine, locations))).toBe(content(s0))
  })

  it("thêm phần tử ⇒ xoá; xoá phần tử ⇒ thêm lại nguyên bản vào ô thêm mới; hoàn tác ra đúng nội dung cũ", () => {
    const s0 = base()
    const done = write(s0, [{ op: "add", path: "actors[]", value: { id: "A04", name: "Tutor", kind: "human", description: "Helps.", flows_in: [], flows_out: [] } }, { op: "remove", path: "actors[id=A03]" }])
    const { locations } = buildRevertLocations(done.spine, "CR-014", done.changes)
    expect(locations.map((l) => l.path).sort()).toEqual(["actors[]", "actors[id=A04]"])
    expect(locations[0].path).toBe("actors[]")
    const back = applyLocations(done.spine, locations)
    expect([...back.actors.map((a) => a.id)].sort()).toEqual(["A01", "A02", "A03"])
    expect(back.actors.find((a) => a.id === "A03")).toEqual(s0.actors.find((a) => a.id === "A03"))
  })

  it("phần tử đã bị xoá về sau ⇒ bỏ qua và báo; người khác sửa tiếp field CR đã đổi ⇒ old_text lệch hiện tại (để kiểm xử lý xung đột)", () => {
    const s0 = base()
    const done = write(s0, [{ op: "set", path: "actors[id=A01].name", value: "Student" }, { op: "set", path: "actors[id=A02].name", value: "Owner" }])
    const later = write(done.spine, [{ op: "set", path: "actors[id=A01].name", value: "Pupil" }, { op: "remove", path: "actors[id=A02]" }])
    const { locations, skipped } = buildRevertLocations(later.spine, "CR-014", done.changes)
    expect(skipped).toEqual(["actors[id=A02]"])
    expect(locations).toHaveLength(1)
    const current = previewAfter(later.spine, "actors[id=A01]", [])
    expect(locations[0].proposal.old_text).toContain("Student")
    expect(locations[0].proposal.old_text).not.toBe(current)
  })

  it("Change không phải phần tử Spine (revert, diagrams…) bị bỏ", () => {
    const { locations } = buildRevertLocations(base(), "CR-014", [
      { seq: 1, op: "revert", path: "actors[id=A01].name", before: "x", value: "y" },
      { seq: 2, op: "set", path: "diagrams[id=D1].puml", before: "x", value: "y" }
    ])
    expect(locations).toEqual([])
  })
})

describe("C-3 đoạn nguyên văn (originalPassageLocations)", () => {
  const spine = (): Spine => {
    const s = base()
    s.custom_sections.push({ id: "CS01", heading: "Overview", level: 2, source: "import", blocks: [{ kind: "paragraph", text: "The Learner studies.", rows: null, image_ref: null }] } as never)
    return s
  }
  const records = [
    {
      section_id: "fixed:1",
      known: [],
      parts: [
        { kind: "heading", text: "Overview", level: 2 },
        { kind: "original", custom_id: "CS01", diagrams: [], mentions: [{ path: "actors[id=A01]", array: "actors", id: "A01", name: "Learner" }] },
        { kind: "original", custom_id: "CS99", diagrams: [], mentions: [{ path: "actors[id=A01]", array: "actors", id: "A01", name: "Learner" }] }
      ]
    }
  ] as never

  it("CR đụng actor mà đoạn nguyên văn nhắc ⇒ đoạn đó là vị trí 'sửa chữ'; mục riêng không còn trong Spine thì bỏ", () => {
    const found = originalPassageLocations(spine(), records, [{ path: "actors[id=A01]" }])
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ path: "custom_sections[id=CS01]", found_by: ["mention"], entity_paths: ["actors[id=A01]"] })
  })

  it("CR không đụng phần tử được nhắc ⇒ không thêm; đã là vị trí ⇒ chỉ nối phần tử gây ra", () => {
    expect(originalPassageLocations(spine(), records, [{ path: "actors[id=A02]" }])).toEqual([])
    const base0 = [
      { path: "actors[id=A01]", section_id: "fixed:2.1", found_by: ["spine_link" as const], entity_paths: [], owner_step: null },
      { path: "custom_sections[id=CS01]", section_id: "custom:CS01", found_by: ["keyword" as const], entity_paths: [], owner_step: null }
    ]
    const merged = withOriginalPassages(spine(), records, base0)
    expect(merged).toHaveLength(2)
    expect(merged[1]).toMatchObject({ found_by: ["keyword", "mention"], entity_paths: ["actors[id=A01]"] })
  })
})
