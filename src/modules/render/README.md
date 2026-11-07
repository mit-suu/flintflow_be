# modules/render

Xuất tài liệu SRS ra file. Vòng một chỉ có Word (`.docx`); PDF/Handoff hoãn (Phases §9.1).
Writer **không đọc Spine** — nó nhận `RenderedDocument` do Assemble (T15) dựng sẵn.

## Dự án "Upload SRS có sẵn": file upload là nền, mục chưa sửa giữ nguyên văn

Dự án có sẵn (`source-fidelity.ts#sourceBasedFrom`):
- điều kiện: `start_kind ≠ new`, không chuyển từ mode 2, profile có `source_file_ref`;
- thuộc một trong hai loại: theo **mẫu cố định của công ty** (`template_intent = fixed`) hoặc **cấu trúc FlintFlow đủ mục**
  (`target_structure.resolved_mode = 1`).

Với các dự án này, mọi bản in (Word, PDF, file version, tải version) lấy **chính file upload** làm nền:

- **Mục nguyên vẹn** (`pristineSectionIds`): bản in của mục từ Spine hiện tại giống hệt bản in từ Spine lúc import (bản gốc
  0.1 — `importedSpineOf`).
  - `writeTemplateDocx(…, { keepSource })` không đụng node nào của slot đó: đoạn, bảng, ảnh, field, bookmark, chú thích.
  - Bản 0.1 khi chưa có CR = file upload + stamp + watermark DRAFT.
- Chỉ mục bị change request sửa mới dựng lại. Đoạn gốc là bảng thì dựng lại thành bảng
  (`SectionRenderContext.preferTable`), ghép đúng bảng gốc.
- **Mục FlintFlow tự thêm** mà file không có, chưa đổi ⇒ không in.
- **Mục phải dựng lại mà có field / bookmark / công thức:**
  - đoạn đó giữ tại chỗ;
  - slot không ghi an toàn được (chữ chung đoạn với ngắt section…) ⇒ giữ nguyên slot, cảnh báo log, không ném 422 cho cả
    file.
- **Bìa:** không thay chữ giữ chỗ (`[Version]`…) — bìa là của file đã viết.
- **Bảng lịch sử:**
  - bảng của file giữ nguyên, kể cả chú thích dưới bảng;
  - không thêm dòng cho lô import / ký 0.1 (`assemble.service#withoutImportRows`, change `by = import`);
  - mỗi change request thêm một dòng cuối bảng theo cột gốc, cột lạ để trống (`legacyRecordCount`).
- **Cấu trúc FlintFlow** dùng mapping lúc import (`loadFixedTemplateContext(…, { rebind: false })`), không gán lại kiểu mẫu bắt
  buộc. File nền không điền an toàn được ⇒ writer FPT như trước.
- **Chế độ 4** (tự do, thiếu mục FlintFlow, phải chèn / sắp lại mục) chưa dùng file nền: in theo mẫu FPT.

## Mẫu bắt buộc do người dùng upload

`writeProjectDocx` chọn writer theo `Project.template_intent`, kể cả khi chế độ 3 đã chuyển sang `fpt` để soạn tiếp hoặc trở về `import` sau baseline. Với `fixed`, `template-docx-writer` điền nội dung vào gói DOCX upload; giữ bìa, lề, styles, numbering, header/footer, tên heading và khung bảng gốc. Không thêm bìa, mục lục hay phụ lục cờ. Bản nháp (`source = draft`, cùng điều kiện `writeDocx`) vẫn có **watermark DRAFT**: `writeProjectDocx` gọi `addDraftWatermark` (`docx-ooxml/watermark.ts`) sau khi điền — chỉ thêm shape chữ mờ vào header (header có sẵn của mẫu giữ nội dung; mẫu không có header thì thêm một header chỉ chứa watermark), styles / numbering / lề không đổi. `writeTemplateDocx` tự nó không gắn watermark (giữ byte của mẫu, test `fixed-template-fidelity`). File version lưu dựng ở `baseline` (không watermark); tải version chưa phát hành gắn watermark lúc tải như mẫu FPT. Bản nháp còn được nhận diện bằng tên file `_DRAFT` và custom properties.

Mapping dùng chung `bindFixedTemplateHeadings` (`import/content-slots.ts`) ở cả lúc tách file (`runParse` truyền
`fixedTemplate` khi upload theo mẫu cố định) lẫn lúc xuất. Hàm này gán phần nhỏ `slot:*` theo tiêu đề và áp quy tắc **cha và
con cùng mục**: heading cha mà heading con nhận cùng mục FPT (hoặc phần nhỏ của mục đó) thì thành heading bao, chỉ in tiêu
đề; heading con mang dữ liệu (vd "3.1 External Interface Requirements" › "3.1.2 Software Interfaces"). Trong nội dung,
heading con của FlintFlow thành đoạn đậm, không thành heading. Nhãn của phần nhỏ (vd "In Scope:" trong Scope) là dòng thường.

`TemplateProfile.source_file_ref` và `source_sha256` gắn mapping với đúng file nguồn. Hồ sơ cũ chỉ được khôi phục khi raw SHA và toàn bộ heading anchor chứng minh được một nguồn duy nhất; không chọn upload mới nhất. Layout cũ thiếu Purpose/Scope được sửa theo thứ tự heading trong nguồn, trước khi assembly; export fixed không đọc cache chứa outline cũ. Mapping heading được đối chiếu với `layout` để dùng đúng id `custom:*` của mục riêng/lặp.

Bảng giữ tiêu đề, độ rộng và thuộc tính ô của mẫu. Cột được nối bằng header chính xác hoặc `table_map.field_path` đã ghi khi import; mapping mơ hồ bị từ chối. Ô gộp ngang giữ logical grid; nhóm gộp dọc không được lặp hoặc che giá trị độc lập. Bảng chưa điền vẫn giữ trong nguồn. Revision History dùng đúng các cột gốc. Nội dung điền thay hướng dẫn kế thừa body style của mẫu, bỏ override xám/nghiêng dành cho hướng dẫn. Dữ liệu không có heading tương ứng được báo bằng `meta.consistency` / `template_section_absent`, không tự tạo heading mới.

Version mới lưu cùng `template_source`, `spine_snapshot`, `record_snapshot`; tái tạo dùng các snapshot đó và cache riêng có renderer revision, không ghi đè file cũ hoặc dùng Spine/profile hiện tại. Version fixed cũ thiếu nguồn/snapshot có thể chứng minh sẽ trả lỗi rõ ràng khi tải bản tự tái tạo; các variant `original`/`tracked` vẫn dùng artifact đã lưu.

Đường Word/PDF và tạo file version dùng chung writer. Thiếu file/mapping hoặc cấu trúc chưa điền an toàn được (ví dụ chữ và section break cùng đoạn) trả `TEMPLATE_LAYOUT_UNAVAILABLE`, không tự chuyển sang mẫu mặc định. Các thuộc tính layout được kiểm tra bằng test với fixture `fixed-template-fu-it-srs-01.docx`; đối chiếu phân trang trực quan cần Word/LibreOffice.

## File

| File | Vai trò |
| --- | --- |
| `rendered-document.types.ts` | Hợp đồng `RenderedDocument` / `RenderedSection` / `Block` (đóng băng sau M1, đổi qua PR `contract-change`, báo T15 và T16) |
| `rendered-document.schema.ts` | Zod strict của hợp đồng, kiểm compile-time khớp types; `draft` ⇒ bắt buộc `watermark: "DRAFT"`, `baseline` ⇒ cấm watermark |
| `markdown-to-blocks.ts` | Markdown giới hạn → `Block[]` (heading, đoạn, `**bold**`, `*italic*`, `` `code` ``, bullet, numbered, bảng GFM). `headingOffset` để lồng heading dưới section |
| `docx-writer.ts` | `writeDocx(doc, { flagLanguage?, language? }): Promise<Buffer>`, `buildDocxFileName(doc)` |
| `labels.ts` | FLF-265: mọi chữ máy theo ngôn ngữ (nhãn, enum, câu ghép, nhóm heading, nhãn phase §I, chữ của writer). `VI_LABELS`/`VI_SECTION_TITLES` dùng chung mode 1 — không thêm key; nhãn mới chỉ bật ở mẫu FPT (`functionLayout: "fpt"`). Chữ máy trên sơ đồ ở `diagram/renderers/labels.ts` |
| `localized-spine.ts` | FLF-265 D11: `localizeSpine(spine, units, translations, language?)` — bản xem Spine đã dịch trong bộ nhớ; kiểu `LocalizedSpine` không gán được cho `Spine` (không lọt vào op-engine / check / prompt / hash), đường render lấy ra qua `renderView`. Logic dựa chữ Anh của renderer quyết trên Spine gốc (`SectionRenderContext.canonical`) |
| `localized-diagrams.ts` | FLF-265 N1: nguồn sơ đồ của bản xem đã dịch — hình dựng từ Spine vẽ lại bằng renderer (chỉ khi nguồn đang lưu khớp renderer hiện tại), wireframe model vẽ thay chữ theo đơn vị `diagrams[id=…].labels`. `assemble.service` nạp PNG theo ngôn ngữ cho các nguồn đã đổi (`diagram/localized-diagram.service.ts`, vẽ trên PlantUML nếu chưa có, trần chờ `LOCALIZED_IMAGE_BUDGET_MS`); không có ⇒ ảnh gốc |
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

`language: "vi"` (FLF-265, mặc định `en`): bìa, mục lục, header/footer, §I, ghi chú dưới đây ra tiếng Việt; phụ lục cờ vẫn theo `flagLanguage`.

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
