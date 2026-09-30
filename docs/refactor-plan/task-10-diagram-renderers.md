# Task 10 — Diagram renderers ×5 + nối PlantUML pipeline

**Wave:** 2 · **Người phụ trách:** C · **Effort:** 8 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [ ] Xong

## Mục tiêu
Một đường duy nhất cho diagram (Phases §7.1): projection Spine → `.puml` → compile-check → PlantUML self-host → `diagrams[]` với `source_hash`, `render_status` → nhúng khi export. Năm loại: context, usecase, screen_flow, erd, screen_layout (salt).

## Lệch hướng audit cần đóng
D1 (PlantUML client chưa nối; erd/screen_flow là markdown; Excalidraw song song).

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Đọc/sử dụng: `flintflow_be/src/shared/diagram/plantuml.client.ts` (`renderPlantUml`, `isPlantUmlReachable`), `compile-check.ts` (`checkPlantUml`); `docker-compose.yml` (service plantuml); `context/Product-Brief-to-SRS-Phases.md` §7; `context/srs-spine.md` §7.1.
- Sửa: `flintflow_be/src/shared/diagram/plantuml.test.ts` (khi server không chạy dùng `it.skip` có thông báo, không pass im lặng).
- Sửa: `flintflow_be/src/app.ts` mount route diagram.
### Tạo mới
- `flintflow_be/src/modules/diagram/renderers/{context.renderer.ts, usecase.renderer.ts, screen-flow.renderer.ts, erd.renderer.ts, screen-layout.renderer.ts}` — hàm thuần `(spine, ownerId?)` trả `{puml, sourceProjection}`; nhãn tiếng Anh; usecase tách theo actor group nếu > 25 UC (trả nhiều hình, `diagrams[].id` hậu tố `-1,-2`); screen_flow dùng `state` với composite state cho màn có `tabs`, note cho `is_popup`; erd `entity` + crow's foot từ `relations[]`; screen_layout `salt` từ `screens[owner]` + `functions[screen_id=owner]`.
- `flintflow_be/src/modules/diagram/diagram.service.ts` — `renderDiagram(projectId, kind, ownerId?, {by})`: renderer → `checkPlantUml` → nếu lỗi: thử sửa tự động 2 lần (bỏ dòng gây lỗi theo thông báo, hoặc gọi skill `RENDER_FIX` nếu bật) → còn lỗi: lưu `render_status=error, error` → `renderPlantUml(svg)` + `png` → lưu SVG/PNG vào GridFS (`diagram-files` bucket) → ghi `diagrams[]` bằng op engine T08 (`set diagrams[id=…]`, `reason: "render"`) hoặc qua repository nếu T08 chưa merge (đổi tại M2). `renderAll(projectId)`; `staleDiagrams(projectId)` so `source_hash` (T09 `source-hash.ts`).
- `flintflow_be/src/modules/diagram/diagram.controller.ts` + `diagram.route.ts` — `GET /projects/:id/diagrams`, `GET /projects/:id/diagrams/:diagramId.svg|.png`, `POST /projects/:id/diagrams/:kind/render` (dev/thủ công).
- Điền `assets/skills/renderer/{context,usecase,screen-flow,erd,screen-layout}/SKILL.md` + `assets/skills/action/plantuml-conventions/SKILL.md` (quy ước chung, ví dụ từ fixture).
- Test: `renderers/*.test.ts` (snapshot puml từ fixture), `diagram.service.test.ts` (mock client).

## Các bước implement
1. Viết 5 renderer từ fixture T02; snapshot test.
2. Service render + compile-check + GridFS + ghi `diagrams[]`.
3. Routes; swagger.
4. Điền skill renderer/conventions.
5. Chạy thật với PlantUML container: 5 hình fixture `render_status=ok`.

## Dependency
- Phụ thuộc: T01, T02, T03 (stub skill); T08 (op) và T09 (`source-hash`) merge sớm hoặc dùng bản tạm.
- Chặn: T14 (S-3.6), T15 (nhúng ảnh), T18 (S-4.5, S-5.3), T17 (render lại khi reconcile).
- Chạy song song với: T08, T09, T11, T12.

## Output kỳ vọng
- 5 renderer + service + route; ảnh lưu nội bộ; skill renderer có nội dung.

## Tiêu chí hoàn thành (DoD)
- [ ] 5 hình fixture render `ok` trên PlantUML local; snapshot puml ổn định.
- [ ] Đổi `actors[].description` không đổi `source_hash` của `usecase`; đổi `actors[].name` thì đổi.
- [ ] `.puml` lỗi cú pháp cho `render_status=error` và không ném ngoại lệ ra API.
- [ ] `plantuml.test.ts` không còn pass im lặng.

## Ghi chú / rủi ro
- Không có Sequence Diagram (Phases §7.1).
- Salt chỉ cho màn cốt lõi (`detail_status=signed_off`); màn `placeholder` không render layout.
