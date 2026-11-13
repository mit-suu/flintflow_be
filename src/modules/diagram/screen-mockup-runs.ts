/**
 * "Vẽ lại bằng mockup" chạy nền (FLF-410): `startRun` chuẩn bị + kiểm credit ngay trong request (thiếu ⇒ 402, không tạo lượt),
 * tạo `ScreenMockupRun` rồi đưa job `system/screen-mockups` vào hàng đợi và trả lời luôn — người dùng đóng hộp, đi làm việc
 * khác; FE hỏi `getRun` định kỳ để hiện tiến độ và phủ hiệu ứng chờ lên đúng các màn đang chờ.
 *
 * - Một dự án một lượt đang chạy (lượt mới khi lượt cũ chưa xong ⇒ 409 `SCREEN_MOCKUP_RUNNING`).
 * - Dừng (`cancelRun`): màn đang vẽ vẽ nốt (token đã gửi thì đã tốn), các màn còn lại không vẽ, không trừ credit.
 * - Mỗi màn một transaction ⇒ tài liệu (và bản Export) luôn hợp lệ giữa chừng: màn xong có mockup, màn chưa tới giữ ảnh gốc.
 * - Tiến trình chết giữa chừng (driver inline, máy chủ khởi động lại) ⇒ lượt `running` không cập nhật quá `STALE_MS` coi là
 *   đã dừng; màn chưa vẽ vẫn giữ ảnh gốc.
 */

import mongoose from "mongoose"
import { defineJob, enqueueJob } from "../../shared/queue/job-runner.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { Project } from "../project/project.model.js"
import { ScreenMockupRun, type IScreenMockupRun } from "./screen-mockup-run.model.js"
import { drawPrepared, prepare, revertPrepared, type MockupDeps, type MockupRequest } from "./screen-mockup.service.js"

export const SCREEN_MOCKUP_RUNNING = "SCREEN_MOCKUP_RUNNING"
export const SCREEN_MOCKUP_QUEUE_UNAVAILABLE = "SCREEN_MOCKUP_QUEUE_UNAVAILABLE"
/** Đưa lượt vào hàng đợi không xong trong chừng này ⇒ coi hàng đợi hỏng (ioredis chờ kết nối lại vô hạn khi Redis tắt). */
export const SCHEDULE_TIMEOUT_MS = 5000

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
/** Lượt `running` không có cập nhật nào lâu hơn chừng này ⇒ tiến trình đã chết. Một màn vẽ mất vài chục giây. */
export const STALE_MS = 10 * 60 * 1000

export type RunStatus = "running" | "done" | "cancelled" | "interrupted"

export interface RunView {
  run_id: string
  status: RunStatus
  /** Đã yêu cầu dừng, đang vẽ nốt màn hiện tại. */
  stopping: boolean
  total: number
  completed: number
  done: string[]
  failed: { screen_id: string; reason: string }[]
  fell_back_to_system: string[]
  /** Màn còn chờ vẽ (FE phủ hiệu ứng chờ); lượt đã kết thúc ⇒ `[]`. */
  pending: string[]
  suggested_color: string | null
}

const isStale = (run: Pick<IScreenMockupRun, "status" | "updatedAt">, now = Date.now()): boolean =>
  run.status === "running" && now - new Date(run.updatedAt).getTime() > STALE_MS

export const viewOf = (run: IScreenMockupRun | (Omit<IScreenMockupRun, keyof mongoose.Document> & { _id: unknown }), now = Date.now()): RunView => {
  const finished = new Set([...run.done, ...run.failed.map((f) => f.screen_id)])
  const status: RunStatus = isStale(run, now) ? "interrupted" : run.status
  return {
    run_id: String(run._id),
    status,
    stopping: status === "running" && run.cancel_requested,
    total: run.screens.length,
    completed: run.screens.filter((s) => finished.has(s.screen_id)).length,
    done: [...run.done],
    failed: run.failed.map(({ screen_id, reason }) => ({ screen_id, reason })),
    fell_back_to_system: [...run.fell_back_to_system],
    pending: status === "running" ? run.screens.map((s) => s.screen_id).filter((id) => !finished.has(id)) : [],
    suggested_color: run.suggested_color
  }
}

const assertProject = async (projectId: string, orgId: string) => {
  if (!mongoose.isValidObjectId(projectId) || !(await Project.exists({ _id: projectId, organizationId: orgId })))
    throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
}

const latestRun = (projectId: string) => ScreenMockupRun.findOne({ projectId }).sort({ createdAt: -1 })

/** Vẽ các màn của lượt (processor của job; test gọi thẳng với deps riêng). */
export const executeRun = async (runId: string, orgId: string, deps?: MockupDeps): Promise<void> => {
  const run = await ScreenMockupRun.findById(runId)
  if (!run || run.status !== "running") return
  const projectId = String(run.projectId)
  const result = await drawPrepared(
    projectId,
    orgId,
    String(run.userId),
    { ai: run.screens.map(({ screen_id, mode }) => ({ screen_id, mode })), reenabled: [], fellBack: [], themeColor: run.theme_color },
    deps,
    {
      shouldStop: async () => (await ScreenMockupRun.exists({ _id: runId, cancel_requested: true })) !== null,
      onScreen: async (screenId, outcome) => {
        await ScreenMockupRun.updateOne(
          { _id: runId },
          outcome.ok ? { $addToSet: { done: screenId } } : { $push: { failed: { screen_id: screenId, reason: outcome.reason ?? "render" } } }
        )
      }
    }
  )
  await ScreenMockupRun.updateOne({ _id: runId }, { $set: { status: result.cancelled ? "cancelled" : "done", suggested_color: result.suggested_color ?? null } })
}

interface RunJobData {
  runId: string
  orgId: string
}

const screenMockupJob = defineJob<RunJobData>({
  queue: "system",
  name: "screen-mockups",
  process: ({ runId, orgId }) => executeRun(runId, orgId),
  // Lỗi ngoài từng màn (mất kết nối DB…) ⇒ đóng lượt; màn chưa vẽ giữ ảnh gốc
  onFinalFailure: async ({ runId }) => {
    await ScreenMockupRun.updateOne({ _id: runId, status: "running" }, { $set: { status: "cancelled" } })
  },
  options: { attempts: 1 }
})

/** Đưa lượt vào hàng đợi; test thay bằng hàm chạy thẳng. */
export type Schedule = (runId: string, orgId: string) => Promise<void>
const enqueue: Schedule = (runId, orgId) => enqueueJob(screenMockupJob, { runId, orgId }, { key: `screen-mockups:${runId}` })

/** Bắt đầu một lượt: kiểm credit + ghi trạng thái màn ngay, vẽ chạy nền. Trả tiến độ ban đầu. */
export const startRun = async (projectId: string, orgId: string, userId: string, req: MockupRequest, deps?: MockupDeps, schedule: Schedule = enqueue): Promise<RunView> => {
  await assertProject(projectId, orgId)
  const current = await latestRun(projectId)
  if (current && current.status === "running" && !isStale(current)) {
    throw new ApiError(409, "Đang vẽ mockup cho dự án này, chờ lượt hiện tại xong hoặc dừng nó.", SCREEN_MOCKUP_RUNNING, { run_id: String(current._id) })
  }
  if (current && isStale(current)) await ScreenMockupRun.updateOne({ _id: current._id }, { $set: { status: "cancelled" } })

  const prepared = await prepare(projectId, orgId, userId, req, deps)
  const run = await ScreenMockupRun.create({
    projectId,
    userId,
    status: prepared.ai.length > 0 ? "running" : "done",
    screens: prepared.ai,
    done: prepared.reenabled,
    fell_back_to_system: prepared.fellBack,
    theme_color: prepared.themeColor
  })
  if (prepared.ai.length > 0) {
    try {
      await withTimeout(schedule(String(run._id), orgId), SCHEDULE_TIMEOUT_MS)
    } catch (err) {
      // Hàng đợi không phản hồi (Redis tắt…) ⇒ không để request treo: đóng lượt, trả trạng thái màn về như cũ, báo rõ
      console.error(`[screen-mockup] không đưa được lượt ${String(run._id)} vào hàng đợi: ${err instanceof Error ? err.message : String(err)}`)
      await ScreenMockupRun.updateOne({ _id: run._id }, { $set: { status: "cancelled" } })
      await revertPrepared(projectId, orgId, prepared, deps)
      throw new ApiError(503, "Hàng đợi xử lý nền đang không hoạt động, chưa vẽ được. Vui lòng thử lại sau.", SCREEN_MOCKUP_QUEUE_UNAVAILABLE)
    }
  }
  return viewOf((await ScreenMockupRun.findById(run._id))!)
}

/** Lượt gần nhất của dự án; chưa từng chạy ⇒ null. */
export const getRun = async (projectId: string, orgId: string): Promise<RunView | null> => {
  await assertProject(projectId, orgId)
  const run = await latestRun(projectId)
  return run ? viewOf(run) : null
}

/** Dừng lượt đang chạy: màn đang vẽ xong thì dừng. Không có lượt đang chạy ⇒ trả lượt gần nhất như cũ. */
export const cancelRun = async (projectId: string, orgId: string): Promise<RunView | null> => {
  await assertProject(projectId, orgId)
  const run = await latestRun(projectId)
  if (!run) return null
  if (run.status === "running") {
    if (isStale(run)) run.status = "cancelled"
    else run.cancel_requested = true
    await run.save()
  }
  return viewOf(run)
}
