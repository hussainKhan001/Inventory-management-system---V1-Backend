import { Router } from "express";
import { ReorderRule, Catalogue } from "../models/index.js";
import { authenticate, serverHasPermission } from "../middleware/auth.middleware.js";
import { broadcast } from "../utils/broadcaster.js";
import { logAudit, buildDiff } from "../utils/audit.js";
import { logger } from "../utils/logger.js";

const router = Router();

// Fields that, when changed, mean the rate/rule was freshly reviewed — resets lastReviewedDate
const REVIEW_RESET_FIELDS = ["rate", "vendor", "thresholdQty", "reorderQty"];

router.get("/", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "VIEW_REORDER_RULE")) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const rules = await ReorderRule.find({}).sort({ updatedAt: -1 }).lean();
    res.json({ success: true, data: rules });
  } catch (error) {
    logger.error("Error fetching reorder rules:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/:sku", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "VIEW_REORDER_RULE")) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const rule = await ReorderRule.findOne({ sku: req.params.sku }).lean();
    if (!rule) return res.status(404).json({ success: false, message: "Reorder rule not found" });
    res.json({ success: true, data: rule });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "CREATE_REORDER_RULE")) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const data = { ...req.body };
    if (!data.sku) return res.status(400).json({ success: false, message: "sku is required" });

    const existing = await ReorderRule.findOne({ sku: data.sku });
    if (existing) return res.status(409).json({ success: false, message: `A reorder rule already exists for SKU ${data.sku}` });

    if (!data.itemName) {
      const cat = await Catalogue.findOne({ sku: data.sku }, { itemName: 1 }).lean();
      data.itemName = cat?.itemName || "";
    }

    const rule = await ReorderRule.create({
      ...data,
      lastReviewedDate: new Date(),
      createdBy: req.user.name,
      updatedBy: req.user.name,
    });
    broadcast({ type: "DATA_UPDATED", path: "reorder-rules" });
    logAudit(req.user, "CREATE", "ReorderRule", rule.sku, { thresholdQty: rule.thresholdQty, reorderQty: rule.reorderQty, vendor: rule.vendor });
    res.json({ success: true, data: rule });
  } catch (error) {
    logger.error("Error creating reorder rule:", error);
    res.status(400).json({ success: false, message: error.message });
  }
});

router.put("/:sku", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "EDIT_REORDER_RULE")) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const rule = await ReorderRule.findOne({ sku: req.params.sku });
    if (!rule) return res.status(404).json({ success: false, message: "Reorder rule not found" });

    const preSnapshot = rule.toObject();
    const data = { ...req.body };
    delete data.sku; // sku is immutable — the unique key
    delete data.lastReviewedDate; // never trust this from the client — computed below

    const changedReviewField = REVIEW_RESET_FIELDS.some(
      (f) => f in data && String(data[f]) !== String(preSnapshot[f])
    );

    Object.assign(rule, data, { updatedBy: req.user.name });
    if (changedReviewField) rule.lastReviewedDate = new Date();
    await rule.save();

    broadcast({ type: "DATA_UPDATED", path: "reorder-rules" });
    const changes = buildDiff(preSnapshot, rule.toObject(), [...REVIEW_RESET_FIELDS, "isActive", "companyName"]);
    logAudit(req.user, "UPDATE", "ReorderRule", rule.sku, { changedReviewField }, { changes });
    res.json({ success: true, data: rule });
  } catch (error) {
    logger.error("Error updating reorder rule:", error);
    res.status(400).json({ success: false, message: error.message });
  }
});

// Explicit "Mark as reviewed" — for when the user re-confirms an unchanged rate
router.post("/:sku/review", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "EDIT_REORDER_RULE")) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const rule = await ReorderRule.findOneAndUpdate(
      { sku: req.params.sku },
      { lastReviewedDate: new Date(), updatedBy: req.user.name },
      { new: true }
    );
    if (!rule) return res.status(404).json({ success: false, message: "Reorder rule not found" });
    broadcast({ type: "DATA_UPDATED", path: "reorder-rules" });
    logAudit(req.user, "UPDATE", "ReorderRule", rule.sku, { action: "Marked as reviewed" });
    res.json({ success: true, data: rule });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.delete("/:sku", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "DELETE_REORDER_RULE")) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const rule = await ReorderRule.findOneAndDelete({ sku: req.params.sku });
    if (!rule) return res.status(404).json({ success: false, message: "Reorder rule not found" });
    broadcast({ type: "DATA_UPDATED", path: "reorder-rules" });
    logAudit(req.user, "DELETE", "ReorderRule", rule.sku, {});
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
