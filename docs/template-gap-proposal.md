# Đề xuất mở rộng Spine cho mẫu SRS của khách (FLF-278 đợt 3, cách 8)

Trạng thái: **đề xuất, chưa triển khai**. Mọi thay đổi dưới đây đụng hợp đồng đóng băng (`spine.schema.ts`,
`section-registry.ts`, `assets/step-registry.json`, `rendered-document.types.ts`) nên phải qua PR nhãn
`contract-change`, 4/4 duyệt. Đợt 3 chỉ làm phần đo: `GET /api/v1/admin/template-gaps` (trang admin "Mục mẫu khách
thiếu dữ liệu") để nhóm chọn ưu tiên theo số liệu thật thay vì đoán.

## 1. Vấn đề

Pipeline hỏi một bộ thông tin cố định theo khung FPT. Bước 09 cho phép map **một phần** dữ liệu Spine vào heading của
mẫu khách; đợt 1–3 cho BA tự điền, nhờ AI soạn hoặc dùng thư viện tổ chức cho phần còn lại. Nhưng các heading dưới
đây vẫn **không có nguồn dữ liệu trong Spine** — mỗi dự án phải điền tay, AI soạn thì phải hỏi lại BA:

| Nhóm heading thường gặp (IEEE 830 / mẫu công ty) | Hiện tại | Ghi chú |
|---|---|---|
| Security, Availability, Maintainability, Portability, Safety | `nfrs[].category` chỉ có `interface`, `usability`, `reliability`, `performance`, `other`; luật gợi ý chặn (`suggestDestination` → `null`) | ISO/IEC 25010 có 8 đặc tính; Security/Availability gần như mẫu nào cũng có |
| Hardware Interfaces, Communications Interfaces | §4.1 chỉ có hệ thống ngoài (actor `system`) | Thiết bị, cảm biến, giao thức, cổng |
| Design and Implementation Constraints, Operating Environment | Không có | Công nghệ bắt buộc, hạ tầng, phiên bản OS/trình duyệt |
| References, Document Conventions | Không có (nội dung chuẩn của tổ chức) | Đã giải bằng thư viện nội dung tổ chức (đợt 3) — **không cần** thêm vào Spine |
| Legal / Regulatory, Data Retention / Archiving | Không có | Bắt buộc với ngân hàng, y tế, chính phủ |

## 2. Đề xuất theo thứ tự ưu tiên

Ưu tiên dự kiến theo kinh nghiệm thử mẫu ngân hàng; **xếp lại theo cột "Còn trống" của trang admin** sau khi có
khoảng 10–20 dự án thật khoá mẫu.

### P1 — Mở rộng `NfrCategory` theo ISO/IEC 25010

- Thêm `security`, `availability`, `maintainability`, `portability`, `safety`, `compatibility` vào `NfrCategory`
  (giữ `other` cho phần còn lại). Dữ liệu cũ hợp lệ nguyên vẹn (chỉ thêm giá trị enum).
- `section-registry`: giữ §4.2.x hiện có; thêm sub-section mới hoặc gom vào §4.2.4 "Other" khi xuất khung FPT — cần
  chốt để không đổi cấu trúc tài liệu FPT đã baseline.
- Bước NFR (S-7.x) hỏi thêm các nhóm này; luật cờ `nfr_missing_number` áp như các nhóm định lượng.
- Mẫu khách: thêm phần nhỏ `slot:nfr_<category>` để Security/Availability… map thẳng, bỏ khỏi luật chặn.
- Ảnh hưởng: schema, section registry (nếu thêm mục FPT), skill S-7.x, `template-destinations.ts`, renderer NFR, dịch.

### P2 — Giao tiếp phần cứng / truyền thông

- Thêm `interfaces[]` `{id, kind: "hardware" | "communication" | "software", name, description, protocol?}` hoặc mở
  rộng actor `system` với `interface_kind`. Phương án thứ nhất rõ hơn và không làm bẩn sơ đồ use case.
- Step mới (hoặc mở rộng step hệ thống ngoài) hỏi thiết bị/giao thức; render vào §4.1 FPT và `slot:hardware`,
  `slot:communications` cho mẫu khách.

### P3 — Ràng buộc thiết kế và môi trường vận hành

- `constraints[]` `{id, kind: "technology" | "environment" | "regulatory", statement}`; `kind: regulatory` phủ luôn
  Legal/Regulatory và Data Retention ở mức câu yêu cầu.
- Brief (B-x) đã hỏi một phần (nền tảng, `form_factor`) — có thể gom vào đó, không cần step mới.

### Không đề xuất

- References / Document Conventions / chính sách chung của công ty: nội dung không thuộc từng dự án — dùng thư viện
  nội dung tổ chức (`OrgContentEntry`, đợt 3).
- Tự sinh nội dung bằng AI cho mọi mục riêng ở cuối pipeline (cách 4 cũ): đã thay bằng "Nhờ AI soạn" theo yêu cầu
  (đợt 2) để BA kiểm soát và không bịa.

## 3. Cách quyết định

1. Chờ trang admin có đủ dữ liệu; lấy 10 dòng đầu theo "Còn trống".
2. Dòng nào đã có `suggested_destination` khác `—` nghĩa là luật gợi ý hiện tại đã map được ở mẫu mới — bỏ qua.
3. Gom các dòng còn lại vào P1–P3 (hoặc nhóm mới), ước lượng, mở PR `contract-change` cho từng nhóm riêng.
