/**
 * `GET /projects/:id/events` (FLF-487, pipeline-contract #40) — luồng SSE mỗi tab đang mở dự án:
 * - `ready` `{ spine_version }` ngay khi mở (lỡ sự kiện lúc nối lại thì FE so version mà bắt kịp);
 * - `spine_written` khi có người ghi vào tài liệu của dự án (kênh `project:<id>`);
 * - `notification_created` khi chính người mở luồng có thông báo app mới (kênh `user:<id>`);
 * - `: ping` mỗi `PROJECT_EVENTS_PING_MS`; sau `PROJECT_EVENTS_MAX_MS` gửi `bye` rồi đóng ⇒ FE nối lại với token mới,
 *   quyền được kiểm lại.
 * Chỉ đọc: không ghi DB, không giữ credit. Mọi vai trò xem được dự án đều mở được (như #39 `/version`).
 */

import type { Request, Response } from "express"
import mongoose from "mongoose"
import { env } from "../../config/env.js"
import { getProjectById } from "./project.service.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { projectKey, subscribeRealtime, userKey, type RealtimeEvent } from "../../shared/realtime/project-events.js"
import * as spineRepository from "../spine/spine.repository.js"

/** Tab mồ côi không được tích tụ: luồng thứ `MAX_STREAMS_PER_USER + 1` của cùng người + dự án đóng luồng cũ nhất. */
export const MAX_STREAMS_PER_USER = 5

const open = new Map<string, Array<() => void>>()

const track = (key: string, close: () => void): (() => void) => {
  const list = open.get(key) ?? []
  list.push(close)
  open.set(key, list)
  if (list.length > MAX_STREAMS_PER_USER) list[0]()
  return () => {
    const current = open.get(key) ?? []
    const next = current.filter((c) => c !== close)
    if (next.length) open.set(key, next)
    else open.delete(key)
  }
}

export const streamProjectEvents = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  await getProjectById(projectId, requireOrgId(req))
  const head = await spineRepository.versionHead(projectId)

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8")
  res.setHeader("Cache-Control", "no-cache, no-transform")
  res.setHeader("Connection", "keep-alive")
  res.setHeader("X-Accel-Buffering", "no")
  res.flushHeaders?.()

  let closed = false
  const write = (chunk: string) => {
    if (!closed && !res.writableEnded) res.write(chunk)
  }
  // `data` luôn mang `type` (như luồng chạy step) để client chỉ cần đọc dòng `data:`
  const send = (type: string, data: Record<string, unknown>) => write(`event: ${type}\ndata: ${JSON.stringify({ ...data, type })}\n\n`)
  const onEvent = (event: RealtimeEvent) => send(event.type, { ...event })

  const unsubscribers = [subscribeRealtime(projectKey(projectId), onEvent), subscribeRealtime(userKey(userId), onEvent)]
  const ping = setInterval(() => write(": ping\n\n"), env.PROJECT_EVENTS_PING_MS)

  const close = (reason: "bye" | "replaced" | null) => {
    if (closed) return
    if (reason) send("bye", { reason })
    closed = true
    clearInterval(ping)
    clearTimeout(expire)
    for (const off of unsubscribers) off()
    untrack()
    if (!res.writableEnded) res.end()
  }
  const expire = setTimeout(() => close("bye"), env.PROJECT_EVENTS_MAX_MS)
  const untrack = track(`${userId}:${projectId}`, () => close("replaced"))
  req.on("close", () => close(null))

  send("ready", { spine_version: head?.spine_version ?? 0 })
})
