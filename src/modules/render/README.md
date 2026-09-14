# modules/render

Xuất tài liệu SRS ra file. Vòng một chỉ có Word (`.docx`); PDF/Handoff hoãn (Phases §9.1).
Writer **không đọc Spine** — nó nhận `RenderedDocument` do Assemble (T15) dựng sẵn.

## File

| File | Vai trò |
| --- | --- |
| `rendered-document.types.ts` | Hợp đồng `RenderedDocument` / `RenderedSection` / `Block` (đóng băng sau M1, đổi qua PR `contract-change`, báo T15 và T16) |
| `rendered-document.schema.ts` | Zod strict của hợp đồng, kiểm compile-time khớp types; `draft` ⇒ bắt buộc `watermark: "DRAFT"`, `baseline` ⇒ cấm watermark |
| `markdown-to-blocks.ts` | Markdown giới hạn → `Block[]` (heading, đoạn, `**bold**`, `*italic*`, `` `code` ``, bullet, numbered, bảng GFM). `headingOffset` để lồng heading dưới section |
| `docx-writer.ts` | `writeDocx(doc): Promise<Buffer>`, `buildDocxFileName(doc)` |
| `export.controller.ts`, `export.route.ts` | `POST /api/v1/export/word/preview` |
| `zip.test-helper.ts` | Đọc zip bằng `node:zlib` + sinh PNG cho test (không thêm dependency) |

Fixture: `fixtures/rendered-document-sample.json` (5 chương FPT, 1 bảng, 1 ảnh, §I 3 dòng, 2 cờ đỏ, 1 section `stale`, 1 `awaiting_reaccept`).

## Bố cục file Word

1. Trang bìa: tên dự án, `Software Requirement Specification`, version, ngày (`generatedAt`), nhãn `WORKING DRAFT - NOT BASELINED` hoặc `BASELINE`.
2. Mục lục: field `TOC \o "1-3"`; `settings.xml` bật `updateFields` nên Word hỏi cập nhật field khi mở. LibreOffice: *Tools → Update → Update All*.
3. §I Record of Changes: bảng `Date | Version | A*, M, D | In charge | Change Description`.
4. Ngay sau §I (khi có `flagsAppendix`):
   - `draft`: `Working Draft Status` (số cờ đỏ mở, số section stale, số waive) + bảng cờ đỏ + bảng waive.
   - `baseline`: chỉ bảng waive (srs-spine §6: mọi export in danh sách waive).
5. Các section theo thứ tự mảng, heading `"<number> <heading>"` ở `Heading<level>`. Writer không tự đánh số, không sắp xếp lại.

Section `status = stale` hoặc `awaiting_reaccept = true`: dòng ghi chú `[STALE]` / `[AWAITING RE-ACCEPT]` ngay dưới heading, mọi đoạn và ô bảng của section tô vàng `FFF2CC` (Phases §6.5 — đánh dấu tại chỗ).

Bảng: border đơn xám mọi cạnh, hàng đầu là header (lặp khi sang trang, nền xám, chữ đậm); hàng thiếu ô được bù ô rỗng.

Ảnh: chỉ PNG (`Buffer`, base64, hoặc data URI). Rộng hơn vùng chữ A4 (602 px) thì thu nhỏ giữ tỉ lệ; nhỏ hơn thì giữ nguyên. Ảnh hỏng ⇒ `422 RENDER_IMAGE_INVALID`.

## Watermark DRAFT

Watermark kiểu Word (Design → Watermark): shape VML `v:textpath` chữ `DRAFT`, `rotation:315` (nghiêng 45°), màu `silver` độ mờ 50%, neo giữa lề, đặt trong header mặc định ⇒ lặp trên mọi trang.
Lib `docx` không có API watermark nên đoạn này chèn XML thô qua `ImportedXmlComponent` (header của lib đã khai báo namespace `v:`, `o:`, `w10:`). Không cần phương án chữ mờ lặp.

## Dấu version (business-flow §6)

| Nơi | Giá trị |
| --- | --- |
| Tên file | `<slug tên dự án>-<version>[-draft].docx` — slug bỏ dấu tiếng Việt, chữ thường, ký tự lạ thành `-`; không nhân đôi `-draft` |
| `docProps/core.xml` | `title = "<projectName> - Software Requirement Specification"`, `subject = flintflow_version:<version>` |
| `docProps/custom.xml` | `flintflow_project_id`, `flintflow_version`, `flintflow_source` |

## API

`POST /api/v1/export/word/preview` (auth) — body là `RenderedDocument`, trả `application/vnd.openxmlformats-officedocument.wordprocessingml.document` kèm `Content-Disposition: attachment; filename="<tên file>"`.

Giới hạn: parser JSON toàn cục trong `app.ts` giữ mặc định 100 KB, nên body kèm ảnh base64 lớn sẽ bị `413`. Endpoint này chỉ để thử writer; route thật `GET /projects/:id/export/word` (T15) không gửi body.

| HTTP | code | Khi |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` / `MISSING_ACCESS_TOKEN` | Chưa đăng nhập |
| 422 | `RENDERED_DOCUMENT_INVALID` | Body sai hợp đồng (liệt kê ≤ 5 lỗi zod) |
| 422 | `RENDER_IMAGE_INVALID` | Block ảnh không phải PNG hợp lệ |
