var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
import { Inventory } from "../models/index.js";
import { createNotification } from "./notification.js";
async function sendSlackFile(buffer, fileName, message) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) return null;
  try {
    // Step 1: get upload URL
    const urlRes = await fetch(
      `https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(fileName)}&length=${buffer.length}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const urlData = await urlRes.json();
    if (!urlData.ok) { console.error("[Slack] getUploadURLExternal failed:", urlData.error); return null; }

    // Step 2: upload file bytes
    await fetch(urlData.upload_url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buffer,
    });

    // Step 3: complete upload and post to channel
    const completeRes = await fetch("https://slack.com/api/files.completeUploadExternal", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ id: urlData.file_id }],
        channel_id: channel,
        initial_comment: message,
      }),
    });
    const completeData = await completeRes.json();
    if (!completeData.ok) { console.error("[Slack] completeUploadExternal failed:", completeData.error); return null; }

    // Step 4: files.completeUploadExternal only returns {id, title} — fetch full info to get permalink
    const fileId = completeData.files?.[0]?.id ?? urlData.file_id;
    const infoRes = await fetch(`https://slack.com/api/files.info?file=${fileId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const infoData = await infoRes.json();
    if (!infoData.ok) { console.error("[Slack] files.info failed:", infoData.error); return null; }

    return infoData.file?.permalink ?? null;
  } catch (err) {
    console.error("[Slack] sendSlackFile error:", err);
    return null;
  }
}
__name(sendSlackFile, "sendSlackFile");

const EVENT_URL_MAP = {
  INWARD:                 "N8N_WEBHOOK_INWARD",
  INWARD_UPDATE:          "N8N_WEBHOOK_INWARD_UPDATE",
  INWARD_DELETE:          "N8N_WEBHOOK_INWARD_DELETE",
  OUTWARD:                "N8N_WEBHOOK_OUTWARD",
  OUTWARD_UPDATE:         "N8N_WEBHOOK_OUTWARD_UPDATE",
  OUTWARD_DELETE:         "N8N_WEBHOOK_OUTWARD_DELETE",
  MATERIAL_REQ:           "N8N_WEBHOOK_MATERIAL_REQ",
  NEW_PO:                 "N8N_WEBHOOK_NEW_PO",
  GRN:                    "N8N_WEBHOOK_GRN",
  LOW_STOCK:              "N8N_WEBHOOK_LOW_STOCK",
};

async function triggerN8nWebhook(event, payload) {
  const envKey = EVENT_URL_MAP[event];
  const webhookUrl = (envKey && process.env[envKey]) || process.env.N8N_WEBHOOK_GENERIC;
  if (!webhookUrl) {
    console.warn(`[n8n] No webhook URL set for event "${event}" (checked ${envKey || "—"} and N8N_WEBHOOK_GENERIC). Skipping.`);
    return;
  }

  try {
    const headers = { "Content-Type": "application/json" };
    if (process.env.N8N_WEBHOOK_SECRET) {
      headers["X-Webhook-Secret"] = process.env.N8N_WEBHOOK_SECRET;
    }
    console.log(`[n8n] Triggering webhook for event "${event}" -> ${webhookUrl}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10e3);
    const reqId = payload?.id || payload?.mrNumber || payload?.requestId;
    const bodyObj = {
      event,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      ...(reqId ? { requestId: reqId } : {}),
      ...payload
    };
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyObj),
      signal: controller.signal
    });
    clearTimeout(timeout);
    console.log(`[n8n] Webhook response status for "${event}": ${res.status} ${res.statusText}`);
  } catch (err) {
    if (err.name === "AbortError") {
      console.error(`[n8n] Webhook for event "${event}" timed out after 10s`);
    } else {
      console.error(`[n8n] Failed to fire webhook for event "${event}":`, err?.message || err);
    }
  }
}
__name(triggerN8nWebhook, "triggerN8nWebhook");
async function checkAndFireLowStockWebhook(skus) {
  try {
    const lowItems = await Inventory.aggregate([
      { $match: { sku: { $in: skus } } },
      { $lookup: { from: "catalogues", localField: "sku", foreignField: "sku", as: "catalogue" } },
      { $unwind: { path: "$catalogue", preserveNullAndEmptyArrays: false } },
      { $match: { $expr: { $lte: ["$liveStock", "$catalogue.minStock"] } } },
      { $project: { sku: 1, itemName: 1, liveStock: 1, minStock: "$catalogue.minStock", unit: 1 } }
    ]);
    for (const item of lowItems) {
      await createNotification({
        message: `Low Stock Alert: ${item.itemName} (${item.sku}) is at ${item.liveStock} ${item.unit} (Min: ${item.minStock})`,
        severity: "warning",
        path: "inventory"
      });
      await triggerN8nWebhook("LOW_STOCK", {
        sku: item.sku,
        itemName: item.itemName,
        liveStock: item.liveStock,
        minStock: item.minStock,
        unit: item.unit
      });
    }
  } catch (err) {
    console.error("[n8n] Low stock check failed:", err);
  }
}
__name(checkAndFireLowStockWebhook, "checkAndFireLowStockWebhook");
export {
  checkAndFireLowStockWebhook,
  triggerN8nWebhook,
  sendSlackFile
};
