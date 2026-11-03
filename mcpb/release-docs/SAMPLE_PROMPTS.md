# AutoCAD MCP - sample prompts / câu lệnh mẫu

## Setup / Cài đặt

- Install the ACAD MCP Bridge in AutoCAD. / Cài ACAD MCP Bridge vào AutoCAD.
- Ping AutoCAD and tell me which drawing is open. / Ping AutoCAD, đang mở bản vẽ nào?

## From an image / Từ hình ảnh

- Here is a scan of a ground floor plan: D:/Project/scan.jpg. Read all printed dimensions, then draw it at 1:100 with standard layers, door and window tags, room names with measured areas and full exterior dimensions. Compare with the scan and fix any difference.
- Đây là ảnh mặt bằng D:/DuAn/scan.jpg. Đọc hết các số kích thước rồi vẽ lại tỷ lệ 1:100, layer chuẩn, ký hiệu cửa, tên phòng kèm diện tích đo từ tường, đủ 3 lớp kích thước ngoài. So với ảnh và sửa chỗ sai.
- Vẽ ngôi nhà trong ảnh này: kích thước 6x15 m, tường bao 200, tường ngăn 100. Vẽ mặt bằng tầng 1 có nội thất và mặt đứng chính theo ảnh.
- Attach D:/Project/sketch.png as a faded underlay so that the corner of grid A-1 is at 0,0 and the 6000 dimension of the sketch is 6000 mm, then trace the furniture outlines over it.
- Chèn ảnh D:/DuAn/phac.jpg làm nền mờ, hiệu chỉnh theo kích thước 4200 trên ảnh, rồi đồ lại các đường bao nội thất.

## From a 3D model / Từ mô hình 3D

- Read the room sizes and openings of the SketchUp model (SketchUp MCP), then draw the floor plan in AutoCAD with draw_plan at 1:50.
- Import D:/Export/elevation_front.dwg (a 2D export of SketchUp) with the layer prefix X-SU-, clean it up onto A-ELEV layers and add levels and dimensions.

## Drafting / Triển khai

- Set up layers and styles for 1:50 in Vietnamese. / Tạo layer và style cho tỷ lệ 1:50, mô tả tiếng Việt.
- Add a door schedule table next to the plan with all door tags, sizes and counts. / Thêm bảng thống kê cửa cạnh mặt bằng.
- Define a block "BED-1600" with attributes CODE and SIZE, then place it in both bedrooms. / Tạo block giường có thuộc tính rồi đặt vào 2 phòng ngủ.
- Make an A3 sheet "KT-01" with the title block (project NHÀ Ở GIA ĐÌNH, drawing MẶT BẰNG TẦNG 1) and export a PDF to D:/Out/KT-01.pdf.

## Elevations, sections and structure / Mặt đứng, mặt cắt và kết cấu

- Draw the four elevations of the plan with a gable roof (pitch 30°, overhang 500) and the porch roof from the photo, then add the gable window and the finials seen in the photo. / Vẽ 4 mặt đứng từ mặt bằng, mái dốc 30°, vươn 500, thêm mái sảnh và các chi tiết trang trí như trong ảnh.
- Draw sections A-A and B-B from the section marks of the plan. / Vẽ mặt cắt A-A và B-B theo ký hiệu mặt cắt trên mặt bằng.
- Draw beam D1 on axis C (220x350, two spans of 2900): bottom 2Ø16, top 2Ø14, support bars 1Ø14 over a quarter of the span, stirrups Ø6a100/200. / Vẽ dầm D1 trục C 220x350, 2 nhịp 2900, thép dưới 2Ø16, trên 2Ø14, mũ gối 1Ø14 dài 1/4 nhịp, đai Ø6a100/200.
- Draw footing M1 1200x1200x400 at -1.500 with mesh Ø12a150 and the column 220x220 with 4Ø16, then the bar schedule of the beam and the footing with a CSV. / Vẽ móng M1 1200x1200x400 đáy -1.500, lưới Ø12a150, cột 220x220 4Ø16, rồi bảng thống kê thép dầm và móng, xuất CSV.
- Make the A3 sheets KT-01 to KT-04 and KC-01, KC-02 and export one PDF. / Dàn các tờ A3 KT-01 đến KT-04, KC-01, KC-02 và xuất một file PDF.

## Interior design / Thiết kế nội thất

- Furnish the house: double beds with nightstands and wardrobes in the bedrooms, sofa, TV cabinet and coffee table in the living room, a kitchen run with sink and hob, wall cabinets and hood, a dining set, and the WC fixtures. List what you assume first. / Bố trí nội thất cả nhà (giường đôi, tab, tủ áo, sofa, kệ tivi, bàn trà, tủ bếp có chậu và bếp, tủ trên, hút mùi, bàn ăn, thiết bị WC); liệt kê các giả định trước khi vẽ.
- Draw the floor finish plan with wooden planks 150x900 in the bedrooms and 600x600 porcelain elsewhere, then the reflected ceiling plan. / Vẽ mặt bằng lát sàn (phòng ngủ sàn gỗ 150x900, còn lại gạch 600x600) và mặt bằng trần đèn.
- Draw the interior elevations of the four walls of PHÒNG NGỦ 1 and of the kitchen wall, then the shop drawings of the kitchen JN-03 and the wardrobe JN-01. / Triển khai 4 vách phòng ngủ 1 và vách bếp, chi tiết tủ bếp JN-03 và tủ áo JN-01.
- Make the finish and material schedule with a CSV for Excel. / Lập bảng thống kê vật liệu hoàn thiện, xuất CSV.
- Count the doors, windows, furniture and lights by block, with their codes. / Đếm cửa, đồ nội thất và đèn theo block kèm mã.
- Draw the floor, wall and ceiling finish plans and the lighting layout of floor 2, each with its legend and general notes. / Vẽ mặt bằng hoàn thiện sàn, hoàn thiện tường, hoàn thiện trần và bố trí đèn tầng 2, có chú thích và ghi chú chung.
- Make the A3 sheets NT-01 to NT-07 with the vertical title strip (client, project, consultant, phase TKTC) and export one PDF. / Dàn tờ A3 NT-01 đến NT-07 với khung tên dải dọc (chủ đầu tư, dự án, tư vấn, giai đoạn TKTC) và xuất một file PDF.

## Three sets: architecture, structure, interior / Ba bộ hồ sơ: kiến trúc, kết cấu, nội thất

- Make the structural set in a new drawing: general notes, the framing plan of every slab and the beam schedule, then sheets KC-00 to KC-06 with the drawing list. / Lập bộ kết cấu trong bản vẽ mới: ghi chú chung, mặt bằng kết cấu từng sàn, bảng mặt cắt dầm, dàn tờ KC-00 đến KC-06 kèm danh mục bản vẽ.
- Keep architecture, structure and interior in three files, each with its own drawing list and title block item. / Tách kiến trúc, kết cấu, nội thất thành ba file, mỗi bộ có danh mục và hạng mục riêng trên khung tên.

## Buildings of several floors / Nhà nhiều tầng

- Draw a 5x18 m townhouse with three floors and a stair tower (tum): U stair at the back, a 1.2 m balcony on floors 2 and 3, a 1 m parapet on the roof terrace. List what you assume first. / Vẽ nhà phố 5x18 m, 3 tầng + tum, thang chữ U phía sau, ban công 1,2 m tầng 2 và 3, tường mái cao 1 m; liệt kê giả định trước khi vẽ.
- Draw the front and back elevations and section A-A through the stair. / Vẽ mặt đứng chính, mặt đứng sau và mặt cắt A-A qua cầu thang.
- Furnish floor 2 and draw its ceiling plan and the interior elevations of PHÒNG NGỦ 1. / Bố trí nội thất tầng 2, vẽ trần đèn và triển khai mặt đứng phòng ngủ 1.

## Quantities and checks / Khối lượng và kiểm tra

- Take off the quantities by layer and save a CSV for Excel. / Bóc khối lượng theo layer, xuất CSV.
- Count the blocks with their attribute values. / Đếm block kèm giá trị thuộc tính.
- Check the drawing and fix the duplicates and the polylines that should be closed. / Kiểm tra bản vẽ, xóa đối tượng trùng và đóng các polyline hở.
- Find walls drawn as one thick line and redraw them with two faces. / Tìm tường vẽ 1 nét dày và vẽ lại đúng 2 nét.
