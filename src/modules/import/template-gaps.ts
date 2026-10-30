/**
 * FLF-278 trên FLF-335/336 — thống kê heading của mẫu khách mà FlintFlow không có mục tương ứng (thành mục riêng
 * `custom:*` trong layout) và còn để trống ở bao nhiêu dự án — đầu vào để nhóm quyết định mở rộng Spine
 * (`docs/template-gap-proposal.md`). Chỉ đọc; không ghi Spine, không đổi schema.
 */
import type { Request, Response } from "express"
import { z } from "zod"
import { Project } from "../project/project.model.js"
import { Spine } from "../spine/spine.model.js"
import type { CustomSection } from "../spine/spine.types.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { validationError } from "../../shared/utils/validation-message.js"
import { isRealText } from "../../shared/utils/instruction-text.js"
import { normalizeTitle } from "./org-mapping.js"
import { suggestSlot } from "./content-slots.js"
import { TemplateProfile } from "./template-profile.model.js"

export interface TemplateGapRow {
  /** Tiêu đề đã chuẩn hoá — gộp "2.4 Hardware Interfaces" và "Hardware interfaces". */
  key: string
  /** Tối đa 3 cách viết gốc khác nhau. */
  samples: string[]
  /** Số dự án mẫu bắt buộc có heading này là mục riêng. */
  projects: number
  /** Trong đó còn trống (chưa có chữ thật / bảng / ảnh). */
  empty: number
  /** Luật gợi ý phần nhỏ hiện tại đã nhận ra — khác null ⇒ mẫu mới sẽ được gợi ý map vào dữ liệu Spine. */
  suggested_destination: string | null
}

export interface GapInput {
  /** Mục riêng trong layout của một dự án: id + tiêu đề heading. */
  sections: readonly { id: string; title: string }[]
  /** `custom_sections` hiện tại trong Spine của dự án đó. */
  spineSections: readonly Pick<CustomSection, "id" | "blocks">[]
}

const filled = (c: Pick<CustomSection, "blocks"> | undefined) =>
  !!c && c.blocks.some((b) => b.image_ref || isRealText(b.text) || (b.rows ?? []).some((r) => r.some((cell) => isRealText(cell))))

/** Gộp theo tiêu đề chuẩn hoá; xếp theo số dự án còn trống rồi số dự án gặp. */
export const aggregateTemplateGaps = (inputs: readonly GapInput[], limit: number): TemplateGapRow[] => {
  const rows = new Map<string, TemplateGapRow>()
  for (const { sections, spineSections } of inputs) {
    const byId = new Map(spineSections.map((c) => [c.id, c]))
    for (const s of sections) {
      const key = normalizeTitle(s.title)
      if (!key) continue
      const row = rows.get(key) ?? { key, samples: [], projects: 0, empty: 0, suggested_destination: suggestSlot(s.title) }
      row.projects += 1
      if (!filled(byId.get(s.id))) row.empty += 1
      if (row.samples.length < 3 && !row.samples.includes(s.title)) row.samples.push(s.title)
      rows.set(key, row)
    }
  }
  return [...rows.values()].sort((a, b) => b.empty - a.empty || b.projects - a.projects || a.key.localeCompare(b.key)).slice(0, limit)
}

/** Dự án mẫu bắt buộc (`template_intent = fixed`, trần 2.000 gần nhất) + mục riêng trong layout và Spine của chúng. */
export const templateGaps = async (limit: number): Promise<{ projects: number; rows: TemplateGapRow[] }> => {
  const projects = await Project.find({ template_intent: "fixed" }, { _id: 1 }).sort({ updatedAt: -1 }).limit(2000).lean()
  const ids = projects.map((p) => p._id)
  const [profiles, spines] = await Promise.all([
    TemplateProfile.find({ projectId: { $in: ids } }, { projectId: 1, layout: 1 }).lean(),
    Spine.find({ projectId: { $in: ids } }, { projectId: 1, "custom_sections.id": 1, "custom_sections.blocks": 1 }).lean()
  ])
  const sectionsOf = new Map(spines.map((s) => [String(s.projectId), (s.custom_sections ?? []) as Pick<CustomSection, "id" | "blocks">[]]))
  const inputs = profiles.map((p) => ({
    sections: (p.layout ?? [])
      .filter((l) => l.section_id.startsWith("custom:") && l.heading_text.trim())
      .map((l) => ({ id: l.section_id.slice("custom:".length), title: l.heading_text.trim() })),
    spineSections: sectionsOf.get(String(p.projectId)) ?? []
  }))
  return { projects: profiles.length, rows: aggregateTemplateGaps(inputs, limit) }
}

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }).strict()

/** `GET /api/v1/admin/template-gaps` (admin, đã qua `authMiddleware` + `adminMiddleware` ở router admin). */
export const getTemplateGaps = catchAsync(async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query)
  if (!parsed.success) throw validationError(parsed.error)
  return sendSuccess(res, 200, await templateGaps(parsed.data.limit))
})
