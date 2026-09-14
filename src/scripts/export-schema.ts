/**
 * export-schema.ts
 * ─────────────────────────────────────────────────────────────────
 * Xuất JSON Schema của Spine từ zod (`spine.schema.ts`) ra
 * `assets/schema/srs-spine.schema.json`.
 *
 * Chạy: npm run schema:export
 * `spine.schema.test.ts` fail nếu file trên đĩa lệch với schema hiện tại.
 */

import fs from "node:fs"
import path from "node:path"
import { getAssetsRoot } from "../config/paths.js"
import { serializeJsonSchema } from "../modules/spine/spine.schema.js"

const outDir = path.join(getAssetsRoot(), "schema")
const outFile = path.join(outDir, "srs-spine.schema.json")

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(outFile, serializeJsonSchema(), "utf8")

console.log(`✅ Đã ghi ${path.relative(process.cwd(), outFile)}`)
