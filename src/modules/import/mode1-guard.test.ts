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
import { assertChangesAllowed, changeRequiresCr, changesRequireCr, isMode1Project, prefillFrom } from "./mode1-guard.js"
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

  it("mode 1 v2 (D3, FLF-183): chỉ baseline imported (v0) hoặc chưa có Spine ⇒ sửa tự do; release cũng khoá", async () => {
    projects.set("v0", { mode: "import" })
    baselines.set("v0", [{ type: "imported" }])
    projects.set("fresh", { mode: "import" })
    projects.set("rel", { mode: "import" })
    baselines.set("rel", [{ type: "imported" }, { type: "release" }])
    expect(await changesRequireCr("v0")).toBe(false)
    expect(await changesRequireCr("fresh")).toBe(false)
    expect(await changesRequireCr("rel")).toBe(true)
    await expect(assertChangesAllowed("v0", prefillFrom("Xoá UC-02"))).resolves.toBeUndefined()
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
