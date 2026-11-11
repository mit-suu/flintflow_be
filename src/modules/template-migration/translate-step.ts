/**
 * Bước dịch của đổi mẫu khác ngôn ngữ: dịch chữ Spine **đè vào Spine** (ghi như một thay đổi, hoàn tác được) — khác lớp bản dịch
 * ngoài Spine của mode 2. Chưa ghi gì: trả danh sách op `set` để bước áp dụng ghi trong cùng lô với các op khác.
 *
 *  - Tên phần tử (actor / màn / entity / tính năng) dịch trước, thân sau; tên đã dịch vào thuật ngữ tạm của lượt này để thân dùng
 *    đúng chữ (không ghi glossary DB — bản dịch của lần đổi mẫu không phải bản dịch lớp ngoài).
 *  - Mỗi lô một lượt `executeAiAction(TRANSLATE_DOCUMENT)` ⇒ giữ / trừ credit theo lô như dịch thường; lỗi giữa chừng ⇒ ném, phần
 *    đã dịch được lưu qua `onBatch` để lần chạy lại không dịch (không trừ) lần hai.
 *  - Lô lỗi / không nhận được đơn vị nào ⇒ ném (không ghi nửa chừng). Đơn vị model chép nguyên câu gốc (`copiedSource`) ⇒ giữ chữ gốc,
 *    đếm vào `untranslated` để báo BA.
 *  - Nhãn wireframe trong `diagrams[].source` không có field Spine để ghi ⇒ không dịch ở đây (ghi chú trong `skipped`).
 */
import type { UserLocale } from "../../shared/i18n/locale.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { formatGlossary, glossaryFor, isNameUnit, namesOf, seedEntriesOf } from "../translation/glossary.service.js"
import { acceptBatchItems, defaultTranslateDocumentExecutor, type TranslateDocumentExecutor } from "../translation/translation-run.service.js"
import { hashSource, readUnitField, translationUnits, writeUnitField, fitTranslation, type TranslationUnit, type UnitRef, type UnitValue } from "../translation/translation-units.js"
import { splitBatches, uniqueBatchItems } from "../translation/translation.service.js"
import type { Op } from "../spine/op.types.js"
import type { Spine } from "../spine/spine.types.js"
import type { GlossaryEntry } from "../translation/translation.repository.js"
import type { MigrationTranslatedUnit } from "./template-migration.model.js"

const LANGUAGE_NAMES: Record<UserLocale, string> = { vi: "Vietnamese", en: "English" }

export const TRANSLATION_INCOMPLETE = "TEMPLATE_MIGRATION_TRANSLATION_FAILED"

export interface TranslateStepInput {
  projectId: string
  userId: string
  spine: Spine
  source: UserLocale
  target: UserLocale
  /** Bản dịch đã có của lần đổi mẫu này (chạy lại không dịch lại, không trừ credit). */
  stored?: readonly MigrationTranslatedUnit[]
  /** Chỉ dịch các đơn vị thoả điều kiện (đổi ngược chỉ dịch mục đã sửa mà BA giữ). Mặc định: mọi đơn vị. */
  filter?: (unit: TranslationUnit) => boolean
  /** Gọi sau mỗi lô thành công với toàn bộ bản dịch đã có — người gọi lưu lại để chạy lại không mất. */
  onBatch?: (units: MigrationTranslatedUnit[]) => Promise<void>
  executor?: TranslateDocumentExecutor
}

export interface TranslateStepResult {
  units: MigrationTranslatedUnit[]
  /** Op `set` ghi chữ dịch vào Spine (đường dẫn = key đơn vị). */
  ops: Op[]
  credits_used: number
  /** Đơn vị giữ chữ gốc vì model chép lại nguyên câu. */
  untranslated: number
  /** Đơn vị bỏ qua vì không có field Spine để ghi (nhãn wireframe). */
  skipped: number
}

type Row = Record<string, unknown>
const isRow = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v)

const byId = (list: unknown, id: string | null): Row | undefined => (Array.isArray(list) ? list.find((r): r is Row => isRow(r) && r.id === id) : undefined)

/** Chỗ chứa field của đơn vị trong Spine (project lồng `release_scope.in`, phần tử theo id, validation theo id). */
const slotOf = (spine: Spine, ref: UnitRef): { owner: Row; field: string } | null => {
  if (ref.group === "project") {
    const path = ref.field.split(".")
    const field = path.pop() ?? ref.field
    const owner = path.reduce<unknown>((acc, part) => (isRow(acc) ? acc[part] : undefined), spine.project)
    return isRow(owner) ? { owner, field } : null
  }
  if (ref.group === "diagrams") return null
  const element = byId(spine[ref.group], ref.id)
  const owner = element && ref.validation_id !== undefined ? byId(element.validations, ref.validation_id) : element
  return owner ? { owner, field: ref.field } : null
}

/** Name-first: tên dịch trước để thuật ngữ dùng thống nhất ở thân. Giữ thứ tự gốc trong mỗi nhóm. */
const nameFirst = (units: readonly TranslationUnit[]): TranslationUnit[] => [...units.filter(isNameUnit), ...units.filter((u) => !isNameUnit(u))]

export const translateForMigration = async (input: TranslateStepInput): Promise<TranslateStepResult> => {
  const executor = input.executor ?? defaultTranslateDocumentExecutor
  const all = translationUnits(input.spine).filter((u) => !input.filter || input.filter(u))
  const units = all.filter((u) => u.ref.group !== "diagrams")
  const skipped = all.length - units.length

  const done = new Map<string, MigrationTranslatedUnit>() // theo hash chữ gốc
  for (const s of input.stored ?? []) done.set(s.source_hash, s)
  const hashOf = new Map(units.map((u) => [u.key, hashSource(u.value)]))
  const pending = nameFirst(units.filter((u) => !done.has(hashOf.get(u.key)!)))

  const glossary: GlossaryEntry[] = seedEntriesOf(input.target, input.spine.glossary)
  for (const s of input.stored ?? []) {
    const src = units.find((u) => hashOf.get(u.key) === s.source_hash)
    if (src) glossary.push(...namesOf([{ key: src.key, source: src.value, text: s.text }]))
  }

  let creditsUsed = 0
  let untranslated = 0
  const batches = splitBatches(uniqueBatchItems(pending))
  for (const batch of batches) {
    const result = await executor(
      {
        promptVariables: {
          source_language: LANGUAGE_NAMES[input.source],
          target_language: LANGUAGE_NAMES[input.target],
          glossary: formatGlossary(glossaryFor(glossary, batch.map((item) => item.text))),
          items: JSON.stringify(batch.map(({ key, text }) => ({ key, text })), null, 2)
        }
      },
      input.projectId,
      input.userId
    )
    creditsUsed += result.cost ?? 0
    const accepted = acceptBatchItems(batch, result.data.items)
    if (!accepted.length) throw new ApiError(502, "Dịch lô nội dung không trả về bản dịch hợp lệ nào. Chưa ghi gì vào tài liệu - thử áp dụng lại.", TRANSLATION_INCOMPLETE)
    for (const a of accepted) done.set(a.sourceHash, { key: a.key, source_hash: a.sourceHash, text: a.text })
    untranslated += batch.length - accepted.length
    glossary.push(...namesOf(accepted))
    if (input.onBatch) await input.onBatch([...done.values()])
  }

  // Ghi chữ dịch lên bản sao Spine để lấy giá trị field thật (mảng chữ của entity, cạnh luồng màn… có hình riêng)
  const view = structuredClone(input.spine)
  const ops: Op[] = []
  const out: MigrationTranslatedUnit[] = []
  for (const unit of units) {
    const hit = done.get(hashOf.get(unit.key)!)
    if (!hit) continue
    const slot = slotOf(view, unit.ref)
    const current = slot ? readUnitField(slot.owner, slot.field) : null
    const text: UnitValue | null = current === null ? null : fitTranslation(current, hit.text)
    if (!slot || text === null) continue
    writeUnitField(slot.owner, slot.field, text)
    ops.push({ op: "set", path: unit.key, value: slot.owner[slot.field], reason: "Dịch theo ngôn ngữ của mẫu mới" })
    out.push({ key: unit.key, source_hash: hit.source_hash, text: hit.text })
  }
  return { units: out, ops, credits_used: creditsUsed, untranslated, skipped }
}
