import mongoose, { Schema, Document } from "mongoose"

export interface ISession extends Document {
  userId: mongoose.Types.ObjectId
  tokenHash: string
  expiresAt: Date
  isRevoked: boolean
  userAgent?: string
  ip?: string
  createdAt: Date
  updatedAt: Date
}

const sessionSchema = new Schema<ISession>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    expiresAt: {
      type: Date,
      required: true
    },
    isRevoked: {
      type: Boolean,
      default: false
    },
    userAgent: {
      type: String
    },
    ip: {
      type: String
    }
  },
  { timestamps: true }
)

export const Session = mongoose.model<ISession>("Session", sessionSchema)
