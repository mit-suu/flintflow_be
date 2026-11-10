/**
 * Áp dụng một lần đổi mẫu đã `ready` vào dự án. Op engine không nhận Mongo session nên không có giao dịch xuyên kho — thay bằng thứ tự
 * ghi + trạng thái `applying` + cờ bước (`apply_steps`) để job phục hồi (`recover-applying.ts`) biết dở ở đâu:
 *
 *   recheck → chiếm `applying` → [dịch] → chạy khô Spine → snapshot → dựng + lưu file nền → ghi Spine → profile + project → `applied`
 *
 *  - Chỉ bước Spine không hoàn tác được từ phía người gọi; mọi bước trước đó chưa đụng bản nháp: lỗi ⇒ trả về `ready` (xoá file mới,
 *    bản riêng vừa đăng ký), bản nháp còn nguyên như cũ.
 *  - Từ khi Spine đã ghi, đường duy nhất là đi tiếp (ghi profile + project): lỗi ⇒ giữ `applying`, phục hồi chạy tiếp (mọi bước idempotent).
 *  - Spine chỉ ghi qua op engine bằng CR nguồn `template_migration` (`change-request/write.service.ts`): Change mang `txn` bắt đầu
 *    `template-migration:<id>`, nên Record of Changes lọc được và hoàn tác nhận ra được.
 *  - Dịch (D9) chạy trước mọi thứ cần dọn và lưu bản dịch trên migration: áp dụng lại sau lỗi không dịch (không trừ credit) lần hai.
 */
import { randomUUID } from "node:crypto"
import mongoose from "mongoose"
import { ChangeRequest } from "../change-request/change-request.model.js"
import type { CrStatus } from "../change-request/change-request.state.js"
import { ensureTemplateMigrationCr, revertTemplateMigrationChanges, writeTemplateMigrationOps } from "../change-request/write.service.js"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { latestDocVersion } from "../doc-version/doc-version.service.js"
import { ChangeLocation } from "../change-request/change-location.model.js"
import { stripRecord } from "../import/check.service.js"
import { mode1RuleProfileFor } from "../import/mode1-guard.js"
import { findVersion, createProjectVersion, discardProjectVersion, toColumns, type TemplateActor } from "../import/org-template-versions.service.js"
import { refreshSegmentHashes } from "../import/finalize.service.js"
import { TemplateProfile, type ITemplateProfile, type TableMapEntry } from "../import/template-profile.model.js"
import { sourceLanguageOf } from "../project/document-language.js"
import { Project } from "../project/project.model.js"
import { getProjectById } from "../project/project.service.js"
import { listChangesForRecord, renderSpineDocument } from "../render/assemble.service.js"
import type { TemplateLayout } from "../render/layout-sections.js"
import { Change as ChangeModel } from "../spine/change.model.js"
import * as flagsService from "../spine/flags.service.js"
import { TransactionRejectedError, planRevert, planTransaction } from "../spine/op-engine.js"
import type { Op } from "../spine/op.types.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Change, Spine } from "../spine/spine.types.js"
import type { TranslationUnit } from "../translation/translation-units.js"
import type { TranslateDocumentExecutor } from "../translation/translation-run.service.js"
import { toUserLocale } from "../../shared/i18n/locale.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { addCustomOps, affectedSectionIds, customIdAllocator, deleteOps, migrationTxn, ownerKeysOf, selectReverseChanges, withSnapshotContinuations } from "./apply-plan.js"
import { BuildBaseFileError, buildBaseFile, planLayout, type PlannedLayout } from "./build-base-file.js"
import { composeProfile } from "./compose-profile.js"
import { editedSections, sectionKeyResolver } from "./edited-since.js"
import {
  TemplateMigration,
  stateUpdate,
  type ApplySteps,
  type ITemplateMigration,
  type MigrationSnapshot
} from "./template-migration.model.js"
import {
  currentBinding,
  invalidState,
  load,
  loadReadySpine,
  sameRef,
  sha256Of,
  stale,
  toDto,
  type MigrationContext,
  type MigrationDto
} from "./template-migration.service.js"
import { resolveAiChoices, type ResolveExecutor, type ResolveResult } from "./resolve-step.js"
import { translateForMigration, type TranslateStepResult } from "./translate-step.js"

export type ApplyStepName = "claimed" | "translated" | "snapshot" | "file" | "spine" | "profile"

export interface ApplyOptions {
  /** Gọi sau mỗi bước xong. Ném ở đây = lỗi giả lập ở đúng bước đó (test) — như một lỗi thật của bước kế tiếp. */
  afterStep?: (step: ApplyStepName) => void | Promise<void>
  /** Lỗi giữa chừng ⇒ chạy phục hồi ngay (mặc định). Tắt để giả lập tiến trình chết: chỉ job phục hồi dọn sau đó. */
  recoverOnError?: boolean
  translateExecutor?: TranslateDocumentExecutor
  resolveExecutor?: ResolveExecutor
}

export const NO_STEPS: ApplySteps = { snapshot: false, file: false, spine: false, profile: false }

type ProfileLean = Partial<ITemplateProfile> & Record<string, unknown>

/** `Spine` thuần (bỏ `projectId` của bản ghi) — op engine kiểm schema đóng nên không nhận khoá thừa. */
const plainSpine = (record: Spine): Spine => {
  const { projectId: _projectId, ...spine } = record as Spine & { projectId?: string }
  return spine
}

const loadProfile = async (projectId: string): Promise<ProfileLean | null> => (await TemplateProfile.findOne({ projectId }).lean()) as unknown as ProfileLean | null

/** Lượt áp dụng này đã bị lượt phục hồi thay thế (token đổi) ⇒ dừng ngay, không ghi thêm gì. */
export class ApplyAbortedError extends Error {
  constructor() {
    super("Lượt áp dụng đã bị lượt phục hồi thay thế")
  }
}

type Holder = Pick<ITemplateMigration, "_id" | "apply_token">

/** Mọi bước ghi của lần đổi mẫu đi qua đây: chỉ lượt đang giữ token mới ghi được; mỗi lần ghi cũng là nhịp sống của lượt. */
export const touch = async (doc: Holder, fields: Record<string, unknown> = {}): Promise<void> => {
  const res = await TemplateMigration.updateOne({ _id: doc._id, state: "applying", apply_token: doc.apply_token }, { $set: { applying_heartbeat: new Date(), ...fields } })
  if (!res.matchedCount) throw new ApplyAbortedError()
}

const beat = (doc: Holder): Promise<void> => touch(doc)

const markStep = (doc: Holder, step: keyof ApplySteps, extra: Record<string, unknown> = {}): Promise<void> => touch(doc, { [`apply_steps.${step}`]: true, ...extra })

/** Kế hoạch op lớn (bản dịch cả tài liệu) ra file, không nhét vào bản ghi migration (trần 16MB). */
const PLAN_INLINE_MAX = 1_000_000

const savePlan = async (doc: ITemplateMigration, work: Pick<SpineWork, "ops" | "revert">, baseVersion: number): Promise<NonNullable<ITemplateMigration["spine_plan"]>> => {
  const json = JSON.stringify(work.ops)
  const base = { revert_seqs: work.revert.map((c) => c.seq), base_version: baseVersion }
  if (json.length <= PLAN_INLINE_MAX) return { ...base, ops: work.ops, ops_file_ref: null }
  const ref = await docFileStore().save(Buffer.from(json, "utf8"), { projectId: String(doc.projectId), kind: "upload", name: `template-migration-${String(doc._id)}-ops.json` })
  return { ...base, ops: null, ops_file_ref: ref }
}

const loadPlanOps = async (plan: NonNullable<ITemplateMigration["spine_plan"]>): Promise<Op[]> => {
  if (plan.ops) return plan.ops
  if (!plan.ops_file_ref) return []
  return JSON.parse((await docFileStore().load(plan.ops_file_ref)).toString("utf8")) as Op[]
}

// ─── kiểm lại lúc áp dụng ────────────────────────────────────────

/** Mọi lệch (Spine, file nền, mẫu, CR đang mở) ⇒ quay về bước phân nhóm và báo 409 — dữ liệu ghim lúc `ready` không còn đúng. */
const bounceToDecisions = async (ctx: MigrationContext, doc: ITemplateMigration, reason: string): Promise<never> => {
  await TemplateMigration.updateOne({ _id: doc._id, state: "ready" }, { $set: stateUpdate("decisions", { prepared_spine_version: null, prepared_source_sha256: null, ready_at: null, resolved_items: [] }) })
  throw stale(reason)
}

const OPEN_CR_EXCLUDED: CrStatus[] = ["written", "rejected", "cancelled"]

const recheck = async (ctx: MigrationContext, doc: ITemplateMigration): Promise<void> => {
  const spine = await loadReadySpine(ctx.projectId)
  const [project, profile, head] = await Promise.all([getProjectById(ctx.projectId, ctx.orgId), loadProfile(ctx.projectId), spineRepository.versionHead(ctx.projectId)])
  if (spine.spine_version !== doc.prepared_spine_version) await bounceToDecisions(ctx, doc, "Tài liệu đã đổi kể từ lúc chuẩn bị.")
  const binding = await currentBinding(project, profile as unknown as ITemplateProfile | null, spine)
  if (binding.source_sha256 !== doc.prepared_source_sha256 || !sameRef(binding.template_ref, doc.from.template_ref)) {
    await bounceToDecisions(ctx, doc, "Mẫu hoặc file nền của dự án đã đổi kể từ lúc chuẩn bị.")
  }
  if (doc.direction === "reverse" && (head?.content_seq ?? 0) !== doc.base_content_seq) await bounceToDecisions(ctx, doc, "Tài liệu có thay đổi mới kể từ lúc chuẩn bị.")

  // CR đang mở mà vị trí của nó nằm ở mục sắp bị xoá / chuyển đi ⇒ áp dụng xong CR mất đích
  const affected = affectedSectionIds(doc, doc.from.headings, doc.groups.structure_only_dropped)
  if (affected.size) {
    const open = await ChangeRequest.find({ projectId: ctx.projectId, status: { $nin: OPEN_CR_EXCLUDED } }, { cr_id: 1 }).lean()
    if (open.length) {
      const hit = await ChangeLocation.exists({ projectId: ctx.projectId, cr_id: { $in: open.map((c) => c.cr_id) }, section_id: { $in: [...affected] } })
      if (hit) await bounceToDecisions(ctx, doc, "Có change request đang mở chạm vào mục sắp bị xoá hoặc chuyển.")
    }
  }
}

// ─── kế hoạch ghi Spine ──────────────────────────────────────────

interface WorkContext {
  doc: ITemplateMigration
  projectId: string
  spine: Spine
  profile: ProfileLean | null
  changes: Change[]
}

export interface SpineWork {
  /** Quyết định hiệu lực: lựa chọn AI (`move_to` cấu trúc / `ai_resolve`) đã thay bằng kết quả của AI. */
  decisions: { id: string; choice: string }[]
  revert: Change[]
  ops: Op[]
  keepKeys: Set<string>
  layout: PlannedLayout
  /** Spine sau khi đảo + ghi op (kết quả chạy khô) — nguồn dựng các mục từ Spine. */
  planned: Spine
  translation: TranslateStepResult | null
}

type ResolveRunner = (spine: Spine) => Promise<ResolveResult>

type TranslateRunner = (spine: Spine, filter: ((unit: TranslationUnit) => boolean) | undefined) => Promise<TranslateStepResult | null>

const planInput = (doc: ITemplateMigration, spine?: Pick<Spine, "functions" | "use_cases" | "features" | "screens">, decisions?: { id: string; choice: string }[]) => ({
  hasSpineElements: !!spine && spine.functions.length + spine.use_cases.length + spine.features.length + spine.screens.length > 0,
  targetHeadings: doc.to.headings,
  oldHeadings: doc.from.headings,
  pairing: doc.pairing,
  groups: doc.groups,
  decisions: decisions ?? doc.decisions.map((d) => ({ id: d.id, choice: d.choice })),
  targetIsSnapshot: doc.direction === "reverse" && !!doc.reverse_of
})

const rejected = (doc: ITemplateMigration, err: TransactionRejectedError): ApiError =>
  new ApiError(
    409,
    doc.direction === "reverse"
      ? "Bỏ các sửa này làm gãy liên kết giữa các phần của tài liệu. Sửa các liên kết bên dưới (hoặc giữ lại các sửa đó) rồi áp dụng lại."
      : "Dữ liệu hiện tại không ghi được theo lần đổi mẫu này. Kiểm tra lại các mục bên dưới.",
    doc.direction === "reverse" ? "TEMPLATE_MIGRATION_LINKS_BROKEN" : "TEMPLATE_MIGRATION_SPINE_REJECTED",
    { violations: err.violations.map((v) => ({ rule: v.rule, path: v.path ?? null, message: v.message })) }
  )

/**
 * Lập kế hoạch Spine: Change cần đảo (đổi ngược) + op (xoá mục riêng, mục riêng trống, chữ dịch) và chạy khô cả hai trên bản sao.
 * Đổi ngược chạy kiểm bất biến / liên kết (op engine) trên toàn bản nháp; gãy ⇒ 409 liệt kê, chưa lưu gì.
 */
export const planSpineWork = async (wc: WorkContext, translate: TranslateRunner, resolve: ResolveRunner, options: { dryRun?: boolean } = {}): Promise<SpineWork> => {
  const { doc } = wc
  const snapshotMode = !!planInput(doc).targetIsSnapshot
  const customId = customIdAllocator(wc.spine)
  const prior = doc.reverse_of ? await TemplateMigration.findById(doc.reverse_of) : null

  let revert: Change[] = []
  let keepKeys = new Set<string>()
  if (doc.direction === "reverse" && prior?.applied_at) {
    const sel = selectReverseChanges({ doc, priorId: String(prior._id), priorAppliedAt: prior.applied_at, oldHeadings: doc.from.headings, followers: doc.pairing.followers, spine: wc.spine, changes: wc.changes })
    revert = sel.changes
    keepKeys = sel.keepKeys
  }

  const guard = <T>(fn: () => T): T => {
    try {
      return fn()
    } catch (err) {
      if (err instanceof TransactionRejectedError) throw rejected(doc, err)
      throw err
    }
  }
  const dry = (spine: Spine, ops: Op[]): Spine => (ops.length ? guard(() => planTransaction(spine, { base_version: spine.spine_version, ops, by: "template-migration", step_id: null }, { startSeq: 1 })).spine : spine)
  const afterRevert = revert.length ? guard(() => planRevert(wc.spine, revert, { by: "template-migration", startSeq: 1 })).spine : wc.spine
  // D8: lựa chọn cần AI chạy trước khi lập layout (kết quả có thể đổi quyết định: chuyển được hay giữ thành mục riêng)
  const resolved = await resolve(afterRevert)
  const layout: PlannedLayout = planLayout(planInput(doc, wc.spine, resolved.decisions), customId)
  if (snapshotMode && prior) layout.entries = withSnapshotContinuations(layout.entries, prior.from.headings)
  // Mục riêng đã được lô đảo xử lý (vd khôi phục / bỏ mục do lần đổi mẫu trước thêm) thì không xoá lần nữa
  const baseOps = [...deleteOps({ groups: doc.groups, decisions: resolved.decisions }, doc.from.headings, afterRevert), ...addCustomOps(layout.newCustoms), ...resolved.ops]
  if (options.dryRun !== false) dry(afterRevert, baseOps)

  let translation: TranslateStepResult | null = null
  if (doc.needs_translation) {
    const resolve = sectionKeyResolver(doc.from.headings, doc.pairing.followers)
    const filter = doc.direction === "reverse" ? (u: TranslationUnit): boolean => ownerKeysOf(afterRevert, u.key, resolve).some((k) => keepKeys.has(k)) : undefined
    translation = await translate(afterRevert, filter)
  }
  const ops = [...baseOps, ...(translation?.ops ?? [])]
  const planned = options.dryRun === false ? afterRevert : dry(afterRevert, ops)
  return { decisions: resolved.decisions, revert, ops, keepKeys, layout, planned, translation }
}

// ─── dịch ────────────────────────────────────────────────────────

const translateRunner =
  (ctx: { doc: ITemplateMigration; userId: string }, executor: TranslateDocumentExecutor | undefined): TranslateRunner =>
  async (spine, filter) => {
    const source = toUserLocale(ctx.doc.from.language)
    const target = toUserLocale(ctx.doc.to.language)
    if (!source || !target) throw new ApiError(422, "Không xác định được ngôn ngữ để dịch.", "TEMPLATE_MIGRATION_LANGUAGE_UNKNOWN")
    const result = await translateForMigration({
      projectId: String(ctx.doc.projectId),
      userId: ctx.userId,
      spine,
      source,
      target,
      stored: ctx.doc.translated_units,
      ...(filter ? { filter } : {}),
      ...(executor ? { executor } : {}),
      onBatch: (units) => touch(ctx.doc, { translated_units: units })
    })
    return result
  }

// ─── snapshot ────────────────────────────────────────────────────

/** Dự án từng theo mẫu tự do: đăng ký file nền cũ thành bản riêng của dự án để đổi ngược có đích (đích đổi ngược phải là một bản mẫu). */
const registerSnapshotVersion = async (ctx: MigrationContext, doc: ITemplateMigration, profile: ProfileLean | null, projectName: string): Promise<MigrationSnapshot["registered_ref"]> => {
  const ref = profile?.source_file_ref
  if (!ref || doc.from.template_ref) return null
  try {
    const buffer = await docFileStore().load(ref)
    const headings = doc.from.headings.filter((h) => h.heading_text.trim()).map((h) => ({ heading_text: h.heading_text, section_id: h.section_id }))
    const { version } = await createProjectVersion(
      ctx.orgId,
      ctx.projectId,
      projectName,
      ctx.actor as TemplateActor,
      { buffer, originalname: "srs-truoc-khi-doi-mau.docx", size: buffer.length },
      { headings, table_map: toColumns((profile.table_map ?? []) as TableMapEntry[]), language: doc.from.language, template_family: doc.from.template_family }
    )
    return { template_id: version.template_id as mongoose.Types.ObjectId, version: version.version }
  } catch (error) {
    console.error("[TemplateMigration] không đăng ký được file nền cũ làm bản riêng của dự án (đổi ngược về mẫu tự do sẽ không có đích):", error instanceof Error ? error.message : error)
    return null
  }
}

const takeSnapshot = async (ctx: MigrationContext, doc: ITemplateMigration, profile: ProfileLean | null): Promise<void> => {
  const project = await getProjectById(ctx.projectId, ctx.orgId)
  const registered_ref = doc.direction === "forward" ? await registerSnapshotVersion(ctx, doc, profile, project.name) : null
  // Snapshot không chứa bản sao Spine (flow2 / mốc nguyên vẹn): chúng bất biến hoặc nằm ở migration trước, khôi phục lấy từ đó
  const { flow2_entry_spine: _f, migrated_base_spine: _m, ...profileLight } = (profile ?? {}) as Record<string, unknown>
  const prior = await TemplateMigration.findOne({ projectId: ctx.projectId, state: "applied" }, { _id: 1 }).sort({ applied_at: -1 }).lean()
  const snapshot: MigrationSnapshot = {
    profile: profile ? profileLight : null,
    prior_anchor_migration_id: prior ? (prior._id as mongoose.Types.ObjectId) : null,
    source_file_ref: profile?.source_file_ref ?? null,
    template_ref: project.template_ref ? { template_id: project.template_ref.template_id, version: project.template_ref.version } : null,
    template_intent: project.template_intent ?? null,
    document_language: project.documentLanguage ?? null,
    registered_ref
  }
  await markStep(doc, "snapshot", { snapshot })
}

// ─── file nền ────────────────────────────────────────────────────

const loadTarget = async (doc: ITemplateMigration): Promise<Buffer> => {
  try {
    return await docFileStore().load(doc.to.file_ref)
  } catch (error) {
    console.error(`[TemplateMigration] không đọc được file mẫu đích ${doc.to.file_ref}:`, error instanceof Error ? error.message : error)
    throw new ApiError(409, "File của mẫu đích không còn trên kho. Huỷ lần đổi mẫu này và chọn lại mẫu.", "TEMPLATE_MIGRATION_TARGET_UNAVAILABLE")
  }
}

const loadSource = async (profile: ProfileLean | null): Promise<Buffer | null> => {
  if (!profile?.source_file_ref) return null
  try {
    return await docFileStore().load(profile.source_file_ref)
  } catch (error) {
    // Không có file nền để chép khối ⇒ dựng toàn bộ từ Spine (cờ vàng ở báo cáo), không dừng áp dụng
    console.error(`[TemplateMigration] không đọc được file nền ${profile.source_file_ref}:`, error instanceof Error ? error.message : error)
    return null
  }
}

/** Layout dùng để dựng bản in từ Spine cho các mục của file mới: theo layout dự kiến, giữ phần còn lại của profile cũ. */
const renderLayoutOf = (doc: ITemplateMigration, work: SpineWork, profile: ProfileLean | null): TemplateLayout => {
  const translated = doc.needs_translation && doc.direction === "forward"
  return {
    fixedTemplate: true,
    layout: work.layout.entries.map((e, order) => ({ order, heading_text: e.heading_text, level: e.level, section_id: e.section_id })),
    language: doc.to.language,
    legacyRecord: (profile?.legacy_record_of_changes ?? []) as TemplateLayout["legacyRecord"],
    ...(profile?.non_screen_table?.length ? { nonScreenTable: profile.non_screen_table } : {}),
    ...(!translated && profile?.function_originals?.length ? { functionOriginals: profile.function_originals as TemplateLayout["functionOriginals"] } : {}),
    ...(profile?.section_slices?.length ? { sectionSlices: profile.section_slices } : {}),
    ...(!translated && profile?.section_segments?.length ? { sectionSegments: profile.section_segments } : {})
  }
}

const buildFile = async (ctx: MigrationContext, doc: ITemplateMigration, work: SpineWork, profile: ProfileLean | null, changes: Change[], spine: Spine): Promise<void> => {
  const project = await getProjectById(ctx.projectId, ctx.orgId)
  const target = await loadTarget(doc)
  const sourceBuffer = await loadSource(profile)
  const translated = doc.needs_translation && doc.direction === "forward"

  // Mục đã bị CR sửa kể từ khi file nền hiện tại được dựng (import, hoặc lần đổi mẫu trước) ⇒ dựng từ Spine
  const since = (profile?.migrated_base_at as Date | null | undefined) ?? new Date(0)
  const resolve = sectionKeyResolver(doc.from.headings, doc.pairing.followers)
  const spineOnly = new Set(editedSections(changes.filter((c) => /^CR-/.test(c.by)), spine, since, resolve).sections.map((s) => s.key))

  const version = (await latestDocVersion(ctx.projectId))?.version ?? "0.1"
  const renderFromSpine = () => renderSpineDocument(ctx.projectId, project.name, work.planned, { version, source: "draft", recordChanges: [] }, { loadTemplate: async () => renderLayoutOf(doc, work, profile) })

  const result = await buildBaseFile({
    target,
    targetHeadings: doc.to.headings,
    oldHeadings: doc.from.headings,
    pairing: doc.pairing,
    groups: doc.groups,
    decisions: work.decisions,
    direction: doc.direction,
    source: sourceBuffer ? { buffer: sourceBuffer, headingKeys: doc.from.headings.filter((h) => h.heading_text.trim()).map((h) => h.key) } : null,
    spineOnly,
    needsTranslation: translated,
    renderFromSpine,
    ...(profile?.legacy_record_of_changes ? { legacyRecordCount: (profile.legacy_record_of_changes as unknown[]).length } : {}),
    targetIsSnapshot: !!planInput(doc).targetIsSnapshot,
    hasSpineElements: planInput(doc, work.planned).hasSpineElements
  }).catch((err: unknown) => {
    if (err instanceof BuildBaseFileError) throw new ApiError(422, "Không dựng được file nền mới từ mẫu đích: số heading của file không khớp mapping đã lưu.", "TEMPLATE_MIGRATION_BUILD_FAILED", { reason: err.code })
    throw err
  })
  if (result.problems.length) {
    throw new ApiError(422, "File nền mới dựng ra không qua kiểm cấu trúc, chưa áp dụng gì.", "TEMPLATE_MIGRATION_BUILD_FAILED", { problems: result.problems.slice(0, 10) })
  }

  const ref = await docFileStore().save(result.buffer, { projectId: ctx.projectId, kind: "upload", name: `template-migration-${String(doc._id)}.docx` })
  try {
    const known = [
      ...((await findVersion(ctx.orgId, String(doc.to.template_id), doc.to.version).then((v) => v.table_map).catch(() => [])) as { header: string; field_path: string | null }[]),
      ...(((profile?.table_map ?? []) as TableMapEntry[]).map((t) => ({ header: t.header, field_path: t.field_path })))
    ]
    const composed = await composeProfile({
      buffer: result.buffer,
      plan: work.layout.entries,
      needsContent: new Set(doc.groups.missing.filter((m) => m.needs_content).map((m) => m.new_key)),
      knownColumns: known
    })
    const warnings = [...result.warnings, ...composed.warnings, ...result.sections.filter((s) => s.flag === "yellow").map((s) => `Mục ${s.section_id}: ${s.reason ?? "cần kiểm tra"}`)]
    const plan = await savePlan(doc, work, spine.spine_version)
    await markStep(doc, "file", {
      new_base_file_ref: ref,
      spine_plan: plan,
      anchor_spine: work.planned,
      new_profile: { ...composed, source_sha256: sha256Of(result.buffer), build_warnings: warnings },
      missing_sections: composed.missing_sections
    })
  } catch (err) {
    await docFileStore().remove(ref).catch(() => undefined)
    throw err
  }
}

// ─── ghi Spine ───────────────────────────────────────────────────

/** Ghi Spine: đảo (đổi ngược) rồi các op, mỗi lô đúng một lần (nhận ra qua `txn` đã có Change). Chạy lại sau lỗi chỉ ghi phần chưa có. */
export const writeSpine = async (doc: ITemplateMigration, userId: string): Promise<void> => {
  const plan = doc.spine_plan
  if (!plan) throw new Error("Thiếu kế hoạch ghi Spine của lần đổi mẫu")
  const seqs = new Set(plan.revert_seqs)
  const revert = seqs.size ? (await spineRepository.listChanges(String(doc.projectId))).filter((c) => seqs.has(c.seq)) : []
  const ops = await loadPlanOps(plan)
  const projectId = String(doc.projectId)
  const id = String(doc._id)
  const crId = doc.spine_cr_id ?? (await ensureTemplateMigrationCr(projectId, id, userId, `Đổi mẫu sang ${doc.to.name || "mẫu mới"}`))
  if (!doc.spine_cr_id) await touch(doc, { spine_cr_id: crId })
  const written = async (suffix?: "revert"): Promise<boolean> => !!(await ChangeModel.exists({ projectId, txn: migrationTxn(id, suffix) }))
  const reason = `${crId}: đổi mẫu sang ${doc.to.name || "mẫu mới"}`
  // Khoá lạc quan theo version lúc lập kế hoạch: Spine đổi từ đó ⇒ 409 SPINE_VERSION_CONFLICT, chưa ghi gì ⇒ phục hồi trả về `ready`.
  // Lô đầu đã ghi (chạy lại sau lỗi) thì version đã đi tiếp: lô sau theo version hiện tại.
  // Một lô op engine tăng version đúng một lần ⇒ version sau lô đảo là `base_version + 1`: lô op luôn có khoá lạc quan, kể cả khi chạy tiếp
  // sau lỗi (Spine bị người khác ghi chen ⇒ 409, không đè bản dịch chữ cũ lên sửa mới)
  if (revert.length && !(await written("revert"))) {
    await touch(doc)
    await revertTemplateMigrationChanges(projectId, revert, { crId, txn: migrationTxn(id, "revert"), baseVersion: plan.base_version })
  }
  if (ops.length && !(await written())) {
    await touch(doc)
    await writeTemplateMigrationOps(projectId, ops, { crId, txn: migrationTxn(id), reason, baseVersion: plan.base_version + (revert.length ? 1 : 0) })
  }
}

/** Đã có Change của lần đổi mẫu này trong log (dù chưa kịp đánh dấu bước) ⇒ Spine đã ghi một phần hoặc toàn bộ. */
export const hasSpineWrites = async (doc: ITemplateMigration): Promise<boolean> =>
  doc.apply_steps.spine || !!(await ChangeModel.exists({ projectId: doc.projectId, txn: { $regex: `^${migrationTxn(String(doc._id))}(:|$)` } }))

// ─── profile + project ───────────────────────────────────────────

/** Ghi profile mới + `Project` (idempotent: `$set` cùng giá trị). Chạy sau khi chữ dịch / mục riêng đã nằm trong Spine. */
export const writeProfileAndProject = async (doc: ITemplateMigration, now: Date = new Date()): Promise<void> => {
  const projectId = String(doc.projectId)
  const np = doc.new_profile as (Record<string, unknown> & { source_sha256: string; build_warnings?: string[] }) | null
  if (!np || !doc.new_base_file_ref) throw new Error("Thiếu dữ liệu file nền mới để ghi profile")
  const base = (doc.snapshot?.profile ?? null) as ProfileLean | null
  const translated = doc.needs_translation && doc.direction === "forward"
  await touch(doc)
  const { build_warnings: _w, ...fields } = np
  const at = doc.spine_written_at ?? now
  const $set: Record<string, unknown> = {
    ...fields,
    source_file_ref: doc.new_base_file_ref,
    language: doc.to.language,
    template_family: doc.to.template_family ?? base?.template_family ?? "fpt",
    // Chữ đã dịch ⇒ nguyên văn / đoạn nguyên văn của file cũ không còn đúng ngôn ngữ: bản in dùng Spine
    function_originals: translated ? [] : (base?.function_originals ?? []),
    section_segments: translated ? [] : (base?.section_segments ?? []),
    section_slices: base?.section_slices ?? [],
    migration_missing_sections: doc.missing_sections,
    // Mốc nguyên vẹn = Spine theo kế hoạch lúc áp dụng (không đọc Spine sống: chạy tiếp sau lỗi có thể đã lẫn sửa của người khác)
    // Chỉ đổi ngôn ngữ tài liệu (mode 2 / FPT): bản in tiếp tục từ Spine qua lớp bản dịch, không coi file nền mới là nền nguyên văn
    migrated_base_at: doc.language_switch_only ? null : at,
    migrated_base_spine: null,
    migrated_base_migration_id: doc._id
  }
  const existing = await TemplateProfile.exists({ projectId })
  if (existing) await TemplateProfile.updateOne({ projectId }, { $set })
  else {
    // Dự án chưa có profile (mẫu FPT sinh từ Spine): tạo profile đủ trường bắt buộc
    const version = (await latestDocVersion(projectId))?.version ?? "0.1"
    await TemplateProfile.create({ projectId, doc_version: version, ...$set })
  }
  const language = toUserLocale(doc.to.language)
  await Project.updateOne(
    { _id: projectId },
    { $set: { template_ref: { template_id: doc.to.template_id, version: doc.to.version }, template_intent: "fixed", ...(language ? { documentLanguage: language } : {}) } }
  )
  if (!translated) await refreshSegmentHashes(projectId).catch((e: unknown) => console.warn("[TemplateMigration] tính lại dấu đoạn lỗi (bản in dùng Spine cho đoạn lệch):", e instanceof Error ? e.message : e))
}

export const recomputeFlags = async (projectId: string, crId: string): Promise<void> => {
  try {
    await flagsService.recompute(projectId, { by: crId, ruleProfile: await mode1RuleProfileFor(projectId), atBaseline: true })
  } catch (err) {
    console.warn(`[TemplateMigration] ${crId}: đã ghi nhưng tính lại cờ lỗi — cờ sẽ được tính lại ở lần recompute sau`, err)
  }
}

export const finalizeApplied = async (doc: ITemplateMigration, now: Date): Promise<ITemplateMigration> => {
  const done = await TemplateMigration.findOneAndUpdate(
    { _id: doc._id, state: "applying", apply_token: doc.apply_token },
    { $set: stateUpdate("applied", { applied_at: doc.spine_written_at ?? now, apply_token: null, translated: doc.needs_translation, applying_heartbeat: null, "apply_steps.profile": true }) },
    { returnDocument: "after" }
  )
  if (!done) return (await TemplateMigration.findById(doc._id))!
  if (done.spine_cr_id) await recomputeFlags(String(done.projectId), done.spine_cr_id)
  return done
}

// ─── trả về ready ────────────────────────────────────────────────

/** Spine chưa ghi gì ⇒ bản nháp còn nguyên: bỏ file mới + bản riêng vừa đăng ký, về `ready` để áp dụng lại (kiểm lại dữ liệu ở lần sau). */
export const rollbackToReady = async (doc: ITemplateMigration): Promise<void> => {
  const failures = await cleanupArtifacts(doc)
  await TemplateMigration.updateOne(
    { _id: doc._id, state: "applying", apply_token: doc.apply_token },
    {
      $set: stateUpdate("ready", { apply_steps: { ...NO_STEPS }, new_base_file_ref: null, new_profile: null, spine_plan: null, anchor_spine: null, snapshot: null, missing_sections: [], applying_heartbeat: null, apply_token: null }),
      ...(failures.length ? { $push: { warnings: { $each: failures } } } : {})
    }
  )
}

/**
 * Dọn file nền mới, file kế hoạch op và bản riêng vừa đăng ký. Lỗi dọn được log **và** ghi vào `warnings` của migration (không nuốt):
 * file / bản riêng rò rỉ thì người vận hành thấy được và dọn tay.
 */
export const cleanupArtifacts = async (doc: ITemplateMigration): Promise<string[]> => {
  const failures: string[] = []
  const attempt = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error(`[TemplateMigration] dọn ${what} thất bại:`, message)
      failures.push(`Dọn ${what} thất bại (${message}) — cần dọn tay`)
    }
  }
  if (doc.new_base_file_ref) await attempt("file nền mới", () => docFileStore().remove(doc.new_base_file_ref!))
  if (doc.spine_plan?.ops_file_ref) await attempt("file kế hoạch op", () => docFileStore().remove(doc.spine_plan!.ops_file_ref!))
  const reg = doc.snapshot?.registered_ref
  if (reg) {
    await attempt("bản riêng của file nền cũ", async () => {
      const version = await findVersion(String(doc.orgId), String(reg.template_id), reg.version).catch(() => null)
      if (version) await discardProjectVersion(version)
    })
  }
  return failures
}

// ─── áp dụng ─────────────────────────────────────────────────────

const claim = async (ctx: MigrationContext, id: string): Promise<ITemplateMigration> => {
  const doc = await TemplateMigration.findOneAndUpdate(
    { _id: id, projectId: ctx.projectId, orgId: ctx.orgId, state: "ready" },
    { $set: stateUpdate("applying", { applying_heartbeat: new Date(), apply_token: randomUUID(), apply_attempts: 0, apply_steps: { ...NO_STEPS }, new_base_file_ref: null, new_profile: null, spine_plan: null, anchor_spine: null, spine_written_at: null }) },
    { returnDocument: "after" }
  )
  if (doc) return doc
  throw invalidState((await load(ctx, id)).state, ["ready"])
}

export const applyMigration = async (ctx: MigrationContext, id: string, options: ApplyOptions = {}): Promise<MigrationDto> => {
  const loaded = await load(ctx, id)
  if (loaded.state === "applying") throw new ApiError(409, "Lần đổi mẫu đang được áp dụng.", "TEMPLATE_MIGRATION_APPLYING")
  if (loaded.state !== "ready") throw invalidState(loaded.state, ["ready"])
  await recheck(ctx, loaded)
  const doc = await claim(ctx, id)
  const step = async (name: ApplyStepName): Promise<void> => void (await options.afterStep?.(name))

  try {
    await step("claimed")
    const [spine, profile, changes] = await Promise.all([loadReadySpine(ctx.projectId).then(plainSpine), loadProfile(ctx.projectId), spineRepository.listChanges(ctx.projectId)])
    // Khe giữa `recheck` và `claim`: Spine đổi từ lúc kiểm ⇒ trả về `ready` rồi về bước phân nhóm (dữ liệu ghim lúc ready không còn đúng)
    if (spine.spine_version !== doc.prepared_spine_version) {
      await rollbackToReady(doc)
      await bounceToDecisions(ctx, doc, "Tài liệu đã đổi trong lúc bắt đầu áp dụng.")
    }
    const wc: WorkContext = { doc, projectId: ctx.projectId, spine, profile, changes }
    const work = await planSpineWork(
      wc,
      translateRunner({ doc, userId: ctx.actor.userId }, options.translateExecutor),
      (afterRevert) =>
        resolveAiChoices({ doc, projectId: ctx.projectId, userId: ctx.actor.userId, spine: afterRevert, ...(options.resolveExecutor ? { executor: options.resolveExecutor } : {}), onItem: (items) => touch(doc, { resolved_items: items }) })
    )
    await step("translated")
    await beat(doc)
    await takeSnapshot(ctx, doc, profile)
    await step("snapshot")
    const fresh = (await TemplateMigration.findById(doc._id))!
    await buildFile(ctx, fresh, work, profile, changes, spine)
    await step("file")
    const withFile = (await TemplateMigration.findById(doc._id))!
    await writeSpine(withFile, ctx.actor.userId)
    await markStep(doc, "spine", { spine_written_at: new Date() })
    await step("spine")
    const now = new Date()
    await writeProfileAndProject((await TemplateMigration.findById(doc._id))!, now)
    await step("profile")
    return await toDto(await finalizeApplied((await TemplateMigration.findById(doc._id))!, now))
  } catch (err) {
    if (options.recoverOnError === false || err instanceof ApplyAbortedError) throw err
    const { recoverApplyingMigration } = await import("./recover-applying.js")
    const outcome = await recoverApplyingMigration(String(doc._id), { force: true }).catch((e: unknown) => {
      console.error("[TemplateMigration] phục hồi sau lỗi áp dụng thất bại — job phục hồi sẽ thử lại:", e instanceof Error ? e.message : e)
      return "pending" as const
    })
    // Đã ghi Spine thì đi tiếp tới cùng: kết quả là `applied`, không báo lỗi
    if (outcome === "applied") return toDto((await TemplateMigration.findById(doc._id))!)
    throw err
  }
}

