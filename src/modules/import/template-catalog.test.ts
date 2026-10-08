import { describe, expect, it } from "vitest"
import { isKnownSectionId } from "./section-catalog.js"
import { TEMPLATE_CATALOGS } from "./template-catalog.js"

describe("template-catalog (FLF-252)", () => {
  for (const [family, entries] of Object.entries(TEMPLATE_CATALOGS)) {
    it(`${family}: id không trùng; đích là section FPT có thật hoặc keep / feature / parent; có tên`, () => {
      const ids = entries.map((e) => e.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const e of entries) {
        expect(e.titles.length).toBeGreaterThan(0)
        expect(["keep", "feature", "parent"].includes(e.target) || isKnownSectionId(e.target)).toBe(true)
        expect(e.target).not.toBe("unmapped")
      }
      // Revision History luôn thành Record of Changes
      expect(entries.find((e) => e.titles.includes("Revision History"))?.target).toBe("fixed:I")
    })
  }
})
