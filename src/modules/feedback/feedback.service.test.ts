import { describe, it, expect, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => {
  const query = { sort: vi.fn(), populate: vi.fn(), lean: vi.fn() }
  query.sort.mockReturnValue(query)
  query.populate.mockReturnValue(query)
  return { query, Feedback: { create: vi.fn(), find: vi.fn(() => query) } }
})

vi.mock("./feedback.model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./feedback.model.js")>()),
  Feedback: mocks.Feedback
}))

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
  it("mới nhất trước, kèm người gửi; user đã xoá ⇒ user null", async () => {
    mocks.query.lean.mockResolvedValue([
      { _id: "F2", category: "suggestion", message: "Thêm dark mode", createdAt: AT, userId: { _id: USER, email: "a@x.vn", name: "An" } },
      { _id: "F1", category: "other", message: "Hi", createdAt: AT, userId: null }
    ])

    const items = await feedbackService.listFeedback()

    expect(mocks.query.sort).toHaveBeenCalledWith({ createdAt: -1 })
    expect(mocks.query.populate).toHaveBeenCalledWith("userId", "email name")
    expect(items).toEqual([
      { _id: "F2", category: "suggestion", message: "Thêm dark mode", createdAt: AT, user: { _id: USER, email: "a@x.vn", name: "An" } },
      { _id: "F1", category: "other", message: "Hi", createdAt: AT, user: null }
    ])
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
