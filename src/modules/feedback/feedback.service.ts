import { Feedback, type FeedbackCategory } from "./feedback.model.js"
import type { CreateFeedbackDTO } from "./feedback.validation.js"
import { User } from "../user/user.model.js"
import { vietnameseSearchPattern } from "../../shared/utils/vi-search.js"

/** Một dòng góp ý trả cho admin — kèm người gửi (null nếu user đã bị xoá). */
export interface FeedbackItem {
  _id: string
  category: FeedbackCategory
  message: string
  createdAt: Date
  user: { _id: string; email: string; name: string | null } | null
}

interface PopulatedUser {
  _id: unknown
  email: string
  name?: string | null
}

export const createFeedback = async (userId: string, input: CreateFeedbackDTO) => {
  const feedback = await Feedback.create({ userId, category: input.category, message: input.message })
  return {
    _id: String(feedback._id),
    category: feedback.category,
    message: feedback.message,
    createdAt: feedback.createdAt
  }
}

export interface FeedbackListQuery {
  page: number
  limit: number
  /** Tìm không dấu trong nội dung góp ý, email hoặc tên người gửi. */
  q?: string
}

/** Góp ý mới nhất trước, theo trang (FLF-404) — trước đây trả hết một lần, không giới hạn. */
export const listFeedback = async ({ page, limit, q }: FeedbackListQuery) => {
  const filter: Record<string, unknown> = {}
  if (q) {
    const pattern = vietnameseSearchPattern(q)
    // Người gửi nằm ở collection User ⇒ tìm id người khớp trước rồi gộp điều kiện
    const senders = await User.find({ $or: [{ email: pattern }, { name: pattern }] }, { _id: 1 }).lean()
    filter.$or = [{ message: pattern }, ...(senders.length ? [{ userId: { $in: senders.map((u) => u._id) } }] : [])]
  }

  const [total, docs] = await Promise.all([
    Feedback.countDocuments(filter),
    Feedback.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate<{ userId: PopulatedUser | null }>("userId", "email name")
      .lean()
  ])

  const items: FeedbackItem[] = docs.map((doc) => ({
    _id: String(doc._id),
    category: doc.category,
    message: doc.message,
    createdAt: doc.createdAt,
    user: doc.userId
      ? { _id: String(doc.userId._id), email: doc.userId.email, name: doc.userId.name ?? null }
      : null
  }))
  return { items, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } }
}
