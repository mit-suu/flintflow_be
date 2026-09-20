import mongoose, { Schema, Document } from "mongoose"

/** Màu thư mục — FE map sang token màu (không lưu hex). */
export const FOLDER_COLORS = ["violet", "blue", "amber", "green", "rose"] as const
export type FolderColor = (typeof FOLDER_COLORS)[number]

export const FOLDER_NAME_MAX = 60

/** Thư mục nhóm dự án của một user. Dự án trỏ tới thư mục qua `Project.folderId`. */
export interface IFolder extends Document {
  userId: mongoose.Types.ObjectId
  name: string
  color: FolderColor
  createdAt: Date
  updatedAt: Date
}

const folderSchema = new Schema<IFolder>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: FOLDER_NAME_MAX
    },
    color: {
      type: String,
      enum: FOLDER_COLORS,
      default: "violet"
    }
  },
  { timestamps: true }
)

export const Folder = mongoose.model<IFolder>("Folder", folderSchema)
