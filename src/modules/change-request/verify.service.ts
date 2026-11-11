/**
 * C-5 kiểm đề xuất (nút 3.7–3.9, UC-82). FLF-171, plan §6 2E; mode 1 v2 (FLF-186) theo phần tử Spine.
 * - Code (chặn): phần tử vẫn do CR giữ khoá; giá trị tại path **chưa đổi** kể từ lúc đề xuất (lệch ⇒
 *   `409 CR_VALUE_CHANGED`); `edit` có op và đổi thật; op chỉ chạm phần tử CR đang khoá (thêm phần tử mới thì được);
 *   `comment` có nội dung; toàn bộ op của CR qua `planTransaction` chạy khô + bất biến; Spine giả lập không thêm cờ đỏ
 *   (hồ sơ luật mode 1).
 * - AI `CR_CONSISTENCY`: nhận xét vàng trên phạm vi thay đổi (phần tử cùng section; FLF-367 thêm phần tử liên quan ở
 *   section khác + đoạn văn giữ nguyên), gắn theo `section_id`. FLF-367: `contradiction` chưa hỏi ⇒ quay lại hỏi người
 *   yêu cầu (`clarifying → awaiting_answers`), không đi tới `ready_to_submit`.
 *   FLF-307: chỉ chạy khi cả CR qua kiểm code và có vị trí đổi đề xuất từ lần trước; nhận xét cũ giữ lại và đưa AI xem
 *   để không nêu lại.
 * Trượt ⇒ AI làm lại vị trí đó (`redo_count` ≤ 2) ⇒ vẫn trượt / vị trí sửa tay trượt ⇒ `manual_fix` (3.9).
 */

import { ActionType } from "../../shared/ai/ai-action.types.js"
import type { FindingsOutput } from "../../shared/ai/response-parser.js"
import { stripRecord } from "../import/check.service.js"
import { titleOfSection } from "../import/gap-report.service.js"
import { withMeteredAi } from "../import/metered-ai.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { MODE1_RULE_PROFILE } from "../import/mode1-rule-profile.js"
import { flagKey, runDeterministicCheck } from "../spine/deterministic-check.js"
import { humanizeText, pathLabel, ruleLabel } from "../spine/human-labels.js"
import { TransactionRejectedError, planTransaction } from "../spine/op-engine.js"
import { userOpSchema, type Op } from "../spine/op.types.js"
import * as spineRepository from "../spine/spine.repository.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus, submitCr, transitionCr } from "./change-request.service.js"
import { recordAutoPass } from "../pipeline/auto-pass.service.js"
import { MAX_REDO_PER_LOCATION } from "./change-request.state.js"
import { ChangeLocation, type IChangeLocation, type VerifyViolation } from "./change-location.model.js"
import { newContradictions } from "./clarify.service.js"
import { answersText, crHeader, glossaryText, plainValues, relatedElements, relatedPassages, truncate } from "./cr-context.js"
import { regroup } from "./group.service.js"
import { crDocumentLanguage, foreignTexts, wrongLanguageMessage } from "./cr-language.js"
import type { UserLocale } from "../../shared/i18n/locale.js"
import { refreshDiagramLocations } from "./diagram-location.js"
import { fixDuplicateIds } from "./propose.service.js"
import { elementValue, isArrayPath, listElements, opElement, sectionOfElement, unchangedSince, valueText } from "./spine-location.js"

export const valueChanged = (loc: Pick<IChangeLocation, "location_id" | "path">): Mode1Error =>
  new Mode1Error("CR_VALUE_CHANGED", `${pathLabel(loc.path)} đã bị sửa ở chỗ khác kể từ lúc đề xuất — tải lại rồi đề xuất lại`, { location_id: loc.location_id, path: loc.path })

type CheckLocation = Pick<IChangeLocation, "location_id" | "path" | "conclusion" | "proposal">

const opPath = (raw: unknown): string => {
  const path = (raw as { path?: unknown } | null)?.path
  return typeof path === "string" ? path : ""
}

/** Phần tử mà các op của vị trí chạm tới (bỏ op thêm phần tử mới `arr[]`). */
export const opElements = (loc: Pick<IChangeLocation, "proposal">): string[] =>
  (loc.proposal?.spine_ops ?? []).map((o) => opElement(opPath(o))).filter((p): p is string => !!p)

/** Kiểm tất định từng vị trí (không gồm chạy khô op — xem `checkSpineOps`). `locks`: path ⇒ CR giữ khoá. */
/**
 * FLF-375: phần tử "thuộc" CR (thay bảng khoá đã bỏ) — mọi vị trí của CR + phần tử CR tự thêm bằng op `add` (lô use case
 * tạo use case / chức năng / màn mới rồi sửa tiếp chúng). Op chạm phần tử ngoài tập này ⇒ `op_path_not_locked`.
 */
export const ownedElements = (crId: string, locations: readonly Pick<IChangeLocation, "path" | "proposal">[]): Map<string, string> => {
  const owned = new Map<string, string>()
  for (const l of locations) {
    owned.set(l.path, crId)
    for (const raw of l.proposal?.spine_ops ?? []) {
      const o = raw as { op?: unknown; path?: unknown; value?: unknown }
      const array = typeof o.path === "string" ? /^(\w+)\[\]$/.exec(o.path)?.[1] : undefined
      const id = o.value && typeof o.value === "object" ? (o.value as { id?: unknown }).id : undefined
      if (o.op === "add" && array && typeof id === "string") owned.set(`${array}[id=${id}]`, crId)
    }
  }
  return owned
}

/** Chữ mới của đề xuất viết khác ngôn ngữ tài liệu (QLHS 11/11 bug #17) — `new_text` là JSON giá trị sau khi sửa. */
const languageViolation = (loc: CheckLocation, current: unknown, language: UserLocale): VerifyViolation[] => {
  let after: unknown
  try {
    after = JSON.parse(loc.proposal?.new_text ?? "null")
  } catch {
    return []
  }
  const texts = foreignTexts(language, current, after)
  return texts.length ? [{ rule: "wrong_language", message: wrongLanguageMessage(pathLabel(loc.path), language, texts) }] : []
}

/** `language`: ngôn ngữ chữ của tài liệu (`crDocumentLanguage`) — thiếu ⇒ không kiểm ngôn ngữ. */
export const checkLocation = (
  cr: Pick<IChangeRequest, "cr_id">,
  loc: CheckLocation,
  spine: Spine,
  locks: ReadonlyMap<string, string>,
  language?: UserLocale
): VerifyViolation[] => {
  if (!loc.conclusion) return [{ rule: "unconcluded", message: "Vị trí chưa có kết luận" }]
  if (loc.conclusion === "not_related") return []
  const current = elementValue(spine, loc.path)
  if (current === undefined) return [{ rule: "element_missing", message: `${pathLabel(loc.path)} không còn trong tài liệu`, path: loc.path }]
  const out: VerifyViolation[] = []
  const p = loc.proposal
  if (!p) return [...out, { rule: "no_proposal", message: "Thiếu đề xuất" }]
  // FLF-375 (§3.2): trước khi xác nhận, đề xuất chưa có giá trị kiểm tra — chữ cũ đã đổi (người khác vừa ghi) ⇒ AI soạn
  // lại trên nội dung hiện tại như một lỗi kiểm thường; lúc xác nhận mới so 3 cột (`concurrent-edit.ts`)
  if (!unchangedSince(spine, loc.path, p)) return [...out, { rule: "value_changed", message: `${pathLabel(loc.path)} vừa được sửa ở chỗ khác — soạn lại trên nội dung hiện tại`, path: loc.path }]
  if (loc.conclusion === "edit") {
    if (!p.spine_ops.length) out.push({ rule: "edit_without_ops", message: "Kết luận là sửa nhưng chưa có nội dung sửa" })
    else if (p.new_text !== null && p.new_text === p.old_text) out.push({ rule: "edit_no_change", message: "Đề xuất không thay đổi gì ở phần tử này" })
    for (const el of opElements(loc)) {
      if (el !== loc.path && locks.get(el) !== cr.cr_id) out.push({ rule: "op_path_not_locked", message: `Đề xuất sửa cả ${pathLabel(el)} — phần này không thuộc các vị trí của change request`, path: el })
    }
    // Vị trí "mục trống" (`arr[]`): chỉ được thêm phần tử vào đúng mảng đó, không lấn sang mảng khác
    if (isArrayPath(loc.path)) {
      const array = loc.path.slice(0, -2)
      for (const raw of p.spine_ops) {
        const path = opPath(raw)
        if (!path.startsWith(array)) out.push({ rule: "op_outside_section", message: `Đề xuất sửa ${pathLabel(path)} — vị trí này chỉ được thêm mới vào ${pathLabel(loc.path)}`, path })
      }
    } else {
      // Phần tử mới chỉ thêm từ ô "thêm mới" của đúng mục (2026-09-24: AI chèn bảng phân quyền thành mục riêng mới từ vị
      // trí tác nhân A01 / màn SCR-06 — thêm phần tử không qua khoá nên trước đây lọt kiểm)
      for (const raw of p.spine_ops) {
        const path = opPath(raw)
        if (isArrayPath(path)) {
          out.push({ rule: "add_outside_slot", message: `Đề xuất thêm ${pathLabel(path)} từ ${pathLabel(loc.path)} — phần tử mới phải thêm ở ô “thêm mới” của đúng mục`, path })
        }
      }
    }
    if (language) out.push(...languageViolation(loc, current, language))
  }
  if (loc.conclusion === "comment" && !p.comment_text?.trim()) out.push({ rule: "comment_empty", message: "Kết luận là ghi chú nhưng chưa có nội dung ghi chú" })
  return out
}

/** Chạy khô toàn bộ op Spine của CR; vi phạm gắn về vị trí sinh ra op. */
export const checkSpineOps = (spine: Spine, cr: Pick<IChangeRequest, "cr_id">, locations: CheckLocation[]): Map<string, VerifyViolation[]> => {
  const out = new Map<string, VerifyViolation[]>()
  const push = (locId: string, v: VerifyViolation) => out.set(locId, [...(out.get(locId) ?? []), v])
  const ops: Op[] = []
  const owner: string[] = []
  for (const l of locations) {
    if (l.conclusion !== "edit") continue
    for (const raw of l.proposal?.spine_ops ?? []) {
      const parsed = userOpSchema.safeParse(raw)
      if (!parsed.success) {
        push(l.location_id, { rule: "op_invalid", message: "Nội dung sửa sai định dạng, không áp dụng được" })
        continue
      }
      ops.push(parsed.data)
      owner.push(l.location_id)
    }
  }
  if (!ops.length) return out
  try {
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: cr.cr_id }, { startSeq: 1 })
    const before = new Set(runDeterministicCheck(spine, [], { ruleProfile: MODE1_RULE_PROFILE }).filter((c) => c.level === "red").map(flagKey))
    // `diagram_stale` không tính: sửa dữ liệu hình thể hiện thì hình PlantUML cũ đi là đương nhiên — 3.14 vẽ lại ngay sau
    // khi ghi. Trước đây mọi CR đổi tên use case / actor / màn đều trượt kiểm vì "lỗi đỏ mới" này.
    const newRed = runDeterministicCheck(plan.spine, [], { ruleProfile: MODE1_RULE_PROFILE }).filter(
      (c) => c.level === "red" && c.rule_id !== "diagram_stale" && !before.has(flagKey(c))
    )
    for (const c of newRed) for (const locId of new Set(owner)) push(locId, { rule: "new_red_flag", message: `Đề xuất làm phát sinh lỗi đỏ mới: ${ruleLabel(c.rule_id) ? `${ruleLabel(c.rule_id)} — ` : ""}${c.message}` })
  } catch (err) {
    if (!(err instanceof TransactionRejectedError)) throw err
    for (const v of err.violations) {
      const locId = v.op_index !== undefined ? owner[v.op_index] : undefined
      for (const id of locId ? [locId] : [...new Set(owner)]) push(id, { rule: v.rule, message: humanizeText(v.message), ...(v.path ? { path: v.path } : {}) })
    }
  }
  return out
}

/** Phần phạm vi cùng section (giữ chỗ cho phần tử section khác + đoạn văn giữ nguyên, FLF-367). */
const NEIGHBOURS_CHARS = 5000

/**
 * Phạm vi đưa AI xem: phần tử khác cùng section với vị trí sửa (tối đa `limit` phần tử); FLF-367 thêm phần tử liên quan ở
 * section khác và đoạn văn giữ nguyên liên quan (theo cụm từ của CR + giá trị sau khi sửa).
 */
export const scopeText = (spine: Spine, changed: readonly Pick<IChangeLocation, "path" | "section_id" | "proposal">[], query: string, limit = 20): string => {
  const sections = new Set(changed.map((l) => l.section_id))
  const edited = new Set(changed.map((l) => l.path))
  const neighbours = listElements(spine)
    .filter((e) => !edited.has(e.path) && sections.has(sectionOfElement(spine, e.path)))
    .slice(0, limit)
  const shown = new Set([...edited, ...neighbours.map((e) => e.path)])
  // Giá trị sau khi sửa là JSON ⇒ chỉ lấy giá trị chữ (tên khoá như "business_rule_ids" kéo mọi phần tử vào)
  const text = `${query}\n${changed.map((l) => plainValues(l.proposal?.new_text ?? l.proposal?.comment_text ?? "")).join("\n")}`
  const others = relatedElements(spine, text, { exclude: [...shown] })
  const passages = relatedPassages(spine, text, { exclude: [...shown] })
  const lines = [
    truncate(neighbours.map((e) => `[${e.path}] (${sectionOfElement(spine, e.path)}) ${truncate(valueText(e.value), 600)}`).join("\n"), NEIGHBOURS_CHARS),
    ...others.map((e) => `[${e.path}] (${e.section_id}) ${e.text}`),
    ...(passages.length ? ["Passages kept verbatim:", ...passages] : [])
  ].filter(Boolean)
  return lines.join("\n") || "(none)"
}

/**
 * FLF-367: mâu thuẫn C-5 thấy ⇒ hỏi người yêu cầu (`verifying → clarifying → awaiting_answers`) thay vì ghi chú vàng.
 * Câu hỏi = nhận xét (trích cả hai phía) + lựa chọn; câu đã hỏi ở vòng trước thì thôi. Vị trí không sửa tay bỏ kết luận
 * để C-4 đề xuất lại theo câu trả lời (khoá giữ nguyên như luồng gộp lệnh `amend`; C-3 tìm lại vị trí như thường).
 */
const askContradictions = async (cr: IChangeRequest, locations: IChangeLocation[], questions: { question: string; suggestions: string[] }[]): Promise<void> => {
  for (const l of locations) {
    if (l.manual) continue
    l.conclusion = null
    l.reason = null
    l.proposal = null
    l.verify = null
    l.redo_count = 0
  }
  await Promise.all(locations.map((l) => l.save()))
  await regroup(cr)
  await transitionCr(cr, "clarifying")
  cr.clarifications.push({
    round: cr.clarifications.length + 1,
    questions: questions.map((q) => q.question),
    answers: [],
    suggestions: questions.map((q) => q.suggestions)
  })
  cr.markModified("clarifications")
  await transitionCr(cr, "awaiting_answers")
}

type AiFlag = { rule: string; message: string }

/** Nhận xét AI của lần kiểm trước, theo vị trí (vị trí vừa đề xuất lại có `verify = null` ⇒ không còn nhận xét). */
export const previousFlags = (locations: readonly Pick<IChangeLocation, "location_id" | "verify">[]): Map<string, AiFlag[]> =>
  new Map(locations.flatMap((l) => (l.verify?.ai_flags.length ? [[l.location_id, l.verify.ai_flags.map((f) => ({ rule: f.rule, message: f.message }))] as const] : [])))

export const previousFindingsText = (flags: ReadonlyMap<string, readonly AiFlag[]>): string => {
  const messages = [...new Set([...flags.values()].flat().map((f) => `- (${f.rule}) ${f.message}`))]
  return messages.length ? truncate(messages.join("\n"), 3000) : "(none)"
}

export const runVerify = async (cr: IChangeRequest, userId: string): Promise<void> => {
  assertCrStatus(cr, ["proposing", "manual_fix", "ready_to_submit", "verifying"], "verifying")
  await transitionCr(cr, "verifying")
  cr.paused = null
  await cr.save()
  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const spine = stripRecord(record)
  const locations = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).sort({ location_id: 1 })
  // Sửa tay / "Sửa lại" cũng có thể mang id trùng ⇒ đổi trước khi chạy khô (FLF-307)
  await fixDuplicateIds(spine, locations)
  // Đề xuất của vị trí khác có thể đã đổi (sửa tay, "Sửa lại") ⇒ kết luận vẽ lại sơ đồ gốc tính lại trước khi kiểm (§4.13)
  await refreshDiagramLocations(spine, locations)
  const locks = ownedElements(cr.cr_id, locations)

  // QLHS 11/11 bug #17: chữ mới phải cùng ngôn ngữ tài liệu — lệch ⇒ vi phạm, AI làm lại như mọi lỗi kiểm code
  const language = await crDocumentLanguage(String(cr.projectId), spine)
  const violations = new Map(locations.map((l) => [l.location_id, checkLocation(cr, l, spine, locks, language)]))
  for (const [locId, vs] of checkSpineOps(spine, cr, locations)) violations.set(locId, [...(violations.get(locId) ?? []), ...vs])

  // AI consistency (FLF-307): chỉ khi cả CR đã qua kiểm code — vòng nào còn trượt thì AI làm lại, nhận xét lúc đó vô
  // ích. Không vị trí nào đổi đề xuất kể từ lần kiểm trước (`verify` còn nguyên) ⇒ giữ nhận xét cũ, không gọi lại: mỗi
  // lượt gọi ra một bộ nhận xét khác, người dùng tưởng sửa mãi không hết.
  const previous = previousFlags(locations)
  const codeOk = locations.every((l) => !violations.get(l.location_id)?.length)
  const changed = locations.filter((l) => l.conclusion === "edit" || l.conclusion === "comment")
  const aiFlags = new Map(previous)
  if (codeOk && changed.some((l) => l.verify === null)) {
    // Vị trí vừa đề xuất lại bỏ nhận xét cũ (có thể đã sửa đúng chỗ đó); AI thấy mọi nhận xét cũ để không nêu lại
    for (const l of changed) if (l.verify === null) aiFlags.delete(l.location_id)
    const result = await withMeteredAi<FindingsOutput>({ projectId: String(cr.projectId), userId, stepId: `C-5:${cr.cr_id}` }, ActionType.CR_CONSISTENCY, {
      ...crHeader(cr),
      answers: answersText(cr),
      previous_findings: previousFindingsText(previous),
      edits: truncate(
        changed
          .map((l) =>
            l.conclusion === "edit"
              ? `[${l.location_id}][${l.path}] (${l.section_id === "misc" ? "-" : `${l.section_id} ${titleOfSection(spine, l.section_id)}`})\n  before: ${truncate(l.proposal?.old_text ?? "", 1500)}\n  after: ${truncate(l.proposal?.new_text ?? "", 1500)}`
              : `[${l.location_id}][${l.path}] (comment) ${l.proposal?.comment_text}`
          )
          .join("\n")
      ),
      scope: scopeText(spine, changed, `${cr.title}\n${crHeader(cr).description}\n${answersText(cr)}`),
      glossary: glossaryText(spine)
    })
    if (!result.ok) {
      cr.paused = { reason: result.reason, at: new Date() }
      await cr.save()
      return
    }
    // FLF-367: mâu thuẫn ⇒ hỏi người yêu cầu (câu đã hỏi thì thôi, thành ghi chú vàng như cũ); nhận xét khác vẫn vàng
    const contradictions = newContradictions(
      cr,
      result.data.findings.filter((f) => f.rule === "contradiction").map((f) => ({ question: humanizeText(f.message), suggestions: [] }))
    )
    if (contradictions.length) {
      await askContradictions(cr, locations, contradictions)
      return
    }
    for (const f of result.data.findings) {
      // Nhận xét gắn vào vị trí sửa cùng section; không khớp section nào thì vị trí sửa đầu tiên (người duyệt vẫn thấy)
      const hit = changed.filter((c) => c.section_id === f.section_id)
      const flag = { rule: f.rule, message: humanizeText(f.message) }
      for (const l of hit.length ? hit : changed.slice(0, 1)) {
        const mine = aiFlags.get(l.location_id) ?? []
        if (!mine.some((x) => x.message === flag.message)) aiFlags.set(l.location_id, [...mine, flag])
      }
    }
  }

  const at = new Date()
  const failing: IChangeLocation[] = []
  for (const l of locations) {
    const vs = violations.get(l.location_id) ?? []
    l.verify = { code_ok: vs.length === 0, violations: vs, ai_flags: aiFlags.get(l.location_id) ?? [], at }
    if (vs.length) failing.push(l)
  }
  let next: "ready_to_submit" | "proposing" | "manual_fix" = "ready_to_submit"
  if (failing.length) {
    next = failing.some((l) => l.manual || l.redo_count >= MAX_REDO_PER_LOCATION) ? "manual_fix" : "proposing"
    if (next === "proposing") for (const l of failing) l.redo_count += 1
  }
  await Promise.all(locations.map((l) => l.save()))
  await transitionCr(cr, next)
  // FLF-337: mức "Chỉ ở mốc chốt" sau baseline — CR qua C-5 (Code + AI không phàn nàn) tự xác nhận, ghi vào bản nháp (C-6 FLF-330).
  // Nguồn + người yêu cầu đã bắt buộc lúc tạo; Lead duyệt gói (C-7) vẫn là cổng cứng. AI có nhận xét ⇒ để BA xem.
  if (next === "ready_to_submit" && spine.project.review_mode === "milestones" && !locations.some((l) => (l.verify?.ai_flags?.length ?? 0) > 0)) {
    await submitCr(cr, userId)
    await recordAutoPass(String(cr.projectId), `C-6:${cr.cr_id}`, "Chỉ ở mốc chốt: change request qua kiểm tự ghi vào bản nháp", `${cr.cr_id} ${cr.title}`)
  }
}
