/**
 * Layout + kế hoạch step theo template người dùng (mode 1 v2 — FLF-183; plan v2 §5, D2/D6). Hàm thuần.
 * - Layout: thứ tự + tiêu đề các mục của file upload. Heading mở một section FPT mới ⇒ giữ section đó; heading con
 *   cùng section với mục bao nó ⇒ không thành mục riêng (nội dung đã trích vào section FPT); heading không khớp section
 *   FPT nào, hoặc lặp một section FPT đã gặp ở chỗ khác ⇒ **mục riêng** `custom:<id>`, khối bên dưới giữ nguyên văn.
 * - Kế hoạch step (D6 — mọi đầu mục mẫu FPT là cốt lõi): step sở hữu section FPT luôn `applied`, `missing` khi section
 *   không có nội dung; Brief (B-*) và S-1.x `hidden`; step không sở hữu section (S-8.2, S-8.4, S-9.x) luôn chạy.
 *   Luật 2 của business-flow §5 (thêm step được đọc tới) không cần tách riêng: với D6 mọi step ghi field FPT đã chạy.
 * - Seed: op đặt `steps[]` (accepted / pending / skipped), vòng S-5 theo màn, `progress` — áp sau lô thực thể của finalize.
 */

import { loadStepRegistry, loopKeys, orderedSteps, type PhaseId } from "../pipeline/step-registry.js"
import { sectionHasData } from "../spine/deterministic-check.js"
import { FEATURE_OWNER_STEPS, FIXED_OWNER_STEPS } from "../spine/section-registry.js"
import type { Op } from "../spine/op.types.js"
import type { CustomBlock, CustomSection, Spine, StepState } from "../spine/spine.types.js"
import type { DocBlockKind } from "./import.constants.js"
import { UNMAPPED_SECTION } from "./import.constants.js"
import type { LayoutEntry, StepPlanItem } from "./template-profile.model.js"

export const CUSTOM_SECTION_PREFIX = "custom:"
export const customSectionKey = (id: string): string => `${CUSTOM_SECTION_PREFIX}${id}`

/**
 * Section chủ của một **phần nối** (mục riêng tiêu đề rỗng): mục gần nhất phía trước có cấp nhỏ hơn — đúng mục mà
 * assemble gộp khối của phần nối vào (xem `render/layout-sections.ts`). Không tìm được ⇒ null.
 */
export const continuationOwnerSection = (layout: readonly LayoutEntry[], sectionId: string): string | null => {
  const at = layout.findIndex((e) => e.section_id === sectionId)
  if (at < 0) return null
  for (let i = at - 1; i >= 0; i--) if (layout[i].level < layout[at].level) return layout[i].section_id
  return null
}
const customId = (n: number): string => `CS${String(n).padStart(2, "0")}`
const clampLevel = (level: number | null): number => Math.min(9, Math.max(1, level ?? 1))

/** Section do step feature sở hữu — đại diện mọi `feature:*` trong kế hoạch. */
export const FEATURE_SECTIONS = "feature:*"

/** Block tối thiểu (DocBlock đã lưu, theo thứ tự tài liệu). */
export interface LayoutBlock {
  block_id: string
  kind: DocBlockKind
  level: number | null
  text: string
  /** Section của block sau finalize (heading gần nhất phía trên), `null` nếu nhóm / không khớp. */
  section_id: string | null
  rows?: string[][] | null
}

export interface LayoutResult {
  layout: LayoutEntry[]
  customSections: CustomSection[]
}

const toCustomBlock = (b: LayoutBlock): CustomBlock | null => {
  const text = b.text.trim()
  switch (b.kind) {
    case "table":
      return { kind: "table", text: "", rows: b.rows ?? [], image_ref: null }
    case "image":
      return { kind: "image", text, rows: null, image_ref: null }
    case "list_item":
      return text ? { kind: "list_item", text, rows: null, image_ref: null } : null
    case "paragraph":
    case "caption":
    case "unsupported":
      return text ? { kind: "paragraph", text, rows: null, image_ref: null } : null
    default:
      // ô / hàng bảng đã nằm trong khối bảng
      return null
  }
}

/**
 * Layout + mục riêng từ block đã lưu và bảng heading → section (id thật sau finalize).
 * `unmappedBlockIds` (I-4 báo không trích được) và mọi khối dưới heading nhóm (`group:*`, không trích) ⇒ **phần nối**
 * của section: mục riêng tiêu đề rỗng, cấp = cấp section + 1, đứng sau section trong layout — assemble gộp khối của nó
 * vào đầu section đó (FLF-184), để render từ Spine không mất văn xuôi của file gốc.
 */
export const buildLayout = (
  blocks: LayoutBlock[],
  headingSections: ReadonlyMap<string, string>,
  unmappedBlockIds: ReadonlySet<string> = new Set()
): LayoutResult => {
  const layout: LayoutEntry[] = []
  const customSections: CustomSection[] = []
  const seen = new Set<string>()
  const stack: { level: number; section: string; entry: LayoutEntry }[] = []
  /** Mục riêng đang nhận nguyên văn mọi khối. */
  let current: CustomSection | null = null
  /** Section FPT / nhóm đang mở — khối không trích được thành phần nối của nó. */
  let owner: LayoutEntry | null = null
  const continuations = new Map<LayoutEntry, CustomSection>()

  const newCustom = (heading: string, level: number): CustomSection => {
    const section: CustomSection = { id: customId(customSections.length + 1), heading, level, blocks: [], source: "import" }
    customSections.push(section)
    return section
  }
  const continuationOf = (entry: LayoutEntry): CustomSection => {
    let section = continuations.get(entry)
    if (!section) {
      section = newCustom("", clampLevel(entry.level + 1))
      continuations.set(entry, section)
      layout.push({ order: layout.length, heading_text: "", level: section.level, section_id: customSectionKey(section.id) })
    }
    return section
  }

  for (const b of blocks) {
    if (b.kind === "heading" && b.level !== null) {
      while (stack.length && stack[stack.length - 1].level >= b.level) stack.pop()
      const enclosing = stack[stack.length - 1] ?? null
      const mapped = headingSections.get(b.block_id) ?? UNMAPPED_SECTION
      const heading = b.text.trim()
      if (mapped !== UNMAPPED_SECTION && mapped === enclosing?.section) {
        // heading con của chính section đó — nội dung đã trích vào section FPT; khối sau nó lại thuộc section đó
        stack.push({ level: b.level, section: mapped, entry: enclosing.entry })
        current = null
        owner = enclosing.entry
        continue
      }
      let section: string
      if (mapped !== UNMAPPED_SECTION && !seen.has(mapped)) {
        section = mapped
        seen.add(mapped)
        current = null
      } else {
        current = newCustom(heading, clampLevel(b.level))
        section = customSectionKey(current.id)
      }
      const entry: LayoutEntry = { order: layout.length, heading_text: heading, level: clampLevel(b.level), section_id: section }
      layout.push(entry)
      stack.push({ level: b.level, section, entry })
      owner = current ? null : entry
      continue
    }
    const block = toCustomBlock(b)
    if (!block) continue
    if (current) current.blocks.push(block)
    else if (owner && (owner.section_id.startsWith("group:") || unmappedBlockIds.has(b.block_id))) continuationOf(owner).blocks.push(block)
  }
  return { layout, customSections }
}

/** Section có nội dung thật (khối không phải heading) — mục "chỉ có heading" coi như thiếu. */
export const sectionsWithContent = (blocks: LayoutBlock[]): Set<string> => {
  const out = new Set<string>()
  for (const b of blocks) {
    if (!b.section_id || b.kind === "heading" || b.kind === "table_cell" || b.kind === "table_row") continue
    if (b.kind === "table" || b.kind === "image" || b.text.trim()) out.add(b.section_id)
  }
  return out
}

/** Section FPT do step sở hữu (không tính function — vòng S-5 theo màn). */
export const sectionsOwnedBy = (stepId: string): string[] => [
  ...Object.entries(FIXED_OWNER_STEPS)
    .filter(([, steps]) => steps.includes(stepId))
    .map(([section]) => section),
  ...(FEATURE_OWNER_STEPS.includes(stepId) ? [FEATURE_SECTIONS] : [])
]

/** Mục suy dẫn: hệ thống tự điền (Record of Changes từ lịch sử CR) — không bao giờ "Thiếu". */
const DERIVED_SECTIONS: ReadonlySet<string> = new Set(["fixed:I"])

const isHiddenPhase = (phase: PhaseId): boolean => phase.startsWith("B-") || phase === "S-1"

const matches = (section: string, pool: Iterable<string>): boolean => {
  if (section !== FEATURE_SECTIONS) return [...pool].includes(section)
  return [...pool].some((s) => s.startsWith("feature:"))
}

/**
 * Kế hoạch step (không gồm vòng S-5 — xem `seedStepOps`).
 * `spine`: Spine **sau khi đã nạp dữ liệu trích được**. Mục nào luật cờ soi được thì "đã có nội dung" tính theo
 * **dữ liệu Spine**, không theo chữ trong file: file có đầu mục "Screen Authorization" nhưng I-4 không trích ra
 * role/permission nào ⇒ Spine trống ⇒ cờ đỏ `section_empty`. Trước đây chỗ này chỉ nhìn block của file nên step
 * được đánh `accepted` ngay từ import, người dùng thấy "đã chốt" mà cờ đỏ vẫn treo (gặp thật 2026-09-20).
 * Mục ngoài bảng luật (mục riêng, feature…) vẫn theo file như cũ.
 */
export const buildStepPlan = (layout: LayoutEntry[], content: ReadonlySet<string>, spine?: Spine): StepPlanItem[] =>
  loadStepRegistry()
    .filter((s) => s.kind !== "loop")
    .map((s): StepPlanItem => {
      if (isHiddenPhase(s.phase)) {
        return { step_id: s.id, state: "hidden", missing: false, section_ids: [], reason: "Không sinh đầu mục — bật nếu muốn AI phân tích lại ý tưởng" }
      }
      const owned = sectionsOwnedBy(s.id)
      if (!owned.length) return { step_id: s.id, state: "applied", missing: false, section_ids: [], reason: "Bước ghép / kiểm tra tài liệu — luôn chạy" }
      if (owned.every((sec) => DERIVED_SECTIONS.has(sec))) {
        return { step_id: s.id, state: "applied", missing: false, section_ids: owned, reason: "Mục tự sinh từ lịch sử thay đổi" }
      }
      const hasContent = owned.some((sec) => {
        const inSpine = spine ? sectionHasData(spine, sec) : null
        return inSpine === null ? matches(sec, content) : inSpine
      })
      const inLayout = owned.some((sec) => matches(sec, layout.map((l) => l.section_id)))
      const inFile = owned.some((sec) => matches(sec, content))
      const reason = hasContent
        ? "Có trong file, đã có nội dung"
        : inFile
          ? "Đầu mục có trong file nhưng chưa trích được dữ liệu nào — chạy step để AI soạn"
          : inLayout
            ? "Đầu mục mẫu FPT có trong file nhưng trống"
            : "Đầu mục mẫu FPT — file không có"
      return { step_id: s.id, state: "applied", missing: !hasContent, section_ids: owned, reason }
    })

/** Trạng thái step khởi đầu theo kế hoạch: ẩn ⇒ skipped; đã có nội dung ⇒ accepted; còn lại ⇒ pending. */
const initialStatus = (item: StepPlanItem): StepState["status"] => {
  if (item.state === "hidden") return "skipped"
  if (item.section_ids.length && !item.missing) return "accepted"
  return "pending"
}

export interface SeedOptions {
  /** Seq cuối của lô thực thể import — step accepted nhận `last_seq` này để section không bị coi là stale. */
  firstSeq: number | null
  lastSeq: number | null
  at: string
}

/**
 * Op seed `steps[]` + `progress` cho Spine vừa import (steps[] rỗng). Vòng S-5: màn có function ⇒ 5 step accepted;
 * màn không function đã là `placeholder` (spine-builder) nên bị bỏ qua.
 */
export const seedStepOps = (spine: Spine, plan: StepPlanItem[], opts: SeedOptions): Op[] => {
  const accepted = (id: string): StepState => ({ id, status: "accepted", first_seq: opts.firstSeq, last_seq: opts.lastSeq, accepted_at: opts.at })
  const steps: StepState[] = plan.map((item) => {
    const status = initialStatus(item)
    return status === "accepted" ? accepted(item.step_id) : { id: item.step_id, status, first_seq: null, last_seq: null, accepted_at: null }
  })
  const withFunctions = new Set(spine.functions.map((f) => f.screen_id ?? "nonscreen"))
  const loopTemplates = loadStepRegistry().filter((s) => s.kind === "loop")
  for (const key of loopKeys(spine)) {
    if (!withFunctions.has(key)) continue
    for (const t of loopTemplates) steps.push(accepted(`${t.id}@${key}`))
  }

  const probe = { ...spine, steps }
  const placeholders = new Set(spine.screens.filter((s) => s.detail_status === "placeholder").map((s) => s.id))
  const next = orderedSteps(probe).find((st) => {
    if (st.loop !== null && placeholders.has(st.loop)) return false
    const status = steps.find((s) => s.id === st.id)?.status ?? "pending"
    return status !== "accepted" && status !== "skipped"
  })
  return [
    ...steps.map((value): Op => ({ op: "add", path: "steps[]", value })),
    { op: "set", path: "progress.current_phase", value: next?.phase ?? null },
    { op: "set", path: "progress.current_step", value: next?.id ?? null }
  ]
}

/** Op thêm mục riêng vào Spine. */
export const customSectionOps = (sections: CustomSection[]): Op[] => sections.map((value): Op => ({ op: "add", path: "custom_sections[]", value }))
