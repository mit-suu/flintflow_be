import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { gateTableOf, MAX_TABLE_ROWS } from "./gate-table.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

describe("gateTableOf", () => {
  it("BUG-20: S-9.4 hiện bảng MoSCoW, xếp Must trước và nói rõ mục chưa được xếp hạng", () => {
    const spine: Spine = {
      ...FIXTURE,
      functions: FIXTURE.functions.slice(0, 3).map((f, i) => ({ ...f, priority: i === 0 ? null : i === 1 ? "could" : "must" })),
      nfrs: FIXTURE.nfrs.slice(0, 1).map((n) => ({ ...n, priority: "should" as const }))
    }
    const table = gateTableOf(spine, "S-9.4")!
    expect(table.title_vi).toContain("MoSCoW")
    expect(table.columns).toEqual(["Mã", "Loại", "Tên", "Ưu tiên"])
    expect(table.rows.map((r) => r[3])).toEqual(["Must", "Should", "Could", "— chưa xếp"])
    expect(table.truncated).toBe(0)
  })

  it("bảng ở gate là bản thu gọn: cắt bớt và nói còn bao nhiêu dòng", () => {
    const table = gateTableOf(FIXTURE, "S-9.4")!
    expect(table.rows.length).toBe(MAX_TABLE_ROWS)
    expect(table.truncated).toBe(FIXTURE.functions.length + FIXTURE.nfrs.length - MAX_TABLE_ROWS)
  })

  it("S-4.3 hiện ma trận quyền: mỗi màn một dòng, mỗi vai trò một cột", () => {
    const table = gateTableOf(FIXTURE, "S-4.3")!
    expect(table.columns.slice(0, 2)).toEqual(["Mã màn", "Màn hình"])
    expect(table.columns).toHaveLength(2 + FIXTURE.roles.length)
    const first = table.rows[0]
    expect(first).toHaveLength(table.columns.length)
    expect(first.slice(2).every((cell) => typeof cell === "string")).toBe(true)
  })

  it("step không sinh bảng thì không có bảng", () => {
    expect(gateTableOf(FIXTURE, "S-3.1")).toBeNull()
  })
})
