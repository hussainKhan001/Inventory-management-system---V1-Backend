var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
import dotenv from "dotenv";
dotenv.config();
import express from "express";
import path from "path";
import http from "http";
import fs from "fs";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import mongoose from "mongoose";
import rateLimit from "express-rate-limit";
import compression from "compression";
import { logger } from "./utils/logger.js";
import { connectDB } from "./config/db.js";
import { initBroadcaster, broadcast } from "./utils/broadcaster.js";
import { createNotification } from "./utils/notification.js";
import { StockCheckReport } from "./models/index.js";
import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import rolePermissionRoutes from "./routes/rolePermission.routes.js";
import catalogueRoutes from "./routes/catalogue.routes.js";
import supplierRoutes from "./routes/supplier.routes.js";
import inventoryRoutes from "./routes/inventory.routes.js";
import planRoutes from "./routes/plan.routes.js";
import planRevisionRoutes from "./routes/plan-revision.routes.js";
import mrRoutes from "./routes/mr.routes.js";
import poRoutes from "./routes/po.routes.js";
import quotationRoutes from "./routes/quotation.routes.js";
import grnRoutes from "./routes/grn.routes.js";
import transactionRoutes from "./routes/transaction.routes.js";
import stockCheckRoutes from "./routes/stockCheck.routes.js";
import settingRoutes from "./routes/setting.routes.js";
import notificationRoutes from "./routes/notification.routes.js";
import writeoffRoutes from "./routes/writeoff.routes.js";
import gatePassRoutes from "./routes/gate-passes.routes.js";
import publicRoutes from "./routes/public.routes.js";
import uploadRoutes from "./routes/upload.routes.js";
import auditRoutes from "./routes/audit.routes.js";
import gstRateRoutes from "./routes/gstRate.routes.js";
import formConfigRoutes, { seedFormConfigs } from "./routes/form-config.routes.js";
import accountsRoutes from "./routes/accounts.routes.js";
import ledgerRoutes from "./routes/ledger.routes.js";
import { initScheduler, sendDailyMRReport } from "./scheduler.js";
import { encryptionMiddleware } from "./middleware/encrypt.middleware.js";
const IS_PROD = process.env.NODE_ENV === "production";
if (IS_PROD) {
  const required = ["MONGODB_URI", "JWT_SECRET", "ENCRYPTION_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    logger.error(`[STARTUP] Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5e3;
// Required for Render/proxied deployments so rate-limit sees real client IPs
app.set("trust proxy", 1);
app.use(compression({ level: 6, threshold: 1024 }));
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  // allow image loads from frontend
  contentSecurityPolicy: false
  // CSP managed at CDN/Vercel level
}));
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  // 15 minutes
  max: 20,
  message: { success: false, message: "Too many login attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1e3,
  // 1 minute
  max: 300,
  message: { success: false, message: "Too many requests. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false
});
app.use("/api/auth/login", authLimiter);
app.use("/api", apiLimiter);
const ALLOWED_ORIGINS = [
  "*",
  "http://localhost:5173",
  "http://localhost:5174",
  "https://inventory-management-system-v1-fron.vercel.app",
  "https://inventory-management-system--v1.vercel.app",
  ...process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()) : []
];
app.use(cors({
  origin: /* @__PURE__ */ __name((origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin "${origin}" not allowed`));
  }, "origin"),
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "x-enc"]
}));
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(morgan(IS_PROD ? "combined" : "dev"));
app.use(encryptionMiddleware);
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use("/uploads", express.static(uploadDir));
connectDB().then(() => { seedFormConfigs(); initScheduler(); });
initBroadcaster(server);
app.get("/api/health", (_req, res) => res.json({ status: "ok", ts: Date.now() }));

// Public route to serve generated report PDFs via /api path (works behind any reverse proxy)
app.get("/api/reports/:filename", (req, res) => {
  const filename = path.basename(req.params.filename); // strip any path traversal
  const filepath = path.join(process.cwd(), "uploads", "reports", filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ success: false, message: "Report not found" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.sendFile(filepath);
});
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/role-permissions", rolePermissionRoutes);
app.use("/api/catalogue", catalogueRoutes);
app.use("/api/suppliers", supplierRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/planning", planRoutes);
app.use("/api/plan-revisions", planRevisionRoutes);
app.use("/api/material-requirements", mrRoutes);
app.use("/api/pos", poRoutes);
app.use("/api/quotations", quotationRoutes);
app.use("/api/grn", grnRoutes);
app.use("/api", transactionRoutes);
app.use("/api/stock-check", stockCheckRoutes);
app.use("/api/stock-check-reports", stockCheckRoutes);
app.use("/api", settingRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/writeoffs", writeoffRoutes);
app.use("/api/gate-passes", gatePassRoutes);
app.use("/api/public", publicRoutes);
app.use("/api", uploadRoutes);
app.use("/api/audit-logs", auditRoutes);
app.use("/api", gstRateRoutes);
app.use("/api/form-configs", formConfigRoutes);
app.use("/api/accounts", accountsRoutes);
app.use("/api/ledger", ledgerRoutes);
app.post("/api/webhook/trigger-mr-report", async (req, res) => {
  try {
    const secret = req.headers["x-webhook-secret"];
    if (process.env.SLACK_REPORT_SECRET && secret !== process.env.SLACK_REPORT_SECRET) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const dataRange = req.query.dataRange || req.body?.dataRange || "today";
    const slackIds = req.body?.slackIds || [];
    await sendDailyMRReport(undefined, dataRange, slackIds);
    res.json({ success: true, message: "MR report sent to n8n" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
app.post("/api/webhook/n8n", async (req, res) => {
  try {
    const signature = req.headers["x-webhook-secret"];
    if (process.env.N8N_WEBHOOK_SECRET && signature !== process.env.N8N_WEBHOOK_SECRET) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const { action, payload } = req.body;
    if (!action) throw new Error("action is required");
    if (action === "UPDATE_PO_STATUS") {
      const { poId, status } = payload;
      const PurchaseOrder = mongoose.model("PurchaseOrder");
      const po = await PurchaseOrder.findOneAndUpdate({ id: poId }, { $set: { status } }, { returnDocument: 'after' });
      if (!po) throw new Error(`PO ${poId} not found`);
      broadcast({ type: "DATA_UPDATED", path: "pos" });
      res.json({ success: true, message: `PO ${poId} status updated to ${status}` });
    } else if (action === "APPROVE_STOCK_CHECK") {
      const { reportId, approvedBy } = payload;
      const report = await StockCheckReport.findOneAndUpdate(
        { id: reportId },
        { $set: { status: "Approved", approvedBy, approvedAt: /* @__PURE__ */ new Date() } },
        { returnDocument: 'after' }
      );
      if (!report) throw new Error(`Report ${reportId} not found`);
      broadcast({ type: "DATA_UPDATED", path: "stock-check-reports" });
      res.json({ success: true, message: `Stock check ${reportId} approved` });
    } else if (action === "NOTIFY") {
      const { message, severity, path: notifPath, targetRoles } = payload;
      await createNotification({ message, severity, path: notifPath, targetRoles });
      res.json({ success: true, message: "Notification created" });
    } else if (action === "BROADCAST") {
      broadcast(payload);
      res.json({ success: true, message: "Broadcast sent" });
    } else {
      throw new Error(`Unsupported action ${action}`);
    }
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
app.use((err, _req, res, _next) => {
  logger.error("[Error]", err);
  const status = err.status || 500;
  const message = IS_PROD && status === 500 ? "Internal server error" : err.message || "Internal server error";
  res.status(status).json({ success: false, message });
});
server.listen(PORT, () => {
  logger.info(`IMS backend running on port ${PORT} [${process.env.NODE_ENV || "development"}]`);
});
const shutdown = /* @__PURE__ */ __name(async (signal) => {
  logger.info(`[${signal}] Shutting down gracefully...`);
  server.close(async () => {
    await mongoose.connection.close();
    logger.info("MongoDB connection closed. Bye.");
    process.exit(0);
  });
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 1e4);
}, "shutdown");
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  logger.error("[uncaughtException]", err);
  shutdown("uncaughtException");
});
