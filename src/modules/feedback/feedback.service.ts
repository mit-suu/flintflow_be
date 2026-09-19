import { Feedback, type FeedbackCategory } from "./feedback.model.js"
import type { CreateFeedbackDTO } from "./feedback.validation.js"

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

export const listFeedback = async (): Promise<FeedbackItem[]> => {
  const docs = await Feedback.find()
    .sort({ createdAt: -1 })
    .populate<{ userId: PopulatedUser | null }>("userId", "email name")
    .lean()

  return docs.map((doc) => ({
    _id: String(doc._id),
    category: doc.category,
    message: doc.message,
    createdAt: doc.createdAt,
    user: doc.userId
      ? { _id: String(doc.userId._id), email: doc.userId.email, name: doc.userId.name ?? null }
      : null
  }))
}
