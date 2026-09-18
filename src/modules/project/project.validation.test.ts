import { describe, it, expect } from "vitest"
import { CreateProjectSchema, projectModeSchema } from "./project.validation.js"
import { Project, PROJECT_MODES } from "./project.model.js"

describe("Project.mode (FLF-171)", () => {
  it("không gửi mode ⇒ fpt (hành vi cũ của mode 2)", () => {
    expect(projectModeSchema.parse(undefined)).toBe("fpt")
    expect(CreateProjectSchema.parse({ name: "Lumen" }).mode).toBe("fpt")
  })

  it.each(PROJECT_MODES)("nhận mode %s", (mode) => {
    expect(CreateProjectSchema.parse({ name: "Lumen", mode }).mode).toBe(mode)
  })

  it("từ chối mode lạ", () => {
    expect(projectModeSchema.safeParse("coaching").success).toBe(false)
  })

  it("model: project cũ không có mode đọc ra fpt, import_state null; import_state phải thuộc máy trạng thái import", () => {
    const legacy = new Project({ userId: "66f000000000000000000001", name: "Old" })
    expect(legacy.validateSync()).toBeUndefined()
    expect(legacy.mode).toBe("fpt")
    expect(legacy.import_state).toBeNull()

    const imported = new Project({ userId: "66f000000000000000000001", name: "New", mode: "import", import_state: "mapping_review" })
    expect(imported.validateSync()).toBeUndefined()
    expect(new Project({ userId: "66f000000000000000000001", name: "X", import_state: "done" }).validateSync()?.errors.import_state).toBeDefined()
    expect(new Project({ userId: "66f000000000000000000001", name: "X", mode: "coaching" }).validateSync()?.errors.mode).toBeDefined()
  })
})
