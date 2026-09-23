/**
 * run-full-pipeline.ts — M4 / T24
 * ─────────────────────────────────────────────────────────────────
 * Lái **một project mới** đi trọn `B-0.1 → S-9.5 → assemble → Word → baseline` qua HTTP API thật,
 * provider thật (không mock, không fixture op-case). Dùng cho:
 *   - mốc **M4** (`claude_plan/plan-overview.md` §5): một lượt chạy thật, token ghi vào `docs/measurements.md`;
 *   - **smoke test sau deploy** (T24): chạy với `--until S-1.4` để kiểm nhanh mà không tốn nhiều credit.
 *
 * Cách dùng:
 *   npm run run:pipeline -- --email fixture@flintflow.io --password fixture-password-123
 *   npm run run:pipeline -- --api http://localhost:5000/api/v1 --until S-2.5 --name "Smoke"
 *
 * Cờ:
 *   --api URL          gốc API (mặc định http://localhost:5000/api/v1 hoặc $E2E_API_URL)
 *   --email/--password tài khoản (mặc định $E2E_EMAIL/$E2E_PASSWORD)
 *   --name TEN         tên project tạo mới
 *   --project ID       dùng lại project có sẵn thay vì tạo mới (chạy tiếp lượt dở)
 *   --until STEP       dừng sau khi accept step này (mặc định chạy tới hết)
 *   --max-steps N      trần số step (mặc định 200) — chặn vòng lặp vô hạn
 *   --waive-blocking   waive cờ đỏ chặn baseline rồi ký `-conditional` (mặc định: dừng và báo cáo)
 *   --no-brief         không gửi Brief MediQueue — project đã có brief trong Spine (vd. nạp sẵn bởi eval-usecase-s3)
 *   --out FILE         file báo cáo markdown (mặc định test/e2e-ai/results/full-pipeline-<ISO>.md)
 *
 * Script **không** tự nạp credit và **không** đụng vào Spine bằng đường nào khác ngoài API công khai.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../..")

// ─── Brief dùng để trả lời câu hỏi Elicit ────────────────────────────
/**
 * Một sản phẩm **không phải FlintFlow** để lượt chạy không vô tình lặp lại nội dung đã có sẵn trong
 * skill. Đủ dày để model rút ra được actor ngoài, job nền, NFR có số — đúng các thứ DoD của pha
 * Discovery và pha S cần.
 */
const BRIEF = `Product: MediQueue — appointment booking and live queue management for multi-branch outpatient clinics in Vietnam.

Problem: patients queue physically from 6am for a paper number; receptionists juggle phone bookings on spreadsheets; doctors have no reliable view of who is next; clinic owners cannot see utilisation across branches.

Target users: (1) patients booking for themselves or a family member; (2) receptionists at the front desk; (3) doctors and nurses in consultation rooms; (4) clinic administrators managing branches, schedules and reports.

MVP scope (release 1.0): online appointment booking with slot picking; walk-in ticket issuing at a self check-in kiosk; a live queue board per room; doctor consultation console showing the current and next patient; visit fee payment; automatic SMS and email reminders; clinic admin dashboard with branch, room, doctor-schedule and holiday setup, plus a utilisation report.

Out of scope for release 1.0: telemedicine video consultation, insurance claim submission, pharmacy stock management, lab result storage.

External systems the product must integrate with: VietQR payment gateway (QR payment plus an asynchronous payment-result webhook); an SMS gateway for reminder and queue-turn messages; a transactional email service for booking confirmations; the clinic's existing electronic medical record system, which MediQueue reads patient demographics from and writes visit summaries to over a nightly file exchange; a scheduled background job that sends reminders 24 hours and 2 hours before each appointment and expires no-show tickets.

Success metrics: median wait time down from 65 to under 25 minutes; at least 60% of visits booked online within 6 months; no-show rate under 10%; receptionist handling time per booking under 90 seconds.

Non-functional requirements: p95 page response under 2 seconds; queue board updates within 5 seconds of a state change; 99.5% monthly availability during clinic hours 06:00-20:00; support 500 concurrent users and 50 clinics; patient personal data encrypted at rest and in transit, access audited, audit log retained 5 years; the system must comply with Vietnamese personal data protection decree 13/2023; responsive web on desktop and mobile browsers, Vietnamese and English UI.

Constraints: web only for release 1.0 (no native app); 4-month MVP timeline; team of 6; cloud hosting; the clinic chain already uses the EMR system and will not replace it.

Risks and open questions: EMR file-exchange format is not finalised; some branches have unreliable internet and need the kiosk to work briefly offline; walk-in versus booked priority rules differ per branch.`

// ─── Tham số ────────────────────────────────────────────────────────

interface Args {
  api: string
  email: string
  password: string
  name: string
  projectId: string | null
  until: string | null
  maxSteps: number
  waiveBlocking: boolean
  noBrief: boolean
  out: string
}

const parseArgs = (): Args => {
  const argv = process.argv.slice(2)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const args: Args = {
    api: process.env.E2E_API_URL ?? "http://localhost:5000/api/v1",
    email: process.env.E2E_EMAIL ?? "fixture@flintflow.io",
    password: process.env.E2E_PASSWORD ?? "fixture-password-123",
    name: `M4 full run ${stamp}`,
    projectId: null,
    until: null,
    maxSteps: 200,
    waiveBlocking: false,
    noBrief: false,
    out: path.join(REPO_ROOT, "test/e2e-ai/results", `full-pipeline-${stamp}.md`)
  }
  for (let i = 0; i < argv.length; i++) {
    const next = (): string => argv[++i] as string
    switch (argv[i]) {
      case "--api":
        args.api = next()
        break
      case "--email":
        args.email = next()
        break
      case "--password":
        args.password = next()
        break
      case "--name":
        args.name = next()
        break
      case "--project":
        args.projectId = next()
        break
      case "--until":
        args.until = next()
        break
      case "--max-steps":
        args.maxSteps = Number(next())
        break
      case "--no-brief":
        args.noBrief = true
        break
      case "--waive-blocking":
        args.waiveBlocking = true
        break
      case "--out":
        args.out = path.resolve(next())
        break
      default:
        throw new Error(`Cờ không nhận ra: ${argv[i]}`)
    }
  }
  return args
}

const ARGS = parseArgs()

// ─── HTTP ───────────────────────────────────────────────────────────

let TOKEN = ""

interface Envelope<T> {
  data: T
  meta?: Record<string, unknown>
  error: { code: string; message: string } | null
}

class ApiFail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(`${status} ${code}: ${message}`)
  }
}

/** Access token sống 15 phút (ACCESS_TOKEN_EXPIRES); một lượt chạy trọn lâu hơn thế nhiều. */
const relogin = async (): Promise<void> => {
  const res = await fetch(`${ARGS.api}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ARGS.email, password: ARGS.password })
  })
  const json = (await res.json()) as Envelope<{ accessToken: string }>
  if (!res.ok || json.error) throw new ApiFail(res.status, json.error?.code ?? "LOGIN_FAILED", json.error?.message ?? "")
  TOKEN = json.data.accessToken
}

const EXPIRED_TOKEN_CODES = new Set(["INVALID_ACCESS_TOKEN", "TOKEN_EXPIRED", "UNAUTHORIZED"])

const call = async <T>(method: string, pathname: string, body?: unknown, retried = false): Promise<Envelope<T>> => {
  const res = await fetch(`${ARGS.api}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await res.text()
  let json: Envelope<T>
  try {
    json = JSON.parse(text) as Envelope<T>
  } catch {
    throw new ApiFail(res.status, "NON_JSON", text.slice(0, 300))
  }
  if (!res.ok || json.error) {
    const code = json.error?.code ?? "UNKNOWN"
    if (res.status === 401 && EXPIRED_TOKEN_CODES.has(code) && !retried && TOKEN) {
      await relogin()
      return call<T>(method, pathname, body, true)
    }
    throw new ApiFail(res.status, code, json.error?.message ?? text.slice(0, 200))
  }
  return json
}

const log = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

// ─── Trả lời câu hỏi Elicit ─────────────────────────────────────────

interface Question {
  id: string
  text: string
  options?: string[]
  multiple?: boolean
}

let briefSent = ARGS.noBrief

/**
 * Câu hỏi đầu tiên của cả lượt chạy nhận trọn Brief; từ đó trở đi Brief đã nằm trong Spine
 * (`project`, `addendum`, `assumptions`) và được projection đưa vào prompt, nên chỉ cần một câu
 * hướng dẫn ngắn — gửi lại Brief mỗi lượt chỉ làm phình transcript và tốn token vô ích.
 */
const answerFor = (q: Question): string | string[] => {
  if (q.options?.length) {
    // Ưu tiên chế độ nhanh khi được hỏi (B-0.4 Working Mode) để một lượt chạy trọn không vượt ví.
    const fast = q.options.find((o) => /fast|nhanh|quick/i.test(o))
    const pick = fast ?? (q.options[0] as string)
    return q.multiple ? [pick] : pick
  }
  if (!briefSent) {
    briefSent = true
    return `${BRIEF}\n\n---\nAnswer the question above using these facts. If something is not covered, choose the most sensible option for this product, proceed, and record it as an assumption.`
  }
  return "Use the project brief and the document produced so far as the source of truth. If this question is not covered there, choose the most sensible option for this product, proceed without further questions, and record the choice as an assumption."
}

// ─── Chạy một step (SSE) ────────────────────────────────────────────

interface StepEvent {
  type: string
  [k: string]: unknown
}

interface RunOutcome {
  events: StepEvent[]
  gate: { actions: string[]; calls_used: number } | null
  error: { code: string; message: string; retryable: boolean } | null
  answerRounds: number
}

const MAX_ANSWER_ROUNDS = 6

const runStep = async (projectId: string, sessionId: string, stepId: string, baseVersion: number): Promise<RunOutcome> => {
  const open = (): Promise<Response> =>
    fetch(`${ARGS.api}/projects/${projectId}/steps/${stepId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ session_id: sessionId, base_version: baseVersion })
    })

  let res = await open()
  if (res.status === 401) {
    await relogin()
    res = await open()
  }

  const outcome: RunOutcome = { events: [], gate: null, error: null, answerRounds: 0 }
  const contentType = res.headers.get("content-type") ?? ""
  if (!contentType.startsWith("text/event-stream")) {
    const text = await res.text()
    let code = "NON_SSE"
    let message = text.slice(0, 300)
    try {
      const json = JSON.parse(text) as Envelope<unknown>
      code = json.error?.code ?? code
      message = json.error?.message ?? message
    } catch {
      /* giữ nguyên text thô */
    }
    outcome.error = { code, message, retryable: code === "SPINE_VERSION_CONFLICT" }
    return outcome
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  const handle = async (event: StepEvent): Promise<void> => {
    outcome.events.push(event)
    switch (event.type) {
      case "answer_needed": {
        outcome.answerRounds += 1
        const questions = (event.questions ?? []) as Question[]
        if (outcome.answerRounds > MAX_ANSWER_ROUNDS) {
          log(`      ! quá ${MAX_ANSWER_ROUNDS} lượt hỏi — bỏ qua, để step tự kết thúc`)
          return
        }
        log(`      ? ${questions.length} câu hỏi (lượt ${outcome.answerRounds})`)
        await call("POST", `/projects/${projectId}/steps/${stepId}/answer`, {
          session_id: sessionId,
          answers: questions.slice(0, 20).map((q) => ({ question_id: q.id, answer: answerFor(q) }))
        })
        break
      }
      case "render":
        log(`      · render ${String(event.diagram_id)} = ${String(event.render_status)}`)
        break
      case "flags":
        log(`      · cờ: ${String(event.red_open)} đỏ / ${String(event.yellow_open)} vàng`)
        break
      case "gate_ready":
        outcome.gate = { actions: (event.actions ?? []) as string[], calls_used: Number(event.calls_used ?? 0) }
        break
      case "error":
        outcome.error = {
          code: String(event.code),
          message: String(event.message),
          retryable: Boolean(event.retryable)
        }
        break
      default:
        break
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx = buffer.indexOf("\n\n")
    while (idx >= 0) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const payload = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("")
      if (payload) {
        try {
          await handle(JSON.parse(payload) as StepEvent)
        } catch (err) {
          if (err instanceof ApiFail) log(`      ! answer lỗi ${err.message}`)
          else log(`      ! event không xử lý được: ${String(err)}`)
        }
      }
      idx = buffer.indexOf("\n\n")
    }
  }
  return outcome
}

// ─── Vòng chính ─────────────────────────────────────────────────────

interface StepRecord {
  step: string
  seconds: number
  calls: number
  answerRounds: number
  action: string
  credit: number
  error: string
}

const spineVersion = async (projectId: string): Promise<number> => {
  const res = await call<{ spine_version: number }>("GET", `/projects/${projectId}/spine`)
  return res.data.spine_version
}

const balance = async (): Promise<number> => {
  const res = await call<{ balance: number }>("GET", "/billing/balance")
  return res.data.balance
}

/**
 * Step tới lượt chạy — cùng luật với `nextStep()` của BE: step đầu tiên chưa `accepted`, **bỏ qua**
 * vòng S-5 của màn `placeholder` (Phases §6.2 — placeholder đã được quyết định để lại, `pending`
 * mãi mãi).
 *
 * `POST /resume` và `GET /progress` nay đã trả `progress.current_step` theo cùng luật này
 * (`pipeline-progress.ts`); trước đó chúng trả con trỏ ghi lúc `/run` bắt đầu nên chạy tiếp một project
 * dở (`--project`) bị `STEP_NOT_RUNNABLE` — M4 2026-09-16, `docs/spec-gaps.md`. Giữ hàm này như chốt chặn
 * phía client khi script chạy với một BE chưa có sửa đó.
 */
const nextRunnableStep = async (projectId: string): Promise<string | null> => {
  const [steps, spine] = await Promise.all([
    call<{ steps: Array<{ id: string; status: string }> }>("GET", `/projects/${projectId}/steps`),
    call<{ screens: Array<{ id: string; detail_status: string }> }>("GET", `/projects/${projectId}/spine`)
  ])
  const placeholders = new Set(spine.data.screens.filter((s) => s.detail_status === "placeholder").map((s) => s.id))
  const loopOf = (stepId: string): string | null => (stepId.includes("@") ? (stepId.split("@")[1] as string) : null)
  return (
    steps.data.steps.find((s) => {
      const loop = loopOf(s.id)
      return s.status !== "accepted" && !(loop !== null && placeholders.has(loop))
    })?.id ?? null
  )
}

const main = async (): Promise<void> => {
  // 1. Đăng nhập
  const login = await call<{ accessToken: string }>("POST", "/auth/login", { email: ARGS.email, password: ARGS.password })
  TOKEN = login.data.accessToken
  const startBalance = await balance()
  log(`Đăng nhập ${ARGS.email} — ví ${startBalance} credit`)

  // 2. Project + session pipeline
  let projectId = ARGS.projectId
  if (!projectId) {
    const created = await call<{ _id: string }>("POST", "/projects", { name: ARGS.name, domain: "Healthcare" })
    projectId = created.data._id
    log(`Tạo project ${projectId} — "${ARGS.name}"`)
  } else {
    log(`Dùng lại project ${projectId}`)
  }

  const sessions = await call<Array<{ _id: string; is_pipeline: boolean }>>("GET", `/projects/${projectId}/chats`)
  let session = sessions.data.find((s) => s.is_pipeline)
  if (!session) {
    const createdSession = await call<{ _id: string; is_pipeline: boolean }>("POST", `/projects/${projectId}/chats`, {})
    session = createdSession.data
  }
  const sessionId = session._id
  log(`Session pipeline ${sessionId}`)

  // 3. Resume — trả về step đang tới lượt
  const resumed = await call<{
    reverted_step: string | null
    spine_version: number
    progress: { progress: { current_step: string | null; total: number } }
  }>("POST", `/projects/${projectId}/resume`)
  let current = (await nextRunnableStep(projectId)) ?? resumed.data.progress.progress.current_step
  log(`Bắt đầu ở ${current ?? "(chưa có)"} — tổng ${resumed.data.progress.progress.total} step\n`)

  // 4. Vòng step
  const records: StepRecord[] = []
  let stopReason = "hết step"
  let stepCount = 0

  while (current && stepCount < ARGS.maxSteps) {
    if (current === "S-9.5") {
      stopReason = "tới S-9.5 — ký baseline"
      break
    }
    stepCount += 1
    const started = Date.now()
    const before = await balance()
    let version = await spineVersion(projectId)
    log(`[${stepCount}] ${current}`)

    let outcome = await runStep(projectId, sessionId, current, version)
    if (outcome.error?.retryable) {
      log(`      ! ${outcome.error.code} — thử lại một lần`)
      version = await spineVersion(projectId)
      outcome = await runStep(projectId, sessionId, current, version)
    }

    const after = await balance()
    const record: StepRecord = {
      step: current,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      calls: outcome.gate?.calls_used ?? 0,
      answerRounds: outcome.answerRounds,
      action: "",
      credit: before - after,
      error: outcome.error ? outcome.error.code : ""
    }

    // Step đã accepted từ lượt chạy trước (chạy tiếp bằng `--project`): bỏ qua, đi tiếp.
    if (!outcome.gate && outcome.error?.code === "STEP_NOT_RUNNABLE") {
      const next = await nextRunnableStep(projectId)
      if (next && next !== current) {
        log(`      · ${current} đã accepted — nhảy tới ${next}`)
        stepCount -= 1
        current = next
        continue
      }
    }

    if (!outcome.gate) {
      record.action = "—"
      records.push(record)
      stopReason = `step ${current} không tới được gate: ${outcome.error?.code ?? "không rõ"} — ${outcome.error?.message ?? ""}`
      log(`      x ${stopReason}`)
      break
    }

    // Gate: accept nếu có; nếu không (vd S-5.1 chỉ cho accept_as_is) thì accept_as_is kèm lý do.
    const action = outcome.gate.actions.includes("accept") ? "accept" : "accept_as_is"
    record.action = action
    const gateBody: Record<string, unknown> = {
      session_id: sessionId,
      action,
      base_version: await spineVersion(projectId),
      ...(action === "accept_as_is" ? { note: "Lượt chạy M4 tự động: chấp nhận nguyên trạng để đi tiếp" } : {})
    }
    let gated: Envelope<{ next_step: string | null }>
    try {
      gated = await call<{ next_step: string | null }>("POST", `/projects/${projectId}/steps/${current}/gate`, gateBody)
    } catch (err) {
      record.error = err instanceof ApiFail ? err.code : String(err)
      records.push(record)
      stopReason = `gate ${current} lỗi: ${record.error}`
      log(`      x ${stopReason}`)
      break
    }

    records.push(record)
    log(`      v ${action} (${record.calls} lượt gọi, ${record.credit} credit, ${record.seconds}s) -> ${gated.data.next_step ?? "hết"}`)

    if (ARGS.until && current === ARGS.until) {
      stopReason = `dừng theo --until ${ARGS.until}`
      current = gated.data.next_step
      break
    }
    current = gated.data.next_step
  }
  if (stepCount >= ARGS.maxSteps) stopReason = `chạm trần --max-steps ${ARGS.maxSteps}`

  // 5. Assemble + Word + baseline (chỉ khi đi trọn tới S-9.5)
  let assembled = ""
  let docx = ""
  let baselineLine = ""
  const waived: string[] = []

  if (current === "S-9.5") {
    try {
      const asm = await call<{ sections: number }>("POST", `/projects/${projectId}/assemble`, { base_version: await spineVersion(projectId) })
      assembled = `${asm.data.sections} section`
      log(`\nAssemble: ${assembled}`)
    } catch (err) {
      assembled = `lỗi ${err instanceof ApiFail ? err.code : String(err)}`
      log(`\nAssemble thất bại: ${assembled}`)
    }

    try {
      const res = await fetch(`${ARGS.api}/projects/${projectId}/export/word`, { headers: { Authorization: `Bearer ${TOKEN}` } })
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        const file = path.join(path.dirname(ARGS.out), `${path.basename(ARGS.out, ".md")}.docx`)
        fs.writeFileSync(file, buf)
        docx = `${Math.round(buf.length / 1024)} KB -> ${path.relative(REPO_ROOT, file)}`
      } else {
        docx = `HTTP ${res.status}`
      }
      log(`Word: ${docx}`)
    } catch (err) {
      docx = `lỗi ${String(err)}`
    }

    const signBaseline = async (): Promise<Envelope<{ version: string; waived_count: number }>> =>
      call<{ version: string; waived_count: number }>("POST", `/projects/${projectId}/baseline`, { base_version: await spineVersion(projectId) })

    try {
      const signed = await signBaseline()
      baselineLine = `${signed.data.version} (waived ${signed.data.waived_count})`
    } catch (err) {
      if (err instanceof ApiFail && err.code === "BASELINE_BLOCKED" && ARGS.waiveBlocking) {
        const flags = await call<Array<{ id: string; rule_id: string; level: string; open: boolean }>>(
          "GET",
          `/projects/${projectId}/flags?level=red&open=true`
        )
        for (const flag of flags.data) {
          try {
            await call("POST", `/projects/${projectId}/flags/${flag.id}/waive`, {
              reason: `Lượt chạy M4 tự động: waive ${flag.rule_id} để ký baseline có điều kiện`
            })
            waived.push(flag.rule_id)
          } catch (waiveErr) {
            log(`  ! waive ${flag.rule_id} lỗi: ${String(waiveErr)}`)
          }
        }
        try {
          const signed = await signBaseline()
          baselineLine = `${signed.data.version} (waived ${signed.data.waived_count})`
        } catch (retryErr) {
          baselineLine = `thất bại sau waive: ${String(retryErr)}`
        }
      } else {
        baselineLine = err instanceof ApiFail ? `${err.code} — ${err.message}` : String(err)
      }
    }
    log(`Baseline: ${baselineLine}`)
  }

  // 6. Báo cáo
  const endBalance = await balance()
  const totalCredit = startBalance - endBalance
  const progress = await call<{
    readiness: { accepted_pct: number; red_open: number; stale: number }
    progress: { done: number; total: number }
  }>("GET", `/projects/${projectId}/progress`)

  const rows = records
    .map((r) => `| ${r.step} | ${r.calls} | ${r.answerRounds} | ${r.action} | ${r.credit} | ${r.seconds} | ${r.error} |`)
    .join("\n")

  const report = `# Lượt chạy trọn pipeline — provider thật (M4)

- Thời điểm: ${new Date().toISOString()}
- API: ${ARGS.api}
- Project: \`${projectId}\` — "${ARGS.name}"
- Step chạy: **${records.length}** / ${progress.data.progress.total} · done ${progress.data.progress.done}
- Dừng vì: ${stopReason}
- Credit tiêu: **${totalCredit}** (ví ${startBalance} → ${endBalance})
- Readiness cuối: accepted ${progress.data.readiness.accepted_pct}% · đỏ mở ${progress.data.readiness.red_open} · stale ${progress.data.readiness.stale}
${assembled ? `- Assemble: ${assembled}` : ""}
${docx ? `- Word: ${docx}` : ""}
${baselineLine ? `- Baseline: ${baselineLine}` : ""}
${waived.length ? `- Cờ đã waive: ${waived.join(", ")}` : ""}

| Step | Lượt gọi | Lượt hỏi | Gate | Credit | Giây | Lỗi |
| --- | ---: | ---: | --- | ---: | ---: | --- |
${rows}
`

  fs.mkdirSync(path.dirname(ARGS.out), { recursive: true })
  fs.writeFileSync(ARGS.out, report, "utf8")
  log(`\nBáo cáo: ${path.relative(REPO_ROOT, ARGS.out)}`)
  log(`Tổng: ${records.length} step, ${totalCredit} credit, dừng vì ${stopReason}`)
  process.exit(records.length > 0 && !records[records.length - 1].error ? 0 : 1)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
