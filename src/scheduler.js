import cron from "node-cron";
import {
  MaterialRequirement, PurchaseOrder, GRN, Inventory, Inward,
  Quotation, Supplier, Catalogue, AuditLog, MaterialPlan, AccountEntry, Settings,
} from "./models/index.js";
import { logger } from "./utils/logger.js";
import { runDatabaseBackup, BACKUP_ROOT } from "./utils/dbBackup.js";
import { generateMRReportPDF } from "./utils/mrPdfGenerator.js";
import { generateTableReport } from "./utils/reportPdfGenerator.js";
import cloudinary from "./config/cloudinary.js";

function buildDateRange(dataRange) {
  const now = new Date();
  const end = new Date(now); end.setHours(23, 59, 59, 999);
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  if (dataRange === "last7")  start.setDate(start.getDate() - 6);
  if (dataRange === "last30") start.setDate(start.getDate() - 29);
  return { start, end };
}

async function savePDFAndGetUrl(pdfBuffer, filename) {
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "IMS/reports", public_id: filename.replace(".pdf", ""), resource_type: "raw" },
      (err, res) => { if (err) reject(err); else resolve(res); }
    );
    stream.end(pdfBuffer);
  });
  return result.secure_url;
}

/** Upload PDF buffer directly to a Slack channel using Bot Token (new files API) */
export async function uploadPDFToSlack(token, channelId, pdfBuffer, filename, message) {
  const urlRes = await fetch(
    `https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(filename)}&length=${pdfBuffer.length}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const urlData = await urlRes.json();
  if (!urlData.ok) throw new Error(`Slack getUploadURLExternal failed: ${urlData.error}`);

  await fetch(urlData.upload_url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: pdfBuffer,
  });

  const completeRes = await fetch("https://slack.com/api/files.completeUploadExternal", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      files: [{ id: urlData.file_id }],
      channel_id: channelId,
      initial_comment: message,
    }),
  });
  const completeData = await completeRes.json();
  if (!completeData.ok) throw new Error(`Slack completeUploadExternal failed: ${completeData.error}`);
  return completeData;
}

// ── Module-specific data fetchers + column definitions ────────────────────────

const MODULE_CONFIG = {
  MR: {
    label: "Material Requirements Report",
    filePrefix: "MR-Report",
    slackTitle: "MR Report",
    // MR uses its own rich PDF generator (generateMRReportPDF)
    custom: true,
  },
  PO: {
    label: "Purchase Orders Report",
    filePrefix: "PO-Report",
    slackTitle: "PO Report",
    fetch: async (start, end) =>
      PurchaseOrder.find({ createdAt: { $gte: start, $lte: end } }).sort({ createdAt: 1 }).lean(),
    columns: [
      { header: "PO ID",    key: "id",          width: 80  },
      { header: "Supplier", key: "supplier",     width: 110 },
      { header: "Project",  key: "project",      width: 90  },
      { header: "Status",   key: "status",       width: 90  },
      { header: "Priority", key: "priority",     width: 55  },
      { header: "Total (₹)",key: "totalValue",   width: 60, align: "right" },
      { header: "Items",    key: "_itemCount",   width: 30, align: "right" },
    ],
    map: (doc) => ({
      id:          doc.id,
      supplier:    doc.supplier || "—",
      project:     doc.project  || "—",
      status:      doc.status   || "—",
      priority:    doc.priority || "Normal",
      totalValue:  doc.totalValue ? `₹${Number(doc.totalValue).toLocaleString("en-IN")}` : "—",
      _itemCount:  doc.items?.length || 0,
    }),
  },
  GRN: {
    label: "GRN Report",
    filePrefix: "GRN-Report",
    slackTitle: "GRN Report",
    fetch: async (start, end) =>
      GRN.find({ createdAt: { $gte: start, $lte: end } }).sort({ createdAt: 1 }).lean(),
    columns: [
      { header: "GRN ID",    key: "id",        width: 80  },
      { header: "Supplier",  key: "supplier",  width: 110 },
      { header: "Date",      key: "date",      width: 70  },
      { header: "Challan",   key: "challan",   width: 70  },
      { header: "Doc Type",  key: "docType",   width: 70  },
      { header: "Status",    key: "status",    width: 70  },
      { header: "Items",     key: "_items",    width: 45, align: "right" },
    ],
    map: (doc) => ({
      id:       doc.id,
      supplier: doc.supplier || "—",
      date:     doc.date     || "—",
      challan:  doc.challan  || "—",
      docType:  doc.docType  || "—",
      status:   doc.status   || "—",
      _items:   doc.items?.length || 0,
    }),
  },
  Inventory: {
    label: "Inventory Stock Report",
    filePrefix: "Inventory-Report",
    slackTitle: "Inventory Report",
    // Inventory is a snapshot — no date filter
    fetch: async () => Inventory.find({}).sort({ category: 1, itemName: 1 }).lean(),
    columns: [
      { header: "SKU",       key: "sku",          width: 80  },
      { header: "Item Name", key: "itemName",     width: 130 },
      { header: "Category",  key: "category",     width: 80  },
      { header: "Available", key: "availableQty", width: 55, align: "right" },
      { header: "Allocated", key: "allocatedQty", width: 55, align: "right" },
      { header: "Issued",    key: "issuedQty",    width: 50, align: "right" },
      { header: "Total",     key: "totalStock",   width: 65, align: "right" },
    ],
    map: (doc) => ({
      sku:          doc.sku,
      itemName:     doc.itemName,
      category:     doc.category  || "—",
      availableQty: doc.availableQty ?? 0,
      allocatedQty: doc.allocatedQty ?? 0,
      issuedQty:    doc.issuedQty   ?? 0,
      totalStock:   doc.totalStock  ?? 0,
    }),
    // Inventory ignores date range for fetch but shows it in header
    ignoreDateFilter: true,
  },
  Inward: {
    label: "Inward Transactions Report",
    filePrefix: "Inward-Report",
    slackTitle: "Inward Report",
    fetch: async (start, end) =>
      Inward.find({ createdAt: { $gte: start, $lte: end } }).sort({ createdAt: 1 }).lean(),
    columns: [
      { header: "Inward ID",  key: "id",        width: 80  },
      { header: "Date",       key: "date",      width: 70  },
      { header: "Type",       key: "type",      width: 80  },
      { header: "Supplier",   key: "supplier",  width: 100 },
      { header: "Project",    key: "project",   width: 100 },
      { header: "Items",      key: "_items",    width: 45, align: "right" },
      { header: "Status",     key: "status",    width: 40  },
    ],
    map: (doc) => ({
      id:       doc.id,
      date:     doc.date     || "—",
      type:     doc.type     || "—",
      supplier: doc.supplier || doc.vendor || "—",
      project:  doc.project  || "—",
      _items:   doc.items?.length || 0,
      status:   doc.status   || "—",
    }),
  },
  Quotation: {
    label: "Quotations Report",
    filePrefix: "Quotation-Report",
    slackTitle: "Quotation Report",
    fetch: async (start, end) =>
      Quotation.find({ createdAt: { $gte: start, $lte: end } }).sort({ createdAt: 1 }).lean(),
    columns: [
      { header: "Quote ID",   key: "id",           width: 80  },
      { header: "Supplier",   key: "supplierName", width: 120 },
      { header: "MR ID",      key: "mrId",         width: 80  },
      { header: "Status",     key: "status",       width: 65  },
      { header: "Amount (₹)", key: "totalAmount",  width: 90, align: "right" },
      { header: "Date",       key: "date",         width: 80  },
    ],
    map: (doc) => ({
      id:           doc.id,
      supplierName: doc.supplierName || "—",
      mrId:         doc.mrId || "—",
      status:       doc.status || "—",
      totalAmount:  doc.totalAmount != null ? `₹${Number(doc.totalAmount).toLocaleString("en-IN")}` : "—",
      date:         doc.date || "—",
    }),
  },
  "PO-Report": {
    label: "PO Financial Report",
    filePrefix: "PO-Financial-Report",
    slackTitle: "PO Financial Report",
    fetch: async (start, end) =>
      PurchaseOrder.find({ createdAt: { $gte: start, $lte: end } }).sort({ createdAt: 1 }).lean(),
    columns: [
      { header: "PO ID",       key: "id",            width: 80  },
      { header: "Supplier",    key: "supplier",      width: 100 },
      { header: "Project",     key: "project",       width: 85  },
      { header: "Total (₹)",   key: "totalValue",    width: 75, align: "right" },
      { header: "Paid (₹)",    key: "totalPaid",     width: 75, align: "right" },
      { header: "Acct Status", key: "accountStatus", width: 100 },
    ],
    map: (doc) => ({
      id:            doc.id,
      supplier:      doc.supplier || "—",
      project:       doc.project  || "—",
      totalValue:    doc.totalValue != null ? `₹${Number(doc.totalValue).toLocaleString("en-IN")}` : "—",
      totalPaid:     doc.totalPaid != null  ? `₹${Number(doc.totalPaid).toLocaleString("en-IN")}` : "₹0",
      accountStatus: doc.accountStatus || "—",
    }),
  },
  Accounts: {
    label: "Accounts Report",
    filePrefix: "Accounts-Report",
    slackTitle: "Accounts Report",
    fetch: async (start, end) =>
      AccountEntry.find({ createdAt: { $gte: start, $lte: end } }).sort({ createdAt: 1 }).lean(),
    columns: [
      { header: "PO ID",      key: "poId",          width: 80  },
      { header: "Supplier",   key: "supplier",      width: 100 },
      { header: "Project",    key: "project",       width: 90  },
      { header: "Payable(₹)", key: "payableAmount", width: 80, align: "right" },
      { header: "Paid (₹)",   key: "totalPaid",     width: 80, align: "right" },
      { header: "Status",     key: "accountStatus", width: 85  },
    ],
    map: (doc) => ({
      poId:          doc.poId || "—",
      supplier:      doc.supplier || "—",
      project:       doc.project  || "—",
      payableAmount: doc.payableAmount != null ? `₹${Number(doc.payableAmount).toLocaleString("en-IN")}` : "—",
      totalPaid:     doc.totalPaid     != null ? `₹${Number(doc.totalPaid).toLocaleString("en-IN")}` : "₹0",
      accountStatus: doc.accountStatus || "—",
    }),
  },
  MaterialPlan: {
    label: "Material Plans Report",
    filePrefix: "MaterialPlan-Report",
    slackTitle: "Material Plan Report",
    fetch: async (start, end) =>
      MaterialPlan.find({ createdAt: { $gte: start, $lte: end } }).sort({ createdAt: 1 }).lean(),
    columns: [
      { header: "Plan ID",   key: "id",        width: 80  },
      { header: "Project",   key: "project",   width: 110 },
      { header: "Milestone", key: "milestone", width: 90  },
      { header: "Engineer",  key: "engineer",  width: 90  },
      { header: "Status",    key: "status",    width: 80  },
      { header: "Items",     key: "_items",    width: 65, align: "right" },
    ],
    map: (doc) => ({
      id:        doc.id,
      project:   doc.project   || "—",
      milestone: doc.milestone || "—",
      engineer:  doc.engineer  || "—",
      status:    doc.status    || "—",
      _items:    doc.items?.length || 0,
    }),
  },
  Suppliers: {
    label: "Suppliers Report",
    filePrefix: "Suppliers-Report",
    slackTitle: "Suppliers Report",
    // Suppliers don't have a meaningful date range — show all active
    fetch: async () => Supplier.find({ status: { $ne: "Inactive" } }).sort({ companyName: 1 }).lean(),
    ignoreDateFilter: true,
    columns: [
      { header: "Company",  key: "companyName",     width: 130 },
      { header: "Owner",    key: "ownerName",       width: 100 },
      { header: "Mobile",   key: "mobile",          width: 80  },
      { header: "GST No",   key: "gstNumber",       width: 100 },
      { header: "Status",   key: "status",          width: 60  },
      { header: "Products", key: "dealingProducts", width: 45, align: "right" },
    ],
    map: (doc) => ({
      companyName:     doc.companyName || "—",
      ownerName:       doc.ownerName   || "—",
      mobile:          doc.mobile      || "—",
      gstNumber:       doc.gstNumber   || "—",
      status:          doc.status      || "Active",
      dealingProducts: doc.dealingProducts?.length || 0,
    }),
  },
  Catalogue: {
    label: "Catalogue Report",
    filePrefix: "Catalogue-Report",
    slackTitle: "Catalogue Report",
    fetch: async () => Catalogue.find({}).sort({ category: 1, itemName: 1 }).lean(),
    ignoreDateFilter: true,
    columns: [
      { header: "SKU",      key: "sku",      width: 80  },
      { header: "Item",     key: "itemName", width: 140 },
      { header: "Brand",    key: "brand",    width: 70  },
      { header: "Category", key: "category", width: 90  },
      { header: "UoM",      key: "uom",      width: 45  },
      { header: "Status",   key: "status",   width: 90  },
    ],
    map: (doc) => ({
      sku:      doc.sku      || "—",
      itemName: doc.itemName || "—",
      brand:    doc.brand    || "—",
      category: doc.category || "—",
      uom:      doc.uom      || "—",
      status:   doc.status   || "Active",
    }),
  },
  AuditLog: {
    label: "Audit Logs Report",
    filePrefix: "AuditLog-Report",
    slackTitle: "Audit Log Report",
    fetch: async (start, end) =>
      AuditLog.find({ createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 }).limit(500).lean(),
    columns: [
      { header: "User",       key: "userName",   width: 90  },
      { header: "Action",     key: "action",     width: 90  },
      { header: "Resource",   key: "resource",   width: 90  },
      { header: "Entity ID",  key: "entityId",   width: 90  },
      { header: "Summary",    key: "summary",    width: 155 },
    ],
    map: (doc) => ({
      userName:  doc.userName  || "—",
      action:    doc.action    || "—",
      resource:  doc.resource  || doc.entityType || "—",
      entityId:  doc.entityId  || doc.resourceId || "—",
      summary:   doc.summary   || "—",
    }),
  },
};

// ── Core send function for any module ─────────────────────────────────────────

export async function sendModuleReport(moduleKey, dataRange = "today", slackIds = []) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const n8nUrl   = process.env.N8N_WEBHOOK_GENERIC;

  if (!botToken && !n8nUrl) {
    const err = new Error("Neither SLACK_BOT_TOKEN nor N8N_WEBHOOK_GENERIC is configured in .env");
    logger.warn("[Scheduler] " + err.message);
    throw err;
  }

  const cfg = MODULE_CONFIG[moduleKey];
  if (!cfg) {
    logger.warn(`[Scheduler] Unknown module "${moduleKey}" — skipping`);
    return;
  }

  const { start, end } = buildDateRange(dataRange);
  const rangeLabel = dataRange === "today"
    ? start.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : `${start.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} – ${end.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`;

  const dateStr     = start.toISOString().slice(0, 10);
  const pdfFilename = `${cfg.filePrefix}-${dateStr}-${Date.now()}.pdf`;

  // ── Fetch data ───────────────────────────────────────────────────────────────
  let pdfBuffer;
  let recordCount;

  if (moduleKey === "MR") {
    const mrs = await MaterialRequirement.find({
      createdAt: { $gte: start, $lte: end },
    }).sort({ createdAt: 1 }).lean();
    recordCount = mrs.length;
    pdfBuffer = await generateMRReportPDF(mrs, rangeLabel);
  } else {
    const docs = cfg.ignoreDateFilter
      ? await cfg.fetch()
      : await cfg.fetch(start, end);
    recordCount = docs.length;
    const rows = docs.map(cfg.map);
    pdfBuffer = await generateTableReport(cfg.label, cfg.columns, rows, rangeLabel, cfg.slackTitle);
  }

  const pdfUrl = await savePDFAndGetUrl(pdfBuffer, pdfFilename);

  const generatedAt = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
    year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
  });

  // ── Direct Slack upload ──────────────────────────────────────────────────────
  if (botToken && slackIds.length > 0) {
    const message = `📋 *${cfg.slackTitle} — ${rangeLabel}*\n*Total Records:* ${recordCount}  •  _Generated at ${generatedAt}_`;
    for (const channelId of slackIds) {
      try {
        await uploadPDFToSlack(botToken, channelId, pdfBuffer, pdfFilename, message);
        logger.info(`[Scheduler] ${moduleKey} PDF uploaded to Slack channel ${channelId} — ${recordCount} record(s) [${dataRange}]`);
      } catch (err) {
        logger.error(`[Scheduler] Slack upload to ${channelId} failed:`, err.message);
      }
    }
  } else if (botToken && slackIds.length === 0) {
    logger.warn(`[Scheduler] SLACK_BOT_TOKEN set but no slackIds configured for ${moduleKey} automation`);
  }

  // ── n8n webhook ──────────────────────────────────────────────────────────────
  if (n8nUrl) {
    const payload = {
      type: `${moduleKey}_REPORT`, module: moduleKey, dataRange, rangeLabel,
      totalCount: recordCount, slackIds, slackChannel: slackIds[0] || "",
      pdfUrl, pdfFilename, generatedAt,
    };
    try {
      const res = await fetch(n8nUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) logger.error(`[Scheduler] n8n webhook failed: ${res.status}`);
      else logger.info(`[Scheduler] n8n webhook triggered — ${moduleKey} ${recordCount} record(s) [${dataRange}]`);
    } catch (err) {
      logger.error("[Scheduler] n8n webhook error:", err.message);
    }
  }
}

// Keep old export name for backward compatibility
export const sendDailyMRReport = (webhookUrl, dataRange, slackIds) =>
  sendModuleReport("MR", dataRange, slackIds);

// ── Cron scheduler ────────────────────────────────────────────────────────────

const _lastSentMap = new Map();

export function initScheduler() {
  cron.schedule("* * * * *", async () => {
    try {
      const settings = await Settings.findOne().lean();
      const automations = settings?.reportAutomations;
      if (!Array.isArray(automations) || automations.length === 0) return;

      const nowIST = new Date().toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
      }).slice(0, 5);
      const todayIST = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });

      for (const auto of automations) {
        if (!auto.enabled) continue;
        if (nowIST !== (auto.scheduleTime || "20:00")) continue;
        if (_lastSentMap.get(auto.id) === todayIST) continue;
        _lastSentMap.set(auto.id, todayIST);

        const moduleKey = auto.module || "MR";
        try {
          await sendModuleReport(moduleKey, auto.dataRange || "today", auto.slackIds || []);
        } catch (err) {
          logger.error(`[Scheduler] Failed to send ${moduleKey} report:`, err.message);
        }
      }
    } catch (err) {
      logger.error("[Scheduler] Cron check error:", err);
    }
  });
  logger.info("[Scheduler] Report automation scheduler initialized");

  // ── Daily DB backup — runs at 2:00 AM IST (20:30 UTC) ────────────────────────
  const backupTime = process.env.BACKUP_CRON || "30 20 * * *"; // UTC → 2 AM IST
  cron.schedule(backupTime, async () => {
    logger.info("[Backup] Starting scheduled daily database backup...");
    try {
      const result = await runDatabaseBackup();
      logger.info(`[Backup] Daily backup complete — ${result.totalCollections} collections, ${result.totalDocs} docs, ${result.totalSizeKB} KB → ${BACKUP_ROOT}/${result.date}`);
    } catch (err) {
      logger.error("[Backup] Daily backup FAILED:", err.message);
    }
  }, { timezone: "UTC" });
  logger.info(`[Backup] Daily backup scheduled at ${backupTime} UTC (2:00 AM IST) → ${BACKUP_ROOT}`);
}
