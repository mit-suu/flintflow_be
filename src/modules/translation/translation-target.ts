/**
 * translation-target.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-334 B — đích snapshot của `GET /translations/status` (#26) và `POST /translations/run` (#27): cùng Spine mà lượt tải
 * theo ngôn ngữ khác kiểm (409 `TRANSLATION_INCOMPLETE`), để "Dịch nốt" xoá đúng phần thiếu đó.
 *
 * - không đích ⇒ Spine hiện tại (như trước; bản nháp mode 2 #18 `source=draft`)
 * - `baseline_id` ⇒ `Baseline.snapshot` (mode 2 #18 `source=baseline&baseline_id=`; `_id` hoặc `BLnnn`)
 * - `version` ⇒ snapshot baseline của DocVersion (mode 1 #14); version không có `baseline_ref` (bản nháp CR) ⇒ 409
 *   `DOCUMENT_LANGUAGE_UNAVAILABLE`, như lượt tải
 */

import * as spineRepository from "../spine/spine.repository.js"
import { loadBaselineSpine } from "../render/assemble.service.js"
import { requireDocVersion } from "../doc-version/doc-version.service.js"
import { documentLanguageUnavailable, type SpineLoader } from "./translation.service.js"

export interface TranslationTarget {
  baseline_id?: string | undefined
  version?: string | undefined
}

/** Loader Spine của đích — chỉ chạy khi cần đếm / dịch (ngôn ngữ đích ≠ ngôn ngữ gốc). */
export const targetSpineLoader =
  (projectId: string, target: TranslationTarget): SpineLoader =>
  async () => {
    if (target.version !== undefined) {
      const v = await requireDocVersion(projectId, target.version)
      if (!v.baseline_ref) throw documentLanguageUnavailable()
      return loadBaselineSpine(projectId, String(v.baseline_ref))
    }
    if (target.baseline_id !== undefined) return loadBaselineSpine(projectId, target.baseline_id)
    return spineRepository.get(projectId)
  }
