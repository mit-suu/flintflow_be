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
    expect(rows[0].title_vi).toContain("Tên, Mô tả")
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

describe("P06 - không lộ tên field / mã nội bộ", () => {
  const spine = FIXTURE
  const uc = FIXTURE.use_cases[0]
  const role = FIXTURE.roles[0]
  const screen = FIXTURE.screens[0]
  it("gắn chức năng vào use case ⇒ dòng của use case, không phải collection function_ids", () => {
    const rows = summarizeChanges(
      [
        { op: "add", path: `use_cases[id=${uc.id}].function_ids[=FN009]`, before: ABSENT, value: "FN009" },
        { op: "add", path: `use_cases[id=${uc.id}].function_ids[=FN010]`, before: ABSENT, value: "FN010" }
      ] as never,
      spine
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].collection).toBe("use_cases")
    expect(rows[0].kind).toBe("update")
    expect(rows[0].title_vi).toContain(uc.name)
    expect(JSON.stringify(rows)).not.toContain("function_ids")
  })
  it("phân quyền ⇒ '<vai> trên màn <màn>', không in mã", () => {
    const rows = summarizeChanges([{ op: "add", path: "permissions[]", before: ABSENT, value: { id: "P904", role_id: role.id, screen_id: screen.id, action: "view" } }] as never, spine)
    expect(rows[0].title_vi).toBe(`${role.name} trên màn ${screen.name}`)
  })
  it("quyền trỏ màn đã xoá ⇒ không in mã", () => {
    const rows = summarizeChanges([{ op: "add", path: "permissions[id=P905]", before: ABSENT, value: { id: "P905", role_id: role.id, screen_id: "S999", action: "view" } }] as never, spine)
    expect(rows[0].title_vi).toBe(`${role.name} trên một màn đã xoá`)
  })
  it("sửa luồng màn ⇒ field 'Chuyển tới màn'", () => {
    const rows = summarizeChanges([{ op: "set", path: `screens[id=${screen.id}].flow_to`, before: [], value: [{ to: "S07" }] }] as never, spine)
    expect(rows[0].title_vi).toBe(`${screen.name} · Chuyển tới màn`)
  })
  it("sửa mục đích của ghi chú Brief ⇒ không in 'target_section'", () => {
    const note = { id: "AD1", topic: "scope", content: "Bản đầu gọn, khoảng 5-8 use case", content_en: "", target_section: "fixed:1.3", captured_at: "2026-11-17T00:00:00Z" }
    const rows = summarizeChanges([{ op: "set", path: "addendum[id=AD1].target_section", before: "fixed:1.2", value: "fixed:1.3" }] as never, { ...spine, addendum: [note] } as Spine)
    expect(rows[0].title_vi).toBe(`${note.content} · Mục trong tài liệu`)
    expect(JSON.stringify(rows)).not.toContain("target_section")
  })
})

describe("FLF-479: giá trị enum trong nhật ký", () => {
  it("project.type snake_case ⇒ chữ tiếng Việt, không in mã enum thô", () => {
    const rows = summarizeChanges([change("set", "project.type", null, "mobile_and_web_application")], FIXTURE)
    expect(rows[0].title_vi).toBe("Loại: Ứng dụng di động và web")
  })
})
