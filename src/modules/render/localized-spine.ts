/**
 * localized-spine.ts
 * ─────────────────────────────────────────────────────────────────
 * Bản xem Spine đã dịch (FLF-265 D11): bản sao Spine gốc trong bộ nhớ, chữ ở mỗi đơn vị dịch (`translation-units.ts` —
 * field theo id, mảng chuỗi là một đơn vị) thay bằng bản dịch tra theo key; đơn vị chưa dịch giữ chữ gốc. Chỉ sống trong
 * một lượt render (`assemble.service#buildDocumentParts`), không ghi đi đâu.
 *
 * `LocalizedSpine` cố ý KHÔNG phải `Spine` — Spine đã dịch nằm sau một khoá symbol không xuất ra ngoài — nên không
 * truyền nhầm được vào op-engine, deterministic-check, prompt / projection hay `computeSourceHash`: mọi chỗ đó chạy trên
 * chữ gốc (luật `non_english_content`, hash sơ đồ…). Đường render lấy Spine đã dịch qua đúng một cửa là `renderView`;
 * thứ tự, số hiệu, trạng thái và logic dựa chữ Anh vẫn quyết trên Spine gốc (`SectionRenderContext.canonical`).
 * N1: `diagrams[].source` của bản xem là nguồn sơ đồ theo ngôn ngữ tài liệu (`localized-diagrams.ts`) — ảnh PNG theo nguồn
 * đó do `assemble.service` nạp / vẽ, `diagrams[]` của Spine không đổi.
 */

import type { Spine } from "../spine/spine.types.js"
import type { DiagramSource } from "../diagram/localized-diagram.service.js"
import { fitTranslation, readUnitField, writeUnitField, type TranslationUnit, type UnitRef, type UnitValue } from "../translation/translation-units.js"
import { changedDiagramSources, localizeDiagrams } from "./localized-diagrams.js"

const VIEW: unique symbol = Symbol("LocalizedSpine")

/** Spine đã thay chữ dịch — chỉ đọc được qua `renderView`. */
export interface LocalizedSpine {
  readonly [VIEW]: Spine
}

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value)

const byId = (list: unknown, id: string | null): Row | undefined =>
  Array.isArray(list) ? list.find((row): row is Row => isRow(row) && row.id === id) : undefined

/**
 * Chỗ chứa field của đơn vị: `project` (`release_scope.in` ⇒ object `release_scope`), phần tử theo id, validation theo id
 * trong function. Không tìm thấy ⇒ `null`.
 */
const slotOf = (view: Spine, ref: UnitRef): { owner: Row; field: string } | null => {
  if (ref.group === "project") {
    const path = ref.field.split(".")
    const field = path.pop() ?? ref.field
    const owner = path.reduce<unknown>((acc, part) => (isRow(acc) ? acc[part] : undefined), view.project)
    return isRow(owner) ? { owner, field } : null
  }
  const element = byId(view[ref.group], ref.id)
  const owner = element && ref.validation_id !== undefined ? byId(element.validations, ref.validation_id) : element
  return owner ? { owner, field: ref.field } : null
}

/**
 * Bản xem đã dịch của `spine`. `units` là `translationUnits(spine)` của CHÍNH Spine này, `translations` là key ⇒ chữ dịch
 * (`translation.service#resolveTranslations().map`). Thay khi có key VÀ chữ dịch cùng hình dạng với giá trị đang ở đúng
 * chỗ đó (`fitTranslation`: chuỗi ⇔ chuỗi, mảng ⇔ mảng cùng độ dài) — logic chọn theo chỉ số trên Spine gốc lấy phần tử
 * dịch ở cùng chỉ số. Không có key / lệch hình dạng ⇒ giữ chữ gốc. Không sửa `spine` (clone sâu).
 * `language` (N1): có ⇒ nguồn sơ đồ trong bản xem cũng theo ngôn ngữ đó (`localized-diagrams.ts`); không ⇒ giữ nguồn gốc.
 */
export const localizeSpine = (
  spine: Spine,
  units: readonly TranslationUnit[],
  translations: ReadonlyMap<string, UnitValue>,
  language?: string
): LocalizedSpine => {
  const view = structuredClone(spine)
  /** Nhãn wireframe đã dịch theo id sơ đồ: chữ gốc ⇒ chữ dịch. */
  const wireframeText = new Map<string, Map<string, string>>()
  for (const unit of units) {
    const translated = translations.get(unit.key)
    if (translated === undefined) continue
    if (unit.ref.group === "diagrams") {
      const text = fitTranslation(unit.value, translated)
      if (unit.ref.id && Array.isArray(unit.value) && Array.isArray(text)) {
        wireframeText.set(unit.ref.id, new Map(unit.value.map((source, i) => [source, text[i]])))
      }
      continue
    }
    const slot = slotOf(view, unit.ref)
    const source = slot ? readUnitField(slot.owner, slot.field) : null
    const text = source === null ? null : fitTranslation(source, translated)
    if (slot && text !== null) writeUnitField(slot.owner, slot.field, text)
  }
  if (language) localizeDiagrams(spine, view, language, wireframeText)
  return { [VIEW]: view }
}

/**
 * Cửa DUY NHẤT lấy Spine đã dịch — chỉ cho đường render (`assemble.service` ⇒ `section-renderer`, tên mục của phụ lục
 * cờ). Không đưa kết quả vào op-engine, check, prompt hay hash: các chỗ đó cần Spine gốc.
 */
export const renderView = (localized: LocalizedSpine): Spine => localized[VIEW]

/**
 * Sơ đồ có nguồn theo ngôn ngữ khác nguồn gốc của `spine` (N1): id ⇒ nguồn cần ảnh riêng. Sơ đồ không đổi chữ nào ⇒ không
 * có mặt, tài liệu dùng thẳng ảnh gốc.
 */
export const localizedDiagramSources = (spine: Spine, localized: LocalizedSpine): Map<string, DiagramSource> =>
  changedDiagramSources(spine, localized[VIEW])
