# Phương án đo khối lượng chính xác cho công trình phức tạp

Tài liệu nghiên cứu, lập ngày 12/11/2026. Các giai đoạn 1 đến 4 đã triển khai ngày 13/11/2026 (mục 0); giai đoạn 5 và 6 xem mục 0.

## 0. Tình trạng triển khai (13/11/2026)

**Đã có trong công cụ**

| Phần | Ở đâu | Kết quả trên nhà mẫu 5×18 |
|---|---|---|
| Bộ quy tắc đo bóc là dữ liệu: `PL6` (Phụ lục VI, mặc định), `NET` (hình học), hoặc ngưỡng riêng | `rules.mjs`; tham số `rules` của `draw_quantity_schedule`, `draw_finish_quantities`, `material_schedule` | Mỗi dòng có khối lượng theo quy tắc và khối lượng hình học, ba số lẻ |
| Mô hình bề mặt cho hoàn thiện (Kiến trúc và Nội thất dùng chung) | `surfaces.mjs` | 127 mặt được AutoCAD đo lại; 116 phép kiểm tra chéo đạt, 0 không đạt |
| Mô hình khối cho bê tông, ván khuôn, xây, trát, đào đắp, nền | `solids.mjs`, `boq.mjs` | 166 cấu kiện; 22 phép kiểm tra chéo đạt, 0 không đạt |
| AutoCAD đo độc lập | cầu nối `measure_model`; công cụ `measure_model`, `verify_quantities` | Kết cấu: bảng 86,146370 m³, AutoCAD 86,146370 m³. Hoàn thiện: bảng 1396,652 m², AutoCAD 1396,652 m². Mặt sàn từng tầng khớp |
| Bảng chi tiết kiểu Bảng 6.2 bằng công thức sống, sheet kiểm tra | `finishbook.mjs` (sheet Bề mặt, Cầu thang, Cửa, Kiểm tra), `workbooks.mjs` | Excel mở không lỗi công thức; tổng trong Excel bằng bảng |

Khác với đề xuất ở mục 4: phép cắt và hợp làm trên lưới ô dựng từ chính tọa độ của mô hình (chính xác với hình vuông góc), không dùng thư viện Clipper2; AutoCAD là bên đo độc lập.

**Các mặt và khối đã đo theo bề mặt, thể tích thật**

- Tường: từng mặt theo chiều cao tường phía sau, trừ lỗ cửa, cộng má cửa; phòng không có trần treo thì tới đáy sàn.
- Trần: phần phẳng và mặt đứng của giật cấp. Sàn: trừ ô thang, vệt thang thẳng, chân cột; cộng dải sàn dưới cửa.
- Cầu thang: mặt bậc, cổ bậc, len theo bậc, tay vịn theo dốc, đáy bản thang.
- Chống thấm: sàn, phần quét lên tường giữa các cửa, dải dưới cửa. Mặt ngoài nhà, đỉnh tường mái, mái dốc theo diện tích thật.
- Khi đã chạy `structural_calc`: hai mặt bên của dầm lộ dưới trần bê tông sơn, mặt cột nhô khỏi tường.
- Bê tông: chỗ giao chỉ thuộc một cấu kiện (sàn > dầm > tường > cột); tổng thể tích thực bằng hợp của các khối.
- Đất: đào hố móng và rãnh giằng (hố chồng nhau tính một lần), đắp trả = đào − phần chôn, đất thừa. Bê tông nền và lớp tôn nền. Bậc xây cầu thang. Lanh tô.

**Chưa làm hoặc còn giới hạn**

- Giai đoạn 5 (hình học phức tạp): mô hình đo được những gì `draw_plan` mô tả được. Tường cong (dựng bằng dây cung, sai số chiều dài dưới 0,3%), mái hông bốn mái cùng độ dốc, thang chữ L và thang xoắn đã vẽ và đo được (bản sau 1.3.1). Chưa có: mái nhiều khối giao nhau, mái hông khác độ dốc; bê tông thang thẳng, thang chữ L, thang xoắn và lỗ sàn tầng trên của chúng trong bảng kết cấu.
- Giai đoạn 6 (điện, nước): bảng khối lượng đã tính đoạn đứng (dây xuống công tắc, ổ cắm; ống đứng; ống xuống vòi và xi phông) bằng công thức, chưa phải tuyến 3D đếm phụ kiện theo nút.
- Đã làm (bản sau 1.3.1): len chân tường quấn quanh cột lộ; mặt bên dầm trừ phần dầm khác giao vào (một mặt ở chỗ nối chữ T, hai mặt ở chỗ giao chữ thập); trần thạch cao khoét ở chỗ thang thẳng đi qua (từ chỗ bậc thang cách trần dưới 2 m đến đầu vế).
- Thang chữ U đặt trong phòng không phải phòng thang đã trừ sàn phòng đó (bản sau 1.3.1).
- Thang thẳng chưa có bậc xây trong bảng kết cấu. Hố đào có mái dốc chồng nhau tính gần đúng (dung sai 0,2%). Tường xiên: vùng bê tông nền lấy theo lưới 50 mm.
- Không có trong mô hình (ghi ở mục "chưa tính" của bảng): râu thép và trụ liên kết tường, chống vách hố đào, hạ mực nước, ván khuôn bê tông lót.
- Vế thang trong phép đo của AutoCAD là bản phẳng cùng thể tích (không phải bản nghiêng); thể tích vẫn khớp.
- Chưa đối chiếu với mô hình SketchUp và chưa có kỹ sư dự toán duyệt bộ quy tắc mặc định (mục 8).

## 1. Kết luận

Cách cho khối lượng đúng nhất là **dựng một mô hình bề mặt và khối đặc duy nhất của công trình, rồi suy mọi khối lượng từ mô hình đó**. Công thức theo từng hạng mục (diện tích phòng nhân mã vật liệu, chu vi nhân một chiều cao) chỉ giữ lại làm phép kiểm tra độc lập.

Năm điểm của phương án:

1. **Một mô hình, nhiều bảng.** Mỗi mặt hoàn thiện là một đa giác phẳng mang mã vật liệu; mỗi cấu kiện là một khối đặc. Bảng Kiến trúc, Nội thất, Kết cấu đều cộng từ cùng một danh sách nên không thể lệch nhau.
2. **Hai con số cho mỗi dòng.** Khối lượng hình học thật (đã khử chồng lấn) và khối lượng theo quy tắc đo bóc (ngưỡng không trừ lỗ, giao cột – dầm – sàn tính cho ai). Quy tắc là dữ liệu sửa được, không viết cứng trong mã.
3. **Sổ trừ – cộng cho từng mặt.** Mỗi mặt lưu diện tích gộp, từng khoản trừ (cửa nào, bao nhiêu), từng khoản cộng (má cửa) và diện tích ròng, để ra được cột "diễn giải tính toán".
4. **Người kiểm tra độc lập.** Chính AutoCAD tính lại diện tích và thể tích bằng nhân hình học của nó; cộng thêm bộ kiểm tra chéo tự động và các công trình mẫu có đáp án tính tay.
5. **Đầu ra theo mẫu chính thức.** Bảng tổng hợp và bảng chi tiết theo Bảng 6.1, 6.2 của Phụ lục VI (ký hiệu bản vẽ, mã hiệu, số bộ phận giống nhau, diễn giải, làm tròn ba số lẻ), dưới dạng Excel có công thức.

## 2. Bằng chứng

**Nghiên cứu về đo khối lượng từ mô hình (BIM)**

- Luận án của Khosakitchalert (Đại học Osaka): lấy lớp hoàn thiện từ cấu kiện chưa khử chồng lấn cho sai số từ −10,78% đến +43,18% với tường và 0 đến 19,09% với sàn; trong một mô hình phức tạp tường sai tới +100,85% vì lớp hoàn thiện chạy hết chiều cao tầng, vượt lên trên trần. Sau khi khử chồng lấn bằng hình học, hầu hết các lớp còn trong ±1%.
- Liu và cộng sự (2022): cùng một kết cấu dựng theo ba cách nối cấu kiện cho ba bộ khối lượng khác nhau. Muốn đúng quy tắc đo bóc thì ngưỡng lỗ rỗng và quyền sở hữu phần giao phải khai báo rõ.
- Chuẩn IFC chỉ định nghĩa khối lượng theo công thức cho hình lăng trụ; diện tích tường của IFC là mặt giữa tường, không phải mặt hoàn thiện; vế thang trong IFC không có diện tích mặt bậc, cổ bậc.
- Các phần mềm làm tốt phần hoàn thiện (Allplan, Archicad) đều đo theo bề mặt của phòng: trừ lỗ cửa, cộng má cửa, và Allplan giữ riêng "khối lượng theo quy tắc" bên cạnh khối lượng hình học.
- Hướng dẫn của RICS: đối chiếu tổng diện tích đo trên 2D với tổng của mô hình; ghi rõ từng khối lượng là tự động, suy ra hay nhập tay.

**Thử nghiệm trên AutoCAD 2024**

- AutoCAD (qua cầu nối) hợp hai khối đặc cột 220×220×3000 và dầm 2000×200×400 giao nhau: thể tích 0,2964 m³, đúng bằng tính tay (0,1452 + 0,1600 − 0,0088).
- AutoCAD trừ lỗ cửa 0,8×2,4 khỏi mặt tường 4,6×2,8: diện tích 10,96 m², đúng bằng tính tay.
- Cầu thang nhà mẫu sau khi đổi sang đo bề mặt thực: đá granite 29,65 → 39,42 m² (thêm cổ bậc 11,47 m²), len theo bậc 33,85 → 43,22 m. Bảng Kiến trúc và bảng Nội thất nay ra cùng một số.

## 3. Hiện trạng trước khi triển khai (12/11/2026)

| Hạng mục | Cách đo hiện nay | Thiếu hoặc sai |
|---|---|---|
| Cầu thang (đá, len, tay vịn) | Theo hình học từng vế thang | Đã sửa |
| Trần giật cấp | Diện tích mặt bằng phòng | Mặt đứng của phần giật cấp (ước khoảng 7% diện tích trần nhà mẫu) |
| Tường ốp, bả, sơn | Chu vi phòng × chiều cao − lỗ cửa | Má cửa; mặt cột, dầm lộ; tường cao khác nhau trong một phòng |
| Sàn lát | Diện tích phòng | Chưa trừ chân cột, tủ cố định (tùy quy tắc) |
| Bê tông nút cột – dầm | Tính cho cột | Phụ lục VI (bản 2025) tính cho dầm |
| Ống thoát nước | Mặt bằng + ống đứng | Đoạn đứng xuống từng thiết bị |
| Ngưỡng không trừ lỗ | Trừ mọi lỗ | Phụ lục VI: không trừ lỗ dưới 0,25 m² (xây, hoàn thiện), 1 m² (ván khuôn), 0,1 m³ (bê tông) |
| Bảng diễn giải | Diễn giải theo tầng | Chưa theo Bảng 6.2 (ký hiệu bản vẽ, số bộ phận giống nhau) |

## 4. Kiến trúc đề xuất

**Mặt (face)**: loại (sàn, trần, tường, má cửa, đáy sàn, mặt dầm, mặt cột, mặt bậc, cổ bậc, mặt mái, mặt giật cấp); mặt phẳng chứa nó (hoặc mặt trụ trải phẳng cho tường cong, để diện tích vẫn chính xác); đường bao và các lỗ; cấu kiện chủ và phía; phòng mà nó nhìn vào; mã hoàn thiện; diện tích gộp, các khoản trừ, các khoản cộng, diện tích ròng; các cạnh có kiểu (cạnh chân tường để tính len, cạnh trần để tính phào); nguồn gốc (sinh từ đâu, theo quy tắc nào).

**Khối (solid)**: cấu kiện, vật liệu, hình lăng trụ (tiết diện, cao độ đáy và đỉnh), thể tích gộp, các phần bị cắt (bởi cấu kiện nào, theo quy tắc nào), thể tích ròng, các mặt tiếp xúc (để ra ván khuôn, trát).

**Dòng khối lượng**: mã công tác, đơn vị, bộ quy tắc, giá trị, danh sách mặt hoặc khối đóng góp, công thức diễn giải.

**Cách tính**

- Phép cắt, trừ làm trong 2D, trên từng mặt phẳng, với tọa độ nguyên (thư viện Clipper2), diện tích theo công thức đa giác. Không cần nhân CAD 3D trong máy chủ.
- Một lỗ cửa sinh ra: một lỗ trên cả hai mặt tường, tối đa bốn mặt má cửa, và một dải ngưỡng cửa.
- Phần giao giữa cấu kiện xử lý bằng một bảng ưu tiên là dữ liệu (theo Phụ lục VI: sàn > dầm > tường > cột): một đa giác giao duy nhất vừa là phần cắt của bên thua, vừa là phần trừ diện tích tiếp xúc của cả hai.
- Quy tắc đo bóc áp sau cùng: cơ sở đo, đơn vị, ngưỡng lỗ, cách xử lý má cửa, làm tròn.

## 5. Quy tắc đo bóc của Việt Nam

**Tình trạng văn bản (theo tra cứu ngày 12/11/2026, cần kỹ sư dự toán xác nhận)**

- Quy tắc chi tiết gần nhất là Phụ lục VI của Thông tư 13/2021/TT-BXD, khoản bê tông sửa bởi Thông tư 01/2025/TT-BXD.
- Thông tư 37/2026/TT-BXD (hiệu lực 01/7/2026) đã thay Thông tư 13/2021 và không còn phụ lục đo bóc. Thay vào đó là Quyết định 1041/QĐ-BXD "Hướng dẫn xác định khối lượng công trình", chỉ nêu nguyên tắc, mang tính tham khảo.
- Vì vậy bộ quy tắc mặc định đề xuất là Phụ lục VI (bản hợp nhất), cho phép đổi theo quy định riêng của từng công ty.

**Các quy tắc làm thay đổi con số**

| Công tác | Quy tắc |
|---|---|
| Bê tông | Không trừ cốt thép; không trừ lỗ rỗng dưới 0,1 m³; nút cột – dầm tính cho dầm; dầm, cột, vách nằm trong chiều dày sàn tính cho sàn; cột liền tường tính cho tường |
| Ván khuôn | Bề mặt bê tông cần chống đỡ; không trừ lỗ dưới 1 m² |
| Cốt thép | Theo đường kính danh nghĩa; gồm nối chồng, con kê, thép chống; nhóm Ø≤10, ≤18, >18 |
| Xây | Không trừ khoảng trống dưới 0,25 m²; chiều dày không kể lớp trát, ốp |
| Trát, bả, sơn, ốp, lát | Bề mặt cần hoàn thiện, kể cả bờ, góc, phần lõm, lồi; không trừ lỗ dưới 0,25 m²; gờ chỉ, phào tính riêng |
| Ống | Chiều dài theo tim ống, qua cả phụ kiện và van, không kể hố ga |
| Trình bày | Bảng 6.1, 6.2; làm tròn ba số lẻ; ghi rõ khối lượng xác định bằng phần mềm |

Cầu thang, cửa, lan can, trần giật cấp không có quy tắc đo riêng trong Phụ lục VI, chỉ có đơn vị của định mức. Các hạng mục này đo theo bề mặt thực.

## 6. Bộ kiểm tra chéo tự động

1. Mỗi tầng: tổng diện tích sàn các phòng + chân tường, chân cột + hộp kỹ thuật = diện tích mặt sàn.
2. Mỗi phòng: diện tích sàn = hình chiếu của trần + khoảng thông tầng; diện tích trần thật ≥ hình chiếu.
3. Mỗi phòng: các mặt tường khép kín đúng chu vi phòng.
4. Chiều dài len = chu vi − bề rộng cửa đi + chu vi cột lộ.
5. Mỗi lỗ cửa được trừ cùng một diện tích trên đúng hai mặt.
6. Diện tích má cửa = chu vi lỗ (trừ ngưỡng với cửa đi) × chiều sâu.
7. Mỗi mặt: gộp − trừ + cộng = ròng.
8. Mỗi khối: thể tích theo lưới mặt = thể tích theo công thức lăng trụ.
9. Tổng thể tích ròng = thể tích hợp của toàn bộ kết cấu (AutoCAD tính độc lập).
10. Diện tích tiếp xúc A với B = B với A.
11. Mỗi mặt nhìn vào phòng có đúng một mã hoàn thiện hoặc ghi rõ "không hoàn thiện".
12. Cầu thang: tổng chiều cao bậc = chiều cao tầng; số mặt bậc mỗi vế = số cổ bậc − 1.
13. Mái: tổng hình chiếu các mặt mái = diện tích phủ; diện tích thật = hình chiếu / cos góc dốc.
14. Cấu kiện đơn giản: giá trị công thức = giá trị mô hình trong dung sai.
15. Cùng một mã vật liệu: bảng Kiến trúc = bảng Nội thất.

## 7. Lộ trình

| Giai đoạn | Nội dung | Tiêu chí nghiệm thu |
|---|---|---|
| 1 | Mô hình bề mặt cho hoàn thiện (Kiến trúc và Nội thất dùng chung): sàn, tường có má cửa, trần có mặt giật cấp, mặt cột và dầm lộ, cầu thang, mặt ngoài nhà | Kiểm tra 1–7, 11, 12, 15 đạt trên nhà mẫu; ba công trình mẫu có đáp án tính tay khớp trong 0,5% |
| 2 | Mô hình khối cho kết cấu, xây, trát: bảng ưu tiên phần giao, ván khuôn theo mặt tiếp xúc, bộ quy tắc Phụ lục VI | Kiểm tra 8–10, 14 đạt; hai con số (hình học, theo quy tắc) cho mọi dòng |
| 3 | Công cụ kiểm chứng: AutoCAD dựng khối và mặt rồi so với số của máy chủ; đối chiếu với mô hình SketchUp | Lệch dưới 0,1% trên nhà mẫu; báo rõ dòng nào lệch |
| 4 | Bảng chi tiết theo Bảng 6.2 trong Excel sống, có danh sách "chưa tính" và nhãn tự động, suy ra, nhập tay | Kỹ sư dự toán đọc được không cần giải thích |
| 5 | Hình học phức tạp: tường cao khác nhau, thông tầng, lệch tầng, mái dốc nhiều mặt, tường cong, thang thẳng, chữ L, xoắn | Mỗi dạng có công trình mẫu và đáp án |
| 6 | Điện, nước: tuyến 3D có đoạn lên xuống, đếm phụ kiện theo nút tuyến | Chiều dài theo tim ống, qua phụ kiện |

## 8. Việc cần người dùng quyết định

- Bộ quy tắc mặc định: Phụ lục VI (bản hợp nhất 2025) hay quy định nội bộ của công ty.
- Thứ tự ưu tiên phần giao bê tông khi quy tắc không nói rõ (móng, cầu thang).
- Có trừ diện tích sàn dưới tủ cố định, thiết bị vệ sinh hay không.
- Hệ số hao hụt: để ở định mức (như hiện nay với ống, thép) hay hiện thành cột riêng.

## 9. Nguồn

- Phụ lục VI Thông tư 13/2021/TT-BXD và văn bản hợp nhất 37/VBHN-BXD: https://datafiles.chinhphu.vn/cpp/files/vbpq/2026/6/37-vbhn-bxd-6.docx
- Thông tư 37/2026/TT-BXD: https://datafiles.chinhphu.vn/cpp/files/vbpq/2026/7/37-bxd.signed.pdf
- Quyết định 1041/QĐ-BXD (bản sao của bên thứ ba): https://qlda.gxd.vn/van-ban/chi-phi/quyet-dinh-1041-qd-bxd.html
- Định mức Thông tư 12/2021/TT-BXD, Phụ lục II: https://congbaocdn.chinhphu.vn/CongBaoCP/VanBan/2021/8/34408/37006-1-2021771-77212-2021-tt-bxd.pdf
- Khosakitchalert, luận án Đại học Osaka: https://ir.library.osaka-u.ac.jp/repo/ouka/all/77497/31487_Dissertation.pdf
- Liu, Cheng, Gan, Zhou (2022): https://spiral.imperial.ac.uk/handle/10044/1/103193
- RICS, BIM for cost managers: https://www.rics.org/content/dam/ricsglobal/documents/standards/bim_for_cost_managers_1st_edition_rics.pdf
- IFC 4.3, các bộ Qto: https://github.com/buildingSMART/IFC4.3.x-development/tree/master/reference_schemas/psd
- Allplan, bề mặt hoàn thiện đứng: https://help.allplan.com/Allplan/2015-1/1033/Allplan/9925.htm
- Clipper2, độ bền số học: https://angusj.com/clipper2/Docs/Robustness.htm
