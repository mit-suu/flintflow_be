/**
 * Đo tìm đoạn tài liệu upload (FLF-393) trên một file thật — không DB, không gọi model.
 *
 *   npm run eval:doc-retrieval                                 # SRS mẫu + bộ câu hỏi mẫu
 *   npm run eval:doc-retrieval -- --file <đường dẫn> --questions <json> [--top-k 10] [--max-tokens 12000]
 *   npm run eval:doc-retrieval -- --file <đường dẫn> --outline # chỉ in cây chunk (soi chunker)
 *
 * In: số chunk, token nếu gửi toàn văn so với token mỗi câu hỏi sau khi chọn, recall theo nhóm câu hỏi, câu trượt.
 */

import fs from "node:fs"
import path from "node:path"
import { env } from "../config/env.js"
import { parseFileContent } from "../shared/utils/file-text.js"
import { formatCodedParagraphs, splitParagraphs } from "../shared/ai/document-paragraphs.js"
import { chunkParagraphs, estimateDocTokens } from "../shared/ai/document-retrieval/chunker.js"
import { buildProjectIndex } from "../shared/ai/document-retrieval/chunk-index.service.js"
import { alignOutline, extractDocxHeadings, isDocx } from "../shared/ai/document-retrieval/docx-outline.js"
import { evaluateRetrieval, type RetrievalQuestion } from "../shared/ai/document-retrieval/eval-metrics.js"

const DEFAULT_FILE = "fixtures/existing-srs-fu-student-portal.docx"
const DEFAULT_QUESTIONS = "fixtures/doc-retrieval/questions-fu-student-portal.json"

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

const main = async (): Promise<void> => {
  const file = arg("file") ?? DEFAULT_FILE
  const extension = path.extname(file).toLowerCase()
  const buffer = fs.readFileSync(file)
  const mime = extension === ".pdf" ? "application/pdf" : extension === ".docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain"

  const { text } = await parseFileContent(buffer, mime, extension)
  const paragraphs = splitParagraphs(text)
  const outline = isDocx(mime, extension) ? alignOutline(paragraphs, await extractDocxHeadings(buffer)) : []
  const chunks = chunkParagraphs(paragraphs, outline)
  const fullTokens = estimateDocTokens(formatCodedParagraphs(1, text))

  console.log(`File: ${file}`)
  console.log(`Chữ: ${text.length} ký tự · ${paragraphs.length} đoạn · heading từ file: ${outline.length}`)
  console.log(`Chunk: ${chunks.length} · trung bình ${Math.round(chunks.reduce((s, c) => s + c.tokens, 0) / Math.max(1, chunks.length))} token · lớn nhất ${Math.max(0, ...chunks.map((c) => c.tokens))} token`)
  console.log(`Gửi toàn văn: ~${fullTokens} token mỗi lượt gọi`)

  if (flag("outline")) {
    for (const c of chunks) console.log(`#${c.ordinal} P${c.p_start + 1}–P${c.p_end + 1} ${c.tokens}tok  ${c.heading_path.join(" > ") || "(không có mục)"}`)
    return
  }

  const questionsFile = arg("questions") ?? DEFAULT_QUESTIONS
  const questions = JSON.parse(fs.readFileSync(questionsFile, "utf8")) as RetrievalQuestion[]
  const topK = Number(arg("top-k") ?? env.DOC_CONTEXT_TOP_K)
  const maxTokens = Number(arg("max-tokens") ?? env.DOC_CONTEXT_CHAT_TOKENS)
  const index = buildProjectIndex([{ ref: { id: "doc", docCode: 1, name: path.basename(file) }, chunks }])
  const codeWeight = arg("code-weight") ? Number(arg("code-weight")) : undefined
  const report = evaluateRetrieval(index, questions, { topK, maxTokens, ...(codeWeight !== undefined ? { codeWeight } : {}) })

  console.log(`\nCâu hỏi: ${questionsFile} (${questions.length} câu) · top-k ${topK} · trần ${maxTokens} token`)
  console.log(`Recall: ${(report.recall * 100).toFixed(1)}%`)
  for (const [kind, { hit, total }] of Object.entries(report.recallByKind)) console.log(`  ${kind}: ${hit}/${total}`)
  console.log(`Token tài liệu mỗi câu hỏi: trung bình ${report.avgTokens}, lớn nhất ${report.maxTokens} (toàn văn ${fullTokens} ⇒ giảm ${fullTokens > 0 ? (100 - (report.avgTokens / fullTokens) * 100).toFixed(1) : 0}%)`)
  const missed = report.results.filter((r) => !r.hit)
  if (missed.length) {
    console.log("\nTrượt:")
    for (const r of missed) console.log(`  [${r.kind}] ${r.q}  (hạng BM25 của đoạn đúng: ${r.rank ?? "không có"})`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
