/**
 * Sơ đồ gốc của người dùng (mode 1 v3 §4.13). Hàm thuần.
 * Người dùng upload SRS có sẵn hình (vẽ tay bằng draw.io…): I-4 đọc hình lấy dữ liệu vào Spine, còn **hình giữ y nguyên**
 * trong tài liệu (khối ảnh của phần nối, `custom_sections[].blocks[].diagram`). PlantUML cùng loại không in ra cho tới khi
 * một CR được duyệt bỏ ảnh gốc — lúc đó bản render tự hiện sơ đồ FlintFlow vẽ từ Spine.
 *
 * FLF-390: `sequence` (của một function) và `activity` (của một use case) là sơ đồ **của một phần tử** (`owner_id`): mỗi chủ
 * một hình, nên hình gốc chỉ ẩn hình FlintFlow cùng loại CỦA chủ đó (khoá `<kind>@<owner>`), dữ liệu của hình là của chủ đó.
 */

import { computeSourceHash } from "./source-hash.js"
import type { CustomBlock, Diagram, OriginalDiagram, OriginalDiagramKind, Spine } from "./spine.types.js"

export const ORIGINAL_DIAGRAM_KINDS: readonly OriginalDiagramKind[] = ["context", "usecase", "screen_flow", "erd", "sequence", "activity", "deployment"]

/** Loại sơ đồ gốc gắn với một phần tử (mỗi chủ một hình): `sequence` ↔ function, `activity` ↔ use case. */
export const OWNER_DIAGRAM_KINDS: ReadonlySet<OriginalDiagramKind> = new Set<OriginalDiagramKind>(["sequence", "activity"])

export const isOriginalDiagramKind = (kind: string): kind is OriginalDiagramKind => (ORIGINAL_DIAGRAM_KINDS as readonly string[]).includes(kind)

/** Section FPT in sơ đồ loại đó (`section-renderer.ts`). `sequence` ⇒ `function:` + id function (xem `originalSectionOf`). */
export const ORIGINAL_DIAGRAM_SECTION: Readonly<Record<OriginalDiagramKind, string>> = {
  context: "fixed:1",
  usecase: "fixed:2.2.1",
  screen_flow: "fixed:3.1.1",
  erd: "fixed:3.1.5",
  sequence: "function:",
  activity: "fixed:2.2.2",
  deployment: "fixed:4.1"
}

/** Section của sơ đồ gốc (cờ, vị trí CR): `sequence` ⇒ mục của function chủ; `activity` ⇒ đặc tả use case; còn lại theo loại. */
export const originalSectionOf = (d: Pick<OriginalDiagram, "kind" | "owner_id">): string =>
  d.kind === "sequence" ? `function:${d.owner_id ?? ""}` : ORIGINAL_DIAGRAM_SECTION[d.kind]

/** Mảng Spine chứa chủ của sơ đồ gắn phần tử. */
export const OWNER_COLLECTION: Readonly<Partial<Record<OriginalDiagramKind, "functions" | "use_cases">>> = { sequence: "functions", activity: "use_cases" }

/**
 * Phần Spine mà sơ đồ loại đó vẽ ra (nới hơn `sourceProjection` một chút — chỉ dùng để **gợi** vị trí CR; quyết định vẽ
 * lại hay không vẫn theo hash). `project` = phần tử `project` (tên hệ thống trên hình).
 */
export const ORIGINAL_DIAGRAM_DATA: Readonly<Record<OriginalDiagramKind, readonly string[]>> = {
  context: ["project", "actors", "use_cases"],
  usecase: ["project", "actors", "use_cases"],
  screen_flow: ["screens", "actors", "roles", "permissions", "functions", "use_cases"],
  erd: ["entities"],
  sequence: ["functions", "actors"],
  activity: ["use_cases", "actors"],
  deployment: ["deployment_nodes", "deployment_links"]
}

export const ORIGINAL_DIAGRAM_LABELS: Readonly<Record<OriginalDiagramKind, string>> = {
  context: "Sơ đồ ngữ cảnh",
  usecase: "Sơ đồ use case",
  screen_flow: "Sơ đồ luồng màn hình",
  erd: "Sơ đồ quan hệ thực thể",
  sequence: "Sơ đồ tuần tự",
  activity: "Sơ đồ hoạt động",
  deployment: "Sơ đồ triển khai"
}

/** Khoá ẩn / giữ của một sơ đồ gốc: loại gắn function ⇒ `<kind>@<owner>`, loại còn lại ⇒ `<kind>`. */
export const originalKey = (kind: string, ownerId: string | null | undefined): string => (OWNER_DIAGRAM_KINDS.has(kind as OriginalDiagramKind) ? `${kind}@${ownerId ?? ""}` : kind)

/** Khoá của một hình FlintFlow trong `diagrams[]` (so với `keptOriginalKinds`). */
export const diagramKey = (d: Pick<Diagram, "kind" | "owner_id">): string => originalKey(d.kind, d.owner_id)

/** Hash dữ liệu mà sơ đồ loại đó thể hiện — cùng hàm `diagram_stale` dùng cho hình PlantUML. */
export const originalDiagramHash = (spine: Spine, kind: OriginalDiagramKind, ownerId: string | null = null): string =>
  computeSourceHash(spine, { kind, owner_id: OWNER_DIAGRAM_KINDS.has(kind) ? ownerId : null })

/** Giá trị `diagram` ghi lên khối ảnh gốc. */
export const originalDiagramValue = (spine: Spine, kind: OriginalDiagramKind, ownerId: string | null = null): OriginalDiagram => ({
  kind,
  ...(OWNER_DIAGRAM_KINDS.has(kind) ? { owner_id: ownerId } : {}),
  source_hash: originalDiagramHash(spine, kind, ownerId)
})

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

/**
 * Khoá (`originalKey`) của sơ đồ còn hình gốc ⇒ bản render không in hình FlintFlow cùng khoá (tránh hai hình cho một sơ đồ).
 * So hình trong `diagrams[]` bằng `diagramKey`.
 */
export const keptOriginalKinds = (spine: Pick<Spine, "custom_sections">): Set<string> =>
  new Set(keptOriginalDiagrams(spine).map((k) => originalKey(k.diagram.kind, k.diagram.owner_id)))

/** Hình gốc không còn khớp dữ liệu hiện tại (dữ liệu đổi mà hình vẫn là ảnh của người dùng). */
export const isOriginalStale = (spine: Spine, diagram: OriginalDiagram): boolean => originalDiagramHash(spine, diagram.kind, diagram.owner_id ?? null) !== diagram.source_hash

/** Caption chỉ loại sơ đồ (FLF-361) — thứ tự quan trọng: "Use Cases — Screen flow" vẫn là use case. */
const KIND_CAPTION: readonly (readonly [OriginalDiagramKind, RegExp])[] = [
  ["sequence", /sequence|tuần tự/i],
  ["activity", /activity|hoạt động|luồng xử lý/i],
  ["deployment", /deployment|triển khai/i],
  ["usecase", /use[\s-]?cases?/i],
  ["screen_flow", /screens?[\s-]?flow|navigation|luồng màn/i],
  ["erd", /\berd\b|entity[\s-]?relationship|class diagram|data model|quan hệ thực thể/i],
  ["context", /context|ngữ cảnh/i]
]

/** Caption nói là hình khác (ảnh màn hình, state machine…) ⇒ không suy loại theo mục. */
const OTHER_CAPTION = /(layout|screenshot|screen shot|mock-?up|wireframe|prototype|giao diện|state machine|component)/i

/**
 * FLF-361: loại sơ đồ của ảnh gốc **chưa đọc được** (EMF / AI quá tải) — theo caption, không có thì theo mục FPT thường
 * in sơ đồ đó (`ORIGINAL_DIAGRAM_SECTION`). Không suy được ⇒ null. Dùng để vẫn ẩn PlantUML cùng loại (tránh hai hình).
 * `sequence` chỉ suy được trong mục của một function (người gọi lấy chủ từ mục); `activity` không suy (không biết use case chủ).
 */
export const inferDiagramKind = (sectionId: string | null, caption: string): OriginalDiagramKind | null => {
  const byCaption = KIND_CAPTION.find(([, re]) => re.test(caption))
  if (byCaption) {
    if (byCaption[0] === "activity") return null
    return byCaption[0] === "sequence" && !sectionId?.startsWith("function:") ? null : byCaption[0]
  }
  if (OTHER_CAPTION.test(caption) || !sectionId) return null
  return ORIGINAL_DIAGRAM_KINDS.find((k) => !OWNER_DIAGRAM_KINDS.has(k) && ORIGINAL_DIAGRAM_SECTION[k] === sectionId) ?? null
}

/** Chủ (function) của sơ đồ gốc loại gắn function nằm trong mục `sectionId` (`function:<id>`), không có ⇒ null. */
export const ownerOfSection = (sectionId: string | null | undefined): string | null => (sectionId?.startsWith("function:") ? sectionId.slice("function:".length) : null)
