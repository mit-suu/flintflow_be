/**
 * Chặn sửa ngoài change request ở project mode 1 (BR-03). FLF-171, plan §6 2G; mode 1 v3 (bám BPMN 2026-09-22):
 * Flow 1 kết thúc ở gap report (1.13) hoặc đi sang 3.1 — **import xong (baseline v0 `imported`) là mọi sửa phải qua
 * change request**. Không còn giai đoạn "sửa tự do tới baseline v1" của v2.
 * - Sửa trực tiếp (`/changes`, `/reconcile`, `/undo`, lệnh sửa trong chat) ⇒ `409 CHANGE_REQUIRES_CR` kèm nội dung
 *   điền sẵn. **Không tự tạo CR**: 3.1 là việc của BA (nguồn + người yêu cầu bắt buộc), FE mở form điền sẵn.
 * - Mode 1 không chạy step / gate / bật-tắt step, không ký baseline v1, không waive cờ (Flow 1 không có các nút đó;
 *   khoá duy nhất sau v0 là release — Flow 6).
 * Đồng thời đăng ký hồ sơ luật mode 1 làm mặc định cho mọi lượt tính lại cờ của project mode 1.
 */

import type { CrSourceKind } from "../change-request/change-request.constants.js"
import { Project } from "../project/project.model.js"
import * as flagsService from "../spine/flags.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import { Mode1Error, type Mode1ErrorCode } from "./mode1.errors.js"
import { MODE1_RULE_PROFILE } from "./mode1-rule-profile.js"
import { TemplateProfile, type LayoutEntry } from "./template-profile.model.js"
import { withSlotParents } from "./content-slots.js"
import { templateWrapperIds } from "./template-wrappers.js"
import { TemplateMigration } from "../template-migration/template-migration.model.js"
import { UNMEASURED_FILL_ARRAYS, migrationSectionWritten, sectionReferencesOf, type RuleProfile } from "../spine/deterministic-check.js"
import type { Spine } from "../spine/spine.types.js"
import type { SectionSegments } from "../spine/segment-hash.js"

export interface CrPrefill {
  title: string
  description: string
  /** Nguồn gợi ý cho form 3.1 (vd lệnh trong chat ⇒ yêu cầu miệng, `ref: chat:<id>`). BA vẫn sửa được. */
  source?: { kind: CrSourceKind; ref: string | null }
}

export const isMode1Project = async (projectId: string): Promise<boolean> =>
  (await Project.findById(projectId).select("mode").lean())?.mode === "import"

/**
 * Hồ sơ luật của project: mode 1 ⇒ `MODE1_RULE_PROFILE`; thêm chế độ 3 (mẫu bắt buộc, `template_intent = fixed`) ⇒ kèm
 * các mục của mẫu để bật cờ vàng `template_section_absent` / `template_section_empty` (FLF-278 trên FLF-335/336).
 */
export const ruleProfileOf = async (projectId: string): Promise<RuleProfile | undefined> => {
  const project = (await Project.findById(projectId).select("mode template_intent").lean()) as { mode?: string; template_intent?: string | null } | null
  const mode1 = project?.mode === "import"
  const fixed = project?.template_intent === "fixed"
  if (!mode1 && !fixed) return undefined
  const profile = (await TemplateProfile.findOne({ projectId }, { layout: 1, section_segments: 1, section_slices: 1, migration_missing_sections: 1, migrated_base_at: 1, migrated_base_migration_id: 1, "migrated_base_spine.custom_sections": 1 }).lean()) as {
    layout?: LayoutEntry[]
    migration_missing_sections?: string[]
    migrated_base_at?: Date | null
    migrated_base_migration_id?: unknown
    migrated_base_spine?: { custom_sections?: Spine["custom_sections"] } | null
    section_segments?: SectionSegments[]
    section_slices?: { custom_id: string; items: string[] }[]
  } | null
  // FLF-366: đoạn nguyên văn của file import ⇒ cờ vàng khi văn xuôi gốc nhắc tới phần tử đã đổi tên / bị xoá
  const segments = mode1 ? (profile?.section_segments ?? []) : []
  const mode1Profile = (extra: Partial<RuleProfile> = {}): RuleProfile =>
    segments.length || Object.keys(extra).length ? { ...MODE1_RULE_PROFILE, ...extra, ...(segments.length ? { sectionSegments: segments } : {}) } : MODE1_RULE_PROFILE
  if (!fixed) return mode1Profile()
  const layout = profile?.layout ?? []
  if (!layout.length) return mode1 ? mode1Profile() : undefined
  // Mục FPT có mặt qua các phần nhỏ (`slot:*`) của nó cũng là mục của mẫu
  const templateLayout = withSlotParents(layout.map((l) => l.section_id))
  const templateWrappers = templateWrapperIds(layout)
  // Sau đổi mẫu: mục của mẫu đích để trống chờ BA viết (cờ đỏ chặn phát hành) + mục giữ thành mục riêng (không báo "mẫu không có mục này")
  const missing = new Set(profile?.migration_missing_sections ?? [])
  const afterMigration = !!profile?.migrated_base_at
  const anchor = afterMigration ? await anchorOf(profile) : null
  const migrationExtras: Partial<RuleProfile> = {
    ...(missing.size ? { templateMissing: missing, templateHeadings: new Map(layout.filter((l) => l.heading_text.trim()).map((l) => [l.section_id, l.heading_text.trim()] as const)) } : {}),
    ...(afterMigration
      ? {
          templateKept: await keptCustomSections(projectId),
          checkSectionReferences: true,
          ...(anchor?.custom_sections ? { referenceBaseline: new Map(anchor.custom_sections.map((c) => [c.id, sectionReferencesOf(c.blocks)] as const)) } : {})
        }
      : {})
  }
  // Heading lặp có nội dung đã trích vào Spine (slice) ⇒ không phải mục trống
  const templateFilled = new Set((profile?.section_slices ?? []).filter((sl) => sl.items.length).map((sl) => `custom:${sl.custom_id}`))
  if (missing.size) for (const id of unmeasuredFilled(missing, (await spineRepository.get(projectId)) as Spine | null, anchor)) templateFilled.add(id)
  // Luồng 2 của chế độ 3 (`mode = fpt`, flow2.service): đủ luật tạo mới, chỉ trên các mục của mẫu
  return mode1
    ? mode1Profile({ templateLayout, templateWrappers, templateFilled, ...migrationExtras })
    : { exclude: new Set(), downgrade: new Set(), templateLayout, templateWrappers, templateFilled, ...migrationExtras }
}

type AnchorPart = Partial<Pick<Spine, "custom_sections" | "nfrs" | "glossary">>

/** Mốc nguyên vẹn của file nền hiện tại: ở migration (profile chỉ giữ id), hoặc bản sao cũ trên profile. */
const anchorOf = async (profile: { migrated_base_migration_id?: unknown; migrated_base_spine?: AnchorPart | null } | null): Promise<AnchorPart | null> => {
  if (profile?.migrated_base_spine) return profile.migrated_base_spine
  if (!profile?.migrated_base_migration_id) return null
  const m = (await TemplateMigration.findById(profile.migrated_base_migration_id, { "anchor_spine.custom_sections": 1, "anchor_spine.nfrs": 1, "anchor_spine.glossary": 1 }).lean()) as { anchor_spine?: AnchorPart | null } | null
  return m?.anchor_spine ?? null
}

/**
 * Mục khung ngoài bảng đo dữ liệu (`UNMEASURED_FILL_ARRAYS`) đã được viết sau đổi mẫu = mảng nuôi nó có thêm phần tử so với mốc lúc đổi mẫu (không có mốc ⇒ có phần tử).
 * Hàm thuần — cờ `template_section_migration_missing` đóng khi mục nằm trong tập này.
 */
export const unmeasuredFilled = (missing: ReadonlySet<string>, spine: Pick<Spine, "nfrs" | "glossary"> | null, anchor: AnchorPart | null): string[] =>
  [...missing].filter((id) => {
    const arrays = UNMEASURED_FILL_ARRAYS[id]
    if (!arrays || !spine) return false
    return arrays.some((a) => (spine as unknown as Record<string, unknown[]>)[a as string]?.length > (anchor ? ((anchor as unknown as Record<string, unknown[] | undefined>)[a as string]?.length ?? 0) : 0))
  })

export interface CarryProfile {
  migration_missing_sections?: string[]
  migrated_base_at?: Date | null
  migrated_base_migration_id?: unknown
  migrated_base_spine?: AnchorPart | null
  section_slices?: { custom_id: string; items: string[] }[]
}

/**
 * Mục của mẫu trước còn đang chờ viết (cờ đỏ chặn phát hành) mà lần đổi mẫu mới vẫn coi là mục của mẫu đích (`eligible`) và Spine
 * chưa có chữ cho nó ⇒ mang sang danh sách mục thiếu mới. Không mang sang thì mục được ghép "khớp" với heading rỗng của lần đổi
 * trước sẽ mất cờ dù tài liệu vẫn trống. `spine` = Spine sau lần đổi mẫu này.
 */
export const carriedMissingSections = async (profile: CarryProfile | null, spine: Spine, eligible: ReadonlySet<string>, already: readonly string[]): Promise<string[]> => {
  const candidates = new Set((profile?.migration_missing_sections ?? []).filter((id) => eligible.has(id) && !already.includes(id)))
  if (!candidates.size) return []
  const anchor = profile?.migrated_base_at ? await anchorOf(profile) : null
  const filled = new Set((profile?.section_slices ?? []).filter((sl) => sl.items.length).map((sl) => `custom:${sl.custom_id}`))
  for (const id of unmeasuredFilled(candidates, spine, anchor)) filled.add(id)
  return [...candidates].filter((id) => !migrationSectionWritten(spine, id, filled))
}

/** `section_id` cũ mà BA chọn giữ thành mục riêng (`keep_custom`) hoặc bỏ khỏi bản in (`drop_from_print`) ở **mọi** lần đổi mẫu còn hiệu lực (đã áp dụng, chưa hoàn tác). */
export const keptCustomSections = async (projectId: string): Promise<ReadonlySet<string>> => {
  const migrations = await TemplateMigration.find({ projectId, state: "applied" }, { groups: 1, decisions: 1 }).lean()
  const out = new Set<string>()
  for (const migration of migrations) {
    // Giữ thành mục riêng hoặc bỏ khỏi bản in (dữ liệu còn trong Spine): mẫu không có mục này là chủ ý của BA, không báo
    const kept = new Set((migration.decisions ?? []).filter((d) => d.choice === "keep_custom" || d.choice === "drop_from_print").map((d) => d.id))
    for (const e of migration.groups?.extra ?? []) if (kept.has(e.id)) out.add(e.section_id)
  }
  return out
}

flagsService.setRuleProfileResolver(ruleProfileOf)

/** Hồ sơ luật cho các lượt tính lại cờ của luồng import / CR / release (luôn là mode 1, kèm layout mẫu khi chế độ 3). */
export const mode1RuleProfileFor = async (projectId: string): Promise<RuleProfile> => (await ruleProfileOf(projectId)) ?? MODE1_RULE_PROFILE

/** Project mode 1 đã import xong (có baseline v0 trở lên) — từ đây mọi sửa phải qua CR. */
export const changesRequireCr = async (projectId: string): Promise<boolean> => {
  if (!(await isMode1Project(projectId))) return false
  const spine = await spineRepository.get(projectId)
  return (spine?.baselines.length ?? 0) > 0
}

/** Nội dung điền sẵn cho form CR từ câu lệnh sửa (hoặc mô tả op). */
export const prefillFrom = (instruction: string | undefined, fallback = "Sửa tài liệu", source?: CrPrefill["source"]): CrPrefill => {
  const text = (instruction ?? "").trim()
  const base = !text
    ? { title: fallback, description: fallback }
    : (() => {
        const firstLine = text.split(/\r?\n/)[0]
        return { title: firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine, description: text }
      })()
  return source ? { ...base, source } : base
}

export const changeRequiresCr = (prefill: CrPrefill): Mode1Error =>
  new Mode1Error("CHANGE_REQUIRES_CR", "Tài liệu đã chốt bản gốc — mọi sửa phải qua change request", { prefill })

export const assertChangesAllowed = async (projectId: string, prefill: CrPrefill): Promise<void> => {
  if (await changesRequireCr(projectId)) throw changeRequiresCr(prefill)
}

/** Việc của workspace mode 2 không có trong Flow 1. */
export type Mode1Forbidden = "steps" | "signoff" | "waive"

const FORBIDDEN: Record<Mode1Forbidden, { code: Mode1ErrorCode; message: string }> = {
  steps: { code: "MODE1_NO_STEPS", message: "Dự án tải SRS lên không chạy theo từng bước — hãy sửa tài liệu bằng change request." },
  signoff: { code: "MODE1_NO_SIGNOFF", message: "Dự án tải SRS lên không ký baseline theo cách này — hãy phát hành phiên bản khi đã xử lý hết cờ đỏ." },
  waive: { code: "MODE1_NO_WAIVE", message: "Dự án tải SRS lên không bỏ qua cờ được — hãy xử lý cờ bằng change request." }
}

/**
 * Chặn mọi lúc với project mode 1 (không phụ thuộc đã import xong hay chưa — Flow 1 không có các nút này).
 * Nhận `mode` của project mà controller đã nạp khi kiểm quyền — không truy vấn thêm.
 */
export const assertNotMode1 = (mode: string | null | undefined, what: Mode1Forbidden): void => {
  if (mode === "import") throw new Mode1Error(FORBIDDEN[what].code, FORBIDDEN[what].message)
}
