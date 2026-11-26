/**
 * Hình xem trước cho vị trí "sơ đồ gốc" của CR (§4.13): sơ đồ FlintFlow sẽ thay ảnh gốc, vẽ từ dữ liệu SAU CR (chạy khô các
 * đề xuất của CR, không ghi Spine, không lưu file, không gọi AI), và ảnh gốc đang giữ ở chỗ đó. Người duyệt so hai hình trước
 * khi chọn "Thay hình" hay "Giữ hình gốc" — trước đây thẻ chỉ có một dòng chữ "thay bằng sơ đồ FlintFlow vẽ lại".
 */

import type { LlmImage } from "../../shared/ai/providers/provider.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { compileSvg, compileWithFix, defaultDeps, type DiagramServiceDeps } from "../diagram/diagram.service.js"
import { renderKind } from "../diagram/renderers/index.js"
import { stripRecord } from "../import/check.service.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { loadImportImage } from "../render/import-media.js"
import { originalDiagramOf } from "../spine/original-diagram.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { CustomSection, OriginalDiagramKind } from "../spine/spine.types.js"
import { ChangeLocation } from "./change-location.model.js"
import type { IChangeRequest } from "./change-request.model.js"
import { isDiagramLocation, spineAfterCr } from "./diagram-location.js"
import { elementValue } from "./spine-location.js"

export const DIAGRAM_PREVIEW_FAILED = "DIAGRAM_PREVIEW_FAILED"

/** `after` = sơ đồ FlintFlow vẽ từ dữ liệu sau CR; `original` = ảnh gốc của file đang giữ ở chỗ đó. */
export type DiagramPreviewVariant = "after" | "original"

export interface DiagramPreview {
  image: Buffer
  mime: "image/png" | "image/jpeg"
  /** Số phần của loại sơ đồ (use case tách theo feature ⇒ nhiều hình); FE lấy lần lượt theo `part`. Ảnh gốc luôn 1. */
  parts: number
}

export interface DiagramPreviewDeps extends DiagramServiceDeps {
  loadOriginalImage: (projectId: string, part: string) => Promise<LlmImage | null>
}

const previewDeps = (): DiagramPreviewDeps => ({ ...defaultDeps(), loadOriginalImage: loadImportImage })

/**
 * Hình của vị trí `locationId` cho sơ đồ loại `kind` (chủ `ownerId` với loại gắn phần tử). `after`: phần `part` của sơ đồ
 * FlintFlow sau CR. Vị trí không phải sơ đồ gốc / không giữ ảnh loại đó ⇒ 404; vẽ lỗi (máy chủ vẽ hình, lỗi bố cục) ⇒ 422.
 */
export const diagramPreview = async (
  cr: Pick<IChangeRequest, "projectId" | "cr_id">,
  locationId: string,
  kind: OriginalDiagramKind,
  ownerId: string | null,
  options: { part?: number; variant?: DiagramPreviewVariant } = {},
  deps: DiagramPreviewDeps = previewDeps()
): Promise<DiagramPreview> => {
  const projectId = String(cr.projectId)
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const spine = stripRecord(record)
  const locations = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id })
  const loc = locations.find((l) => l.location_id === locationId)
  const custom = loc && isDiagramLocation(loc) ? (elementValue(spine, loc.path) as CustomSection | undefined) : undefined
  const block = custom?.blocks.find((b) => {
    const d = originalDiagramOf(b)
    return !!d && d.kind === kind && (d.owner_id ?? null) === ownerId
  })
  if (!block) throw new Mode1Error("CR_LOCATION_NOT_FOUND", "Chỗ này không giữ hình gốc loại sơ đồ đó")

  if (options.variant === "original") {
    const image = block.image_ref ? await deps.loadOriginalImage(projectId, block.image_ref) : null
    if (!image) throw new ApiError(404, "Không đọc được ảnh gốc của tài liệu", DIAGRAM_PREVIEW_FAILED)
    return { image: Buffer.from(image.data, "base64"), mime: image.mime === "image/jpeg" ? "image/jpeg" : "image/png", parts: 1 }
  }

  const rendered = renderKind(spineAfterCr(spine, locations), kind, ownerId, await deps.renderContext(projectId))
  const chosen = rendered[options.part ?? 0]
  if (!chosen) throw new ApiError(404, "Sơ đồ này không có dữ liệu để vẽ sau change request", DIAGRAM_PREVIEW_FAILED)
  const compiled = chosen.format === "svg" ? await compileSvg(chosen, deps) : await compileWithFix(kind, chosen.source, deps)
  if (!compiled.ok) throw new ApiError(422, "Chưa vẽ được hình xem trước - máy chủ vẽ hình chưa sẵn sàng hoặc sơ đồ lỗi bố cục", DIAGRAM_PREVIEW_FAILED)
  try {
    return { image: compiled.png ?? (await deps.renderPng(compiled.source)), mime: "image/png", parts: rendered.length }
  } catch {
    throw new ApiError(422, "Chưa vẽ được hình xem trước - máy chủ vẽ hình chưa sẵn sàng", DIAGRAM_PREVIEW_FAILED)
  }
}
