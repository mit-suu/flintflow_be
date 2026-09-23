/**
 * screens-flow.e2e — S-4.1 → S-4.4 với PROVIDER THẬT. Chỉ chạy khi `E2E_AI=1`
 * (`npm run test:e2e-ai -- test/e2e-ai/screens-flow.e2e.test.ts`).
 *
 * Đo mức model tuân thủ luật mới của `content/screens-and-flow` + renderer `screen-flow`:
 *   1. không màn mồ côi (`orphanScreens` rỗng sau S-4.4),
 *   2. không cặp màn trỏ qua lại trong `flow_to` (luồng một chiều),
 *   3. Screens Flow tự tách một hình cho mỗi actor người có màn (pipeline tự vẽ lại sau S-4.3/S-4.4),
 *   4. không màn nào chỉ phục vụ actor system/time.
 * Đầu vào: fixture 19 màn ở trạng thái vừa xong S-3 — giữ project/actors/roles/use cases/entities/NFR, bỏ mọi
 * feature/màn/function/quyền. Elicit tự trả lời bằng lựa chọn đầu hoặc câu mặc định, gate luôn `accept`.
 * Kết quả ghi `test/e2e-ai/results/screens-flow-<ISO>.md`.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { seedFixture } from "../setup.js"

const enabled = process.env.E2E_AI === "1"
const STEPS = ["S-4.1", "S-4.2", "S-4.3", "S-4.4"] as const
const AUTO_ANSWER = "Use the product brief and your best judgement; keep it consistent with the existing Spine."

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, "results")

describe.skipIf(!enabled)("Screens Flow theo actor, không màn mồ côi — provider thật (E2E_AI=1)", () => {
  it("S-4.1 → S-4.4", { timeout: 20 * 60_000 }, async () => {
    const { orderedSteps } = await import("../../src/modules/pipeline/step-registry.js")
    const { runStep, submitAnswer } = await import("../../src/modules/pipeline/step-runner.service.js")
    const { gate } = await import("../../src/modules/pipeline/gate.service.js")
    const repo = await import("../../src/modules/spine/spine.repository.js")
    const { orphanScreens } = await import("../../src/modules/spine/deterministic-check.js")
    const { screenActorMap } = await import("../../src/modules/spine/screen-actors.js")
    const { renderScreenFlow, screenFlowTitleOf } = await import("../../src/modules/diagram/renderers/screen-flow.renderer.js")
    const { createMemoryDiagramStore } = await import("../../src/modules/diagram/diagram-file.store.js")
    const { Usage } = await import("../../src/modules/spine/usage.model.js")
    type Spine = import("../../src/modules/spine/spine.types.js").Spine

    const seeded = await seedFixture("full", {
      balance: 5000,
      mutate: (raw) => {
        const s = raw as unknown as Spine
        s.features = []
        s.screens = []
        s.functions = []
        s.permissions = []
        s.messages = []
        s.flags = []
        s.baselines = []
        s.diagrams = s.diagrams.filter((d) => d.kind === "context" || d.kind === "usecase")
        s.use_cases = s.use_cases.map((u) => ({ ...u, function_ids: [] }))
        s.business_rules = s.business_rules.map((b) => ({ ...b, source_validation_ids: [] }))
        s.progress.screen_queue = []
        s.progress.current_phase = "S-3"
        s.progress.current_step = "S-3.6"
        const all = orderedSteps({ screens: [], functions: [] })
        s.steps = all
          .slice(0, all.findIndex((x) => x.id === "S-4.1"))
          .map((x) => ({ id: x.id, status: "accepted" as const, first_seq: 1, last_seq: 1, accepted_at: "2026-01-01T00:00:00.000Z" }))
      }
    })
    const { projectId, sessionId, userId } = seeded

    // PlantUML giả: đo luật dữ liệu + puml, không phụ thuộc server render
    const renderDeps = {
      check: async () =>
        ({ ok: true, method: "svg-scan", render: { format: "svg", data: Buffer.from("<svg/>"), contentType: "image/svg+xml", transport: "post", status: 200, diagnostics: {} } }) as never,
      renderPng: async () => Buffer.from("png"),
      store: createMemoryDiagramStore()
    }

    const log: string[] = []
    for (const stepId of STEPS) {
      const started = Date.now()
      let error: string | undefined
      try {
        await runStep(projectId, stepId, sessionId, userId, (event) => {
          if (event.type === "answer_needed") {
            const answers = event.questions.map((q) => ({ question_id: q.id, answer: q.options?.[0] ?? AUTO_ANSWER }))
            setImmediate(() => submitAnswer(projectId, stepId, sessionId, answers))
          }
          if (event.type === "error") error = `${event.code}: ${event.message}`
        }, { renderDeps })
        const record = (await repo.get(projectId))!
        await gate(projectId, stepId, userId, { action: "accept", base_version: record.spine_version }, { renderDeps })
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
      const s = (await repo.get(projectId))!
      log.push(`| ${stepId} | ${s.screens.length} | ${s.permissions.length} | ${s.use_cases.filter((u) => u.function_ids.length > 0).length} | ${s.diagrams.filter((d) => d.kind === "screen_flow").length} | ${Math.round((Date.now() - started) / 1000)} | ${error ?? ""} |`)
    }

    const spine = (await repo.get(projectId))!
    const humans = spine.actors.filter((a) => a.kind === "human")
    const actorsOf = screenActorMap(spine)
    const orphans = orphanScreens(spine)
    const ids = new Set(spine.screens.map((x) => x.id))
    const twoWay = spine.screens.flatMap((a) =>
      a.flow_to.filter((b) => b > a.id && ids.has(b) && spine.screens.find((x) => x.id === b)!.flow_to.includes(a.id)).map((b) => `${a.id}⇄${b}`)
    )
    const parts = renderScreenFlow(spine)
    const titles = parts.map((p) => screenFlowTitleOf(p.puml) ?? "(không tiêu đề)")
    const storedFlow = spine.diagrams.filter((d) => d.kind === "screen_flow")
    const storedTitles = storedFlow.map((d) => screenFlowTitleOf(d.puml) ?? "(không tiêu đề)")
    const humansWithScreens = humans.filter((a) => [...actorsOf.values()].some((v) => v.includes(a.id)))
    const usages = await Usage.find({ projectId, state: "deducted" }).lean()

    const checks = [
      { name: "Không màn mồ côi", pass: orphans.length === 0, detail: orphans.map((o) => `${o.screen.id} ${o.screen.name}: ${o.why}`).join("; ") || "—" },
      { name: "Luồng một chiều trong dữ liệu (không cặp A⇄B)", pass: twoWay.length === 0, detail: twoWay.join(", ") || "—" },
      {
        name: "Hình lưu trong Spine đã tách theo actor (tự vẽ lại)",
        pass: storedFlow.length === humansWithScreens.length && storedTitles.every((t) => t.startsWith("Screens flow for ")),
        detail: storedTitles.join(" · ")
      },
      { name: "Mỗi actor người có ≥ 1 màn", pass: humansWithScreens.length === humans.length, detail: humans.filter((a) => !humansWithScreens.includes(a)).map((a) => a.name).join(", ") || "—" }
    ]

    const report = [
      `# Screens Flow theo actor — provider thật (${new Date().toISOString()})`,
      "",
      "Sinh bởi `test/e2e-ai/screens-flow.e2e.test.ts`. Đầu vào: fixture 19 màn đã bỏ mọi feature/màn/function/quyền (trạng thái sau S-3).",
      "",
      "| Step | Màn | Quyền | UC gắn function | Hình screen_flow | Giây | Lỗi |",
      "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
      ...log,
      "",
      "| Kiểm | Kết quả | Chi tiết |",
      "| --- | --- | --- |",
      ...checks.map((c) => `| ${c.name} | ${c.pass ? "PASS" : "FAIL"} | ${c.detail.replace(/\|/g, "/")} |`),
      "",
      `Hình renderer (Spine cuối): ${titles.join(" · ")}`,
      "",
      `Lượt gọi model: ${usages.length} · token in ${usages.reduce((n, u) => n + (u.tokens_in ?? 0), 0)} · out ${usages.reduce((n, u) => n + (u.tokens_out ?? 0), 0)} · credit ${usages.reduce((n, u) => n + (u.cost ?? 0), 0)}`,
      "",
      "## Màn sinh ra",
      "",
      "| Id | Tên | Popup | flow_to | Actor người |",
      "| --- | --- | --- | --- | --- |",
      ...spine.screens.map(
        (x) => `| ${x.id} | ${x.name} | ${x.is_popup ? "✔" : ""} | ${x.flow_to.join(", ")} | ${(actorsOf.get(x.id) ?? []).map((a) => humans.find((h) => h.id === a)?.name ?? a).join(", ")} |`
      )
    ].join("\n")
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(path.join(OUT_DIR, `screens-flow-${new Date().toISOString().replace(/[:.]/g, "-")}.md`), `${report}\n`)
    console.log(report)

    expect(spine.screens.length).toBeGreaterThan(0)
    for (const c of checks) expect.soft(c.pass, `${c.name}: ${c.detail}`).toBe(true)
  })
})

describe.skipIf(enabled)("Screens Flow theo actor — provider thật", () => {
  it.skip("bỏ qua: đặt E2E_AI=1 để gọi provider thật (tốn credit)", () => {})
})
