var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
import { GRN, Inward, Transaction, Outward, PurchaseOrder, MaterialRequirement, Quotation, Settings } from "../models/index.js";
import { broadcast } from "../utils/broadcaster.js";
import { getRolesWithPermission, createNotification } from "../utils/notification.js";
import { triggerN8nWebhook } from "../utils/webhook.js";
class POService {
  static {
    __name(this, "POService");
  }
  static async cascadeDeletePO(poId, session) {
    const grns = await GRN.find({ poId }).session(session || null);
    for (const grn of grns) {
      await Inward.deleteMany({ grnRef: grn.id }).session(session || null);
      await GRN.deleteOne({ id: grn.id }).session(session || null);
    }
    await Transaction.deleteMany({ poId }).session(session || null);
    await Outward.deleteMany({ poId }).session(session || null);
    const po = await PurchaseOrder.findOne({ id: poId }).session(session || null);
    // Unlock the source quotation when PO is deleted
    const unsetQuery = po && po.quotationId
      ? { $or: [{ linkedPoId: poId }, { id: po.quotationId }] }
      : { linkedPoId: poId };
    await Quotation.updateMany(
      unsetQuery,
      { $unset: { linkedPoId: "" } }
    ).session(session || null);
    broadcast({ type: "DATA_UPDATED", path: "quotations" });
    // Unlock the MR — reset to Quotation Phase so it can be re-used
    if (po && po.mrId) {
      const otherPOs = await PurchaseOrder.find({ mrId: po.mrId, id: { $ne: poId } }).session(session || null);
      if (otherPOs.length === 0) {
        await MaterialRequirement.updateOne(
          { id: po.mrId },
          { $set: { status: "Quotation Phase" } }
        ).session(session || null);
        broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
      }
    }
    await PurchaseOrder.deleteOne({ id: poId }).session(session || null);
  }

  // Freeze the approverSnapshot on a PO document at the moment of final approval.
  // Call this BEFORE po.save() — it mutates po in place.
  static async freezeApproverSnapshot(po) {
    const cfg = await Settings.findOne({}, { approvers: 1, companyApprovers: 1 }).lean();
    const baseApv = cfg?.approvers || {};
    const companyApv = (cfg?.companyApprovers || []).find((ca) => ca.companyName === po.companyName);
    const apv = companyApv || baseApv;
    po.approverSnapshot = {
      purchaseCoord:      baseApv.purchaseCoord      || "",
      purchaseCoordTitle: baseApv.purchaseCoordTitle || "",
      l1: apv.l1 || "", l1Id: apv.l1Id || "", l1Title: apv.l1Title || "",
      l2: apv.l2 || "", l2Id: apv.l2Id || "", l2Title: apv.l2Title || "",
      l3: apv.l3 || "", l3Id: apv.l3Id || "", l3Title: apv.l3Title || "",
    };
  }

  // Fire post-approval notifications and n8n webhook after a PO status change.
  // Pass the already-saved `po` and the `prevStatus` string it held before the save.
  static async fireApprovalSideEffects({ po, prevStatus, changedBy }) {
    await triggerN8nWebhook("PO_APPROVAL", {
      poId:           po.id,
      previousStatus: prevStatus,
      newStatus:      po.status,
      changedBy,
    });

    if (po.status === "Approved") {
      const roles = await getRolesWithPermission("VIEW_PURCHASE_ORDERS");
      await createNotification({
        message:     `PO ${po.id} has been FINAL APPROVED. Procurement can now proceed.`,
        severity:    "success",
        path:        "pos",
        senderId:    null,
        targetRoles: roles.length ? roles : ["Purchase coordinator", "Super Admin"],
      });
    } else if (po.status === "Blocked") {
      await createNotification({
        message:     `PO ${po.id} was REJECTED at L3 by ${changedBy}.`,
        severity:    "error",
        path:        "pos",
        senderId:    null,
        targetRoles: ["Super Admin", "Purchase coordinator"],
      });
    } else if (["Pending L1", "Pending L2"].includes(po.status)) {
      const permMap = { "Pending L1": "APPROVE_PURCHASE_ORDER_L1", "Pending L2": "APPROVE_PURCHASE_ORDER_L2" };
      const roles = await getRolesWithPermission(permMap[po.status]);
      await createNotification({
        message:     `PO ${po.id} redirected back to ${po.status} by ${changedBy}.`,
        severity:    "warning",
        path:        "pos",
        senderId:    null,
        targetRoles: roles.length ? roles : ["Super Admin"],
      });
    }
  }

}
export {
  POService
};
