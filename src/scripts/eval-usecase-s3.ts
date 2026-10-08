/**
 * eval-usecase-s3.ts — đo chất lượng S-3.1 → S-3.6 (actor, use case, include/extend) bằng provider thật.
 * ─────────────────────────────────────────────────────────────────
 * Mỗi ca trong `fixtures/s3-eval/*.json` là Spine đứng ngay trước S-3.1 với brief đủ persona — tách khỏi
 * phase Brief để số đo chỉ phản ánh prompt S-3. Mỗi lượt: tạo project qua API, nạp Spine của ca qua
 * `spine.repository`, lái S-3.1 → S-3.6 bằng `run-full-pipeline.ts --no-brief`, rồi chấm bằng
 * `usecase-s3-metrics.ts`. LLM dao động giữa các lượt nên luôn chạy nhiều lượt (`--runs`); các lượt chạy
 * tuần tự vì dùng chung một ví credit.
 *
 * Cách dùng (BE đang chạy, tài khoản đã có credit — `npm run seed:e2e-user`):
 *   npm run eval:usecase-s3 -- --label baseline --runs 3
 *   npm run eval:usecase-s3 -- --label after --runs 3 --cases mediqueue,bookbox
 *   npm run eval:usecase-s3 -- --compare test/e2e-ai/results/usecase-s3-baseline-….json test/e2e-ai/results/usecase-s3-after-….json
 *
 * Cờ: --api URL · --email · --password · --runs N (mặc định 3) · --cases a,b · --label TÊN · --compare A.json B.json
 *     · --rescore ca:projectId,… (chấm lại project đã chạy xong, không tốn credit)
 * Kết quả: `test/e2e-ai/results/usecase-s3-<label>-<ISO>.{json,md}`.
 */
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import mongoose from "mongoose"
import { connectDB } from "../config/database.js"
import * as repository from "../modules/spine/spine.repository.js"
import { spineSchema } from "../modules/spine/spine.schema.js"
import { scoreS3, type PersonaExpectation, type S3Metrics } from "./usecase-s3-metrics.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../..")
const EVAL_DIR = path.join(REPO_ROOT, "fixtures/s3-eval")
const RESULTS_DIR = path.join(REPO_ROOT, "test/e2e-ai/results")
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli")

interface Args {
  api: string
  email: string
  password: string
  runs: number
  cases: string[] | null
  label: string
  compare: [string, string] | null
  /** Chấm lại project đã chạy xong, không chạy pipeline: cặp [ca, projectId]. */
  rescore: Array<[string, string]> | null
}

const parseArgs = (): Args => {
  const argv = process.argv.slice(2)
  const args: Args = {
    api: process.env.E2E_API_URL ?? "http://localhost:5000/api/v1",
    email: process.env.E2E_EMAIL ?? "fixture@flintflow.io",
    password: process.env.E2E_PASSWORD ?? "fixture-password-123",
    runs: 3,
    cases: null,
    label: "run",
    compare: null,
    rescore: null
  }
  for (let i = 0; i < argv.length; i++) {
    const next = (): string => argv[++i] as string
    switch (argv[i]) {
      case "--api": args.api = next(); break
      case "--email": args.email = next(); break
      case "--password": args.password = next(); break
      case "--runs": args.runs = Number(next()); break
      case "--cases": args.cases = next().split(","); break
      case "--label": args.label = next(); break
      case "--compare": args.compare = [next(), next()]; break
      case "--rescore":
        args.rescore = next().split(",").map((pair) => pair.split(":") as [string, string])
        break
      default: throw new Error(`Cờ không nhận ra: ${argv[i]}`)
    }
  }
  return args
}

interface EvalCase {
  name: string
  expected_personas: PersonaExpectation[]
  spine: unknown
}

interface RunResult {
  caseName: string
  run: number
  projectId: string
  ok: boolean
  error: string | null
  metrics: S3Metrics | null
}

const loadCases = (only: string[] | null): EvalCase[] =>
  fs
    .readdirSync(EVAL_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(EVAL_DIR, f), "utf8")) as EvalCase)
    .filter((c) => !only || only.includes(c.name))

const login = async (args: Args): Promise<string> => {
  const res = await fetch(`${args.api}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: args.email, password: args.password })
  })
  const json = (await res.json()) as { data?: { accessToken: string }; error?: { message: string } }
  if (!res.ok || !json.data) throw new Error(`Đăng nhập thất bại: ${json.error?.message ?? res.status}`)
  return json.data.accessToken
}

const createProject = async (args: Args, token: string, name: string, domain: string | null): Promise<string> => {
  const res = await fetch(`${args.api}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, domain: domain ?? "General" })
  })
  const json = (await res.json()) as { data?: { _id: string }; error?: { message: string } }
  if (!res.ok || !json.data) throw new Error(`Tạo project thất bại: ${json.error?.message ?? res.status}`)
  return json.data._id
}

/** Thay Spine rỗng của project mới bằng Spine của ca — qua repository, có kiểm schema và khoá phiên bản. */
const loadSpine = async (projectId: string, spine: unknown): Promise<void> => {
  const current = await repository.getOrCreate(projectId)
  const parsed = spineSchema.parse(spine)
  await repository.saveWithVersion({ ...parsed, projectId }, current.spine_version)
}

const drive = (args: Args, projectId: string, out: string): Promise<number> =>
  new Promise((resolve) => {
    // Gọi thẳng node + tsx/cli, không qua shell: tham số (mật khẩu có dấu cách, `&`…) đi nguyên vẹn trên Windows
    const child = spawn(
      process.execPath,
      [TSX_CLI, "src/scripts/run-full-pipeline.ts", "--api", args.api, "--email", args.email, "--password", args.password,
        "--project", projectId, "--until", "S-3.6", "--no-brief", "--out", out],
      { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "inherit"] }
    )
    child.on("close", (code) => resolve(code ?? 1))
  })

/** `reason` của op cuối cùng ghi quan hệ include/extend, theo path. */
const relationReasons = async (projectId: string): Promise<Map<string, string>> => {
  const changes = await repository.listChanges(projectId)
  const reasons = new Map<string, string>()
  for (const c of changes) if (/\.(includes|extends)$/.test(c.path) && c.reason) reasons.set(c.path, c.reason)
  return reasons
}

const runCase = async (args: Args, c: EvalCase, stamp: string, onResult: (r: RunResult) => void): Promise<void> => {
  for (let run = 1; run <= args.runs; run++) {
    // Access token sống 15 phút, một lượt S-3 mất vài phút ⇒ đăng nhập lại mỗi lượt
    const token = await login(args)
    const domain = (c.spine as { project?: { domain?: string } }).project?.domain ?? null
    const projectId = await createProject(args, token, `S3 eval ${c.name} ${args.label} #${run}`, domain)
    let result: RunResult
    try {
      await loadSpine(projectId, c.spine)
      const code = await drive(args, projectId, path.join(RESULTS_DIR, `usecase-s3-${args.label}-${stamp}-${c.name}-${run}.pipeline.md`))
      const metrics = await scoreProject(projectId, c.expected_personas)
      result = { caseName: c.name, run, projectId, ok: code === 0 && metrics !== null, error: code === 0 ? null : `pipeline exit ${code}`, metrics }
    } catch (err) {
      result = { caseName: c.name, run, projectId, ok: false, error: String(err), metrics: null }
    }
    onResult(result)
    process.stdout.write(`${c.name} #${run} ${result.ok ? "ok" : `LỖI ${result.error}`}\n`)
  }
}

/** Chấm Spine hiện tại của một project đã chạy xong S-3 (dùng lại cho `--rescore`). */
const scoreProject = async (projectId: string, personas: PersonaExpectation[]): Promise<S3Metrics | null> => {
  const record = await repository.get(projectId)
  if (!record) return null
  const { projectId: _ignored, ...content } = record
  return scoreS3(spineSchema.parse(content), personas, await relationReasons(projectId))
}

// ─── báo cáo ─────────────────────────────────────────────────────

const METRIC_COLUMNS: Array<[string, (m: S3Metrics) => number]> = [
  ["human", (m) => m.actors.human],
  ["system", (m) => m.actors.system],
  ["time", (m) => m.actors.time],
  ["UC", (m) => m.useCases],
  ["include", (m) => m.includes],
  ["extend", (m) => m.extends],
  ["auth_relation", (m) => m.flags.auth_relation],
  ["orphan_actor", (m) => m.flags.orphan_actor],
  ["relation_invalid", (m) => m.flags.relation_invalid],
  ["floating", (m) => m.flags.floating],
  ["name_semantic", (m) => m.flags.name_semantic],
  ["name_style", (m) => m.flags.name_style],
  ["persona thiếu", (m) => m.personasMissing.length]
]

const mean = (xs: number[]): string => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : "–")

const summaryRows = (results: RunResult[]): Map<string, string[]> => {
  const byCase = new Map<string, S3Metrics[]>()
  for (const r of results) if (r.metrics) byCase.set(r.caseName, [...(byCase.get(r.caseName) ?? []), r.metrics])
  return new Map([...byCase].map(([name, ms]) => [name, METRIC_COLUMNS.map(([, f]) => mean(ms.map(f)))]))
}

const renderReport = (label: string, results: RunResult[]): string => {
  const header = `| Ca | ${METRIC_COLUMNS.map(([h]) => h).join(" | ")} |\n|---|${METRIC_COLUMNS.map(() => "---").join("|")}|`
  const lines = [`# Eval use case S-3 — ${label}`, "", `Trung bình theo ca (${results.filter((r) => r.ok).length}/${results.length} lượt thành công).`, "", header]
  for (const [name, cells] of summaryRows(results)) lines.push(`| ${name} | ${cells.join(" | ")} |`)
  lines.push("", "## Từng lượt", "")
  for (const r of results) {
    lines.push(`### ${r.caseName} #${r.run} — project \`${r.projectId}\`${r.ok ? "" : ` — **${r.error}**`}`, "")
    if (!r.metrics) continue
    lines.push(`Persona thiếu: ${r.metrics.personasMissing.join(", ") || "không"}`, "")
    if (r.metrics.relations.length === 0) lines.push("Không có quan hệ include/extend.", "")
    for (const rel of r.metrics.relations) lines.push(`- ${rel.from} **${rel.kind}** ${rel.to}${rel.reason ? ` — _${rel.reason}_` : ""}`)
    lines.push("")
  }
  return lines.join("\n")
}

const renderCompare = (a: { label: string; results: RunResult[] }, b: { label: string; results: RunResult[] }): string => {
  const sa = summaryRows(a.results)
  const sb = summaryRows(b.results)
  const lines = [`# So sánh ${a.label} → ${b.label}`, "", `| Ca | Chỉ số | ${a.label} | ${b.label} |`, "|---|---|---|---|"]
  for (const name of new Set([...sa.keys(), ...sb.keys()])) {
    METRIC_COLUMNS.forEach(([h], i) => lines.push(`| ${name} | ${h} | ${sa.get(name)?.[i] ?? "–"} | ${sb.get(name)?.[i] ?? "–"} |`))
  }
  return lines.join("\n")
}

const main = async (): Promise<void> => {
  const args = parseArgs()
  if (args.compare) {
    const [a, b] = args.compare.map((f) => JSON.parse(fs.readFileSync(f, "utf8")) as { label: string; results: RunResult[] })
    process.stdout.write(`${renderCompare(a, b)}\n`)
    return
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const base = path.join(RESULTS_DIR, `usecase-s3-${args.label}-${stamp}`)
  const results: RunResult[] = []
  // Ghi lại sau MỖI lượt: lượt sau hỏng (mạng, token, provider) không làm mất số đo đã có
  const save = (r: RunResult): void => {
    results.push(r)
    fs.writeFileSync(`${base}.json`, JSON.stringify({ label: args.label, results }, null, 2))
    fs.writeFileSync(`${base}.md`, renderReport(args.label, results))
  }
  await connectDB()

  if (args.rescore) {
    const cases = new Map(loadCases(null).map((c) => [c.name, c]))
    for (const [caseName, projectId] of args.rescore) {
      const c = cases.get(caseName)
      if (!c) throw new Error(`Không có ca "${caseName}" trong fixtures/s3-eval`)
      const metrics = await scoreProject(projectId, c.expected_personas)
      save({ caseName, run: results.filter((r) => r.caseName === caseName).length + 1, projectId, ok: metrics !== null, error: metrics ? null : "không thấy Spine", metrics })
    }
  } else {
    // Tuần tự: mọi lượt dùng chung một ví credit, reserve song song làm transaction Mongo va nhau
    // (`112 Write conflict`) và step hỏng trước khi gọi model.
    for (const c of loadCases(args.cases)) await runCase(args, c, stamp, save)
  }

  process.stdout.write(`\nBáo cáo: ${base}.md\n`)
  await mongoose.disconnect()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
