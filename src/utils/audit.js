import { logger } from "./logger.js";
import { AuditLog } from "../models/index.js";

const ACTION_COLOR = {
  CREATE:  "#2EB67D",
  UPDATE:  "#ECB22E",
  DELETE:  "#E01E5A",
  APPROVE: "#2EB67D",
  REJECT:  "#E01E5A",
  CANCEL:  "#ECB22E",
  LOGIN:   "#36C5F0",
  LOGOUT:  "#808080",
};

const ACTION_EMOJI = {
  CREATE:  "✅",
  UPDATE:  "✏️",
  DELETE:  "🗑️",
  APPROVE: "✅",
  REJECT:  "❌",
  CANCEL:  "🚫",
  LOGIN:   "🔐",
  LOGOUT:  "🔓",
};

const sendSlackAudit = async (user, action, resource, resourceId, details) => {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl || !webhookUrl.startsWith("https://")) return;

  const emoji  = ACTION_EMOJI[action]  || "📋";
  const color  = ACTION_COLOR[action]  || "#439FE0";
  const now    = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

  const detailText = details && Object.keys(details).length
    ? Object.entries(details).map(([k, v]) => `• *${k}:* ${v}`).join("\n")
    : null;

  const body = {
    attachments: [{
      color,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `${emoji} *${action} — ${resource}*` },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*User:*\n${user.name || "Unknown"}` },
            { type: "mrkdwn", text: `*ID:*\n\`${resourceId}\`` },
          ],
        },
        ...(detailText ? [{
          type: "section",
          text: { type: "mrkdwn", text: detailText },
        }] : []),
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `🕐 ${now} IST  •  ${user.email || ""}` }],
        },
      ],
    }],
  };

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    logger.error("[Audit/Slack] Webhook failed:", err.message);
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────

const _fmt = (v) => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

/**
 * Build a field-level diff between oldDoc and newDoc.
 * @param {object} oldDoc  - snapshot before the change
 * @param {object} newDoc  - snapshot after the change
 * @param {string[]} [fields] - which fields to compare; omit to compare all keys
 * @returns {Array<{ field, oldValue, newValue, summary }>}
 */
const buildDiff = (oldDoc, newDoc, fields) => {
  const keys = fields || Object.keys({ ...oldDoc, ...newDoc });
  return keys
    .filter((k) => JSON.stringify(oldDoc?.[k]) !== JSON.stringify(newDoc?.[k]))
    .map((k) => ({
      field:    k,
      oldValue: oldDoc?.[k],
      newValue: newDoc?.[k],
      summary:  `${k} changed from ${_fmt(oldDoc?.[k])} to ${_fmt(newDoc?.[k])}`,
    }));
};

/**
 * Build a human-readable summary for a log entry.
 * @param {string} action
 * @param {string} resource
 * @param {Array}  [changes]
 * @returns {string}
 */
const buildSummary = (action, resource, changes) => {
  if (changes?.length === 1) return changes[0].summary;
  if (changes?.length > 1) {
    const fields = changes.map((c) => c.field).join(", ");
    return `${action} on ${resource}: changed ${fields}`;
  }
  return `${action} on ${resource}`;
};

// ── Core logger ───────────────────────────────────────────────────────────

/**
 * Fire-and-forget audit logger — backward compatible with all existing callsites.
 *
 * Existing usage (5 args):
 *   logAudit(user, action, resource, resourceId, details)
 *
 * Extended usage (with field-level diff):
 *   logAudit(user, action, resource, resourceId, details, { changes, summary })
 *
 * @param {object}  user
 * @param {string}  action     - CREATE | UPDATE | DELETE | APPROVE | REJECT | CANCEL | LOGIN | LOGOUT …
 * @param {string}  resource   - entity type, e.g. "PurchaseOrder"
 * @param {string}  resourceId
 * @param {object}  [details]  - freeform extra payload (kept for backward compat)
 * @param {object}  [opts]     - { changes?: Array, summary?: string }
 */
const logAudit = (user, action, resource, resourceId, details, opts = {}) => {
  if (!user?._id) return;

  const { changes, summary } = opts;
  const resolvedSummary = summary
    || (changes?.length ? buildSummary(action, resource, changes) : undefined);

  AuditLog.create({
    // ── Existing fields ──────────────────────────────────────────────
    userId:     user._id,
    userName:   user.name  || "Unknown",
    userEmail:  user.email || "",
    action,
    resource,
    resourceId,
    details,
    // ── New fields ───────────────────────────────────────────────────
    entityType: resource,
    entityId:   resourceId,
    changes:    changes || [],
    summary:    resolvedSummary,
  }).catch((err) => logger.error("[Audit] Failed to write log:", err));

  sendSlackAudit(user, action, resource, resourceId, details);
};

export { logAudit, buildDiff, buildSummary };
