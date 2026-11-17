import fs from "node:fs"
import type { docs_v1 } from "@googleapis/docs"

/** Google Doc mẫu đúng dạng `documents.get` (3 mục cấp 1, mục con, một bảng) — `fixtures/google-docs/sample-srs.json`. */
export const loadSampleDoc = (): docs_v1.Schema$Document =>
  JSON.parse(fs.readFileSync(new URL("../../../../fixtures/google-docs/sample-srs.json", import.meta.url), "utf8"))
