/**
 * Bước AI của đổi mẫu (D8) — chỉ chạy cho lựa chọn BA đã chọn và đã được báo credit:
 *  - `move_to:<mục có cấu trúc>` của một **mục riêng chữ tự do**: AI đọc chữ của mục, đề xuất op `add` vào mảng Spine của mục đích; op hợp lệ
 *    (chạy khô qua op engine) ⇒ ghi qua đường CR `template_migration` kèm xoá mục riêng cũ; không hợp lệ / rỗng ⇒ giữ thành mục riêng (không mất chữ).
 *  - `ai_resolve` của conflict (bảng đổi cột / mục bị tách / Record of Changes): AI chọn một cách ghép cụ thể; không chọn được ⇒ cách an toàn nhất.
 * Mục khung chuyển vào mục khác chỉ là chuyển chỗ in (dữ liệu đã có cấu trúc trong Spine) ⇒ không gọi AI.
 * Mỗi mục một lượt `executeAiAction(TEMPLATE_MIGRATION_RESOLVE)` (giữ / trừ credit như mọi lượt AI); kết quả lưu trên migration nên áp dụng lại sau lỗi
 * không gọi (không trừ) lần hai. Hết credit / lỗi provider ⇒ ném, chưa ghi gì vào bản nháp.
 */
import { createHash } from "node:crypto"
import { spineSchema } from "../spine/spine.schema.js"
import { ActionType, type AiActionInput, type AiActionResult } from "../../shared/ai/ai-action.types.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import type { TemplateMigrationResolveOutput } from "../../shared/ai/response-parser.js"
import { targetsOf } from "../import/extract-targets.js"
import { schemaExcerptFor } from "../import/extract-targets.js"
import { TransactionRejectedError, planTransaction } from "../spine/op-engine.js"
import type { Op } from "../spine/op.types.js"
import type { Spine } from "../spine/spine.types.js"
import { decidableItems, isFreeTextSection, type ConflictItem, type ExtraItem } from "./classify.js"
import type { ITemplateMigration } from "./template-migration.model.js"

export type ResolveExecutor = (input: AiActionInput, projectId: string, userId: string) => Promise<AiActionResult<TemplateMigrationResolveOutput>>

export const defaultResolveExecutor: ResolveExecutor = (input, projectId, userId) =>
  executeAiAction<TemplateMigrationResolveOutput>(ActionType.TEMPLATE_MIGRATION_RESOLVE, input, projectId, userId)

/** Kết quả đã chốt cho một mục (lưu trên migration). */
export interface ResolvedItem {
  id: string
  /** Lựa chọn gốc của BA lúc gọi AI + dấu của dữ liệu đầu vào (chữ mục / mô tả conflict): chỉ dùng lại kết quả khi cả hai còn khớp. */
  original_choice: string
  source_hash: string
  /** Lựa chọn hiệu lực thay cho lựa chọn AI của BA (`move_to:…` giữ nguyên khi chuyển được; `keep_custom` khi lùi). */
  choice: string
  ops: Op[]
  /** Mục riêng cũ bị xoá khỏi Spine vì chữ của nó đã thành phần tử có cấu trúc. */
  removed_custom_ids: string[]
  notes: string | null
}

export interface ResolveResult {
  items: ResolvedItem[]
  /** Quyết định hiệu lực (lựa chọn AI đã thay bằng kết quả). */
  decisions: { id: string; choice: string }[]
  ops: Op[]
  warnings: string[]
}

const TEXT_MAX = 6000

const fingerprint = (...parts: unknown[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)

/**
 * Op AI đề xuất đi qua cùng chuẩn hoá phần tử với dữ liệu trích từ file: bỏ khoá thừa không thuộc schema phần tử của mảng đích và bỏ `id` (op engine cấp id),
 * để lỗi hình dạng thường gặp không làm cả lô trượt chạy khô. Mảng không có schema phần tử ⇒ giữ nguyên.
 */
export const normalizeAiElement = (array: string, value: Record<string, unknown>): Record<string, unknown> => {
  const element = (spineSchema.shape as Record<string, unknown>)[array] as { element?: { shape?: Record<string, unknown> } } | undefined
  const known = element?.element?.shape ? new Set(Object.keys(element.element.shape)) : null
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "id" && (!known || known.has(k))))
}
const ADD_PATH = /^(\w+)\[\]$/

const blocksText = (spine: Spine, customId: string): string =>
  (spine.custom_sections.find((c) => c.id === customId)?.blocks ?? [])
    .map((b) => (b.kind === "table" ? (b.rows ?? []).map((r) => r.join(" | ")).join("\n") : b.text))
    .filter(Boolean)
    .join("\n")
    .slice(0, TEXT_MAX)

/** Cách ghép an toàn nhất khi AI không chọn được: giữ nguyên chữ / bảng cũ. */
export const safeConflictChoice = (item: Pick<ConflictItem, "kind" | "choices">): string => {
  const concrete = item.choices.filter((c) => c !== "ai_resolve")
  const prefer = item.kind === "table_columns" ? ["map_by_header", "keep_old_table"] : item.kind === "split_section" ? [] : ["keep_custom"]
  return prefer.find((p) => concrete.includes(p)) ?? concrete[0] ?? "keep_custom"
}

/** Op AI đề xuất phải là `add` vào mảng đích đúng của mục, giá trị là object; còn lại bỏ cả lô (không nhận một nửa). */
const validOps = (raw: TemplateMigrationResolveOutput["ops"], allowedArrays: readonly string[]): Op[] | null => {
  const ops: Op[] = []
  for (const o of raw) {
    const array = ADD_PATH.exec(o.path)?.[1]
    if (!array || !allowedArrays.includes(array) || typeof o.value !== "object" || o.value === null || Array.isArray(o.value)) return null
    ops.push({ op: "add", path: o.path, value: normalizeAiElement(array, o.value as Record<string, unknown>), reason: "Chuyển chữ của mục riêng vào mục có cấu trúc khi đổi mẫu" })
  }
  return ops
}

export interface ResolveInput {
  doc: ITemplateMigration
  projectId: string
  userId: string
  /** Spine sau khi đảo (đổi ngược) — nơi các op sẽ được ghi. */
  spine: Spine
  executor?: ResolveExecutor
  /** Gọi sau mỗi mục xong với toàn bộ kết quả đã có — người gọi lưu lại để chạy lại không mất / không trừ credit hai lần. */
  onItem?: (items: ResolvedItem[]) => Promise<void>
}

export const resolveAiChoices = async (input: ResolveInput): Promise<ResolveResult> => {
  const { doc } = input
  const executor = input.executor ?? defaultResolveExecutor
  const decidable = decidableItems(doc.groups)
  const stored = new Map((doc.resolved_items ?? []).map((i) => [i.id, i]))
  const items: ResolvedItem[] = []
  const warnings: string[] = []
  const decisions = doc.decisions.map((d) => ({ id: d.id, choice: d.choice }))
  const oldByKey = new Map(doc.from.headings.map((h) => [h.key, h]))

  for (const d of doc.decisions) {
    const meta = decidable.get(d.id)
    if (!meta?.ai_choices.includes(d.choice)) continue
    const known = stored.get(d.id)
    let resolved: ResolvedItem
    if (meta.group === "extra") {
      const extra = doc.groups.extra.find((e) => e.id === d.id) as ExtraItem
      resolved = await resolveMove(input, executor, extra, d.choice, oldByKey, warnings, known)
    } else {
      const conflict = doc.groups.conflict.find((c) => c.id === d.id) as ConflictItem
      resolved = await resolveConflict(input, executor, conflict, warnings, known)
    }
    if (resolved === known) {
      items.push(resolved)
      continue
    }
    items.push(resolved)
    stored.set(d.id, resolved)
    if (input.onItem) await input.onItem([...stored.values()])
  }
  for (const i of items) {
    const at = decisions.find((x) => x.id === i.id)
    if (at) at.choice = i.choice
  }
  return { items, decisions, ops: items.flatMap((i) => [...i.ops, ...i.removed_custom_ids.map((id): Op => ({ op: "remove", path: `custom_sections[id=${id}]`, reason: "Chữ đã chuyển vào mục có cấu trúc" }))]), warnings }
}

const resolveMove = async (input: ResolveInput, executor: ResolveExecutor, extra: ExtraItem, choice: string, oldByKey: Map<string, { section_id: string; heading_text: string }>, warnings: string[], known?: ResolvedItem): Promise<ResolvedItem> => {
  const { doc } = input
  const spine = input.spine
  const targetKey = choice.slice("move_to:".length)
  const target = doc.to.headings.find((h) => h.key === targetKey)
  const old = oldByKey.get(extra.old_key)
  // Dấu của đầu vào: quyết định gốc + đích + chữ hiện tại của mục (BA đổi quyết định / mục bị sửa ⇒ kết quả cũ không dùng lại)
  const customTexts = [extra.old_key, ...extra.follower_keys].map((k) => oldByKey.get(k)?.section_id).filter((s): s is string => !!s?.startsWith("custom:")).map((s) => blocksText(spine, s.slice("custom:".length)))
  const hash = fingerprint(choice, target?.section_id ?? null, customTexts)
  if (known && known.original_choice === choice && known.source_hash === hash) return known
  const base = { id: extra.id, original_choice: choice, source_hash: hash }
  const keep = (why: string): ResolvedItem => {
    warnings.push(`Mục "${extra.heading_text}": ${why} - giữ thành mục riêng.`)
    return { ...base, choice: "keep_custom", ops: [], removed_custom_ids: [], notes: why }
  }
  // Mục khung đã có dữ liệu có cấu trúc: chuyển chỗ in, không cần AI
  if (!old || !isFreeTextSection(old.section_id) || !target) return { ...base, choice, ops: [], removed_custom_ids: [], notes: null }
  const customIds = [extra.old_key, ...extra.follower_keys].map((k) => oldByKey.get(k)?.section_id).filter((s): s is string => !!s?.startsWith("custom:")).map((s) => s.slice("custom:".length)).filter((id) => spine.custom_sections.some((c) => c.id === id))
  const allowed = targetsOf(target.section_id)
  const text = customIds.map((id) => blocksText(spine, id)).join("\n").trim()
  if (!allowed.length || !text) return { ...base, choice, ops: [], removed_custom_ids: [], notes: null }

  const res = await executor(
    { promptVariables: { kind: "move_structured", heading: extra.heading_text, target: `${target.section_id} → ${allowed.join(", ")}`, text, schema: schemaExcerptFor(allowed), conflict: "n/a" } },
    input.projectId,
    input.userId
  )
  const ops = validOps(res.data.ops, allowed)
  if (!ops?.length) return keep(res.data.notes ?? "AI không chuyển được chữ này vào mục có cấu trúc")
  try {
    // Chạy khô trên Spine hiện tại: op sai hình / phá bất biến ⇒ bỏ lô này, không làm hỏng cả lần đổi mẫu
    planTransaction(spine, { base_version: spine.spine_version, ops, by: "template-migration", step_id: null }, { startSeq: 1 })
  } catch (err) {
    if (err instanceof TransactionRejectedError) return keep("Đề xuất của AI không qua kiểm tra dữ liệu")
    throw err
  }
  return { ...base, choice, ops, removed_custom_ids: customIds, notes: res.data.notes }
}

const resolveConflict = async (input: ResolveInput, executor: ResolveExecutor, conflict: ConflictItem, warnings: string[], known?: ResolvedItem): Promise<ResolvedItem> => {
  const concrete = conflict.choices.filter((c) => c !== "ai_resolve")
  const description = [
    `kind: ${conflict.kind}`,
    conflict.old_columns.length ? `old table columns: ${JSON.stringify(conflict.old_columns)}` : "",
    conflict.new_columns.length ? `new template table columns: ${JSON.stringify(conflict.new_columns)}` : "",
    conflict.candidate_keys.length ? `candidate target sections: ${conflict.candidate_keys.join(", ")}` : "",
    `allowed choices: ${concrete.join(" | ")}`
  ].filter(Boolean).join("\n")
  const hash = fingerprint("ai_resolve", conflict.id, description)
  if (known && known.original_choice === "ai_resolve" && known.source_hash === hash) return known
  const res = await executor(
    { promptVariables: { kind: "conflict", heading: conflict.old_key, target: conflict.new_key ?? "(none)", text: "", schema: "", conflict: description } },
    input.projectId,
    input.userId
  )
  const chosen = res.data.choice && concrete.includes(res.data.choice) ? res.data.choice : null
  if (!chosen) warnings.push(`Mục ${conflict.old_key}: AI không chọn được cách ghép hợp lệ - dùng cách giữ nguyên chữ / bảng cũ.`)
  return { id: conflict.id, original_choice: "ai_resolve", source_hash: hash, choice: chosen ?? safeConflictChoice(conflict), ops: [], removed_custom_ids: [], notes: res.data.notes }
}
