import { describe, it, expect, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => {
  const query = { sort: vi.fn(), skip: vi.fn(), limit: vi.fn(), populate: vi.fn(), lean: vi.fn() }
  for (const step of [query.sort, query.skip, query.limit, query.populate]) step.mockReturnValue(query)
  const userQuery = { lean: vi.fn() }
  return {
    query,
    userQuery,
    Feedback: { create: vi.fn(), find: vi.fn((_filter?: unknown) => query), countDocuments: vi.fn() },
    User: { find: vi.fn(() => userQuery) }
  }
})

vi.mock("./feedback.model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./feedback.model.js")>()),
  Feedback: mocks.Feedback
}))
vi.mock("../user/user.model.js", () => ({ User: mocks.User }))

import * as feedbackService from "./feedback.service.js"
import { CreateFeedbackSchema } from "./feedback.validation.js"

const USER = "64b000000000000000000002"
const AT = new Date("2026-09-19T03:00:00.000Z")

describe("createFeedback", () => {
  beforeEach(() => vi.clearAllMocks())

  it("lưu theo user, trả bản ghi không lộ userId", async () => {
    mocks.Feedback.create.mockResolvedValue({ _id: "F1", userId: USER, category: "bug", message: "Lỗi", createdAt: AT })

    await expect(feedbackService.createFeedback(USER, { category: "bug", message: "Lỗi" })).resolves.toEqual({
      _id: "F1",
      category: "bug",
      message: "Lỗi",
      createdAt: AT
    })
    expect(mocks.Feedback.create).toHaveBeenCalledWith({ userId: USER, category: "bug", message: "Lỗi" })
  })
})

describe("listFeedback", () => {
  beforeEach(() => vi.clearAllMocks())

  it("mới nhất trước, kèm người gửi; user đã xoá ⇒ user null", async () => {
    mocks.Feedback.countDocuments.mockResolvedValue(2)
    mocks.query.lean.mockResolvedValue([
      { _id: "F2", category: "suggestion", message: "Thêm dark mode", createdAt: AT, userId: { _id: USER, email: "a@x.vn", name: "An" } },
      { _id: "F1", category: "other", message: "Hi", createdAt: AT, userId: null }
    ])

    const { items, meta } = await feedbackService.listFeedback({ page: 1, limit: 20 })

    expect(mocks.query.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 })
    expect(mocks.query.populate).toHaveBeenCalledWith("userId", "email name")
    expect(meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 })
    expect(items).toEqual([
      { _id: "F2", category: "suggestion", message: "Thêm dark mode", createdAt: AT, user: { _id: USER, email: "a@x.vn", name: "An" } },
      { _id: "F1", category: "other", message: "Hi", createdAt: AT, user: null }
    ])
  })

  it("phân trang ở BE: trang 3 cỡ 10 ⇒ skip 20, limit 10; totalPages theo total (FLF-404)", async () => {
    mocks.Feedback.countDocuments.mockResolvedValue(25)
    mocks.query.lean.mockResolvedValue([])
    const { meta } = await feedbackService.listFeedback({ page: 3, limit: 10 })
    expect(mocks.query.skip).toHaveBeenCalledWith(20)
    expect(mocks.query.limit).toHaveBeenCalledWith(10)
    expect(meta).toEqual({ page: 3, limit: 10, total: 25, totalPages: 3 })
    expect(mocks.User.find).not.toHaveBeenCalled()
  })

  it("q ⇒ tìm không dấu trong nội dung hoặc người gửi khớp email / tên", async () => {
    mocks.userQuery.lean.mockResolvedValue([{ _id: USER }])
    mocks.Feedback.countDocuments.mockResolvedValue(0)
    mocks.query.lean.mockResolvedValue([])
    await feedbackService.listFeedback({ page: 1, limit: 20, q: "dang nhap" })

    const filter = mocks.Feedback.find.mock.calls[0][0] as { $or: [{ message: RegExp }, { userId: { $in: string[] } }] }
    expect(filter.$or[0].message.test("Không đăng nhập được")).toBe(true)
    expect(filter.$or[1]).toEqual({ userId: { $in: [USER] } })
    expect(mocks.Feedback.countDocuments).toHaveBeenCalledWith(filter)
  })

  it("q không khớp người gửi nào ⇒ chỉ tìm trong nội dung", async () => {
    mocks.userQuery.lean.mockResolvedValue([])
    mocks.Feedback.countDocuments.mockResolvedValue(0)
    mocks.query.lean.mockResolvedValue([])
    await feedbackService.listFeedback({ page: 1, limit: 20, q: "zzz" })
    expect((mocks.Feedback.find.mock.calls[0][0] as { $or: unknown[] }).$or).toHaveLength(1)
  })
})

describe("CreateFeedbackSchema", () => {
  it("trim message và nhận 3 category", () => {
    for (const category of ["bug", "suggestion", "other"]) {
      expect(CreateFeedbackSchema.parse({ category, message: "  ok " })).toEqual({ category, message: "ok" })
    }
  })

  it.each([
    ["category lạ", { category: "praise", message: "ok" }],
    ["message rỗng", { category: "bug", message: "   " }],
    ["message quá 2000 ký tự", { category: "bug", message: "x".repeat(2001) }]
  ])("%s ⇒ không hợp lệ", (_label, body) => {
    expect(CreateFeedbackSchema.safeParse(body).success).toBe(false)
  })
})
