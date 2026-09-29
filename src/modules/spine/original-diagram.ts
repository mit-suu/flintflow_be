/**
 * Sơ đồ gốc của người dùng (mode 1 v3 §4.13). Hàm thuần.
 * Người dùng upload SRS có sẵn hình (vẽ tay bằng draw.io…): I-4 đọc hình lấy dữ liệu vào Spine, còn **hình giữ y nguyên**
 * trong tài liệu (khối ảnh của phần nối, `custom_sections[].blocks[].diagram`). PlantUML cùng loại không in ra cho tới khi
 * một CR được duyệt bỏ ảnh gốc — lúc đó bản render tự hiện sơ đồ FlintFlow vẽ từ Spine.
 */

import { computeSourceHash } from "./source-hash.js"
import type { CustomBlock, OriginalDiagram, OriginalDiagramKind, Spine } from "./spine.types.js"

export const ORIGINAL_DIAGRAM_KINDS: readonly OriginalDiagramKind[] = ["context", "usecase", "screen_flow", "erd"]

export const isOriginalDiagramKind = (kind: string): kind is OriginalDiagramKind => (ORIGINAL_DIAGRAM_KINDS as readonly string[]).includes(kind)

/** Section FPT in sơ đồ loại đó (`section-renderer.ts`). */
export const ORIGINAL_DIAGRAM_SECTION: Readonly<Record<OriginalDiagramKind, string>> = {
  context: "fixed:1",
  usecase: "fixed:2.2.1",
  screen_flow: "fixed:3.1.1",
  erd: "fixed:3.1.5"
}

/**
 * Phần Spine mà sơ đồ loại đó vẽ ra (nới hơn `sourceProjection` một chút — chỉ dùng để **gợi** vị trí CR; quyết định vẽ
 * lại hay không vẫn theo hash). `project` = phần tử `project` (tên hệ thống trên hình).
 */
export const ORIGINAL_DIAGRAM_DATA: Readonly<Record<OriginalDiagramKind, readonly string[]>> = {
  context: ["project", "actors", "use_cases"],
  usecase: ["project", "actors", "use_cases"],
  screen_flow: ["screens", "actors", "roles", "permissions", "functions", "use_cases"],
  erd: ["entities"]
}

export const ORIGINAL_DIAGRAM_LABELS: Readonly<Record<OriginalDiagramKind, string>> = {
  context: "Sơ đồ ngữ cảnh",
  usecase: "Sơ đồ use case",
  screen_flow: "Sơ đồ luồng màn hình",
  erd: "Sơ đồ quan hệ thực thể"
}

/** Hash dữ liệu mà sơ đồ loại đó thể hiện — cùng hàm `diagram_stale` dùng cho hình PlantUML. */
export const originalDiagramHash = (spine: Spine, kind: OriginalDiagramKind): string => computeSourceHash(spine, { kind, owner_id: null })

export const originalDiagramOf = (block: CustomBlock): OriginalDiagram | null => (block.kind === "image" && block.image_ref && block.diagram ? block.diagram : null)

export interface KeptOriginalDiagram {
  custom_id: string
  block_index: number
  diagram: OriginalDiagram
  caption: string
}

/** Mọi sơ đồ gốc còn nằm trong tài liệu. */
export const keptOriginalDiagrams = (spine: Pick<Spine, "custom_sections">): KeptOriginalDiagram[] =>
  spine.custom_sections.flatMap((c) =>
    c.blocks.flatMap((b, block_index) => {
      const diagram = originalDiagramOf(b)
      return diagram ? [{ custom_id: c.id, block_index, diagram, caption: b.text.trim() }] : []
    })
  )

/** Loại sơ đồ còn hình gốc ⇒ bản render không in PlantUML loại đó (tránh hai hình cho một sơ đồ). */
export const keptOriginalKinds = (spine: Pick<Spine, "custom_sections">): Set<OriginalDiagramKind> =>
  new Set(keptOriginalDiagrams(spine).map((k) => k.diagram.kind))

/** Hình gốc không còn khớp dữ liệu hiện tại (dữ liệu đổi mà hình vẫn là ảnh của người dùng). */
export const isOriginalStale = (spine: Spine, diagram: OriginalDiagram): boolean => originalDiagramHash(spine, diagram.kind) !== diagram.source_hash
