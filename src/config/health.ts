/**
 * health.ts (T24)
 * ─────────────────────────────────────────────────────────────────
 * Nội dung của `GET /health`. Trước T24 endpoint này trả `{ status: "ok" }` ngay khi tiến trình Node
 * còn sống — nghĩa là nó xanh cả khi Mongo chết, khi PlantUML không tồn tại, hay khi image thiếu
 * `assets/`. Một health check như thế không dùng được để quyết định có deploy hay không.
 *
 * Quy ước trạng thái tổng:
 *   - **Mongo hỏng ⇒ `status: "error"`** (HTTP 503). Không có Mongo thì không làm được gì.
 *   - **PlantUML hỏng ⇒ `status: "degraded"`** (HTTP 200). Diagram trả `render_status: "error"`,
 *     mọi thứ còn lại vẫn chạy — chặn deploy vì nó là phản ứng thái quá.
 *   - Asset thiếu là lỗi khởi động (`startup-checks.ts`), tới được đây nghĩa là đã đủ; con số vẫn
 *     được trả về để so nhanh giữa hai môi trường.
 */
import mongoose from "mongoose"
import { getPromptAssetIndex, getSkillIndex } from "../shared/ai/prompt-assets.js"
import { loadStepRegistry } from "../modules/pipeline/step-registry.js"
import { isPlantUmlReachable } from "../shared/diagram/plantuml.client.js"

export type ComponentStatus = "ok" | "error"

export interface HealthReport {
  status: "ok" | "degraded" | "error"
  mongo: ComponentStatus
  plantuml: ComponentStatus
  version: string
  assets: { prompts: number; skills: number; steps: number }
}

export const VERSION = process.env.npm_package_version ?? "1.0.0"

/**
 * PlantUML được probe qua mạng nên không hỏi lại mỗi lượt gọi: docker compose healthcheck gọi
 * `/health` mỗi 10 s và load balancer còn dày hơn thế.
 */
const PLANTUML_CACHE_MS = 15_000
let plantumlCache: { at: number; value: ComponentStatus } | null = null

const plantumlStatus = async (): Promise<ComponentStatus> => {
  const now = Date.now()
  if (plantumlCache && now - plantumlCache.at < PLANTUML_CACHE_MS) return plantumlCache.value
  const value: ComponentStatus = (await isPlantUmlReachable()) ? "ok" : "error"
  plantumlCache = { at: now, value }
  return value
}

/** Chỉ dùng trong test — xoá cache để lượt probe sau chạy thật. */
export const resetHealthCache = (): void => {
  plantumlCache = null
}

const mongoStatus = async (): Promise<ComponentStatus> => {
  if (mongoose.connection.readyState !== 1) return "error"
  try {
    // `readyState` chỉ nói về socket; ping mới nói server thật sự trả lời.
    await mongoose.connection.db?.admin().ping()
    return "ok"
  } catch {
    return "error"
  }
}

const assetCounts = (): HealthReport["assets"] => {
  try {
    return { prompts: getPromptAssetIndex().size, skills: getSkillIndex().size, steps: loadStepRegistry().length }
  } catch {
    return { prompts: 0, skills: 0, steps: 0 }
  }
}

export const buildHealthReport = async (): Promise<HealthReport> => {
  const [mongo, plantuml] = await Promise.all([mongoStatus(), plantumlStatus()])
  const status: HealthReport["status"] = mongo === "error" ? "error" : plantuml === "error" ? "degraded" : "ok"
  return { status, mongo, plantuml, version: VERSION, assets: assetCounts() }
}
