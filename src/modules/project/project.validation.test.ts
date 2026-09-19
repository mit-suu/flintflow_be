import { describe, it, expect, vi } from "vitest"
import type { Request, Response } from "express"
import { CreateProjectSchema, projectModeSchema, validateRequest } from "./project.validation.js"
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

const run = (body: unknown) => {
  const req = { body } as Request
  const next = vi.fn()
  validateRequest(CreateProjectSchema)(req, {} as Response, next)
  return { req, next }
}

describe("CreateProjectSchema qua validateRequest", () => {
  it("trim tên, không gửi mode ⇒ fpt, giữ folderId", () => {
    const { req, next } = run({ name: "  Lumen  ", folderId: "f1" })

    expect(next).toHaveBeenCalledOnce()
    expect(req.body).toEqual({ name: "Lumen", mode: "fpt", folderId: "f1" })
  })

  it.each([
    ["mode lạ", { name: "Lumen", mode: "coaching" }],
    ["tên chỉ có khoảng trắng", { name: "   " }],
    ["tên quá 100 ký tự", { name: "x".repeat(101) }]
  ])("%s ⇒ 400 VALIDATION_ERROR", (_label, body) => {
    expect(() => run(body)).toThrow(expect.objectContaining({ statusCode: 400, code: "VALIDATION_ERROR" }))
  })
})
