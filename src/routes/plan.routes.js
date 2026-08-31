import { Router } from "express";
import { createCrudRoutes } from "../utils/crud.js";
import { MaterialPlan, MaterialRequirement } from "../models/index.js";
import { authenticate, serverHasPermission } from "../middleware/auth.middleware.js";
import { logAudit } from "../utils/audit.js";
import { broadcast } from "../utils/broadcaster.js";
import { createNotification, getRolesWithPermission } from "../utils/notification.js";
import { getNextSequence } from "../utils/sequence.js";

const router = Router();
const GM_ROLES = ["Super Admin", "superadmin", "admin", "Director", "GM"];

// Auto-approve: plans are created directly as Approved
router.post("/", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "CREATE_MATERIAL_PLAN")) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const year = new Date().getFullYear();
    const seq = await getNextSequence("PLAN");
    const id = `MP-${year}-${String(seq).padStart(3, "0")}`;
    const plan = await MaterialPlan.create({
      ...req.body,
      id,
      status: "Approved",
      approvedBy: req.user.name,
      approvedAt: new Date(),
    });
    broadcast({ type: "DATA_UPDATED", path: "planning" });
    logAudit(req.user, "CREATE", "planning", plan.id, { project: plan.project });
    res.json({ success: true, data: plan });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Ledger: per-item allocated vs used quantities for a plan
router.get("/:id/ledger", authenticate, async (req, res) => {
  try {
    const plan = await MaterialPlan.findOne({ id: req.params.id }).lean();
    if (!plan) return res.status(404).json({ success: false, message: "Plan not found" });

    const mrs = await MaterialRequirement.find({
      planId: plan.id,
      status: { $nin: ["Rejected"] },
    }).lean();

    // Aggregate used qty from all linked MRs grouped by SKU/item name
    const usedMap = {};
    for (const mr of mrs) {
      for (const item of mr.items || []) {
        const key = item.sku || item.materialName;
        if (key) usedMap[key] = (usedMap[key] || 0) + (Number(item.qty) || 0);
      }
    }

    const ledger = (plan.items || []).map((item) => {
      const key = item.sku || item.itemName;
      const allocated = Number(item.required) || 0;
      const used = usedMap[key] || 0;
      const remaining = Math.max(0, allocated - used);
      return {
        sku: item.sku,
        itemName: item.itemName,
        unit: item.unit,
        priority: item.priority,
        allocated,
        used,
        remaining,
        percentUsed: allocated > 0 ? Math.min(100, Math.round((used / allocated) * 100)) : 0,
      };
    });

    res.json({
      success: true,
      data: ledger,
      planId: plan.id,
      project: plan.project,
      title: plan.title || plan.milestone,
      mrCount: mrs.length,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Submit for approval (backward compat — new plans skip this step)
router.post("/:id/submit", authenticate, async (req, res) => {
  try {
    const plan = await MaterialPlan.findOne({ id: req.params.id });
    if (!plan) return res.status(404).json({ success: false, message: "Plan not found" });
    if (!["Draft", "Open", "Rejected"].includes(plan.status)) {
      return res.status(400).json({ success: false, message: "Only Draft or Rejected plans can be submitted" });
    }
    plan.status = "Pending Approval";
    plan.submittedBy = req.user.name;
    plan.submittedAt = new Date();
    await plan.save();
    broadcast({ type: "DATA_UPDATED", path: "planning" });
    logAudit(req.user, "UPDATE", "planning", plan.id, { action: "Submitted for approval" });
    const gmRoles = await getRolesWithPermission("APPROVE_MATERIAL_PLAN");
    await createNotification({
      message: `Material Plan ${plan.id} submitted for approval by ${req.user.name}`,
      severity: "warning",
      path: "planning",
      senderId: req.user._id,
      targetRoles: gmRoles.length ? gmRoles : ["Director", "Super Admin"],
    });
    res.json({ success: true, data: plan });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Approve (GM/Director)
router.post("/:id/approve", authenticate, async (req, res) => {
  try {
    const canApprove = GM_ROLES.includes(req.user.role) || await serverHasPermission(req.user, "APPROVE_MATERIAL_PLAN");
    if (!canApprove) return res.status(403).json({ success: false, message: "Only GM / Director can approve material plans" });
    const plan = await MaterialPlan.findOne({ id: req.params.id });
    if (!plan) return res.status(404).json({ success: false, message: "Plan not found" });
    plan.status = "Approved";
    plan.approvedBy = req.user.name;
    plan.approvedAt = new Date();
    plan.rejectionReason = undefined;
    plan.rejectedBy = undefined;
    plan.rejectedAt = undefined;
    await plan.save();
    broadcast({ type: "DATA_UPDATED", path: "planning" });
    logAudit(req.user, "APPROVE", "planning", plan.id, { approvedBy: req.user.name });
    await createNotification({
      message: `Material Plan ${plan.id} approved by ${req.user.name}`,
      severity: "success",
      path: "planning",
      senderId: req.user._id,
    });
    res.json({ success: true, data: plan });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Reject (GM/Director)
router.post("/:id/reject", authenticate, async (req, res) => {
  try {
    const canReject = GM_ROLES.includes(req.user.role) || await serverHasPermission(req.user, "REJECT_MATERIAL_PLAN");
    if (!canReject) return res.status(403).json({ success: false, message: "Only GM / Director can reject material plans" });
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ success: false, message: "Rejection reason is required" });
    const plan = await MaterialPlan.findOne({ id: req.params.id });
    if (!plan) return res.status(404).json({ success: false, message: "Plan not found" });
    plan.status = "Rejected";
    plan.rejectedBy = req.user.name;
    plan.rejectedAt = new Date();
    plan.rejectionReason = reason.trim();
    await plan.save();
    broadcast({ type: "DATA_UPDATED", path: "planning" });
    logAudit(req.user, "REJECT", "planning", plan.id, { rejectedBy: req.user.name, reason: reason.trim() });
    await createNotification({
      message: `Material Plan ${plan.id} rejected by ${req.user.name}: ${reason.trim()}`,
      severity: "error",
      path: "planning",
      senderId: req.user._id,
    });
    res.json({ success: true, data: plan });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Standard CRUD: GET /, GET /:id, PUT /:id, DELETE /:id
// POST / is already handled above — Express uses the first registered handler
createCrudRoutes(router, MaterialPlan, "planning", "id", "MATERIAL_PLAN", "PLANNING");

export default router;
