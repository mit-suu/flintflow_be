/**
 * srs-text-fields.ts
 * ─────────────────────────────────────────────────────────────────
 * Field chữ tự nhiên render vào SRS, theo từng collection của Spine — MỘT danh sách dùng chung cho:
 * - luật vàng `non_english_content` (`deterministic-check.ts` `ownedTexts`): Spine mode 2 phải tiếng Anh;
 * - đơn vị dịch của lớp bản dịch (`translation/translation-units.ts`, FLF-265 D5).
 * Hai bên đọc cùng danh sách để khỏi lệch: field nào bị bắt "phải tiếng Anh" thì cũng là field được dịch sang
 * ngôn ngữ tài liệu. Không có id, mã, số, enum (`kind`, `priority`, `category`), `relation_verbs`, `*_vi`, `addendum`.
 */

/** Field chữ của từng phần tử collection (thứ tự giữ đúng thứ tự `ownedTexts` đọc trước đây — thứ tự trong câu cờ). */
export const SRS_TEXT_FIELDS = {
  actors: ["name", "description"],
  roles: ["name"],
  use_cases: ["name", "description"],
  features: ["name"],
  screens: ["name", "description", "tabs"],
  functions: ["name", "trigger", "description", "normal", "abnormal"],
  entities: ["name", "description"],
  nfrs: ["statement", "metric", "threshold"],
  business_rules: ["statement"],
  common_requirements: ["statement"],
  messages: ["text"],
  other_requirements: ["statement"],
  glossary: ["term", "definition"]
} as const

export type SrsTextGroup = keyof typeof SRS_TEXT_FIELDS

export const SRS_TEXT_GROUPS = Object.keys(SRS_TEXT_FIELDS) as SrsTextGroup[]

/** `functions[].validations[]` — chữ lồng theo id của validation. */
export const VALIDATION_TEXT_FIELDS = ["statement"] as const

/**
 * Field chữ của `project`. `release_scope` là object `{ in[], out[] }` — luật quét cả object, lớp bản dịch tách
 * thành hai đơn vị `release_scope.in` / `release_scope.out`. `name` / `system_name` không thuộc danh sách: tên
 * user đặt và tên hệ thống tiếng Anh không dịch (luật vẫn quét riêng hai field đó).
 */
export const PROJECT_TEXT_FIELDS = ["vision", "goals", "release_scope"] as const

/** Lấy đúng các field trong danh sách (giữ thứ tự) — field vắng mặt vẫn có key, giá trị `undefined`. */
export const pickTextFields = <T extends object>(item: T, fields: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(fields.map((field) => [field, (item as Record<string, unknown>)[field]]))
