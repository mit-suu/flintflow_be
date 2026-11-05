/** Task-local verification: read the existing project and invoke the real export controller.
 * Does not start app/server startup hooks or modify business records. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import dns from "node:dns"
import mongoose from "mongoose"
import type { Request, Response } from "express"
import { env } from "../config/env.js"
import { exportWord } from "../modules/render/export.controller.js"
import { Project } from "../modules/project/project.model.js"
import { parseDocument } from "../modules/import/parse.service.js"
import { loadFixedTemplateContext } from "../modules/render/project-docx-writer.js"
import { DocxPackage, readStamp } from "../modules/docx-ooxml/index.js"
import { NS, wAll, wAttr } from "../modules/docx-ooxml/xml.js"
import { writeTemplateDocx } from "../modules/render/template-docx-writer.js"
import type { RenderedDocument } from "../modules/render/rendered-document.types.js"

const [inputDraft, outputDir] = process.argv.slice(2)
if (!inputDraft || !outputDir) throw new Error("usage: verify-fixed-template-export.ts <previous draft.docx> <output directory>")
dns.setServers(["1.1.1.1", "8.8.8.8"])
try {
  const stamp = await readStamp(await DocxPackage.load(await readFile(inputDraft)))
  if (!stamp?.project_id) throw new Error("Input draft has no project stamp")
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 15000 })
  const project = await Project.findById(stamp.project_id).lean()
  if (!project || project.template_intent !== "fixed") throw new Error("Project is not a fixed-template project")
  const context = await loadFixedTemplateContext(String(project._id))
  const req = {
    user: { userId: String(project.userId) },
    orgContext: { orgId: String(project.organizationId), role: "owner" },
    params: { projectId: String(project._id) }, query: { source: "draft" }
  } as unknown as Request
  const headers: Record<string, string> = {}
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const res = {
      status() { return this },
      setHeader(name: string, value: string) { headers[name] = String(value); return this },
      send(data: Buffer) { resolve(data); return this }
    } as unknown as Response
    exportWord(req, res, (error: unknown) => reject(error))
  })
  const source = await parseDocument(context.template), output = await parseDocument(buffer)
  const sourceHeadings = source.blocks.filter((b) => b.kind === "heading").map((b) => [b.text, b.level])
  const outputHeadings = output.blocks.filter((b) => b.kind === "heading").map((b) => [b.text, b.level])
  if (JSON.stringify(sourceHeadings) !== JSON.stringify(outputHeadings)) throw new Error("Downloaded outline differs from source")
  const filename = decodeURIComponent(headers["Content-Disposition"].split("''")[1])
  await mkdir(outputDir, { recursive: true })
  await writeFile(path.join(outputDir, filename), buffer)
  await writeFile(path.join(outputDir, "source.docx"), context.template)
  const unchanged: RenderedDocument = {
    projectId: String(project._id), projectName: "[Project name]", version: "[Version]", generatedAt: "[Date]",
    source: "draft", sections: [], recordOfChanges: []
  }
  await writeFile(path.join(outputDir, "noop.docx"), await writeTemplateDocx(unchanged, context.template, context.headingMap, context.binding.table_map))
  const xml = await output.pkg.requireXml("word/document.xml")
  const report = {
    projectId: String(project._id), sourceSha256: context.binding.source_sha256,
    filename, headers, headings: outputHeadings,
    tables: output.blocks.filter((b) => b.kind === "table").map((b) => ({ header: b.rows?.[0], rows: b.rows?.length })),
    margins: wAll(xml, "pgMar").map((e) => ({ top: wAttr(e, "top"), left: wAttr(e, "left") })),
    addedHeaderParts: output.pkg.partNames().filter((n) => /^word\/(header|footer)\d+\.xml$/.test(n)),
    drawingCount: xml.getElementsByTagNameNS(NS.w, "drawing").length
  }
  await writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ filename, headingCount: outputHeadings.length, tables: report.tables, margins: report.margins, directory: outputDir }))
} catch (error) {
  const failure = error as Error & { code?: string; meta?: unknown }
  console.error(failure.name, failure.code ?? "", failure.message, failure.meta ?? "")
  process.exitCode = 1
} finally {
  await mongoose.disconnect()
}
