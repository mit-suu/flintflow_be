/**
 * system-name.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-177 — một nguồn tên hệ thống cho mọi chỗ in ra ngoài (boundary sơ đồ use case, sơ đồ ngữ cảnh,
 * bìa/tiêu đề/tên file docx): `project.system_name` (tiếng Anh, user chốt ở B-0.1), chưa có ⇒ tên dự phòng
 * (mặc định `project.name`). Tên project làm việc (`Project.name`) không bị đổi theo.
 */

import type { SpineProject } from "./spine.types.js"

export const systemName = (project: Pick<SpineProject, "name" | "system_name">, fallback: string = project.name): string =>
  project.system_name?.trim() || fallback
