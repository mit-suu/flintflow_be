/**
 * eval-elicit-brief.ts — đo luồng Brief bằng provider thật: thẻ hỏi AI phát ra và giá trị nó ghi.
 * ─────────────────────────────────────────────────────────────────
 * Mỗi ca trong `fixtures/brief-eval/*.json` là một chuỗi ý tưởng. Mỗi lượt: tạo project qua API, gửi ý
 * tưởng khi chạy B-0.1, **ghi lại nguyên văn mọi thẻ và mọi lời đáp**, trả lời thẻ (luôn chọn phương án
 * đầu — phương án model khuyến nghị), rồi đọc Spine để lấy `project.form_factor`, `project.stakes`,
 * `assumptions[]` và sổ quyết định. Chấm bằng `elicit-brief-metrics.ts`.
 *
 * Phủ tới **lượt phỏng vấn mở đầu B-1**, không dừng ở B-0.1: lượt đó hỏi gộp một lần cho cả giai đoạn
 * (FLF-234) nên ra 3–4 thẻ thay vì 2, và là chỗ phát nhiều thẻ nhất của luồng Brief. Đo thiếu nó thì hai
 * chỉ số `candidate_without_option` và `none_option_on_multiselect` không bao giờ chạy tới dữ liệu thật —
 * chúng về 0 vì chưa ca nào chạm B-1, không phải vì hết khuyết tật.
 *
 * Đường đi đúng như user bấm: B-0.1 → duyệt cổng → `POST /phases/B-0/run`. B-0.2/B-0.3 tự chốt (nền tảng và
 * mức độ đã quyết ở thẻ của B-0.1) nên server chạy tiếp sang B-1 trên **cùng luồng** và phát lượt hỏi gộp.
 * Ghi xong thẻ của lượt đó là **đóng luồng ngay, không trả lời** — trả lời là mở ra 6 bước soạn của B-1,
 * tốn credit mà không đo thêm gì. Hai lượt B-0.1 và B-1 phải nằm trong cùng project: trần câu của lượt hỏi
 * gộp phụ thuộc `project.stakes` (`elicit-loop/SKILL.md`), mà `stakes` do chính thẻ B-0.1 quyết.
 *
 * Chi phí: mỗi ca thêm một lượt gọi model (lượt hỏi gộp). Khi đang phát triển thì hạ `--runs` hoặc khoanh
 * `--cases` thay vì chạy cả bộ.
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
 *     · --project ID (chạy trên một project TRỐNG có sẵn thay vì tạo mới — tài khoản đã đụng trần dự án của
 *       gói thì không tạo được project nào nữa; chỉ dùng được với `--runs 1` vì lượt sau cần project trắng.
 *       Project phải thật sự trắng, driver tự kiểm và dừng nếu không — xem `assertVirginProject`)
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
/** Giai đoạn chạy tiếp sau khi duyệt cổng B-0.1. Server tự sang B-1 trên cùng luồng khi B-0 tự chốt hết. */
const B0_UNIT = "B-0"
/** Lượt hỏi gộp đầu giai đoạn mang `step_id` là ĐƠN VỊ giai đoạn, không phải id bước (`phase-runner.service.ts`). */
const B1_UNIT = "B-1"

/** Trần lượt hỏi của một ca — B-0.1 thật chỉ hỏi 1–2 lượt; quá số này là model vòng vo. */
const MAX_ANSWER_ROUNDS = 5

/**
 * Trần số lần duyệt cổng trên đường từ B-0.1 tới lượt hỏi gộp B-1. Đường bình thường cần 0 lần (B-0.2/B-0.3
 * tự chốt); trần này chỉ để ca bất thường không chạy vô hạn mà vẫn tốn credit.
 */
const MAX_GATES_TO_B1 = 4

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
  /** Project TRỐNG có sẵn để chạy, thay vì tạo mới (tài khoản đã đụng trần dự án của gói). */
  project: string | null
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
    render: null,
    project: null
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
      case "--project": args.project = next(); break
      default: throw new Error(`Cờ không nhận ra: ${argv[i]}`)
    }
  }
  return args
}

const ARGS = parseArgs()

if (ARGS.project && ARGS.runs > 1) {
  throw new Error("--project chỉ chạy được 1 lượt: lượt thứ hai cần một project trắng, mà project này đã bị lượt đầu ghi. Thêm --runs 1.")
}

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
  /** Cổng chốt đang chờ user ở cuối luồng (bước tự chốt không tính) — để duyệt rồi đi tiếp. */
  pendingGate: string | null
  /** Đã ghi được thẻ của lượt hỏi gộp đầu B-1. */
  reachedB1Interview: boolean
}

type SseEvent = { type: string; [k: string]: unknown }

/** Đọc luồng SSE tới khi đóng, hoặc tới khi `handle` trả `"stop"` (dừng sớm thì huỷ luôn kết nối). */
const readSse = async (res: Response, handle: (event: SseEvent) => Promise<"stop" | void>): Promise<void> => {
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
          if ((await handle(JSON.parse(payload) as SseEvent)) === "stop") {
            await reader.cancel()
            return
          }
        } catch (err) {
          log(`      ! sự kiện không xử lý được: ${String(err)}`)
        }
      }
      idx = buffer.indexOf("\n\n")
    }
  }
}

interface DriveOptions {
  /** Tin user mở lượt chạy; cũng là `user_message` của lượt ghi đầu tiên. */
  message?: string
  /** Ghi thẻ của lượt hỏi gộp B-1 rồi dừng, không trả lời — trả lời là mở ra 6 bước soạn của B-1. */
  stopAtB1Interview?: boolean
}

/**
 * Chạy một luồng SSE của pipeline và ghi lại từng lượt. Lời đáp tới trong sự kiện `elicit`, thẻ tới trong
 * `answer_needed`; một lượt là "các `elicit` đã nhận" + "các thẻ của `answer_needed` ngay sau đó". Trả lời
 * xong thì cùng luồng chạy tiếp.
 *
 * Trả lời gửi về `step_id` của chính sự kiện, không về một bước cố định: luồng giai đoạn chạy qua nhiều
 * bước, và lượt hỏi gộp đầu giai đoạn mang `step_id` là đơn vị giai đoạn.
 */
const driveSse = async (projectId: string, sessionId: string, res: Response, options: DriveOptions = {}): Promise<DriveOutcome> => {
  const outcome: DriveOutcome = { turns: [], error: null, reachedGate: false, pendingGate: null, reachedB1Interview: false }
  if (!(res.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
    const text = await res.text()
    outcome.error = `không phải SSE (${res.status}): ${text.slice(0, 200)}`
    return outcome
  }

  let pendingUserMessage = options.message ?? ""
  let replyBuffer = ""
  let rounds = 0

  const onAnswerNeeded = async (stepId: string, questions: ContractQuestion[]): Promise<"stop" | void> => {
    rounds += 1
    const recorded = questions.map(recordQuestion)
    outcome.turns.push({ step_id: stepId, user_message: pendingUserMessage, reply: replyBuffer.trim(), questions: recorded })
    replyBuffer = ""
    log(`      ? ${recorded.length} câu (${stepId}, lượt ${rounds}): ${recorded.map((q) => q.header ?? q.id).join(", ")}`)

    if (options.stopAtB1Interview && stepId === B1_UNIT) {
      outcome.reachedB1Interview = true
      return "stop"
    }
    if (rounds > MAX_ANSWER_ROUNDS) {
      log(`      ! quá ${MAX_ANSWER_ROUNDS} lượt hỏi — không trả lời nữa, để step tự kết thúc`)
      return
    }
    const answers = recorded.map((q) => ({ question_id: q.id, answer: answerFor(q) }))
    pendingUserMessage = answers.map((a) => (Array.isArray(a.answer) ? a.answer.join(", ") : a.answer)).join(" · ")
    await call("POST", `/projects/${projectId}/steps/${stepId}/answer`, { session_id: sessionId, answers })
  }

  await readSse(res, async (event) => {
    switch (event.type) {
      case "elicit":
        replyBuffer += String(event.delta ?? "")
        return
      case "answer_needed":
        return onAnswerNeeded(String(event.step_id), (event.questions ?? []) as ContractQuestion[])
      case "gate_ready":
        outcome.reachedGate = true
        // `auto` = bước tự chốt, không có gì cho user bấm ⇒ không phải cổng phải duyệt
        outcome.pendingGate = event.auto === true ? outcome.pendingGate : String(event.step_id)
        return
      case "phase_gate":
        outcome.pendingGate = String(event.step_id)
        return
      case "error":
        outcome.error = `${String(event.code)}: ${String(event.message)}`
        return
      default:
        return
    }
  })

  // Lời đáp cuối (sau lượt trả lời cuối) không có `answer_needed` nào đóng lại nó.
  if (replyBuffer.trim() !== "") outcome.turns.push({ user_message: pendingUserMessage, reply: replyBuffer.trim(), questions: [] })
  return outcome
}

const postSse = async (pathname: string, body: unknown): Promise<Response> =>
  fetch(`${ARGS.api}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body)
  })

const spineVersion = async (projectId: string): Promise<number> =>
  (await call<{ spine_version: number }>("GET", `/projects/${projectId}/spine`)).spine_version

/**
 * Dừng nếu project đã có hội thoại hoặc quyết định cũ.
 *
 * Một project nhìn thì trống (chưa bước nào accepted) vẫn có thể mang hội thoại của lần dùng trước, và chủ đề
 * đã chốt ở đó nằm trong sổ quyết định. Luật "không hỏi lại điều đã chốt" khi ấy làm AI bỏ hẳn những thẻ mà
 * ca đo sinh ra để đo — số đo trông như một đợt tụt chất lượng trong khi AI làm đúng. Gặp thật: một project
 * đã trả lời thẻ Tuân thủ từ lần trước, lượt đo sau đó không còn thẻ nào về nền tảng lẫn tuân thủ.
 *
 * Sai kiểu này không có dấu hiệu nào trong báo cáo, nên phải chặn ở đây chứ không cảnh báo rồi chạy tiếp.
 */
const assertVirginProject = async (projectId: string): Promise<void> => {
  const [steps, spine, sessions] = await Promise.all([
    call<{ steps: Array<{ id: string; status: string }> }>("GET", `/projects/${projectId}/steps`),
    call<{ decisions: unknown[] }>("GET", `/projects/${projectId}/spine`),
    call<Array<{ _id: string; is_pipeline: boolean }>>("GET", `/projects/${projectId}/chats`)
  ])
  const accepted = steps.steps.filter((s) => s.status === "accepted").map((s) => s.id)
  const decisions = spine.decisions.length
  const pipeline = sessions.find((s) => s.is_pipeline)
  const messages = pipeline
    ? (await call<{ messages?: unknown[] }>("GET", `/projects/${projectId}/chats/${pipeline._id}`)).messages?.length ?? 0
    : 0

  const dirt = [
    accepted.length > 0 ? `${accepted.length} bước đã chốt (${accepted.join(", ")})` : null,
    decisions > 0 ? `${decisions} chủ đề trong sổ quyết định` : null,
    messages > 0 ? `${messages} tin trong phiên chính` : null
  ].filter((x): x is string => x !== null)

  if (dirt.length > 0) {
    throw new Error(
      `--project ${projectId} không trắng: ${dirt.join("; ")}. Số đo sẽ sai mà không có dấu hiệu nào — AI bỏ qua ` +
        "những thẻ mà ca đo sinh ra để đo, vì chủ đề đã chốt từ lần dùng trước. Dùng project khác hoặc bỏ --project để tạo mới."
    )
  }
}

/** Chạy B-0.1 với ý tưởng của ca, ghi mọi thẻ, tới cổng chốt. */
const driveB01 = async (projectId: string, sessionId: string, idea: string, baseVersion: number): Promise<DriveOutcome> => {
  const res = await postSse(`/projects/${projectId}/steps/${STEP_ID}/run`, { session_id: sessionId, base_version: baseVersion, message: idea })
  return driveSse(projectId, sessionId, res, { message: idea })
}

/**
 * Từ cổng chốt B-0.1 đi tới lượt hỏi gộp đầu B-1 và ghi thẻ của lượt đó.
 *
 * Duyệt cổng đang chờ rồi chạy giai đoạn, lặp lại nếu trên đường còn cổng khác: đường bình thường không lặp
 * lần nào vì B-0.2/B-0.3 tự chốt và server sang B-1 ngay trên cùng luồng.
 */
const driveToB1Interview = async (projectId: string, sessionId: string, gateAt: string): Promise<DriveOutcome> => {
  const merged: DriveOutcome = { turns: [], error: null, reachedGate: false, pendingGate: gateAt, reachedB1Interview: false }

  for (let round = 0; round < MAX_GATES_TO_B1 && merged.pendingGate !== null; round++) {
    const gateStep = merged.pendingGate
    try {
      await call("POST", `/projects/${projectId}/steps/${gateStep}/gate`, { session_id: sessionId, action: "accept", base_version: await spineVersion(projectId) })
      log(`      v duyệt ${gateStep}`)
    } catch (err) {
      merged.error = `duyệt cổng ${gateStep} lỗi: ${String(err)}`
      return merged
    }

    const res = await postSse(`/projects/${projectId}/phases/${B0_UNIT}/run`, { session_id: sessionId, base_version: await spineVersion(projectId) })
    const outcome = await driveSse(projectId, sessionId, res, { stopAtB1Interview: true })

    merged.turns.push(...outcome.turns)
    merged.reachedGate = merged.reachedGate || outcome.reachedGate
    merged.reachedB1Interview = outcome.reachedB1Interview
    merged.error = outcome.error
    merged.pendingGate = outcome.reachedB1Interview ? null : outcome.pendingGate

    if (outcome.reachedB1Interview || outcome.error !== null) return merged
  }

  if (merged.error === null && !merged.reachedB1Interview) {
    merged.error = `không tới được lượt phỏng vấn ${B1_UNIT} sau ${MAX_GATES_TO_B1} lần duyệt cổng`
  }
  return merged
}

const runCase = async (c: EvalCase, onResult: (r: RunResult) => void): Promise<void> => {
  for (let run = 1; run <= ARGS.runs; run++) {
    await login()
    const projectId =
      ARGS.project ?? (await call<{ _id: string }>("POST", "/projects", { name: `Brief eval ${c.id} ${ARGS.label} #${run}`, domain: "General" }))._id
    if (ARGS.project) await assertVirginProject(projectId)
    let result: RunResult
    try {
      const sessions = await call<Array<{ _id: string; is_pipeline: boolean }>>("GET", `/projects/${projectId}/chats`)
      const session = sessions.find((s) => s.is_pipeline) ?? (await call<{ _id: string }>("POST", `/projects/${projectId}/chats`, {}))
      const b01 = await driveB01(projectId, session._id, c.idea, await spineVersion(projectId))
      // Spine đọc NGAY sau B-0.1: `form_factor`/`stakes`/giả định của luồng Brief do chính bước này ghi, chạy
      // tiếp sang B-1 rồi mới đọc thì lẫn cả thứ B-1 vừa viết vào số đo của B-0.1.
      const spine = await readSpine(projectId)

      const b1 = b01.error === null && b01.reachedGate ? await driveToB1Interview(projectId, session._id, STEP_ID) : null
      const recorded: RecordedRun = { case_id: c.id, turns: [...b01.turns, ...(b1?.turns ?? [])], spine }
      const error =
        b01.error ?? (b01.reachedGate ? null : "không tới được cổng chốt") ?? b1?.error ?? null
      result = {
        caseId: c.id,
        run,
        projectId,
        ok: error === null && (b1?.reachedB1Interview ?? false),
        error,
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
  ["nhãn lồng thiếu ranh giới", (m) => m.nested_labels_without_edge],
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
    lines.push(
      `**Lượt ${i + 1}**${turn.step_id ? ` · \`${turn.step_id}\`` : ""} — user: _${turn.user_message.slice(0, 200)}_`,
      "",
      `> ${turn.reply.replace(/\n/g, "\n> ")}`,
      ""
    )
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
