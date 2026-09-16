/**
 * startup-checks.ts
 * ─────────────────────────────────────────────────────────────────
 * Kiểm tra tại thời điểm KHỞI ĐỘNG những thứ mà nếu sai thì phải chết ngay,
 * chứ không phải chết giữa một pipeline 151 step.
 *
 * Nguyên tắc: lỗi cấu hình là lỗi ồn ào. Trước đây prompt asset thiếu sẽ rơi
 * vào một bảng hardcode trong code và im lặng đổi provider — kiểu lỗi tệ nhất
 * vì nó không dừng gì cả, chỉ làm kết quả sai đi.
 *
 * Nạp: prompt phẳng (legacy), 30 skill BMAD (frontmatter sai hợp đồng ⇒ ném ngay) và
 * step registry (T12).
 */

import { getPromptAssetIndex, getSkillIndex } from "../shared/ai/prompt-assets.js"
import { loadStepRegistry } from "../modules/pipeline/step-registry.js"
import { getAssetsRoot } from "./paths.js"
import { env } from "./env.js"
import { isPlantUmlReachable } from "../shared/diagram/plantuml.client.js"

export const validateStartupAssets = (): void => {
  const assetsRoot = getAssetsRoot()
  const index = getPromptAssetIndex()
  const skills = getSkillIndex()
  const steps = loadStepRegistry()

  console.log(
    `[startup] assets: ${assetsRoot} — nạp ${index.size} prompt asset ` +
      `(${[...index.keys()].sort().join(", ")}), ${skills.size} skill, ${steps.length} step`
  )
}

/**
 * Cảnh báo cấu hình (T24) — **không** thoát tiến trình.
 *
 * Khác với asset: asset sai là prompt sai, kết quả sai một cách im lặng ⇒ phải chết ngay. Còn thiếu
 * PlantUML chỉ làm diagram trả `render_status: "error"`, và thiếu `MODAL_BASE_URL` chỉ làm lượt gọi
 * model báo `AI_PROVIDER_NOT_CONFIGURED` — cả hai đều lộ ra rõ ràng ở đúng chỗ. Giết server vì chúng
 * sẽ biến một sự cố cục bộ thành sập toàn hệ thống.
 *
 * Chạy bất đồng bộ sau khi server đã nghe cổng để không làm chậm khởi động.
 */
export const warnStartupConfig = async (): Promise<void> => {
  if (!env.MODAL_BASE_URL.trim()) {
    console.warn("[startup] ⚠ MODAL_BASE_URL trống — mọi skill `provider: glm` sẽ trả AI_PROVIDER_NOT_CONFIGURED")
  }
  if (env.AI_PROVIDER_OVERRIDE) {
    console.warn(
      `[startup] ⚠ AI_PROVIDER_OVERRIDE=${env.AI_PROVIDER_OVERRIDE} — provider của skill bị bỏ qua. ` +
        "Chỉ dùng cho CI / smoke test."
    )
  }
  if (!(await isPlantUmlReachable())) {
    console.warn(
      `[startup] ⚠ PlantUML không phản hồi ở ${env.PLANTUML_BASE_URL} — diagram sẽ có render_status "error". ` +
        "Dựng bằng: docker compose up -d plantuml"
    )
  }
}
