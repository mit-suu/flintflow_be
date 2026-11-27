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
import { foldText } from "../import/text-similarity.js"
import type { EditedSection } from "./edited-since.js"
import { isFrameworkId, wrapperKeys, type NewHeading, type OldHeading, type PairBy, type PairingResult } from "./pair-sections.js"
import { confidenceOf, GUESS_SCORE, HIGH_MARGIN, itemTarget, rankTargets, type PlaceScore, type PlaceSource, type PlaceTarget, type PlaceWhy } from "./place-score.js"

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

/**
 * Lý do của lựa chọn chọn sẵn — FE dịch thành câu ngắn. `best_fit`: đúng nghĩa theo tên / hướng dẫn / loại dữ liệu của mục mẫu;
 * `same_data`: mục mẫu đã in đúng phần dữ liệu này từ Spine (gộp vào, không in lần hai); `kept_for_data`: không mục nào hợp nhưng
 * mục có dữ liệu ⇒ giữ thành mục riêng. `no_place` chỉ còn cho mục không có dữ liệu. `close_name` / `first_heading`: bản ghi cũ.
 */
export type SuggestReason = "no_place" | "close_name" | "map_columns" | "no_table_in_new" | "keep_history" | "first_heading" | "best_fit" | "same_data" | "kept_for_data"

export interface Suggestion {
  suggested: string
  suggested_reason: SuggestReason
  confidence: SuggestConfidence
}

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
  /** Mục chưa có cặp nhưng Spine đã có dữ liệu của nó (tầm nhìn, giả định…) ⇒ in từ Spine, không phải "Cần viết". */
  filled_from_spine?: true
}

/** Mục mẫu đích hợp để đặt một mục cũ, xếp theo điểm (`place-score`). */
export interface PlaceTargetHint {
  new_key: string
  score: number
  why: PlaceWhy[]
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
  /** Tối đa `TARGET_HINTS` mục mẫu hợp nhất (bản ghi cũ không có). */
  targets?: PlaceTargetHint[]
  /** Số phần tử Spine / đoạn chữ của mục (bản ghi cũ không có). */
  data_size?: number
}

/**
 * `placement`: mục có cặp theo id nhưng sai nghĩa rõ (mẫu tự nhận "3.4 Tuân thủ" là mục Yêu cầu khác) ⇒ BA chọn giữ cặp
 * (`keep_pair`), gộp vào mục hợp hơn (`move_to:<k>`) hoặc giữ thành mục riêng.
 */
export type ConflictKind = "table_columns" | "split_section" | "record_of_changes" | "placement"

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
  targets?: PlaceTargetHint[]
  data_size?: number
  /**
   * `split_section` có lựa chọn `distribute`: phần tử Spine của mục cũ ⇒ heading đích theo nội dung (vd NFR có "uptime" ⇒ Tính sẵn
   * sàng). Phần tử không phân loại được nằm ở heading đầu (`new_key`).
   */
  item_targets?: { id: string; new_key: string }[]
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
  /** Tóm tắt dữ liệu Spine của từng mục cũ, theo `old_key` (thiếu ⇒ coi như không biết dữ liệu, gợi ý như mục trống). */
  oldData?: ReadonlyMap<string, OldSectionData>
  /** `new_key` của mục mẫu đích mà Spine đã có dữ liệu để in (dù không có cặp). */
  newFilled?: ReadonlySet<string>
  /**
   * Mẫu đích có bảng lịch sử sửa đổi đứng trước heading đầu tiên (không thuộc mục nào) — bảng Record of Changes cũ ghép vào đó theo
   * tên cột thay vì "không có chỗ".
   */
  preHeadingRecord?: boolean
}

export interface OldSectionData {
  size: number
  /** Vài phần tử đầu nối lại, đã cắt ngắn — để chấm nghĩa. */
  sample: string
  /** Phần tử có mã (để chia theo phần tử khi mục bị tách). */
  items?: readonly { id: string | null; text: string }[]
}

/** Số mục mẫu gợi ý kèm theo mỗi mục cũ. */
export const TARGET_HINTS = 3

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
const SCREEN_COLUMN = "permissions[].screen_id"

/**
 * Bảng ma trận phân quyền: chỉ so cột khung (bỏ cột vai trò); cột thừa của mẫu đích là vai trò ví dụ, không tính. Cột vai trò có thể
 * chưa gán field (`h:<tên vai trò>`, mapping chỉ biết chữ tiêu đề) ⇒ cột chưa gán field đứng sau cột màn hình cũng là cột vai trò.
 * Cột màn hình = cột gán `permissions[].screen_id`, không có thì cột đầu (ma trận phân quyền luôn mở đầu bằng màn hình).
 */
const samePermissionColumns = (a: TableShape, b: TableShape): boolean => {
  const frame = (t: TableShape): TableShape => {
    const screen = Math.max(0, t.columns.indexOf(SCREEN_COLUMN))
    const isRole = (i: number): boolean => t.columns[i] === ROLE_COLUMN || (i > screen && t.columns[i].startsWith("h:"))
    const idx = t.columns.map((_, i) => i).filter((i) => !isRole(i))
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

  const newFilled = input.newFilled ?? new Set<string>()
  const missing: MissingItem[] = input.neu
    .map((n, i) => ({ n, wrapper: isWrapper(i) }))
    .filter(({ n }) => !claimed.has(n.key) && !ignored.has(n.key))
    .map(({ n, wrapper }) => {
      const content = !wrapper && (n.section_id === UNMAPPED_SECTION || isContentSection(n.section_id))
      const filled = content && newFilled.has(n.key)
      return { id: `x:${n.key}`, new_key: n.key, heading_text: n.heading_text, section_id: n.section_id, needs_content: content && !filled, guidance: n.guidance ?? null, ...(filled ? { filled_from_spine: true as const } : {}) }
    })

  // Nơi đặt được một mục cũ: mọi mục của mẫu đích (kể cả mục đã có cặp — phần gộp nối sau nội dung đang có — và heading nhóm — thành
  // mục con cuối của nhóm), trừ heading phần tử ví dụ và heading con gộp vào mục cha
  const merged = new Set(pairing.children ?? [])
  const wrappers = wrapperKeys(input.neu)
  const placeable = input.neu.filter((n) => !ignored.has(n.key) && !merged.has(n.key) && n.heading_text.trim())
  const moveChoices = placeable.map((n) => `move_to:${n.key}`)
  const aiMoves = placeable.filter((n) => isStructuredTarget(n.section_id)).map((n) => `move_to:${n.key}`)
  const oldPairedTo = new Map<string, string[]>()
  for (const p of pairing.pairs) if (p.new_key) oldPairedTo.set(p.new_key, [...(oldPairedTo.get(p.new_key) ?? []), p.old_key])
  /** Mục mẫu để chấm cho mục cũ `oldKey` (dữ liệu của mục cũ khác đã ghép vào mục mẫu là một tín hiệu; không tính chính nó). */
  const placeTargets = (oldKey: string, among: readonly NewHeading[] = placeable): PlaceTarget[] =>
    among.map((n) => ({
      key: n.key,
      heading_text: n.heading_text,
      section_id: n.section_id,
      guidance: n.guidance ?? null,
      has_children: wrappers.has(n.key),
      paired_section_ids: (oldPairedTo.get(n.key) ?? []).filter((k) => k !== oldKey).map((k) => oldByKey.get(k)?.section_id ?? "")
    }))
  const sourceOf = (o: OldHeading): PlaceSource => ({ heading_text: o.heading_text, section_id: o.section_id, sample: input.oldData?.get(o.key)?.sample })
  const hints = (ranked: readonly PlaceScore[]): PlaceTargetHint[] => ranked.slice(0, TARGET_HINTS).map((r) => ({ new_key: r.new_key, score: r.score, why: r.why }))
  const dataSize = (o: OldHeading): number => input.oldData?.get(o.key)?.size ?? 0
  /** Lý do khi gợi ý đặt mục cũ vào `target`: mục mẫu đang in đúng phần dữ liệu này từ Spine ⇒ `same_data`. */
  const reasonFor = (o: OldHeading, target: NewHeading): SuggestReason =>
    newFilled.has(target.key) && (o.section_id === target.section_id || overlapsOf(o.section_id).includes(target.section_id) || overlapsOf(target.section_id).includes(o.section_id)) ? "same_data" : "best_fit"

  /**
   * Mục bị tách: gợi ý heading hợp nghĩa nhất trong các heading cùng id (không còn lấy heading đầu). Phần tử Spine của mục phân loại
   * được vào ≥ 2 heading ⇒ thêm lựa chọn `distribute` (chia theo từng phần tử) và gợi ý nó.
   */
  const splitConflict = (o: OldHeading, nw: NewHeading, split: readonly string[]): ConflictItem => {
    const candidates = split.map((k) => newByKey.get(k)).filter((n): n is NewHeading => !!n)
    const targets = placeTargets(o.key, candidates)
    const ranked = rankTargets(sourceOf(o), targets)
    const items = (input.oldData?.get(o.key)?.items ?? []).filter((i): i is { id: string; text: string } => !!i.id)
    const assigned = items.map((i) => ({ id: i.id, new_key: itemTarget(i.text, targets) }))
    const distinct = new Set(assigned.map((a) => a.new_key ?? nw.key))
    const distribute = distinct.size > 1
    const base = { id: `c:split_section:${o.key}`, kind: "split_section" as const, old_key: o.key, new_key: nw.key, candidate_keys: [...split], old_columns: [], new_columns: [], ai_choices: ["ai_resolve"], decision_required: true as const, targets: hints(ranked), data_size: dataSize(o) }
    const choices = [...split.map((k) => `to:${k}`), ...(distribute ? ["distribute"] : []), "ai_resolve"]
    if (distribute) {
      const suggestion: Suggestion = { suggested: "distribute", suggested_reason: "best_fit", confidence: assigned.every((a) => a.new_key) ? "high" : "guess" }
      return { ...base, choices, ...suggestion, item_targets: assigned.map((a) => ({ id: a.id, new_key: a.new_key ?? nw.key })) }
    }
    const best = ranked[0]?.new_key ?? split[0]
    return { ...base, choices, ...(ranked[0] && ranked[0].score >= GUESS_SCORE ? high(`to:${best}`, "best_fit") : high(`to:${split[0]}`, "first_heading")) }
  }

  /**
   * Cặp theo id / chồng lấn mà sai nghĩa rõ: cùng id không được thưởng (khái niệm quá xa) và một mục khác của mẫu hơn hẳn ⇒ conflict
   * `placement` gợi ý mục đó. Cặp do BA ghép tay / ghép theo tên không bị hỏi lại.
   */
  const placementOf = (o: OldHeading, nw: NewHeading, by: PairBy | null): ConflictItem | null => {
    if (by !== "section_id" && by !== "overlap") return null
    const ranked = rankTargets(sourceOf(o), placeTargets(o.key))
    const pairedScore = ranked.find((r) => r.new_key === nw.key)
    const best = ranked[0]
    const target = best ? newByKey.get(best.new_key) : undefined
    if (!best || !pairedScore || !target || best.new_key === nw.key || pairedScore.why.includes("same_section") || !confidenceOf(ranked)) return null
    if (best.score - pairedScore.score < HIGH_MARGIN) return null
    const choices = ["keep_pair", ...moveChoices.filter((c) => c !== `move_to:${nw.key}`), "keep_custom"]
    return { id: `c:placement:${o.key}`, kind: "placement", old_key: o.key, new_key: nw.key, candidate_keys: [], old_columns: [], new_columns: [], choices, ai_choices: [], decision_required: true, suggested: `move_to:${target.key}`, suggested_reason: reasonFor(o, target), confidence: confidenceOf(ranked)!, targets: hints(ranked), data_size: dataSize(o) }
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
        const old_columns = (oldTables.get(o.section_id) ?? []).map(humanColumns)
        // Bảng lịch sử của mẫu đứng trước heading đầu ⇒ ghép dòng cũ vào đó theo tên cột
        const record = input.preHeadingRecord ? (newTables.get(RECORD_OF_CHANGES) ?? []) : []
        if (record.length) conflict.push({ id: `c:record_of_changes:${o.key}`, kind: "record_of_changes", old_key: o.key, new_key: null, candidate_keys: [], old_columns, new_columns: record.map(humanColumns), choices: ["map_by_header", "keep_custom", DROP_FROM_PRINT, "ai_resolve"], ai_choices: ["ai_resolve"], decision_required: true, ...high("map_by_header", "keep_history") })
        else conflict.push({ id: `c:record_of_changes:${o.key}`, kind: "record_of_changes", old_key: o.key, new_key: null, candidate_keys: [], old_columns, new_columns: [], choices: ["keep_custom", DROP_FROM_PRINT, "ai_resolve"], ai_choices: ["ai_resolve"], decision_required: true, ...high(DROP_FROM_PRINT, "no_place") })
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
      // "Không in ra" an toàn cho cả mục chữ tự do (dữ liệu giữ trong Spine). Đổi mẫu không xoá dữ liệu (BF §3.7, FLF-466): không có lựa chọn "xoá" ở nhóm Thừa
      const choices = ["keep_custom", DROP_FROM_PRINT, ...moveChoices]
      const ranked = rankTargets(sourceOf(o), placeTargets(o.key))
      const confidence = confidenceOf(ranked)
      const top = ranked[0] ? newByKey.get(ranked[0].new_key) : undefined
      const size = dataSize(o)
      // Không bao giờ đoán sẵn một lựa chọn cần AI; mục có dữ liệu không bao giờ bị chọn sẵn "Không in ra" với độ tin cao
      const suggestion: Suggestion =
        confidence && top && !ai_choices.includes(`move_to:${top.key}`)
          ? { suggested: `move_to:${top.key}`, suggested_reason: reasonFor(o, top), confidence }
          : size > 0
            ? { suggested: "keep_custom", suggested_reason: "kept_for_data", confidence: "guess" }
            : high(DROP_FROM_PRINT, "no_place")
      extra.push({ id: `e:${o.key}`, old_key: o.key, heading_text: o.heading_text, section_id: o.section_id, follower_keys: followers, choices, ai_choices, decision_required: true, ...suggestion, targets: hints(ranked), data_size: size })
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
    const placement = placementOf(o, nw, p.by)
    const split = splitByOld.get(o.key)
    if (placement) conflicts.push(placement)
    else if (split && split.length > 1) conflicts.push(splitConflict(o, nw, split))
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
/**
 * FLF-466: nhóm Thừa không còn "xoá". Lần đổi mẫu đang mở từ trước còn `delete` trong `choices` / quyết định ⇒ đọc thành `drop_from_print`
 * (chỉ nhóm Thừa; "xoá" của conflict bảng giữ nguyên).
 */
export const LEGACY_DELETE = "delete"
export const extraChoiceOf = (choice: string): string => (choice === LEGACY_DELETE ? DROP_FROM_PRINT : choice)
/** Đọc lựa chọn đã lưu của một mục: nhóm Thừa đổi `delete` thành `drop_from_print`, nhóm khác giữ nguyên. */
export const readChoice = (groups: Pick<MigrationGroups, "extra">, id: string, choice: string): string =>
  groups.extra.some((e) => e.id === id) ? extraChoiceOf(choice) : choice

const extraChoices = (choices: readonly string[]): string[] => [...new Set(choices.map(extraChoiceOf))]

export const decidableItems = (groups: MigrationGroups): Map<string, DecidableItem> => {
  const out = new Map<string, DecidableItem>()
  for (const e of groups.extra) out.set(e.id, { group: "extra", choices: extraChoices(e.choices), ai_choices: e.ai_choices, required: true, default: chosenFor({ ...e, choices: extraChoices(e.choices) }) })
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
/** Bản sao quyết định với lựa chọn khác (quyết định có thể là subdocument mongoose). */
const withChoice = <D extends DecisionLike>(d: D, choice: string): D => ({ ...(typeof (d as { toObject?: () => D }).toObject === "function" ? (d as unknown as { toObject: () => D }).toObject() : d), choice })

export const settleDecisions = <D extends DecisionLike>(groups: MigrationGroups, decisions: readonly D[]): { decisions: D[]; undecided: string[] } => {
  const items = decidableItems(groups)
  const kept = decisions.map((d) => (groups.extra.some((e) => e.id === d.id) && d.choice === LEGACY_DELETE ? withChoice(d, DROP_FROM_PRINT) : d)).filter((d) => items.get(d.id)?.choices.includes(d.choice))
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
