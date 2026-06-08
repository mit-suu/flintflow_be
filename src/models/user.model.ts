import mongoose, { Schema, Document } from "mongoose"
import bcrypt from "bcrypt"

export interface IUser extends Document {
  email: string
  password: string
  refreshToken?: string
  createdAt: Date
  updatedAt: Date
  comparePassword(password: string): Promise<boolean>
}

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    password: {
      type: String,
      required: true,
      select: false
    },
    refreshToken: {
      type: String,
      select: false
    }
  },
  { timestamps: true }
)

userSchema.pre<any>("save", async function (done: any) {
  if (!this.isModified("password")) {
    return done()
  }

  try {
    const salt = await bcrypt.genSalt(10)
    this.password = await bcrypt.hash(this.password, salt)
    done()
  } catch (error) {
    done(error as Error)
  }
})

userSchema.methods.comparePassword = async function (password: string): Promise<boolean> {
  return await bcrypt.compare(password, this.password)
}

export const User = mongoose.model<IUser>("User", userSchema)
