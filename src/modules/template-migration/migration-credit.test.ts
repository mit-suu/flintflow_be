import { describe, expect, it } from "vitest"
import { BATCH_MAX_CHARS } from "../translation/translation.service.js"
import type { MigrationGroups } from "./classify.js"
import { aiChoiceCounts, estimateMigrationCredits } from "./migration-credit.js"

const COSTS = { translate_batch: 2, ai_item: 3 }

const groups: MigrationGroups = {
  matched: [],
  missing: [],
  extra: [{ id: "e:a", old_key: "a", heading_text: "A", section_id: "custom:a", follower_keys: [], choices: ["keep_custom", "delete", "move_to:n1", "move_to:n2"], ai_choices: ["move_to:n2"], decision_required: true }],
  conflict: [{ id: "c:table_columns:b", kind: "table_columns", old_key: "b", new_key: "n3", candidate_keys: [], old_columns: [], new_columns: [], choices: ["map_by_header", "ai_resolve"], ai_choices: ["ai_resolve"], decision_required: true }],
  edited_since: [],
  structure_only_dropped: [],
  restored_from_snapshot: null
}

describe("estimateMigrationCredits", () => {
  it("không dịch, không AI ⇒ 0", () => {
    expect(estimateMigrationCredits({ translation_chars: 0, structural_moves: 0, ai_resolve: 0 }, COSTS).total).toBe(0)
  })

  it("dịch theo lô ký tự của lớp dịch; mỗi mục AI một lượt đề xuất", () => {
    const r = estimateMigrationCredits({ translation_chars: BATCH_MAX_CHARS * 2 + 1, structural_moves: 2, ai_resolve: 1 }, COSTS)
    expect(r.translation).toEqual({ chars: BATCH_MAX_CHARS * 2 + 1, batches: 3, credits: 6 })
    expect(r.structural_moves).toEqual({ count: 2, credits: 6 })
    expect(r.ai_resolve).toEqual({ count: 1, credits: 3 })
    expect(r.total).toBe(15)
  })
})

describe("aiChoiceCounts", () => {
  it("chỉ đếm move_to vào mục có cấu trúc và ai_resolve; keep_custom / xoá / move_to thường không tốn", () => {
    expect(aiChoiceCounts(groups, [{ id: "e:a", choice: "move_to:n2" }, { id: "c:table_columns:b", choice: "ai_resolve" }])).toEqual({ structural_moves: 1, ai_resolve: 1 })
    expect(aiChoiceCounts(groups, [{ id: "e:a", choice: "move_to:n1" }, { id: "c:table_columns:b", choice: "map_by_header" }])).toEqual({ structural_moves: 0, ai_resolve: 0 })
  })
})
