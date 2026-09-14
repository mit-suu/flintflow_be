/**
 * prompt-assets.ts
 * ─────────────────────────────────────────────────────────────────
 * Đọc prompt asset từ ĐĨA — nguồn sự thật duy nhất theo
 * Product-Brief-to-SRS-Phases.md §8 ("Nguồn sự thật: repo", không DB override).
 *
 * Hai loại asset:
 *   - Skill (`assets/skills/<kind>/<skill_id>/SKILL.md` + `references/*.md`):
 *     khung BMAD cho pipeline B-0 → S-9. Index theo `skill_id`, có
 *     `asset_version` = sha256(SKILL.md + references) để ghi vào
 *     `sections[].asset_version`.
 *   - Prompt phẳng (`assets/prompts/*.md`): chỉ còn cho action ngoài pipeline
 *     (`chat`, `summarize_document`) và action legacy chờ T21 gỡ.
 *
 * Module này là nơi DUY NHẤT parse frontmatter của asset. `seed-from-md.ts`,
 * `prompt-registry.service.ts` và admin controller đều gọi vào đây.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import matter from "gray-matter"
import { getAssetsRoot, getPromptsDir } from "../../config/paths.js"

// ─── Prompt phẳng (assets/prompts) ───────────────────────────────

export interface PromptAsset {
  /** Đường dẫn tương đối so với assets/prompts, dùng cho log. */
  file: string
  actionType: string
  provider: string
  aiModel: string
  maxTokens: number
  temperature: number
  isActive: boolean
  description?: string
  template: string
}

/** Field frontmatter bắt buộc. Thiếu một cái là lỗi lúc load, không phải lúc gọi model. */
const REQUIRED_FIELDS = ["actionType", "provider", "aiModel", "maxTokens", "temperature"] as const

/**
 * Thư mục loader KHÔNG quét:
 *   - _archive: prompt của action type đã ngừng dùng (vd pipeline Excalidraw
 *     diagram_*). Giữ trên đĩa để tra cứu, không nạp — nạp vào thì thành asset
 *     mồ côi và test sẽ đỏ.
 */
const IGNORED_DIRS = new Set(["node_modules", "_archive"])

/** Liệt kê mọi file .md dưới `dir`, đệ quy thư mục con. */
const listMarkdownFiles = (dir: string, relBase = ""): string[] => {
  const out: string[] = []

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase ? path.join(relBase, entry.name) : entry.name

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      out.push(...listMarkdownFiles(path.join(dir, entry.name), rel))
      continue
    }

    if (!entry.name.endsWith(".md")) continue
    if (entry.name === "README.md") continue
    out.push(rel)
  }

  return out
}

const parseAsset = (promptsDir: string, file: string): PromptAsset => {
  const raw = fs.readFileSync(path.join(promptsDir, file), "utf-8")
  const { data, content } = matter(raw)

  const missing = REQUIRED_FIELDS.filter((f) => data[f] === undefined || data[f] === null)
  if (missing.length > 0) {
    throw new Error(`[${file}] Thiếu field frontmatter bắt buộc: ${missing.join(", ")}`)
  }

  const template = content.trim()
  if (!template) {
    throw new Error(`[${file}] Nội dung prompt (template) không được để trống.`)
  }

  return {
    file,
    actionType: String(data.actionType),
    provider: String(data.provider),
    aiModel: String(data.aiModel),
    maxTokens: Number(data.maxTokens),
    temperature: Number(data.temperature),
    isActive: data.isActive !== false,
    description: data.description ? String(data.description) : undefined,
    template
  }
}

/** Đọc lại toàn bộ prompt phẳng từ đĩa. Không cache — dùng cho seeder và cho test. */
export const listPromptAssets = (): PromptAsset[] => {
  const promptsDir = getPromptsDir()

  if (!fs.existsSync(promptsDir)) {
    throw new Error(`Không tìm thấy thư mục prompts: ${promptsDir}`)
  }

  const files = listMarkdownFiles(promptsDir)
  if (files.length === 0) {
    throw new Error(`Không có file .md nào trong ${promptsDir}`)
  }

  return files.map((f) => parseAsset(promptsDir, f))
}

/**
 * Index actionType → asset, có cache.
 * actionType trùng nhau là lỗi cấu hình ⇒ nổ lúc load, vì nếu để im thì
 * file nào thắng phụ thuộc thứ tự đọc thư mục — không xác định.
 */
let cachedIndex: Map<string, PromptAsset> | null = null

export const getPromptAssetIndex = (): Map<string, PromptAsset> => {
  if (cachedIndex) return cachedIndex

  const index = new Map<string, PromptAsset>()

  for (const asset of listPromptAssets()) {
    const existing = index.get(asset.actionType)
    if (existing) {
      throw new Error(
        `actionType trùng lặp: "${asset.actionType}" xuất hiện ở cả "${existing.file}" và "${asset.file}"`
      )
    }
    index.set(asset.actionType, asset)
  }

  cachedIndex = index
  return index
}

export const invalidatePromptAssetCache = (): void => {
  cachedIndex = null
}

// ─── Skill (assets/skills) ───────────────────────────────────────

export const SKILL_KINDS = ["action", "content", "renderer", "output"] as const
export type SkillKind = (typeof SKILL_KINDS)[number]

/** Tên schema hợp lệ cho `output_schema`. Tên ứng với schema trong response-parser.ts. */
export const OUTPUT_SCHEMA_NAMES = [
  "opTransaction",
  "elicit",
  "discoveryStep",
  "review",
  "changeInstruction",
  "renderFix",
  "puml",
  "none"
] as const
export type OutputSchemaName = (typeof OUTPUT_SCHEMA_NAMES)[number]

export const SKILL_LANGUAGES = ["en", "user"] as const
export type SkillLanguage = (typeof SKILL_LANGUAGES)[number]

export interface SkillAsset {
  skillId: string
  kind: SkillKind
  version: string
  provider: string
  aiModel: string
  maxTokens: number
  temperature: number
  reads: string[]
  writes: string[]
  outputSchema: OutputSchemaName[]
  language: SkillLanguage
  description?: string
  /** Stub chờ task sau điền nội dung (T10/T14/T15/T18/T19/T20). */
  stub: boolean
  /** Thư mục skill, tương đối so với assets/skills (vd `action/draft-to-ops`). */
  dir: string
  /** Thân SKILL.md (không gồm frontmatter), luôn nạp. */
  template: string
  /** Tên file trong references/ (không đuôi .md), sắp xếp. Nội dung nạp theo yêu cầu. */
  referenceNames: string[]
  /** sha256 hex của SKILL.md + references, xuống dòng chuẩn hoá LF. */
  assetVersion: string
}

const SKILL_FILE = "SKILL.md"
const REFERENCES_DIR = "references"
const SKILL_REQUIRED_FIELDS = [
  "skill_id",
  "kind",
  "version",
  "provider",
  "aiModel",
  "maxTokens",
  "temperature",
  "reads",
  "writes",
  "output_schema",
  "language"
] as const

export const getSkillsDir = (): string => path.join(getAssetsRoot(), "skills")

/** CRLF → LF để checkout Windows và Linux ra cùng asset_version. */
const readNormalized = (file: string): string =>
  fs.readFileSync(file, "utf-8").replace(/\r\n/g, "\n")

const toStringArray = (value: unknown, field: string, where: string): string[] => {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`[${where}] Field '${field}' phải là mảng chuỗi.`)
  }
  return value as string[]
}

const listReferenceNames = (skillDir: string): string[] => {
  const refDir = path.join(skillDir, REFERENCES_DIR)
  if (!fs.existsSync(refDir)) return []

  return fs
    .readdirSync(refDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name.slice(0, -".md".length))
    .sort()
}

export const computeSkillAssetVersion = (skillDir: string, referenceNames: string[]): string => {
  const hash = crypto.createHash("sha256")
  hash.update(`${SKILL_FILE}\n`)
  hash.update(readNormalized(path.join(skillDir, SKILL_FILE)))

  for (const name of referenceNames) {
    hash.update(`\0${REFERENCES_DIR}/${name}.md\n`)
    hash.update(readNormalized(path.join(skillDir, REFERENCES_DIR, `${name}.md`)))
  }

  return hash.digest("hex")
}

const parseSkill = (skillsDir: string, kind: SkillKind, dirName: string): SkillAsset => {
  const rel = `${kind}/${dirName}`
  const skillDir = path.join(skillsDir, kind, dirName)
  const { data, content } = matter(readNormalized(path.join(skillDir, SKILL_FILE)))

  const missing = SKILL_REQUIRED_FIELDS.filter((f) => data[f] === undefined || data[f] === null)
  if (missing.length > 0) {
    throw new Error(`[${rel}] Thiếu field frontmatter bắt buộc: ${missing.join(", ")}`)
  }

  const skillId = String(data.skill_id)
  if (skillId !== dirName) {
    throw new Error(`[${rel}] skill_id "${skillId}" phải trùng tên thư mục "${dirName}".`)
  }
  if (data.kind !== kind) {
    throw new Error(`[${rel}] kind "${data.kind}" phải trùng thư mục cha "${kind}".`)
  }
  if (!SKILL_LANGUAGES.includes(data.language)) {
    throw new Error(`[${rel}] language phải thuộc: ${SKILL_LANGUAGES.join(", ")}`)
  }

  const outputSchema = Array.isArray(data.output_schema)
    ? toStringArray(data.output_schema, "output_schema", rel)
    : [String(data.output_schema)]
  const invalidSchema = outputSchema.filter(
    (s) => !(OUTPUT_SCHEMA_NAMES as readonly string[]).includes(s)
  )
  if (invalidSchema.length > 0) {
    throw new Error(
      `[${rel}] output_schema không hợp lệ: ${invalidSchema.join(", ")} ` +
        `(hợp lệ: ${OUTPUT_SCHEMA_NAMES.join(", ")})`
    )
  }

  const maxTokens = Number(data.maxTokens)
  const temperature = Number(data.temperature)
  if (!(maxTokens > 0) || !Number.isFinite(temperature)) {
    throw new Error(`[${rel}] maxTokens phải > 0 và temperature phải là số.`)
  }

  const template = content.trim()
  if (!template) {
    throw new Error(`[${rel}] Thân SKILL.md không được để trống.`)
  }

  const referenceNames = listReferenceNames(skillDir)

  return {
    skillId,
    kind,
    version: String(data.version),
    provider: String(data.provider),
    aiModel: String(data.aiModel),
    maxTokens,
    temperature,
    reads: toStringArray(data.reads, "reads", rel),
    writes: toStringArray(data.writes, "writes", rel),
    outputSchema: outputSchema as OutputSchemaName[],
    language: data.language as SkillLanguage,
    description: data.description ? String(data.description) : undefined,
    stub: data.stub === true,
    dir: rel,
    template,
    referenceNames,
    assetVersion: computeSkillAssetVersion(skillDir, referenceNames)
  }
}

/** Đọc lại toàn bộ skill từ đĩa. Không cache — dùng cho test và admin. */
export const listSkillAssets = (): SkillAsset[] => {
  const skillsDir = getSkillsDir()

  if (!fs.existsSync(skillsDir)) {
    throw new Error(`Không tìm thấy thư mục skills: ${skillsDir}`)
  }

  const skills: SkillAsset[] = []

  for (const kind of SKILL_KINDS) {
    const kindDir = path.join(skillsDir, kind)
    if (!fs.existsSync(kindDir)) continue

    for (const entry of fs.readdirSync(kindDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue
      if (!fs.existsSync(path.join(kindDir, entry.name, SKILL_FILE))) {
        throw new Error(`[${kind}/${entry.name}] Thiếu ${SKILL_FILE}.`)
      }
      skills.push(parseSkill(skillsDir, kind, entry.name))
    }
  }

  if (skills.length === 0) {
    throw new Error(`Không có skill nào trong ${skillsDir}`)
  }

  return skills
}

let cachedSkillIndex: Map<string, SkillAsset> | null = null

/** Index skill_id → skill, có cache. skill_id trùng (khác kind) nổ lúc load. */
export const getSkillIndex = (): Map<string, SkillAsset> => {
  if (cachedSkillIndex) return cachedSkillIndex

  const index = new Map<string, SkillAsset>()

  for (const skill of listSkillAssets()) {
    const existing = index.get(skill.skillId)
    if (existing) {
      throw new Error(
        `skill_id trùng lặp: "${skill.skillId}" xuất hiện ở cả "${existing.dir}" và "${skill.dir}"`
      )
    }
    index.set(skill.skillId, skill)
  }

  cachedSkillIndex = index
  return index
}

/** Nạp nội dung một file references/<name>.md của skill (nạp có điều kiện, Phases §8). */
export const loadSkillReference = (skillId: string, name: string): string => {
  const skill = getSkillIndex().get(skillId)
  if (!skill) {
    throw new Error(`Không tìm thấy skill '${skillId}'.`)
  }
  if (!skill.referenceNames.includes(name)) {
    throw new Error(
      `Skill '${skillId}' không có reference '${name}' ` +
        `(có: ${skill.referenceNames.join(", ") || "không có"}).`
    )
  }

  return readNormalized(path.join(getSkillsDir(), skill.dir, REFERENCES_DIR, `${name}.md`)).trim()
}

export const invalidateSkillCache = (): void => {
  cachedSkillIndex = null
}
