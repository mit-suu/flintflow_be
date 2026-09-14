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
