/**
 * Guard G9 / BR-03 (FLF-172, P4 §8.3 `chat-guard.test.ts` — phần hàm): `prefillFrom`, `changeRequiresCr`,
 * `isMode1Project` / `assertChangesAllowed` với model Project giả. Luồng HTTP (chat JSON + stream, `/changes`,
 * `/changes/preview`, `/reconcile`, `/undo`) ở `test/integration/mode1/chat-guard.int.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const projects = new Map<string, { mode?: string }>()
const baselines = new Map<string, { type: string }[]>()

vi.mock("../project/project.model.js", () => ({
  Project: {
    findById: (id: string) => ({
      select: () => ({ lean: async () => projects.get(id) ?? null })
    })
  }
}))

vi.mock("../spine/spine.repository.js", () => ({
  get: async (id: string) => (baselines.has(id) ? { baselines: baselines.get(id) } : null)
}))

import { isChangeInstruction } from "../spine/change.service.js"
import { assertChangesAllowed, assertNotMode1, changeRequiresCr, changesRequireCr, isMode1Project, prefillFrom } from "./mode1-guard.js"
import { Mode1Error } from "./mode1.errors.js"

beforeEach(() => {
  projects.clear()
  baselines.clear()
})

describe("prefillFrom", () => {
  it("câu lệnh một dòng ⇒ title = description = câu đã trim", () => {
    expect(prefillFrom("  Rename actor Learner to Student  ")).toEqual({ title: "Rename actor Learner to Student", description: "Rename actor Learner to Student" })
  })

  it("nhiều dòng ⇒ title là dòng đầu, description giữ nguyên văn (CRLF cũng tách)", () => {
    expect(prefillFrom("Đổi tên UC-01\r\nLý do: khách yêu cầu")).toEqual({ title: "Đổi tên UC-01", description: "Đổi tên UC-01\r\nLý do: khách yêu cầu" })
  })

  it("dòng đầu > 80 ký tự ⇒ cắt 77 + …; đúng 80 ký tự ⇒ giữ nguyên", () => {
    const long = "x".repeat(81)
    const res = prefillFrom(long)
    expect(res.title).toBe(`${"x".repeat(77)}…`)
    expect(res.title).toHaveLength(78)
    expect(res.description).toBe(long)
    expect(prefillFrom("y".repeat(80)).title).toBe("y".repeat(80))
  })

  it("rỗng / chỉ khoảng trắng / undefined ⇒ nội dung mặc định hoặc fallback truyền vào", () => {
    expect(prefillFrom(undefined)).toEqual({ title: "Sửa tài liệu", description: "Sửa tài liệu" })
    expect(prefillFrom("   \n ")).toEqual({ title: "Sửa tài liệu", description: "Sửa tài liệu" })
    expect(prefillFrom("", "Hoàn tác thay đổi")).toEqual({ title: "Hoàn tác thay đổi", description: "Hoàn tác thay đổi" })
  })

  it("có nguồn gợi ý ⇒ đưa vào prefill cho form 3.1; không có ⇒ không có khoá source", () => {
    expect(prefillFrom("Xoá UC-02", "Sửa tài liệu", { kind: "verbal", ref: "chat:c1" })).toEqual({
      title: "Xoá UC-02",
      description: "Xoá UC-02",
      source: { kind: "verbal", ref: "chat:c1" }
    })
    expect(prefillFrom("Xoá UC-02")).not.toHaveProperty("source")
  })
})

describe("changeRequiresCr", () => {
  it("Mode1Error 409 CHANGE_REQUIRES_CR mang meta.prefill", () => {
    const err = changeRequiresCr({ title: "t", description: "d" })
    expect(err).toBeInstanceOf(Mode1Error)
    expect(err).toMatchObject({ code: "CHANGE_REQUIRES_CR", statusCode: 409, meta: { prefill: { title: "t", description: "d" } } })
  })
})

describe("isMode1Project / assertChangesAllowed", () => {
  it("mode import đã có baseline v1 ⇒ chặn; fpt / không có mode / không tồn tại ⇒ cho qua", async () => {
    projects.set("m1", { mode: "import" })
    baselines.set("m1", [{ type: "imported" }, { type: "generated" }])
    projects.set("m2", { mode: "fpt" })
    projects.set("old", {})
    expect(await isMode1Project("m1")).toBe(true)
    expect(await isMode1Project("m2")).toBe(false)
    expect(await isMode1Project("old")).toBe(false)
    expect(await isMode1Project("missing")).toBe(false)

    await expect(assertChangesAllowed("m1", prefillFrom("Xoá UC-02"))).rejects.toMatchObject({
      code: "CHANGE_REQUIRES_CR",
      meta: { prefill: { title: "Xoá UC-02" } }
    })
    await expect(assertChangesAllowed("m2", prefillFrom("Xoá UC-02"))).resolves.toBeUndefined()
    await expect(assertChangesAllowed("missing", prefillFrom("Xoá UC-02"))).resolves.toBeUndefined()
  })

  it("mode 1 v3 (BPMN Flow 1 ⇒ 3.1): có baseline imported (v0) là chặn; chưa có Spine / chưa baseline ⇒ cho qua", async () => {
    projects.set("v0", { mode: "import" })
    baselines.set("v0", [{ type: "imported" }])
    projects.set("fresh", { mode: "import" })
    projects.set("noBaseline", { mode: "import" })
    baselines.set("noBaseline", [])
    projects.set("rel", { mode: "import" })
    baselines.set("rel", [{ type: "imported" }, { type: "release" }])
    expect(await changesRequireCr("v0")).toBe(true)
    expect(await changesRequireCr("fresh")).toBe(false)
    expect(await changesRequireCr("noBaseline")).toBe(false)
    expect(await changesRequireCr("rel")).toBe(true)
    await expect(assertChangesAllowed("v0", prefillFrom("Xoá UC-02"))).rejects.toMatchObject({ code: "CHANGE_REQUIRES_CR" })
  })
})

describe("assertNotMode1", () => {
  it("mode import ⇒ 409 đúng mã theo việc bị cấm; mode khác / không có mode ⇒ cho qua", () => {
    expect(() => assertNotMode1("import", "steps")).toThrow(expect.objectContaining({ code: "MODE1_NO_STEPS", statusCode: 409 }))
    expect(() => assertNotMode1("import", "signoff")).toThrow(expect.objectContaining({ code: "MODE1_NO_SIGNOFF", statusCode: 409 }))
    expect(() => assertNotMode1("import", "waive")).toThrow(expect.objectContaining({ code: "MODE1_NO_WAIVE", statusCode: 409 }))
    expect(() => assertNotMode1("fpt", "steps")).not.toThrow()
    expect(() => assertNotMode1(undefined, "waive")).not.toThrow()
  })
})

describe("điều kiện chặn chat — isChangeInstruction", () => {
  it("lệnh sửa bị nhận diện; câu hỏi và câu không có động từ sửa ở đầu thì không", () => {
    expect(isChangeInstruction("Rename actor Learner to Student")).toBe(true)
    expect(isChangeInstruction("Delete use case UC-01")).toBe(true)
    expect(isChangeInstruction("What does UC-01 do?")).toBe(false)
    expect(isChangeInstruction("Why rename the actor")).toBe(false)
    expect(isChangeInstruction("")).toBe(false)
  })
})
