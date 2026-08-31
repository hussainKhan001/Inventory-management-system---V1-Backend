import { Router } from "express";
import { createCrudRoutes } from "../utils/crud.js";
import { MPlan } from "../models/index.js";
import { authenticate, serverHasPermission } from "../middleware/auth.middleware.js";
import { getNextSequence } from "../utils/sequence.js";
import { broadcast } from "../utils/broadcaster.js";
import { createNotification, getRolesWithPermission } from "../utils/notification.js";
import { logAudit } from "../utils/audit.js";

const router = Router();

// Create — generate MP-{year}-{seq}
router.post("/", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "CREATE_MP_PLAN")) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const year = new Date().getFullYear();
    const seq = await getNextSequence("mp");
    const id = `MP-${year}-${seq}`;
    const plan = await MPlan.create({
      ...req.body,
      id,
      createdBy: req.user.name,
      createdById: req.user._id?.toString(),
    });
    broadcast({ type: "DATA_UPDATED", path: "mp-plans" });
    logAudit(req.user, "CREATE", "MPlan", plan.id, { project: plan.project });
    res.json({ success: true, data: plan });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Submit for GM/Director approval
router.post("/:id/submit", authenticate, async (req, res) => {
  try {
    const plan = await MPlan.findOne({ id: req.params.id });
    if (!plan) return res.status(404).json({ success: false, message: "Material Plan not found" });
    if (!["Draft", "Rejected"].includes(plan.status)) {
      return res.status(400).json({ success: false, message: "Only Draft or Rejected plans can be submitted" });
    }
    plan.status = "Pending Approval";
    plan.submittedBy = req.user.name;
    plan.submittedAt = new Date();
    await plan.save();
    broadcast({ type: "DATA_UPDATED", path: "mp-plans" });
    logAudit(req.user, "UPDATE", "MPlan", plan.id, { action: "submitted" });
    const targetRoles = await getRolesWithPermission("APPROVE_MP_PLAN");
    await createNotification({
      message: `Material Plan ${plan.id} submitted for approval by ${req.user.name}`,
      severity: "warning",
      path: "mp-plans",
      senderId: req.user._id,
      targetRoles: targetRoles.length ? targetRoles : ["Director", "Super Admin", "GM"],
    });
    res.json({ success: true, data: plan });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Approve
router.post("/:id/approve", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "APPROVE_MP_PLAN")) {
      return res.status(403).json({ success: false, message: "No permission to approve Material Plans" });
    }
    const plan = await MPlan.findOne({ id: req.params.id });
    if (!plan) return res.status(404).json({ success: false, message: "Material Plan not found" });
    if (plan.status !== "Pending Approval") {
      return res.status(400).json({ success: false, message: "Only Pending Approval plans can be approved" });
    }
    plan.status = "Approved";
    plan.approvedBy = req.user.name;
    plan.approvedAt = new Date();
    plan.rejectionReason = undefined;
    plan.rejectedBy = undefined;
    plan.rejectedAt = undefined;
    await plan.save();
    broadcast({ type: "DATA_UPDATED", path: "mp-plans" });
    logAudit(req.user, "APPROVE", "MPlan", plan.id, { approvedBy: req.user.name });
    await createNotification({
      message: `Material Plan ${plan.id} approved by ${req.user.name}`,
      severity: "success",
      path: "mp-plans",
      senderId: req.user._id,
    });
    res.json({ success: true, data: plan });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Reject
router.post("/:id/reject", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "REJECT_MP_PLAN")) {
      return res.status(403).json({ success: false, message: "No permission to reject Material Plans" });
    }
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ success: false, message: "Rejection reason is required" });
    const plan = await MPlan.findOne({ id: req.params.id });
    if (!plan) return res.status(404).json({ success: false, message: "Material Plan not found" });
    if (!["Pending Approval", "Approved"].includes(plan.status)) {
      return res.status(400).json({ success: false, message: "Only Pending Approval or Approved plans can be rejected" });
    }
    plan.status = "Rejected";
    plan.rejectedBy = req.user.name;
    plan.rejectedAt = new Date();
    plan.rejectionReason = reason.trim();
    await plan.save();
    broadcast({ type: "DATA_UPDATED", path: "mp-plans" });
    logAudit(req.user, "REJECT", "MPlan", plan.id, { reason: reason.trim() });
    await createNotification({
      message: `Material Plan ${plan.id} rejected by ${req.user.name}: ${reason.trim()}`,
      severity: "error",
      path: "mp-plans",
      senderId: req.user._id,
    });
    res.json({ success: true, data: plan });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

createCrudRoutes(router, MPlan, "mp-plans", "id", "MP_PLAN", "MP_PLAN");

export default router;
