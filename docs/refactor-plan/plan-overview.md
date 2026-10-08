# FlintFlow — Execution Plan tổng hợp (refactor theo srs-spine.md + Product-Brief-to-SRS-Phases.md)

> Nguồn: `audit.md` (đối chiếu codebase với tài liệu) + khảo sát trực tiếp `flintflow_be`, `flintflow_fe` ngày 13/09/2026.
> 24 task, 5 wave, 4 người (A, B, C, D). Mỗi task có file riêng `task-XX-*.md` với các bước, dependency, DoD và checkbox trạng thái.
> File này là nơi báo cáo tiến độ: cập nhật mục 8 mỗi khi task/wave đổi trạng thái.

## 1. Giả định đã chốt để lập plan (nhóm xác nhận trước khi bắt đầu Wave 1)

| # | Câu treo trong audit §4 | Giả định dùng cho plan |
|---|---|---|
| 1 | business-flow.md (I-*/C-*, import .docx, Track Changes) còn là "đề xuất" | **Ngoài phạm vi** 5 wave này. Ghi thành Wave 6 tuỳ chọn (mục 9). Spine/op/registry được thiết kế để thêm I-*/C-* sau mà không phá. |
| 2 | Nguồn thẩm quyền quy trình | `Product-Brief-to-SRS-Phases.md` §6.4 (51 step + 5×N) và `srs-spine.md`. BPMN chỉ tham khảo. |
| 3 | user_story, acceptance_criteria, sequence diagram, PDF/CSV | Bỏ theo Phases §1.3/§7.1/§9.1. Nội dung cũ migrate vào `addendum[]` (T21). |
| 4 | UC34/UC35 MoSCoW + scope | MoSCoW thành S-9.4 ghi `functions[].priority`, `nfrs[].priority` (T19). Scope in/out thành S-2.2 ghi `project.release_scope` (T14). |
| 5 | Brief lưu ở đâu | `project{vision, goals[], form_factor, stakes, working_mode}` + `addendum[]` có `target_section` + `other_requirements[]` + `assumptions[]` (T20). |
| 6 | Nơi lưu Spine | Một document Mongo `Spine` mỗi project; `changes[]`, `usage[]`, `baselines[].snapshot` tách collection; `spine_version` khoá lạc quan bằng `findOneAndUpdate` có điều kiện (T01). |
| 7 | Ngôn ngữ | Nội dung render vào SRS tiếng Anh, chat/UI theo user, cờ vàng `non_english_content` (T09). |
| 8 | Prompt override qua admin | Bỏ DB override vòng một; registry chỉ đọc đĩa; trang admin prompt read-only (T03). |
| 9 | Gate ở Fast path | Coaching: gate từng step. Fast: gate gộp một lần cuối phase (T13). |
| 10 | Ranh giới upload | Chỉ gửi `extractedText`/summary cho model; giữ Cloudinary (T11). |

**Đơn vị effort:** 1 điểm ≈ 0,5 ngày công một người. Mỗi wave chênh giữa 4 người ≤ 2 điểm. Vai trò gợi ý: A = BE lõi Spine/op, B = BE pipeline/AI skill, C = BE platform/render/diagram, D = FE. Có thể đổi người nhưng giữ tổng điểm mỗi người trong wave.

## 2. Bảng tổng

| Wave | Task ID | Mô tả | Người | Effort | Depends on | Chạy song song với |
|---|---|---|---|---|---|---|
| 1 | T01 | Spine schema, types, Mongoose model, repository (khoá lạc quan) | A | 8 | — | T02–T07 |
| 1 | T02 | Fixture Spine 19 màn + seed script + 10 ca thử op | B | 6 | — (xác nhận với T01 tại M1) | T01, T03–T07 |
| 1 | T03 | Tái cấu trúc prompt asset thành 29 skill BMAD, bỏ DB override, ActionType mới, dọn Excalidraw | B | 6 | — | T01, T02, T04–T07 |
| 1 | T04 | Notification in-app + Billing mock gateway + sửa credit (expires_at, deduct/release) | C | 13 | — | T01–T03, T05–T07 |
| 1 | T05 | Word export writer (docx) + watermark DRAFT + interface RenderedDocument | A | 5 | — | T01–T04, T06, T07 |
| 1 | T06 | Admin read-only 10.1–10.3 (users, metrics, AI cost) BE + FE | D | 6 | — | T01–T05, T07 |
| 1 | T07 | FE foundation: typed API layer, types/, gỡ demo/hardcode, DocumentPane read-only, bỏ khoá export | D | 6 | — | T01–T06 |
| 2 | T08 | Op engine: path resolver, ops, transaction, bất biến, cascade + Pipeline API contract | A | 13 | T01, T02 | T09–T12 |
| 2 | T09 | Section registry FPT + status() + deterministic check (10 đỏ + 6 vàng) + flags/waiver + GET /progress | B | 13 | T01, T02, T08 (reference-fields) | T08, T10–T12 |
| 2 | T10 | Diagram renderers ×5 + nối PlantUML + source_hash + GridFS | C | 8 | T01, T02, T03 | T08, T09, T11, T12 |
| 2 | T11 | Draft-to-ops + retry schema ≤ 2 + context projection | C | 6 | T01, T03, T08, T09 | T08–T10, T12 |
| 2 | T12 | Step registry (51 + 5×N JSON chung) + FE workspace shell v2 trên contract (msw mock) | D | 13 | T07, T08 (contract) | T08–T11 |
| 3 | T13 | Step runner / orchestrator + gate (4 hành động, trần 8/3) + meter + resume + is_pipeline | A | 10 | T08, T09, T10, T11, T12, T04 | T14–T16 |
| 3 | T14 | Content skill S-1.2, S-2, S-3 end-to-end trên fixture + đo token | B | 9 | T03, T10, T11, T13 | T13, T15, T16 |
| 3 | T15 | Assemble S-8.2/8.3/8.4 (render section từ field, §I, đánh số) + nối export Word | C | 9 | T05, T08, T09, T10 | T13, T14, T16 |
| 3 | T16 | FE Verification & Change panel, DocumentPane từ BE, Export UI, read-only view, onboarding | D | 10 | T09, T12, T15 (T17 mock) | T13–T15 |
| 4 | T17 | Change flow: impact, 3 nhánh, preview diff, stale, hoà giải, undo, traceability | A | 9 | T08, T09, T10, T11, T13, T15 | T18–T20 |
| 4 | T18 | Content skill S-4, S-5 loop màn, S-6, S-7, S-8.1 | B | 10 | T10, T13, T14 | T17, T19, T20 |
| 4 | T19 | S-9 gate cuối, baseline snapshot, export bản sạch, prioritization (thay UC34/35) | C | 8 | T04, T09, T13, T15, T18 | T17, T18, T20 |
| 4 | T20 | Discovery B-0…B-2 + S-1 qua step runner (BE + FE refit chat) | D | 9 | T11, T12, T13, T14 | T17–T19 |
| 5 | T21 | Data migration Section→Spine + xoá legacy + README/swagger/CLAUDE.md | A | 7 | T17–T20 | T22–T24 (merge trước) |
| 5 | T22 | Bộ test tích hợp (memory Mongo + supertest) + e2e-ai op cases + đo token end-to-end + coverage | B | 6 | T17–T21 | T21, T23, T24 |
| 5 | T23 | FE tích hợp thật toàn bộ, Playwright e2e, i18n nhãn, dọn mock | D | 6 | T17–T21 | T21, T22, T24 |
| 5 | T24 | Docker compose BE/FE/Mongo RS/PlantUML, env, health, gỡ hardcode | C | 4 | T17–T20, T23 | T21–T23 |

## 3. Cân effort theo wave × người

| Wave | A | B | C | D | Tổng |
|---|---|---|---|---|---|
| 1 | 13 (T01, T05) | 12 (T02, T03) | 13 (T04) | 12 (T06, T07) | 50 |
| 2 | 13 (T08) | 13 (T09) | 14 (T10, T11) | 13 (T12) | 53 |
| 3 | 10 (T13) | 9 (T14) | 9 (T15) | 10 (T16) | 38 |
| 4 | 9 (T17) | 10 (T18) | 8 (T19) | 9 (T20) | 36 |
| 5 | 7 (T21) | 6 (T22) | 4 (T24) | 6 (T23) | 23 |
| **Tổng** | **52** | **50** | **48** | **50** | **200** |

Ghi chú: C nhẹ hơn ở Wave 5 để bù Wave 2 nặng nhất (14 điểm).

Ước lượng lịch (4 người full-time): Wave 1 ≈ 1,5 tuần · Wave 2 ≈ 1,5 tuần · Wave 3 ≈ 1 tuần · Wave 4 ≈ 1 tuần · Wave 5 ≈ 3–4 ngày. Tổng ≈ 6 tuần chưa kể buffer.

## 4. Sơ đồ luồng wave và dependency

```mermaid
flowchart LR
  subgraph W1[Wave 1 — nền móng]
    T01[T01 Spine schema/model]
    T02[T02 Fixture 19 màn]
    T03[T03 Skill assets]
    T04[T04 Notification + Billing]
    T05[T05 Docx writer]
    T06[T06 Admin RO]
    T07[T07 FE foundation]
  end
  M1{M1}
  subgraph W2[Wave 2 — engine & registry]
    T08[T08 Op engine + contract]
    T09[T09 Section registry + check]
    T10[T10 Diagram renderers]
    T11[T11 Draft-to-ops]
    T12[T12 Step registry + FE shell]
  end
  M2{M2}
  subgraph W3[Wave 3 — luồng dọc S-3 → Word]
    T13[T13 Step runner]
    T14[T14 Skill S-2/S-3]
    T15[T15 Assemble + export]
    T16[T16 FE verification/change]
  end
  M3{M3}
  subgraph W4[Wave 4 — mở rộng ngang]
    T17[T17 Change flow]
    T18[T18 Skill S-4…S-8.1]
    T19[T19 S-9 baseline]
    T20[T20 Discovery B-0…S-1]
  end
  M4{M4}
  subgraph W5[Wave 5 — migration, test, ops]
    T21[T21 Migration + cleanup]
    T22[T22 Integration tests]
    T23[T23 FE e2e]
    T24[T24 Docker/ops]
  end
  M5{M5}

  T01 --> M1
  T02 --> M1
  T03 --> M1
  T04 --> M1
  T05 --> M1
  T06 --> M1
  T07 --> M1
  M1 --> T08
  M1 --> T09
  M1 --> T10
  M1 --> T11
  M1 --> T12
  T08 -. contract .-> T12
  T08 -. op.types .-> T11
  T08 --> M2
  T09 --> M2
  T10 --> M2
  T11 --> M2
  T12 --> M2
  M2 --> T13
  M2 --> T14
  M2 --> T15
  M2 --> T16
  T13 -. service .-> T14
  T15 -. /document .-> T16
  T13 --> M3
  T14 --> M3
  T15 --> M3
  T16 --> M3
  M3 --> T17
  M3 --> T18
  M3 --> T19
  M3 --> T20
  T18 -. S-8.1 .-> T19
  T17 --> M4
  T18 --> M4
  T19 --> M4
  T20 --> M4
  M4 --> T21
  M4 --> T22
  M4 --> T23
  M4 --> T24
  T21 -. merge trước .-> T22
  T21 -. merge trước .-> T23
  T23 -. e2e .-> T24
  T21 --> M5
  T22 --> M5
  T23 --> M5
  T24 --> M5
```

Đường nét đứt là phụ thuộc **nội wave**: task đích bắt đầu song song nhưng chỉ hoàn tất sau khi task nguồn merge phần được nêu (contract, op.types, service, endpoint).

## 5. Merge point (bắt buộc trước khi mở wave kế)

| Merge point | Điều kiện tick | Người tick |
|---|---|---|
| **M1** (kết thúc W1) | T01 merge trước tiên; T02 fixture parse qua `spineSchema`; T03 `getSkill`, `ActionType` mới, `opTransactionSchema` đóng băng; T07 `types/spine.ts` đồng bộ với T01; toàn bộ PR W1 merge vào `develop`; CI (typecheck + test BE/FE) xanh. | A |
| **M2** (kết thúc W2) | Thứ tự merge T08 → T09 → T10/T11 → T12; fixture chạy qua op engine + deterministic check ra **0 cờ đỏ**; `docs/api/pipeline-contract.md` và `assets/step-registry.json` **đóng băng** (đổi phải qua PR nhãn `contract-change`, 4/4 approve); FE shell chạy trọn trên mock. | A |
| **M3** (kết thúc W3) | Luồng `seed:fixture → S-3 run (mock provider) → assemble → Word` chạy trọn qua API + FE; `docs/measurements.md` có token S-2/S-3 trên fixture; nếu chi phí > 2× dự kiến thì chỉnh projection T11 trước khi mở W4. | A + B |
| **M4** (kết thúc W4) | Một project mới đi trọn B-0.1 → S-9.5 → Word baseline trên dev với provider thật ít nhất 1 lần; token ghi vào `docs/measurements.md`; FE ChangePanel chạy thật (không mock). | cả 4 |
| **M5** (kết thúc W5) | Legacy đã xoá, CI xanh (unit + integration + e2e), `docker compose up` chạy trọn, tag `v1.0-refactor`; mục 8 dưới đây 100%. | cả 4 |

## 6. Hướng dẫn implement theo giai đoạn

**Chuẩn bị (ngày 0)**
1. Cả nhóm đọc `audit.md`, `srs-spine.md`, `Phases.md` §1–§4, §6.4, §9 và bảng giả định (mục 1). Phản đối giả định nào thì chốt ngay tại đây, sửa file task liên quan trước khi code.
2. Tạo branch `develop` từ `main`; bật branch protection: CI xanh + 1 reviewer khác người.
3. Quy ước branch `feat/tXX-<slug>`; PR nhỏ, merge sớm (đặc biệt `op.types.ts`, `pipeline.dto.ts`, `step-registry.json`).

**Wave 1 (bắt đầu ngay, 7 task song song)**
- A ưu tiên T01 xong trong ≤ 3 ngày rồi mới làm T05. B làm T02 và T03 xen kẽ (T03 trước để chốt `opTransactionSchema` cho T02 viết `expected_ops`). C làm T04. D làm T07 trước rồi T06.
- Thống nhất tên file `lib/api/*.ts` giữa C (T04) và D (T06, T07) ngay ngày 1.
- Tick M1.

**Wave 2**
- A merge `op.types.ts` + `pipeline.dto.ts` + `pipeline-contract.md` trong 2 ngày đầu; D bắt đầu mock từ đó; C bắt đầu T11 từ đó.
- B làm T09 (registry trước, check sau); C làm T10 rồi T11; D làm `step-registry.json` trước (3 ngày đầu) rồi FE shell.
- Thứ tự merge: T08 → T09 → T10/T11 → T12. Tick M2.

**Wave 3 (luồng dọc đầu tiên)**
- A T13; B T14 bắt đầu bằng gọi `draftOps` trực tiếp, chuyển sang runner khi T13 merge; C T15; D T16 (flags/document/export thật, change flow mock).
- Cuối wave: demo nội bộ fixture → S-3 → Word. Tick M3.

**Wave 4 (mở rộng ngang)**
- A T17 (nối FE ChangePanel của D); B T18; C T19; D T20.
- Cuối wave: chạy project mới đầu-cuối với provider thật. Tick M4.

**Wave 5**
- T21 merge trước; T22/T23/T24 song song; T24 chạy e2e T23 trong compose. Tick M5.

**Nguyên tắc chung**
- Mọi người (và AI agent) đọc `coding-rules.md` trước khi code: bảng vùng sở hữu file theo task, điều cấm, quy trình yêu cầu chéo (XREQ). Sau mỗi task hoặc mỗi phiên làm việc, xuất báo cáo theo `task-report-template.md` và dán vào PR.
- Không code trước dependency: người rảnh đi review PR hoặc viết test cho task wave sau.
- Mọi thay đổi `spine.schema.ts`, `pipeline-contract.md`, `step-registry.json`, `RenderedDocument` sau khi đóng băng phải qua PR `contract-change`.
- Không sửa nội dung `audit.md`; ghi thiếu sót tài liệu vào `docs/spec-gaps.md`.

## 7. Bản đồ lệch hướng audit → task đóng

| Mã audit | Task đóng |
|---|---|
| A1, A6, A8 | T01 |
| A2 | T08 |
| A3 | T09, T15 |
| A4 | T01, T08, T15 (§I) |
| A5 | T19 |
| A7, C9 | T09, T12 |
| B1 | T12, T13 |
| B2, B3 | T20 |
| B4 | T07, T12, T13 |
| B5, D5 | T11 |
| B6 | T12, T13 |
| B7 | T13, T17 |
| B8 | T14 (S-2.2), T19 (S-9.4) |
| C1 | T07, T16, T17 |
| C2 | T08, T17 |
| C3 | T16, T17 |
| C4 | T17 |
| C5, C7 | T09, T19 |
| C6 | T07, T16 |
| C8 | T05, T07, T15, T16 |
| D1 | T03, T07, T10 |
| D2, D3 | T03 |
| D4 | T03, T09, T14 |
| E1, E2 | T04 |
| E3 | T01, T08 |
| E4 | T13, T17, T20 |
| E5 (vai trò Lead/Analyst/Viewer) | Hoãn (P5) |
| E6 | Giữ nguyên (giả định 10) |
| F1 (import .docx, CR) | Wave 6 tuỳ chọn |
| F2 | T05, T15 |
| F3 | T04, T06 |
| F4 (share/clone) | Hoãn (Phases §9.1) |

## 8. Trạng thái tổng thể (cập nhật trực tiếp tại đây)

Cách cập nhật: người phụ trách đổi ô Trạng thái của task mình (`Chưa làm` / `Đang làm` / `Xong` + ngày), đồng thời tick checkbox trong file task. Người tick merge point ghi ngày vào cột M.

| Wave | Task | Người | Trạng thái | Ngày cập nhật | Ghi chú |
|---|---|---|---|---|---|
| 1 | T01 | A | Xong | 2026-09-14 | DoD 5/5. Đã sửa (`c1ec448`): xoá cứng project dọn `Spine/Change/Baseline/Usage`; unique `(projectId, version)` cho baseline |
| 1 | T02 | B | Xong | 2026-09-14 | Fixture + 10 ca op xanh. Đã sửa (`1f27ec4`): seed ghi qua model `Spine` với `projectId`, validate `spineSchema`. Chưa chạy seed trên Mongo thật |
| 1 | T03 | B | Xong | 2026-09-14 | 30 skill + registry + ActionType. **Chốt: bỏ tính năng prompt-template** (không khôi phục route 410). Đã sửa (`70e807e`): startup nạp skill index; chặn action diagram đã archive |
| 1 | T04 | C | Xong | 2026-09-14 | **Chốt: dùng `payment_service` thật** (VietQR). Đã sửa (`85b8918` + FE `befce78`): `deductCredit` hoàn claim khi ví lệch, nhánh expired trừ theo số khả dụng; gói trả phí chỉ kích hoạt qua checkout `plan:<id>` |
| 1 | T05 | A | Đang làm | 2026-09-14 | Đã sửa (`2efb86d` + FE `d12b35a`): body `/export` 15mb, nhận nhầm bảng/numbered list; FE `RenderedDocument.projectId`. **Còn:** mở file docx bằng Word/LibreOffice (máy review chưa cài) |
| 1 | T06 | D | Xong | 2026-09-14 | 403/200 đúng. Trang prompt-templates bỏ theo quyết định ở T03. Đã sửa (`f3680a8`): quyền admin đọc role/`isActive` từ DB mỗi request. Còn: ai-cost chưa đối chiếu DB thật |
| 1 | T07 | D | Xong | 2026-09-14 | typecheck/lint/test xanh; `build` xanh trên `develop` a3f9c3d (2026-09-14 23:00). Còn Google client ID thật trong `.env.local` (không track) |
| — | **M1** | A | [ ] | 2026-09-14 | Chưa tick: T05 mở file docx bằng tay; CI FE trên `develop` a3f9c3d đỏ ở `npm ci` (`package-lock.json` thiếu `@emnapi/core`, `@emnapi/runtime`) |
| 2 | T08 | A | Đang làm | 2026-09-14 | Đã sửa (`f7ccb3d`): ghi Spine+changes trong Mongo transaction (standalone: lưu Spine trước, cấp lại seq); `revert_conflict`; `path_not_writable`; lô không đổi không tăng version; contract cập nhật. **Còn:** 4/4 người approve `pipeline-contract.md` |
| 2 | T09 | B | Xong | 2026-09-14 | Đã sửa (`e9583a5`): recompute thường không đóng cờ luật S-9; kiểm quyền trước validate; bỏ spread O(n²) |
| 2 | T10 | C | Xong | 2026-09-14 | Đã sửa (`7a2c1e5`): so theo `source_hash` + `force`; lưu file sau transaction, xoá file cũ; bỏ `dropErrorLine` và marker "syntax error" chung |
| 2 | T11 | C | Xong | 2026-09-14 | Đã sửa (`2fefd2b`): txn do server sinh; `ops: []` ⇒ `txn: null`; retry gửi lại ops cũ; projection đọc step registry T12 |
| 2 | T12 | D | Xong | 2026-09-14 | Đã sửa (FE `a425983`): huỷ SSE khi rời trang/chạy lại, luồng đóng sớm ⇒ lỗi `STREAM_CLOSED`, `spine_version` chỉ tăng; mock đóng luồng khi lỗi |
| — | **M2** | A | [ ] | 2026-09-14 | Chưa tick: chờ 4/4 approve contract T08; chưa có nhãn `contract-change` trên GitHub (BE/FE). `wave2/review`: BE 428 + FE 102 test xanh, typecheck sạch |
| 3 | T13 | A | Xong | 2026-09-15 | DoD 3/5. Đã merge `develop` qua PR [flintflow_be #33](https://github.com/mit-suu/flintflow_be/pull/33) (nhánh `feat/FLF-150-step-runner`, Jira FLF-150). BE 474 test xanh. **Chờ quyết định:** `POST /resume` không có trong contract → chưa mount (đề xuất contract-change); hoàn ví khi 409 cần XREQ T04 `refundDeductedCredit`. Báo cáo: `flintflow/plans/reports/t13-report-260915-step-runner.md` |
| 3 | T14 | B | Xong (bị chặn một phần) | 2026-09-15 | DoD 2/4. Đã merge `develop` qua PR [flintflow_be #35](https://github.com/mit-suu/flintflow_be/pull/35) (nhánh `feat/FLF-152-skills-s2-s3`, Jira FLF-152). BE 546 test xanh. **Bị chặn:** nội dung 4 skill content chưa tới model vì `prompt-assets.test.ts:97-107` (T03) ép `stub: true` → XREQ T03; `E2E_AI=1` chưa chạy (không có provider). **Chờ quyết định:** contract-change S-3.6 renders `context` (S-3.1 thêm actor phi-human làm context stale). Báo cáo: `flintflow/plans/reports/t14-report-260915-skills-s2-s3.md` |
| 3 | T15 | C | Xong | 2026-09-15 | DoD 4/4. Đã merge `develop` qua PR [flintflow_be #34](https://github.com/mit-suu/flintflow_be/pull/34) (nhánh `feat/FLF-151-assemble-export`, Jira FLF-151). BE 544 test xanh. **Chờ quyết định:** mã `409 NO_WORKING_DRAFT` + `group:*` section id cần contract-change. Còn: mở docx bằng Word tay. Báo cáo: `flintflow/plans/reports/t15-report-260915-assemble-export.md` |
| 3 | T16 | D | Xong | 2026-09-15 | DoD 4/5. Đã merge `develop` qua PR [flintflow_fe #21](https://github.com/mit-suu/flintflow_fe/pull/21) (nhánh `feat/FLF-153-fe-verification-change`, Jira FLF-153). FE 181 test, lint 0 lỗi. Change flow trên msw (T17 nối thật). **Chờ:** BE `PATCH /users/me` + `onboardedAt` (XREQ, `modules/user`); export Word từ BE thật chạy tay; `types/chat.ts` thiếu `is_pipeline`. Báo cáo: `flintflow/plans/reports/t16-report-260915-fe-verification-change.md` |
| — | **M3** | A + B | [ ] | 2026-09-15 | Chưa tick (người tick). Từng mắt xích có test tự động; chưa chạy trọn trên Mongo thật + trình duyệt; `docs/measurements.md` mới có số mock (cần XREQ T03 bỏ `stub` + `E2E_AI=1`). 5 contract-change + 6 XREQ chờ quyết — `overnight-260915-wave3.md` mục 2 |
| 4 | T17 | A | Chưa làm | | |
| 4 | T18 | B | Chưa làm | | |
| 4 | T19 | C | Chưa làm | | |
| 4 | T20 | D | Chưa làm | | |
| — | **M4** | cả 4 | [ ] | | |
| 5 | T21 | A | Chưa làm | | |
| 5 | T22 | B | Chưa làm | | |
| 5 | T23 | D | Chưa làm | | |
| 5 | T24 | C | Chưa làm | | |
| — | **M5** | cả 4 | [ ] | | |

**Tiến độ wave:** W1 6/7 · W2 4/5 · W3 4/4 · W4 0/4 · W5 0/4 · **Tổng 14/24** (T13, T15, T14, T16 xong 2026-09-15 trên `wave3/review`, phiên overnight — T13/T14 còn mục DoD bị chặn bởi contract-change/XREQ, xem `flintflow/plans/reports/overnight-260915-wave3.md`; W1/W2 giữ như lượt sửa 2026-09-14, chi tiết ở `review-t01-t12.md`).

## 9. Wave 6 tuỳ chọn (business-flow.md, chỉ liệt kê)

Chỉ mở khi nhóm chốt business-flow §7 và sau M5. Không chi tiết ở đây.
- P0 thử nghiệm: chèn `w:ins/w:del` vào đoạn + ô bảng, độ ổn định `paraId`; import 1 SRS thật; đo token 1 CR.
- I-1…I-4: preflight .docx, parse & anchor block, profile match, spine extraction → baseline v0 imported.
- C-1…C-7: intake, clarify (tái dùng T17 clarification), impact (tái dùng T17), propose (gọi skill của step sở hữu field, tái dùng T14/T18), verify (T15 consistency + T09), approve theo nhóm, write Track Changes + version mới.
- Template profile thứ hai; vai trò Lead/Analyst/Viewer (E5).

## 10. Danh sách file plan

`plan-overview.md` (file này), `coding-rules.md` (quy tắc và vùng sở hữu file), `task-report-template.md` (mẫu báo cáo bắt buộc) và 24 file task: `task-01-spine-schema.md`, `task-02-fixture-spine.md`, `task-03-skill-assets.md`, `task-04-notification-billing.md`, `task-05-docx-writer.md`, `task-06-admin-readonly.md`, `task-07-fe-foundation.md`, `task-08-op-engine.md`, `task-09-section-registry-check.md`, `task-10-diagram-renderers.md`, `task-11-draft-to-ops.md`, `task-12-step-registry-fe-shell.md`, `task-13-step-runner.md`, `task-14-skills-s2-s3.md`, `task-15-assemble-export.md`, `task-16-fe-verification-change.md`, `task-17-change-flow.md`, `task-18-skills-s4-s8.md`, `task-19-s9-baseline.md`, `task-20-discovery-brief.md`, `task-21-migration-cleanup.md`, `task-22-integration-tests.md`, `task-23-fe-integration-e2e.md`, `task-24-ops-docker.md`.
