/**
 * Phân nhóm kết quả ghép mục thành 4 nhóm (+ "đã sửa sau lần đổi mẫu" khi đổi ngược) — hàm thuần, không gọi AI.
 *
 *  - `matched`  : mục có cặp, cấu trúc bảng khớp ⇒ chép nguyên khối sang mẫu mới.
 *  - `missing`  : mục của mẫu đích chưa có cặp ⇒ thêm trống + hướng dẫn của mẫu (cờ đỏ chặn phát hành ở bước áp dụng).
 *  - `extra`    : mục của tài liệu hiện tại không có chỗ ở mẫu đích ⇒ BA chọn `keep_custom | move_to:<mục> | delete`.
 *  - `conflict` : có cặp nhưng không đặt thẳng được (bảng đổi cột, mục bị tách, bảng Record of Changes khác / mất) ⇒ BA chọn hoặc `ai_resolve`.
 *  - `edited_since`: chỉ đổi ngược — mục có Change ghi sau lần đổi mẫu, `keep` (mặc định) | `discard`.
 * Mỗi mục thừa / conflict mang một lựa chọn chọn sẵn (`suggested`) luôn miễn phí, kèm lý do (`suggested_reason`) và độ chắc
 * (`confidence`): `high` ⇒ dùng luôn nếu BA không đổi; `guess` (chỉ "chuyển vào" khi đủ 3 điều kiện) ⇒ BA phải xác nhận. Không bao
 * giờ chọn sẵn `ai_resolve` hay lựa chọn cần AI.
 * Phần tử và phần nối không vào nhóm nào: đi theo mục cha (`PairingResult.followers`). Mỗi mục có cặp nằm ở đúng một trong
 * `matched` / `conflict`; mục đã sửa còn nằm thêm ở `edited_since`.
 */
import { isContentSection } from "../import/section-catalog.js"
import { targetsOf } from "../import/extract-targets.js"
import { overlapsOf } from "../import/content-slots.js"
import { recordColumnOfHeader } from "../import/legacy-record.js"
import { UNMAPPED_SECTION } from "../import/import.constants.js"
import { foldText, splitHeadingNumber, titleSimilarity } from "../import/text-similarity.js"
import type { EditedSection } from "./edited-since.js"
import { isFrameworkId, type NewHeading, type OldHeading, type PairBy, type PairingResult } from "./pair-sections.js"

export const RECORD_OF_CHANGES = "fixed:I"

/**
 * Lựa chọn cho mục **khung** (có dữ liệu có cấu trúc trong Spine: use case, bảng, yêu cầu…) mà mẫu đích không có chỗ: chỉ bỏ khỏi bản in, dữ
 * liệu + liên kết trong Spine giữ nguyên (hoàn tác / đổi ngược đưa lại). `delete` (xoá thật) chỉ dành cho mục riêng chữ tự do (`custom:*`).
 */
export const DROP_FROM_PRINT = "drop_from_print"

/** Mục riêng chữ tự do: không có dữ liệu có cấu trúc nên xoá thật được. */
export const isFreeTextSection = (sectionId: string): boolean => sectionId.startsWith("custom:") || sectionId === UNMAPPED_SECTION

/** Bảng của một mục: định danh từng cột (đường dẫn field nếu mapping biết, không thì chữ tiêu đề đã gập). */
export interface TableShape {
  columns: string[]
  /** Chữ tiêu đề từng cột như người đọc thấy (cùng thứ tự `columns`) — để so cột theo tên khi chỉ một phía có field và để hiện cho BA. */
  headers?: string[]
}

export type TableShapes = ReadonlyMap<string, readonly TableShape[]>

/** `high`: chọn sẵn, áp dụng luôn nếu BA không đổi. `guess`: đoán, BA phải xác nhận (gửi đúng `suggested`) hoặc chọn khác. */
export type SuggestConfidence = "high" | "guess"

/** Lý do của lựa chọn chọn sẵn — FE dịch thành câu ngắn. */
export type SuggestReason = "no_place" | "close_name" | "map_columns" | "no_table_in_new" | "keep_history" | "first_heading"

export interface Suggestion {
  suggested: string
  suggested_reason: SuggestReason
  confidence: SuggestConfidence
}

/** Ngưỡng tên gần giống để đoán "chuyển vào" (thang `titleSimilarity`); còn cần cùng nhóm cha + mục đích đang trống. */
export const MOVE_GUESS_SIMILARITY = 0.6

export interface MatchedItem {
  id: string
  old_key: string
  new_key: string
  by: PairBy
  needs_review: boolean
}

export interface MissingItem {
  id: string
  new_key: string
  heading_text: string
  section_id: string
  /** Mục có nội dung (không phải heading nhóm) ⇒ thêm trống + hướng dẫn, cờ đỏ chặn phát hành tới khi BA viết xong. */
  needs_content: boolean
  guidance: string | null
  /** Mục thừa đã chọn "chuyển vào" mục này (`id` của mục thừa) — mục nhận nội dung, không còn là mục phải viết. Chỉ có khi ≥ 1. */
  moved_in?: string[]
}

export interface ExtraItem {
  id: string
  old_key: string
  heading_text: string
  section_id: string
  /** Phần tử / phần nối đi theo mục này (đi cùng quyết định của nó). */
  follower_keys: string[]
  choices: string[]
  /** Lựa chọn cần AI sắp lại dữ liệu có cấu trúc (`move_to` vào mục trích được vào Spine). */
  ai_choices: string[]
  decision_required: true
  /** Lựa chọn chọn sẵn (bản ghi trước khi có gợi ý thì thiếu ⇒ BA phải chọn như cũ). */
  suggested?: string
  suggested_reason?: SuggestReason
  confidence?: SuggestConfidence
}

export type ConflictKind = "table_columns" | "split_section" | "record_of_changes"

export interface ConflictItem {
  id: string
  kind: ConflictKind
  old_key: string
  /** `null` = mẫu đích không có mục tương ứng (Record of Changes mất). */
  new_key: string | null
  /** `split_section`: các heading của mẫu đích mà mục cũ có thể đặt vào. */
  candidate_keys: string[]
  old_columns: string[][]
  new_columns: string[][]
  choices: string[]
  ai_choices: string[]
  decision_required: true
  suggested?: string
  suggested_reason?: SuggestReason
  confidence?: SuggestConfidence
}

export interface EditedItem {
  id: string
  old_key: string
  heading_text: string
  changes: number
  last_at: string
  /** Số ký tự đã sửa — ước tính credit dịch khi giữ. */
  chars: number
  choices: ["keep", "discard"]
  default: "keep"
}

export interface MigrationGroups {
  matched: MatchedItem[]
  missing: MissingItem[]
  extra: ExtraItem[]
  conflict: ConflictItem[]
  edited_since: EditedItem[]
  /** Heading nhóm không có nội dung riêng và không có chỗ ở mẫu đích — bỏ, không cần hỏi. */
  structure_only_dropped: string[]
  /** Đổi ngược: số mục có cặp chưa sửa từ lần đổi mẫu ⇒ tự lấy lại từ snapshot (không hỏi). `null` = đổi xuôi. */
  restored_from_snapshot: number | null
}

export interface ClassifyInput {
  old: readonly OldHeading[]
  neu: readonly NewHeading[]
  pairing: PairingResult
  oldTables?: TableShapes
  newTables?: TableShapes
  /** Đổi ngược: mục đã sửa sau `applied_at`, theo `old_key`. `null` / bỏ trống = đổi xuôi. */
  edited?: readonly EditedSection[] | null
}

const SAME_TABLE_CHOICES = ["map_by_header", "keep_old_table", "ai_resolve"]
const NO_TABLE_CHOICES = ["keep_old_table", "delete", "ai_resolve"]

/** Khoá theo chữ tiêu đề của cột `i` (không có `headers` thì suy từ định danh dạng `h:`); `null` = không biết. */
const headerKeyOf = (t: TableShape, i: number): string | null => {
  const header = t.headers?.[i]
  if (header !== undefined) return `h:${foldText(header)}`
  return t.columns[i].startsWith("h:") ? t.columns[i] : null
}

/**
 * Hai bảng cùng bộ cột (đổi thứ tự cột không tính là đổi). Hai cột là một khi cùng định danh, hoặc cùng chữ tiêu đề: mapping
 * của hai phía có thể chỉ một phía biết field (`use_cases[].id` so với `h:use case id`) mà cột vẫn là cùng một cột.
 */
export const sameColumns = (a: TableShape, b: TableShape): boolean => {
  if (a.columns.length !== b.columns.length) return false
  const free = new Set(b.columns.map((_, j) => j))
  for (let i = 0; i < a.columns.length; i++) {
    const hi = headerKeyOf(a, i)
    const hit = [...free].find((j) => a.columns[i] === b.columns[j] || (hi !== null && hi === headerKeyOf(b, j)))
    if (hit === undefined) return false
    free.delete(hit)
  }
  return true
}

/** Mục phân quyền màn hình: cột vai trò là dữ liệu của dự án (mỗi vai trò một cột), không phải cột của khung. */
const PERMISSION_SECTION = "fixed:3.1.3"
const ROLE_COLUMN = "permissions[].role_id"

/** Bảng ma trận phân quyền: chỉ so cột khung (bỏ cột vai trò); cột thừa của mẫu đích là vai trò ví dụ, không tính. */
const samePermissionColumns = (a: TableShape, b: TableShape): boolean => {
  const frame = (t: TableShape): TableShape => {
    const idx = t.columns.map((_, i) => i).filter((i) => t.columns[i] !== ROLE_COLUMN)
    return { columns: idx.map((i) => t.columns[i]), ...(t.headers ? { headers: idx.map((i) => t.headers![i]) } : {}) }
  }
  const fa = frame(a)
  const fb = frame(b)
  const free = new Set(fb.columns.map((_, j) => j))
  for (let i = 0; i < fa.columns.length; i++) {
    const hi = headerKeyOf(fa, i)
    const hit = [...free].find((j) => fa.columns[i] === fb.columns[j] || (hi !== null && hi === headerKeyOf(fb, j)))
    if (hit === undefined) return false
    free.delete(hit)
  }
  return true
}

/** So bộ cột theo mục: mục phân quyền màn hình bỏ cột vai trò. */
export const sameSectionColumns = (sectionId: string, a: TableShape, b: TableShape): boolean => (sectionId === PERMISSION_SECTION ? samePermissionColumns(a, b) : sameColumns(a, b))

/** Cột của bảng cho người đọc: chữ tiêu đề; bảng lưu từ trước (không có `headers`) thì bỏ tiền tố `h:` của định danh. */
const humanColumns = (t: TableShape): string[] => t.headers ?? t.columns.map((c) => (c.startsWith("h:") ? c.slice(2) : c))

/** Định danh cột: field của mapping nếu có; bảng Record of Changes theo cột lịch sử chuẩn; còn lại chữ tiêu đề. */
export const columnIdentity = (header: string, fieldPath: string | null | undefined, sectionId: string): string => {
  if (fieldPath) return fieldPath
  if (sectionId === RECORD_OF_CHANGES) {
    const col = recordColumnOfHeader(header)
    if (col) return `roc:${col}`
  }
  return `h:${foldText(header)}`
}

export interface TableSource {
  block_id: string
  section_id: string | null
  rows?: readonly (readonly string[])[] | null
}

/** Bảng theo mục (chỉ mục có `section_id`) — `fieldPaths` khoá `<block_id>#<cột>`. */
export const tableShapesBySection = (tables: readonly TableSource[], fieldPaths: ReadonlyMap<string, string | null>): Map<string, TableShape[]> => {
  const out = new Map<string, TableShape[]>()
  for (const t of tables) {
    const header = t.rows?.[0]
    if (!t.section_id || !header?.length) continue
    const shape: TableShape = { columns: header.map((h, c) => columnIdentity(h, fieldPaths.get(`${t.block_id}#${c}`), t.section_id!)), headers: header.map((h) => h.trim()) }
    out.set(t.section_id, [...(out.get(t.section_id) ?? []), shape])
  }
  return out
}

const isStructuredTarget = (sectionId: string): boolean => targetsOf(sectionId).length > 0

const high = (suggested: string, suggested_reason: SuggestReason): Suggestion => ({ suggested, suggested_reason, confidence: "high" })

/** Heading cha gần nhất (theo cấp) của từng heading có chữ; thiếu cấp ⇒ không có cha. */
const parentKeys = (headings: readonly { key: string; heading_text: string; level?: number }[]): Map<string, string | null> => {
  const out = new Map<string, string | null>()
  const stack: { level: number; key: string }[] = []
  for (const h of headings) {
    if (h.level === undefined || !h.heading_text.trim()) continue
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop()
    out.set(h.key, stack[stack.length - 1]?.key ?? null)
    stack.push({ level: h.level, key: h.key })
  }
  return out
}

export const classify = (input: ClassifyInput): MigrationGroups => {
  const oldByKey = new Map(input.old.map((o) => [o.key, o]))
  const newByKey = new Map(input.neu.map((n) => [n.key, n]))
  const { pairing } = input
  const oldTables: TableShapes = input.oldTables ?? new Map<string, TableShape[]>()
  const newTables: TableShapes = input.newTables ?? new Map<string, TableShape[]>()
  const editedByKey = new Map((input.edited ?? []).map((e) => [e.key, e]))
  const splitByOld = new Map(pairing.split.map((s) => [s.old_key, s.new_keys]))

  const claimed = new Set<string>()
  for (const p of pairing.pairs) if (p.new_key) claimed.add(p.new_key)
  for (const s of pairing.split) for (const k of s.new_keys) claimed.add(k)
  for (const k of pairing.children ?? []) claimed.add(k)
  const ignored = new Set(pairing.ignored_new)

  const followersOf = (key: string): string[] => pairing.followers.filter((f) => f.parent_old_key === key).map((f) => f.old_key)
  /**
   * Heading nhóm của mẫu đích ("II. Software Requirement Specification", "Introduction"): heading ngay sau nó sâu hơn ⇒ nội dung nằm
   * ở các mục con, bản thân nó không cần viết (không cờ đỏ, không là đích "chuyển vào"). Thiếu `level` ⇒ không suy được, giữ như cũ.
   */
  const isWrapper = (i: number): boolean => {
    const own = input.neu[i]?.level
    const next = input.neu[i + 1]?.level
    return own !== undefined && next !== undefined && next > own
  }

  const missing: MissingItem[] = input.neu
    .map((n, i) => ({ n, wrapper: isWrapper(i) }))
    .filter(({ n }) => !claimed.has(n.key) && !ignored.has(n.key))
    .map(({ n, wrapper }) => ({
      id: `x:${n.key}`,
      new_key: n.key,
      heading_text: n.heading_text,
      section_id: n.section_id,
      needs_content: !wrapper && (n.section_id === UNMAPPED_SECTION || isContentSection(n.section_id)),
      guidance: n.guidance ?? null
    }))

  // Mục thiếu có nội dung là nơi `move_to` đến được (mục đã có cặp không nhận thêm nội dung lạ)
  const moveTargets = missing.filter((m) => m.needs_content)
  const moveChoices = moveTargets.map((m) => `move_to:${m.new_key}`)
  const aiMoves = moveTargets.filter((m) => isStructuredTarget(m.section_id)).map((m) => `move_to:${m.new_key}`)

  const oldParent = parentKeys(input.old)
  const newParent = parentKeys(input.neu)
  const pairedTo = new Map(pairing.pairs.filter((p) => p.new_key).map((p) => [p.old_key, p.new_key!]))
  /** Mục đích đã được đoán cho một mục thừa khác — mỗi mục đích chỉ nhận một lần đoán. */
  const guessed = new Set<string>()
  /**
   * Đoán "chuyển vào" chỉ khi đủ cả 3: tên gần giống, cùng nhóm cha (heading cha cũ ghép với heading cha mới, hoặc hai mục cùng id /
   * chồng lấn), mục đích đang trống cần nội dung (`moveTargets`). Nhiều mục đích đạt ⇒ tên giống nhất, rồi mục đứng trước.
   */
  const moveGuess = (o: OldHeading): string | null => {
    let best: { choice: string; score: number } | null = null
    for (const m of moveTargets) {
      const choice = `move_to:${m.new_key}`
      if (guessed.has(choice)) continue
      const score = titleSimilarity(splitHeadingNumber(o.heading_text).title, splitHeadingNumber(m.heading_text).title)
      if (score < MOVE_GUESS_SIMILARITY) continue
      const op = oldParent.get(o.key) ?? null
      const np = newParent.get(m.new_key) ?? null
      const sameGroup = (op !== null && np !== null && pairedTo.get(op) === np) || o.section_id === m.section_id || overlapsOf(o.section_id).includes(m.section_id)
      if (!sameGroup) continue
      if (!best || score > best.score) best = { choice, score }
    }
    return best?.choice ?? null
  }

  const matched: MatchedItem[] = []
  const conflict: ConflictItem[] = []
  const extra: ExtraItem[] = []
  const edited_since: EditedItem[] = []
  const structure_only_dropped: string[] = []
  let restored = 0

  for (const p of pairing.pairs) {
    const o = oldByKey.get(p.old_key)
    if (!o) continue
    const nw = p.new_key ? newByKey.get(p.new_key) : undefined

    if (!nw) {
      if (o.section_id === RECORD_OF_CHANGES) {
        conflict.push({ id: `c:record_of_changes:${o.key}`, kind: "record_of_changes", old_key: o.key, new_key: null, candidate_keys: [], old_columns: (oldTables.get(o.section_id) ?? []).map(humanColumns), new_columns: [], choices: ["keep_custom", DROP_FROM_PRINT, "ai_resolve"], ai_choices: ["ai_resolve"], decision_required: true, ...high(DROP_FROM_PRINT, "no_place") })
        continue
      }
      const followers = followersOf(o.key)
      // Heading nhóm không có phần nối / phần tử đi theo ⇒ chỉ là khung, không có gì để mất
      if (o.section_id.startsWith("group:") && !followers.length) {
        structure_only_dropped.push(o.key)
        continue
      }
      // Chỉ mục chữ tự do chuyển vào mục có cấu trúc mới gọi AI (resolve-step); mục khung chuyển chỗ in không gọi AI ⇒ không nhãn "dùng
      // AI", không tính credit (test tay 11/11: ước tính 3 credit, thực tế 0)
      const free = isFreeTextSection(o.section_id)
      const ai_choices = free ? aiMoves : []
      // "Không in ra" an toàn cho cả mục chữ tự do (dữ liệu giữ trong Spine); "xoá" chỉ khi BA tự chọn
      const choices = ["keep_custom", ...(free ? [DROP_FROM_PRINT, "delete"] : [DROP_FROM_PRINT]), ...moveChoices]
      const guess = moveGuess(o)
      // Không bao giờ đoán sẵn một lựa chọn cần AI
      const suggestion: Suggestion = guess && !ai_choices.includes(guess) ? { suggested: guess, suggested_reason: "close_name", confidence: "guess" } : high(DROP_FROM_PRINT, "no_place")
      if (suggestion.confidence === "guess") guessed.add(suggestion.suggested)
      extra.push({ id: `e:${o.key}`, old_key: o.key, heading_text: o.heading_text, section_id: o.section_id, follower_keys: followers, choices, ai_choices, decision_required: true, ...suggestion })
      continue
    }

    const conflicts: ConflictItem[] = []
    if (isFrameworkId(o.section_id) && (o.section_id === nw.section_id || overlapsOf(o.section_id).includes(nw.section_id))) {
      const oldT = oldTables.get(o.section_id) ?? []
      const newT = newTables.get(nw.section_id) ?? []
      if (oldT.some((ot) => !newT.some((nt) => sameSectionColumns(o.section_id, ot, nt)))) {
        const kind: ConflictKind = o.section_id === RECORD_OF_CHANGES ? "record_of_changes" : "table_columns"
        const choices = newT.length ? SAME_TABLE_CHOICES : NO_TABLE_CHOICES
        const suggestion = newT.length ? high("map_by_header", kind === "record_of_changes" ? "keep_history" : "map_columns") : high("keep_old_table", "no_table_in_new")
        conflicts.push({ id: `c:${kind}:${o.key}`, kind, old_key: o.key, new_key: nw.key, candidate_keys: [], old_columns: oldT.map(humanColumns), new_columns: newT.map(humanColumns), choices, ai_choices: ["ai_resolve"], decision_required: true, ...suggestion })
      }
    }
    const split = splitByOld.get(o.key)
    if (split && split.length > 1) {
      conflicts.push({ id: `c:split_section:${o.key}`, kind: "split_section", old_key: o.key, new_key: nw.key, candidate_keys: split, old_columns: [], new_columns: [], choices: [...split.map((k) => `to:${k}`), "ai_resolve"], ai_choices: ["ai_resolve"], decision_required: true, ...high(`to:${split[0]}`, "first_heading") })
    }
    conflict.push(...conflicts)

    const edit = editedByKey.get(o.key)
    if (edit) edited_since.push({ id: `s:${o.key}`, old_key: o.key, heading_text: o.heading_text, changes: edit.changes, last_at: edit.last_at, chars: edit.chars, choices: ["keep", "discard"], default: "keep" })
    else if (input.edited) restored++
    if (!conflicts.length && !edit) matched.push({ id: `m:${o.key}`, old_key: o.key, new_key: nw.key, by: p.by ?? "section_id", needs_review: p.needs_review })
  }

  return { matched, missing, extra, conflict, edited_since, structure_only_dropped, restored_from_snapshot: input.edited ? restored : null }
}

/**
 * Nhóm mục thiếu sau quyết định của BA: mục là đích của `move_to:<new_key>` (đã quyết) nhận nội dung chuyển vào ⇒ không còn "Cần viết"
 * (`needs_content = false`, ghi `moved_in`). `groups` lưu trên migration là kết quả phân nhóm lúc ghép, không đổi theo quyết định ⇒ DTO
 * và bước áp dụng đọc qua hàm này. Truyền quyết định **đã giải** (AI không chuyển được ⇒ `keep_custom`) để mục đó vẫn là mục thiếu.
 */
export const missingAfterMoves = (groups: MigrationGroups, decisions: readonly { id: string; choice: string }[]): MigrationGroups => {
  const movedIn = new Map<string, string[]>()
  for (const d of decisions) {
    if (!d.choice.startsWith("move_to:")) continue
    const key = d.choice.slice("move_to:".length)
    movedIn.set(key, [...(movedIn.get(key) ?? []), d.id])
  }
  if (!movedIn.size) return groups
  return {
    ...groups,
    missing: groups.missing.map((m) => {
      const from = movedIn.get(m.new_key)
      return from ? { ...m, needs_content: false, moved_in: from } : m
    })
  }
}

export interface DecidableItem {
  group: "extra" | "conflict" | "edited_since"
  choices: readonly string[]
  /** Lựa chọn cần AI (tính credit). */
  ai_choices: readonly string[]
  required: boolean
  default: string | null
}

/** Lựa chọn chọn sẵn dùng được ngay: chỉ khi chắc (`high`), còn là lựa chọn hợp lệ và không cần AI. Đoán / bản ghi cũ ⇒ `null`. */
const chosenFor = (item: Pick<ExtraItem, "choices" | "ai_choices" | "suggested" | "confidence">): string | null =>
  item.confidence === "high" && item.suggested && item.suggested !== "ai_resolve" && item.choices.includes(item.suggested) && !item.ai_choices.includes(item.suggested) ? item.suggested : null

/** Mọi mục nhận quyết định, theo id — nguồn kiểm "id có trong nhóm" + "lựa chọn đúng nhóm" ở PATCH decisions. */
export const decidableItems = (groups: MigrationGroups): Map<string, DecidableItem> => {
  const out = new Map<string, DecidableItem>()
  for (const e of groups.extra) out.set(e.id, { group: "extra", choices: e.choices, ai_choices: e.ai_choices, required: true, default: chosenFor(e) })
  for (const c of groups.conflict) out.set(c.id, { group: "conflict", choices: c.choices, ai_choices: c.ai_choices, required: true, default: chosenFor(c) })
  for (const s of groups.edited_since) out.set(s.id, { group: "edited_since", choices: s.choices, ai_choices: [], required: false, default: s.default })
  return out
}

export interface DecisionLike {
  id: string
  choice: string
}

/**
 * Quyết định còn hiệu lực + mục bắt buộc chưa có quyết định **và không có lựa chọn chọn sẵn** (dòng đoán chưa xác nhận, hoặc mục của
 * bản ghi trước khi có gợi ý). Quyết định không còn khớp nhóm mới bị bỏ.
 */
export const settleDecisions = <D extends DecisionLike>(groups: MigrationGroups, decisions: readonly D[]): { decisions: D[]; undecided: string[] } => {
  const items = decidableItems(groups)
  const kept = decisions.filter((d) => items.get(d.id)?.choices.includes(d.choice))
  const decided = new Set(kept.map((d) => d.id))
  return { decisions: kept, undecided: [...items].filter(([id, item]) => item.required && !decided.has(id) && item.default === null).map(([id]) => id) }
}

/**
 * Quyết định đầy đủ để áp dụng: quyết định của BA + lựa chọn chọn sẵn của mục thừa / conflict BA không chạm (mục đã sửa sau lần đổi
 * mẫu giữ mặc định riêng ở bước áp dụng). Gọi lúc `ready` để bước áp dụng chỉ đọc `decisions` như trước.
 */
export const withSuggestedDecisions = <D extends DecisionLike>(groups: MigrationGroups, decisions: readonly D[], make: (id: string, choice: string) => D): D[] => {
  const decided = new Set(decisions.map((d) => d.id))
  const filled = [...decidableItems(groups)].filter(([id, item]) => item.group !== "edited_since" && !decided.has(id) && item.default !== null).map(([id, item]) => make(id, item.default!))
  return [...decisions, ...filled]
}
