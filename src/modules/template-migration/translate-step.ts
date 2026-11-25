/**
 * Bước dịch của đổi mẫu khác ngôn ngữ: dịch chữ Spine **đè vào Spine** (ghi như một thay đổi, hoàn tác được) — khác lớp bản dịch
 * ngoài Spine của mode 2. Chưa ghi gì: trả danh sách op `set` để bước áp dụng ghi trong cùng lô với các op khác.
 *
 *  - Tên phần tử (actor / màn / entity / tính năng) dịch trước, thân sau; tên đã dịch vào thuật ngữ tạm của lượt này để thân dùng
 *    đúng chữ (không ghi glossary DB — bản dịch của lần đổi mẫu không phải bản dịch lớp ngoài).
 *  - Mỗi lô một lượt `executeAiAction(TRANSLATE_DOCUMENT)` ⇒ giữ / trừ credit theo lô như dịch thường. Phần đã dịch được lưu qua
 *    `onBatch` để lần chạy lại không dịch (không trừ) lần hai.
 *  - Lô không nhận đủ đơn vị (0 hay một phần — key lạ, lệch hình dạng, chép nguyên câu, hoặc model trả lỗi parse 422) KHÔNG ném:
 *    phần chưa nhận được gom lại, thử lại bằng cách chia đôi lô hỏng (dừng khi lô còn ≤5 đơn vị hoặc hết ngân sách thử lại —
 *    tối đa thêm 50% số lô ban đầu, không quá 10 lượt). Đơn vị vẫn hỏng sau cùng ⇒ giữ chữ gốc, ghi key vào `untranslated_keys`
 *    để bước áp dụng báo BA theo tên mục (FLF-471 — trước đây ném 502, hỏng cả lượt áp dụng và lặp lại mãi vì lô hỏng luôn
 *    đứng đầu hàng dịch lại).
 *  - Chỉ ném khi: hết credit (402), lỗi nhà cung cấp mà `executeAiAction` đã tự thử lại vẫn không qua, hoặc lượt bị huỷ — phần
 *    đã dịch trước đó vẫn được giữ qua `onBatch`.
 *  - Nhãn wireframe trong `diagrams[].source` không có field Spine để ghi ⇒ không dịch ở đây (ghi chú trong `skipped`).
 */
import type { UserLocale } from "../../shared/i18n/locale.js"
import { formatGlossary, glossaryFor, isNameUnit, namesOf, seedEntriesOf } from "../translation/glossary.service.js"
import { acceptBatchItemsWithReasons, defaultTranslateDocumentExecutor, type RejectReason, type TranslateDocumentExecutor } from "../translation/translation-run.service.js"
import { hashSource, readUnitField, translationUnits, writeUnitField, fitTranslation, type TranslationUnit, type UnitRef, type UnitValue } from "../translation/translation-units.js"
import { splitBatches, uniqueBatchItems, type BatchItem } from "../translation/translation.service.js"
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
  /** Đơn vị giữ chữ gốc vì model không dịch được dù đã thử lại (chia nhỏ lô) — bằng `untranslated_keys.length`. */
  untranslated: number
  /** Key các đơn vị ở trên — bước áp dụng map sang tên mục để báo BA (FLF-471). */
  untranslated_keys: string[]
  /** Đơn vị bỏ qua vì không có field Spine để ghi (nhãn wireframe). */
  skipped: number
}

const statusOf = (err: unknown): number | undefined => (typeof err === "object" && err !== null && "statusCode" in err ? (err as { statusCode?: number }).statusCode : undefined)

/** Lô model trả sai định dạng (parser 422) — executor đã nhả credit, lô này xử lý như lô không nhận được đơn vị nào: thử lại chia nhỏ. */
const isParseError = (err: unknown): boolean => statusOf(err) === 422

/** Lô hỏng chỉ thử lại chia đôi tới khi còn ≤5 đơn vị — dưới mức này chia tiếp không còn ý nghĩa (lô quá nhỏ, phí lượt gọi). */
const MIN_RETRY_BATCH_UNITS = 5
/** Ngân sách lượt gọi thêm cho thử lại: tối đa 50% số lô ban đầu, không quá 10 lượt (Cần chốt #2 của plan — không hoàn credit lượt loại hết). */
const MAX_RETRY_EXTRA_RATIO = 0.5
const MAX_RETRY_EXTRA_CAP = 10

const splitInHalf = (items: BatchItem[]): BatchItem[][] => {
  const mid = Math.ceil(items.length / 2)
  return [items.slice(0, mid), items.slice(mid)]
}

const REASON_LABELS: Record<RejectReason, string> = { missing: "key lạ/thiếu", shape_mismatch: "lệch hình dạng", copied_source: "chép nguyên câu gốc" }

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
  const untranslatedKeys = new Set<string>()
  const initialBatches = splitBatches(uniqueBatchItems(pending))
  const retryBudget = Math.min(Math.ceil(initialBatches.length * MAX_RETRY_EXTRA_RATIO), MAX_RETRY_EXTRA_CAP)
  let retriesUsed = 0
  const queue: BatchItem[][] = [...initialBatches]

  const giveUp = (items: BatchItem[]): void => {
    for (const item of items) untranslatedKeys.add(item.key)
  }
  // Lô vẫn hỏng: chia đôi thử lại trong ngân sách, hết ngân sách hoặc lô đã ≤5 đơn vị ⇒ giữ chữ gốc, không thử nữa.
  const retry = (items: BatchItem[]): void => {
    if (items.length === 0) return
    if (items.length > MIN_RETRY_BATCH_UNITS && retriesUsed < retryBudget) {
      const parts = splitInHalf(items)
      retriesUsed += parts.length
      queue.push(...parts)
      return
    }
    giveUp(items)
  }

  while (queue.length > 0) {
    const batch = queue.shift()!
    let result
    try {
      result = await executor(
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
    } catch (err) {
      // 402 hết credit / lỗi nhà cung cấp sau khi executor đã tự thử lại ⇒ ném thật — phần đã dịch trước đó đã lưu qua onBatch.
      if (!isParseError(err)) throw err
      console.warn(`[TemplateMigration] Lô dịch đổi mẫu lỗi parse (422), thử lại chia nhỏ — ${batch.length} đơn vị:`, err)
      retry(batch)
      continue
    }
    creditsUsed += result.cost ?? 0
    const { accepted, rejected } = acceptBatchItemsWithReasons(batch, result.data.items)
    for (const a of accepted) done.set(a.sourceHash, { key: a.key, source_hash: a.sourceHash, text: a.text })
    glossary.push(...namesOf(accepted))
    if (input.onBatch) await input.onBatch([...done.values()])
    if (rejected.length > 0) {
      const byReason = new Map<RejectReason, number>()
      for (const r of rejected) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1)
      const breakdown = [...byReason].map(([reason, count]) => `${REASON_LABELS[reason]}=${count}`).join(", ")
      console.warn(
        `[TemplateMigration] Lô dịch đổi mẫu nhận ${accepted.length}/${batch.length} đơn vị (logId=${result.logId}) — loại: ${breakdown}. rawText (2000 ký tự đầu): ${result.rawText.slice(0, 2000)}`
      )
      retry(rejected.map((r) => r.item))
    }
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
  return { units: out, ops, credits_used: creditsUsed, untranslated: untranslatedKeys.size, untranslated_keys: [...untranslatedKeys], skipped }
}
