/**
 * FLF-466 (BF §2, §3.6): Viewer chỉ thấy bản gốc và bản phát hành. Mọi route đọc dữ liệu từ Spine (truy vết, sơ đồ, ảnh)
 * đọc theo snapshot của version ổn định mới nhất, không đọc Spine sống (có nội dung bản nháp).
 */

import { ApiError } from "../utils/api-error.js"
import { listDocVersions } from "../../modules/doc-version/doc-version.service.js"
import { isStableDocVersion } from "../../modules/doc-version/versioning.js"
import { loadBaselineSpine } from "../../modules/render/assemble.service.js"
import { spineSchema } from "../../modules/spine/spine.schema.js"
import type { Spine } from "../../modules/spine/spine.types.js"

export const VIEWER_NO_STABLE_VERSION = "VIEWER_NO_STABLE_VERSION"

/** Spine của version ổn định mới nhất; chưa có bản ổn định (hoặc không đọc được snapshot) ⇒ 404. */
export const viewerSpine = async (projectId: string): Promise<Spine> => {
  const stable = (await listDocVersions(projectId)).find(isStableDocVersion)
  const notYet = new ApiError(404, "Dự án chưa có bản phát hành để xem.", VIEWER_NO_STABLE_VERSION)
  if (!stable) throw notYet
  if (stable.spine_snapshot) {
    const parsed = spineSchema.safeParse(stable.spine_snapshot)
    if (parsed.success) return parsed.data
  }
  if (!stable.baseline_ref) throw notYet
  return loadBaselineSpine(projectId, stable.baseline_ref)
}
