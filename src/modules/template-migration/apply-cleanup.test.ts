import { afterEach, describe, expect, it } from "vitest"
import { setDocFileStore, type DocFileStore } from "../doc-version/doc-file.store.js"
import type { ITemplateMigration } from "./template-migration.model.js"
import { cleanupArtifacts } from "./apply.service.js"
import { examplesSuppressed, planLayout } from "./build-base-file.js"
import type { MigrationGroups } from "./classify.js"
import type { PairingResult } from "./pair-sections.js"

let restore: (() => void) | null = null
afterEach(() => restore?.())

describe("cleanupArtifacts", () => {
  it("lỗi dọn file không bị nuốt: trả danh sách cảnh báo để ghi vào migration (file rò rỉ thì người vận hành thấy)", async () => {
    const removed: string[] = []
    const store = {
      remove: async (ref: string) => {
        if (ref === "bad") throw new Error("storage down")
        removed.push(ref)
      }
    } as unknown as DocFileStore
    restore = setDocFileStore(store)
    const doc = { new_base_file_ref: "bad", spine_plan: { ops: null, ops_file_ref: "ops-ref", revert_seqs: [], base_version: 1 }, snapshot: null } as unknown as ITemplateMigration
    const failures = await cleanupArtifacts(doc)
    expect(removed).toEqual(["ops-ref"])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(/file nền mới.*storage down.*dọn tay/)
  })

  it("không có gì để dọn ⇒ không cảnh báo", async () => {
    restore = setDocFileStore({ remove: async () => undefined } as unknown as DocFileStore)
    expect(await cleanupArtifacts({ new_base_file_ref: null, spine_plan: null, snapshot: null } as unknown as ITemplateMigration)).toEqual([])
  })
})

describe("heading ví dụ của mẫu khi dự án có phần tử trong Spine", () => {
  const pairing: PairingResult = { pairs: [{ old_key: "fixed:3.1.2", new_key: "n1", by: "section_id", score: 1, needs_review: false }], followers: [], split: [], ignored_new: ["n2"] }
  const groups = { matched: [], missing: [], extra: [], conflict: [], edited_since: [], structure_only_dropped: [], restored_from_snapshot: null } as MigrationGroups
  const input = (hasSpineElements: boolean) => ({
    targetHeadings: [
      { key: "n1", heading_text: "3.1.2 Screens", section_id: "fixed:3.1.2", level: 3 },
      { key: "n2", heading_text: "3.2 Example feature", section_id: "feature:@B0030", level: 2 }
    ],
    oldHeadings: [{ key: "fixed:3.1.2", heading_text: "3.1.2 Screens", level: 3, section_id: "fixed:3.1.2" }],
    pairing,
    groups,
    decisions: [],
    hasSpineElements
  })

  it("dự án FPT / dựng từ Spine (file cũ không có heading phần tử) vẫn bỏ heading ví dụ khi Spine có phần tử", () => {
    expect(examplesSuppressed(pairing, false)).toBe(false)
    expect(examplesSuppressed(pairing, true)).toBe(true)
    expect(planLayout(input(false), () => "CS01").entries.map((e) => e.section_id)).toEqual(["fixed:3.1.2", "feature:@B0030"])
    expect(planLayout(input(true), () => "CS01").entries.map((e) => e.section_id)).toEqual(["fixed:3.1.2"])
  })
})
