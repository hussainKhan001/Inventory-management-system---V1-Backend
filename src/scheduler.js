import fs from "fs";
import path from "path";
import cron from "node-cron";
import { MaterialRequirement, Settings } from "./models/index.js";
import { logger } from "./utils/logger.js";
import { generateMRReportPDF } from "./utils/mrPdfGenerator.js";
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
  // Save locally as backup
  const dir = path.join(process.cwd(), "uploads", "reports");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), pdfBuffer);

  // Upload to Cloudinary for a publicly accessible URL (avoids nginx routing issues)
  try {
    const publicId = `IMS/reports/${filename.replace(".pdf", "")}`;
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "IMS/reports", public_id: filename.replace(".pdf", ""), resource_type: "raw" },
        (err, res) => { if (err) reject(err); else resolve(res); }
      );
      stream.end(pdfBuffer);
    });
    return result.secure_url;
  } catch (err) {
    logger.warn("[Scheduler] Cloudinary upload failed, falling back to local URL:", err.message);
    const base = (process.env.APP_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, "");
    return `${base}/api/reports/${filename}`;
  }
}

/** Upload PDF buffer directly to a Slack channel using Bot Token (new files API) */
export async function uploadPDFToSlack(token, channelId, pdfBuffer, filename, message) {
  // Step 1: get upload URL
  const urlRes = await fetch(
    `https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(filename)}&length=${pdfBuffer.length}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const urlData = await urlRes.json();
  if (!urlData.ok) throw new Error(`Slack getUploadURLExternal failed: ${urlData.error}`);

  // Step 2: upload file bytes
  await fetch(urlData.upload_url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: pdfBuffer,
  });

  // Step 3: complete upload and post to channel
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

export async function sendDailyMRReport(webhookUrl, dataRange = "today", slackIds = []) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const n8nUrl   = webhookUrl || process.env.N8N_WEBHOOK_GENERIC;

  if (!botToken && !n8nUrl) {
    const err = new Error("Neither SLACK_BOT_TOKEN nor N8N_WEBHOOK_GENERIC is configured in .env");
    logger.warn("[Scheduler] " + err.message);
    throw err;
  }

  const { start, end } = buildDateRange(dataRange);
  const mrs = await MaterialRequirement.find({
    createdAt: { $gte: start, $lte: end },
  }).sort({ createdAt: 1 }).lean();

  const rangeLabel = dataRange === "today"
    ? start.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : `${start.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} – ${end.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`;

  const dateStr    = start.toISOString().slice(0, 10);
  const pdfFilename = `MR-Report-${dateStr}-${Date.now()}.pdf`;
  const pdfBuffer  = await generateMRReportPDF(mrs, rangeLabel);
  const pdfUrl     = await savePDFAndGetUrl(pdfBuffer, pdfFilename);

  const generatedAt = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
    year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
  });

  // ── Direct Slack upload (preferred) ─────────────────────────────────────────
  if (botToken && slackIds.length > 0) {
    const message = `📋 *MR Report — ${rangeLabel}*\n*Total MRs:* ${mrs.length}  •  _Generated at ${generatedAt}_`;
    for (const channelId of slackIds) {
      try {
        await uploadPDFToSlack(botToken, channelId, pdfBuffer, pdfFilename, message);
        logger.info(`[Scheduler] PDF uploaded to Slack channel ${channelId} — ${mrs.length} MR(s) [${dataRange}]`);
      } catch (err) {
        logger.error(`[Scheduler] Slack upload to ${channelId} failed:`, err.message);
      }
    }
  } else if (botToken && slackIds.length === 0) {
    logger.warn("[Scheduler] SLACK_BOT_TOKEN set but no slackIds configured in this automation — skipping direct upload");
  }

  // ── n8n webhook (fallback / additional notification) ────────────────────────
  if (n8nUrl) {
    const payload = {
      type: "MR_REPORT", module: "MR", dataRange, rangeLabel,
      totalCount: mrs.length, slackIds, slackChannel: slackIds[0] || "",
      pdfUrl, pdfFilename, generatedAt,
      mrs: mrs.map(mr => ({
        id:              mr._id,
        mrNumber:        mr.mrNumber || "",
        status:          mr.status  || "",
        requesterName:   mr.requesterName || "",
        project:         mr.projectName || mr.project || "",
        location:        mr.location  || "",
        workType:        mr.workType  || "",
        purpose:         mr.purpose   || "",
        requirementDate: mr.requirementDate
          ? new Date(mr.requirementDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "",
        createdAt: new Date(mr.createdAt).toLocaleString("en-IN", {
          day: "2-digit", month: "short", year: "numeric",
          hour: "2-digit", minute: "2-digit", hour12: true,
        }),
        itemCount: mr.items?.length || 0,
        items: (mr.items || []).map(i => ({
          name: i.materialName || "", qty: i.qty || 0, unit: i.unit || "", status: i.status || "",
        })),
      })),
    };

    try {
      const res = await fetch(n8nUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) logger.error(`[Scheduler] n8n webhook failed: ${res.status}`);
      else logger.info(`[Scheduler] n8n webhook triggered — ${mrs.length} MR(s) [${dataRange}]`);
    } catch (err) {
      logger.error("[Scheduler] n8n webhook error:", err.message);
    }
  }

  if (!botToken && !slackIds.length && !n8nUrl) {
    throw new Error("No delivery method configured (add SLACK_BOT_TOKEN + slackIds, or N8N_WEBHOOK_GENERIC)");
  }
}

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

        if ((auto.module || "MR") === "MR") {
          await sendDailyMRReport(undefined, auto.dataRange || "today", auto.slackIds || []);
        } else {
          logger.info(`[Scheduler] Module "${auto.module}" not yet implemented — skipping`);
        }
      }
    } catch (err) {
      logger.error("[Scheduler] Cron check error:", err);
    }
  });
  logger.info("[Scheduler] Report automation scheduler initialized");
}
