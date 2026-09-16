/**
 * T21 — Chuyển project cũ (Section markdown) sang Spine, best-effort.
 *
 * Cách dùng:
 *   npm run migrate:sections -- --dry-run                 # chỉ đọc, không ghi DB
 *   npm run migrate:sections -- --project <projectId>     # một project
 *   npm run migrate:sections -- --report docs/migration-report.md
 *
 * Nguyên tắc:
 * - Đọc collection `sections` bằng driver thô — model Mongoose cũ đã xoá cùng module specification.
 *   Script KHÔNG sửa/xoá dữ liệu cũ; dọn collection cũ là việc thủ công sau khi đối chiếu báo cáo.
 * - Ghi Spine duy nhất qua `applyTransaction` với một op hệ thống `migrate` (path `$`) ⇒ đúng một
 *   `changes[]` `{op: "migrate", reason: "legacy import"}`, `before` là Spine rỗng — revert được.
 * - Chỉ migrate Spine chưa từng ghi (`spine_version === 1`). Chạy lại là idempotent: project đã
 *   migrate hoặc đã chạy pipeline bị bỏ qua.
 * - Addendum là đích an toàn: MỌI section có nội dung đều thành addendum; thêm vào đó `vision`, `goals[]`
 *   và bảng use case parse được thành cấu trúc.
 *   `progress` giữ B-0.1, `steps[]` rỗng — Intake của B-0 sẽ thấy Spine có addendum.
 * - Lịch sử phiên bản section cũ không migrate.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Actor, Addendum, Spine, SpineRecord, UseCase } from "../modules/spine/spine.types.js"
import type { Transaction } from "../modules/spine/op.types.js"
import { planTransaction } from "../modules/spine/op-engine.js"

export const MIGRATION_REASON = "legacy import"
export const MIGRATION_ACTOR = "system"

/** Một document của collection `sections` cũ — chỉ những field script đọc. */
export interface LegacySection {
  type: string
  content: unknown
  status?: string
  updatedAt?: Date | string | null
}

interface SectionTarget {
  target_section: string
  topic: string
}

/**
 * Loại section cũ → section FPT nhận addendum. Thứ tự khoá là thứ tự migrate (ổn định cho id AD##).
 * Loại lạ (không có ở đây) vẫn giữ lại dưới `fixed:5.4`.
 */
export const LEGACY_SECTION_TARGETS: Readonly<Record<string, SectionTarget>> = {
  vision_problem: { target_section: "fixed:1", topic: "Vision and problem" },
  business_goals: { target_section: "fixed:1", topic: "Business goals" },
  value_proposition: { target_section: "fixed:1", topic: "Value proposition" },
  high_level_business_rules: { target_section: "fixed:1", topic: "High-level business rules" },
  scope_out_of_scope: { target_section: "fixed:1", topic: "Release scope (in / out)" },
  stakeholders: { target_section: "fixed:2.1", topic: "Stakeholders" },
  user_journey: { target_section: "fixed:2.1", topic: "User journey" },
  use_case_spec: { target_section: "fixed:2.2.2", topic: "Use case specification" },
  screen_flow: { target_section: "fixed:3.1.1", topic: "Screen flow" },
  screen_description: { target_section: "fixed:3.1.2", topic: "Screen descriptions" },
  functional_requirements: { target_section: "fixed:3.1.2", topic: "Functional requirements" },
  user_story: { target_section: "fixed:3.1.2", topic: "User stories" },
  acceptance_criteria: { target_section: "fixed:3.1.2", topic: "Acceptance criteria" },
  priority_ranking: { target_section: "fixed:3.1.2", topic: "Priority ranking (MoSCoW)" },
  rbac: { target_section: "fixed:3.1.3", topic: "Role-based access control" },
  non_screen_functions: { target_section: "fixed:3.1.4", topic: "Non-screen functions" },
  erd: { target_section: "fixed:3.1.5", topic: "Entity relationship model" },
  external_interfaces: { target_section: "fixed:4.1", topic: "External interfaces" },
  non_functional_requirements: { target_section: "fixed:4.2.4", topic: "Non-functional requirements" },
  common_business_rules: { target_section: "fixed:5.1", topic: "Common business rules" },
  common_requirements: { target_section: "fixed:5.2", topic: "Common requirements" },
  application_messages: { target_section: "fixed:5.3", topic: "Application messages" },
  assumptions_risks: { target_section: "fixed:5.4", topic: "Assumptions and risks" },
  success_metrics: { target_section: "fixed:5.4", topic: "Success metrics" },
  glossary: { target_section: "fixed:5.5", topic: "Glossary" }
}

const UNKNOWN_TARGET = "fixed:5.4"

// ─── chuyển nội dung ────────────────────────────────────────────

/** Nội dung Section là Mixed: chuỗi markdown, `{content}` hoặc JSON bất kỳ. */
export const contentToText = (content: unknown): string => {
  if (typeof content === "string") return content.trim()
  if (content === null || content === undefined) return ""
  if (typeof content === "object" && "content" in content && typeof content.content === "string") {
    return content.content.trim()
  }
  return JSON.stringify(content, null, 2)
}

const stripInlineMarkdown = (text: string): string =>
  text
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim()

/** Dòng bullet (`-`, `*`, `+`, `•`, `1.`). Không có bullet ⇒ rỗng (không đoán). */
export const extractBullets = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:[-*+•]|\d+[.)])\s+(.+)$/)?.[1])
    .filter((item): item is string => item !== undefined)
    .map(stripInlineMarkdown)
    .filter((item) => item.length > 0)

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => stripInlineMarkdown(cell.replace(/<br\s*\/?>/gi, ", ")))

const isSeparatorRow = (cells: string[]): boolean => cells.every((cell) => /^:?-{2,}:?$/.test(cell))

export interface MarkdownTable {
  header: string[]
  rows: string[][]
}

/**
 * Mọi bảng markdown trong văn bản. Dòng phân cách `|---|` là tuỳ chọn: nội dung cũ do model sinh có bảng
 * thiếu dòng này (đo trên dữ liệu dev 2026-09-16).
 */
export const parseMarkdownTables = (text: string): MarkdownTable[] => {
  const tables: MarkdownTable[] = []
  let current: string[][] = []
  const flush = () => {
    const [header, ...rest] = current
    const rows = rest.filter((cells) => !isSeparatorRow(cells))
    if (header && rows.length > 0) tables.push({ header, rows })
    current = []
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("|")) current.push(splitRow(line))
    else flush()
  }
  flush()
  return tables
}

const findColumn = (header: string[], pattern: RegExp): number => header.findIndex((cell) => pattern.test(cell))

/** Mục tiêu kinh doanh: dòng có mã `BG-xx` (bảng hoặc heading), nếu không có thì dòng bullet. */
export const extractGoals = (text: string): string[] => {
  const goals: string[] = []
  for (const table of parseMarkdownTables(text)) {
    const idCol = findColumn(table.header, /^(mã|id|#)$/i)
    const goalCol = findColumn(table.header, /mục tiêu|goal/i)
    if (idCol === -1 || goalCol === -1) continue
    for (const row of table.rows) if (/^BG-?\d+$/i.test(row[idCol] ?? "") && row[goalCol]) goals.push(row[goalCol])
  }
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^#{2,6}\s+BG-?\d+\s*[—–:-]\s*(.+)$/i)?.[1]
    if (heading) goals.push(stripInlineMarkdown(heading))
  }
  return goals.length > 0 ? [...new Set(goals)] : extractBullets(text)
}

export interface ParsedUseCaseRow {
  id: string | null
  name: string
  actorNames: string[]
  description: string
}

/** Ô actor kiểu "- (include từ UC-03)" không phải tên actor. */
const isActorName = (name: string): boolean => /^[\p{L}\p{N}]/u.test(name) && !/\b(include|extend)\b|UC-?\d+/i.test(name)

/**
 * Các bảng markdown có cột tên use case và cột actor ⇒ các dòng use case (trùng tên giữ dòng đầu — nội dung
 * cũ hay có bảng nháp lặp lại). Không có bảng như vậy ⇒ `null`, caller để nguyên nội dung vào addendum.
 */
export const parseUseCaseTable = (text: string): ParsedUseCaseRow[] | null => {
  const rows: ParsedUseCaseRow[] = []
  const seen = new Set<string>()
  for (const table of parseMarkdownTables(text)) {
    const nameCol = findColumn(table.header, /use ?case(?! ?id)|^name$|^tên|chức năng/i)
    const actorCol = findColumn(table.header, /actor|tác nhân/i)
    if (nameCol === -1 || actorCol === -1) continue
    const idCol = findColumn(table.header, /^(uc ?)?id$|^mã|^uc$|^#$/i)
    const descCol = findColumn(table.header, /desc|mô tả/i)

    for (const cells of table.rows) {
      const name = cells[nameCol] ?? ""
      if (!name || seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())
      rows.push({
        id: idCol === -1 ? null : cells[idCol] || null,
        name,
        actorNames: (cells[actorCol] ?? "")
          .split(/[,;/]/)
          .map((a) => a.trim())
          .filter(isActorName),
        description: descCol === -1 ? "" : cells[descCol] ?? ""
      })
    }
  }
  return rows.length > 0 ? rows : null
}

// ─── dựng Spine ─────────────────────────────────────────────────

const nextId = (prefix: string, width: number, existing: readonly { id: string }[]) => {
  const pattern = new RegExp(`^${prefix}(\\d+)$`)
  let max = existing.reduce((m, item) => Math.max(m, Number(item.id.match(pattern)?.[1] ?? 0)), 0)
  return (): string => `${prefix}${String(++max).padStart(width, "0")}`
}

const toIso = (value: Date | string | null | undefined, fallback: Date): string => {
  const date = value ? new Date(value) : fallback
  return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString()
}

export interface MigrationSummary {
  sections: number
  addendum: number
  vision: boolean
  goals: number
  actors: number
  use_cases: number
  /** `use_case_spec` có bảng parse được thành `use_cases[]`. */
  use_case_table_parsed: boolean
  /** Loại section không có trong bảng ánh xạ — vẫn giữ dưới `fixed:5.4`. */
  unknown_types: string[]
  empty_types: string[]
}

export interface MigrationResult {
  spine: Spine
  summary: MigrationSummary
}

const typeOrder = (type: string): number => {
  const index = Object.keys(LEGACY_SECTION_TARGETS).indexOf(type)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

/** Hàm thuần: Spine hiện có + các section cũ ⇒ Spine sau migrate. Không đổi `spine_version`. */
export const buildMigratedSpine = (base: Spine, sections: readonly LegacySection[], now: Date = new Date()): MigrationResult => {
  const spine: Spine = structuredClone(base)
  const summary: MigrationSummary = {
    sections: sections.length,
    addendum: 0,
    vision: false,
    goals: 0,
    actors: 0,
    use_cases: 0,
    use_case_table_parsed: false,
    unknown_types: [],
    empty_types: []
  }

  const newAddendumId = nextId("AD", 2, spine.addendum)
  const newActorId = nextId("A", 2, spine.actors)
  const newUseCaseId = nextId("UC", 2, spine.use_cases)

  const addAddendum = (section: LegacySection, text: string, target: SectionTarget) => {
    const item: Addendum = {
      id: newAddendumId(),
      topic: target.topic,
      content: text,
      // Nội dung cũ có thể là tiếng Việt; B-2.2 Addendum Triage dịch/chỉnh khi đi lại pipeline
      content_en: text,
      target_section: target.target_section,
      captured_at: toIso(section.updatedAt, now)
    }
    spine.addendum.push(item)
    summary.addendum++
  }

  const actorIdByName = new Map(spine.actors.map((a) => [a.name.toLowerCase(), a.id]))
  const actorIdFor = (name: string): string => {
    const key = name.toLowerCase()
    const existing = actorIdByName.get(key)
    if (existing) return existing
    const actor: Actor = { id: newActorId(), name, kind: "human", description: "" }
    spine.actors.push(actor)
    actorIdByName.set(key, actor.id)
    summary.actors++
    return actor.id
  }

  const sorted = [...sections].sort((a, b) => typeOrder(a.type) - typeOrder(b.type))
  for (const section of sorted) {
    const text = contentToText(section.content)
    if (!text) {
      summary.empty_types.push(section.type)
      continue
    }

    const known = LEGACY_SECTION_TARGETS[section.type]
    if (!known) summary.unknown_types.push(section.type)
    const target = known ?? { target_section: UNKNOWN_TARGET, topic: `Legacy section: ${section.type}` }

    if (section.type === "vision_problem" && spine.project.vision === null) {
      spine.project.vision = text
      summary.vision = true
    }
    if (section.type === "value_proposition" && spine.project.vision === null) {
      spine.project.vision = text
      summary.vision = true
    }
    if (section.type === "business_goals" && spine.project.goals.length === 0) {
      spine.project.goals = extractGoals(text)
      summary.goals = spine.project.goals.length
    }

    if (section.type === "use_case_spec") {
      const rows = parseUseCaseTable(text)
      if (rows) {
        const names = new Set(spine.use_cases.map((uc) => uc.name.toLowerCase()))
        for (const row of rows) {
          if (names.has(row.name.toLowerCase())) continue
          names.add(row.name.toLowerCase())
          const useCase: UseCase = {
            id: newUseCaseId(),
            name: row.name,
            actor_ids: [...new Set(row.actorNames.map(actorIdFor))],
            function_ids: [],
            description: row.description,
            includes: [],
            extends: []
          }
          spine.use_cases.push(useCase)
          summary.use_cases++
        }
        // Không `continue`: bảng chỉ mang id/tên/actor — luồng, tiền/hậu điều kiện vẫn nằm trong văn bản gốc
        summary.use_case_table_parsed = true
      }
    }

    addAddendum(section, text, target)
  }

  return { spine, summary }
}

// ─── điều kiện + transaction ────────────────────────────────────

export type SkipReason = "spine_already_written" | "no_sections"

/** Chỉ Spine chưa từng ghi mới migrate — tránh đè dữ liệu pipeline hoặc migrate hai lần. */
export const skipReasonOf = (spine: Spine, sections: readonly LegacySection[]): SkipReason | null => {
  if (sections.length === 0) return "no_sections"
  if (spine.spine_version !== 1) return "spine_already_written"
  return null
}

export const buildMigrationTransaction = (base: Spine, migrated: Spine): Transaction => ({
  base_version: base.spine_version,
  ops: [{ op: "migrate", path: "$", value: { ...migrated, spine_version: base.spine_version }, reason: MIGRATION_REASON }],
  by: MIGRATION_ACTOR,
  step_id: null
})

// ─── báo cáo ────────────────────────────────────────────────────

export type ProjectOutcome = "migrated" | "would_migrate" | "skipped" | "failed"

export interface ProjectReportRow {
  projectId: string
  name: string
  outcome: ProjectOutcome
  detail: string
  summary: MigrationSummary | null
}

export const renderReport = (rows: readonly ProjectReportRow[], options: { dryRun: boolean; at: Date; totalSections: number }): string => {
  const count = (o: ProjectOutcome) => rows.filter((r) => r.outcome === o).length
  const sum = (pick: (s: MigrationSummary) => number) => rows.reduce((n, r) => n + (r.summary ? pick(r.summary) : 0), 0)
  const lines = [
    `## Lần chạy ${options.at.toISOString()} — ${options.dryRun ? "dry-run (không ghi)" : "thật"}`,
    "",
    `- Project có section cũ: **${rows.length}** · section đọc được: **${options.totalSections}**`,
    `- ${options.dryRun ? "Sẽ migrate" : "Đã migrate"}: **${count(options.dryRun ? "would_migrate" : "migrated")}** · bỏ qua: **${count("skipped")}** · lỗi: **${count("failed")}**`,
    `- Addendum: ${sum((s) => s.addendum)} · actor: ${sum((s) => s.actors)} · use case: ${sum((s) => s.use_cases)} · project có vision: ${rows.filter((r) => r.summary?.vision).length}`,
    "",
    "| Project | Tên | Kết quả | Section | Vision | Goals | Actor | Use case | Addendum | Ghi chú |",
    "|---|---|---|---|---|---|---|---|---|---|"
  ]
  for (const r of rows) {
    const s = r.summary
    const cell = (v: string | number | boolean | undefined) => (s ? String(v) : "—")
    lines.push(
      `| \`${r.projectId}\` | ${r.name.replace(/\|/g, "\\|")} | ${r.outcome} | ${cell(s?.sections)} | ${cell(s?.vision ? "có" : "không")} | ${cell(s?.goals)} | ${cell(s?.actors)} | ${cell(s?.use_cases)} | ${cell(s?.addendum)} | ${r.detail.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")} |`
    )
  }
  return lines.join("\n") + "\n"
}

const REPORT_HEADER = `# Báo cáo migration Section → Spine (T21)

Sinh bởi \`npm run migrate:sections\`. Mỗi lần chạy thêm một khối lên đầu danh sách bên dưới.
Kết quả \`skipped\` với \`spine_already_written\` là bình thường cho project đã chạy pipeline mới hoặc đã migrate.

`

// ─── CLI ────────────────────────────────────────────────────────

interface CliArgs {
  dryRun: boolean
  projectId: string | null
  reportPath: string
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const parseArgs = (argv: readonly string[]): CliArgs => {
  const args: CliArgs = { dryRun: false, projectId: null, reportPath: path.resolve(__dirname, "../../docs/migration-report.md") }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true
    else if (argv[i] === "--project" && argv[i + 1]) args.projectId = argv[++i]
    else if (argv[i] === "--report" && argv[i + 1]) args.reportPath = path.resolve(argv[++i])
  }
  return args
}

const appendReport = (reportPath: string, block: string): void => {
  const previous = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : REPORT_HEADER
  const body = previous.startsWith(REPORT_HEADER) ? previous.slice(REPORT_HEADER.length) : previous
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, `${REPORT_HEADER}${block}\n${body}`)
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  const [{ default: mongoose }, { env }, { Project }, repository, { applyTransaction }] = await Promise.all([
    import("mongoose"),
    import("../config/env.js"),
    import("../modules/project/project.model.js"),
    import("../modules/spine/spine.repository.js"),
    import("../modules/spine/op-engine.js")
  ])

  // Không dùng connectDB: nó còn khởi tạo replica set và tài khoản admin — script không được có tác dụng phụ đó
  await mongoose.connect(env.MONGO_URI)
  console.log(`🟢 Connected to MongoDB${args.dryRun ? " (dry-run: không ghi)" : ""}`)

  try {
    const filter = args.projectId ? { projectId: new mongoose.Types.ObjectId(args.projectId) } : {}
    const docs = await mongoose.connection.collection("sections").find(filter).toArray()
    const byProject = new Map<string, LegacySection[]>()
    for (const doc of docs) {
      const key = String(doc.projectId)
      const list = byProject.get(key) ?? []
      list.push({ type: String(doc.type), content: doc.content, status: doc.status, updatedAt: doc.updatedAt })
      byProject.set(key, list)
    }

    const rows: ProjectReportRow[] = []
    for (const [projectId, sections] of byProject) {
      const project = await Project.findById(projectId).lean()
      if (!project) {
        rows.push({ projectId, name: "(không còn project)", outcome: "skipped", detail: "project_missing", summary: null })
        continue
      }
      try {
        const init = { name: project.name, domain: project.domain ?? null }
        const record: SpineRecord | Spine = args.dryRun
          ? (await repository.get(projectId)) ?? repository.createEmptySpine(init)
          : await repository.getOrCreate(projectId, init)
        const { projectId: _ignored, ...base } = { projectId, ...record }

        const skip = skipReasonOf(base, sections)
        if (skip) {
          rows.push({ projectId, name: project.name, outcome: "skipped", detail: skip, summary: null })
          continue
        }

        const { spine: migrated, summary } = buildMigratedSpine(base, sections)
        const txn = buildMigrationTransaction(base, migrated)
        if (args.dryRun) {
          // Áp thử trong bộ nhớ: bắt lỗi schema/bất biến trước lần chạy thật
          planTransaction(base, txn, { startSeq: 1 })
          rows.push({ projectId, name: project.name, outcome: "would_migrate", detail: "", summary })
        } else {
          const result = await applyTransaction(projectId, txn)
          rows.push({ projectId, name: project.name, outcome: "migrated", detail: `spine_version ${result.spine_version}`, summary })
        }
      } catch (err) {
        const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        rows.push({ projectId, name: project.name, outcome: "failed", detail, summary: null })
      }
    }

    const block = renderReport(rows, { dryRun: args.dryRun, at: new Date(), totalSections: docs.length })
    appendReport(args.reportPath, block)
    console.log(block)
    console.log(`📝 Báo cáo: ${args.reportPath}`)
    if (rows.some((r) => r.outcome === "failed")) process.exitCode = 1
  } finally {
    await mongoose.disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("❌ Migration lỗi:", err)
    process.exit(1)
  })
}
