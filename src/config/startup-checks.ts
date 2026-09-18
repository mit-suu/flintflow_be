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
import { probePlantUml } from "../shared/diagram/plantuml.client.js"

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
  const plantuml = await probePlantUml()
  if (!plantuml.ok) {
    // Nói đúng nguyên nhân: bảo "dựng PlantUML lên" khi cổng đang bị một dự án
    // khác chiếm là chỉ sai đường, dựng thêm cũng không chiếm lại được cổng.
    console.warn(
      plantuml.reason === "not_plantuml"
        ? `[startup] ⚠ ${env.PLANTUML_BASE_URL} có server trả lời nhưng không phải ảnh (${plantuml.detail}) — ` +
            'một tiến trình khác đang chiếm cổng này. Diagram sẽ có render_status "error". ' +
            "Đổi PLANTUML_BASE_URL sang cổng khác, hoặc tắt tiến trình đang chiếm."
        : `[startup] ⚠ PlantUML không phản hồi ở ${env.PLANTUML_BASE_URL} (${plantuml.detail}) — ` +
            'diagram sẽ có render_status "error". Dựng bằng: docker compose up -d plantuml'
    )
  }
}
