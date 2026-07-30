import { TokenPayload } from "../auth/jwt.util.js"

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload
    }
  }
}
