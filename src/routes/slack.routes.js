import { Router } from "express";
import express from "express";
import { verifySlackSignature, sendSlackApprovalMessage } from "../utils/slack-po.js";
import { PurchaseOrder, Settings, Supplier } from "../models/index.js";
import { POService } from "../services/po.service.js";
import { logAudit } from "../utils/audit.js";
import { broadcast } from "../utils/broadcaster.js";
import { logger } from "../utils/logger.js";

const router = Router();

router.post(
  "/interactions",
  express.raw({ type: "application/x-www-form-urlencoded" }),
  async (req, res) => {
    const timestamp = req.headers["x-slack-request-timestamp"];
    const signature = req.headers["x-slack-signature"];
    const rawBody   = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body);

    if (!verifySlackSignature(rawBody, timestamp, signature)) {
      return res.status(403).send("Invalid Slack signature");
    }

    let payload;
    try {
      const params = new URLSearchParams(rawBody);
      payload = JSON.parse(params.get("payload") || "{}");
    } catch {
      return res.status(400).send("Invalid payload");
    }

    if (payload.type !== "block_actions") return res.status(200).send();
    const action = payload.actions?.[0];
    if (!action) return res.status(200).send();

    // action_id format: l1_approve, l1_reject, l2_approve, l2_reject, l3_approve, l3_reject, view_portal
    const actionId = action.action_id;
    if (actionId === "view_portal") return res.status(200).send();

    const match = actionId.match(/^l([123])_(approve|reject)$/);
    if (!match) return res.status(200).send();

    // Acknowledge immediately — Slack requires response within 3 seconds
    res.status(200).send();

    const level       = parseInt(match[1], 10);
    const verb        = match[2]; // "approve" or "reject"
    const poId        = action.value;
    const slackUser   = payload.user || {};
    const responseUrl = payload.response_url;
    const approverName = slackUser.real_name || slackUser.name || "Slack User";

    try {
      const po = await PurchaseOrder.findOne({ id: poId });
      if (!po) {
        await _updateMsg(responseUrl, `⚠️ PO *${poId}* not found.`);
        return;
      }

      const expectedStatus = `Pending L${level}`;
      if (po.status !== expectedStatus) {
        await _updateMsg(responseUrl, `⚠️ PO *${poId}* is no longer awaiting L${level} approval (current status: *${po.status}*). No changes made.`);
        return;
      }

      // Load bypass settings for this company
      const cfg = await Settings.findOne({}, { approvers: 1, companyApprovers: 1, bypassApprovals: 1 }).lean();
      const companyApv = (cfg?.companyApprovers || []).find(ca => ca.companyName === po.companyName);
      const apv = companyApv || cfg?.approvers || {};
      const bypass = cfg?.bypassApprovals || {};
      const bl1 = !!(companyApv?.bypassL1 ?? bypass.l1);
      const bl2 = !!(companyApv?.bypassL2 ?? bypass.l2);
      const bl3 = !!(companyApv?.bypassL3 ?? bypass.l3);

      const prevStatus = po.status;
      const now = new Date().toISOString();

      po.approvalHistory = po.approvalHistory || [];
      po.approvalHistory.push({
        action:          verb,
        approverName,
        approverSlackId: slackUser.id || null,
        remark:          "Via Slack",
        at:              now,
      });
      po.markModified("approvalHistory");

      let resultMsg;
      let auditAction;

      if (verb === "approve") {
        // Set current level as Approved
        po[`approvalL${level}`]   = "Approved";
        po[`approvalL${level}At`] = now;
        po[`approvalL${level}By`] = approverName;

        if (level === 1) {
          // L1 approve → check L2 bypass
          if (bl2) {
            po.approvalL2   = "Approved";
            po.approvalL2At = now;
            po.approvalL2By = "Bypassed";
            if (bl3) {
              po.approvalL3   = "Approved";
              po.approvalL3At = now;
              po.approvalL3By = "Bypassed";
              po.status       = "GRN Pending";
              await POService.freezeApproverSnapshot(po);
            } else {
              po.approvalL3 = "Pending";
              po.approvalL3At = null;
              po.status     = "Pending L3";
            }
          } else {
            po.approvalL2   = "Pending";
            po.approvalL2At = null;
            po.approvalL3   = "Pending";
            po.approvalL3At = null;
            po.status       = "Pending L2";
          }
          auditAction = "APPROVE_L1";
          resultMsg = `✅ *${poId}* L1 approved by *${approverName}*. Status → *${po.status}*.`;
        } else if (level === 2) {
          // L2 approve → check L3 bypass
          if (bl3) {
            po.approvalL3   = "Approved";
            po.approvalL3At = now;
            po.approvalL3By = "Bypassed";
            po.status       = "GRN Pending";
            await POService.freezeApproverSnapshot(po);
          } else {
            po.approvalL3   = "Pending";
            po.approvalL3At = null;
            po.status       = "Pending L3";
          }
          auditAction = "APPROVE_L2";
          resultMsg = `✅ *${poId}* L2 approved by *${approverName}*. Status → *${po.status}*.`;
        } else {
          // L3 final approval
          po.status = "GRN Pending";
          await POService.freezeApproverSnapshot(po);
          auditAction = "APPROVE_L3";
          resultMsg = `✅ *${poId}* L3 approved by *${approverName}*. Status → *GRN Pending*.`;
        }
      } else {
        // Reject at any level
        po.status         = "Blocked";
        po[`approvalL${level}By`] = approverName;
        po.rejectedByName = approverName;
        po.rejectedAt     = now;
        auditAction = `REJECT_L${level}`;
        resultMsg = `❌ *${poId}* rejected at L${level} by *${approverName}*. Status → *Blocked*.`;
      }

      await po.save({ validateModifiedOnly: true });
      await POService.fireApprovalSideEffects({ po, prevStatus, changedBy: approverName });
      logAudit(
        { name: approverName, _id: slackUser.id || "slack" },
        auditAction,
        "PurchaseOrder", po.id,
        { via: "slack", slackUserId: slackUser.id }
      );
      broadcast({ type: "DATA_UPDATED", path: "pos" });
      await _updateMsg(responseUrl, resultMsg);
      logger.info(`[Slack] ${auditAction} on ${poId} by ${approverName}`);

      // If approved and next status is a pending level, send next level's card
      if (verb === "approve") {
        const nextLevel = po.status === "Pending L1" ? 1 : po.status === "Pending L2" ? 2 : po.status === "Pending L3" ? 3 : 0;
        if (nextLevel > 0) {
          Promise.all([
            Settings.findOne({}, { approvers: 1, companyApprovers: 1 }).lean(),
            Supplier.findOne({ id: po.supplier }, { companyName: 1, supplierName: 1 }).lean(),
          ]).then(([cfg, supplierDoc]) => {
            const companyApv = (cfg?.companyApprovers || []).find(ca => ca.companyName === po.companyName);
            const apv = companyApv || cfg?.approvers || {};
            const channelKey = `l${nextLevel}SlackChannelId`;
            const channelId = (companyApv?.[channelKey]) || cfg?.approvers?.[channelKey] || "";
            const dmKey = `l${nextLevel}SlackId`;
            const dmUserId = (companyApv?.[dmKey]) || cfg?.approvers?.[dmKey] || "";
            const supplierName = supplierDoc?.companyName || supplierDoc?.supplierName || po.supplier || "";
            sendSlackApprovalMessage({
              level:       nextLevel,
              poId:        po.id,
              supplier:    supplierName,
              companyName: po.companyName || "",
              totalValue:  po.totalValue  || 0,
              project:     po.project     || "",
              approvedBy:  approverName,
              approverName: apv[`l${nextLevel}`] || "",
              channelId,
              dmUserId,
            });
          }).catch(err => logger.error("[Slack] Next level card failed:", err.message));
        }
      }

    } catch (err) {
      logger.error("[Slack] Interaction processing error:", err);
      await _updateMsg(responseUrl, `⚠️ Failed to process action on *${poId}*: ${err.message}`);
    }
  }
);

async function _updateMsg(responseUrl, text) {
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replace_original: true,
        text,
        blocks: [{ type: "section", text: { type: "mrkdwn", text } }]
      })
    });
  } catch (err) {
    logger.error("[Slack] Failed to update message:", err.message);
  }
}

export default router;
