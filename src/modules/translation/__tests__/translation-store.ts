/**
 * Kho bản dịch trong bộ nhớ thay `translation.repository.ts` cho unit test (project `unit` không nối Mongo).
 * Giữ đúng luật ghi của repository thật: `author` đè, `machine` chỉ chèn; glossary `seed` đè, `model` chỉ chèn
 * (`replace` ⇒ đè `model`, không đè `seed`); khoá lượt dịch một (dự án, ngôn ngữ) một lượt.
 * Luật đó chạy trên Mongo thật ở `test/integration/translation.int.test.ts`.
 *
 * Dùng: `vi.mock("./translation.repository.js", async () => (await import("./__tests__/translation-store.js")).fakeRepository)`.
 */
import { vi } from "vitest"
import type { GlossaryEntry, StoredTranslation, TranslationEntry } from "../translation.repository.js"
import type { TranslationOrigin } from "../spine-translation.model.js"
import type { GlossaryOrigin } from "../translation-glossary.model.js"

export const store = {
  /** `${projectId}|${locale}|${sourceHash}` ⇒ bản lưu */
  translations: new Map<string, StoredTranslation & { sourceLocale: string }>(),
  /** `${projectId}|${locale}|${term}` ⇒ thuật ngữ */
  glossary: new Map<string, GlossaryEntry & { origin: GlossaryOrigin }>(),
  /** `${projectId}|${locale}` ⇒ mã khoá đang giữ */
  locks: new Map<string, string>()
}

export const resetStore = (): void => {
  store.translations.clear()
  store.glossary.clear()
  store.locks.clear()
  for (const fn of Object.values(fakeRepository)) fn.mockClear()
}

const tKey = (projectId: string, locale: string, hash: string) => `${projectId}|${locale}|${hash}`

export const fakeRepository = {
  findByHashes: vi.fn(async (projectId: string, locale: string, hashes: string[]) => {
    const out = new Map<string, StoredTranslation>()
    for (const hash of hashes) {
      const hit = store.translations.get(tKey(projectId, locale, hash))
      if (hit) out.set(hash, { sourceHash: hit.sourceHash, text: hit.text, origin: hit.origin })
    }
    return out
  }),
  saveTranslations: vi.fn(async (projectId: string, locale: string, sourceLocale: string, entries: TranslationEntry[], origin: TranslationOrigin) => {
    const seen = new Set<string>()
    for (const { sourceHash, text } of entries) {
      if (seen.has(sourceHash)) continue
      seen.add(sourceHash)
      const key = tKey(projectId, locale, sourceHash)
      if (origin === "machine" && store.translations.has(key)) continue
      store.translations.set(key, { sourceHash, text, origin, sourceLocale })
    }
  }),
  loadGlossary: vi.fn(async (projectId: string, locale: string) =>
    [...store.glossary].filter(([k]) => k.startsWith(`${projectId}|${locale}|`)).map(([, v]) => ({ term: v.term, translation: v.translation }))
  ),
  upsertGlossary: vi.fn(async (projectId: string, locale: string, entries: GlossaryEntry[], origin: GlossaryOrigin, replace = false) => {
    for (const { term, translation } of entries) {
      const key = tKey(projectId, locale, term.trim())
      const current = store.glossary.get(key)
      if (origin === "model" && current && (!replace || current.origin === "seed")) continue
      store.glossary.set(key, { term: term.trim(), translation: translation.trim(), origin })
    }
  }),
  acquireRunLock: vi.fn(async (projectId: string, locale: string) => {
    const key = `${projectId}|${locale}`
    if (store.locks.has(key)) return null
    const token = `lock-${store.locks.size + 1}-${Date.now()}`
    store.locks.set(key, token)
    return token
  }),
  releaseRunLock: vi.fn(async (projectId: string, locale: string, token: string) => {
    const key = `${projectId}|${locale}`
    if (store.locks.get(key) === token) store.locks.delete(key)
  })
}
