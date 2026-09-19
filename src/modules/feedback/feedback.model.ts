import mongoose, { Schema, Document } from "mongoose"

/** Loại góp ý member gửi từ app (UC-12). */
export const FEEDBACK_CATEGORIES = ["bug", "suggestion", "other"] as const
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]

export const FEEDBACK_MESSAGE_MAX = 2000

export interface IFeedback extends Document {
  userId: mongoose.Types.ObjectId
  category: FeedbackCategory
  message: string
  createdAt: Date
  updatedAt: Date
}

const feedbackSchema = new Schema<IFeedback>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    category: {
      type: String,
      enum: FEEDBACK_CATEGORIES,
      required: true
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: FEEDBACK_MESSAGE_MAX
    }
  },
  { timestamps: true }
)

// Admin đọc mới nhất trước
feedbackSchema.index({ createdAt: -1 })

export const Feedback = mongoose.model<IFeedback>("Feedback", feedbackSchema)
