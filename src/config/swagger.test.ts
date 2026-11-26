import { describe, expect, it } from "vitest"
import swaggerJsdoc from "swagger-jsdoc"
import { options } from "./swagger.js"

describe("swagger", () => {
  it("FLF-486: mọi JSDoc @openapi là YAML hợp lệ (failOnErrors) và có endpoint MCP google-docs", () => {
    const spec = swaggerJsdoc({ ...options, failOnErrors: true }) as { paths?: Record<string, Record<string, unknown>> }
    expect(spec.paths?.["/api/v1/mcp/google-docs"]?.post).toBeDefined()
  })
})
