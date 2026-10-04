/**
 * eval-elicit-brief.ts — đo luồng Brief (B-0.1) bằng provider thật: thẻ hỏi AI phát ra và giá trị nó ghi.
 * ─────────────────────────────────────────────────────────────────
 * Mỗi ca trong `fixtures/brief-eval/*.json` là một chuỗi ý tưởng. Mỗi lượt: tạo project qua API, gửi ý
 * tưởng khi chạy B-0.1, **ghi lại nguyên văn mọi thẻ và mọi lời đáp**, trả lời thẻ (luôn chọn phương án
 * đầu — phương án model khuyến nghị), rồi đọc Spine để lấy `project.form_factor`, `project.stakes`,
 * `assumptions[]` và sổ quyết định. Chấm bằng `elicit-brief-metrics.ts`.
 *
 * Khác eval S-3: ca ở đây là **đầu vào của người dùng**, không phải Spine nạp sẵn, và thứ cần đo là **thẻ
 * hỏi** chứ không phải Spine cuối — nên driver tự đọc SSE thay vì gọi `run-full-pipeline.ts` (script đó tự
 * trả lời thẻ và không giữ lại nguyên văn thẻ).
 *
 * LLM dao động ở `temperature: 0.5` nên một lượt không kết luận được: mặc định 3 lượt mỗi ca.
 *
 * Cách dùng (BE đang chạy, tài khoản đã có credit — `npm run seed:e2e-user`):
 *   npm run eval:elicit-brief -- --label baseline --runs 3
 *   npm run eval:elicit-brief -- --label after --runs 1 --cases clinic-booking
 *   npm run eval:elicit-brief -- --compare test/e2e-ai/results/elicit-brief-baseline-….json test/e2e-ai/results/elicit-brief-after-….json
 *
 * Cờ: --api URL · --email · --password · --runs N (mặc định 3) · --cases a,b · --label TÊN · --compare A.json B.json
 *     · --render A.json (dựng lại `.md` từ kết quả đã lưu, không gọi provider)
 * Kết quả: `test/e2e-ai/results/elicit-brief-<label>-<ISO>.{json,md}`.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  scoreBrief,
  type BriefMetrics,
  type RecordedQuestion,
  type RecordedRun,
  type RecordedSpine,
  type RecordedTurn
} from "./elicit-brief-metrics.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../..")
const CASES_DIR = path.join(REPO_ROOT, "fixtures/brief-eval")
const RESULTS_DIR = path.join(REPO_ROOT, "test/e2e-ai/results")

const STEP_ID = "B-0.1"

/** Trần lượt hỏi của một ca — B-0.1 thật chỉ hỏi 1–2 lượt; quá số này là model vòng vo. */
const MAX_ANSWER_ROUNDS = 5

/** Câu trả lời cho câu hỏi mở: cố định để hai lần chạy so sánh được với nhau. */
const OPEN_ANSWER =
  "Cứ theo đúng ý tưởng tôi vừa kể. Chỗ nào tôi chưa nói thì bạn chọn phương án hợp lý nhất cho dự án này và ghi lại là bạn đang giả định."

interface Args {
  api: string
  email: string
  password: string
  runs: number
  cases: string[] | null
  label: string
  compare: [string, string] | null
  /** Dựng lại `.md` từ một `.json` đã lưu — sửa cách trình bày báo cáo mà không phải chạy lại (tốn credit). */
  render: string | null
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
    render: null
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
      case "--render": args.render = next(); break
      default: throw new Error(`Cờ không nhận ra: ${argv[i]}`)
    }
  }
  return args
}

const ARGS = parseArgs()

/** Một ca: chỉ cần chuỗi ý tưởng; `note` ghi ca này dùng để bắt khuyết tật nào. */
interface EvalCase {
  id: string
  idea: string
  note: string
}

interface RunResult {
  caseId: string
  run: number
  projectId: string
  ok: boolean
  error: string | null
  recorded: RecordedRun | null
  metrics: BriefMetrics | null
}

const loadCases = (only: string[] | null): EvalCase[] =>
  fs
    .readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), "utf8")) as EvalCase)
    .filter((c) => !only || only.includes(c.id))

// ─── HTTP ────────────────────────────────────────────────────────

interface Envelope<T> {
  data: T
  error: { code: string; message: string } | null
}

let TOKEN = ""

const login = async (): Promise<void> => {
  const res = await fetch(`${ARGS.api}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ARGS.email, password: ARGS.password })
  })
  const json = (await res.json()) as Envelope<{ accessToken: string }>
  if (!res.ok || json.error) throw new Error(`Đăng nhập thất bại: ${json.error?.message ?? res.status}`)
  TOKEN = json.data.accessToken
}

const call = async <T>(method: string, pathname: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${ARGS.api}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await res.text()
  let json: Envelope<T>
  try {
    json = JSON.parse(text) as Envelope<T>
  } catch {
    throw new Error(`${method} ${pathname}: ${res.status} không phải JSON — ${text.slice(0, 200)}`)
  }
  if (!res.ok || json.error) throw new Error(`${method} ${pathname}: ${json.error?.code ?? res.status} ${json.error?.message ?? ""}`)
  return json.data
}

const log = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

// ─── lái một lượt ────────────────────────────────────────────────

interface ContractQuestion {
  id: string
  text: string
  header?: string
  options?: Array<string | { label: string; description?: string; preview?: string }>
  multiple?: boolean
  inline?: boolean
}

const RECOMMENDED_SUFFIX = /\s*\((khuyến nghị|recommended)\)\s*$/i

const recordOption = (option: string | { label: string; description?: string; preview?: string }): RecordedQuestion["options"][number] =>
  typeof option === "string" ? { label: option } : option

const recordQuestion = (q: ContractQuestion): RecordedQuestion => ({
  id: q.id,
  text: q.text,
  ...(q.header ? { header: q.header } : {}),
  options: (q.options ?? []).map(recordOption),
  ...(q.multiple === undefined ? {} : { multiple: q.multiple }),
  ...(q.inline ? { inline: true } : {})
})

/**
 * Trả lời như một user bấm thẻ: lấy **phương án đầu** (phương án model khuyến nghị) — chính phép khuyến nghị
 * là thứ cần đo. Thẻ nhiều lựa chọn vẫn chỉ bấm một ô để hai lần chạy so sánh được.
 */
const answerFor = (q: RecordedQuestion): string | string[] => {
  if (q.options.length === 0) return OPEN_ANSWER
  const pick = q.options[0].label.replace(RECOMMENDED_SUFFIX, "").trim()
  return q.multiple ? [pick] : pick
}

interface SpineResponse {
  spine_version: number
  project: { form_factor: string[]; stakes: string | null }
  assumptions: Array<{ path: string }>
  decisions: Array<{ topic_key: string; answer: string }>
}

const readSpine = async (projectId: string): Promise<RecordedSpine> => {
  const spine = await call<SpineResponse>("GET", `/projects/${projectId}/spine`)
  return {
    form_factor: spine.project.form_factor,
    stakes: spine.project.stakes,
    assumption_paths: spine.assumptions.map((a) => a.path),
    decisions: spine.decisions.map((d) => ({ topic_key: d.topic_key, answer: d.answer }))
  }
}

interface DriveOutcome {
  turns: RecordedTurn[]
  error: string | null
  reachedGate: boolean
}

/**
 * Chạy B-0.1 và ghi lại từng lượt. Lời đáp tới trong sự kiện `elicit`, thẻ tới trong `answer_needed`; một
 * lượt là "các `elicit` đã nhận" + "các thẻ của `answer_needed` ngay sau đó". Trả lời xong thì cùng luồng
 * SSE chạy tiếp cho tới `gate_ready`.
 */
const driveStep = async (projectId: string, sessionId: string, idea: string, baseVersion: number): Promise<DriveOutcome> => {
  const res = await fetch(`${ARGS.api}/projects/${projectId}/steps/${STEP_ID}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ session_id: sessionId, base_version: baseVersion, message: idea })
  })

  const outcome: DriveOutcome = { turns: [], error: null, reachedGate: false }
  if (!(res.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
    const text = await res.text()
    outcome.error = `không phải SSE (${res.status}): ${text.slice(0, 200)}`
    return outcome
  }

  let pendingUserMessage = idea
  let replyBuffer = ""
  let rounds = 0

  const onAnswerNeeded = async (questions: ContractQuestion[]): Promise<void> => {
    rounds += 1
    const recorded = questions.map(recordQuestion)
    outcome.turns.push({ user_message: pendingUserMessage, reply: replyBuffer.trim(), questions: recorded })
    replyBuffer = ""
    if (rounds > MAX_ANSWER_ROUNDS) {
      log(`      ! quá ${MAX_ANSWER_ROUNDS} lượt hỏi — không trả lời nữa, để step tự kết thúc`)
      return
    }
    const answers = recorded.map((q) => ({ question_id: q.id, answer: answerFor(q) }))
    pendingUserMessage = answers.map((a) => (Array.isArray(a.answer) ? a.answer.join(", ") : a.answer)).join(" · ")
    log(`      ? ${recorded.length} câu (lượt ${rounds}): ${recorded.map((q) => q.header ?? q.id).join(", ")}`)
    await call("POST", `/projects/${projectId}/steps/${STEP_ID}/answer`, { session_id: sessionId, answers })
  }

  const handle = async (event: { type: string; [k: string]: unknown }): Promise<void> => {
    switch (event.type) {
      case "elicit":
        replyBuffer += String(event.delta ?? "")
        break
      case "answer_needed":
        await onAnswerNeeded((event.questions ?? []) as ContractQuestion[])
        break
      case "gate_ready":
        outcome.reachedGate = true
        break
      case "error":
        outcome.error = `${String(event.code)}: ${String(event.message)}`
        break
      default:
        break
    }
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx = buffer.indexOf("\n\n")
    while (idx >= 0) {
      const payload = buffer
        .slice(0, idx)
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("")
      buffer = buffer.slice(idx + 2)
      if (payload) {
        try {
          await handle(JSON.parse(payload) as { type: string })
        } catch (err) {
          log(`      ! sự kiện không xử lý được: ${String(err)}`)
        }
      }
      idx = buffer.indexOf("\n\n")
    }
  }

  // Lời đáp cuối (sau lượt trả lời cuối) không có `answer_needed` nào đóng lại nó.
  if (replyBuffer.trim() !== "") outcome.turns.push({ user_message: pendingUserMessage, reply: replyBuffer.trim(), questions: [] })
  return outcome
}

const runCase = async (c: EvalCase, onResult: (r: RunResult) => void): Promise<void> => {
  for (let run = 1; run <= ARGS.runs; run++) {
    await login()
    const project = await call<{ _id: string }>("POST", "/projects", { name: `Brief eval ${c.id} ${ARGS.label} #${run}`, domain: "General" })
    const projectId = project._id
    let result: RunResult
    try {
      const sessions = await call<Array<{ _id: string; is_pipeline: boolean }>>("GET", `/projects/${projectId}/chats`)
      const session = sessions.find((s) => s.is_pipeline) ?? (await call<{ _id: string }>("POST", `/projects/${projectId}/chats`, {}))
      const spine = await call<{ spine_version: number }>("GET", `/projects/${projectId}/spine`)
      const outcome = await driveStep(projectId, session._id, c.idea, spine.spine_version)
      const recorded: RecordedRun = { case_id: c.id, turns: outcome.turns, spine: await readSpine(projectId) }
      result = {
        caseId: c.id,
        run,
        projectId,
        ok: outcome.error === null && outcome.reachedGate,
        error: outcome.error ?? (outcome.reachedGate ? null : "không tới được cổng chốt"),
        recorded,
        metrics: scoreBrief(recorded)
      }
    } catch (err) {
      result = { caseId: c.id, run, projectId, ok: false, error: String(err), recorded: null, metrics: null }
    }
    onResult(result)
    log(`${c.id} #${run} ${result.ok ? "ok" : `LỖI ${result.error}`}`)
  }
}

// ─── báo cáo ─────────────────────────────────────────────────────

/** Chỉ số số hoá được, dùng cho bảng trung bình và cho `--compare`. */
const METRIC_COLUMNS: Array<[string, (m: BriefMetrics) => number | string]> = [
  ["câu/lượt", (m) => m.questions_per_turn.join("+") || "–"],
  ["chủ đề", (m) => m.topic_keys.join(" ") || "–"],
  ["stakes", (m) => m.stakes_value ?? "–"],
  ["giả định stakes", (m) => (m.has_stakes_assumption ? "có" : "không")],
  ["option thiếu mô tả", (m) => m.options_without_description],
  ["option số trần", (m) => m.numeric_only_options],
  ["nhãn lồng nhau", (m) => m.nested_labels],
  ["option không-thêm-gì", (m) => m.none_option_on_multiselect],
  ["ứng viên thiếu option", (m) => m.candidate_without_option.join(" ") || "–"],
  ["vốn từ cấm", (m) => m.banned_vocab.join(" ") || "–"],
  ["B-0 tự quyết", (m) => m.b0_fields_set_without_card_or_assumption.join(" ") || "–"],
  ["lượng từ bịa", (m) => m.unsourced_quantifiers]
]

/** Giá trị của một chỉ số qua các lượt của một ca: số ⇒ trung bình, chữ ⇒ các giá trị khác nhau. */
const aggregate = (values: Array<number | string>): string => {
  if (values.length === 0) return "–"
  if (values.every((v) => typeof v === "number")) {
    const nums = values as number[]
    return (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1)
  }
  const uniq = [...new Set(values.map(String))]
  // Nối bằng " / ": "|" là dấu phân cột của bảng markdown nên một ca dao động giữa các lượt sẽ vỡ bảng.
  return uniq.length === 1 ? uniq[0] : uniq.join(" / ")
}

const summaryRows = (results: RunResult[]): Map<string, string[]> => {
  const byCase = new Map<string, BriefMetrics[]>()
  for (const r of results) if (r.metrics) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r.metrics])
  return new Map([...byCase].map(([id, ms]) => [id, METRIC_COLUMNS.map(([, f]) => aggregate(ms.map(f)))]))
}

const renderCards = (recorded: RecordedRun): string[] => {
  const lines: string[] = []
  for (const [i, turn] of recorded.turns.entries()) {
    lines.push(`**Lượt ${i + 1}** — user: _${turn.user_message.slice(0, 200)}_`, "", `> ${turn.reply.replace(/\n/g, "\n> ")}`, "")
    for (const q of turn.questions) {
      lines.push(`- \`${q.id}\`${q.header ? ` · **${q.header}**` : ""}${q.multiple ? " · nhiều lựa chọn" : ""}: ${q.text}`)
      for (const o of q.options) lines.push(`  - **${o.label}**${o.description ? ` — ${o.description}` : " — _(không có mô tả)_"}`)
    }
    lines.push("")
  }
  return lines
}

const renderReport = (label: string, results: RunResult[]): string => {
  const header = `| Ca | ${METRIC_COLUMNS.map(([h]) => h).join(" | ")} |\n|---|${METRIC_COLUMNS.map(() => "---").join("|")}|`
  const lines = [
    `# Eval luồng Brief — ${label}`,
    "",
    `${results.filter((r) => r.ok).length}/${results.length} lượt thành công. Số là trung bình theo ca; chữ liệt kê các giá trị khác nhau.`,
    "",
    header
  ]
  for (const [id, cells] of summaryRows(results)) lines.push(`| ${id} | ${cells.join(" | ")} |`)
  lines.push("", "## Nguyên văn từng lượt", "")
  for (const r of results) {
    lines.push(`### ${r.caseId} #${r.run} — project \`${r.projectId}\`${r.ok ? "" : ` — **${r.error}**`}`, "")
    if (r.recorded) lines.push(...renderCards(r.recorded))
    if (r.metrics?.unsourced_quantifier_samples.length) {
      lines.push(`Lượng từ không có nguồn: ${r.metrics.unsourced_quantifier_samples.map((s) => `\`${s}\``).join(", ")}`, "")
    }
  }
  return lines.join("\n")
}

const renderCompare = (a: { label: string; results: RunResult[] }, b: { label: string; results: RunResult[] }): string => {
  const sa = summaryRows(a.results)
  const sb = summaryRows(b.results)
  const lines = [`# So sánh ${a.label} → ${b.label}`, "", `| Ca | Chỉ số | ${a.label} | ${b.label} | |`, "|---|---|---|---|---|"]
  let changed = 0
  for (const id of new Set([...sa.keys(), ...sb.keys()])) {
    METRIC_COLUMNS.forEach(([h], i) => {
      const before = sa.get(id)?.[i] ?? "–"
      const after = sb.get(id)?.[i] ?? "–"
      if (before !== after) changed += 1
      lines.push(`| ${id} | ${h} | ${before} | ${after} | ${before === after ? "" : "**đổi**"} |`)
    })
  }
  lines.push("", changed === 0 ? "Không đổi." : `${changed} chỉ số đổi.`)
  return lines.join("\n")
}

const main = async (): Promise<void> => {
  if (ARGS.render) {
    const saved = JSON.parse(fs.readFileSync(ARGS.render, "utf8")) as { label: string; results: RunResult[] }
    const out = ARGS.render.replace(/\.json$/, ".md")
    fs.writeFileSync(out, renderReport(saved.label, saved.results))
    log(`Báo cáo: ${out}`)
    return
  }
  if (ARGS.compare) {
    const [a, b] = ARGS.compare.map((f) => JSON.parse(fs.readFileSync(f, "utf8")) as { label: string; results: RunResult[] })
    process.stdout.write(`${renderCompare(a, b)}\n`)
    return
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const base = path.join(RESULTS_DIR, `elicit-brief-${ARGS.label}-${stamp}`)
  const results: RunResult[] = []
  // Ghi lại sau MỖI lượt: lượt sau hỏng (mạng, token, provider) không làm mất số đo đã có
  const save = (r: RunResult): void => {
    results.push(r)
    fs.writeFileSync(`${base}.json`, JSON.stringify({ label: ARGS.label, results }, null, 2))
    fs.writeFileSync(`${base}.md`, renderReport(ARGS.label, results))
  }

  // Tuần tự: mọi lượt dùng chung một ví credit, reserve song song làm transaction Mongo va nhau
  for (const c of loadCases(ARGS.cases)) await runCase(c, save)

  log(`\nBáo cáo: ${base}.md`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
