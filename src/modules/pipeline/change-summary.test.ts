import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { ABSENT } from "../spine/op.types.js"
import { summarizeChanges, summaryHeadline, titleOf } from "./change-summary.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const change = (op: string, p: string, before: unknown, value: unknown) => ({ op, path: p, before, value, reason: null })

describe("summarizeChanges", () => {
  it("thêm phần tử ⇒ một dòng mang tên phần tử và section của nó", () => {
    const uc = { id: "UC90", name: "Send Appointment Reminder", actor_ids: [], function_ids: [], description: "", includes: [], extends: [] }
    const rows = summarizeChanges([change("add", "use_cases[id=UC90]", ABSENT, uc)], FIXTURE)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: "add", collection: "use_cases", id: "UC90", title_vi: "Send Appointment Reminder" })
    expect(rows[0].section_id).toBe("fixed:2.2.2")
  })

  it("nhiều op trên cùng phần tử gộp một dòng, kèm tên field đã đổi", () => {
    const actor = FIXTURE.actors[0]
    const rows = summarizeChanges(
      [change("set", `actors[id=${actor.id}].name`, actor.name, "Receptionist"), change("set", `actors[id=${actor.id}].description`, actor.description, "x")],
      FIXTURE
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe("update")
    expect(rows[0].title_vi).toContain("name, description")
  })

  it("xoá phần tử lấy tên từ `before`", () => {
    const screen = FIXTURE.screens[0]
    const rows = summarizeChanges([change("remove", `screens[id=${screen.id}]`, screen, { ...ABSENT, index: 0 })], FIXTURE)
    expect(rows[0]).toMatchObject({ kind: "remove", collection: "screens", title_vi: screen.name })
  })

  it("bỏ qua sổ sách của runner (steps, progress, flags)", () => {
    const rows = summarizeChanges([
      change("set", "steps[id=S-4.1].status", "in_progress", "accepted"),
      change("set", "progress.current_step", "S-4.1", "S-4.2"),
      change("add", "flags[id=FL001]", ABSENT, { id: "FL001" })
    ])
    expect(rows).toEqual([])
  })

  it("field của project ⇒ dòng nói tên field và giá trị mới", () => {
    const rows = summarizeChanges([change("set", "project.system_name", null, "Minh An Booking")], FIXTURE)
    expect(rows[0].title_vi).toContain("Minh An Booking")
  })

  it("headline gộp theo loại và collection", () => {
    const headline = summaryHeadline([
      { kind: "add", collection: "use_cases", id: "UC90", title_vi: "a" },
      { kind: "add", collection: "use_cases", id: "UC91", title_vi: "b" },
      { kind: "update", collection: "functions", id: "FN005", title_vi: "c" }
    ])
    expect(headline).toBe("thêm 2 use case · sửa 1 chức năng")
  })

  it("titleOf lùi dần name → statement → id", () => {
    expect(titleOf({ statement: "Uptime >= 99%" }, "N08")).toBe("Uptime >= 99%")
    expect(titleOf({}, "N08")).toBe("N08")
  })
})
