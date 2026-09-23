import { describe, it, expect } from "vitest"
import { DEAD_FIELDS, DEAD_INDEXES, LEGACY_LOCATIONS, REQUIRED_INDEXES } from "./migrate-mode1-v2-indexes.js"

describe("migrate-mode1-v2-indexes", () => {
  it("xoá đúng index của bản CR-theo-block (thủ phạm E11000 block_id: null)", () => {
    expect(DEAD_INDEXES).toEqual([
      { collection: "changelocations", index: "projectId_1_cr_id_1_block_id_1" },
      { collection: "docblocks", index: "projectId_1_locked_by_cr_1" }
    ])
  })

  it("index cần có khớp schema V4: vị trí unique theo location_id và theo path; khoá unique theo path", () => {
    expect(REQUIRED_INDEXES).toEqual([
      { collection: "changelocations", key: { projectId: 1, cr_id: 1, location_id: 1 }, unique: true },
      { collection: "changelocations", key: { projectId: 1, cr_id: 1, path: 1 }, unique: true },
      { collection: "spinelocks", key: { projectId: 1, path: 1 }, unique: true }
    ])
  })

  it("chỉ bỏ field của bản theo block — không đụng field V4 (`path`, `entity_paths`, `section_id`)", () => {
    const dropped = DEAD_FIELDS.flatMap((d) => d.fields)
    expect(dropped).toEqual(["block_id", "block", "locked_by_cr"])
    for (const keep of ["path", "entity_paths", "section_id", "proposal", "conclusion"]) expect(dropped).not.toContain(keep)
  })

  it("vị trí bản cũ nhận diện bằng thiếu `path` — không đụng vị trí V4", () => {
    expect(LEGACY_LOCATIONS).toEqual({ collection: "changelocations", filter: { path: { $exists: false } } })
  })
})
