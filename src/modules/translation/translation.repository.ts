/**
 * translation.repository.ts
 * ─────────────────────────────────────────────────────────────────
 * Đọc / ghi lớp bản dịch (FLF-265) — nơi DUY NHẤT chạm `SpineTranslation`, `TranslationGlossary`, `TranslationRunLock`.
 * Luật ưu tiên nằm ở câu lệnh ghi, không ở chỗ gọi:
 * - `author` (lượt AI ghi Spine trả kèm, D16) ghi đè mọi bản cùng hash;
 * - `machine` (dịch theo lô) chỉ chèn khi chưa có — không bao giờ đè `author` (và bản `machine` có trước);
 * - glossary `seed` (từ `term_native`) ghi đè; `model` (học từ tên đã dịch) chỉ chèn, trừ khi `replace` (không đè `seed`);
 * - khoá `TranslationRunLock`: một lượt dịch theo lô mỗi (dự án, ngôn ngữ).
 */

import { randomUUID } from "node:crypto"
import mongoose from "mongoose"
import type { UserLocale } from "../../shared/i18n/locale.js"
import { SpineTranslation, type TranslationOrigin } from "./spine-translation.model.js"
import { TranslationGlossary, type GlossaryOrigin } from "./translation-glossary.model.js"
import { TranslationRunLock } from "./translation-run-lock.model.js"
import type { UnitValue } from "./translation-units.js"

export interface StoredTranslation {
  sourceHash: string
  text: UnitValue
  origin: TranslationOrigin
}

export interface TranslationEntry {
  sourceHash: string
  text: UnitValue
}

export interface GlossaryEntry {
  term: string
  translation: string
}

const oid = (id: string) => new mongoose.Types.ObjectId(id)

const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === 11000

/** Một truy vấn `$in` theo hash — không có hash nào ⇒ không truy vấn. */
export const findByHashes = async (projectId: string, locale: UserLocale, hashes: string[]): Promise<Map<string, StoredTranslation>> => {
  const unique = [...new Set(hashes)]
  if (unique.length === 0) return new Map()
  const rows = await SpineTranslation.find(
    { projectId: oid(projectId), locale, sourceHash: { $in: unique } },
    { sourceHash: 1, text: 1, origin: 1 }
  ).lean()
  return new Map(rows.map((row) => [row.sourceHash, { sourceHash: row.sourceHash, text: row.text, origin: row.origin }]))
}

/**
 * Lưu bản dịch theo hash. Trùng hash trong cùng lô ⇒ giữ bản đầu. Hai request cùng chèn một hash lần đầu ⇒ một bên
 * dính unique index: `machine` bỏ qua (bên kia đã có bản), `author` thử lại một lần để ghi đè.
 */
export const saveTranslations = async (
  projectId: string,
  locale: UserLocale,
  sourceLocale: UserLocale,
  entries: TranslationEntry[],
  origin: TranslationOrigin
): Promise<void> => {
  const byHash = new Map<string, UnitValue>()
  for (const entry of entries) if (!byHash.has(entry.sourceHash)) byHash.set(entry.sourceHash, entry.text)
  if (byHash.size === 0) return

  const now = new Date()
  const ops = [...byHash].map(([sourceHash, text]) => ({
    updateOne: {
      filter: { projectId: oid(projectId), locale, sourceHash },
      update:
        origin === "author"
          ? { $set: { text, origin, sourceLocale }, $setOnInsert: { createdAt: now } }
          : { $setOnInsert: { text, origin, sourceLocale, createdAt: now } },
      upsert: true
    }
  }))
  try {
    await SpineTranslation.bulkWrite(ops, { ordered: false })
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err
    if (origin === "author") await SpineTranslation.bulkWrite(ops, { ordered: false })
  }
}

export const loadGlossary = async (projectId: string, locale: UserLocale): Promise<GlossaryEntry[]> => {
  const rows = await TranslationGlossary.find({ projectId: oid(projectId), locale }, { term: 1, translation: 1 }).lean()
  return rows.map((row) => ({ term: row.term, translation: row.translation }))
}

/**
 * Ghi thuật ngữ. `seed` (từ `term_native` hiện tại) ghi đè mọi bản. `model`:
 * - mặc định chỉ chèn khi thuật ngữ chưa có — bản học đầu tiên giữ ổn định giữa các lô;
 * - `replace` ⇒ đè bản `model` cũ (không đè `seed`): tên lấy từ bản dịch đang thắng (bản `author`, hoặc bản đã lưu
 *   lúc gieo) để glossary luôn theo đúng chữ dịch của tên đó.
 */
export const upsertGlossary = async (
  projectId: string,
  locale: UserLocale,
  entries: GlossaryEntry[],
  origin: GlossaryOrigin,
  replace = false
): Promise<void> => {
  const byTerm = new Map<string, string>()
  for (const { term, translation } of entries) {
    const key = term.trim()
    if (key && translation.trim() && !byTerm.has(key)) byTerm.set(key, translation.trim())
  }
  if (byTerm.size === 0) return

  const ops = [...byTerm].map(([term, translation]) => {
    const filter = { projectId: oid(projectId), locale, term }
    if (origin === "seed") return { updateOne: { filter, update: { $set: { translation, origin } }, upsert: true } }
    // `replace`: dòng `seed` không khớp filter ⇒ upsert đụng unique index ⇒ bỏ qua (seed thắng)
    if (replace) return { updateOne: { filter: { ...filter, origin: { $ne: "seed" as const } }, update: { $set: { translation, origin } }, upsert: true } }
    return { updateOne: { filter, update: { $setOnInsert: { translation, origin } }, upsert: true } }
  })
  try {
    await TranslationGlossary.bulkWrite(ops, { ordered: false })
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err
  }
}

// ─── khoá lượt dịch theo lô ───────────────────────────────────────

/** Đủ cho `max_batches` tối đa (10 lô) kể cả provider chậm; quá hạn ⇒ coi lượt cũ đã chết, chiếm lại được. */
export const RUN_LOCK_TTL_MS = 15 * 60 * 1000

/**
 * Chiếm khoá dịch theo lô của (dự án, ngôn ngữ). Trả mã khoá, hoặc `null` khi lượt khác đang giữ (còn hạn).
 * Một lệnh nguyên tử: khoá trống / quá hạn ⇒ ghi đè; đang giữ ⇒ upsert đụng unique index.
 */
export const acquireRunLock = async (projectId: string, locale: UserLocale): Promise<string | null> => {
  const now = new Date()
  const token = randomUUID()
  try {
    await TranslationRunLock.findOneAndUpdate(
      { projectId: oid(projectId), locale, lockedUntil: { $lt: now } },
      { $set: { token, lockedUntil: new Date(now.getTime() + RUN_LOCK_TTL_MS) } },
      { upsert: true }
    )
    return token
  } catch (err) {
    if (isDuplicateKeyError(err)) return null
    throw err
  }
}

/** Nhả khoá — chỉ khi vẫn đúng lượt đã chiếm (khoá quá hạn đã bị lượt khác chiếm thì để nguyên). */
export const releaseRunLock = async (projectId: string, locale: UserLocale, token: string): Promise<void> => {
  await TranslationRunLock.deleteOne({ projectId: oid(projectId), locale, token })
}
