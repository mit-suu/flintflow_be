import dotenv from "dotenv"

dotenv.config()

export const env = {
  PORT: process.env.PORT || "5000",
  NODE_ENV: process.env.NODE_ENV || "development",
  MONGO_URI: process.env.MONGO_URI || "mongodb://localhost:27017/flintflow",
  CLIENT_URL: process.env.CLIENT_URL || "http://localhost:3000",
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || "access-secret",
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || "refresh-secret",
  ACCESS_TOKEN_EXPIRES: process.env.ACCESS_TOKEN_EXPIRES || "15m",
  REFRESH_TOKEN_EXPIRES: process.env.REFRESH_TOKEN_EXPIRES || "3d"
}
