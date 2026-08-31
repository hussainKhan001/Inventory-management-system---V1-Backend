import { Router } from "express";
import { createCrudRoutes } from "../utils/crud.js";
import { ExtraMaterialRequest } from "../models/index.js";
import { authenticate, serverHasPermission } from "../middleware/auth.middleware.js";
import { getNextSequence } from "../utils/sequence.js";
import { broadcast } from "../utils/broadcaster.js";
import { createNotification, getRolesWithPermission } from "../utils/notification.js";
import { logAudit } from "../utils/audit.js";

const router = Router();

// Create EMR — generate EMR-{year}-{seq}
router.post("/", authenticate, async (req, res) => {
  try {
    const year = new Date().getFullYear();
    const seq = await getNextSequence("emr");
    const id = `EMR-${year}-${seq}`;
    const emr = await ExtraMaterialRequest.create({
      ...req.body,
      id,
      requestedBy: req.user.name,
      requestedById: req.user._id?.toString(),
    });
    broadcast({ type: "DATA_UPDATED", path: "emr" });
    logAudit(req.user, "CREATE", "EMR", emr.id, { masterPoId: emr.masterPoId, project: emr.project });
    const roles = await getRolesWithPermission("APPROVE_EMR");
    await createNotification({
      message: `Extra Material Request ${emr.id} submitted by ${req.user.name}`,
      severity: "warning",
      path: "emr",
      senderId: req.user._id,
      targetRoles: roles,
    });
    res.json({ success: true, data: emr });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Approve
router.post("/:id/approve", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "APPROVE_EMR")) {
      return res.status(403).json({ success: false, message: "No permission to approve EMR" });
    }
    const emr = await ExtraMaterialRequest.findOne({ id: req.params.id });
    if (!emr) return res.status(404).json({ success: false, message: "EMR not found" });
    if (emr.status !== "Pending") {
      return res.status(400).json({ success: false, message: "Only Pending EMRs can be approved" });
    }
    emr.status = "Approved";
    emr.approvedBy = req.user.name;
    emr.approvedAt = new Date();
    await emr.save();
    broadcast({ type: "DATA_UPDATED", path: "emr" });
    logAudit(req.user, "APPROVE", "EMR", emr.id, {});
    await createNotification({
      message: `EMR ${emr.id} approved by ${req.user.name}`,
      severity: "success",
      path: "emr",
      senderId: req.user._id,
    });
    res.json({ success: true, data: emr });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Reject
router.post("/:id/reject", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "APPROVE_EMR")) {
      return res.status(403).json({ success: false, message: "No permission to reject EMR" });
    }
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ success: false, message: "Rejection reason is required" });
    const emr = await ExtraMaterialRequest.findOne({ id: req.params.id });
    if (!emr) return res.status(404).json({ success: false, message: "EMR not found" });
    if (emr.status !== "Pending") {
      return res.status(400).json({ success: false, message: "Only Pending EMRs can be rejected" });
    }
    emr.status = "Rejected";
    emr.rejectedBy = req.user.name;
    emr.rejectedAt = new Date();
    emr.rejectionReason = reason.trim();
    await emr.save();
    broadcast({ type: "DATA_UPDATED", path: "emr" });
    logAudit(req.user, "REJECT", "EMR", emr.id, { reason: reason.trim() });
    await createNotification({
      message: `EMR ${emr.id} rejected by ${req.user.name}: ${reason.trim()}`,
      severity: "error",
      path: "emr",
      senderId: req.user._id,
    });
    res.json({ success: true, data: emr });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

createCrudRoutes(router, ExtraMaterialRequest, "emr", "id", "EMR", "EMR");

export default router;
