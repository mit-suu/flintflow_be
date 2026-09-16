/**
 * paths.ts
 * ─────────────────────────────────────────────────────────────────
 * Resolve thư mục asset (prompt template, spine schema) một lần cho cả process.
 *
 * Vì sao không dùng `__dirname`: asset là file .md/.json, `tsc` KHÔNG emit chúng
 * sang dist/. Nếu resolve theo __dirname thì ở production đường dẫn thành
 * `dist/scripts/prompts` — một thư mục chưa bao giờ được tạo. Đó chính là lý do
 * "nguồn sự thật: repo" của Product-Brief-to-SRS-Phases.md §8 không khả thi trên
 * production trước khi có file này.
 *
 * Thay vào đó: asset nằm ở `<repo>/assets/`, ngoài `rootDir`, và được COPY
 * nguyên vẹn vào image (xem Dockerfile). Resolve bằng cách đi lên từ cwd để
 * script chạy từ thư mục con vẫn tìm được.
 */

import fs from "node:fs"
import path from "node:path"

const ASSETS_DIR_NAME = "assets"
const MAX_WALK_UP = 5

const findAssetsRoot = (): string => {
  // Cho phép override tường minh khi deploy đặt asset ở chỗ khác
  const fromEnv = process.env.FLINTFLOW_ASSETS_DIR
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) {
      throw new Error(
        `FLINTFLOW_ASSETS_DIR trỏ tới thư mục không tồn tại: ${fromEnv}`
      )
    }
    return fromEnv
  }

  let dir = process.cwd()
  for (let i = 0; i <= MAX_WALK_UP; i++) {
    const candidate = path.join(dir, ASSETS_DIR_NAME)
    if (fs.existsSync(candidate)) return candidate

    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  throw new Error(
    `Không tìm thấy thư mục '${ASSETS_DIR_NAME}/' khi đi lên từ cwd (${process.cwd()}).\n` +
      `  - Chạy local: chạy lệnh từ thư mục gốc repo (nơi có assets/).\n` +
      `  - Chạy Docker: kiểm tra Dockerfile có 'COPY assets ./assets' ở stage runtime.\n` +
      `  - Hoặc set biến môi trường FLINTFLOW_ASSETS_DIR.`
  )
}

/** Thư mục assets gốc. Resolve lazy + cache để lỗi nổ ở lần dùng đầu, không phải lúc import. */
let cachedAssetsRoot: string | null = null

export const getAssetsRoot = (): string => {
  if (!cachedAssetsRoot) cachedAssetsRoot = findAssetsRoot()
  return cachedAssetsRoot
}

export const getPromptsDir = (): string => path.join(getAssetsRoot(), "prompts")

/**
 * Corpus tham chiếu của Claude "diagram" skill, dùng bởi /draw-test.
 * KHÔNG phải prompt asset — để riêng ngoài prompts/ để loader không quét vào.
 */
export const getDiagramSkillDir = (): string =>
  path.join(getAssetsRoot(), "diagram-skill", "diagram")
