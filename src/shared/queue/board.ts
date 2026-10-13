/**
 * Bull Board — giao diện xem job (chờ / đang chạy / lỗi / số lần retry) và retry tay. Mount dưới `/api/v1/admin/queues`
 * nên đi qua `authMiddleware + adminMiddleware` của admin route. Chỉ có khi `JOB_DRIVER=bullmq`.
 */

import { createBullBoard } from "@bull-board/api"
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter"
import { ExpressAdapter } from "@bull-board/express"
import type { Router } from "express"
import { QUEUE_NAMES, getQueue } from "./job-runner.js"

export const createQueueBoardRouter = (basePath: string): Router => {
  const serverAdapter = new ExpressAdapter()
  serverAdapter.setBasePath(basePath)
  createBullBoard({
    queues: QUEUE_NAMES.map((name) => new BullMQAdapter(getQueue(name))),
    serverAdapter,
    options: { uiConfig: { boardTitle: "FlintFlow jobs" } }
  })
  return serverAdapter.getRouter() as Router
}
