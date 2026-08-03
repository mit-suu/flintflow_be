import mongoose, { Schema, Document } from "mongoose"
import bcrypt from "bcrypt"

export type AuthProvider = "local" | "google"
export type UserRole = "user" | "admin"

export interface IUser extends Document {
  email: string
  password?: string
  passwordHash?: string | null
  authProvider: AuthProvider
  googleId?: string | null
  name?: string
  role: UserRole
  isActive: boolean
  emailVerified: boolean
  emailVerifiedAt?: Date | null
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
      trim: true,
      index: true
    },
    passwordHash: {
      type: String,
      select: false,
      default: null
    },
    authProvider: {
      type: String,
      enum: ["local", "google"],
      default: "local"
    },
    googleId: {
      type: String,
      sparse: true,
      default: null
    },
    name: {
      type: String,
      trim: true
    },
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user"
    },
    isActive: {
      type: Boolean,
      default: true
    },
    emailVerified: {
      type: Boolean,
      default: false
    },
    emailVerifiedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
)

// Virtual field 'password' mapping to 'passwordHash' for backwards compatibility and easy creation
userSchema.virtual("password").set(function (this: IUser, password: string) {
  (this as any)._password = password
}).get(function (this: IUser) {
  return (this as any)._password
})

userSchema.pre("save", async function () {
  const passwordToHash = (this as any)._password || this.password
  if (passwordToHash) {
    const salt = await bcrypt.genSalt(10)
    this.passwordHash = await bcrypt.hash(passwordToHash, salt)
  }
})

userSchema.methods.comparePassword = async function (password: string): Promise<boolean> {
  if (!this.passwordHash) return false
  return await bcrypt.compare(password, this.passwordHash)
}

export const User = mongoose.model<IUser>("User", userSchema)
