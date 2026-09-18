/**
 * Helper test mode 1 (FLF-171): tạo project mode import, client HTTP, provider giả trả output đúng schema
 * của các ActionType mode 1 theo nội dung prompt.
 */
import request from "supertest"
import { expect } from "vitest"
import app from "../../src/app.js"
import type { SeededFixture } from "../setup.js"

export const createMode1Project = async (seeded: SeededFixture, name = "Lumen import"): Promise<string> => {
  const res = await request(app).post("/api/v1/projects").set("Authorization", `Bearer ${seeded.token}`).send({ name, mode: "import" })
  expect(res.status, JSON.stringify(res.body.error)).toBe(201)
  return String(res.body.data._id)
}

export const mode1Api = (seeded: SeededFixture, projectId: string) => {
  const auth = { Authorization: `Bearer ${seeded.token}` }
  const base = `/api/v1/projects/${projectId}`
  return {
    base,
    upload: (buf: Buffer, name = "SRS_Lumen.docx", path = "/import") => request(app).post(`${base}${path}`).set(auth).attach("file", buf, name),
    get: (suffix: string) => request(app).get(`${base}${suffix}`).set(auth),
    post: (suffix: string, body: object = {}) => request(app).post(`${base}${suffix}`).set(auth).send(body),
    patch: (suffix: string, body: object) => request(app).patch(`${base}${suffix}`).set(auth).send(body),
    spineVersion: async () => (await request(app).get(`${base}/spine`).set(auth)).body.data.spine_version as number
  }
}

const firstBlock = (prompt: string, after: string): string => {
  const tail = prompt.slice(prompt.indexOf(after))
  return /\[(B\d{4,})\]/.exec(tail)?.[1] ?? "B0001"
}

/** Output I-4 giả theo section trong prompt (khớp `makeSrsDocx`). */
export const fakeImportExtract = (prompt: string): string | undefined => {
  if (!prompt.includes("# Import Extract")) return undefined
  const section = /Section \(registry id\): (\S+)/.exec(prompt)?.[1] ?? "fixed:1"
  const b = firstBlock(prompt, "Blocks of the section")
  const item = (entity: string, key: string | null, value: object, confidence = 0.9, field_confidence: object = {}) => ({
    entity,
    key,
    value,
    confidence,
    field_confidence,
    source_block_ids: [b]
  })
  let items: object[] = []
  if (section === "fixed:1") items = [item("project", null, { vision: "Lumen is an online learning platform for small training centers." })]
  else if (section === "fixed:2.2.1") items = [item("use_cases", "UC-02", { name: "Log in", actor_ids: ["Learner"] })]
  else if (section === "fixed:3.1.2") items = [item("screens", "SCR-01", { name: "Login screen", description: "Lets the learner sign in." })]
  else if (section === "fixed:4.2.3")
    items = [item("nfrs", "NFR-01", { statement: "The system shall respond within 2 seconds for 95% of requests.", kind: "quantitative", metric: "response time", threshold: "2 s" })]
  else if (section.startsWith("function:"))
    items = [item("functions", null, { trigger: "Learner submits the form", normal: ["Enter email", "Submit"], abnormal: ["Wrong password"] }, 0.85, { trigger: 0.5 })]
  return JSON.stringify({ section_id: section, items, unmapped_block_ids: [] })
}

export const fakeSemanticCheck = (prompt: string): string | undefined => {
  if (!prompt.includes("# Import Semantic Check")) return undefined
  const b = /\[(B\d{4,})\] \(fixed:4\.2\.3\)/.exec(prompt)?.[1] ?? "B0001"
  return JSON.stringify({ findings: [{ rule: "ambiguity", section_id: "fixed:4.2.3", message: "\"95% of requests\" needs a load profile.", block_ids: [b] }] })
}

export const fakeMode1 = (prompt: string): string | undefined => fakeImportExtract(prompt) ?? fakeSemanticCheck(prompt)
