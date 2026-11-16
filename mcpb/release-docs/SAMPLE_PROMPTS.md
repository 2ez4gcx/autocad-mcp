# Construction AutoCAD MCP - sample prompts / câu lệnh mẫu

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

## Separate sets: architecture, structure, interior / Các bộ hồ sơ riêng: kiến trúc, kết cấu, nội thất

- Make the structural set in a new drawing: general notes, the framing plan of every slab and the beam schedule, then sheets KC-00 to KC-06 with the drawing list. / Lập bộ kết cấu trong bản vẽ mới: ghi chú chung, mặt bằng kết cấu từng sàn, bảng mặt cắt dầm, dàn tờ KC-00 đến KC-06 kèm danh mục bản vẽ.
- Keep architecture, structure and interior in three files, each with its own drawing list and title block item. / Tách kiến trúc, kết cấu, nội thất thành ba file, mỗi bộ có danh mục và hạng mục riêng trên khung tên.

## Electrical and plumbing / Điện và cấp thoát nước

- Make the electrical set of this house in a new drawing: lighting and power plans of every floor, the single-line diagram, the riser diagram and the load calculation in Excel. List what you assume first. / Lập bộ hồ sơ điện cho nhà này trong bản vẽ mới: mặt bằng chiếu sáng, ổ cắm các tầng, sơ đồ nguyên lý, sơ đồ trục đứng, bảng tính phụ tải bằng Excel; liệt kê giả định trước.
- Put an 18000 BTU air conditioner in the living room and two more sockets by the TV. / Đặt điều hòa 18.000 BTU cho phòng khách và thêm hai ổ cắm cạnh TV.
- Make the plumbing set: supply and drainage plans, riser diagrams, the septic tank detail, the WC enlarged at 1:25 and the calculation with the tank and pipe sizes. / Lập bộ cấp thoát nước: mặt bằng cấp nước, thoát nước, sơ đồ nguyên lý, chi tiết bể tự hoại, mặt bằng WC tỷ lệ 1/25 và bảng tính dung tích bồn, đường kính ống.
- The house has 8 people and a 2000 L tank: recalculate the riser and the septic tank. / Nhà có 8 người, bồn 2000 lít: tính lại ống đứng và bể tự hoại.

## Buildings of several floors / Nhà nhiều tầng

- Draw a 5x18 m townhouse with three floors and a stair tower (tum): U stair at the back, a 1.2 m balcony on floors 2 and 3, a 1 m parapet on the roof terrace. List what you assume first. / Vẽ nhà phố 5x18 m, 3 tầng + tum, thang chữ U phía sau, ban công 1,2 m tầng 2 và 3, tường mái cao 1 m; liệt kê giả định trước khi vẽ.
- Draw the front and back elevations and section A-A through the stair. / Vẽ mặt đứng chính, mặt đứng sau và mặt cắt A-A qua cầu thang.
- Furnish floor 2 and draw its ceiling plan and the interior elevations of PHÒNG NGỦ 1. / Bố trí nội thất tầng 2, vẽ trần đèn và triển khai mặt đứng phòng ngủ 1.
- Open last month's set, widen the kitchen window to 1600 and move the WC wall 300 forward; update the plan and every view that depends on it where they stand, then export the sheets again. / Mở bộ hồ sơ tháng trước, mở rộng cửa sổ bếp thành 1600 và dời tường WC ra 300; cập nhật mặt bằng và mọi hình phụ thuộc ngay tại chỗ rồi xuất lại các tờ.
- This drawing comes from another office: make its layers consistent with our standard. Show me the mapping first, keep the plotted look. / Bản vẽ này của văn phòng khác: chuẩn hóa layer theo chuẩn của mình, cho xem bảng chuyển layer trước, giữ nguyên bản in.
- Standardise the layers of every drawing in this folder and save the copies in a new folder. / Chuẩn hóa layer tất cả bản vẽ trong thư mục này, lưu bản sao sang thư mục mới.
- Read the ground floor plan of this drawing from another office, show me what you read over it, then take it over so I can change it and draw its elevations. / Đọc mặt bằng tầng 1 của bản vẽ văn phòng khác, cho xem phần đọc được đè lên bản vẽ, rồi nhận về để sửa và vẽ mặt đứng.
- Move the WC wall 300 back and widen window S1 to 1600 as revision 2: update the plan, section and door schedule in place, cloud what changed, and add the revision to the title blocks. / Lần sửa 2: dời tường WC lùi 300, mở rộng cửa sổ S1 thành 1600; cập nhật mặt bằng, mặt cắt, bảng cửa tại chỗ, khoanh mây chỗ sửa và ghi lần sửa vào khung tên.
- Here is a drawing from another office: tell me what sheets and views it has, convert its old Vietnamese fonts to Unicode, then move the WC wall 300 up and cloud it as revision 3. / Đây là bản vẽ của đơn vị khác: cho biết có những tờ, hình nào; chuyển font tiếng Việt cũ sang Unicode; dời tường WC lên 300 và khoanh mây lần sửa 3.
- Compare this drawing with the version we issued last week (D:/Issued/KT-rev2.dwg) and cloud everything that changed as revision 3. / So bản vẽ này với bản đã phát hành tuần trước và khoanh mây mọi chỗ thay đổi là lần sửa 3.
- Check this drawing for dimensions written over with wrong values and room areas that do not match, list them, then fix them as revision 4. / Kiểm tra bản vẽ này: kích thước ghi đè sai số, diện tích phòng không khớp; liệt kê rồi sửa và khoanh mây lần sửa 4.
- List all Chinese texts of this drawing, translate them into Vietnamese and write the translations into the drawing. / Liệt kê chữ tiếng Trung trên bản vẽ, dịch sang tiếng Việt và ghi bản dịch vào bản vẽ.
- Make a register of every drawing in D:/Project/KT as an Excel file. / Lập danh mục bản vẽ của cả thư mục D:/Project/KT ra file Excel.
- Living room: a 1600 low cabinet under the window without a TV, a round coffee table Ø800, a round dining table Ø1100; a carpet zone 2600x2200 set into the floor (FL-05); a T-bar ceiling with a linear light, two spots and an access panel where I say. / Phòng khách: tủ thấp 1600 dưới cửa sổ không có tivi, bàn trà tròn Ø800, bàn ăn tròn Ø1100; vùng thảm 2600x2200 lát âm sàn (FL-05); trần lưới T với đèn thanh, hai đèn spot và nắp thăm ở vị trí tôi chỉ.
- Write revision 3 "Cập nhật nội thất" dated today into the title blocks of every sheet, then export them to PDF. / Ghi lần sửa 3 "Cập nhật nội thất" ngày hôm nay vào khung tên mọi tờ rồi xuất PDF.

## Quantities and checks / Khối lượng và kiểm tra

- Take off the quantities by layer and save a CSV for Excel. / Bóc khối lượng theo layer, xuất CSV.
- Check the structural and finish bills of this house against AutoCAD's own measure, and tell me which faces or members disagree. / Kiểm tra lại bảng khối lượng kết cấu và hoàn thiện của nhà này bằng số đo của chính AutoCAD, báo mặt hay cấu kiện nào lệch.
- Draw the finish quantities with the geometric rule set instead of Appendix VI (every opening deducted). / Lập bảng khối lượng hoàn thiện theo khối lượng hình học thay vì Phụ lục VI (trừ mọi lỗ cửa).
- Count the blocks with their attribute values. / Đếm block kèm giá trị thuộc tính.
- Check the drawing and fix the duplicates and the polylines that should be closed. / Kiểm tra bản vẽ, xóa đối tượng trùng và đóng các polyline hở.
- Find walls drawn as one thick line and redraw them with two faces. / Tìm tường vẽ 1 nét dày và vẽ lại đúng 2 nét.
