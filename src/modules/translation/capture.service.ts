/**
 * capture.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Lưu bản ngôn ngữ tài liệu mà lượt AI ghi Spine trả kèm (FLF-265 D16, plan phase 2 §2.7).
 *
 * Gọi SAU khi `applyTransaction` thành công, ngoài transaction: Spine đã ghi xong (tiếng Anh, không đổi), giờ mới tách
 * đơn vị từ cặp (value Anh của op, value dịch cùng `path`) ⇒ `SpineTranslation` theo hash câu Anh, `origin: 'author'`
 * (thắng bản `machine` cùng hash). Tên actor / màn / entity / feature vừa dịch ⇒ glossary `model` (đè bản `model` cũ).
 *
 * Không bao giờ làm hỏng lượt ghi: lỗi chỉ log. Bỏ qua đúng phần lỗi — path không khớp op, hình dạng lệch, mảng khác
 * độ dài, op `remove` / `renumber` — phần đó thành "thiếu" và dịch theo lô sau (`POST /translations/run`).
 */

import type { LocalizedEntry } from "../../shared/ai/response-parser.js"
import type { UserLocale } from "../../shared/i18n/locale.js"
import type { Op } from "../spine/op.types.js"
import * as repository from "./translation.repository.js"
import { learnGlossary } from "./glossary.service.js"
import { copiedSource, hashSource, unitsOfValue, type LocalizedUnit } from "./translation-units.js"
import type { TurnLanguagePair } from "./turn-language.js"

/** Op mang chữ: `set` / `add` có `value`. `remove` / `renumber` / op hệ thống không có gì để dịch. */
const carriesText = (op: Pick<Op, "op" | "value">): boolean => (op.op === "set" || op.op === "add") && op.value !== undefined

type TextOp = Pick<Op, "op" | "path" | "value">

/** `id` chuỗi của giá trị một phần tử (`{ id: "FN3", … }`); không phải object / không có id ⇒ `undefined`. */
const idOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const id = (value as Record<string, unknown>).id
  return typeof id === "string" && id ? id : undefined
}

/** Ghép các mục `localized` của MỘT path với op cùng path. Trả các cặp (op, mục) đã ghép. */
const pairEntries = (candidates: readonly TextOp[], entries: readonly LocalizedEntry[]): LocalizedUnit[] => {
  // Một op: mục đầu tiên ghép được (id lệch ⇒ `unitsOfValue` trả rỗng ⇒ thử mục sau)
  if (candidates.length === 1) {
    for (const entry of entries) {
      const units = unitsOfValue(candidates[0].path, candidates[0].value, entry.value)
      if (units.length > 0) return units
    }
    return []
  }
  // Nhiều op cùng path (`add functions[]` × N): ghép theo `id`. Mục thiếu id chỉ ghép theo vị trí khi số mục = số op
  // VÀ mọi mục có id đứng đúng vị trí op của nó (thứ tự đáng tin) — không thì bỏ, thà "thiếu" còn hơn gán nhầm phần tử.
  const indexById = entries.map((entry) => {
    const id = idOf(entry.value)
    return id === undefined ? undefined : candidates.findIndex((op) => idOf(op.value) === id)
  })
  const inOrder = entries.length === candidates.length && indexById.every((index, i) => index === undefined || index === i)
  const taken = new Set<number>()
  const out: LocalizedUnit[] = []
  entries.forEach((entry, i) => {
    const id = idOf(entry.value)
    const index =
      id !== undefined
        ? candidates.findIndex((op, k) => !taken.has(k) && idOf(op.value) === id)
        : inOrder && !taken.has(i)
          ? i
          : -1
    if (index < 0) return
    const units = unitsOfValue(candidates[index].path, candidates[index].value, entry.value)
    if (units.length === 0) return
    taken.add(index)
    out.push(...units)
  })
  return out
}

/**
 * Ghép từng mục `localized` với op cùng `path` (hàm thuần) ⇒ các cặp (hash câu Anh, câu dịch).
 * - `set` lặp lại cùng path ⇒ chỉ op CUỐI (giá trị thắng trong Spine) được ghép.
 * - Nhiều op `add` cùng path ⇒ ghép theo `id` (`pairEntries`), không đoán; op `add` chưa có id (server cấp lúc áp) ⇒
 *   ghép theo vị trí khi số mục = số op.
 * - Bỏ đơn vị model chép nguyên câu Anh (`copiedSource`).
 */
export const localizedUnitsOf = (ops: readonly TextOp[], localized: readonly LocalizedEntry[]): LocalizedUnit[] => {
  const byPath = new Map<string, TextOp[]>()
  for (const op of ops) {
    if (!carriesText(op)) continue
    // `set` ghi đè mọi giá trị trước đó của path ⇒ op trước không còn trong Spine
    byPath.set(op.path, op.op === "set" ? [op] : [...(byPath.get(op.path) ?? []), op])
  }
  const entriesByPath = new Map<string, LocalizedEntry[]>()
  for (const entry of localized) {
    if (!byPath.has(entry.path)) continue
    entriesByPath.set(entry.path, [...(entriesByPath.get(entry.path) ?? []), entry])
  }
  return [...entriesByPath].flatMap(([path, entries]) => pairEntries(byPath.get(path) ?? [], entries)).filter((unit) => !copiedSource(unit))
}

/** Chỉ số ở cuối path (`project.goals[0]`, `functions[id=FN1].normal[2]`). */
const TRAILING_INDEX = /^(.+)\[(\d+)\]$/

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string")

/** Mục `localized` nhắm một dòng của mảng chuỗi mà op đã được viết lại thành `set` cả mảng (`expandIndexSelectors`). */
export interface IndexedEntry {
  /** Path cả mảng (path của op sau khi viết lại). */
  path: string
  index: number
  /** Giá trị Anh của cả mảng sau lượt ghi. */
  value: string[]
  /** Câu dịch của đúng dòng đó. */
  text: string
}

/**
 * P07 (T8, câu 10): model sửa một dòng bằng chỉ số (`set project.goals[0]`) và trả `localized` cùng path đó, nhưng server đã
 * viết op thành `set project.goals` cả mảng ⇒ không ghép được, mục tiêu vừa sửa thành "chưa dịch". Trả các mục như vậy để
 * ghép lại với bản dịch cũ của mảng (hàm thuần).
 */
export const indexedEntriesOf = (ops: readonly TextOp[], localized: readonly LocalizedEntry[]): IndexedEntry[] => {
  const opPaths = new Set(ops.filter(carriesText).map((op) => op.path))
  const out: IndexedEntry[] = []
  for (const entry of localized) {
    if (opPaths.has(entry.path) || typeof entry.value !== "string") continue
    const match = TRAILING_INDEX.exec(entry.path)
    if (!match) continue
    const op = [...ops].reverse().find((o) => o.op === "set" && o.path === match[1])
    if (!op || !isStringArray(op.value)) continue
    const index = Number(match[2])
    if (index >= op.value.length) continue
    out.push({ path: match[1], index, value: op.value, text: entry.value })
  }
  return out
}

/** Giá trị trước lượt ghi của một path (bản ghi `changes` mới nhất của path đó). */
export type PreviousValueLoader = (projectId: string, path: string) => Promise<unknown>

const previousValueFromChanges: PreviousValueLoader = async (projectId, path) => {
  const { Change } = await import("../spine/change.model.js")
  const row = await Change.findOne({ projectId, path }, { before: 1 }).sort({ seq: -1 }).lean<{ before?: unknown }>()
  return row?.before
}

/**
 * Đơn vị cho các mục nhắm một dòng: bản dịch cũ của cả mảng (theo hash giá trị trước lượt ghi) thay đúng dòng vừa sửa. Mảng
 * một dòng không cần bản cũ. Không có bản cũ / lệch độ dài ⇒ bỏ (để "thiếu", dịch theo lô sau) — không đoán các dòng còn lại.
 */
const indexedUnits = async (
  projectId: string,
  locale: UserLocale,
  entries: readonly IndexedEntry[],
  loadPrevious: PreviousValueLoader
): Promise<LocalizedUnit[]> => {
  const out: LocalizedUnit[] = []
  for (const entry of entries) {
    let translated: string[] | null = entry.value.length === 1 ? [entry.text] : null
    if (!translated) {
      const before = await loadPrevious(projectId, entry.path)
      if (!isStringArray(before) || before.length !== entry.value.length) continue
      const old = (await repository.findByHashes(projectId, locale, [hashSource(before)])).get(hashSource(before))?.text
      if (!isStringArray(old) || old.length !== before.length) continue
      translated = [...old]
      translated[entry.index] = entry.text
    }
    out.push(...unitsOfValue(entry.path, entry.value, translated))
  }
  return out
}

/**
 * Lưu bản `author` cho các op vừa áp. Trả số đơn vị đã lưu (0 khi không có gì / lỗi). Ngôn ngữ đích = ngôn ngữ gốc ⇒
 * không lưu gì (không có gì để dịch).
 */
export const captureLocalized = async (
  projectId: string,
  locale: UserLocale,
  sourceLocale: UserLocale,
  ops: readonly Pick<Op, "op" | "path" | "value">[],
  localized: readonly LocalizedEntry[] | null | undefined,
  loadPrevious: PreviousValueLoader = previousValueFromChanges
): Promise<number> => {
  if (!localized || localized.length === 0 || locale === sourceLocale) return 0
  try {
    const units = [...localizedUnitsOf(ops, localized), ...(await indexedUnits(projectId, locale, indexedEntriesOf(ops, localized), loadPrevious))]
    if (units.length === 0) return 0
    await repository.saveTranslations(
      projectId,
      locale,
      sourceLocale,
      units.map(({ sourceHash, text }) => ({ sourceHash, text })),
      "author"
    )
    try {
      // Bản `author` là bản đang thắng ⇒ glossary theo đúng tên tài liệu đang hiện (`replace`, không đè `seed`)
      await learnGlossary(projectId, locale, units, true)
    } catch (err) {
      console.warn("[captureLocalized] Không học được glossary từ tên vừa dịch:", err)
    }
    return units.length
  } catch (err) {
    console.warn("[captureLocalized] Không lưu được bản dịch kèm lượt ghi - các câu này thành 'thiếu':", err)
    return 0
  }
}

/** `captureLocalized` theo ngôn ngữ của lượt (`documentLanguageForTurn`); lượt không có ngôn ngữ tài liệu ⇒ không làm gì. */
export const captureForTurn = async (
  projectId: string,
  language: TurnLanguagePair | null | undefined,
  ops: readonly Pick<Op, "op" | "path" | "value">[],
  localized: readonly LocalizedEntry[] | null | undefined
): Promise<number> => (language ? captureLocalized(projectId, language.locale, language.source, ops, localized) : 0)
