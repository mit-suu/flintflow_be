/**
 * Ảnh gốc của màn trong dự án import (FLF-410): mục chức năng §3.x.y của file có ảnh màn hình (`TemplateProfile.
 * function_originals`, nguyên văn file). Người dùng chọn "Vẽ lại bằng mockup" ⇒ mockup thay các ảnh màn hình của mục.
 *
 * - Mục của màn: function đầu tiên (theo `order`) của màn có nguyên văn chứa ảnh; không có ⇒ function đầu tiên có nguyên văn.
 * - Ảnh nào là ảnh màn hình: model chỉ ra trong chính lượt vẽ mockup (`screen_images`); model không trả ⇒ regex chú thích
 *   dùng chung với import (`SCREEN_CAPTION`); không ảnh nào khớp ⇒ ảnh đầu tiên.
 * - `index` của ảnh = thứ tự ảnh trong khối nguyên văn của mục (0, 1, …).
 */

import { createHash } from "node:crypto"
import mongoose from "mongoose"
import type { Spine } from "../spine/spine.types.js"
import type { FunctionOriginalBlock } from "../render/function-original.js"
import type { ScreenMockupMode } from "../../shared/diagram/screen-theme.js"
import { compareIds } from "./renderers/common.js"
import type { OriginalImageInput } from "./screen-layout.ai.js"
import type { LoadOriginal } from "./screen-layout-parts.js"

/** Chú thích chỉ ảnh màn hình — import dùng chung (`import/extract.service.ts`: ảnh màn hình không gửi AI đọc như sơ đồ). */
export const SCREEN_CAPTION = /(layout|screenshot|screen shot|mock-?up|wireframe|prototype|giao diện)/i

export interface FunctionOriginalLite {
  section_id: string
  blocks: readonly FunctionOriginalBlock[]
}

export interface OriginalImage {
  index: number
  image_ref: string
  caption: string
  context: string
}

/** Ảnh trong khối nguyên văn của mục, kèm chú thích (chữ của khối ảnh) và đoạn chữ liền trước / sau. */
export const originalImages = (blocks: readonly FunctionOriginalBlock[]): OriginalImage[] => {
  const textAt = (i: number): string => {
    const b = blocks[i]
    return b && (b.kind === "paragraph" || b.kind === "list_item" || b.kind === "heading") ? b.text.trim() : ""
  }
  const out: OriginalImage[] = []
  blocks.forEach((b, i) => {
    if (b.kind !== "image" || !b.image_ref) return
    out.push({ index: out.length, image_ref: b.image_ref, caption: b.text.trim() || "(none)", context: [textAt(i - 1), textAt(i + 1)].filter(Boolean).join(" / ").slice(0, 300) })
  })
  return out
}

/** Mục nguyên văn chứa ảnh màn: function của màn theo `order`, ưu tiên mục có ảnh. Không có ⇒ null. */
export const originalSectionOfScreen = (spine: Pick<Spine, "functions">, originals: readonly FunctionOriginalLite[], screenId: string): FunctionOriginalLite | null => {
  const sections = spine.functions
    .filter((f) => f.screen_id === screenId)
    .sort((a, b) => a.order - b.order || compareIds(a.id, b.id))
    .flatMap((f) => originals.filter((o) => o.section_id === `function:${f.id}`))
  return sections.find((o) => originalImages(o.blocks).length > 0) ?? sections[0] ?? null
}

/**
 * Index các ảnh bị mockup thay: model chỉ ra (lọc index có thật) ⇒ dùng; không ⇒ mọi ảnh có chú thích màn hình; không ảnh
 * nào khớp ⇒ ảnh đầu tiên; mục không ảnh ⇒ `[]` (mockup chèn ngay dưới tiêu đề mục).
 */
export const screenLayoutImageIndexes = (images: readonly OriginalImage[], aiIndexes?: readonly number[] | null): number[] => {
  const valid = new Set(images.map((i) => i.index))
  const fromAi = (aiIndexes ?? []).filter((i) => valid.has(i))
  if (fromAi.length > 0) return [...new Set(fromAi)].sort((a, b) => a - b)
  const byCaption = images.filter((i) => SCREEN_CAPTION.test(`${i.caption} ${i.context}`)).map((i) => i.index)
  if (byCaption.length > 0) return byCaption
  return images.length > 0 ? [images[0].index] : []
}

/** Hash ảnh gốc gửi model (theo tham chiếu file — file import bất biến). */
export const imageHashOf = (images: readonly OriginalImage[]): string => createHash("sha256").update(images.map((i) => i.image_ref).join("|")).digest("hex")

/** Mục nguyên văn của dự án (DB). Chưa nối Mongo / không phải dự án import ⇒ `[]`. */
export const loadFunctionOriginals = async (projectId: string): Promise<FunctionOriginalLite[]> => {
  if (mongoose.connection.readyState !== 1 || !mongoose.isValidObjectId(projectId)) return []
  const { TemplateProfile } = await import("../import/template-profile.model.js")
  const profile = await TemplateProfile.findOne({ projectId }).select("function_originals").lean()
  return (profile?.function_originals ?? []).map((o) => ({ section_id: o.section_id, blocks: o.blocks }))
}

/** Ảnh PNG/JPEG của file import; EMF / mất file ⇒ null. */
export type LoadImage = (projectId: string, imageRef: string) => Promise<OriginalImageInput["image"]>

const defaultLoadImage: LoadImage = async (projectId, ref) => {
  const { loadImportImage } = await import("../render/import-media.js")
  return loadImportImage(projectId, ref)
}

/**
 * Dep `loadOriginal` của `diagram.service` (DB): ảnh gốc của mục chứa màn (kiểu `original` kèm dữ liệu ảnh). Chỉ được gọi
 * cho màn có trong `Project.screenMockups`. Mục không có ⇒ null.
 */
export const loadScreenOriginal =
  (deps: { originals?: (projectId: string) => Promise<FunctionOriginalLite[]>; loadImage?: LoadImage } = {}): LoadOriginal =>
  async (projectId, spine, screenId, mode: ScreenMockupMode) => {
    const section = originalSectionOfScreen(spine, await (deps.originals ?? loadFunctionOriginals)(projectId), screenId)
    if (!section) return null
    const images = originalImages(section.blocks)
    const load = deps.loadImage ?? defaultLoadImage
    const inputs: OriginalImageInput[] = await Promise.all(
      images.map(async ({ index, caption, context, image_ref }) => ({ index, caption, context, ...(mode === "original" ? { image: await load(projectId, image_ref).catch(() => null) } : {}) }))
    )
    return { input: { mode, images: inputs }, imageHash: imageHashOf(images) }
  }
