/**
 * prompt-assets.ts
 * ─────────────────────────────────────────────────────────────────
 * Đọc prompt asset từ ĐĨA (`assets/prompts/**.md`) — nguồn sự thật theo
 * Product-Brief-to-SRS-Phases.md §8 ("Nguồn sự thật: repo").
 *
 * Module này là nơi DUY NHẤT parse frontmatter của prompt asset. Cả
 * `seed-from-md.ts` (seed vào DB) và `prompt-registry.service.ts` (đọc lúc
 * chạy) đều gọi vào đây, nên không thể lệch nhau.
 *
 * Lý do tồn tại: trước đây `prompt-registry.service.ts` có một bảng
 * DEFAULT_TEMPLATES hardcode trong code, ghim `openai/gpt-4o-mini` và
 * `gemini/gemini-3.5-flash`, trong khi asset trên đĩa ghim
 * `glm/zai-org/GLM-5.3-Flash`. DB rỗng (deploy mới, drop collection) là mọi
 * action im lặng đổi provider VÀ đổi context window — rồi nuôi sai số cho
 * CONTEXT_WINDOW_BY_MODEL. Nay chỉ còn hai nguồn: đĩa (mặc định) và DB
 * (override tường minh qua /admin/prompt-templates).
 */

import fs from "node:fs"
import path from "node:path"
import matter from "gray-matter"
import { getPromptsDir } from "../../config/paths.js"

export interface PromptAsset {
  /** Đường dẫn tương đối so với assets/prompts, dùng cho log. */
  file: string
  actionType: string
  provider: string
  aiModel: string
  maxTokens: number
  temperature: number
  isActive: boolean
  description?: string
  template: string
}

/** Field frontmatter bắt buộc. Thiếu một cái là lỗi lúc load, không phải lúc gọi model. */
const REQUIRED_FIELDS = ["actionType", "provider", "aiModel", "maxTokens", "temperature"] as const

/**
 * Thư mục loader KHÔNG quét:
 *   - diagram-skill: corpus tham chiếu của Claude skill (.excalidraw/.png/.zip)
 *   - _archive: prompt của action type đã ngừng dùng. Giữ trên đĩa để tra cứu
 *     và để hồi sinh được, nhưng KHÔNG seed vào DB — nếu quét vào thì chúng
 *     thành asset mồ côi (không ứng ActionType nào) và test sẽ đỏ.
 */
const IGNORED_DIRS = new Set(["diagram-skill", "node_modules", "_archive"])

/**
 * Liệt kê mọi file .md dưới `dir`, ĐỆ QUY thư mục con.
 * Đệ quy là điều kiện cần cho cây asset 29 file ở §8.2
 * (actions/ · content/ · renderers/ · output/).
 */
const listMarkdownFiles = (dir: string, relBase = ""): string[] => {
  const out: string[] = []

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase ? path.join(relBase, entry.name) : entry.name

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      out.push(...listMarkdownFiles(path.join(dir, entry.name), rel))
      continue
    }

    if (!entry.name.endsWith(".md")) continue
    if (entry.name === "README.md") continue
    out.push(rel)
  }

  return out
}

const parseAsset = (promptsDir: string, file: string): PromptAsset => {
  const raw = fs.readFileSync(path.join(promptsDir, file), "utf-8")
  const { data, content } = matter(raw)

  const missing = REQUIRED_FIELDS.filter((f) => data[f] === undefined || data[f] === null)
  if (missing.length > 0) {
    throw new Error(`[${file}] Thiếu field frontmatter bắt buộc: ${missing.join(", ")}`)
  }

  const template = content.trim()
  if (!template) {
    throw new Error(`[${file}] Nội dung prompt (template) không được để trống.`)
  }

  return {
    file,
    actionType: String(data.actionType),
    provider: String(data.provider),
    aiModel: String(data.aiModel),
    maxTokens: Number(data.maxTokens),
    temperature: Number(data.temperature),
    isActive: data.isActive !== false,
    description: data.description ? String(data.description) : undefined,
    template
  }
}

/** Đọc lại toàn bộ asset từ đĩa. Không cache — dùng cho seeder và cho test. */
export const listPromptAssets = (): PromptAsset[] => {
  const promptsDir = getPromptsDir()

  if (!fs.existsSync(promptsDir)) {
    throw new Error(`Không tìm thấy thư mục prompts: ${promptsDir}`)
  }

  const files = listMarkdownFiles(promptsDir)
  if (files.length === 0) {
    throw new Error(`Không có file .md nào trong ${promptsDir}`)
  }

  return files.map((f) => parseAsset(promptsDir, f))
}

/**
 * Index actionType → asset, có cache.
 * actionType trùng nhau là lỗi cấu hình ⇒ nổ lúc load, vì nếu để im thì
 * file nào thắng phụ thuộc thứ tự đọc thư mục — không xác định.
 */
let cachedIndex: Map<string, PromptAsset> | null = null

export const getPromptAssetIndex = (): Map<string, PromptAsset> => {
  if (cachedIndex) return cachedIndex

  const index = new Map<string, PromptAsset>()

  for (const asset of listPromptAssets()) {
    const existing = index.get(asset.actionType)
    if (existing) {
      throw new Error(
        `actionType trùng lặp: "${asset.actionType}" xuất hiện ở cả "${existing.file}" và "${asset.file}"`
      )
    }
    index.set(asset.actionType, asset)
  }

  cachedIndex = index
  return index
}

export const invalidatePromptAssetCache = (): void => {
  cachedIndex = null
}
