/**
 * Chuẩn bị đổi mẫu (xuôi hoặc ngược) cho dự án đã có baseline: chọn mẫu đích → mapping → ghép mục → phân nhóm → quyết định của
 * BA → `ready`. Chưa đụng bản nháp / Spine / file nền (dựng file nền là bước sau, áp dụng là bước sau nữa). Phân nhóm không gọi AI.
 *
 * Ràng buộc: chỉ Lead / Analyst (route), mẫu phải thuộc đúng org của dự án (`findOne({ _id, orgId })`), dự án phải có baseline,
 * bản nháp không bị khoá chờ Lead duyệt, và mỗi dự án chỉ một lần đổi mẫu đang mở (index duy nhất từng phần).
 */
import { createHash } from "node:crypto"
import mongoose from "mongoose"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { DocBlock } from "../import/doc-block.model.js"
import { OrgTemplate, OrgTemplateVersion, type IOrgTemplate, type IOrgTemplateVersion } from "../import/org-library.model.js"
import {
  analyzeTemplateFile,
  assertCanPublish,
  createDraftVersion,
  createProjectVersion,
  deleteFamily,
  discardProjectVersion,
  findFamily,
  findFamilyAny,
  findVersion,
  materializeLegacyVersion,
  publishVersion,
  type AnalyzedTemplate,
  type TemplateActor,
  type TemplateFile
} from "../import/org-template-versions.service.js"
import { parseDocument } from "../import/parse.service.js"
import { assignBlockSections } from "../import/profile-match.service.js"
import { isKnownSectionId, SECTION_CANDIDATES } from "../import/section-catalog.js"
import { TemplateProfile, type HeadingMapEntry, type ITemplateProfile } from "../import/template-profile.model.js"
import { foldText } from "../import/text-similarity.js"
import { sourceLanguageOf } from "../project/document-language.js"
import { getProjectById } from "../project/project.service.js"
import type { IProject } from "../project/project.model.js"
import { assertDraftUnlocked } from "../spine/draft-lock.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { translationUnits } from "../translation/translation-units.js"
import { toUserLocale } from "../../shared/i18n/locale.js"
import { ApiError } from "../../shared/utils/api-error.js"
import {
  classify,
  decidableItems,
  settleDecisions,
  tableShapesBySection,
  type MigrationGroups,
  type TableShape
} from "./classify.js"
import { brokenLinks, revertability, type BrokenLink, type RevertBlockReason } from "./precheck.js"
import { editedSince, sectionKeyResolver, type EditedSection } from "./edited-since.js"
import { aiChoiceCounts, estimateMigrationCredits, loadMigrationUnitCosts, type MigrationCreditEstimate } from "./migration-credit.js"
import {
  applyPairEdits,
  normalizeElementId,
  pairSections,
  PairEditError,
  type NewHeading,
  type OldHeading,
  type PairEdit,
  type PairOptions,
  type PairingResult
} from "./pair-sections.js"
import {
  TemplateMigration,
  stateUpdate,
  type ITemplateMigration,
  type MigrationAnalysis,
  type MigrationFrom,
  type MigrationState,
  type MigrationTo
} from "./template-migration.model.js"

export interface MigrationContext {
  projectId: string
  orgId: string
  actor: TemplateActor
}

export type StartInput =
  | { kind: "template"; template_id: string; version: number }
  | { kind: "file"; file: TemplateFile; publish_to_org: boolean; name?: string; template_id?: string }

export const MIGRATION_NOT_FOUND = () => new ApiError(404, "Không tìm thấy lần đổi mẫu này.", "TEMPLATE_MIGRATION_NOT_FOUND")
export const invalidState = (state: MigrationState, allowed: readonly MigrationState[]) =>
  new ApiError(409, `Lần đổi mẫu đang ở bước "${state}", không thực hiện được thao tác này.`, "TEMPLATE_MIGRATION_INVALID_STATE", { state, allowed })
export const stale = (reason: string) => new ApiError(409, `${reason} Hãy huỷ và chuẩn bị lại lần đổi mẫu.`, "TEMPLATE_MIGRATION_STALE")

// ─── kiểm tra điều kiện bắt đầu ──────────────────────────────────

/** D5: chỉ đổi mẫu sau baseline; bản nháp đang chờ Lead duyệt thì khoá (UC-45). */
export const loadReadySpine = async (projectId: string): Promise<Spine> => {
  const spine = await spineRepository.get(projectId)
  if (!spine) throw new ApiError(404, "Không tìm thấy dữ liệu dự án.", "SPINE_NOT_FOUND")
  if (!spine.baselines.length) {
    throw new ApiError(409, "Chỉ đổi được mẫu sau khi tài liệu đã có baseline. Trước baseline, hãy tải lại file hoặc tạo lại dự án theo mẫu đúng.", "TEMPLATE_MIGRATION_NO_BASELINE")
  }
  assertDraftUnlocked(spine)
  return spine
}

const isDuplicateKey = (err: unknown): boolean => err instanceof mongoose.mongo.MongoServerError && err.code === 11000

// ─── dữ liệu hiện tại của dự án (phía "cũ") ─────────────────────

const levelOfNumber = (number: string): number => number.split(".").length

const numberOrder = (number: string): number[] => (number === "I" ? [0] : number.split(".").map(Number))
const compareNumbers = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) - (b[i] ?? -1)
  return 0
}

/** Dự án chưa có layout (mẫu FPT sinh từ Spine): heading là các mục của mẫu FPT + mục riêng của Spine. */
const fptHeadings = (spine: Spine): OldHeading[] => {
  const framework = [...SECTION_CANDIDATES]
    .sort((a, b) => compareNumbers(numberOrder(a.number), numberOrder(b.number)))
    .map((c) => ({ key: c.id, heading_text: `${c.number} ${c.titles[0]}`, level: levelOfNumber(c.number), section_id: c.id }))
  const custom = spine.custom_sections.filter((c) => c.heading.trim()).map((c) => ({ key: `custom:${c.id}`, heading_text: c.heading, level: c.level, section_id: `custom:${c.id}` }))
  return [...framework, ...custom]
}

/** `key` duy nhất: `section_id` của layout (mỗi mục xuất hiện một lần); trùng thì thêm hậu tố. */
const uniqueKeys = <T extends { section_id: string }>(items: readonly T[]): (T & { key: string })[] => {
  const seen = new Map<string, number>()
  return items.map((i) => {
    const n = (seen.get(i.section_id) ?? 0) + 1
    seen.set(i.section_id, n)
    return { ...i, key: n === 1 ? i.section_id : `${i.section_id}#${n}` }
  })
}

const oldHeadingsOf = (profile: ITemplateProfile | null, spine: Spine): OldHeading[] => {
  if (!profile?.layout?.length) return fptHeadings(spine)
  const ordered = [...profile.layout].sort((a, b) => a.order - b.order)
  return uniqueKeys(ordered.map((l) => ({ heading_text: l.heading_text, level: l.level, section_id: l.section_id }))).map((l) => ({
    key: l.key,
    heading_text: l.heading_text,
    level: l.level,
    section_id: l.section_id
  }))
}

/** Tên + mã UC / tính năng / chức năng / màn của Spine: heading trùng ⇒ phần tử, đi theo mục cha. */
const elementOptions = (spine: Spine): PairOptions => {
  const named = [...spine.use_cases, ...spine.features, ...spine.functions, ...spine.screens]
  return {
    elementNames: new Set(named.map((e) => foldText(e.name)).filter(Boolean)),
    elementIds: new Set(named.map((e) => normalizeElementId(e.id)))
  }
}

export const sha256Of = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex")

/** Binding hiện tại của dự án — để biết đổi từ đâu và để bước sau biết dữ liệu có đổi giữa chừng không. */
export const currentBinding = async (project: IProject, profile: ITemplateProfile | null, spine: Spine): Promise<MigrationFrom> => {
  let sha = profile?.source_sha256 ?? null
  if (!sha && profile?.source_file_ref) {
    try {
      sha = sha256Of(await docFileStore().load(profile.source_file_ref))
    } catch (error) {
      // Không băm buffer rỗng: không đọc được file nền thì không có dấu để so, báo rõ thay vì ghim dấu rác
      console.error(`[TemplateMigration] không đọc được file nền của dự án ${String(project._id)}:`, error instanceof Error ? error.message : error)
      throw new ApiError(503, "Không đọc được file nền của dự án lúc này. Thử lại sau.", "TEMPLATE_MIGRATION_SOURCE_UNAVAILABLE")
    }
  }
  return {
    template_ref: project.template_ref ? { template_id: project.template_ref.template_id, version: project.template_ref.version } : null,
    source_file_ref: profile?.source_file_ref ?? null,
    source_sha256: sha,
    doc_version: profile?.doc_version ?? null,
    language: sourceLanguageOf(project, profile?.language),
    template_family: profile?.template_family ?? null,
    headings: oldHeadingsOf(profile, spine)
  }
}

// ─── bảng của hai phía ───────────────────────────────────────────

const oldTablesOf = async (projectId: string, profile: ITemplateProfile | null): Promise<Map<string, TableShape[]>> => {
  if (!profile?.doc_version) return new Map()
  const blocks = await DocBlock.find({ projectId, doc_version: profile.doc_version, kind: "table" }).select("block_id section_id rows").lean()
  const paths = new Map((profile.table_map ?? []).map((t) => [`${t.block_id}#${t.column_index}`, t.field_path]))
  return tableShapesBySection(blocks, paths)
}

/**
 * Bảng của mẫu đích theo mục: đọc lại file mẫu (cùng file ⇒ cùng `block_id` như lúc phân tích) và gán mục theo mapping đã rà
 * của bản. Không đọc được ⇒ bỏ qua so bảng và báo trong `warnings` (không lặng lẽ).
 */
const newTablesOf = async (buffer: Buffer, version: Pick<IOrgTemplateVersion, "headings" | "table_map">): Promise<{ tables: Map<string, TableShape[]>; warning: string | null; levels: number[] | null }> => {
  try {
    const { blocks } = await parseDocument(buffer)
    const headingBlocks = blocks.filter((b) => b.kind === "heading" && b.level !== null)
    if (headingBlocks.length !== version.headings.length) return { tables: new Map(), levels: null, warning: "Không đối chiếu được bảng của mẫu mới (số heading của file không khớp mapping), nên chưa phát hiện được bảng đổi cột." }
    const headingMap: HeadingMapEntry[] = headingBlocks.map((b, i) => ({
      block_id: b.block_id,
      heading_text: version.headings[i].heading_text,
      section_id: version.headings[i].section_id,
      confidence: 1,
      detected_by: "user",
      confirmed: true
    }))
    const sections = assignBlockSections(blocks, headingMap)
    const paths = new Map(version.table_map.map((t) => [`${t.block_id}#${t.column_index}`, t.field_path]))
    const tables = blocks.filter((b) => b.kind === "table").map((b) => ({ block_id: b.block_id, section_id: sections.get(b.block_id) ?? null, rows: b.rows }))
    return { tables: tableShapesBySection(tables, paths), warning: null, levels: headingBlocks.map((b) => b.level as number) }
  } catch (error) {
    console.error("[TemplateMigration] đọc bảng của mẫu đích lỗi:", error instanceof Error ? error.message : error)
    return { tables: new Map(), levels: null, warning: "Không đọc được bảng của mẫu mới nên chưa phát hiện được bảng đổi cột." }
  }
}

// ─── mẫu đích ────────────────────────────────────────────────────

const newHeadingsOf = (v: Pick<IOrgTemplateVersion, "headings">): NewHeading[] =>
  v.headings.map((h, i) => ({
    key: `n${i}`,
    heading_text: h.heading_text,
    section_id: h.section_id,
    ...(h.auto_confirmed ? { auto_confirmed: true } : {}),
    ...(h.guidance ? { guidance: h.guidance } : {})
  }))

const toSideOf = (family: Pick<IOrgTemplate, "_id" | "name">, v: IOrgTemplateVersion): MigrationTo => ({
  template_id: family._id as mongoose.Types.ObjectId,
  version: v.version,
  name: family.name,
  visibility: v.visibility,
  file_ref: v.file_ref,
  sha256: v.source_file.sha256,
  language: v.language,
  template_family: v.template_family ?? null,
  headings: newHeadingsOf(v)
})

/** Bản mẫu org chọn được: mọi bản đã đăng của họ mẫu thuộc org (kể cả cũ hơn), hoặc bản riêng của chính dự án này. */
const resolveOrgTarget = async (orgId: string, projectId: string, templateId: string, version: number): Promise<{ family: IOrgTemplate; version: IOrgTemplateVersion }> => {
  const family = await findFamilyAny(orgId, templateId)
  // Họ ẩn chỉ nhận khi là của chính dự án này
  if (family.project_id && String(family.project_id) !== projectId) throw new ApiError(404, "Không tìm thấy mẫu của tổ chức.", "ORG_TEMPLATE_NOT_FOUND")
  await materializeLegacyVersion(family)
  const v = await findVersion(orgId, templateId, version)
  const visible = v.status === "published" && (v.visibility === "org" || (v.visibility === "project" && String(v.project_id) === projectId))
  if (!visible) throw new ApiError(404, "Không tìm thấy bản này của mẫu.", "ORG_TEMPLATE_VERSION_NOT_FOUND")
  return { family, version: v }
}

/** File mẫu tải lên: Lead có thể đăng lên org (`publishVersion`), còn lại là bản riêng của dự án. Trả cả cách dọn khi bước sau lỗi. */
const persistUploadedTarget = async (
  ctx: MigrationContext,
  project: IProject,
  input: Extract<StartInput, { kind: "file" }>,
  analyzed: AnalyzedTemplate
): Promise<{ family: IOrgTemplate; version: IOrgTemplateVersion; rollback: () => Promise<void> }> => {
  const { orgId, actor } = ctx
  if (!input.publish_to_org) {
    const created = await createProjectVersion(orgId, ctx.projectId, project.name, actor, input.file, analyzed)
    return { ...created, rollback: () => discardProjectVersion(created.version) }
  }
  const existing = input.template_id ? await findFamily(orgId, input.template_id) : null
  const name = input.name?.trim() || input.file.originalname.replace(/\.docx$/i, "").slice(0, 120) || "Mẫu mới"
  const family = existing ?? (await OrgTemplate.create({ orgId, name, created_by: actor.userId, latest_version: 0 }))
  let draftRef: IOrgTemplateVersion | null = null
  try {
    const draft = await createDraftVersion(orgId, actor, family, input.file, analyzed)
    draftRef = draft
    await publishVersion(orgId, actor, String(family._id), draft.version)
    // Đã đăng lên thư viện là việc người dùng chủ động chọn — lần đổi mẫu lỗi sau đó không gỡ bản này
    return { family, version: (await findVersion(orgId, String(family._id), draft.version)), rollback: async () => undefined }
  } catch (err) {
    const log = (e: unknown) => console.error("[TemplateMigration] dọn mẫu vừa tạo sau lỗi thất bại:", e instanceof Error ? e.message : e)
    if (!existing) await deleteFamily(orgId, String(family._id)).catch(log)
    else if (draftRef) {
      // Bản nháp chưa đăng của họ có sẵn không được ở lại thư viện
      const dropped = await OrgTemplateVersion.findOneAndDelete({ _id: draftRef._id, status: "draft" }).catch((e: unknown) => (log(e), null))
      if (dropped) await docFileStore().remove(dropped.file_ref).catch(log)
    }
    throw err
  }
}

// ─── bắt đầu ─────────────────────────────────────────────────────

/** Đổi ngược (D15): đích chính là mẫu trước của lần đổi gần nhất đã áp dụng (cùng bản mẫu hoặc cùng file nguồn). */
const reverseTargetOf = async (projectId: string, to: MigrationTo): Promise<ITemplateMigration | null> => {
  const latest = await TemplateMigration.findOne({ projectId, state: "applied", applied_at: { $ne: null } }).sort({ applied_at: -1 })
  if (!latest) return null
  const ref = latest.from.template_ref
  const sameRef = !!ref && String(ref.template_id) === String(to.template_id) && ref.version === to.version
  const sameFile = !!latest.from.source_sha256 && latest.from.source_sha256 === to.sha256
  return sameRef || sameFile ? latest : null
}

export const sameRef = (a: MigrationFrom["template_ref"], b: MigrationFrom["template_ref"]): boolean =>
  (!a && !b) || (!!a && !!b && String(a.template_id) === String(b.template_id) && a.version === b.version)

const sameAsCurrent = (from: MigrationFrom, to: MigrationTo): boolean =>
  (!!from.template_ref && String(from.template_ref.template_id) === String(to.template_id) && from.template_ref.version === to.version) || (!!from.source_sha256 && from.source_sha256 === to.sha256)

const toRecord = (m: ReadonlyMap<string, TableShape[]>): Record<string, TableShape[]> => Object.fromEntries(m)
const toMap = (r: Record<string, TableShape[]>): Map<string, TableShape[]> => new Map(Object.entries(r))

interface Prepared {
  /** Mẫu đích kèm cấp heading đọc từ file (để nhận heading ví dụ lồng dưới mục chứa phần tử). */
  to: MigrationTo
  pairing: PairingResult
  analysis: MigrationAnalysis
  groups: MigrationGroups
  warnings: string[]
  direction: "forward" | "reverse"
  reverse_of: mongoose.Types.ObjectId | null
}

/**
 * Đổi ngược có bản chụp file nền của lần đổi mẫu trước: đích thật là **chính bản chụp đó** (đúng file + heading + bảng của nó),
 * không phải file sạch của mẫu — bước dựng chép lại nguyên khối từ bản chụp. Không đọc được bản chụp ⇒ dùng mẫu đã chọn.
 */
const snapshotTarget = async (previous: ITemplateMigration | null, to: MigrationTo, buffer: Buffer, version: IOrgTemplateVersion): Promise<{ to: MigrationTo; buffer: Buffer; version: Pick<IOrgTemplateVersion, "headings" | "table_map"> }> => {
  const ref = previous?.snapshot?.source_file_ref
  if (!previous || !ref) return { to, buffer, version }
  try {
    const snapBuffer = await docFileStore().load(ref)
    const headings = previous.from.headings.filter((h) => h.heading_text.trim()).map((h) => ({ heading_text: h.heading_text, section_id: h.section_id }))
    const table_map = ((previous.snapshot?.profile?.table_map as IOrgTemplateVersion["table_map"] | undefined) ?? []).map((t) => ({ block_id: t.block_id, column_index: t.column_index, header: t.header, field_path: t.field_path }))
    return {
      to: { ...to, file_ref: ref, sha256: previous.from.source_sha256 ?? to.sha256, headings: headings.map((h, i) => ({ key: `n${i}`, ...h })) },
      buffer: snapBuffer,
      version: { headings, table_map }
    }
  } catch (error) {
    console.error("[TemplateMigration] không đọc được bản chụp file nền của lần đổi mẫu trước, dùng file mẫu đã chọn:", error instanceof Error ? error.message : error)
    return { to, buffer, version }
  }
}

const prepare = async (projectId: string, spine: Spine, profile: ITemplateProfile | null, from: MigrationFrom, target: MigrationTo, targetBuffer: Buffer, targetVersion: IOrgTemplateVersion): Promise<Prepared> => {
  const previous = await reverseTargetOf(projectId, target)
  const { to, buffer, version } = await snapshotTarget(previous, target, targetBuffer, targetVersion)
  const [oldTables, newSide] = await Promise.all([oldTablesOf(projectId, profile), newTablesOf(buffer, version)])
  const neu = newSide.levels ? to.headings.map((h, i) => ({ ...h, level: newSide.levels![i] })) : to.headings
  const pairing = pairSections(from.headings, neu, elementOptions(spine))
  let edited: EditedSection[] | null = null
  const warnings = newSide.warning ? [newSide.warning] : []
  if (previous?.applied_at) {
    const result = await editedSince(projectId, previous.applied_at, sectionKeyResolver(from.headings, pairing.followers))
    edited = result.sections
    if (result.unattributed) warnings.push(`${result.unattributed} thay đổi sau lần đổi mẫu trước không gắn được vào mục nào của tài liệu — kiểm tra lại khi áp dụng.`)
  }
  const analysis: MigrationAnalysis = { old_tables: toRecord(oldTables), new_tables: toRecord(newSide.tables), edited }
  const groups = classify({ old: from.headings, neu, pairing, oldTables, newTables: newSide.tables, edited })
  return { to: { ...to, headings: neu }, pairing, analysis, groups, warnings, direction: previous ? "reverse" : "forward", reverse_of: previous ? (previous._id as mongoose.Types.ObjectId) : null }
}

/** Dự án giữ chữ gốc của khách trong Spine (import thật) — khác dự án tạo SRS / chuyển từ FPT (Spine luôn tiếng Anh). */
export const keepsCustomerText = (project: Pick<IProject, "mode" | "converted_from">): boolean => project.mode === "import" && project.converted_from !== "fpt"

export const startMigration = async (ctx: MigrationContext, input: StartInput): Promise<MigrationDto> => {
  const project = await getProjectById(ctx.projectId, ctx.orgId)
  const spine = await loadReadySpine(ctx.projectId)
  const open = await TemplateMigration.findOne({ projectId: ctx.projectId, open: true }).select("_id state").lean()
  if (open) throw new ApiError(409, "Dự án đang có một lần đổi mẫu chưa xong. Hoàn tất hoặc huỷ lần đó trước.", "TEMPLATE_MIGRATION_OPEN", { migration_id: String(open._id), state: open.state })

  const profile = await TemplateProfile.findOne({ projectId: ctx.projectId })
  const from = await currentBinding(project, profile, spine)

  let family: IOrgTemplate
  let version: IOrgTemplateVersion
  let rollback: () => Promise<void> = async () => undefined
  if (input.kind === "template") {
    ;({ family, version } = await resolveOrgTarget(ctx.orgId, ctx.projectId, input.template_id, input.version))
  } else {
    // Lead mới đăng được lên thư viện: chặn trước khi đọc / lưu file
    if (input.publish_to_org) assertCanPublish(ctx.actor)
    const analyzed = await analyzeTemplateFile(input.file.buffer)
    if (from.source_sha256 && from.source_sha256 === sha256Of(input.file.buffer)) {
      throw new ApiError(409, "File này chính là mẫu dự án đang theo.", "TEMPLATE_MIGRATION_SAME_TEMPLATE")
    }
    ;({ family, version, rollback } = await persistUploadedTarget(ctx, project, input, analyzed))
  }

  try {
    const to = toSideOf(family, version)
    if (sameAsCurrent(from, to)) throw new ApiError(409, "Dự án đang theo đúng mẫu này.", "TEMPLATE_MIGRATION_SAME_TEMPLATE")
    const buffer = input.kind === "file" ? input.file.buffer : await docFileStore().load(version.file_ref)
    const prepared = await prepare(ctx.projectId, spine, profile, from, to, buffer, version)
    const head = await spineRepository.versionHead(ctx.projectId)
    const translateTo = toUserLocale(to.language)
    if (!translateTo) prepared.warnings.push("Không xác định được ngôn ngữ của mẫu mới nên chưa tính việc dịch — kiểm tra lại ngôn ngữ trước khi áp dụng.")
    const doc = await TemplateMigration.create({
      projectId: ctx.projectId,
      orgId: ctx.orgId,
      state: "mapping_review",
      open: true,
      direction: prepared.direction,
      reverse_of: prepared.reverse_of,
      from,
      to: prepared.to,
      pairing: prepared.pairing,
      analysis: prepared.analysis,
      groups: prepared.groups,
      decisions: [],
      // D9: chỉ dự án có file của khách (import) mới dịch đè Spine. Dự án tạo SRS (mode 2) / chuyển từ FPT: Spine luôn tiếng Anh, lớp bản dịch
      // ngoài Spine lo phần in ⇒ đổi mẫu khác ngôn ngữ chỉ đổi ngôn ngữ tài liệu (không dịch Spine, không credit)
      needs_translation: !!translateTo && translateTo !== from.language && keepsCustomerText(project),
      language_switch_only: !!translateTo && translateTo !== from.language && !keepsCustomerText(project),
      warnings: prepared.warnings,
      base_spine_version: spine.spine_version,
      base_content_seq: head?.content_seq ?? 0,
      created_by: ctx.actor.userId
    })
    return await toDto(doc, spine)
  } catch (err) {
    await rollback().catch((e: unknown) => console.error("[TemplateMigration] dọn bản mẫu riêng sau lỗi thất bại:", e instanceof Error ? e.message : e))
    if (isDuplicateKey(err)) throw new ApiError(409, "Dự án vừa có một lần đổi mẫu khác được mở.", "TEMPLATE_MIGRATION_OPEN")
    throw err
  }
}

// ─── đọc ─────────────────────────────────────────────────────────

export const load = async (ctx: Pick<MigrationContext, "projectId" | "orgId">, id: string): Promise<ITemplateMigration> => {
  await getProjectById(ctx.projectId, ctx.orgId)
  const doc = mongoose.isValidObjectId(id) ? await TemplateMigration.findOne({ _id: id, projectId: ctx.projectId, orgId: ctx.orgId }) : null
  if (!doc) throw MIGRATION_NOT_FOUND()
  return doc
}

const effectiveChoice = (doc: Pick<ITemplateMigration, "decisions" | "groups">, id: string): string | null =>
  doc.decisions.find((d) => d.id === id)?.choice ?? decidableItems(doc.groups).get(id)?.default ?? null

const estimateOf = async (doc: ITemplateMigration, spine: Spine | null): Promise<MigrationCreditEstimate> => {
  let chars = 0
  if (doc.needs_translation) {
    // Đổi ngược chỉ dịch mục đã sửa mà BA giữ; đổi xuôi dịch cả tài liệu
    chars =
      doc.direction === "reverse"
        ? doc.groups.edited_since.filter((e) => effectiveChoice(doc, e.id) === "keep").reduce((n, e) => n + e.chars, 0)
        : spine
          ? translationUnits(spine).reduce((n, u) => n + JSON.stringify(u.value).length, 0)
          : 0
  }
  return estimateMigrationCredits({ translation_chars: chars, ...aiChoiceCounts(doc.groups, doc.decisions) }, await loadMigrationUnitCosts())
}

/** Mẫu trước của lần đổi mẫu đã áp dụng — đích của "Quay về mẫu trước" (mẫu org hoặc bản riêng đăng ký cho file nền cũ khi dự án từng theo mẫu tự do / FPT). */
export interface PreviousTemplate {
  template_id: string
  version: number
  name: string
  visibility: "org" | "project"
}

export interface MigrationDto {
  id: string
  project_id: string
  state: MigrationState
  direction: "forward" | "reverse"
  reverse_of: string | null
  from: { template_ref: { template_id: string; version: number } | null; language: string; template_family: string | null; headings: OldHeading[] }
  to: { template_id: string; version: number; name: string; visibility: "org" | "project"; language: string; template_family: string | null; headings: NewHeading[] }
  pairing: PairingResult
  groups: MigrationGroups
  decisions: { id: string; choice: string }[]
  /** Mục bắt buộc chọn mà chưa có quyết định — phải rỗng mới `ready` được. */
  undecided: string[]
  language: { source: string; target: string; needs_translation: boolean; /** Chỉ đổi ngôn ngữ tài liệu (dự án mode 2 / chuyển từ FPT): không dịch Spine, không credit. */ switches_document_language: boolean }
  credit_estimate: MigrationCreditEstimate
  warnings: string[]
  /** Đổi ngược: liên kết sẽ gãy nếu áp dụng ngay (chạy khô như bước áp dụng) — hiện trước khi bấm Áp dụng; rỗng = ổn. */
  broken_links: BrokenLink[]
  /** Lần đổi mẫu đã áp dụng: hoàn tác được không (cùng luật với `revert`); `null` khi chưa áp dụng. */
  revertable: boolean | null
  revert_blocked_reason: RevertBlockReason | null
  previous_template: PreviousTemplate | null
  prepared_spine_version: number | null
  prepared_source_sha256: string | null
  applied_at: string | null
  created_by: string
  created_at: string
  updated_at: string
}

const revertFields = async (doc: ITemplateMigration): Promise<{ revertable: boolean | null; revert_blocked_reason: RevertBlockReason | null }> => {
  if (doc.state !== "applied") return { revertable: null, revert_blocked_reason: null }
  const r = await revertability(doc)
  return { revertable: r.revertable, revert_blocked_reason: r.reason }
}

export const previousTemplateOf = async (doc: Pick<ITemplateMigration, "state" | "from" | "snapshot" | "orgId">): Promise<PreviousTemplate | null> => {
  if (doc.state !== "applied" && doc.state !== "reverting") return null
  const ref = doc.from.template_ref ?? doc.snapshot?.registered_ref ?? null
  if (!ref) return null
  const [family, version] = await Promise.all([OrgTemplate.findOne({ _id: ref.template_id, orgId: doc.orgId }, { name: 1 }).lean(), OrgTemplateVersion.findOne({ template_id: ref.template_id, version: ref.version }, { visibility: 1 }).lean()])
  if (!family || !version) return null
  return { template_id: String(ref.template_id), version: ref.version, name: family.name, visibility: version.visibility }
}

export const toDto = async (doc: ITemplateMigration, spineHint?: Spine | null): Promise<MigrationDto> => {
  const spine = doc.needs_translation && doc.direction === "forward" ? (spineHint ?? (await spineRepository.get(String(doc.projectId)))) : null
  return {
    id: String(doc._id),
    project_id: String(doc.projectId),
    state: doc.state,
    direction: doc.direction,
    reverse_of: doc.reverse_of ? String(doc.reverse_of) : null,
    from: {
      template_ref: doc.from.template_ref ? { template_id: String(doc.from.template_ref.template_id), version: doc.from.template_ref.version } : null,
      language: doc.from.language,
      template_family: doc.from.template_family,
      headings: doc.from.headings
    },
    to: {
      template_id: String(doc.to.template_id),
      version: doc.to.version,
      name: doc.to.name,
      visibility: doc.to.visibility,
      language: doc.to.language,
      template_family: doc.to.template_family,
      headings: doc.to.headings
    },
    pairing: doc.pairing,
    groups: doc.groups,
    decisions: doc.decisions.map((d) => ({ id: d.id, choice: d.choice })),
    undecided: settleDecisions(doc.groups, doc.decisions).undecided,
    language: { source: doc.from.language, target: toUserLocale(doc.to.language) ?? "en", needs_translation: doc.needs_translation, switches_document_language: doc.language_switch_only },
    credit_estimate: await estimateOf(doc, spine),
    warnings: doc.warnings,
    broken_links: await brokenLinks(doc),
    ...(await revertFields(doc)),
    previous_template: await previousTemplateOf(doc),
    prepared_spine_version: doc.prepared_spine_version,
    prepared_source_sha256: doc.prepared_source_sha256,
    applied_at: doc.applied_at ? doc.applied_at.toISOString() : null,
    created_by: String(doc.created_by),
    created_at: doc.createdAt.toISOString(),
    updated_at: doc.updatedAt.toISOString()
  }
}

export interface MigrationSummary {
  id: string
  state: MigrationState
  direction: "forward" | "reverse"
  /** Chỉ lần đổi mẫu đã áp dụng mới nhất: hoàn tác được không + mẫu trước để "Quay về mẫu trước". */
  revertable: boolean | null
  revert_blocked_reason: RevertBlockReason | null
  previous_template: PreviousTemplate | null
  to: { template_id: string; version: number; name: string }
  created_at: string
  applied_at: string | null
}

export const listMigrations = async (ctx: Pick<MigrationContext, "projectId" | "orgId">): Promise<MigrationSummary[]> => {
  await getProjectById(ctx.projectId, ctx.orgId)
  const docs = await TemplateMigration.find({ projectId: ctx.projectId, orgId: ctx.orgId }).select("state direction to.template_id to.version to.name createdAt applied_at projectId orgId from snapshot.registered_ref").sort({ createdAt: -1 }).limit(20)
  const latestApplied = docs.filter((d) => d.state === "applied").sort((a, b) => (b.applied_at?.getTime() ?? 0) - (a.applied_at?.getTime() ?? 0))[0]
  const latest = latestApplied ? { fields: await revertFields(latestApplied), previous: await previousTemplateOf(latestApplied) } : null
  return docs.map((d) => ({
    id: String(d._id),
    state: d.state,
    direction: d.direction,
    revertable: d === latestApplied && latest ? latest.fields.revertable : null,
    revert_blocked_reason: d === latestApplied && latest ? latest.fields.revert_blocked_reason : null,
    previous_template: d === latestApplied && latest ? latest.previous : null,
    to: { template_id: String(d.to.template_id), version: d.to.version, name: d.to.name },
    created_at: d.createdAt.toISOString(),
    applied_at: d.applied_at ? d.applied_at.toISOString() : null
  }))
}

export const getMigration = async (ctx: Pick<MigrationContext, "projectId" | "orgId">, id: string): Promise<MigrationDto> => toDto(await load(ctx, id))

// ─── sửa cặp / quyết định ────────────────────────────────────────

/** Chuyển trạng thái nguyên tử: chỉ khi đang ở một trong `from` (hai người thao tác cùng lúc không đạp nhau). */
export const transition = async (
  ctx: Pick<MigrationContext, "projectId" | "orgId">,
  id: string,
  from: readonly MigrationState[],
  next: MigrationState,
  fields: Record<string, unknown> = {},
  /** Chỉ chuyển nếu bản ghi chưa đổi kể từ lúc đọc (kiểm điều kiện trên đúng dữ liệu đã đọc). */
  expectUpdatedAt?: Date
): Promise<ITemplateMigration> => {
  const doc = await TemplateMigration.findOneAndUpdate(
    { _id: id, projectId: ctx.projectId, orgId: ctx.orgId, state: { $in: from }, ...(expectUpdatedAt ? { updatedAt: expectUpdatedAt } : {}) },
    { $set: stateUpdate(next, fields) },
    { returnDocument: "after" }
  )
  if (doc) return doc
  const current = await load(ctx, id)
  throw invalidState(current.state, from)
}

const badRequest = (message: string, field: string, ids?: string[]) => new ApiError(400, message, "VALIDATION_ERROR", { field, ...(ids ? { ids } : {}) })

/** BA sửa cặp: id phải thuộc `pairing` đã lưu, mẫu đích phải thuộc mẫu của lần này. Phân nhóm lại (không AI); quyết định còn hợp lệ được giữ. */
export const patchPairs = async (ctx: MigrationContext, id: string, edits: readonly PairEdit[]): Promise<MigrationDto> => {
  const doc = await load(ctx, id)
  if (doc.state !== "mapping_review" && doc.state !== "decisions") throw invalidState(doc.state, ["mapping_review", "decisions"])
  let pairing: PairingResult
  try {
    pairing = applyPairEdits(doc.pairing, doc.to.headings, edits)
  } catch (err) {
    if (err instanceof PairEditError) throw badRequest(err.message, "pairs", edits.map((e) => e.old_key))
    throw err
  }
  const groups = classify({
    old: doc.from.headings,
    neu: doc.to.headings,
    pairing,
    oldTables: toMap(doc.analysis.old_tables),
    newTables: toMap(doc.analysis.new_tables),
    edited: doc.analysis.edited
  })
  const decisions = settleDecisions(groups, doc.decisions).decisions.map((d) => ({ id: d.id, choice: d.choice, at: d.at, by: d.by }))
  const updated = await TemplateMigration.findOneAndUpdate(
    { _id: doc._id, state: { $in: ["mapping_review", "decisions"] }, updatedAt: doc.updatedAt },
    { $set: stateUpdate("mapping_review", { pairing, groups, decisions, resolved_items: [] }) },
    { returnDocument: "after" }
  )
  if (!updated) throw new ApiError(409, "Lần đổi mẫu vừa được người khác cập nhật. Tải lại rồi thử lại.", "TEMPLATE_MIGRATION_CONFLICT")
  return toDto(updated)
}

/**
 * BA sửa mapping heading → mục của **file mẫu tải lên** (bản riêng của dự án) lúc `mapping_review`: mapping tự nhận có thể sai, mà mẫu org đã được Lead rà
 * lúc đăng nên không sửa ở đây. `section_id` phải là mục của FlintFlow (`isKnownSectionId`) hoặc `unmapped`. Ghi lại cả bản mẫu riêng (dự án dùng lại
 * đúng mapping đã sửa) rồi ghép lại + phân nhóm lại; quyết định còn hợp lệ được giữ.
 */
export const patchMapping = async (ctx: MigrationContext, id: string, edits: readonly { key: string; section_id: string }[]): Promise<MigrationDto> => {
  const doc = await load(ctx, id)
  if (doc.state !== "mapping_review") throw invalidState(doc.state, ["mapping_review"])
  if (doc.direction !== "forward" || doc.to.visibility !== "project") {
    throw new ApiError(409, "Chỉ sửa được mapping của file mẫu bạn vừa tải lên. Mẫu của tổ chức đã được Lead rà khi đăng bản.", "TEMPLATE_MIGRATION_MAPPING_LOCKED")
  }
  const keys = new Set(doc.to.headings.map((h) => h.key))
  const unknownKeys = edits.filter((e) => !keys.has(e.key)).map((e) => e.key)
  if (unknownKeys.length) throw badRequest("Có heading không thuộc file mẫu này.", "edits", unknownKeys)
  const badSections = edits.filter((e) => e.section_id !== "unmapped" && !isKnownSectionId(e.section_id)).map((e) => e.key)
  if (badSections.length) throw badRequest("Có mục không thuộc danh mục mục của FlintFlow.", "edits", badSections)

  const next = new Map(edits.map((e) => [e.key, e.section_id]))
  const headings = doc.to.headings.map((h) => (next.has(h.key) ? { ...h, section_id: next.get(h.key)!, auto_confirmed: false } : h))
  const version = await findVersion(ctx.orgId, String(doc.to.template_id), doc.to.version)
  const [project, spine, profile] = await Promise.all([getProjectById(ctx.projectId, ctx.orgId), loadReadySpine(ctx.projectId), TemplateProfile.findOne({ projectId: ctx.projectId })])
  const from = await currentBinding(project, profile, spine)
  const buffer = await docFileStore().load(doc.to.file_ref)
  const mapped = { ...version.toObject(), headings: headings.map((h) => ({ heading_text: h.heading_text, section_id: h.section_id, ...(h.guidance ? { guidance: h.guidance } : {}) })) } as IOrgTemplateVersion
  const prepared = await prepare(ctx.projectId, spine, profile, from, { ...doc.toObject().to, headings }, buffer, mapped)
  const decisions = settleDecisions(prepared.groups, doc.decisions).decisions.map((d) => ({ id: d.id, choice: d.choice, at: d.at, by: d.by }))
  const updated = await TemplateMigration.findOneAndUpdate(
    { _id: doc._id, state: "mapping_review", updatedAt: doc.updatedAt },
    { $set: { to: prepared.to, pairing: prepared.pairing, analysis: prepared.analysis, groups: prepared.groups, warnings: prepared.warnings, decisions, resolved_items: [] } },
    { returnDocument: "after" }
  )
  if (!updated) throw new ApiError(409, "Lần đổi mẫu vừa được người khác cập nhật. Tải lại rồi thử lại.", "TEMPLATE_MIGRATION_CONFLICT")
  // Bản riêng của dự án nhớ mapping đã sửa (mẫu org thì không bao giờ vào nhánh này)
  await OrgTemplateVersion.updateOne({ _id: version._id, visibility: "project" }, { $set: { headings: mapped.headings } })
  return toDto(updated)
}

export const confirmMapping = async (ctx: MigrationContext, id: string): Promise<MigrationDto> => {
  await load(ctx, id)
  return toDto(await transition(ctx, id, ["mapping_review"], "decisions"))
}

export type BatchAction = "keep_all" | "discard_all"

/**
 * Ghi quyết định. Mọi `id` phải là mục nhận quyết định của chính lần đổi mẫu này (extra / conflict / đã sửa sau lần đổi mẫu) và
 * `choice` phải thuộc lựa chọn của đúng mục đó; sai ⇒ 400, không ghi gì. `batch` (chỉ đổi ngược) đặt cùng lúc cho mọi mục đã sửa.
 */
export const patchDecisions = async (ctx: MigrationContext, id: string, input: { decisions: { id: string; choice: string }[]; batch?: BatchAction }): Promise<MigrationDto> => {
  const doc = await load(ctx, id)
  if (doc.state !== "decisions") throw invalidState(doc.state, ["decisions"])
  const items = decidableItems(doc.groups)
  const unknown = input.decisions.filter((d) => !items.has(d.id)).map((d) => d.id)
  if (unknown.length) throw badRequest("Có mục không thuộc lần đổi mẫu này.", "decisions", unknown)
  const wrong = input.decisions.filter((d) => !items.get(d.id)!.choices.includes(d.choice)).map((d) => d.id)
  if (wrong.length) throw badRequest("Có lựa chọn không hợp lệ cho mục tương ứng.", "decisions", wrong)
  if (input.batch && !doc.groups.edited_since.length) throw badRequest("Lần đổi mẫu này không có mục đã sửa sau lần đổi mẫu trước.", "batch")

  const now = new Date()
  const by = new mongoose.Types.ObjectId(ctx.actor.userId)
  const next = new Map(doc.decisions.map((d) => [d.id, { id: d.id, choice: d.choice, at: d.at, by: d.by }]))
  if (input.batch) {
    const choice = input.batch === "keep_all" ? "keep" : "discard"
    for (const e of doc.groups.edited_since) next.set(e.id, { id: e.id, choice, at: now, by })
  }
  for (const d of input.decisions) next.set(d.id, { id: d.id, choice: d.choice, at: now, by })
  const updated = await TemplateMigration.findOneAndUpdate(
    { _id: doc._id, state: "decisions", updatedAt: doc.updatedAt },
    { $set: { decisions: [...next.values()], resolved_items: [] } },
    { returnDocument: "after" }
  )
  if (!updated) throw new ApiError(409, "Lần đổi mẫu vừa được người khác cập nhật. Tải lại rồi thử lại.", "TEMPLATE_MIGRATION_CONFLICT")
  return toDto(updated)
}

// ─── sẵn sàng / huỷ ──────────────────────────────────────────────

/**
 * `decisions → ready`: mọi mục bắt buộc đã có quyết định; dữ liệu chưa đổi so với lúc chuẩn bị (file nền / mẫu hiện tại; đổi ngược:
 * không có sửa mới); bản nháp vẫn mở. Ghim `prepared_spine_version` + `prepared_source_sha256` cho bước áp dụng.
 */
export const markReady = async (ctx: MigrationContext, id: string): Promise<MigrationDto> => {
  const doc = await load(ctx, id)
  if (doc.state !== "decisions") throw invalidState(doc.state, ["decisions"])
  const spine = await loadReadySpine(ctx.projectId)
  const { undecided } = settleDecisions(doc.groups, doc.decisions)
  if (undecided.length) throw new ApiError(409, `Còn ${undecided.length} mục chưa chọn cách xử lý.`, "TEMPLATE_MIGRATION_UNDECIDED", { undecided })

  const [project, profile, head] = await Promise.all([getProjectById(ctx.projectId, ctx.orgId), TemplateProfile.findOne({ projectId: ctx.projectId }), spineRepository.versionHead(ctx.projectId)])
  const current = await currentBinding(project, profile, spine)
  if (current.source_sha256 !== doc.from.source_sha256 || !sameRef(current.template_ref, doc.from.template_ref)) {
    throw stale("Mẫu hoặc file nền của dự án đã đổi kể từ lúc chuẩn bị.")
  }
  if (doc.direction === "reverse" && (head?.content_seq ?? 0) !== doc.base_content_seq) throw stale("Tài liệu có thay đổi mới kể từ lúc chuẩn bị nên danh sách mục đã sửa không còn đúng.")

  return toDto(await transition(ctx, id, ["decisions"], "ready", { ready_at: new Date(), prepared_spine_version: spine.spine_version, prepared_source_sha256: current.source_sha256 }, doc.updatedAt), spine)
}

/** Huỷ trước `applying`; giải phóng chỗ của dự án để mở lần đổi mẫu khác. */
export const cancelMigration = async (ctx: MigrationContext, id: string): Promise<MigrationDto> => {
  const doc = await load(ctx, id)
  if (doc.state === "applying") throw new ApiError(409, "Lần đổi mẫu đang áp dụng nên không huỷ được.", "TEMPLATE_MIGRATION_APPLYING")
  return toDto(await transition(ctx, id, ["mapping_review", "decisions", "ready"], "cancelled", { cancelled_at: new Date() }))
}
