import mongoose, { Schema, Document } from "mongoose"

export interface ICreditWallet extends Document {
  userId: mongoose.Types.ObjectId
  /** Org sở hữu ví (task-26). null = ví cá nhân có trước org, chờ migration backfill. */
  organizationId: mongoose.Types.ObjectId | null
  balance: number
  reserved: number
  createdAt: Date
  updatedAt: Date
}

const creditWalletSchema = new Schema<ICreditWallet>(
  {
    /**
     * task-26 Pha 4: KHÔNG còn unique. Trục sở hữu là organizationId (partial unique index bên dưới) —
     * một người ở nhiều org thì có nhiều ví. Field này giờ chỉ cho biết ví/gói sinh ra từ tài khoản nào.
     */
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    /**
     * Org sở hữu (task-26 Pha 0). Nullable ở pha này để migration backfill dần và API cũ chạy y nguyên;
     * Pha 4 đổi filter sang organizationId rồi mới bỏ nullable.
     *
     * KHÔNG đặt index: true ở đây — partial unique index bên dưới cũng có khoá { organizationId: 1 } nên
     * hai bên sinh trùng tên organizationId_1 và Mongo từ chối tạo.
     */
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null
    },
    balance: {
      type: Number,
      default: 0,
      min: 0
    },
    reserved: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  { timestamps: true }
)

/**
 * Mỗi org đúng một ví (business-flow §2: "một ví chung cho mỗi org"). Partial index để ràng buộc này có
 * hiệu lực NGAY ở Pha 0 mà vẫn bỏ qua các ví cũ còn organizationId = null — unique thường sẽ coi mọi null
 * là trùng nhau và chặn hết. Pha 4 bỏ unique theo userId, giữ lại cái này.
 */
creditWalletSchema.index(
  { organizationId: 1 },
  { unique: true, partialFilterExpression: { organizationId: { $type: "objectId" } } }
)

export const CreditWallet = mongoose.model<ICreditWallet>("CreditWallet", creditWalletSchema)
