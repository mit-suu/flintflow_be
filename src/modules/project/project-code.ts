/**
 * Mã dự án ngắn mang trong tên file xuất (flow §4): `P` + 6 ký tự cuối của `_id`, viết hoa. Chưa có trường riêng ⇒ suy từ `_id`,
 * không đổi schema (giả định plan FLF-466).
 */
export const projectCode = (projectId: string): string => `P${String(projectId).slice(-6).toUpperCase()}`
