import { describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ env: { GOOGLE_DOCS_AGENT_ENABLED: false } }))
vi.mock("../../../config/env.js", () => ({ env: h.env }))

const { requireDocsAgentEnabled, GOOGLE_DOCS_AGENT_DISABLED } = await import("./docs-agent.guard.js")

const run = () => {
  const next = vi.fn()
  requireDocsAgentEnabled({} as never, {} as never, next)
  return next.mock.calls[0]?.[0] as { statusCode?: number; code?: string } | undefined
}

describe("requireDocsAgentEnabled", () => {
  it("cờ tắt ⇒ next(503 GOOGLE_DOCS_AGENT_DISABLED)", () => {
    h.env.GOOGLE_DOCS_AGENT_ENABLED = false
    expect(run()).toMatchObject({ statusCode: 503, code: GOOGLE_DOCS_AGENT_DISABLED })
  })

  it("cờ bật ⇒ next() không lỗi", () => {
    h.env.GOOGLE_DOCS_AGENT_ENABLED = true
    expect(run()).toBeUndefined()
  })
})
