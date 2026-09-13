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
 * Sẽ bổ sung ở các stage sau: validate srs-spine.schema.json, registry cờ đỏ
 * (10 red + 6 yellow), và đối chiếu step-registry ↔ prompt asset.
 */

import { getPromptAssetIndex } from "../shared/ai/prompt-assets.js"
import { getAssetsRoot } from "./paths.js"

export const validateStartupAssets = (): void => {
  const assetsRoot = getAssetsRoot()
  const index = getPromptAssetIndex()

  console.log(
    `[startup] assets: ${assetsRoot} — nạp ${index.size} prompt asset ` +
      `(${[...index.keys()].sort().join(", ")})`
  )
}
