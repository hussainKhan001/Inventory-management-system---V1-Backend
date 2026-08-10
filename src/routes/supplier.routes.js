import { Router } from "express";
import { createCrudRoutes } from "../utils/crud.js";
import { Supplier } from "../models/index.js";
import { generateTableReport } from "../utils/reportPdfGenerator.js";

const router = Router();

// A4 landscape usable width = 841.89 - 80 = ~762
// Columns below must sum to 762
router.get("/pdf", async (req, res) => {
  try {
    const search = req.query.search || "";
    const query = search
      ? {
          $or: [
            { companyName: { $regex: search, $options: "i" } },
            { ownerName:   { $regex: search, $options: "i" } },
            { mobile:      { $regex: search, $options: "i" } },
          ],
        }
      : {};

    const suppliers = await Supplier.find(query).sort({ companyName: 1 }).lean();

    const columns = [
      { header: "Vendor ID", key: "id",          width: 80  },
      { header: "Company",   key: "companyName",  width: 180 },
      { header: "Owner",     key: "ownerName",    width: 130 },
      { header: "Mobile",    key: "mobile",       width: 90  },
      { header: "GST No",    key: "gstNumber",    width: 130 },
      { header: "Address",   key: "address",      width: 112 },
      { header: "Status",    key: "status",       width: 40  },
    ]; // total = 762

    const now = new Date();
    const dateLabel = now.toLocaleDateString("en-IN", {
      day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
    });

    const rows = suppliers.map((s) => ({
      id:          s.id || "—",
      companyName: s.companyName || s.name || "—",
      ownerName:   s.ownerName   || s.contact || "—",
      mobile:      s.mobile      || s.phone   || "—",
      gstNumber:   s.gstNumber   || "—",
      address:     (typeof s.address === "string" ? s.address : "") || "—",
      status:      s.status      || "Active",
    }));

    const pdfBuffer = await generateTableReport(
      "Supplier Database",
      columns,
      rows,
      dateLabel,
      "Suppliers Report",
      { landscape: true }
    );

    const filename = `Suppliers-${now.toISOString().slice(0, 10)}.pdf`;
    res.set({
      "Content-Type":        "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length":      pdfBuffer.length,
    });
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

createCrudRoutes(router, Supplier, "suppliers", "id", void 0, "SUPPLIER");
var stdin_default = router;
export {
  stdin_default as default
};
