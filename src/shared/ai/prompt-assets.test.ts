import { describe, it, expect, beforeEach } from "vitest"
import { ActionType } from "./ai-action.types.js"
import {
  listPromptAssets,
  getPromptAssetIndex,
  invalidatePromptAssetCache
} from "./prompt-assets.js"

describe("prompt assets trên đĩa", () => {
  beforeEach(() => invalidatePromptAssetCache())

  it("MỌI ActionType trong enum đều có asset trên đĩa", () => {
    // Đây là bất biến mà DEFAULT_TEMPLATES từng che đi: priority_ranking,
    // scope_out_of_scope và summarize_document chỉ tồn tại trong code, không
    // có file .md nào. Xoá bảng hardcode mà không trích chúng ra đĩa trước là
    // làm hỏng 3 luồng đang chạy.
    const index = getPromptAssetIndex()
    const missing = Object.values(ActionType).filter((t) => !index.has(t))

    expect(missing, `Thiếu asset cho: ${missing.join(", ")}`).toEqual([])
  })

  it("không có asset MỒ CÔI (asset không ứng với ActionType nào)", () => {
    // Chiều ngược lại của test trên. Khi xoá một ActionType chết mà quên xoá
    // file .md, asset mồ côi sẽ vẫn được seed vào DB và không ai biết.
    const known = new Set<string>(Object.values(ActionType))
    const orphans = listPromptAssets()
      .filter((a) => !known.has(a.actionType))
      .map((a) => `${a.file} (${a.actionType})`)

    expect(orphans, `Asset mồ côi: ${orphans.join(", ")}`).toEqual([])
  })

  it("không có actionType nào trùng nhau", () => {
    // getPromptAssetIndex() tự throw khi trùng — nếu file nào thắng phụ thuộc
    // thứ tự đọc thư mục thì đó là hành vi không xác định.
    expect(() => getPromptAssetIndex()).not.toThrow()
  })

  it("mọi asset có frontmatter hợp lệ và template không rỗng", () => {
    for (const asset of listPromptAssets()) {
      expect(asset.actionType, `${asset.file}: actionType rỗng`).toBeTruthy()
      expect(asset.provider, `${asset.file}: provider rỗng`).toBeTruthy()
      expect(asset.aiModel, `${asset.file}: aiModel rỗng`).toBeTruthy()
      expect(asset.maxTokens, `${asset.file}: maxTokens không hợp lệ`).toBeGreaterThan(0)
      expect(
        Number.isFinite(asset.temperature),
        `${asset.file}: temperature không phải số`
      ).toBe(true)
      expect(asset.template.length, `${asset.file}: template rỗng`).toBeGreaterThan(0)
    }
  })

  it("bỏ qua README.md và thư mục diagram-skill", () => {
    const files = listPromptAssets().map((a) => a.file)

    expect(files.some((f) => f.endsWith("README.md"))).toBe(false)
    expect(files.some((f) => f.includes("diagram-skill"))).toBe(false)
  })
})
