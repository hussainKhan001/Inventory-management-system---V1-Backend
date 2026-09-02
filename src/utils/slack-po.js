import crypto from "crypto";

const LEVEL_LABELS = {
  1: "AGM Purchase (L1)",
  2: "Project Head (L2)",
  3: "Director (L3)",
};

const APPROVED_BY_LABEL = {
  1: "Created By",
  2: "L1 Approved By",
  3: "L2 Approved By",
};

export async function sendSlackApprovalMessage({ level, poId, supplier, companyName, totalValue, project, approvedBy, approverName, channelId, dmUserId }) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = channelId || process.env.SLACK_CHANNEL_ID;
  if (!token || (!channel && !dmUserId)) {
    console.warn(`[Slack] No channel/DM configured for L${level} approval on ${poId} — skipping`);
    return;
  }

  const valueStr = totalValue != null
    ? `₹${Number(totalValue).toLocaleString("en-IN")}`
    : "—";

  const label = LEVEL_LABELS[level] || `L${level}`;
  const approvedByLabel = APPROVED_BY_LABEL[level] || "Approved By";
  const headerText = `🔔 PO Approval Required — ${label}${approverName ? ` — ${approverName}` : ""}`;

  const actionPrefix = `l${level}_`;
  const isL3 = level === 3;

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: headerText, emoji: true }
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*PO ID:*\n${poId}` },
        { type: "mrkdwn", text: `*Company:*\n${companyName || "—"}` },
        { type: "mrkdwn", text: `*Supplier:*\n${supplier || "—"}` },
        { type: "mrkdwn", text: `*Total Value:*\n${valueStr}` },
        { type: "mrkdwn", text: `*Project:*\n${project || "—"}` },
        { type: "mrkdwn", text: `*${approvedByLabel}:*\n${approvedBy || "—"}` },
      ]
    },
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Approve", emoji: true },
          style: "primary",
          action_id: `${actionPrefix}approve`,
          value: poId,
          confirm: {
            title: { type: "plain_text", text: "Approve PO?" },
            text: { type: "mrkdwn", text: `Approve *${poId}*?` },
            confirm: { type: "plain_text", text: "Yes, Approve" },
            deny: { type: "plain_text", text: "Cancel" }
          }
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ Reject", emoji: true },
          style: "danger",
          action_id: `${actionPrefix}reject`,
          value: poId,
          confirm: {
            title: { type: "plain_text", text: "Reject PO?" },
            text: { type: "mrkdwn", text: `Reject *${poId}*? This will block the PO.` },
            confirm: { type: "plain_text", text: "Yes, Reject" },
            deny: { type: "plain_text", text: "Cancel" }
          }
        },
        {
          type: "button",
          text: { type: "plain_text", text: "↗ View in Portal", emoji: true },
          url: `${process.env.FRONTEND_URL || "https://inventory-management-system--v1.vercel.app"}/#pos`,
          action_id: "view_portal",
        }
      ]
    }
  ];

  const postToChannel = async (target) => {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: target,
        text: `L${level} Approval Required: ${poId} — ${supplier || ""} (${valueStr})`,
        blocks
      })
    });
    const data = await res.json();
    if (!data.ok) console.error(`[Slack] Failed to send L${level} message to ${target} for ${poId}:`, data.error);
    else console.log(`[Slack] L${level} approval card sent for ${poId} → ${target}`);
  };

  const postDM = async (userId) => {
    // Open DM channel with user first, then post
    const openRes = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ users: userId })
    });
    const openData = await openRes.json();
    if (!openData.ok) {
      console.error(`[Slack] conversations.open failed for ${userId}:`, openData.error);
      return;
    }
    await postToChannel(openData.channel.id);
  };

  try {
    const sends = [];
    if (channel) sends.push(postToChannel(channel));
    if (dmUserId && dmUserId !== channel) sends.push(postDM(dmUserId));
    await Promise.all(sends);
  } catch (err) {
    console.error(`[Slack] sendSlackApprovalMessage L${level} error:`, err.message);
  }
}

export function verifySlackSignature(rawBody, timestamp, signature) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return true;

  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
  if (parseInt(timestamp, 10) < fiveMinutesAgo) return false;

  const sigBase = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac("sha256", signingSecret);
  hmac.update(sigBase);
  const computed = `v0=${hmac.digest("hex")}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    return false;
  }
}
