/**
 * C-2 làm rõ CR (nút 3.2–3.3, UC-49). FLF-171, plan §6 2E.
 * Mơ hồ ⇒ vòng hỏi mới (`awaiting_answers`); rõ (hoặc đã hết 3 vòng) ⇒ lưu đích (entity path, từ khoá) cho C-3
 * và chuyển `impact_review`. AI lỗi / hết credit ⇒ `paused` ở `clarifying`.
 * Mode 1 v3 phase 7: "mơ hồ" gồm cả thiếu dữ kiện để viết nội dung mới — prompt kèm tài liệu bổ sung; câu trả lời
 * trống = chưa biết; đi tiếp mà còn thiếu ⇒ `missing_info` cho C-4 ghi giả định.
 * FLF-367: CR mâu thuẫn với tài liệu (Spine mọi section, đoạn văn giữ nguyên) ⇒ câu hỏi mâu thuẫn trích cả hai phía,
 * hỏi cả khi đã hết `MAX_CLARIFY_ROUNDS`; câu đã hỏi không hỏi lại.
 */

import { ActionType } from "../../shared/ai/ai-action.types.js"
import type { CrClarifyOutput } from "../../shared/ai/response-parser.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { latestDocVersion } from "../doc-version/doc-version.service.js"
import { stripRecord } from "../import/check.service.js"
import { DocBlock } from "../import/doc-block.model.js"
import { loadLayout, titleOfSection } from "../import/gap-report.service.js"
import type { LayoutEntry } from "../import/template-profile.model.js"
import { withMeteredAi } from "../import/metered-ai.js"
import { internalElementNames, nameElementIds } from "../spine/human-labels.js"
import { similarQuestion } from "../pipeline/decisions.service.js"
import { listSections } from "../spine/section-registry.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { accountLocaleOf } from "../user/account-locale.js"
import type { UserLocale } from "../../shared/i18n/locale.js"
import { approvedBatch } from "./add-use-case.service.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus, transitionCr } from "./change-request.service.js"
import { AMENDABLE_CR_STATUSES, MAX_CLARIFY_ROUNDS, canAskMore } from "./change-request.state.js"
import { answersText, crHeader, crProjection, crQuery, relevantMaterialsText, truncate } from "./cr-context.js"
import { clarifyLanguageText, crDocumentLanguage, crReplyLanguage } from "./cr-language.js"
import { mentionedSections, mergeHeadings, type HeadingRef } from "./section-mention.js"

/**
 * Tiêu đề mục của bản tài liệu mới nhất, theo thứ tự (kèm mã section đã khớp). Dự án chuyển từ mode 2 (FLF-318) không
 * có file upload nên không có `DocBlock` ⇒ mục lục theo mẫu FPT từ Spine.
 */
const docHeadings = async (cr: IChangeRequest, spine: Spine): Promise<HeadingRef[]> => {
  const version = await latestDocVersion(cr.projectId)
  if (!version) return []
  const headings = await DocBlock.find({ projectId: cr.projectId, doc_version: version.version, kind: "heading" })
    .sort({ "anchor.ordinal": 1 })
    .select("text section_id")
    .lean()
  const layout = await loadLayout(String(cr.projectId))
  if (!headings.length && !layout) return listSections(spine).map((sec) => ({ text: sec.title_en, section_id: sec.id }))
  return mergeHeadings(layout, headings.map((h) => ({ text: h.text, section_id: h.section_id ?? null })))
}

const outlineText = (headings: readonly HeadingRef[]): string =>
  truncate(headings.map((h) => `${h.text}${h.section_id ? ` (${h.section_id})` : ""}`).join("\n"), 3000)

/** Chữ người yêu cầu viết: tiêu đề, mô tả, lệnh gộp thêm, câu trả lời (không lấy câu hỏi của AI). */
/**
 * CR tạo từ nút "Viết" của mục thiếu sau đổi mẫu mang `source.ref` = `section_id` của mục — đích ghi nội dung. Chỉ nhận khi đúng là
 * mục có heading trong tài liệu hiện tại (ref là chữ tự do của form thì bỏ qua).
 */
export const sourceRefSections = (ref: string | null | undefined, headings: readonly HeadingRef[]): string[] =>
  ref && headings.some((h) => h.section_id === ref) && !/^(group:|unmapped$)/.test(ref) ? [ref] : []

const requesterText = (cr: IChangeRequest): string =>
  [cr.title, cr.description, ...(cr.amendments ?? []).map((a) => a.text), ...cr.clarifications.flatMap((c) => c.answers)].join("\n")

/**
 * Lựa chọn mặc định cho câu hỏi mâu thuẫn (FLF-367) khi model không gợi ý, theo ngôn ngữ hỏi người yêu cầu; người dùng
 * vẫn tự gõ được ("khác").
 */
export const CONTRADICTION_CHOICES: Readonly<Record<UserLocale, readonly string[]>> = {
  vi: ["Đổi theo CR và sửa cả chỗ cũ", "Giữ như cũ, không áp dụng phần này của CR"],
  en: ["Change per the CR and fix the old text too", "Keep as is, skip this part of the CR"]
}

/** Lựa chọn mặc định cho câu hỏi cảnh báo yêu cầu không hợp lý (BF §3.2 C-4) khi model không gợi ý. Lựa chọn đầu = làm tiếp. */
export const WARNING_CHOICES: Readonly<Record<UserLocale, readonly string[]>> = {
  vi: ["Vẫn làm", "Bỏ yêu cầu này"],
  en: ["Proceed anyway", "Drop this request"]
}

const questionKey = (q: string): string => q.replace(/\s+/g, " ").trim().toLowerCase()

/**
 * Câu hỏi "ai / bao nhiêu" (trả lời bằng một giá trị): lựa chọn mặc định "Đổi theo CR / Giữ như cũ" không khớp câu này (EduCampus
 * B9: "tác nhân của UC-11 nên là ai" mà chỉ có hai nút đổi / giữ) ⇒ model không gợi ý thì để người dùng tự gõ.
 */
export const asksForValue = (question: string): boolean =>
  /(?<![\p{L}\p{N}])(ai|who|whom|bao nhiêu|how many|how much)(?![\p{L}\p{N}])/iu.test(question)

type NewContradictionOptions = {
  /** Đổi mã nội bộ trong câu mới sang tên như câu đã lưu (câu đã lưu qua `nameElementIds` rồi) — so cùng một dạng. */
  name?: (text: string) => string
}

/**
 * Câu hỏi mâu thuẫn chưa từng hỏi (so mọi vòng trước, có trả lời hay bỏ trống) kèm gợi ý. FLF-474: so **cả hai phía** đã đổi mã
 * sang tên, theo độ trùng từ (`similarQuestion`) chứ không nguyên văn — model diễn đạt lại một chút mỗi vòng. Model không gợi ý ⇒
 * lựa chọn mặc định theo ngôn ngữ, trừ câu "ai / bao nhiêu" (để trống, người dùng tự gõ). `question` trả về là chữ gốc của model.
 */
export const newContradictions = (
  cr: Pick<IChangeRequest, "clarifications">,
  found: readonly { question: string; suggestions: readonly string[] }[],
  language: UserLocale = "vi",
  options: NewContradictionOptions = {}
): { question: string; suggestions: string[] }[] => {
  const name = options.name ?? ((t: string) => t)
  const seen: string[] = cr.clarifications.flatMap((c) => c.questions)
  const isSeen = (named: string): boolean => {
    const key = questionKey(named)
    return seen.some((q) => questionKey(q) === key || similarQuestion(q, named))
  }
  const out: { question: string; suggestions: string[] }[] = []
  for (const c of found) {
    const named = name(c.question)
    if (!questionKey(named) || isSeen(named)) continue
    seen.push(named)
    const suggestions = [...new Set(c.suggestions.map((s) => s.trim()).filter(Boolean))]
    const fallback = asksForValue(c.question) ? [] : [...CONTRADICTION_CHOICES[language]]
    out.push({ question: c.question.trim(), suggestions: suggestions.length ? suggestions : fallback })
  }
  return out
}

/**
 * Người yêu cầu đã chọn làm tiếp sau một cảnh báo của C-2: bấm đúng gợi ý đầu của câu cảnh báo ("Vẫn làm" / "Proceed
 * anyway"). Lời tự gõ do model đọc (`warning_accepted`).
 */
export const pickedProceed = (cr: Pick<IChangeRequest, "clarifications">): boolean =>
  cr.clarifications.some((round) =>
    (round.warning_questions ?? []).some((i) => {
      const answer = round.answers[i]
      const proceed = round.suggestions?.[i]?.[0]
      return !!answer && !!proceed && questionKey(answer) === questionKey(proceed)
    })
  )

type ForcedInput = Pick<CrClarifyOutput, "contradictions" | "warnings">

/**
 * Câu phải hỏi kể cả khi hết vòng làm rõ: mâu thuẫn (FLF-367) và cảnh báo yêu cầu không hợp lý (BF §3.2 C-4), mỗi câu kèm
 * lựa chọn. Chống vòng hỏi vô tận: model diễn đạt lại câu cũ mỗi lượt thì so nguyên văn không bắt được ⇒ cảnh báo hỏi đúng một
 * lần mỗi CR, mâu thuẫn chỉ thêm được một vòng sau trần làm rõ; quá đó thì đi tiếp (mâu thuẫn còn lại ra cờ vàng ở C-5).
 */
export const forcedQuestions = (
  cr: Pick<IChangeRequest, "clarifications">,
  out: ForcedInput,
  asked: number,
  language: UserLocale,
  options: NewContradictionOptions = {}
): { contradictions: { question: string; suggestions: string[] }[]; warningKeys: Set<string> } => {
  if (asked > MAX_CLARIFY_ROUNDS) return { contradictions: [], warningKeys: new Set() }
  const warnedBefore = cr.clarifications.some((round) => (round.warning_questions ?? []).length > 0)
  const warnings = warnedBefore ? [] : out.warnings
  const contradictions = newContradictions(
    cr,
    [...out.contradictions, ...warnings.map((w) => ({ question: w.question, suggestions: w.suggestions.length ? w.suggestions : [...WARNING_CHOICES[language]] }))],
    language,
    options
  )
  return { contradictions, warningKeys: new Set(warnings.map((w) => questionKey(w.question))) }
}

/** Từ khoá dự phòng khi hết vòng mà model vẫn thấy mơ hồ: từ dài trong tiêu đề CR. */
const fallbackKeywords = (cr: IChangeRequest): string[] => cr.title.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5).slice(0, 5)

/**
 * FLF-449: CR tạo từ danh sách rút đã trả lời câu hỏi (`seed.skip_clarify`), có chỗ đã tra, chưa gộp thêm lệnh và chỉ có đúng
 * vòng hỏi đáp mang sang từ thẻ hỏi (đã trả lời đủ).
 */
export const extractionAnswered = (cr: Pick<IChangeRequest, "seed" | "amendments" | "clarifications">): boolean =>
  !!cr.seed?.skip_clarify &&
  (cr.seed.targets ?? []).length > 0 &&
  !cr.amendments?.length &&
  cr.clarifications.length === 1 &&
  cr.clarifications[0].answers.length === cr.clarifications[0].questions.length

/** Câu mâu thuẫn (không kể cảnh báo) đã hỏi mà người dùng bỏ trống ⇒ coi như "Giữ như cũ" (FLF-474). */
export const unansweredContradictions = (cr: Pick<IChangeRequest, "clarifications">): string[] =>
  cr.clarifications.flatMap((round) =>
    round.questions.filter((_, i) => round.kinds?.[i] === "contradiction" && !(round.warning_questions ?? []).includes(i) && !round.answers[i]?.trim() && round.answers.length > 0)
  )

export const runClarify = async (cr: IChangeRequest, userId: string): Promise<void> => {
  assertCrStatus(cr, ["draft", "clarifying"], "clarifying")
  await transitionCr(cr, "clarifying")
  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const spine = stripRecord(record)
  const round = cr.clarifications.length + 1
  // Phase 8: mỗi lần gộp thêm lệnh được hỏi lại tối đa 3 vòng (đếm từ lần gộp gần nhất)
  const lastAmendment = cr.amendments?.length ? cr.amendments[cr.amendments.length - 1] : null
  const asked = cr.clarifications.length - (lastAmendment?.after_round ?? 0)

  cr.paused = null
  // FLF-318: CR tạo từ bản xem trước đã duyệt (thêm / xoá / sửa use case) ⇒ câu hỏi đã hỏi trong chat như trước
  // baseline, lô đã chốt ⇒ không hỏi thêm, không gọi model; C-3 lấy vị trí theo đúng lô
  if (approvedBatch(spine, cr)) {
    cr.missing_info = []
    cr.markModified("missing_info")
    cr.targets = { entity_paths: [...new Set(cr.seed?.targets ?? [])], keywords: [] }
    cr.markModified("targets")
    await transitionCr(cr, "impact_review")
    return
  }
  // FLF-449 (BF §3.6.1 "bỏ C-2 nếu đã hỏi ở bước 4"): CR từ danh sách rút, BA đã trả lời ở thẻ hỏi (câu trả lời nằm trong
  // `clarifications`) và Code đã tra được chỗ ⇒ không hỏi lại, không gọi model; C-3 đi từ chỗ đã tra. Gộp thêm lệnh sau đó ⇒
  // làm rõ như thường.
  if (extractionAnswered(cr)) {
    cr.missing_info = []
    cr.markModified("missing_info")
    cr.targets = { entity_paths: [...new Set(cr.seed?.targets ?? [])], keywords: [] }
    cr.markModified("targets")
    await transitionCr(cr, "impact_review")
    return
  }
  const headings = await docHeadings(cr, spine)
  // Mục người yêu cầu gọi tên ("phần 3.1.3 Screen Authorization") luôn là đích — code nhận, không trông vào model.
  const named = [...new Set([...mentionedSections(requesterText(cr), headings), ...sourceRefSections(cr.source?.ref, headings)])]
  // FLF-438: hỏi theo ngôn ngữ người yêu cầu; khác ngôn ngữ tài liệu ⇒ tên / đoạn trích kèm bản dịch trong ngoặc
  const replyLanguage = crReplyLanguage(requesterText(cr), await accountLocaleOf(userId))
  const language = clarifyLanguageText(replyLanguage, await crDocumentLanguage(String(cr.projectId), spine))
  const result = await withMeteredAi<CrClarifyOutput>({ projectId: String(cr.projectId), userId, stepId: `C-2:${cr.cr_id}` }, ActionType.CR_CLARIFY, {
    ...crHeader(cr),
    round: Math.min(asked + 1, MAX_CLARIFY_ROUNDS),
    clarifications: answersText(cr),
    materials: await relevantMaterialsText(cr, crQuery(cr)),
    // FLF-367: kèm BR / NFR và đoạn văn giữ nguyên liên quan (theo cụm từ của CR hoặc mục được gọi tên) để thấy mâu thuẫn
    projection: crProjection(spine, `${cr.title}\n${crHeader(cr).description}\n${answersText(cr)}\n${(cr.materials ?? []).map((m) => m.text).join("\n")}`, {
      sections: named
    }),
    outline: outlineText(headings),
    language
  })
  if (!result.ok) {
    cr.paused = { reason: result.reason, at: new Date() }
    await cr.save()
    return
  }
  const out = result.data
  // Câu trả lời vừa gửi là lời rút lại ⇒ FE hỏi huỷ CR (chỉ khi lượt này có câu trả lời; không bao giờ tự huỷ)
  const answeredNow = (cr.clarifications[cr.clarifications.length - 1]?.answers ?? []).some((a) => a.trim() !== "")
  cr.withdraw_suggested = answeredNow && out.withdraw === true
  // Cảnh báo ở vòng trước đã được trả lời là làm tiếp (bấm "Vẫn làm", hoặc model đọc lời tự gõ) ⇒ ghi lại cho C-3 / C-4
  if (!cr.proceed_after_warning && (pickedProceed(cr) || out.warning_accepted === true)) cr.proceed_after_warning = true
  // FLF-367: mâu thuẫn hỏi cả khi đã hết vòng làm rõ (không qua `canAskMore`), đứng trước câu hỏi mơ hồ
  // BF §3.2 C-4: yêu cầu không hợp lý ⇒ cảnh báo + lý do, hỏi "Vẫn làm" hay bỏ (một lần, như câu mâu thuẫn)
  // P06 (CR #3) + FLF-474: câu hỏi / gợi ý cho người dùng không lộ mã nội bộ ("SCR-05", "FN009", "CS27") — thay bằng tên phần tử
  const layout: LayoutEntry[] | undefined = await loadLayout(String(cr.projectId))
  const extraNames = internalElementNames(spine, (id) => titleOfSection(spine, id, layout))
  const withNames = (text: string) => nameElementIds(text, spine, extraNames)
  const { contradictions, warningKeys } = forcedQuestions(cr, out, asked, replyLanguage, { name: withNames })
  const askAmbiguous = out.ambiguous && canAskMore(asked)
  if (askAmbiguous || contradictions.length) {
    // Gợi ý song song câu hỏi — model trả thiếu / thừa thì cắt, bù `[]`; bỏ gợi ý trùng
    const ambiguous = askAmbiguous ? out.questions : []
    const suggestions = ambiguous.map((_, i) => [...new Set((out.suggestions[i] ?? []).map((s) => s.trim()).filter(Boolean))])
    cr.clarifications.push({
      round,
      questions: [...contradictions.map((c) => c.question), ...ambiguous].map(withNames),
      answers: [],
      suggestions: [...contradictions.map((c) => c.suggestions), ...suggestions].map((list) => list.map(withNames)),
      warning_questions: contradictions.flatMap((c, i) => (warningKeys.has(questionKey(c.question)) ? [i] : [])),
      kinds: [...contradictions.map(() => "contradiction" as const), ...ambiguous.map(() => "ambiguous" as const)]
    })
    await transitionCr(cr, "awaiting_answers")
    return
  }
  // Phase 7: đi tiếp mà còn thiếu dữ kiện (thường là hết vòng hỏi) ⇒ C-4 viết kèm giả định. Model vẫn thấy "mơ hồ" ở
  // vòng cuối mà không liệt kê ⇒ câu hỏi chưa được trả lời chính là dữ kiện thiếu.
  // FLF-474: câu mâu thuẫn bỏ trống = giữ như cũ ⇒ ghi vào dữ kiện còn thiếu để C-4 viết kèm giả định, không hỏi lại
  const missing = (out.missing_info.length ? out.missing_info : out.ambiguous ? out.questions : []).map(withNames)
  cr.missing_info = [...new Set([...missing, ...unansweredContradictions(cr)])]
  cr.markModified("missing_info")
  // Đã chỉ đích danh mục thì bỏ từ khoá của model: từ khoá kiểu "SCR-01", "Hộ gia đình" kéo cả tài liệu vào CR.
  // FLF-445: CR tạo từ nhóm cờ đã có đích là chỗ bị cờ ⇒ cũng bỏ từ khoá, để C-3 bám đúng chỗ đó.
  const keywords = named.length || cr.flag_ids?.length ? [] : out.targets.keywords.length || out.targets.entity_paths.length ? out.targets.keywords : fallbackKeywords(cr)
  // Phần tử bản xem trước đã chạm (mode 1 v3) luôn là đích — 3.4 vẫn tìm thêm vị trí liên quan như thường
  cr.targets = { entity_paths: [...new Set([...named, ...out.targets.entity_paths, ...(cr.seed?.targets ?? [])])], keywords }
  cr.markModified("targets")
  await transitionCr(cr, "impact_review")
}

/**
 * Phase 8 (chat): gộp thêm một lệnh sửa vào CR chưa nộp. `draft` ⇒ chỉ ghi lại (bước làm rõ đầu tiên đọc luôn); sau đó ⇒
 * quay lại 3.2 (khoá giữ nguyên, vị trí + đề xuất cũ giữ nguyên; C-3 chỉ cộng thêm vị trí mới).
 */
export const amendCr = async (cr: IChangeRequest, userId: string, instruction: string): Promise<void> => {
  assertCrStatus(cr, AMENDABLE_CR_STATUSES, "clarifying")
  cr.amendments.push({ text: instruction, at: new Date(), after_round: cr.clarifications.length })
  cr.markModified("amendments")
  cr.paused = null
  await cr.save()
  if (cr.status === "draft") return
  await transitionCr(cr, "clarifying")
  await runClarify(cr, userId)
}

/** UC-49: trả lời đúng số câu hỏi của vòng đang chờ rồi chạy lại C-2. */
export const answerClarification = async (cr: IChangeRequest, userId: string, answers: string[]): Promise<void> => {
  assertCrStatus(cr, ["awaiting_answers"], "clarifying")
  const last = cr.clarifications[cr.clarifications.length - 1]
  if (!last || answers.length !== last.questions.length) {
    throw new ApiError(400, `Cần ${last?.questions.length ?? 0} câu trả lời theo đúng thứ tự câu hỏi`, "VALIDATION_ERROR")
  }
  last.answers = answers
  cr.markModified("clarifications")
  await transitionCr(cr, "clarifying")
  await runClarify(cr, userId)
}
