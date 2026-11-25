/**
 * ai-review.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-449 việc 5, 6: kiểm bằng AI ở hai bước, dùng chung một service (skill `review-section`):
 *
 * | Profile | Bước | ActionType | Lens | Tài liệu tải lên |
 * | --- | --- | --- | --- | --- |
 * | `quality` | S-9.2 Soát chất lượng | `REVIEW` | mâu thuẫn yêu cầu / NFR, mơ hồ, bảo mật, trái quyết định, giả định trái nhau, lệch tài liệu | có |
 * | `consistency` | S-8.4 Rà nhất quán | `CONSISTENCY_PASS` | trùng nghĩa, lệch thuật ngữ, thiếu chỗ liệt kê | không |
 *
 * Kết quả luôn là cờ **vàng** `rule_id = "ai_review"`, tên lens ở `Flag.lens`. Code không tin output của model:
 * lọc cấp độ, lens, section, `target_id`, và bắt buộc câu trích nguyên văn (`verifyQuote`, luật (a) của N2). Chạy lại
 * một bước thì ghi đè lượt trước của chính bước đó (đóng cờ cũ chưa "Giữ nguyên + lý do", mở cờ mới), không nhân đôi.
 *
 * `ai_review` nằm trong `MODEL_OWNED_RULES` nên recompute tất định không đóng nó.
 * Hàm ghép tài liệu (`GET /document`, export) KHÔNG gọi nhánh này: chỉ lượt chạy bước mới tốn credit.
 */

import { env } from "../../../config/env.js"
import { applyTransaction } from "../../spine/op-engine.js"
import * as repository from "../../spine/spine.repository.js"
import type { Op } from "../../spine/op.types.js"
import type { Flag, Spine, SpineRecord } from "../../spine/spine.types.js"
import { ActionType, type AiActionInput, type AiActionResult } from "../../../shared/ai/ai-action.types.js"
import { executeAiAction } from "../../../shared/ai/ai-action.service.js"
import { buildDocumentContext } from "../../../shared/ai/document-context.service.js"
import { normalizeQuoteText, verifyQuote } from "../../../shared/ai/quote-check.js"
import type { ReviewOutput } from "../../../shared/ai/response-parser.js"
import type { ReplyLanguage } from "../../../shared/i18n/reply-language.js"
import { ApiError } from "../../../shared/utils/api-error.js"
import * as meter from "../meter.service.js"

export type ReviewProfile = "quality" | "consistency"
export type AiReviewExecutor = (input: AiActionInput, projectId: string, userId: string) => Promise<AiActionResult<ReviewOutput>>

export const AI_REVIEW_RULE = "ai_review"
/** Trần ký tự (JSON) của một lô nội dung gửi model. */
export const AI_REVIEW_BATCH_CHARS = 24_000
/** Trần số lô mỗi lượt chạy; vượt thì gom các khối cuối vào lô cuối. */
export const AI_REVIEW_MAX_BATCHES = 6
/** Số cờ `ambiguity` tối đa giữ lại từ một lô; lens khác không bị giới hạn. */
export const AI_REVIEW_MAX_AMBIGUITY_PER_BATCH = 5
/** Section mặc định của cờ khi không suy ra được từ `target_id`. */
const DEFAULT_SECTION = "fixed:1"

interface LensDef {
  name: string
  hint: string
}

interface ProfileDef {
  stepId: string
  actionType: ActionType
  callKind: string
  reason: string
  lenses: readonly LensDef[]
  /** Có nạp quyết định, giả định, tài liệu tải lên vào ngữ cảnh. */
  withSettledContext: boolean
}

const PROFILES: Readonly<Record<ReviewProfile, ProfileDef>> = {
  quality: {
    stepId: "S-9.2",
    actionType: ActionType.REVIEW,
    callKind: "review",
    reason: "S-9.2 Soát chất lượng",
    withSettledContext: true,
    lenses: [
      // Thứ tự ưu tiên: mâu thuẫn trước, ambiguity sau cùng
      { name: "decision_conflict", hint: "content contradicts the answer of a settled decision" },
      { name: "assumption_conflict", hint: "two assumptions disagree, or an assumption contradicts the content or a decision" },
      { name: "requirement_conflict", hint: "two requirements (function, business rule, validation, NFR, use case) say opposite things" },
      { name: "fr_nfr_conflict", hint: "a function contradicts a non-functional requirement" },
      { name: "source_conflict", hint: "the SRS says something different from an uploaded source document (skip when no document is given)" },
      { name: "security_risk", hint: "missing authorization or sensitive data handling" },
      { name: "ambiguity", hint: "vague or untestable wording, vague names" }
    ]
  },
  consistency: {
    stepId: "S-8.4",
    actionType: ActionType.CONSISTENCY_PASS,
    callKind: "consistency_pass",
    reason: "S-8.4 Rà nhất quán",
    withSettledContext: false,
    lenses: [
      { name: "semantic_duplicate", hint: "two elements say the same thing in different words" },
      { name: "term_drift", hint: "prose uses a name that differs from the keyed name or glossary term" },
      { name: "cross_section_gap", hint: "an element is mentioned but missing where it must be listed, or a stated count differs from the real one" }
    ]
  }
}

export const reviewStepOf = (profile: ReviewProfile): string => PROFILES[profile].stepId
export const reviewLensesOf = (profile: ReviewProfile): string[] => PROFILES[profile].lenses.map((l) => l.name)

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

// ─── lô nội dung ─────────────────────────────────────────────────

export interface ReviewBatch {
  /** Khoá section logic của mọi khối trong lô (`feature:F1`, `function:FN07`, `fixed:…`). */
  section_ids: string[]
  /** Nội dung theo khối, khoá = tên khối. */
  projection: Record<string, unknown>
}

interface Block {
  key: string
  section_ids: string[]
  value: unknown
  size: number
}

const block = (key: string, section_ids: string[], value: unknown): Block => ({ key, section_ids, value, size: JSON.stringify(value).length })

const fixedSectionIds = (spine: Spine): string[] => spine.sections.map((s) => s.id).filter((id) => id.startsWith("fixed:"))

/**
 * Khối nội dung đầy đủ: mỗi feature cùng functions (kèm business rule, message), use case và screen của nó thành một khối;
 * phần còn lại (project, actors, NFR, entities, giao diện ngoài, phần mồ côi) thành khối chung đứng đầu.
 */
const buildBlocks = (spine: Spine): Block[] => {
  const ruleById = new Map(spine.business_rules.map((r) => [r.id, r]))
  const usedRules = new Set<string>()
  const usedMessages = new Set<string>()
  const usedUseCases = new Set<string>()
  const functionsOf = (featureId: string) => spine.functions.filter((f) => f.feature_id === featureId)

  const featureBlocks: Block[] = spine.features.map((feature) => {
    const functions = functionsOf(feature.id)
    const fnIds = new Set(functions.map((f) => f.id))
    const fnKeys = functions.map((f) => `function:${f.id}`)
    const useCases = spine.use_cases.filter((u) => !usedUseCases.has(u.id) && u.function_ids.some((id) => fnIds.has(id)))
    for (const u of useCases) usedUseCases.add(u.id)
    const value = {
      feature: { id: feature.id, name: feature.name },
      functions: functions.map((f) => {
        const rules = f.business_rule_ids.flatMap((id) => {
          const r = ruleById.get(id)
          if (!r) return []
          usedRules.add(id)
          return [{ id: r.id, statement: r.statement }]
        })
        const messages = spine.messages
          .filter((m) => m.function_ids.includes(f.id))
          .map((m) => {
            usedMessages.add(m.id)
            return { id: m.id, code: m.code, text: m.text }
          })
        return {
          id: f.id,
          name: f.name,
          screen_id: f.screen_id,
          trigger: f.trigger,
          description: f.description,
          normal: f.normal,
          abnormal: f.abnormal,
          validations: f.validations.map((v) => ({ id: v.id, statement: v.statement })),
          business_rules: rules,
          messages
        }
      }),
      use_cases: useCases.map((u) => ({ id: u.id, name: u.name, actor_ids: u.actor_ids, function_ids: u.function_ids, description: u.description })),
      screens: spine.screens.filter((s) => s.feature_id === feature.id).map((s) => ({ id: s.id, name: s.name, description: s.description, tabs: s.tabs }))
    }
    return block(`feature:${feature.id}`, [`feature:${feature.id}`, ...fnKeys], value)
  })

  const common = block("common", fixedSectionIds(spine), {
    project: { name: spine.project.name, vision: spine.project.vision, goals: spine.project.goals, form_factor: spine.project.form_factor },
    actors: spine.actors.map((a) => ({ id: a.id, name: a.name, kind: a.kind, description: a.description })),
    roles: spine.roles.map((r) => ({ id: r.id, name: r.name, actor_id: r.actor_id })),
    nfrs: spine.nfrs.map((n) => ({ id: n.id, category: n.category, statement: n.statement, metric: n.metric, threshold: n.threshold })),
    entities: spine.entities.map((e) => ({ id: e.id, name: e.name, description: e.description })),
    external_interfaces: spine.deployment_nodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind, components: n.components, artifacts: n.artifacts })),
    permissions: spine.permissions.map((p) => ({ screen_id: p.screen_id, role_id: p.role_id, action: p.action })),
    common_requirements: spine.common_requirements.map((c) => ({ id: c.id, category: c.category, statement: c.statement })),
    business_rules: spine.business_rules.filter((r) => !usedRules.has(r.id)).map((r) => ({ id: r.id, statement: r.statement })),
    messages: spine.messages.filter((m) => !usedMessages.has(m.id)).map((m) => ({ id: m.id, code: m.code, text: m.text })),
    use_cases: spine.use_cases.filter((u) => !usedUseCases.has(u.id)).map((u) => ({ id: u.id, name: u.name, actor_ids: u.actor_ids, description: u.description })),
    other_requirements: spine.other_requirements.map((o) => ({ id: o.id, kind: o.kind, statement: o.statement }))
  })

  return [common, ...featureBlocks]
}

/**
 * Hàm thuần: gom khối vào lô theo trần ký tự. Khối vượt trần đứng một mình. Quá `AI_REVIEW_MAX_BATCHES` thì khối cuối
 * dồn hết vào lô cuối (kèm `console.warn`), không bỏ im khối nào. Luôn có ít nhất một lô.
 * `profile` chưa đổi cách chia (hai profile xem cùng nội dung), giữ trong chữ ký để phía gọi không phải đổi khi cần.
 */
export const buildReviewBatches = (spine: Spine, _profile: ReviewProfile): ReviewBatch[] => {
  const groups: Block[][] = []
  let current: Block[] = []
  let size = 0
  for (const b of buildBlocks(spine)) {
    if (current.length > 0 && size + b.size > AI_REVIEW_BATCH_CHARS) {
      groups.push(current)
      current = []
      size = 0
    }
    current.push(b)
    size += b.size
  }
  if (current.length > 0) groups.push(current)

  if (groups.length > AI_REVIEW_MAX_BATCHES) {
    const tail = groups.slice(AI_REVIEW_MAX_BATCHES - 1).flat()
    console.warn(`[ai-review] ${groups.length} lô vượt trần ${AI_REVIEW_MAX_BATCHES}: gom ${tail.length} khối cuối vào lô cuối`)
    groups.splice(AI_REVIEW_MAX_BATCHES - 1, groups.length, tail)
  }

  return groups.map((blocks) => ({
    section_ids: [...new Set(blocks.flatMap((b) => b.section_ids))],
    projection: Object.fromEntries(blocks.map((b) => [b.key, b.value]))
  }))
}

/** Số lô của một lượt chạy (tối thiểu 1) — để ước tính credit. */
export const estimateReviewBatches = (spine: Spine, profile: ReviewProfile): number => Math.max(1, buildReviewBatches(spine, profile).length)

// ─── ngữ cảnh chung ──────────────────────────────────────────────

const clip = (text: string, max = 80): string => (text.length > max ? `${text.slice(0, max)}...` : text)

/** id + tên của mọi phần tử để model nói được "trùng / trái với X" dù X nằm ở lô khác. */
const elementIndex = (spine: Spine): { id: string; name: string }[] => [
  ...spine.features.map((e) => ({ id: e.id, name: e.name })),
  ...spine.actors.map((e) => ({ id: e.id, name: e.name })),
  ...spine.roles.map((e) => ({ id: e.id, name: e.name })),
  ...spine.use_cases.map((e) => ({ id: e.id, name: e.name })),
  ...spine.screens.map((e) => ({ id: e.id, name: e.name })),
  ...spine.functions.map((e) => ({ id: e.id, name: e.name })),
  ...spine.entities.map((e) => ({ id: e.id, name: e.name })),
  ...spine.nfrs.map((e) => ({ id: e.id, name: clip(e.statement) })),
  ...spine.business_rules.map((e) => ({ id: e.id, name: clip(e.statement) })),
  ...spine.deployment_nodes.map((e) => ({ id: e.id, name: e.name }))
]

/** Mọi chuỗi trong một giá trị JSON — nguồn để kiểm câu trích (so từng chuỗi, không so JSON đã escape). */
const collectStrings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") out.push(value)
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out)
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, out)
  return out
}

/** Section của phần tử: khoá logic có hậu tố `:<id>` trong `spine.sections` (`function:FN07`, `feature:F2`), không có ⇒ mặc định. */
const sectionOfTarget = (spine: Spine, targetId: string | null): string =>
  (targetId ? spine.sections.find((s) => s.id.endsWith(`:${targetId}`))?.id : undefined) ?? DEFAULT_SECTION

const baseStep = (stepId: string): string => stepId.split("@")[0] ?? stepId

/** Tên trường hay gặp ⇒ chữ thường theo ngôn ngữ (cờ hiện cho người dùng, không được lộ tên nội bộ). */
const FIELD_WORDS: Record<string, { vi: string; en: string }> = {
  function_ids: { vi: "danh sách chức năng", en: "function list" },
  actor_ids: { vi: "danh sách tác nhân", en: "actor list" },
  use_case_ids: { vi: "danh sách use case", en: "use case list" },
  business_rule_ids: { vi: "danh sách quy tắc nghiệp vụ", en: "business rule list" },
  screen_id: { vi: "màn hình", en: "screen" },
  feature_id: { vi: "nhóm chức năng", en: "feature" },
  spine_version: { vi: "phiên bản tài liệu", en: "document version" },
  section_id: { vi: "mục", en: "section" }
}

/** Làm sạch câu cờ do model viết: mã con (`FN006-V2`) về mã cha, tên trường về chữ thường. Token lạ giữ nguyên, chỉ cảnh báo. */
export const humanizeReviewMessage = (message: string, language: ReplyLanguage = "vi"): string => {
  const lang = language === "en" ? "en" : "vi"
  let out = message.replace(/\b([A-Z]{1,4}\d{1,4})-[A-Z]{1,2}\d{1,3}\b/g, "$1")
  out = out.replace(/([`'"“”‘’]?)\b([a-z]+(?:_[a-z]+)+)\b\1/g, (whole, _q: string, token: string) => {
    const word = FIELD_WORDS[token]
    if (word) return word[lang]
    console.warn(`[ai-review] token nội bộ chưa có trong từ điển: ${token}`)
    return whole
  })
  return out
}

const flagDedupeKey = (lens: string, sectionId: string, targetId: string | null, message: string): string =>
  `${lens}|${sectionId}|${targetId ?? ""}|${normalizeQuoteText(message)}`
/** Khoá "cùng chỗ, cùng lens" để cờ mới không đè lên cờ người đã giữ / waive. */
const flagSlotKey = (lens: string | null | undefined, sectionId: string, targetId: string | null | undefined): string =>
  `${lens ?? ""}|${sectionId}|${targetId ?? ""}`

const nextFlagId = (flags: readonly Flag[]): (() => string) => {
  let max = flags.reduce((acc, f) => {
    const m = /^FL(\d+)$/.exec(f.id)
    return m ? Math.max(acc, Number(m[1])) : acc
  }, 0)
  return () => `FL${String(++max).padStart(3, "0")}`
}

export interface AiReviewOptions {
  executor?: AiReviewExecutor
  replyLanguage?: ReplyLanguage
}

export interface AiReviewResult {
  spine_version: number
  /** Cờ vàng vừa mở. */
  opened: string[]
  /** Cờ `ai_review` của lượt trước (cùng bước) vừa đóng khi ghi đè. */
  closed: string[]
  /** Cờ model đưa ra nhưng câu trích không khớp nguồn nên bị bỏ. */
  dropped_unquoted: number
  batches: number
  /** Cờ env tắt ⇒ không gọi model. */
  skipped: boolean
}

const isEnabled = (profile: ReviewProfile): boolean => (profile === "quality" ? env.QUALITY_LENS_ENABLED : env.CONSISTENCY_LLM_ENABLED)

/** Một lượt gọi model, có reserve / finalize / release lượt như mọi bước gọi model khác. */
const meteredCall = async (
  projectId: string,
  userId: string,
  def: ProfileDef,
  run: () => Promise<AiActionResult<ReviewOutput>>
): Promise<AiActionResult<ReviewOutput>> => {
  const reservedId = await meter.reserveCall(projectId, userId, def.stepId, def.callKind)
  let result: AiActionResult<ReviewOutput>
  try {
    result = await run()
  } catch (err) {
    await meter.releaseCall(reservedId)
    throw err
  }
  await meter.finalizeCall(reservedId, {
    call_kind: def.callKind,
    attempt: 1,
    tokens_in: result.tokensUsed?.promptTokens ?? 0,
    tokens_out: result.tokensUsed?.completionTokens ?? 0,
    cost: result.cost ?? 0,
    logId: result.logId || null
  })
  return result
}

/**
 * Chạy một lượt kiểm AI cho `profile`. Các lô chạy tuần tự; lỗi ở một lô ném ra (runner xử lý như lỗi step), không nuốt.
 */
export const runAiReview = async (projectId: string, userId: string, profile: ReviewProfile, options: AiReviewOptions = {}): Promise<AiReviewResult> => {
  const def = PROFILES[profile]
  const record = await repository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", repository.SPINE_NOT_FOUND)
  if (!isEnabled(profile)) return { spine_version: record.spine_version, opened: [], closed: [], dropped_unquoted: 0, batches: 0, skipped: true }

  const spine = stripRecord(record)
  const execute: AiReviewExecutor = options.executor ?? ((input, pid, uid) => executeAiAction<ReviewOutput>(def.actionType, input, pid, uid))
  const lensNames = new Set(def.lenses.map((l) => l.name))
  const batches = buildReviewBatches(spine, profile)

  // ── ngữ cảnh chung (vào mọi lô)
  const index = elementIndex(spine)
  const indexIds = new Set(index.map((e) => e.id))
  const decisions = def.withSettledContext
    ? spine.decisions.filter((d) => d.superseded_by === null).map((d) => ({ id: d.id, question: d.question, answer: d.answer }))
    : []
  const assumptions = def.withSettledContext
    ? spine.assumptions.filter((a) => a.status !== "rejected").map((a) => ({ id: a.id, statement: a.statement, status: a.status }))
    : []
  const documents = def.withSettledContext ? (await buildDocumentContext({ projectId, actionType: ActionType.REVIEW })).contextText : ""
  const openFlags = spine.flags
    .filter((f) => f.resolved_at === null)
    .map(({ rule_id, lens, section_id, message }) => ({ rule_id, lens: lens ?? null, section_id, message }))
  const settledSources = [...decisions.map((d) => d.answer), ...assumptions.map((a) => a.statement), documents]
  const knownSections = new Set(spine.sections.map((s) => s.id))

  const lensText = def.lenses.map((l) => `${l.name} - ${l.hint}`).join("\n")
  const accepted = new Map<string, { lens: string; section_id: string; target_id: string | null; message: string }>()
  let droppedUnquoted = 0

  for (const batch of batches) {
    const input: AiActionInput = {
      promptVariables: {
        call_kind: def.callKind,
        step_id: def.stepId,
        lenses: lensText,
        section_ids: batch.section_ids,
        projection: batch.projection,
        element_index: index,
        decisions,
        assumptions,
        documents,
        glossary: spine.glossary.map(({ id, term, definition }) => ({ id, term, definition })),
        open_flags: openFlags,
        business_goals: spine.project.goals
      },
      ...(options.replyLanguage ? { replyLanguage: options.replyLanguage } : {})
    }
    const result = await meteredCall(projectId, userId, def, () => execute(input, projectId, userId))
    const sources = [...collectStrings(batch.projection), ...settledSources]
    const batchSections = new Set(batch.section_ids)
    let ambiguityKept = 0

    // Không tin output: chỉ nhận cờ vàng, lens thuộc profile, câu trích khớp nguồn
    for (const f of result.data.flags ?? []) {
      const lens = f.rule_id ?? ""
      const message = humanizeReviewMessage(f.message.trim(), options.replyLanguage ?? "vi")
      if (f.level !== "yellow" || !lensNames.has(lens) || message === "") continue

      const targetId = f.target_id && indexIds.has(f.target_id) ? f.target_id : null
      const sectionId = batchSections.has(f.section_id) || knownSections.has(f.section_id) ? f.section_id : sectionOfTarget(spine, targetId)

      // `cross_section_gap` về con số có thể không có câu để trích; có trích thì vẫn phải đúng nguồn
      const quote = f.quote?.trim() ?? ""
      const quoteRequired = lens !== "cross_section_gap" || quote !== ""
      if (quoteRequired && !verifyQuote(quote, sources)) {
        droppedUnquoted += 1
        continue
      }

      const key = flagDedupeKey(lens, sectionId, targetId, message)
      if (accepted.has(key)) continue
      // Giữ theo thứ tự model trả; ambiguity không được chiếm hết chỗ của lens mâu thuẫn
      if (lens === "ambiguity") {
        if (ambiguityKept >= AI_REVIEW_MAX_AMBIGUITY_PER_BATCH) continue
        ambiguityKept += 1
      }
      accepted.set(key, { lens, section_id: sectionId, target_id: targetId, message })
    }
  }
  if (droppedUnquoted > 0) console.warn(`[ai-review] ${def.stepId}: bỏ ${droppedUnquoted} cờ vì câu trích không khớp nguồn`)

  // ── ghi đè lượt trước của chính bước này. Đọc lại Spine: model chạy lâu, cờ có thể đã đổi trong lúc đó
  const latest = (await repository.get(projectId)) ?? record
  const now = new Date().toISOString()
  const ownedBefore = latest.flags.filter(
    (f) => f.rule_id === AI_REVIEW_RULE && baseStep(f.remediation_step) === def.stepId && f.resolved_at === null && !f.waived_by_user
  )
  const closing = ownedBefore.filter((f) => f.kept_reason === null)
  // Cờ người đã giữ (còn mở, có lý do) hoặc đã waive thì giữ nguyên, và cờ mới cùng chỗ + cùng lens không thêm
  const userDecided = new Set(
    latest.flags
      .filter((f) => f.rule_id === AI_REVIEW_RULE && baseStep(f.remediation_step) === def.stepId && (f.waived_by_user || (f.resolved_at === null && f.kept_reason !== null)))
      .map((f) => flagSlotKey(f.lens, f.section_id, f.target_id))
  )
  const fresh = [...accepted.values()].filter((c) => !userDecided.has(flagSlotKey(c.lens, c.section_id, c.target_id)))

  const nextId = nextFlagId(latest.flags)
  const ops: Op[] = [
    ...closing.map((f): Op => ({ op: "set", path: `flags[id=${f.id}].resolved_at`, value: now, reason: `${def.reason}: chạy lại, đóng cờ lượt trước` })),
    ...fresh.map((c): Op => {
      const flag: Flag = {
        id: nextId(),
        level: "yellow",
        rule_id: AI_REVIEW_RULE,
        lens: c.lens,
        section_id: c.section_id,
        target_id: c.target_id,
        message: c.message,
        remediation_step: def.stepId,
        opened_at_version: latest.spine_version + 1,
        resolved_at: null,
        waived_by_user: false,
        waive_reason: null,
        waived_at_version: null,
        kept_reason: null,
        kept_by: null,
        kept_at: null
      }
      return { op: "add", path: "flags[]", value: flag, reason: def.reason }
    })
  ]

  if (ops.length === 0) {
    return { spine_version: latest.spine_version, opened: [], closed: [], dropped_unquoted: droppedUnquoted, batches: batches.length, skipped: false }
  }

  const applied = await applyTransaction(projectId, { base_version: latest.spine_version, ops, by: userId, step_id: def.stepId, reason: def.reason })
  return {
    spine_version: applied.spine_version,
    opened: ops.filter((o) => o.op === "add").map((o) => (o.value as Flag).id),
    closed: closing.map((f) => f.id),
    dropped_unquoted: droppedUnquoted,
    batches: batches.length,
    skipped: false
  }
}
