# Đọc mặt bằng của bản vẽ cũ

Tài liệu lập ngày 13/11/2026. Công cụ: `read_plan`. Mã nguồn: máy chủ `mcpb/src/readplan.mjs`, cầu nối `bridge/src/PlanRead.cs`.

## 1. Mục đích

Bản vẽ do công cụ này vẽ thì lưu sẵn mô tả công trình, nên sửa và cập nhật tại chỗ được (`update`). Bản vẽ của người khác chỉ có nét. `read_plan` đọc nét đó thành mô tả mặt bằng của `draw_plan`. Từ đó có hai việc:

- **Xem trước** (`preview`): vẽ đè phần đọc được lên bản vẽ để so sánh, trên layer `X-READ-PLAN` không in. Tường màu đỏ, cửa đi xanh dương, cửa sổ xanh lá, lỗ mở cam, tên phòng tím.
- **Nhận về** (`adopt`): làm ba việc.
  - Đối tượng đã đọc (mặt tường, cung cửa, khối cửa, trục, tên phòng) và kích thước cũ của mặt bằng được chuyển sang layer `X-OLD-PLAN`, đóng băng và không in. Không xóa gì.
  - Mặt bằng được vẽ lại đúng chỗ bằng `draw_plan`.
  - Mặt bằng đó thành mặt bằng của bản vẽ: sửa bằng `draw_plan update: true`, vẽ mặt đứng, mặt cắt, bảng khối lượng từ đó.

## 2. Cách đọc

- **Hình học:** lấy toàn bộ nét theo tọa độ thế giới. Mặt bằng nằm trong khối hoặc xref đã bind thì được mở ra; khối nhỏ (cửa, ký hiệu, đồ đạc) giữ nguyên là khối.
- **Tường:** hai mặt song song cách nhau 80–450 mm (đặt được bằng `thickness`). Lấy trên layer tường nếu bản vẽ có; nếu layer tường thiếu thì lấy trên mọi layer không phải chú thích, chọn bên nào ra nhiều tường hơn.
  - Mỗi mặt chỉ ghép với mặt gần nhất.
  - Các đoạn cùng trục, cùng chiều dày được nối lại.
  - Đầu tường kéo tới trục của tường nó gặp (góc chữ L, chữ T).
- **Lỗ mở:** đoạn mà cả hai mặt tường cùng dừng, dài 0,45–4 m.
  - Có cung mở cửa hoặc khối cửa là cửa đi. Hai cánh thì ra cửa hai cánh. Hướng mở lấy theo cung hoặc theo phía khối cửa nhô ra.
  - Có nét kính dọc tường hoặc khối cửa sổ là cửa sổ.
  - Không có gì là lỗ mở trống.
  - Ký hiệu (D1, S1) lấy từ chữ hoặc thuộc tính khối ở gần.
- **Cột:** hình chữ nhật kín 150–1200 mm trên layer cột, hoặc có hatch đặc.
- **Trục:** nét tâm dài trên layer trục, kèm số hoặc chữ trong bóng trục ở đầu nét.
- **Phòng:** chữ bên trong tường bắt đầu bằng tên một loại phòng (PHÒNG, WC, KHO, SẢNH, BẾP…, tiếng Anh, tiếng Trung).
- **Những thứ ngoài cặp mặt tường** (bổ sung 13/11/2026):
  - vách kính: hai nét kính cách nhau 20–80 mm trên layer cửa/kính, dài từ 1 m, đọc thành tường có cửa sổ suốt chiều dài;
  - tường vẽ bằng một polyline có bề rộng: bề rộng là chiều dày;
  - tường cong: hai cung đồng tâm cách nhau một chiều dày, đọc thành tường theo cung giữa;
  - cửa không có cung: một nét cánh xuất phát từ đầu khe, chéo 30–90° so với tường, dài gần bằng khe; hoặc một khối tên lạ nằm trong khe: thò ra ngoài tường là cửa đi, nằm gọn trong tường là cửa sổ (khối có thuộc tính là ký hiệu, không tính);
  - cầu thang: từ 6 nét bậc song song, dài bằng nhau, cách đều 200–380 mm; hướng lên lấy theo chữ LÊN/UP gần đầu vế nhất; hai vế đặt cạnh nhau là thang chữ U, vế kia đi ngược lại;
  - cao độ: chữ dạng +3.600, -0.450, ±0.000.
- **Chọn vùng mặt bằng:** không đưa `window` thì công cụ tự tìm các vùng có tường và xếp theo số cung cửa, khối cửa, tên phòng, tường theo cả hai phương. Mặt cắt và mặt đứng cũng có nét song song nhưng không có những thứ này. Công cụ đọc vùng đứng đầu và liệt kê các vùng còn lại.

## 3. Kết quả thử

- **Nhà mẫu 5×18, tầng 1** (đối chiếu với mô tả gốc):
  - 15 đoạn tường đúng chiều dày 100/200.
  - Cả 6 lỗ mở đúng chỗ, đúng bề rộng, đúng loại (cửa hai cánh D1, cửa sổ S1/S3, cửa đi D3/D4, lỗ mở trống), đúng ký hiệu.
  - 8 trục đúng tọa độ và tên; 5 phòng đúng tên.
  - Thiếu một bức tường chỉ còn hai mẩu 75 mm hai bên lỗ mở rộng 2 350 mm.
- **Bản vẽ văn phòng của đơn vị khác, mặt bằng tầng 1** (sau khi chuẩn hóa layer):
  - Đọc được 19 đoạn tường, 6 trục, 7 phòng đúng tên (WC NAM, WC NỮ, RECEPTION, PHÒNG TRÀ NƯỚC, PHÒNG HỌP A, PHÒNG CHỜ ×2).
  - Không đọc được vách kính bao ngoài (hai nét cách nhau dưới 80 mm) và cửa vẽ thành khe hở không có cung.
  - Khi nhận về: chuyển được 99 đối tượng và 55 kích thước cũ sang layer cất giữ, mặt bằng mới được vẽ đúng chỗ, bản vẽ có view `draw_plan` và lưu mô tả công trình.

Sau bổ sung, cùng mặt bằng văn phòng đó đọc thêm được 4 đoạn vách kính bao ngoài (hiện thành tường có cửa sổ suốt chiều dài), 1 cửa đi và 1 vế thang. Trên nhà mẫu, thang chữ U được đọc thành hai vế đúng hướng: vế 1 đi lên, vế 2 đi ngược lại.

## 4. Giới hạn, cách dùng an toàn

- Luôn xem trước rồi mới nhận về. Bản vẽ càng gọn (đã chuẩn hóa layer, tường hai nét, cửa có cung) thì đọc càng đủ.
- Không đọc được:
  - tường vẽ một nét mảnh (không có bề rộng), thang xoắn, thang chữ L;
  - cửa vẽ thành khe trống không có nét cánh: khe rộng 600 đến 1000 mm được nhận là cửa đi và báo trong kết quả (cần soát lại; `gap_doors: false` để đọc thành ô trống), khe rộng hơn vẫn là ô trống;
  - thang chữ U chỉ đọc được thành hai vế (muốn vẽ thang U trọn vẹn thì khai `stairs` kiểu `u` với vùng thang);
  - đồ đạc, ghi chú (những thứ này giữ nguyên trên bản vẽ).
- Thiếu gì thì sửa mô tả công trình (`save_path` ghi ra file JSON) rồi vẽ bằng `draw_plan`. Hoặc nhận về rồi sửa bằng `draw_plan update: true`.
- Nhận về mất ba bước Undo. Rã băng layer `X-OLD-PLAN` để so với bản cũ.
- Một phần mặt bằng nằm trong khối thì cả khối đó được chuyển sang `X-OLD-PLAN`; công cụ có báo.

## 5. Khoanh mây chỗ sửa đổi

- **Mọi công cụ vẽ nhận thêm `revision`** (số lần sửa, hoặc `{no, note}`), dùng cùng `update: true`.
  - Trước khi xóa hình cũ, cầu nối ghi lại từng đối tượng: loại, layer, tọa độ và nội dung.
  - Vẽ xong, nó so với hình mới: đối tượng mất đi và đối tượng mới ra được gom thành vùng.
  - Mỗi vùng được khoanh mây trên layer `A-ANNO-REVS`, kèm tam giác số lần sửa; ghi chú đặt cạnh tam giác đầu tiên.
- **Đường bao lớn đổi một góc** (đường bao tường cả tầng vẽ thành một polyline) chỉ khoanh chỗ đỉnh của nó dời đi, không khoanh cả tầng. Hình đổi hoàn toàn (một bảng vẽ lại từng dòng) được khoanh một mây bao quanh.
- **Mây của một lần sửa là một view riêng** (`revision:<số>`), không mất khi cập nhật các hình khác; `list_views` liệt kê nó.
- **`revision_cloud`** khoanh mây chỗ sửa bằng tay trên bản vẽ cũ: một vùng chọn, các đối tượng (handle) vừa sửa, hoặc các điểm.
- **Bảng sửa đổi trên khung tên:** `create_layout` nhận `title_block.revisions` `[{no, text, date}]`, ghi vào bốn dòng LẦN NỘP / NỘI DUNG ĐIỀU CHỈNH / NGÀY NỘP. Đây là thuộc tính của khung tên nên mỗi tờ có lịch sử sửa riêng.
- **Thử trên nhà mẫu (lần sửa 2):** dời tường WC tầng 1 lùi 300, mở rộng cửa sổ S1 thành S4 rộng 1 600.
  - Mặt bằng: 2 mây, một quanh khu WC – bếp, một quanh S4.
  - Mặt cắt A-A: 2 mây.
  - Bảng cửa: 1 mây bao bảng.
  - Mặt bằng tầng 2 và tầng 3 không đổi nên không có mây.
  - `check_drawing` không báo lỗi.

## 6. Sửa bản vẽ của người khác (bổ sung 13/11/2026)

- **Đọc bản đồ bản vẽ** (`describe_drawing`):
  - Tờ là layout (viewport cho biết vùng model và tỷ lệ) hoặc khung vẽ trong model: hình chữ nhật hay khối có tên khung (KHUNG, FRAME, TITLE...) đúng khổ A0–A4 theo một tỷ lệ. Khung kéo dài (A3 thêm dải khung tên, 468×297) cũng nhận.
  - Khung nằm trong khung khác là cùng một tờ (viền trong, khung in) hoặc ô chi tiết. Hình chữ nhật bao nhiều tờ cùng khổ là đường bao bộ bản vẽ, không phải tờ.
  - Tỷ lệ của tờ lấy theo thuộc tính khung tên, nếu không có thì theo tỷ lệ ghi dưới phần lớn các hình.
  - Hình nhận theo tên hình cao hơn chữ thường. Tỷ lệ lấy từ chữ "TỶ LỆ 1/100" bên cạnh. Tên ghi hai thứ tiếng (Việt trên, Trung dưới) tính là một hình.
  - Tên nằm trong khung tên (dải bên phải, ô góc dưới phải) là tên tờ, không phải hình. Khung vẽ bằng 4 đường line rời cũng nhận. Khung không có hình, số hay tên (khung in, ô trùng tỷ lệ giấy) không tính là tờ.
  - Khung A3 1:100 và A1 1:50 cùng kích thước: khi không có chữ tỷ lệ, tờ lấy tỷ lệ của các khung cùng cỡ.
  - Vùng của từng hình:
    - Tên hình đặt dưới hình, nên mỗi hàng tên chiếm dải tới hàng tên phía trên, chia đôi giữa các tên cùng hàng. Hàng thấp nhất kéo tới mép dưới tờ, vì tên có thể đứng cạnh hình. Dải khung tên bên phải không tính.
    - Sau đó vùng được thu lại vừa với nét vẽ nằm trong dải, cộng lề 2 % (`window_from: drawing`). Khung và khung tên không tính. Dải không có nét thì giữ nguyên dải (`window_from: titles`).
- **Font chữ cũ** (`convert_vietnamese_text`):
  - TCVN3 (.VnTime, .VnArial; font đuôi H hiện chữ hoa) và VNI (VNI-Times, VNI-Helve) được nhận theo font của kiểu chữ.
  - Kiểu chữ dùng font tên khác (font SHX, TrueType đổi tên) được nhận theo nội dung chữ (`by_content`, bật sẵn). Điều kiện: ít nhất 3 chữ đọc ra TCVN3 hoặc VNI, chiếm phần lớn các chữ có dấu của kiểu đó. Cũng có thể chỉ thẳng: `styles: {"TEN_KIEU": "vni"}`. `describe_drawing` liệt kê các kiểu này.
  - Chữ được đổi sang Unicode; phần mtext đổi font giữa chừng cũng được theo dõi, phần chữ Trung (SimSun) giữ nguyên. Kiểu chữ chuyển sang Arial.
  - Chữ đã là Unicode thì để nguyên.
- **Kéo giãn tại chỗ** (`stretch_entities`): như lệnh STRETCH. Đối tượng nằm gọn trong vùng chọn thì dời; đối tượng cắt qua mép thì chỉ dời các điểm nằm trong vùng.
  - Mặt tường kéo dài ra, đỉnh polyline dời đi, điểm định nghĩa kích thước dời nên số đo tự cập nhật.
  - Hatch không liên kết được kéo theo từng đỉnh đường bao. Biên gồm đoạn thẳng và cung được đổi thành biên polyline: cung giữ độ phồng như lệnh STRETCH giữ độ phồng của cung polyline. Lỗ tròn được tách thành hai nửa cung.
  - Đường bao phòng (polyline kín) đổi kích thước thì chữ diện tích bên trong được tính lại, giữ đúng cách viết ("5,06 m²" thành "4,39 m²"). Chữ phải ghi m², m2, S =, DT, DIỆN TÍCH hoặc chỉ là con số, và phải đúng bằng diện tích cũ. `update_areas: false` để giữ nguyên.
- **Tìm và thay chữ** (`replace_text`): text, mtext, thuộc tính, kích thước ghi đè, ô bảng, định nghĩa khối. Nên xem trước (`preview`).
- **So hai phiên bản** (`compare_drawings`): so model từng đối tượng với file cũ, khoanh mây vùng khác. Mây của chính công cụ không tính.
  - `layers: false` bỏ qua khác biệt layer: so bản đã chuẩn hóa layer với bản gốc để chắc không mất nét nào.

**Kết quả thử trên bản sao:**
- **Văn phòng (song ngữ Việt – Trung, font VNI):**
  - Đổi font: 390 chữ được chuyển sang Unicode, 19 kiểu chữ VNI-Helve/VNI-Avo chuyển sang Arial. Ví dụ "MAËT BAÈNG TAÀNG 2" thành "MẶT BẰNG TẦNG 2", "VAÊN PHOØNG 02" thành "VĂN PHÒNG 02".
  - Bản đồ: 31 tờ khung A3 kéo dài 1:100 (khối KHUNGTEN), khoảng 60 hình có loại, tầng, tỷ lệ. Trước khi sửa cách nhận khung, công cụ không nhận được tờ nào.
- **Nhà mẫu:**
  - Dời tường WC lên 300: 9 đối tượng được kéo (2 đường bao tường, hatch tường, 2 cửa, 3 đường bao phòng, 1 kích thước 4000 thành 4300), một mây số 3.
  - Diện tích phòng đi theo: WC và SÂN PHƠI từ 5,06 thành 4,39 m², BẾP + ĂN từ 18,40 thành 19,78 m².
  - So với file cũ: 12 đối tượng đổi (9 đã kéo cùng 3 chữ diện tích). Mây khoanh dải tường đã dời, chữ diện tích và số kích thước, không trùm cả phòng. `check_drawing` không báo lỗi.
  - Thay "MẶT BẰNG TUM": 3 chỗ (ô bảng danh mục, chữ tên hình, thuộc tính khung tên). Khối vẽ của bảng và của kích thước không bị đếm lần hai.
  - Ghi chú của một lần sửa được giữ khi lệnh sau cùng lần sửa không ghi chú.
- **Bản vẽ thử có bảng gõ font .VnTime:** 4 ô bảng và 1 chữ được chuyển ("B¶ng thèng kª" thành "Bảng thống kê").
- **Bổ sung sau cùng:**
  - Hatch biên đoạn thẳng + nửa đường tròn, kéo đầu cung sang phải 300: cung giữ dạng nửa tròn, diện tích ra đúng 1,578 m² như tính tay.
  - Kiểu chữ "Standard" (font Arial) chứa chữ gõ VNI được nhận theo nội dung và chuyển đúng ("PHOØNG KHAÙCH" thành "PHÒNG KHÁCH").
  - Bản vẽ văn phòng: 43/50 hình có vùng thu theo nét vẽ.
    - Đọc mặt bằng tầng 1 trong vùng đó ra 28 đoạn tường, 5 lỗ mở và đủ 7 phòng (WC NAM, WC NỮ, RECEPTION, PHÒNG TRÀ NƯỚC, PHÒNG HỌP A, 2 PHÒNG CHỜ).
    - `read_plan` tự chọn vùng thì gộp nhiều tầng (247 đoạn tường).
  - Nhà mẫu: tờ KT-01 ra đủ 3 mặt bằng tầng 1, 2, 3.
- **Giới hạn:**
  - Kiểu chữ chỉ có 1–2 chữ gõ font cũ thì không đủ để nhận theo nội dung; khi đó chỉ thẳng bằng `styles`.
  - Vùng hình vẫn dựa vào vị trí tên hình. Hình không có tên thì không có vùng; khi đó đưa `window` cho `read_plan`.
  - Số bản vẽ chỉ đọc được khi nó là thuộc tính khung tên, chữ trong khung, hoặc chữ trong khối khung riêng của từng tờ. Các bản vẽ cũ đã thử không ghi số bản vẽ ở đâu cả nên số để trống.
  - Hatch có biên là elip hoặc spline thì không kéo được (có báo số lượng).

## 7. Rà soát và dọn bản vẽ của người khác (bổ sung 13/11/2026)

- **Kiểm tra kích thước và diện tích** (`check_annotations`):
  - Kích thước bị ghi đè chữ được so với số đo thật. Công cụ đọc số trong chữ ("4.000", "4,000" hiểu cả là bốn nghìn; "2x1200" là 2400; có tính hệ số DIMLFAC).
  - Sai lệch được chấp nhận: nửa đơn vị lẻ cuối, 0,2 % hoặc 1 mm.
  - Chữ ghi đè chỉ có chữ (VAR, EQ) thì liệt kê riêng, không kiểm.
  - Chữ diện tích (m², m2, S =, DT, DIỆN TÍCH, AREA, 面積) được so với diện tích đường bao kín nhỏ nhất quanh nó. Đường bao lệch quá xa con số (ví dụ đường bao cả nhà) thì không tính. Mây sửa đổi không bị coi là đường bao.
  - `fix` sửa kích thước (số được thay bằng `<>`, tức số đo, phần chữ còn lại giữ nguyên: "R=500" thành "R=<>"), sửa diện tích (viết đúng cách cũ), hoặc cả hai. Có thể chỉ sửa một số handle. `revision` khoanh mây.
  - Lưu ý: chi tiết vẽ không theo tỷ lệ cố ý ghi đè kích thước, nên phải xem danh sách trước khi sửa.
- **Danh sách chữ và sửa nhiều chữ** (`list_texts`, `update_texts`):
  - Liệt kê text, mtext, thuộc tính, kích thước ghi đè, mleader, ô bảng của model và các layout. Mỗi chữ khác nhau một dòng, kèm số lần, handle, loại, layer, ngôn ngữ (vi, zh, en). Xuất CSV có cột "Bản dịch".
  - `update_texts` ghi lại theo handle trong một bước Undo. Ô bảng dùng handle dạng "handle:hàng:cột".
  - Dùng để dịch bản vẽ song ngữ Việt – Trung, hoặc sửa câu chữ hàng loạt.
- **Dọn bản vẽ** (`clean_drawing`): xóa nét vẽ trùng hoàn toàn (cùng loại, layer, màu, nét, độ dày và hình), nét dài bằng 0, chữ rỗng; gộp các đoạn thẳng chồng hoặc nối nhau trên cùng một đường (như OVERKILL). Nên xem trước (`preview`). Layer khóa không bị đụng.
- **Danh mục cả thư mục** (`describe_folder`): đọc từng file DWG ngầm (không mở trong AutoCAD, không cần bản vẽ nào đang mở). Ra danh mục tờ: file, layout/khung, số bản vẽ, tên tờ, khổ giấy, tỷ lệ, các hình, font cũ. Ghi được ra .xlsx hoặc .csv.

**Kết quả thử trên bản sao:**
- **Nhà mẫu:**
  - Dời tường WC mà không cập nhật diện tích, rồi ghi đè kích thước 4300 thành "4000".
  - `check_annotations` tìm đúng 1 kích thước sai và 3 chữ diện tích sai (WC, SÂN PHƠI, BẾP + ĂN); 13 kích thước ghi đè khác đều đúng.
  - Sửa tất cả với lần sửa 4: kiểm lại ra 0 sai, có 4 mây.
- **Bản vẽ văn phòng:**
  - `clean_drawing` xóa 18 nét trùng và gộp 28 đoạn chồng. Cảnh báo nét trùng của `check_drawing` giảm từ 18 còn 3 (loại mà công cụ không gộp, như hatch).
  - So với file cũ: 63 đối tượng mất (46 bị xóa, 17 đoạn được kéo dài), 17 đối tượng mới, không có gì khác thay đổi.
- **Thư mục 13 bản vẽ cũ:** đọc cả 13 file trong khoảng 20 giây, ra 151 tờ. File Excel mở được, không lỗi.
- **Lỗi tìm ra khi thử và đã sửa:**
  - Biên hatch dựng lại thành polyline phải được đóng kín (lặp đỉnh đầu ở cuối) và mang cờ polyline; thiếu hai điều này thì phòng bị tô và dải tường bị trống.
  - Mây sửa đổi từng bị coi là đường bao phòng khi kiểm tra diện tích.
  - Đọc thư mục từng không chạy khi AutoCAD không mở bản vẽ nào.
