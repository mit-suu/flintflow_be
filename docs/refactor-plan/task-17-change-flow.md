# Task 17 — Change flow: impact query, 3 nhánh, preview diff, stale, hoà giải, undo, traceability

**Wave:** 4 · **Người phụ trách:** A · **Effort:** 9 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [ ] Xong

## Mục tiêu
Sửa qua hội thoại đúng srs-spine §9 và Phases §2.2–2.3: impact query trên đồ thị khoá, ba nhánh (áp im lặng / preview diff / sau baseline bắt buộc impact), `stale` lan theo 3 cột, hoà giải một lượt, undo op cuối, traceability read-only. Thay hoàn toàn rollback cắt chat.

## Lệch hướng audit cần đóng
C2 (undo phá huỷ), C3 (không có impact/stale/hoà giải/diff), C4 (traceability sai khái niệm), B7 (khoá cứng section), E4 (session khác chỉ phát op sửa).

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Đọc: `modules/spine/{op-engine.ts, reference-fields.ts, section-registry.ts, section-status.ts, flags.service.ts}`, `modules/pipeline/{draft-to-ops.ts, context-projection.ts, step-runner.service.ts}`, `modules/diagram/diagram.service.ts`, `context/srs-spine.md` §9, §4.1.
- Sửa: `flintflow_be/src/modules/spine/spine.route.ts` hoặc route `changes` (T08) thêm nhánh `{instruction}`, `reconcile`, `undo`, `traceability`.
- Sửa: `flintflow_be/src/modules/project/chat-session.service.ts` (session không pipeline: tin nhắn dạng lệnh sửa chuyển vào `change.service`).
- Sửa: `flintflow_be/src/modules/specification/traceability.service.ts` thay bằng file mới; file cũ xoá ở T21.
### Tạo mới
- `flintflow_be/src/modules/spine/impact.service.ts` — `impactOf(spine, paths[])` trả `{fields: string[], sections: {id, relation: owner|reads|derived}[], diagrams: kind[], referrers: {path, id}[]}` từ `reference-fields` + `FIELD_SECTION_MAP`.
- `flintflow_be/src/modules/spine/change.service.ts` — `preview(projectId, {instruction?, ops?, base_version})` trả `{ops, diff: [{path, before, value, sections[]}], impact, branch: silent|dependent|post_baseline, violations?, clarification?}`: `instruction` đi qua skill `apply-change-op` (ActionType `CHANGE_INSTRUCTION`, projection quanh các thực thể được nhắc; mơ hồ thì `clarification` UC 6.11), `ops` thuần thì validate; `apply(projectId, previewId | body)` gọi `applyTransaction` (`by: user`, `reason` từ instruction); nhánh `post_baseline`: bắt buộc `impact` trong response và `reason` bắt buộc; sau áp gọi `flags.recompute`; ghi `changes[]`.
- `flintflow_be/src/modules/spine/reconcile.service.ts` — `reconcile(projectId)`: liệt kê section `stale` (T09), với mỗi section gọi skill của step sở hữu với projection chỉ field phụ thuộc + diff các `changes[]` gây stale, gom ops, preview diff gộp, `apply`, render lại `diagrams[]` có `source_hash` lệch, đặt `awaiting_reaccept` (bằng cờ trên `steps[]`/`sections[]` theo cách T09 định nghĩa). User từ chối diff thì section vẫn `stale`.
- `flintflow_be/src/modules/spine/undo.service.ts` — `undoLast(projectId)`: revert txn cuối (`changes[].before`, cùng `txn`) qua `revertRange`; không undo txn `render`/`baseline`; ghi `changes[] {op: "undo"}`.
- `flintflow_be/src/modules/spine/traceability.service.ts` — `trace(spine, {entity, id})` read-only: actor, use cases, functions, screens, entities, nfrs liên quan (qua `reference-fields`); trả đồ thị cạnh.
- Routes trong `spine.route.ts`/`pipeline.route.ts`: `POST /changes/preview`, `POST /changes`, `POST /reconcile`, `POST /undo`, `GET /traceability`, `GET /changes`.
- Điền `assets/skills/action/apply-change-op/SKILL.md` (impact, ba nhánh, cách ra op nhỏ nhất).
- Test: `impact.test.ts`, `change.service.test.ts` (3 nhánh + từ chối bất biến + post_baseline), `reconcile.test.ts`, `undo.test.ts`, `traceability.test.ts`.

## Các bước implement
1. `impact.service` + test trên fixture (đổi `actors[id=A01].name` cho sections `fixed:2.1` owner, `2.2.2`, `3.1.3` reads, diagrams usecase/context derived).
2. `change.service` preview/apply với ops thuần; sau đó nhánh instruction qua skill (mock).
3. `undo`, `traceability` + routes.
4. `reconcile` + render lại diagram.
5. Nối FE ChangePanel (T16) bỏ mock; kiểm cùng D.

## Dependency
- Phụ thuộc: T08, T09, T11, T13, T15 (để xem stale trên document), T10.
- Chặn: T21 (xoá rollback), T23.
- Chạy song song với: T18, T19, T20.

## Output kỳ vọng
- API change/reconcile/undo/traceability chạy thật; FE Change panel nối thật.

## Tiêu chí hoàn thành (DoD)
- [ ] Đổi tên actor: preview liệt kê đúng 3 section + 2 diagram; apply làm `status(fixed:2.2.2)=stale`.
- [ ] Hoà giải: diff gộp, apply, diagram render lại, section `awaiting_reaccept`; từ chối thì vẫn stale.
- [ ] Undo khôi phục Spine deep-equal trước txn; undo hai lần liên tiếp đúng thứ tự.
- [ ] Sau baseline (T19), apply không có `reason` trả 400; còn cờ đỏ thì không tạo baseline mới.
- [ ] Session không pipeline gửi lệnh sửa đi qua change flow, không đẩy `progress`.

## Ghi chú / rủi ro
- Hoà giải thủ công một lượt; không tự lan toả (Phases §9.1).
- Impact không bắt ngữ nghĩa (srs-spine §4.1): ghi rõ trong UI (T16) là cảnh báo heuristic.
