/**
 * Fixture đổi mẫu ChoViet (khung FPT) ⇒ jam01 (IEEE 29148 tiếng Việt), dùng làm golden test cho gợi ý chỗ đặt và dựng layout.
 * Heading + chữ hướng dẫn của mẫu đích đọc thật từ file mẫu jam01 (`analyzeTemplateFile`). Khung cũ rút gọn từ layout của dự án
 * ChoViet sau import (mỗi tính năng giữ 2 chức năng); mẫu nội dung Spine là câu tóm tắt tự viết, không chứa dữ liệu cá nhân.
 */
import type { NewHeading, OldHeading } from "./pair-sections.js"

export const JAM01_HEADINGS: NewHeading[] = [
  {"key":"n0","heading_text":"1. Giới thiệu","section_id":"unmapped","level":1,"guidance":"Tổng quan về tài liệu và định hướng người đọc về hệ thống được đặc tả. Tóm tắt ngắn mục đích của SRS, phạm vi sản phẩm, đối tượng đọc và cách tổ chức tài liệu. Không viết chi tiết ở đây — dẫn sang các mục liên quan."},
  {"key":"n1","heading_text":"1.1 Mục đích tài liệu","section_id":"slot:vision","level":2,"guidance":"Nêu lý do tài liệu SRS này tồn tại, nó chứa gì và ai sẽ dùng. Viết 2–4 câu. Gọi tên các nhóm đọc chính (sản phẩm, phát triển, kiểm thử, bảo mật, tuân thủ, vận hành) và cách họ dùng tài liệu trong vòng đời phần mềm. Nhấn mạnh rằng SRS định nghĩa hệ thống phải làm GÌ, không phải làm NHƯ THẾ NÀO. Nhắc tới tài liệu liên quan (vision/scope, kiến trúc, lộ trình, hợp đồng) nếu có."},
  {"key":"n2","heading_text":"1.2 Phạm vi sản phẩm","section_id":"slot:scope","level":2,"guidance":"Xác định sản phẩm bằng tên và phiên bản/bản phát hành. Trong 3–5 câu, mô tả mục đích chính, các năng lực chính và kết quả mong muốn. Liệt kê rõ phần trong / ngoài phạm vi khi SRS chỉ phủ một phần của hệ thống lớn hơn. Tập trung vào \"cái gì\" và \"vì sao\". Nối các năng lực với mục tiêu kinh doanh; dẫn sang tài liệu vision/scope riêng nếu có. Thêm một sơ đồ đơn giản nếu nó làm rõ ranh giới trong hệ thống lớn hơn."},
  {"key":"n3","heading_text":"1.3 Định nghĩa, từ viết tắt","section_id":"fixed:5.5","level":2,"guidance":"Bảng thuật ngữ nghiệp vụ, từ viết tắt và ký hiệu dùng trong SRS để người đọc hiểu đúng. Đưa vào các thuật ngữ ảnh hưởng tới cách hiểu yêu cầu (vd \"người dùng\", \"tenant\", \"gần thời gian thực\"). Sắp theo thứ tự chữ cái và thống nhất trong cả bộ tài liệu."},
  {"key":"n4","heading_text":"1.4 Tài liệu tham khảo","section_id":"slot:references","level":2,"guidance":"Liệt kê nguồn bên ngoài là bắt buộc (normative) hoặc tham khảo (informative) cho SRS: tiêu chuẩn, hợp đồng, chính sách, đặc tả giao diện, hướng dẫn UX, tài liệu use case, quyết định kiến trúc, vision/scope. Mỗi mục ghi: tên, tác giả/chủ quản, phiên bản, ngày, nơi lưu/URL, và loại bắt buộc hay tham khảo. Ưu tiên link ổn định hoặc đường dẫn trong repository thay vì URL dễ đổi."},
  {"key":"n5","heading_text":"1.5 Tổng quan tài liệu","section_id":"unmapped","level":2,"guidance":"Tóm tắt mỗi phần lớn nói về gì (Tổng quan sản phẩm, Yêu cầu, Kiểm chứng, Phụ lục), nêu quy ước của tài liệu và cách quản lý cập nhật / lịch sử sửa đổi. Giữ trong 3–5 câu, tập trung vào cách tra cứu và quy ước."},
  {"key":"n6","heading_text":"2. Tổng quan sản phẩm","section_id":"unmapped","level":1,"guidance":"Bối cảnh và các yếu tố nền ảnh hưởng tới yêu cầu của sản phẩm."},
  {"key":"n7","heading_text":"2.1 Góc nhìn sản phẩm","section_id":"fixed:1","level":2,"guidance":"Đặt sản phẩm trong hệ sinh thái lớn hơn: bối cảnh và nguồn gốc, là sản phẩm mới, thay thế, hay một thành viên của họ sản phẩm. Nếu là một phần của hệ thống lớn hơn, nêu ngắn quan hệ, giao diện ngoài và phụ thuộc chính. Ghi rõ chủ quản, SLA và mô hình hỗ trợ. Chỉ rõ hệ thống thượng nguồn / hạ nguồn và ranh giới sở hữu. Một sơ đồ ngữ cảnh mức cao giúp người đọc định hướng."},
  {"key":"n8","heading_text":"2.2 Chức năng sản phẩm","section_id":"fixed:2.2.1","level":2,"guidance":"Tổng quan ngắn các nhóm chức năng / tính năng chính. Để hành vi chi tiết, dữ liệu và trường hợp biên sang Mục 3. 5–10 gạch đầu dòng thường là đủ ở mức này, nhóm các chức năng liên quan. Thêm sơ đồ luồng dữ liệu hoặc sơ đồ use case tổng quát nếu hữu ích."},
  {"key":"n9","heading_text":"2.3 Ràng buộc sản phẩm","section_id":"fixed:4.2.4","level":2,"guidance":"Các giới hạn hoặc điều kiện định hình thiết kế và triển khai: giao diện bắt buộc, công nghệ, nghĩa vụ pháp lý, mức chất lượng tối thiểu, giới hạn phần cứng, họ mô hình AI/ML, chính sách tổ chức. Viết ràng buộc thành câu \"phải\" kiểm chứng được (vd \"phải dùng module mã hoá đạt FIPS 140-3\"). Phân biệt ràng buộc bên ngoài / bên trong và bắt buộc / ưu tiên. Tránh quyết định thiết kế trừ khi thực sự bắt buộc. Ghi chú: Mục 3 định nghĩa nghĩa vụ kiểm chứng được — hành vi hoặc chất lượng hệ thống phải có để thoả các giới hạn ở mục này."},
  {"key":"n10","heading_text":"2.4 Đặc điểm người dùng","section_id":"fixed:2.1","level":2,"guidance":"Xác định nhóm người dùng, vai trò và persona: trình độ, quyền truy cập, tần suất sử dụng, nhu cầu tiếp cận (accessibility) và mục tiêu. Phân nhóm người dùng theo hành vi, không chỉ theo chức danh. Ghi các yêu cầu bản địa hoá và khả năng tiếp cận ảnh hưởng tới yêu cầu UI/UX."},
  {"key":"n11","heading_text":"2.5 Giả định và phụ thuộc","section_id":"slot:assumptions","level":2,"guidance":"Liệt kê giả định (khác với sự thật đã biết) về môi trường, phần cứng, cách dùng, thành phần/dịch vụ bên thứ ba và hỗ trợ của tổ chức. Liệt kê phụ thuộc vào hệ thống, thư viện hoặc nhóm bên ngoài. Với mỗi mục, nêu tác động nếu giả định sai. Liên kết giả định với sổ rủi ro (risk register), kèm người chịu trách nhiệm và cách giảm thiểu nếu có."},
  {"key":"n12","heading_text":"2.6 Phân bổ yêu cầu","section_id":"slot:apportioning","level":2,"guidance":"Phân bổ các yêu cầu chính cho phân hệ, dịch vụ hoặc bản phát hành / vòng lặp. Dùng bảng đối chiếu để thể hiện phân bổ và chỉ rõ yêu cầu bị hoãn. Ghi rõ những phân bổ chưa xác định và theo dõi như việc cần làm."},
  {"key":"n13","heading_text":"3. Yêu cầu","section_id":"unmapped","level":1,"guidance":"Mục này đặc tả các yêu cầu KIỂM CHỨNG ĐƯỢC của sản phẩm, đủ chi tiết để thiết kế và kiểm thử. Dùng mã định danh duy nhất, từ khoá thống nhất (phải / nên / có thể — shall / should / may) và điều kiện rõ ràng. Mô tả đầu vào, xử lý và đầu ra khi phù hợp. Dẫn tới ràng buộc ở Mục 2.3 mà yêu cầu giải quyết. Dạng mã: REQ-[AREA]-[NNN]-[VER] (-[VER] tuỳ chọn khi có phiên bản), AREA ∈ {FUNC, INT, PERF, SEC, REL, AVAIL, OBS, COMP, INST, BUILD, DIST, MAINT, REUSE, PORT, COST, DEAD, POC, CM, ML}. Mã phải duy nhất và không đổi; khi sửa nội dung thì tăng -[VER] và ghi vào Lịch sử sửa đổi. Mỗi tạo tác kiểm thử có thể tham chiếu mã yêu cầu. Mỗi yêu cầu phải kiểm thử được và không mơ hồ: dùng thước đo chuẩn, tránh từ mơ hồ như \"thân thiện\", \"nhanh\"."},
  {"key":"n14","heading_text":"3.1 Giao diện bên ngoài","section_id":"unmapped","level":2,"guidance":"Đặc tả mọi đầu vào và đầu ra bên ngoài, gồm giao diện hệ thống cần dùng và giao diện hệ thống cung cấp. Định nghĩa giao diện đủ để triển khai và kiểm thử (định dạng, giao thức, thời gian…). Dùng tài liệu kiểm soát giao diện (ICD) hoặc schema khi phù hợp và tham chiếu tại đây."},
  {"key":"n15","heading_text":"3.1.1 Giao diện người dùng","section_id":"fixed:3.1.2","level":3,"guidance":"Mô tả cách người dùng tương tác với hệ thống ở mức logic. Định nghĩa thành phần UI, luồng và chuẩn phải theo (style guide, hướng dẫn khả năng tiếp cận). Gồm ràng buộc bố cục, điều khiển chung (trợ giúp, tìm kiếm), phím tắt, hành vi khi lỗi / khi trống, và bản địa hoá. Thiết kế hình ảnh (mockup) để trong đặc tả UI riêng và tham chiếu tới. Tham chiếu chuẩn khả năng tiếp cận (vd WCAG) và hướng dẫn của từng nền tảng. Có thể chia nhỏ: Khả năng sử dụng / tiếp cận (đầu vào, đầu ra, hộp thoại phù hợp khả năng và kỳ vọng người dùng) và Tiện lợi."},
  {"key":"n16","heading_text":"3.1.2 Giao diện phần cứng","section_id":"fixed:4.1","level":3,"guidance":"Chi tiết tương tác với thiết bị và nền tảng vật lý: loại thiết bị hỗ trợ / không hỗ trợ, tín hiệu dữ liệu / điều khiển, đặc tính điện hoặc cơ khí nếu liên quan, giao thức truyền thông. Gồm kỳ vọng về thời gian, thông lượng và độ tin cậy. Tham chiếu đặc tả phần cứng và yêu cầu chứng nhận áp dụng."},
  {"key":"n17","heading_text":"3.1.3 Giao diện phần mềm","section_id":"fixed:4.1","level":3,"guidance":"Định nghĩa tích hợp với thành phần và dịch vụ phần mềm khác: hệ thống kết nối (tên, phiên bản), dịch vụ / API cần dùng hoặc cung cấp, dữ liệu / thông điệp trao đổi, kiểu và giao thức truyền thông, ngữ nghĩa giới hạn / lỗi / timeout. Xác định dữ liệu dùng chung và chủ sở hữu. Ghi chính sách đánh phiên bản và tương thích ngược. Định nghĩa kỳ vọng xác thực / phân quyền cho từng tích hợp."},
  {"key":"n18","heading_text":"3.2 Chức năng","section_id":"group:3","level":2,"guidance":"Đặc tả các hành vi và chức năng quan sát được từ bên ngoài mà phần mềm phải cung cấp. Tổ chức yêu cầu chức năng theo tính năng, use case hoặc dịch vụ. Với mỗi chức năng, mô tả kích hoạt / đầu vào, xử lý (mức hộp đen), đầu ra và điều kiện lỗi. Với hành vi AI, định nghĩa giới hạn tính xác định (vd temperature), tiêu chí từ chối, quy tắc an toàn và điểm con người xem xét. Đưa vào trường hợp biên và kịch bản tiêu cực cho đầy đủ. Với tính năng AI, nêu hành vi dự phòng và ngưỡng để từ chối trả lời."},
  {"key":"n19","heading_text":"3.3 Chất lượng dịch vụ","section_id":"group:4.2","level":2,"guidance":"Các thuộc tính chất lượng ràng buộc hoặc bổ nghĩa cho hành vi chức năng. Dùng chỉ số, khoảng giá trị và điều kiện cụ thể. Khi một chất lượng chỉ áp dụng cho một phần chức năng, tham chiếu mã yêu cầu liên quan. Nêu lý do khi mục tiêu cắt ngang nhiều chức năng để hỗ trợ quyết định đánh đổi."},
  {"key":"n20","heading_text":"3.3.1 Hiệu năng","section_id":"fixed:4.2.3","level":3,"guidance":"Kỳ vọng về thời gian phản hồi, thông lượng và tài nguyên. Đặc tả quan hệ thời gian, tải đỉnh / ổn định và mục tiêu hiệu năng trong điều kiện dự kiến. Gồm cách đo, môi trường và ngưỡng chấp nhận. Nêu ràng buộc thời gian thực nếu có. Gồm mục tiêu mở rộng (scalability) và giả định hoạch định dung lượng. Có thể chia nhỏ: Thời gian (độ trễ, thông lượng…) và Không gian (bộ nhớ, lưu trữ, băng thông…)."},
  {"key":"n21","heading_text":"3.3.2 Bảo mật","section_id":"slot:security","level":3,"guidance":"Bảo vệ dữ liệu, danh tính và thao tác. Định nghĩa xác thực, phân quyền, bảo vệ dữ liệu (khi truyền / khi lưu), kiểm toán và quyền riêng tư. Xử lý lạm dụng và tấn công bên ngoài (injection, rò rỉ dữ liệu, chiếm quyền dịch vụ), gồm mặc định an toàn và yêu cầu ứng phó sự cố. Phân biệt biện pháp bắt buộc và khuyến nghị. Có thể chia nhỏ: An toàn (hậu quả có hại bên ngoài), Bảo mật thông tin (lộ dữ liệu cho bên không có quyền), Quyền riêng tư (dữ liệu riêng bị lộ khi chưa đồng ý), Toàn vẹn (dữ liệu bị sửa trái phép), Sẵn sàng (dữ liệu / tài nguyên có quyền sẵn sàng khi cần). Ghi chú: biện pháp bảo mật chung đặt ở đây; dẫn chéo từ 3.1 (kiểm tra ở mức giao diện, giao thức an toàn), 3.4 (nghĩa vụ pháp lý / hợp đồng, bằng chứng kiểm toán) và 3.6 (bảo vệ riêng của mô hình AI/ML)."},
  {"key":"n22","heading_text":"3.3.3 Độ tin cậy","section_id":"fixed:4.2.2","level":3,"guidance":"Khả năng thực hiện đúng như đặc tả một cách nhất quán. Đặc tả chỉ số và kỹ thuật (MTBF, error budget, thử lại / backoff, idempotency, dự phòng). Định nghĩa điều kiện đánh giá và hành vi chuyển dự phòng (failover). Định nghĩa suy giảm có kiểm soát (thành phần dự phòng, kết quả cache, heuristic xác định cho AI/ML), chính sách timeout / từ chối, và quay về phiên bản trước."},
  {"key":"n23","heading_text":"3.3.4 Tính sẵn sàng","section_id":"fixed:4.2.2","level":3,"guidance":"Thời gian hoạt động và mức sẵn sàng phục vụ. Định nghĩa mục tiêu sẵn sàng, khung bảo trì và cơ chế checkpoint, khôi phục, khởi động lại. Gồm dự phòng theo vùng địa lý / zone nếu có. Diễn đạt độ sẵn sàng theo cách người dùng hiểu (vd thời gian gián đoạn mỗi tháng) và gắn với SLA/SLO. Ghi hành vi scale-out/in ảnh hưởng tới độ sẵn sàng (vd thời gian failover tối đa, ràng buộc quorum)."},
  {"key":"n24","heading_text":"3.3.5 Khả năng quan sát","section_id":"fixed:4.2.4","level":3,"guidance":"Khả năng hiểu trạng thái và hành vi hệ thống khi chạy thật qua telemetry. Định nghĩa yêu cầu về log, metric, trace và profiling: sự kiện / trường, giới hạn cardinality, lấy mẫu, thời gian lưu, xử lý dữ liệu cá nhân trong telemetry. Đặc tả nhãn chuẩn (service, version, tenant), truyền mã tương quan / trace ID, chính sách che dữ liệu. Nêu luật cảnh báo theo SLO, dashboard và người phụ trách. Không ghi chi tiết quy trình bảo trì (runbook, trực ca để ở 3.5.4 Khả năng bảo trì)."},
  {"key":"n25","heading_text":"3.4 Tuân thủ","section_id":"fixed:5.4","level":2,"guidance":"Yêu cầu phát sinh để đáp ứng tiêu chuẩn, quy định hoặc hợp đồng bên ngoài. Đặc tả định dạng bắt buộc, quy ước đặt tên, thủ tục kế toán, quyền và thoả thuận của bên cung cấp / người dùng, thoả thuận bản quyền, truy vết kiểm toán, lưu giữ hồ sơ và báo cáo. Với mỗi mục, tham chiếu 2.3 Ràng buộc sản phẩm nếu có, hoặc trích trực tiếp nguồn có thẩm quyền."},
  {"key":"n26","heading_text":"3.5 Thiết kế và triển khai","section_id":"unmapped","level":2,"guidance":"Ràng buộc hoặc yêu cầu bắt buộc ảnh hưởng tới cách giải pháp được thiết kế, triển khai và bảo trì."},
  {"key":"n27","heading_text":"3.5.1 Cài đặt","section_id":"fixed:5.4","level":3,"guidance":"Bảo đảm phần mềm chạy ổn trong môi trường đích. Định nghĩa nền tảng / môi trường hỗ trợ và không hỗ trợ, điều kiện tiên quyết, cách cài đặt, cấu hình môi trường (biến môi trường, secret) và cách quay lui / gỡ cài đặt. Nêu kỳ vọng tự động hoá (IaC, script cài đặt, container image). Cơ chế mở rộng (topology, đa vùng) để ở 3.5.3 Phân tán; mục tiêu mở rộng để ở 3.3."},
  {"key":"n28","heading_text":"3.5.2 Build và phát hành","section_id":"fixed:5.4","level":3,"guidance":"Biện pháp kiểm soát việc build, đóng gói và phát hành tạo tác để bảo đảm toàn vẹn, truy vết và tái lập. Định nghĩa cách mã nguồn thành tạo tác triển khai được và đi qua các môi trường: tái lập build, quản lý phụ thuộc, bản quyền, quản lý cấu hình, kiểm tra tạo tác và thăng cấp bản phát hành. Dẫn chéo 3.5.1 Cài đặt và 3.5.10 Quản lý thay đổi cho thiết lập môi trường, đánh phiên bản và truy vết bản phát hành. Không ghi chi tiết topology vận hành (để ở 3.5.3 Phân tán)."},
  {"key":"n29","heading_text":"3.5.3 Phân tán","section_id":"slot:distribution","level":3,"guidance":"Triển khai, dữ liệu và thiết bị phân tán theo địa lý hoặc tổ chức. Đặc tả topology triển khai, cách phân bố / nhân bản thành phần và dữ liệu, runbook mở rộng, và ràng buộc do cấu trúc tổ chức hoặc mạng."},
  {"key":"n30","heading_text":"3.5.4 Khả năng bảo trì","section_id":"fixed:4.2.4","level":3,"guidance":"Thuộc tính giúp phần mềm dễ sửa, dễ vá và dễ phát triển tiếp. Định nghĩa kỳ vọng về tính module, độ phức tạp mã, giao diện, chuẩn lập trình, khả năng quan sát cho nhà phát triển, tài liệu, hiệu quả phát hành và quản lý nợ kỹ thuật."},
  {"key":"n31","heading_text":"3.5.5 Khả năng tái sử dụng","section_id":"fixed:4.2.4","level":3,"guidance":"Khuyến khích dùng lại thành phần giữa các sản phẩm khi phù hợp. Xác định thành phần dự định tái sử dụng và ràng buộc về phụ thuộc hoặc công nghệ. Đặc tả tính module, độ ổn định API, đóng gói và tài liệu để tái sử dụng được."},
  {"key":"n32","heading_text":"3.5.6 Khả năng chuyển đổi","section_id":"fixed:4.2.4","level":3,"guidance":"Khả năng chạy trên nhiều nền tảng hoặc môi trường với thay đổi tối thiểu. Đặc tả hệ điều hành, kiến trúc phần cứng, nhà cung cấp đám mây hoặc container runtime hỗ trợ / không hỗ trợ. Định nghĩa lớp trừu tượng, chính sách cấu hình và việc tách cấu hình theo môi trường."},
  {"key":"n33","heading_text":"3.5.7 Chi phí","section_id":"fixed:5.4","level":3,"guidance":"Các cân nhắc hoặc mục tiêu tài chính. Nêu giới hạn ngân sách, chi phí mỗi giao dịch, ràng buộc bản quyền hoặc hạn mức chi đám mây ảnh hưởng tới quyết định thiết kế. Giữ chi phí ở mức cao trừ khi hợp đồng quy định. Liên kết tới mô hình chi phí hoặc giả định TCO nếu có. Ghi kỳ vọng chi phí biến đổi / cố định ảnh hưởng tới chiến lược mở rộng."},
  {"key":"n34","heading_text":"3.5.8 Thời hạn","section_id":"fixed:5.4","level":3,"guidance":"Kỳ vọng tiến độ ảnh hưởng tới phạm vi và độ ưu tiên. Đặc tả mốc chính, ngày bàn giao hoặc giai đoạn / đợt. Nêu phụ thuộc giữa các mốc và tiêu chí sẵn sàng bắt buộc. Dùng thời hạn để định hướng Phân bổ yêu cầu (Mục 2.6)."},
  {"key":"n35","heading_text":"3.5.9 Thử nghiệm khái niệm (POC)","section_id":"fixed:5.4","level":3,"guidance":"Kiểm chứng tính khả thi và giảm rủi ro cho các giả định quan trọng trước khi làm toàn bộ. Định nghĩa mục tiêu, phạm vi, tiêu chí thành công và khung thời gian của mỗi POC. Mô tả điều sẽ được kiểm chứng (kỹ thuật, khả năng sử dụng, hiệu năng) và kết quả sẽ ảnh hưởng tới yêu cầu hoặc thiết kế ra sao. Giữ POC hẹp và đo được; tập trung vào mục tiêu kiểm chứng, không vào chi tiết triển khai."},
  {"key":"n36","heading_text":"3.5.10 Quản lý thay đổi","section_id":"fixed:5.4","level":3,"guidance":"Kiểm soát cách thay đổi được đưa vào và thông báo. Định nghĩa loại thay đổi (phá vỡ, bổ sung, sửa lỗi), luồng phê duyệt và tạo tác bắt buộc (changelog, tóm tắt đánh giá, hướng dẫn chuyển đổi, ghi chú phát hành). Đặc tả cam kết tương thích ngược / xuôi, kế hoạch thông báo cho khách hàng, lộ trình ngừng hỗ trợ, quy trình triển khai / quay lui."},
  {"key":"n37","heading_text":"3.6 AI/ML","section_id":"unmapped","level":2,"guidance":"Yêu cầu riêng cho hệ thống có thành phần học máy hoặc dựa trên dữ liệu làm cốt lõi. Bổ sung cho các yêu cầu chức năng, chất lượng và thiết kế ở trên, xử lý vòng đời, dữ liệu và các cân nhắc đạo đức riêng của ML. Bỏ mục này nếu sản phẩm không dùng AI/ML."},
  {"key":"n38","heading_text":"3.6.1 Đặc tả mô hình","section_id":"fixed:5.4","level":3,"guidance":"Định nghĩa mỗi mô hình dùng để làm gì và tiêu chí đo được cho hiệu năng chấp nhận được. Mô tả mục đích, phạm vi, hành vi mong đợi, đầu vào / đầu ra chính và mục tiêu hiệu năng đo được. Nêu bộ dữ liệu kiểm định, benchmark hoặc cách đánh phiên bản để bảo đảm tái lập. Phân biệt mục tiêu nền với cải thiện mong muốn; định nghĩa mức trôi (drift) chấp nhận được."},
  {"key":"n39","heading_text":"3.6.2 Quản lý dữ liệu","section_id":"fixed:5.4","level":3,"guidance":"Bảo đảm toàn vẹn, truy vết và vòng đời có đạo đức của dữ liệu dùng để huấn luyện, kiểm định và vận hành mô hình. Đặc tả nguồn gốc, chủ sở hữu, điều kiện đồng ý của bộ dữ liệu; quy trình gán nhãn và kiểm soát chất lượng; dòng dữ liệu, phiên bản và tái lập (huấn luyện → kiểm định → suy luận); lưu trữ, kiểm soát truy cập, chuẩn ẩn danh / giả danh; xử lý dữ liệu thiếu, tổng hợp hoặc tăng cường."},
  {"key":"n40","heading_text":"3.6.3 Guardrails","section_id":"fixed:5.4","level":3,"guidance":"Bảo đảm hệ thống AI vận hành an toàn, dự đoán được và trong ranh giới đã duyệt. Đặc tả cách hệ thống kiểm tra đầu vào, lọc hoặc giới hạn đầu ra, và giới hạn hành động được phép để tránh gây hại, lạm dụng hoặc hậu quả ngoài ý muốn. Gồm cơ chế phát hiện và phản ứng với đầu vào độc hại hoặc điều kiện vận hành không an toàn. Xử lý guardrail ở cả ba lớp: đầu vào, đầu ra và hành động. Định nghĩa quy trình leo thang, ghi log và quay lui khi ràng buộc an toàn bị kích hoạt. Dẫn chéo 3.3.2 Bảo mật cho bảo vệ mức hệ thống và 3.6.4 Đạo đức cho kỳ vọng chuẩn mực."},
  {"key":"n41","heading_text":"3.6.4 Đạo đức","section_id":"fixed:5.4","level":3,"guidance":"Công bằng, minh bạch và trách nhiệm giải trình trong hành vi và kết quả của mô hình. Định nghĩa cách nhận diện, đo lường và quản lý các cân nhắc đạo đức trong phát triển và vận hành: mục tiêu công bằng, kỳ vọng giải thích được, yêu cầu tài liệu hoặc rà soát. Dùng chỉ số công bằng phù hợp bối cảnh (vd demographic parity, equal opportunity). Có thể chia nhỏ: Công bằng (thiên lệch xã hội trong kết quả), Diễn giải được (xem được bên trong mô hình), Giải thích được (giải thích được một đầu ra cho một đầu vào). Phối hợp với 3.6.3 Guardrails cho cơ chế thực thi và 3.6.5 cho giám sát của con người."},
  {"key":"n42","heading_text":"3.6.5 Human-in-the-Loop","section_id":"fixed:5.4","level":3,"guidance":"Vai trò giám sát của con người với quyết định do mô hình ảnh hưởng hoặc đưa ra. Mô tả nơi và cách con người xem xét, phê duyệt hoặc can thiệp. Làm rõ kỳ vọng về độ trễ / khối lượng xem xét, đường leo thang, cơ chế phản hồi, truy vết và kiểm toán thao tác của con người. Liên kết tới vai trò đã định nghĩa ở 2.4 Đặc điểm người dùng."},
  {"key":"n43","heading_text":"3.6.6 Vòng đời và vận hành mô hình","section_id":"fixed:5.4","level":3,"guidance":"Yêu cầu về triển khai, giám sát, huấn luyện lại và ngừng dùng mô hình khi chạy thật. Nêu cách mô hình chuyển từ phát triển sang vận hành, cách giám sát hiệu năng và chất lượng dữ liệu, cách kích hoạt và quản lý huấn luyện lại hoặc quay lui. Gồm kỳ vọng về đánh phiên bản và lưu trữ."},
  {"key":"n44","heading_text":"4. Kiểm chứng","section_id":"slot:verification","level":1,"guidance":"Mô tả cách từng yêu cầu được kiểm chứng để có bằng chứng khách quan về việc tuân thủ. Nêu phương pháp kiểm chứng (test, chỉ số canary, analysis, inspection, demonstration) và bằng chứng kiểm thử, tốt nhất là ma trận song song với Mục 3. Cân nhắc ghi chi tiết môi trường, công cụ và yêu cầu dữ liệu kiểm thử. Gồm cả kiểm thử dương và âm, và kiểm chứng phi chức năng (hiệu năng, bảo mật, độ tin cậy). Tạo tác kiểm chứng có thể đánh phiên bản và liên kết với CI/CD. Với AI, tham chiếu Model Card, theo dõi phiên bản bộ dữ liệu đánh giá và bảo đảm tái lập kết quả."},
  {"key":"n45","heading_text":"5. Phụ lục","section_id":"group:5","level":1,"guidance":"Tài liệu hỗ trợ không bắt buộc, giúp hiểu nội dung mà không phải yêu cầu. Gồm bảng thuật ngữ, từ điển dữ liệu, mô hình / sơ đồ, bộ dữ liệu mẫu hoặc phân tích tác động thay đổi hỗ trợ các mục chính. Tham chiếu thay vì chép lại nội dung khi có thể. Sắp xếp phụ lục gọn gàng và tham chiếu tới chúng từ phần chính."}
]

const o = (key: string, heading_text: string, level: number, section_id: string): OldHeading => ({ key, heading_text, level, section_id })

/** Khung FPT của ChoViet sau import, theo thứ tự tài liệu (mỗi tính năng giữ 2 chức năng). */
export const CHOVIET_HEADINGS: OldHeading[] = [
  o("o0", "I. Lịch sử thay đổi", 1, "fixed:I"),
  o("o1", "1 Tổng quan sản phẩm", 1, "custom:c1"),
  o("o2", "Mục tiêu", 2, "slot:goals"),
  o("o3", "Phạm vi phát hành 1.0", 2, "slot:scope"),
  o("o4", "Trong phạm vi", 3, "slot:scope"),
  o("o5", "Ngoài phạm vi", 3, "slot:scope"),
  o("o6", "Quy tắc nghiệp vụ tổng quát", 2, "fixed:1"),
  o("o7", "Hệ thống bên ngoài", 2, "slot:context"),
  o("o8", "2 Yêu cầu người dùng", 1, "group:2"),
  o("o9", "2.1 Tác nhân", 2, "fixed:2.1"),
  o("o10", "2.2 Use case", 2, "group:2.2"),
  o("o11", "2.2.1 Sơ đồ use case", 3, "fixed:2.2.1"),
  o("o12", "2.2.2 Đặc tả use case", 3, "fixed:2.2.2"),
  o("o13", "3 Yêu cầu chức năng", 1, "group:3"),
  o("o14", "3.1 Tổng quan chức năng hệ thống", 2, "group:3.1"),
  o("o15", "3.1.1 Luồng màn hình", 3, "fixed:3.1.1"),
  o("o16", "3.1.2 Mô tả màn hình", 3, "fixed:3.1.2"),
  o("o17", "3.1.3 Phân quyền màn hình", 3, "fixed:3.1.3"),
  o("o18", "3.1.4 Chức năng không có màn hình", 3, "fixed:3.1.4"),
  o("o19", "3.1.5 Sơ đồ quan hệ thực thể", 3, "fixed:3.1.5"),
  o("o20", "3.2 Tài khoản và truy cập", 2, "feature:F01"),
  o("o21", "3.2.1 Đăng nhập", 3, "function:FN01"),
  o("o22", "3.2.2 Đăng ký tài khoản", 3, "function:FN02"),
  o("o23", "3.3 Khám phá sản phẩm", 2, "feature:F02"),
  o("o24", "3.3.1 Duyệt trang chủ", 3, "function:FN03"),
  o("o25", "3.3.2 Tìm kiếm sản phẩm", 3, "function:FN04"),
  o("o26", "3.4 Giỏ hàng và thanh toán", 2, "feature:F03"),
  o("o27", "3.4.1 Đặt hàng", 3, "function:FN05"),
  o("o28", "3.4.2 Thanh toán đơn hàng", 3, "function:FN06"),
  o("o29", "3.5 Đơn hàng và trả hàng", 2, "feature:F04"),
  o("o30", "3.5.1 Theo dõi đơn hàng", 3, "function:FN07"),
  o("o31", "3.5.2 Xác nhận đã nhận hàng", 3, "function:FN08"),
  o("o32", "3.6 Quản lý Shop của người bán", 2, "feature:F05"),
  o("o33", "3.6.1 Đăng ký shop người bán", 3, "function:FN09"),
  o("o34", "3.6.2 Xem tổng quan Shop", 3, "function:FN10"),
  o("o35", "3.7 Quản trị nền tảng", 2, "feature:F06"),
  o("o36", "3.7.1 Duyệt shop", 3, "function:FN11"),
  o("o37", "3.7.2 Khoá tài khoản vi phạm", 3, "function:FN12"),
  o("o38", "4 Yêu cầu phi chức năng", 1, "group:4"),
  o("o39", "4.1 Giao tiếp hệ thống ngoài", 2, "fixed:4.1"),
  o("o40", "4.2 Thuộc tính chất lượng", 2, "group:4.2"),
  o("o41", "4.2.1 Tính khả dụng", 3, "fixed:4.2.1"),
  o("o42", "4.2.2 Độ tin cậy", 3, "fixed:4.2.2"),
  o("o43", "4.2.3 Hiệu năng", 3, "fixed:4.2.3"),
  o("o44", "4.2.4 Thuộc tính đặc thù", 3, "fixed:4.2.4"),
  o("o45", "5 Phụ lục yêu cầu", 1, "group:5"),
  o("o46", "5.1 Quy tắc nghiệp vụ", 2, "fixed:5.1"),
  o("o47", "5.2 Yêu cầu chung", 2, "fixed:5.2"),
  o("o48", "5.3 Danh sách thông báo", 2, "fixed:5.3"),
  o("o49", "5.4 Yêu cầu khác", 2, "fixed:5.4"),
  o("o50", "5.5 Thuật ngữ", 2, "fixed:5.5")
]

/** Tóm tắt dữ liệu Spine của mục cũ (theo `old_key`): số phần tử + mẫu nội dung + phần tử (khi cần chia theo phần tử). */
export const CHOVIET_DATA: ReadonlyMap<string, { size: number; sample: string; items?: { id: string | null; text: string }[] }> = new Map([
  ["o2", { size: 4, sample: "Người mua tìm và đặt hàng trong 3 bước. Người bán mở shop trong một ngày." }],
  ["o6", { size: 9, sample: "Mỗi đơn hàng chỉ thuộc một shop. Người bán phải xác nhận đơn trong 24 giờ." }],
  ["o7", { size: 4, sample: "Cổng thanh toán nhận yêu cầu qua API. Đơn vị vận chuyển nhận đơn qua webhook." }],
  ["o12", { size: 35, sample: "Người mua đặt hàng. Người bán xác nhận đơn hàng. Quản trị viên duyệt shop." }],
  ["o15", { size: 41, sample: "Màn hình đăng nhập chuyển sang màn hình trang chủ." }],
  ["o17", { size: 41, sample: "Vai trò người bán được xem và sửa màn hình quản lý sản phẩm." }],
  ["o18", { size: 53, sample: "Tự động huỷ đơn hàng chưa xác nhận sau 24 giờ." }],
  ["o19", { size: 16, sample: "Thực thể Đơn hàng gồm mã đơn, trạng thái, tổng tiền." }],
  ["o39", { size: 4, sample: "Hệ thống tích hợp cổng thanh toán và đơn vị vận chuyển qua HTTPS, dữ liệu JSON." }],
  ["o41", { size: 3, sample: "Người dùng mới đặt được đơn đầu tiên không cần hướng dẫn." }],
  [
    "o42",
    {
      size: 2,
      sample: "Hệ thống tự thử lại khi cổng thanh toán lỗi. Uptime 99,9% mỗi tháng.",
      items: [
        { id: "NFR-05", text: "Hệ thống tự thử lại tối đa 3 lần khi cổng thanh toán lỗi, có dự phòng." },
        { id: "NFR-06", text: "Uptime 99,9% mỗi tháng, thời gian gián đoạn tối đa 45 phút." }
      ]
    }
  ],
  ["o46", { size: 87, sample: "Giá sản phẩm phải lớn hơn 0. Mã giảm giá chỉ dùng một lần cho mỗi đơn hàng." }],
  ["o48", { size: 184, sample: "MSG-01 Đăng nhập thành công. MSG-02 Mật khẩu không đúng." }],
  ["o49", { size: 15, sample: "Rủi ro: đơn vị vận chuyển chậm cập nhật trạng thái. Câu hỏi mở: có hỗ trợ trả góp không." }]
])

/** Mục mẫu đích có dữ liệu sẵn trong Spine (in từ Spine dù không có cặp): tầm nhìn, giả định. */
export const JAM01_FILLED_FROM_SPINE: ReadonlySet<string> = new Set(["n1", "n11"])
