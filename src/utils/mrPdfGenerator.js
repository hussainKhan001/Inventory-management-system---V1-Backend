import PDFDocument from "pdfkit";

/**
 * Generates an MR report PDF and returns it as a Buffer.
 * @param {Array}  mrs        - Lean MR documents
 * @param {string} dateLabel  - Human-readable date range label
 * @returns {Promise<Buffer>}
 */
export function generateMRReportPDF(mrs, dateLabel) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width - 80;

    const C = {
      barBg:      "#eef2ff",
      barBorder:  "#c7d2fe",
      barText:    "#3730a3",
      barSub:     "#6366f1",
      labelTxt:   "#9ca3af",
      valueTxt:   "#1f2937",
      tblHead:    "#f1f5f9",
      tblHeadTxt: "#475569",
      tblAlt:     "#f8fafc",
      tblTxt:     "#334155",
      rule:       "#e2e8f0",
      headTitle:  "#1e293b",
      headSub:    "#64748b",
    };

    const drawHRule = (y) => {
      doc.moveTo(40, y).lineTo(40 + W, y).strokeColor(C.rule).lineWidth(0.5).stroke();
    };

    const field = (label, value, x, y, w) => {
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(C.labelTxt)
        .text(label.toUpperCase(), x, y, { width: w, lineBreak: false });
      doc.font("Helvetica").fontSize(9).fillColor(C.valueTxt)
        .text(value || "—", x, y + 11, { width: w, lineBreak: true });
    };

    const drawItemsTable = (items) => {
      const cols = [20, 180, 60, 50, 80, 90];
      const headers = ["#", "Material Name", "Qty", "Unit", "Alloc. Qty", "Status"];
      const x0 = 40;
      let y = doc.y + 6;
      doc.rect(x0, y, W, 17).fill(C.tblHead);
      doc.fillColor(C.tblHeadTxt).font("Helvetica-Bold").fontSize(7.5);
      let cx = x0 + 6;
      headers.forEach((h, i) => { doc.text(h, cx, y + 5, { width: cols[i], lineBreak: false }); cx += cols[i]; });
      y += 17;
      items.forEach((item, idx) => {
        const rowH = 18;
        if (y + rowH > doc.page.height - 60) { doc.addPage(); y = 40; }
        if (idx % 2 === 1) doc.rect(x0, y, W, rowH).fill(C.tblAlt);
        doc.fillColor(C.tblTxt).font("Helvetica").fontSize(8.5);
        cx = x0 + 6;
        [String(idx + 1), item.materialName || "—", String(item.qty ?? "—"), item.unit || "—", String(item.allocatedQty ?? 0), item.status || "—"]
          .forEach((cell, i) => { doc.text(cell, cx, y + 5, { width: cols[i] - 4, lineBreak: false, ellipsis: true }); cx += cols[i]; });
        y += rowH;
      });
      doc.y = y + 4;
    };

    // Page header
    doc.font("Helvetica-Bold").fontSize(18).fillColor(C.headTitle)
      .text("Material Requirements Report", 40, 40, { align: "center", width: W });
    doc.font("Helvetica").fontSize(10).fillColor(C.headSub)
      .text(`Date: ${dateLabel}  •  Total MRs: ${mrs.length}`, { align: "center", width: W });
    doc.moveDown(0.8);
    drawHRule(doc.y);
    doc.moveDown(0.5);

    if (mrs.length === 0) {
      doc.font("Helvetica").fontSize(12).fillColor(C.headSub)
        .text("No Material Requirements found for this period.", { align: "center" });
    }

    for (let i = 0; i < mrs.length; i++) {
      const mr = mrs[i];
      if (doc.y > doc.page.height - 200) doc.addPage();

      const createdDT = new Date(mr.createdAt).toLocaleString("en-IN", {
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: true,
      });
      const reqDate = mr.requirementDate
        ? new Date(mr.requirementDate).toLocaleDateString("en-IN") : "—";

      const barY = doc.y;
      doc.rect(40, barY, W, 22).fill(C.barBg);
      doc.rect(40, barY, 3, 22).fill(C.barSub);
      doc.font("Helvetica-Bold").fontSize(10).fillColor(C.barText)
        .text(`${mr.mrNumber || mr._id}`, 52, barY + 6, { width: W / 2, lineBreak: false });
      doc.font("Helvetica").fontSize(8.5).fillColor(C.barSub)
        .text(`${mr.status || "—"}  •  ${createdDT}`, 52 + W / 2, barY + 7, {
          width: W / 2 - 16, align: "right", lineBreak: false,
        });
      doc.y = barY + 26;

      const gy = doc.y + 6;
      const half = W / 2 - 8;
      field("Requester",        mr.requesterName,             40,       gy,      half);
      field("Project",          mr.projectName || mr.project, 40 + W/2, gy,      half);
      field("Location",         mr.location,                  40,       gy + 30, half);
      field("Work Type",        mr.workType,                  40 + W/2, gy + 30, half);
      field("Requirement Date", reqDate,                      40,       gy + 60, half);
      field("Purpose",          mr.purpose,                   40 + W/2, gy + 60, half);
      doc.y = gy + 82;

      if (mr.items && mr.items.length) {
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(C.labelTxt).text("ITEMS", 40, doc.y);
        doc.moveDown(0.2);
        drawItemsTable(mr.items);
      }

      doc.moveDown(0.6);
      if (i < mrs.length - 1) drawHRule(doc.y);
      doc.moveDown(0.6);
    }

    doc.font("Helvetica").fontSize(8).fillColor(C.labelTxt)
      .text(`Neoteric IMS — Auto-generated report • ${dateLabel}`, 40, doc.page.height - 30, {
        width: W, align: "center",
      });

    doc.end();
  });
}
