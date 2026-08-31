import { Router } from "express";
import { createCrudRoutes } from "../utils/crud.js";
import { MasterPO, MasterPOLedger, Quotation, Settings } from "../models/index.js";
import { authenticate, serverHasPermission } from "../middleware/auth.middleware.js";
import { getNextSequence } from "../utils/sequence.js";
import { broadcast } from "../utils/broadcaster.js";
import { createNotification, getRolesWithPermission } from "../utils/notification.js";
import { logAudit } from "../utils/audit.js";

const router = Router();

function pendingLevel(status) {
  if (status === "Pending L1") return "L1";
  if (status === "Pending L2") return "L2";
  if (status === "Pending L3") return "L3";
  return null;
}

// Create Master PO — sets up L1/L2/L3 approval chain (same engine as regular PO)
router.post("/", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "CREATE_MASTER_PO")) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const year = new Date().getFullYear();
    const seq = await getNextSequence("master_po");
    const id = `MPO-${year}-${seq}`;
    const data = { ...req.body };

    const settingsCfg = await Settings.findOne({}, { approvers: 1 }).lean();
    const apv = settingsCfg?.approvers || {};
    const approverSnapshot = {
      l1: apv.l1 || "", l1Id: apv.l1Id || "", l1Title: apv.l1Title || "",
      l2: apv.l2 || "", l2Id: apv.l2Id || "", l2Title: apv.l2Title || "",
      l3: apv.l3 || "", l3Id: apv.l3Id || "", l3Title: apv.l3Title || "",
    };

    const mpo = await MasterPO.create({
      ...data,
      id,
      status: "Pending L1",
      approverSnapshot,
      createdBy: req.user.name,
      createdById: req.user._id?.toString(),
      submittedAt: new Date(),
    });

    // Create empty ledger document for this MPO
    const ledgerSeq = await getNextSequence("mpo_ledger");
    await MasterPOLedger.create({
      id: `MPOL-${year}-${ledgerSeq}`,
      masterPoId: id,
      project: mpo.project,
      entries: [],
    });

    // Lock source quotation
    if (data.quotationId) {
      await Quotation.findOneAndUpdate({ id: data.quotationId }, { linkedMasterPoId: id });
      broadcast({ type: "DATA_UPDATED", path: "quotations" });
    }

    broadcast({ type: "DATA_UPDATED", path: "master-pos" });
    logAudit(req.user, "CREATE", "MasterPO", mpo.id, { planId: mpo.planId, supplier: mpo.supplier, totalAmount: mpo.totalAmount });
    const l1Roles = await getRolesWithPermission("APPROVE_MASTER_PO_L1");
    await createNotification({
      message: `Master PO ${mpo.id} created by ${req.user.name} — awaiting L1 approval`,
      severity: "warning",
      path: "master-pos",
      senderId: req.user._id,
      targetRoles: l1Roles,
    });
    res.json({ success: true, data: mpo });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Approve at current level (L1 → L2 → L3 → Approved)
router.post("/:id/approve", authenticate, async (req, res) => {
  try {
    const mpo = await MasterPO.findOne({ id: req.params.id });
    if (!mpo) return res.status(404).json({ success: false, message: "Master PO not found" });
    const level = pendingLevel(mpo.status);
    if (!level) return res.status(400).json({ success: false, message: `Cannot approve MPO in status "${mpo.status}"` });

    if (!await serverHasPermission(req.user, `APPROVE_MASTER_PO_${level}`)) {
      return res.status(403).json({ success: false, message: `No permission for ${level} approval` });
    }

    const settingsCfg = await Settings.findOne({}, { poThreshold: 1 }).lean();
    const threshold = settingsCfg?.poThreshold || {};
    const amount = mpo.totalAmount || 0;

    let nextStatus;
    if (level === "L1") {
      nextStatus = amount >= (threshold.l2 ?? Infinity) ? "Pending L2" : "Approved";
    } else if (level === "L2") {
      nextStatus = amount >= (threshold.l3 ?? Infinity) ? "Pending L3" : "Approved";
    } else {
      nextStatus = "Approved";
    }

    const { remark } = req.body;
    mpo.approvals.push({
      level,
      approver: req.user.name,
      approverId: req.user._id?.toString(),
      status: "Approved",
      approvedAt: new Date(),
      remark: remark || "",
    });
    mpo.status = nextStatus;
    if (nextStatus === "Approved") {
      mpo.approvedBy = req.user.name;
      mpo.approvedAt = new Date();
    }
    await mpo.save();

    broadcast({ type: "DATA_UPDATED", path: "master-pos" });
    logAudit(req.user, "APPROVE", "MasterPO", mpo.id, { level, nextStatus });

    if (nextStatus === "Approved") {
      await createNotification({
        message: `Master PO ${mpo.id} fully approved by ${req.user.name}`,
        severity: "success",
        path: "master-pos",
        senderId: req.user._id,
      });
    } else {
      const nextLevel = nextStatus.replace("Pending ", "");
      const nextRoles = await getRolesWithPermission(`APPROVE_MASTER_PO_${nextLevel}`);
      await createNotification({
        message: `Master PO ${mpo.id} approved at ${level} — awaiting ${nextLevel} approval`,
        severity: "warning",
        path: "master-pos",
        senderId: req.user._id,
        targetRoles: nextRoles,
      });
    }
    res.json({ success: true, data: mpo });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Reject at current level
router.post("/:id/reject", authenticate, async (req, res) => {
  try {
    const mpo = await MasterPO.findOne({ id: req.params.id });
    if (!mpo) return res.status(404).json({ success: false, message: "Master PO not found" });
    const level = pendingLevel(mpo.status);
    if (!level) return res.status(400).json({ success: false, message: `Cannot reject MPO in status "${mpo.status}"` });

    if (!await serverHasPermission(req.user, `APPROVE_MASTER_PO_${level}`)) {
      return res.status(403).json({ success: false, message: `No permission to reject at ${level}` });
    }
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ success: false, message: "Rejection reason is required" });

    mpo.approvals.push({
      level,
      approver: req.user.name,
      approverId: req.user._id?.toString(),
      status: "Rejected",
      approvedAt: new Date(),
      remark: reason.trim(),
    });
    mpo.status = "Rejected";
    mpo.rejectedBy = req.user.name;
    mpo.rejectedAt = new Date();
    mpo.rejectionReason = reason.trim();
    await mpo.save();

    broadcast({ type: "DATA_UPDATED", path: "master-pos" });
    logAudit(req.user, "REJECT", "MasterPO", mpo.id, { level, reason: reason.trim() });
    await createNotification({
      message: `Master PO ${mpo.id} rejected at ${level} by ${req.user.name}: ${reason.trim()}`,
      severity: "error",
      path: "master-pos",
      senderId: req.user._id,
    });
    res.json({ success: true, data: mpo });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Cancel Approved MPO — resets linked quotation to Pending
router.put("/:id/cancel", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "CANCEL_MASTER_PO")) {
      return res.status(403).json({ success: false, message: "No permission to cancel Master PO" });
    }
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ success: false, message: "Cancel reason is required" });
    const mpo = await MasterPO.findOne({ id: req.params.id });
    if (!mpo) return res.status(404).json({ success: false, message: "Master PO not found" });
    if (!["Approved", "GRN Pending"].includes(mpo.status)) {
      return res.status(400).json({ success: false, message: "Only Approved MPOs can be cancelled" });
    }
    mpo.status = "Cancelled";
    mpo.cancelledBy = req.user.name;
    mpo.cancelledAt = new Date();
    mpo.cancelReason = reason.trim();
    await mpo.save();

    // Unlock source quotation
    if (mpo.categoryQuotationId) {
      await Quotation.findOneAndUpdate(
        { id: mpo.categoryQuotationId },
        { $unset: { linkedMasterPoId: "" }, status: "Pending" }
      );
      broadcast({ type: "DATA_UPDATED", path: "quotations" });
    }

    broadcast({ type: "DATA_UPDATED", path: "master-pos" });
    logAudit(req.user, "CANCEL", "MasterPO", mpo.id, { reason: reason.trim() });
    await createNotification({
      message: `Master PO ${mpo.id} cancelled by ${req.user.name}: ${reason.trim()}`,
      severity: "warning",
      path: "master-pos",
      senderId: req.user._id,
    });
    res.json({ success: true, data: mpo });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

createCrudRoutes(router, MasterPO, "master-pos", "id", "MASTER_PO", "MASTER_PO");

export default router;
