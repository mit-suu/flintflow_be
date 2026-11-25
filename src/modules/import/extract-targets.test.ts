import { describe, expect, it } from "vitest"
import { schemaExcerptFor } from "./extract-targets.js"

describe("schemaExcerptFor - loại yêu cầu chung (bug #3 FLF-447)", () => {
  it("liệt kê khoá loại để model trả `security` thay vì chữ tự do 'Bảo mật'", () => {
    const hint = schemaExcerptFor(["common_requirements"])
    for (const key of ["security", "session", "audit", "localization", "date_format"]) expect(hint).toContain(`"${key}"`)
    expect(hint).toContain("statement")
  })
})
