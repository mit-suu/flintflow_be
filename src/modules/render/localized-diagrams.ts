/**
 * localized-diagrams.ts
 * ─────────────────────────────────────────────────────────────────
 * Sơ đồ của bản xem Spine đã dịch (FLF-265 N1): thay `diagrams[].source` TRONG BẢN XEM bằng nguồn sơ đồ theo ngôn ngữ tài
 * liệu. Không ghi Spine, không compile — PNG theo ngôn ngữ do `diagram/localized-diagram.service.ts` vẽ lúc dựng tài liệu
 * (`assemble.service`); chú thích ảnh và câu "Giao diện" của §3.x.y đọc thẳng nguồn đã dịch này.
 *
 * - Hình dựng từ Spine (ngữ cảnh, use case, luồng màn, ERD, bảng function): renderer vẽ lại trên bản xem đã dịch với nhãn
 *   máy theo ngôn ngữ (`renderers/labels.ts`) — chỉ khi nguồn đang lưu khớp từng ký tự với bản renderer sinh từ Spine
 *   gốc hiện tại. Hình cũ (`diagram_stale`), hình đã qua `render_fix`, phần không còn ⇒ giữ nguồn gốc (tài liệu dùng ảnh
 *   gốc). Renderer chia phần theo id / quan hệ, không theo chữ ⇒ bản dịch cùng số phần, cùng thứ tự với bản gốc.
 * - Wireframe model vẽ: thay chữ trên widget theo đơn vị `diagrams[id=…].labels` (`diagram/salt-text.ts`), dòng tên màn
 *   theo tên màn đã dịch; nhãn chưa dịch giữ chữ gốc.
 */

import type { Diagram, Spine } from "../spine/spine.types.js"
import { RENDERERS, type DiagramKind, type RenderedPart } from "../diagram/renderers/index.js"
import { diagramLabelsFor } from "../diagram/renderers/labels.js"
import { isWireframeSalt, localizeSalt } from "../diagram/salt-text.js"
import type { DiagramSource } from "../diagram/localized-diagram.service.js"

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase()

const screenName = (spine: Spine, id: string | null): string | undefined =>
  id === null ? undefined : spine.screens.find((s) => s.id === id)?.name

/**
 * Đặt nguồn sơ đồ theo `language` vào `view.diagrams` (bản clone của `canonical` đã thay chữ dịch). `wireframeText`: nhãn
 * wireframe đã dịch theo id sơ đồ, chữ gốc ⇒ chữ dịch.
 */
export const localizeDiagrams = (
  canonical: Spine,
  view: Spine,
  language: string,
  wireframeText: ReadonlyMap<string, ReadonlyMap<string, string>>
): void => {
  const labels = diagramLabelsFor(language)
  const parts = new Map<string, { source: RenderedPart[]; localized: RenderedPart[] }>()
  const partsOf = (kind: DiagramKind, ownerId: string | null) => {
    const key = `${kind}:${ownerId ?? ""}`
    let found = parts.get(key)
    if (!found) {
      found = { source: RENDERERS[kind](canonical, ownerId), localized: RENDERERS[kind](view, ownerId, labels) }
      parts.set(key, found)
    }
    return found
  }

  const localized = (source: Diagram): string => {
    if (source.format === "puml" && isWireframeSalt(source.source)) {
      const title = screenName(canonical, source.owner_id)
      const translatedTitle = screenName(view, source.owner_id)
      const words = wireframeText.get(source.id)
      return localizeSalt(source.source, (text) =>
        title !== undefined && normalize(text) === normalize(title) ? translatedTitle : words?.get(text)
      )
    }
    const { source: before, localized: after } = partsOf(source.kind, source.owner_id)
    const index = before.findIndex((part) => part.format === source.format && part.source === source.source)
    const part = index >= 0 && after.length === before.length ? after[index] : undefined
    if (!part || part.format !== source.format) return source.source
    // Chữ dịch dài hơn làm vỡ bố cục SVG ⇒ tài liệu dùng ảnh gốc, không in hình đè chữ
    if (part.issues?.length) {
      console.warn(`[diagram] Bản ${language} của ${source.id} vi phạm bố cục — dùng ảnh gốc: ${part.issues.map((i) => `${i.rule} ${i.message}`).join("; ")}`)
      return source.source
    }
    return part.source
  }

  const sources = new Map(canonical.diagrams.map((d) => [d.id, d]))
  for (const diagram of view.diagrams) {
    const source = sources.get(diagram.id)
    if (source?.render_status === "ok") diagram.source = localized(source)
  }
}

/** Nguồn sơ đồ đã dịch khác nguồn gốc: id ⇒ nguồn theo ngôn ngữ. Sơ đồ chưa đổi chữ nào dùng thẳng ảnh gốc. */
export const changedDiagramSources = (canonical: Spine, view: Spine): Map<string, DiagramSource> => {
  const before = new Map(canonical.diagrams.map((d) => [d.id, d.source]))
  return new Map(
    view.diagrams
      .filter((d) => d.render_status === "ok" && before.has(d.id) && before.get(d.id) !== d.source)
      .map((d) => [d.id, { format: d.format, source: d.source }])
  )
}
