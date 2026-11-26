/**
 * Bus sự kiện realtime cho luồng SSE `GET /projects/:id/events` (FLF-487). Hai loại kênh:
 * - `project:<projectId>` — `spine_written`: có người vừa ghi vào tài liệu của dự án;
 * - `user:<userId>` — `notification_created`: người đó vừa có thông báo app mới (chuông workspace tải lại).
 *
 * - `JOB_DRIVER=inline`: mọi lệnh ghi chạy trong process API ⇒ EventEmitter trong process là đủ.
 * - `JOB_DRIVER=bullmq`: job nền chạy ở process worker ⇒ đi qua Redis pub/sub (kênh `flintflow:rt:<key>`), mọi
 *   instance API cùng nhận. Một kết nối subscriber dùng chung (kết nối ở chế độ subscribe không chạy lệnh khác),
 *   đăng ký kênh khi có người nghe đầu tiên, huỷ khi người cuối rời.
 *
 * Phát là fire-and-forget: lỗi Redis chỉ log, không bao giờ làm hỏng việc đã làm xong. Mất sự kiện thì FE vẫn bắt kịp
 * nhờ polling (`/version` 20s, số chưa đọc 60s).
 */

import { EventEmitter } from "node:events"
import type { Redis } from "ioredis"
import { env } from "../../config/env.js"
import { getRedis } from "../queue/connection.js"

/** Nguồn của một lần ghi, để FE chọn câu báo. `system` (import, job nền không gắn người) ⇒ FE chỉ tải mới, không báo. */
export type SpineWriteSource = "cr" | "edit" | "step" | "undo" | "system"

export interface SpineWrittenEvent {
  type: "spine_written"
  project_id: string
  /** Chỉ để FE biết có bản mới hơn — không bao giờ dùng làm `base_version`. */
  spine_version: number
  actor_user_id: string | null
  /** Tên người cho người đọc, vd "Lan"; không tra được ⇒ null. */
  actor_name: string | null
  source: SpineWriteSource
  cr_id: string | null
  /** Id section bị ghi (owner), tối đa `MAX_EVENT_SECTIONS`; FE tự đổi sang số + tên mục đang hiển thị. */
  sections: string[]
  /** Số section bị ghi nhưng không liệt kê. */
  more: number
  at: string
}

export interface NotificationCreatedEvent {
  type: "notification_created"
  notification_id: string
  organization_id: string | null
  at: string
}

export type RealtimeEvent = SpineWrittenEvent | NotificationCreatedEvent
export type RealtimeHandler = (event: RealtimeEvent) => void

export const projectKey = (projectId: string): string => `project:${projectId}`
export const userKey = (userId: string): string => `user:${userId}`

const CHANNEL_PREFIX = "flintflow:rt:"
const channelOf = (key: string): string => `${CHANNEL_PREFIX}${key}`

const local = new EventEmitter()
// Mỗi tab mở một handler; không giới hạn để không có cảnh báo rò bộ nhớ giả khi nhiều người cùng mở một dự án
local.setMaxListeners(0)

const useRedis = (): boolean => env.JOB_DRIVER === "bullmq"

let subscriber: Redis | null = null
const subscribed = new Set<string>()

const getSubscriber = (): Redis => {
  if (subscriber) return subscriber
  subscriber = getRedis().duplicate()
  subscriber.on("error", (err) => console.error("[realtime]", err.message))
  subscriber.on("message", (channel: string, message: string) => {
    if (!channel.startsWith(CHANNEL_PREFIX)) return
    try {
      local.emit(channel.slice(CHANNEL_PREFIX.length), JSON.parse(message) as RealtimeEvent)
    } catch (err) {
      console.error("[realtime] bỏ sự kiện không đọc được", err instanceof Error ? err.message : err)
    }
  })
  return subscriber
}

/** Phát sự kiện cho mọi luồng đang nghe `key`. Không ném. */
export const publishRealtime = (key: string, event: RealtimeEvent): void => {
  try {
    if (!useRedis()) {
      local.emit(key, event)
      return
    }
    getRedis()
      .publish(channelOf(key), JSON.stringify(event))
      .catch((err: unknown) => console.error("[realtime] publish lỗi", err instanceof Error ? err.message : err))
  } catch (err) {
    console.error("[realtime] publish lỗi", err instanceof Error ? err.message : err)
  }
}

/** Nghe một kênh. Trả hàm huỷ (gọi nhiều lần vô hại). */
export const subscribeRealtime = (key: string, handler: RealtimeHandler): (() => void) => {
  local.on(key, handler)
  if (useRedis() && !subscribed.has(key)) {
    subscribed.add(key)
    getSubscriber()
      .subscribe(channelOf(key))
      .catch((err: unknown) => {
        subscribed.delete(key)
        console.error("[realtime] subscribe lỗi", err instanceof Error ? err.message : err)
      })
  }
  let done = false
  return () => {
    if (done) return
    done = true
    local.off(key, handler)
    if (useRedis() && subscribed.has(key) && local.listenerCount(key) === 0) {
      subscribed.delete(key)
      subscriber?.unsubscribe(channelOf(key)).catch(() => undefined)
    }
  }
}

/** Số handler đang nghe một kênh (test + kiểm rò). */
export const listenerCountOf = (key: string): number => local.listenerCount(key)
