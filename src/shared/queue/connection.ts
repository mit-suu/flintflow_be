/**
 * Kết nối Redis dùng chung cho BullMQ (Queue, QueueEvents, Worker tự `duplicate()` kết nối chặn của nó).
 * Chỉ mở khi `JOB_DRIVER=bullmq` — driver `inline` không bao giờ gọi tới đây.
 */

import { Redis } from "ioredis"
import { env } from "../../config/env.js"

let client: Redis | null = null

export const getRedis = (): Redis => {
  if (client) return client
  // BullMQ bắt buộc `maxRetriesPerRequest: null`: lệnh chặn (BRPOPLPUSH…) không được bị ioredis cắt sau N lần thử.
  client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  client.on("error", (err) => console.error("[redis]", err.message))
  return client
}

/** Ping Redis cho `/health`. `off` = không dùng Redis (driver inline). */
export const redisStatus = async (): Promise<"ok" | "error" | "off"> => {
  if (env.JOB_DRIVER !== "bullmq") return "off"
  try {
    await getRedis().ping()
    return "ok"
  } catch {
    return "error"
  }
}

export const closeRedis = async (): Promise<void> => {
  if (!client) return
  await client.quit().catch(() => undefined)
  client = null
}
