/**
 * Đọc một corpus tri thức từ thư mục (FLF-267). Đổi corpus = trỏ script sang thư mục khác:
 *   - **skill** (`assets/skills`, có `SKILL.md`): chỉ đọc `SKILL.md`; frontmatter `skill_id`, `kind`, `description`;
 *     `source_kind = internal_skill`, `status = verified`; `applies_to` = các step dùng skill đó (bảng `STEP_SKILLS` của
 *     `context-projection.ts`, renderer theo `renders` của `assets/step-registry.json`), không step nào ⇒ `[]`;
 *   - **corpus khác** (phase 2: chuẩn ngoài, mỗi thư mục là nhiều file điều khoản + `index.md`): mọi `*.md`; frontmatter
 *     `source`, `section?`, `topic`, `status`, `applies_to`, `source_kind?` (mặc định `standard`, `status` mặc định
 *     `placeholder` — chưa ai xác minh thì không được vào prompt).
 * Frontmatter ghi đè được `status`, `source_kind`, `applies_to` ở cả hai loại; `knowledge_index: false` ⇒ bỏ file khỏi
 * corpus (vd skill `knowledge-answer` — prompt của chính tầng trả lời, không phải tri thức cho người dùng).
 *
 * Đọc frontmatter bằng `gray-matter` ở đây là cho mục đích khác registry: `prompt-assets.ts` vẫn là nơi DUY NHẤT dựng
 * registry skill; ở đây chỉ lấy metadata để gắn vào chunk tri thức.
 */

import fs from "node:fs"
import path from "node:path"
import matter from "gray-matter"
import { STEP_SKILLS } from "../pipeline/context-projection.js"
import { loadStepRegistry } from "../pipeline/step-registry.js"
import type { KnowledgeDoc, KnowledgeSourceKind, KnowledgeStatus } from "./chunker.js"

export interface LoadCorpusOptions {
  corpus: string
  /** Mặc định tự nhận: thư mục có `SKILL.md` ⇒ `skills`. */
  layout?: "skills" | "generic"
}

const SOURCE_KINDS: readonly KnowledgeSourceKind[] = ["internal_skill", "standard"]
const STATUSES: readonly KnowledgeStatus[] = ["placeholder", "verified"]

const listMarkdown = (dir: string): string[] => {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "_archive" || entry.name === "node_modules") continue
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full)
    }
  }
  walk(dir)
  return out
}

const asString = (v: unknown): string => (typeof v === "string" ? v.trim() : "")
const asStringArray = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : typeof v === "string" && v.trim() ? [v.trim()] : null

/**
 * Step dùng từng skill: skill content theo `STEP_SKILLS`, skill renderer theo `renders` của step registry
 * (`screen_flow` ⇔ `renderer/screen-flow`). Skill action dùng ở mọi step ⇒ không gắn step nào.
 */
export const stepsBySkill = (): Map<string, string[]> => {
  const map = new Map<string, Set<string>>()
  const add = (skill: string, step: string): void => {
    if (!map.has(skill)) map.set(skill, new Set())
    map.get(skill)!.add(step)
  }
  for (const [step, skill] of Object.entries(STEP_SKILLS)) add(skill, step)
  for (const step of loadStepRegistry()) for (const kind of step.renders) add(kind.replace(/_/g, "-"), step.id)
  return new Map([...map].map(([k, v]) => [k, [...v].sort()]))
}

/** Đọc mọi tài liệu của corpus, thứ tự ổn định (theo đường dẫn). */
export const loadCorpus = (dir: string, options: LoadCorpusOptions): KnowledgeDoc[] => {
  const root = path.resolve(dir)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Không thấy thư mục corpus: ${root}`)
  const files = listMarkdown(root)
  const layout = options.layout ?? (files.some((f) => path.basename(f) === "SKILL.md") ? "skills" : "generic")
  const steps = layout === "skills" ? stepsBySkill() : new Map<string, string[]>()

  return files
    .filter((f) => layout !== "skills" || path.basename(f) === "SKILL.md")
    .map((file) => ({ file, parsed: matter(fs.readFileSync(file, "utf-8").replace(/\r\n?/g, "\n")) }))
    .filter(({ parsed }) => (parsed.data as Record<string, unknown>).knowledge_index !== false)
    .map(({ file, parsed }): KnowledgeDoc => {
      const fm = parsed.data as Record<string, unknown>
      const rel = path.relative(root, file).replace(/\\/g, "/")
      const statusOverride = STATUSES.find((s) => s === fm.status)
      const kindOverride = SOURCE_KINDS.find((s) => s === fm.source_kind)
      const appliesOverride = asStringArray(fm.applies_to)
      if (layout === "skills") {
        const source = asString(fm.skill_id) || path.basename(path.dirname(file))
        return {
          corpus: options.corpus,
          doc_id: source,
          source,
          source_kind: kindOverride ?? "internal_skill",
          topic: asString(fm.kind) || path.basename(path.dirname(path.dirname(file))),
          description: asString(fm.description),
          status: statusOverride ?? "verified",
          applies_to: appliesOverride ?? steps.get(source) ?? [],
          body: parsed.content
        }
      }
      const docId = rel.replace(/\.md$/i, "")
      return {
        corpus: options.corpus,
        doc_id: docId,
        source: asString(fm.source) || docId,
        ...(asString(fm.section) ? { section: asString(fm.section) } : {}),
        source_kind: kindOverride ?? "standard",
        topic: asString(fm.topic) || asString(fm.section),
        description: asString(fm.description),
        status: statusOverride ?? "placeholder",
        applies_to: appliesOverride ?? [],
        body: parsed.content
      }
    })
}
