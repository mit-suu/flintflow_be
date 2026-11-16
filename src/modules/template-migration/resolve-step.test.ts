import { describe, expect, it, vi } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { MigrationGroups } from "./classify.js"
import { resolveAiChoices, safeConflictChoice, type ResolveExecutor } from "./resolve-step.js"
import type { ITemplateMigration } from "./template-migration.model.js"

const spine = (): Spine => {
  const s = createEmptySpine({ name: "Lumen" })
  s.custom_sections.push({ id: "CS01", heading: "Legacy Gateway", level: 2, blocks: [{ kind: "paragraph", text: "Nightly batch to the legacy gateway.", rows: null, image_ref: null }], source: "import" })
  return s
}

const groups: MigrationGroups = {
  matched: [],
  missing: [],
  extra: [
    { id: "e:custom:CS01", old_key: "custom:CS01", heading_text: "Legacy Gateway", section_id: "custom:CS01", follower_keys: [], choices: ["keep_custom", "delete", "move_to:n7", "move_to:n9"], ai_choices: ["move_to:n7", "move_to:n9"], decision_required: true },
    // Mục khung chuyển chỗ in: không cần AI
    { id: "e:fixed:2.1", old_key: "fixed:2.1", heading_text: "2.1 Actors", section_id: "fixed:2.1", follower_keys: [], choices: ["keep_custom", "drop_from_print", "move_to:n7"], ai_choices: ["move_to:n7"], decision_required: true }
  ],
  conflict: [{ id: "c:table_columns:fixed:5.1", kind: "table_columns", old_key: "fixed:5.1", new_key: "n9", candidate_keys: [], old_columns: [["a", "b"]], new_columns: [["a", "c"]], choices: ["map_by_header", "keep_old_table", "ai_resolve"], ai_choices: ["ai_resolve"], decision_required: true }],
  edited_since: [],
  structure_only_dropped: [],
  restored_from_snapshot: null
}

const doc = (decisions: { id: string; choice: string }[], resolved: ITemplateMigration["resolved_items"] = []): ITemplateMigration =>
  ({
    groups,
    decisions,
    resolved_items: resolved,
    from: { headings: [{ key: "custom:CS01", heading_text: "Legacy Gateway", level: 2, section_id: "custom:CS01" }, { key: "fixed:2.1", heading_text: "2.1 Actors", level: 2, section_id: "fixed:2.1" }, { key: "fixed:5.1", heading_text: "5.1", level: 2, section_id: "fixed:5.1" }] },
    to: { headings: [{ key: "n7", heading_text: "7 Other Requirements", section_id: "fixed:5.4" }, { key: "n9", heading_text: "9 Rules", section_id: "fixed:5.1" }] }
  }) as unknown as ITemplateMigration

const ok = (data: object): Awaited<ReturnType<ResolveExecutor>> => ({ data, cost: 3 }) as never
const base = { projectId: "p1", userId: "u1", spine: spine() }

describe("resolveAiChoices", () => {
  const moveDecision = { id: "e:custom:CS01", choice: "move_to:n7" }

  it("move_to vào mục có cấu trúc: AI sinh op add hợp lệ ⇒ giữ move_to, xoá mục riêng cũ; chỉ lượt cho mục riêng chữ tự do", async () => {
    const executor = vi.fn<ResolveExecutor>(async () => ok({ ops: [{ op: "add", path: "other_requirements[]", value: { kind: "assumption", statement: "Nightly batch to the legacy gateway." } }], choice: null, notes: null }))
    const r = await resolveAiChoices({ ...base, doc: doc([moveDecision, { id: "e:fixed:2.1", choice: "move_to:n7" }]), executor })
    expect(executor).toHaveBeenCalledTimes(1)
    expect(executor.mock.calls[0][0].promptVariables).toMatchObject({ kind: "move_structured", text: "Nightly batch to the legacy gateway." })
    expect(r.decisions).toContainEqual({ id: "e:custom:CS01", choice: "move_to:n7" })
    expect(r.ops.map((o) => `${o.op}:${o.path}`)).toEqual(["add:other_requirements[]", "remove:custom_sections[id=CS01]"])
  })

  it("AI không chuyển được / trả op sai mảng / sai hình / không qua chạy khô ⇒ lùi về giữ thành mục riêng, có cảnh báo, không mất chữ", async () => {
    const bad: object[] = [
      { ops: [], choice: null, notes: "Prose only" },
      { ops: [{ op: "add", path: "actors[]", value: { name: "X" } }], choice: null, notes: null },
      { ops: [{ op: "add", path: "other_requirements[]", value: "not an object" }], choice: null, notes: null },
      { ops: [{ op: "add", path: "other_requirements[]", value: { nonsense: true } }], choice: null, notes: null }
    ]
    for (const output of bad) {
      const r = await resolveAiChoices({ ...base, doc: doc([moveDecision]), executor: async () => ok(output) })
      expect(r.decisions).toContainEqual({ id: "e:custom:CS01", choice: "keep_custom" })
      expect(r.ops).toEqual([])
      expect(r.warnings.join("\n")).toContain("giữ thành mục riêng")
    }
  })

  it("ai_resolve của conflict: nhận lựa chọn hợp lệ; lựa chọn lạ / không chọn ⇒ cách an toàn (giữ chữ / bảng cũ)", async () => {
    const decision = { id: "c:table_columns:fixed:5.1", choice: "ai_resolve" }
    const picked = await resolveAiChoices({ ...base, doc: doc([decision]), executor: async () => ok({ ops: [], choice: "keep_old_table", notes: null }) })
    expect(picked.decisions).toEqual([{ id: decision.id, choice: "keep_old_table" }])
    for (const choice of ["delete_everything", null]) {
      const r = await resolveAiChoices({ ...base, doc: doc([decision]), executor: async () => ok({ ops: [], choice, notes: null }) })
      expect(r.decisions).toEqual([{ id: decision.id, choice: "map_by_header" }])
      expect(r.warnings.length).toBe(1)
    }
    expect(safeConflictChoice({ kind: "record_of_changes", choices: ["keep_custom", "drop_from_print", "ai_resolve"] })).toBe("keep_custom")
    expect(safeConflictChoice({ kind: "split_section", choices: ["to:n1", "to:n2", "ai_resolve"] })).toBe("to:n1")
  })

  it("kết quả đã lưu chỉ dùng lại khi quyết định gốc + chữ của mục còn khớp: BA đổi quyết định hoặc chữ mục đổi ⇒ gọi AI lại, không áp op sai đích", async () => {
    const out = ok({ ops: [{ op: "add", path: "other_requirements[]", value: { kind: "assumption", statement: "Nightly batch to the legacy gateway." } }], choice: null, notes: null })
    const first = await resolveAiChoices({ ...base, doc: doc([moveDecision]), executor: async () => out })
    const executor = vi.fn<ResolveExecutor>(async () => out)
    // BA đổi sang mục đích khác (move_to:n9) ⇒ kết quả cũ (đích n7) không dùng
    await resolveAiChoices({ ...base, doc: doc([{ id: "e:custom:CS01", choice: "move_to:n9" }], first.items), executor })
    expect(executor).toHaveBeenCalledTimes(1)
    // Chữ của mục bị sửa (CR) ⇒ gọi lại, không xoá chữ mới bằng op cũ
    const edited = spine()
    edited.custom_sections[0].blocks[0].text = "Nightly batch, now also weekly."
    await resolveAiChoices({ ...base, spine: edited, doc: doc([moveDecision], first.items), executor })
    expect(executor).toHaveBeenCalledTimes(2)
  })

  it("kết quả đã lưu ⇒ không gọi AI lần hai (không trừ credit); mục không phải lựa chọn AI ⇒ không gọi; lỗi AI ⇒ ném, kết quả đã xong được lưu qua onItem", async () => {
    const out = ok({ ops: [{ op: "add", path: "other_requirements[]", value: { kind: "assumption", statement: "Nightly batch to the legacy gateway." } }], choice: null, notes: null })
    const first = await resolveAiChoices({ ...base, doc: doc([moveDecision]), executor: async () => out })
    const stored = first.items
    const executor = vi.fn<ResolveExecutor>()
    const again = await resolveAiChoices({ ...base, doc: doc([moveDecision], stored), executor })
    expect(executor).not.toHaveBeenCalled()
    expect(again.items).toHaveLength(1)
    const none = await resolveAiChoices({ ...base, doc: doc([{ id: "e:custom:CS01", choice: "keep_custom" }]), executor })
    expect(none.items).toEqual([])

    const saved: unknown[] = []
    const failing = vi.fn<ResolveExecutor>().mockResolvedValueOnce(ok({ ops: [], choice: "keep_old_table", notes: null })).mockRejectedValueOnce(new Error("hết credit"))
    await expect(
      resolveAiChoices({ ...base, doc: doc([{ id: "c:table_columns:fixed:5.1", choice: "ai_resolve" }, moveDecision]), executor: failing, onItem: async (items) => void saved.push(items) })
    ).rejects.toThrow("hết credit")
    expect(saved).toHaveLength(1)
  })
})
