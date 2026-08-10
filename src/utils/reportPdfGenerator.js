import PDFDocument from "pdfkit";

const C = {
  tblHead:    "#f1f5f9",
  tblHeadTxt: "#475569",
  tblAlt:     "#f8fafc",
  tblTxt:     "#334155",
  rule:       "#e2e8f0",
  headTitle:  "#1e293b",
  headSub:    "#64748b",
  labelTxt:   "#9ca3af",
};

// Truncate text to fit maxWidth — more reliable than pdfkit's built-in ellipsis
function fit(doc, text, maxWidth) {
  if (!text || text === "—") return text || "—";
  if (doc.widthOfString(text) <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && doc.widthOfString(s + "…") > maxWidth) {
    s = s.slice(0, -1);
  }
  return s + "…";
}

/**
 * Generic table-based report PDF.
 * @param {string}   title
 * @param {Array}    columns  [{header, key, width, align?}]  — widths must sum to usable page width
 * @param {Array}    rows     array of plain objects keyed by column.key
 * @param {string}   rangeLabel
 * @param {string}   [footerTag]
 * @param {object}   [opts]   { landscape: boolean }
 * @returns {Promise<Buffer>}
 */
export function generateTableReport(title, columns, rows, rangeLabel, footerTag = title, opts = {}) {
  return new Promise((resolve, reject) => {
    const landscape = opts.landscape === true;
    const doc = new PDFDocument({ margin: 40, size: "A4", layout: landscape ? "landscape" : "portrait" });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end",  () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const MARGIN = 40;
    const W = doc.page.width - MARGIN * 2;

    const drawHRule = (y) =>
      doc.moveTo(MARGIN, y).lineTo(MARGIN + W, y).strokeColor(C.rule).lineWidth(0.5).stroke();

    // ── Page header ────────────────────────────────────────────────────────────
    doc.font("Helvetica-Bold").fontSize(18).fillColor(C.headTitle)
      .text(title, MARGIN, 40, { align: "center", width: W });
    doc.font("Helvetica").fontSize(10).fillColor(C.headSub)
      .text(`Date: ${rangeLabel}  •  Total Records: ${rows.length}`, { align: "center", width: W });
    doc.moveDown(0.8);
    drawHRule(doc.y);
    doc.moveDown(0.6);

    if (rows.length === 0) {
      doc.font("Helvetica").fontSize(12).fillColor(C.headSub)
        .text(`No ${title} records found for this period.`, { align: "center" });
      doc.font("Helvetica").fontSize(8).fillColor(C.labelTxt)
        .text(`Neoteric IMS — Auto-generated ${footerTag} • ${rangeLabel}`,
          MARGIN, doc.page.height - 30, { width: W, align: "center" });
      return doc.end();
    }

    // ── Table ──────────────────────────────────────────────────────────────────
    const PAD   = 4;   // horizontal padding inside each cell
    const ROW_H = 18;
    const HEAD_H = 20;
    const FONT_BODY = 8;
    const FONT_HEAD = 7.5;

    const drawHeader = (pageY) => {
      doc.rect(MARGIN, pageY, W, HEAD_H).fill(C.tblHead);
      doc.font("Helvetica-Bold").fontSize(FONT_HEAD).fillColor(C.tblHeadTxt);
      let cx = MARGIN + PAD;
      columns.forEach(col => {
        const cellW = col.width - PAD * 2;
        const label = fit(doc, col.header, cellW);
        doc.text(label, cx, pageY + 6, { width: cellW, lineBreak: false, align: col.align || "left" });
        cx += col.width;
      });
      return pageY + HEAD_H;
    };

    let y = drawHeader(doc.y);

    rows.forEach((row, idx) => {
      if (y + ROW_H > doc.page.height - 50) {
        doc.addPage();
        y = MARGIN;
        y = drawHeader(y);
      }

      // alternating row background
      if (idx % 2 === 1) doc.rect(MARGIN, y, W, ROW_H).fill(C.tblAlt);

      doc.font("Helvetica").fontSize(FONT_BODY).fillColor(C.tblTxt);

      let cx = MARGIN + PAD;
      columns.forEach(col => {
        const cellW = col.width - PAD * 2;
        const raw  = row[col.key];
        const text = fit(doc, raw === null || raw === undefined ? "—" : String(raw), cellW);

        // clip to cell so nothing bleeds into adjacent columns
        doc.save();
        doc.rect(cx, y, cellW, ROW_H).clip();
        doc.text(text, cx, y + 5, { width: cellW, lineBreak: false, align: col.align || "left" });
        doc.restore();

        cx += col.width;
      });

      y += ROW_H;
    });

    // ── Footer ─────────────────────────────────────────────────────────────────
    doc.font("Helvetica").fontSize(8).fillColor(C.labelTxt)
      .text(`Neoteric IMS — Auto-generated ${footerTag} • ${rangeLabel}`,
        MARGIN, doc.page.height - 30, { width: W, align: "center" });

    doc.end();
  });
}
