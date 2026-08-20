var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
import { logger } from "../utils/logger.js";
import { Router } from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import { PurchaseOrder, Quotation, MaterialRequirement, Supplier, Settings } from "../models/index.js";
import { GRN } from "../models/grn.model.js";
import { authenticate, serverHasPermission } from "../middleware/auth.middleware.js";
import { getRolesWithPermission, createNotification } from "../utils/notification.js";
import { triggerN8nWebhook, sendSlackFile } from "../utils/webhook.js";
import cloudinary from "../config/cloudinary.js";
import { broadcast } from "../utils/broadcaster.js";
import { getNextSequence } from "../utils/sequence.js";
import { createCrudRoutes } from "../utils/crud.js";
import { logAudit } from "../utils/audit.js";

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === "application/pdf"),
});
const router = Router();
router.get("/occupied-mrs", authenticate, async (req, res) => {
  try {
    const RELEASED = ["Rejected", "Blocked", "Cancelled"];

    // Source 1: POs that have quotationId stored directly
    const activePOs = await PurchaseOrder.find(
      { quotationId: { $exists: true, $ne: "" }, status: { $nin: RELEASED } },
      { quotationId: 1, _id: 0 }
    ).lean();
    const fromPOs = activePOs.map((p) => p.quotationId).filter(Boolean);

    // Source 2: Quotations with linkedPoId (covers legacy POs that lack quotationId)
    const linkedQuotes = await Quotation.find(
      { linkedPoId: { $exists: true, $ne: "" } },
      { id: 1, linkedPoId: 1, _id: 0 }
    ).lean();
    const linkedPoIds = [...new Set(linkedQuotes.map((q) => q.linkedPoId).filter(Boolean))];
    const activeLinkedPoIds = linkedPoIds.length
      ? new Set(
          (await PurchaseOrder.find(
            { id: { $in: linkedPoIds }, status: { $nin: RELEASED } },
            { id: 1, _id: 0 }
          ).lean()).map((p) => p.id)
        )
      : new Set();
    const fromQuotes = linkedQuotes
      .filter((q) => activeLinkedPoIds.has(q.linkedPoId))
      .map((q) => q.id);

    // Source 3: Legacy POs (no quotationId, no linkedPoId on quotation) — match by mrId + workType + supplier name
    const alreadyCovered = new Set([...fromPOs, ...fromQuotes]);
    const legacyPOs = await PurchaseOrder.find(
      { $or: [{ quotationId: { $exists: false } }, { quotationId: "" }], mrId: { $exists: true, $ne: "" }, status: { $nin: RELEASED } },
      { mrId: 1, workType: 1, supplier: 1, _id: 0 }
    ).lean();

    const fromLegacy = [];
    if (legacyPOs.length) {
      const legacyMrIds = [...new Set(legacyPOs.map((p) => p.mrId))];
      const candidates = await Quotation.find(
        { mrId: { $in: legacyMrIds }, id: { $nin: [...alreadyCovered] } },
        { id: 1, mrId: 1, category: 1, supplierName: 1, _id: 0 }
      ).lean();
      for (const po of legacyPOs) {
        const poSupplier = (po.supplier || "").toLowerCase();
        const match = candidates.find((q) => {
          if (q.mrId !== po.mrId) return false;
          if (po.workType && q.category && q.category !== po.workType) return false;
          const qName = (q.supplierName || "").toLowerCase();
          return qName && poSupplier && (qName === poSupplier || qName.includes(poSupplier) || poSupplier.includes(qName));
        });
        if (match && !alreadyCovered.has(match.id)) {
          fromLegacy.push(match.id);
          alreadyCovered.add(match.id);
        }
      }
    }

    const data = [...new Set([...fromPOs, ...fromQuotes, ...fromLegacy])];
    res.json({ success: true, data });
  } catch (error) {
    logger.error("Error fetching occupied MRs:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});
router.post("/", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "CREATE_PURCHASE_ORDER")) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const year = (/* @__PURE__ */ new Date()).getFullYear();
    const seq = await getNextSequence("PO");
    const customId = `PO-${year}-${seq}`;
    const data = { ...req.body };
    const calcCharge = /* @__PURE__ */ __name((amt, pct, type) => {
      if (!amt) return 0;
      return type === "Exclusive" ? amt * (1 + pct / 100) : amt;
    }, "calcCharge");
    const itemsTotal = data.items?.reduce((sum, item2) => sum + (item2.totalWithGST || 0), 0) || 0;
    const freightTotal = calcCharge(data.freightAmount || 0, data.freightGstPct || 0, data.freightGstType || "Exclusive");
    const loadingTotal = calcCharge(data.loadingAmount || 0, data.loadingGstPct || 0, data.loadingGstType || "Exclusive");
    const unloadingTotal = calcCharge(data.unloadingAmount || 0, data.unloadingGstPct || 0, data.unloadingGstType || "Exclusive");
    const totalValue = itemsTotal + freightTotal + loadingTotal + unloadingTotal;
    const settingsCfg = await Settings.findOne({}, { approvers: 1, companyApprovers: 1 }).lean();
    const baseApv = settingsCfg?.approvers || {};
    // Company-specific approvers override global approvers when companyName matches
    const companyApvCfg = (settingsCfg?.companyApprovers || []).find(ca => ca.companyName === data.companyName);
    const apv = companyApvCfg || baseApv;
    const approverSnapshot = {
      purchaseCoord:      baseApv.purchaseCoord      || "",
      purchaseCoordTitle: baseApv.purchaseCoordTitle || "",
      l1: apv.l1 || "", l1Id: apv.l1Id || "", l1Title: apv.l1Title || "",
      l2: apv.l2 || "", l2Id: apv.l2Id || "", l2Title: apv.l2Title || "",
      l3: apv.l3 || "", l3Id: apv.l3Id || "", l3Title: apv.l3Title || "",
    };
    const item = await PurchaseOrder.create({
      ...data,
      id: customId,
      totalValue,
      status: data.status || "Pending L1",
      createdBy: req.user.name,
      date: data.date || (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
      ...(approverSnapshot ? { approverSnapshot } : {}),
    });
    // Link source quotation → set linkedPoId so only that quotation is locked
    if (data.quotationId) {
      await Quotation.findOneAndUpdate(
        { id: data.quotationId },
        { linkedPoId: customId }
      );
      broadcast({ type: "DATA_UPDATED", path: "quotations" });
    }
    // Lock the source MR — mark it as PO Raised so it no longer appears in the PO dropdown
    if (data.mrId) {
      await MaterialRequirement.findOneAndUpdate(
        { id: data.mrId },
        { status: "PO Created" }
      );
      broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
    }
    broadcast({ type: "DATA_UPDATED", path: "pos" });
    logAudit(req.user, "CREATE", "PurchaseOrder", item.id, { supplier: item.supplier, totalValue: item.totalValue, status: item.status });
    await createNotification({
      message: `New PURCHASE ORDER created by ${req.user.name}`,
      severity: "success",
      path: "pos",
      senderId: req.user._id
    });
    if (item.status === "Pending L1") {
      const roles = await getRolesWithPermission("APPROVE_PURCHASE_ORDER_L1");
      await createNotification({
        message: `PO ${item.id} created and requires L1 Approval`,
        severity: "warning",
        path: "pos",
        senderId: req.user._id,
        targetRoles: roles
      });
    }
    res.json({ success: true, data: item });
  } catch (error) {
    logger.error("Error creating PO:", error);
    res.status(400).json({ success: false, message: error.message });
  }
});
router.put("/:id/cancel", authenticate, async (req, res) => {
  try {
    const { cancelNote } = req.body;
    if (!cancelNote || !String(cancelNote).trim()) {
      return res.status(400).json({ success: false, message: "Cancellation note is required" });
    }
    const roleLower = (req.user.role || "").toLowerCase().trim();
    const isSuperAdmin = ["super admin", "superadmin", "admin"].includes(roleLower);
    const isAGM = roleLower === "agm";
    if (!isSuperAdmin && !isAGM) {
      return res.status(403).json({ success: false, message: "Only AGM can cancel approved Purchase Orders" });
    }
    const po = await PurchaseOrder.findOne({ id: req.params.id });
    if (!po) return res.status(404).json({ success: false, message: "Purchase Order not found" });
    if (po.status !== "Approved") {
      return res.status(400).json({ success: false, message: `PO is currently "${po.status}". Only Approved POs can be cancelled.` });
    }
    const cancelledAt = (/* @__PURE__ */ new Date()).toISOString();
    await PurchaseOrder.findOneAndUpdate(
      { id: req.params.id },
      { status: "Cancelled", cancelNote: String(cancelNote).trim(), cancelledBy: req.user.name, cancelledAt }
    );
    let quotationReset = false;
    // Clear linkedPoId from source quotation when PO is cancelled
    const cancelUnsetQuery = po.quotationId
      ? { $or: [{ linkedPoId: req.params.id }, { id: po.quotationId }] }
      : { linkedPoId: req.params.id };
    await Quotation.updateMany(
      cancelUnsetQuery,
      { $unset: { linkedPoId: "" } }
    );
    if (po.mrId) {
      const mr = await MaterialRequirement.findOne({ id: po.mrId });
      if (mr) {
        let quotationId = po.quotationId || mr.approvedQuotationId;
        if (!quotationId && Array.isArray(mr.approvals) && mr.approvals.length > 0) {
          const match = mr.approvals.find((a) => a.category === po.workType);
          if (match) quotationId = match.quotationId;
        }
        if (quotationId) {
          const newToken = `QT-TOKEN-${quotationId}-${Date.now()}`;
          await Quotation.findOneAndUpdate(
            { id: quotationId },
            { status: "Pending", token: newToken }
          );
          quotationReset = true;
          broadcast({ type: "DATA_UPDATED", path: "quotations" });
        }
        await MaterialRequirement.findOneAndUpdate(
          { id: po.mrId },
          { status: "Quotation Phase", $unset: { approvedQuotationId: "", approvedSupplier: "" } }
        );
        broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
      }
    }
    broadcast({ type: "DATA_UPDATED", path: "pos" });
    logAudit(req.user, "CANCEL", "PurchaseOrder", po.id, { reason: String(cancelNote).trim() });
    await createNotification({
      message: `PO ${po.id} cancelled by ${req.user.name}. Reason: ${String(cancelNote).trim()}`,
      severity: "warning",
      path: "pos",
      senderId: req.user._id
    });
    await triggerN8nWebhook("PO_CANCELLED", {
      poId: po.id,
      cancelledBy: req.user.name,
      cancelNote: String(cancelNote).trim(),
      quotationReset
    });
    res.json({
      success: true,
      message: `PO cancelled successfully${quotationReset ? ". Linked quotation reset to Pending." : ""}`,
      data: { id: req.params.id, cancelledAt }
    });
  } catch (error) {
    logger.error("Error cancelling PO:", error);
    res.status(400).json({ success: false, message: error.message });
  }
});
router.post("/:id/close", authenticate, async (req, res) => {
  try {
    const { closedItems } = req.body;
    const po = await PurchaseOrder.findOneAndUpdate(
      { id: req.params.id },
      { status: "PO Closed", ...(closedItems !== undefined ? { closedItems } : {}) },
      { returnDocument: "after" }
    ).lean();
    if (!po) return res.status(404).json({ success: false, message: "PO not found" });
    broadcast({ type: "DATA_UPDATED", path: "pos" });
    res.json({ success: true, data: po });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.post("/:id/reopen", authenticate, async (req, res) => {
  try {
    const po = await PurchaseOrder.findOneAndUpdate(
      { id: req.params.id, status: "PO Closed" },
      { status: "GRN Variance", $unset: { closedItems: "" } },
      { returnDocument: "after" }
    ).lean();
    if (!po) return res.status(404).json({ success: false, message: "PO not found or not in Closed status" });
    broadcast({ type: "DATA_UPDATED", path: "pos" });
    res.json({ success: true, data: po });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.post("/:id/hold", authenticate, async (req, res) => {
  try {
    const po = await PurchaseOrder.findOne({ id: req.params.id });
    if (!po) return res.status(404).json({ success: false, message: "PO not found" });
    if (po.status === "On Hold") return res.status(400).json({ success: false, message: "PO is already on hold" });
    const prevStatus = po.status;
    po.set({ status: "On Hold", previousStatus: prevStatus, holdReason: (req.body || {}).reason || "" });
    await po.save({ validateModifiedOnly: true });
    broadcast({ type: "DATA_UPDATED", path: "pos" });
    res.json({ success: true, data: { id: po.id, status: "On Hold", previousStatus: prevStatus } });
  } catch (error) {
    logger.error("Hold PO error:", error);
    res.status(400).json({ success: false, message: error.message || "Failed to hold PO" });
  }
});
router.post("/:id/unhold", authenticate, async (req, res) => {
  try {
    const po = await PurchaseOrder.findOne({ id: req.params.id });
    if (!po) return res.status(404).json({ success: false, message: "PO not found" });
    if (po.status !== "On Hold") return res.status(400).json({ success: false, message: "PO is not on hold" });
    const restoreStatus = po.previousStatus || "Pending L1";
    po.set({ status: restoreStatus, previousStatus: undefined, holdReason: undefined });
    await po.save({ validateModifiedOnly: true });
    broadcast({ type: "DATA_UPDATED", path: "pos" });
    res.json({ success: true, data: { id: po.id, status: restoreStatus } });
  } catch (error) {
    logger.error("Unhold PO error:", error);
    res.status(400).json({ success: false, message: error.message || "Failed to lift hold" });
  }
});
router.post("/:id/pdf-slack", authenticate, pdfUpload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "PDF file required" });

    const po = await PurchaseOrder.findOne({ id: req.params.id }).lean();
    if (!po) return res.status(404).json({ success: false, message: "PO not found" });

    const pdfBuffer = req.file.buffer;

    // Upload PDF to Cloudinary (resource_type "raw" required for non-image files)
    const cloudinaryResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "IMS/pos", public_id: po.id, resource_type: "raw" },
        (error, result) => { if (error) reject(error); else resolve(result); }
      );
      stream.end(pdfBuffer);
    });
    const pdfUrl = cloudinaryResult.secure_url;

    // Upload PDF to Slack as a file (fire-and-forget — Slack sharing only)
    const fmtRs = (n) => Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const slackCaption = `📋 *New PO: ${po.id}* | Supplier: ${po.supplier || "N/A"} | ₹${fmtRs(po.totalValue)} | ${po.status}`;
    sendSlackFile(pdfBuffer, `${po.id}.pdf`, slackCaption).catch(err =>
      logger.error("[Slack] sendSlackFile failed:", err)
    );

    // Fire NEW_PO webhook to N8N with complete payload including PDF URL
    await triggerN8nWebhook("NEW_PO", {
      timestamp: new Date().toISOString(),
      poId: po.id,
      supplier: po.supplier,
      totalValue: po.totalValue,
      status: po.status,
      items: po.items,
      createdBy: po.createdBy,
      workType: po.workType,
      project: po.project,
      mrId: po.mrId,
      priority: po.priority,
      pdfUrl,
    });

    res.json({ success: true, message: "Sent to Slack successfully" });
  } catch (error) {
    logger.error("Error in pdf-slack endpoint:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Submit revision — PO creator submits corrections; directly approved, GRNs reset for Doer re-verify
router.put("/:id/submit-revision", authenticate, async (req, res) => {
  try {
    const po = await PurchaseOrder.findOne({ id: req.params.id });
    if (!po) return res.status(404).json({ success: false, message: "PO not found" });
    if (po.status !== "Pending Revision") return res.status(400).json({ success: false, message: "PO is not pending revision" });

    const {
      supplier, companyName, companyGst, companyAddress,
      vendorBankDetails, vendorContact, vendorEmail, vendorAddress,
      items, totalValue, remark,
    } = req.body;

    const timestamp = new Date().toISOString();
    // Move PO to a GRN-eligible status so AccountsPage picks it up for accounts team approval
    const updatableFields = {
      status: "Ready for Payment",
      revisionSubmittedBy: req.user?.name || "Unknown",
      revisionSubmittedAt: timestamp,
    };
    if (supplier !== undefined)           updatableFields.supplier = supplier;
    if (companyName !== undefined)        updatableFields.companyName = companyName;
    if (companyGst !== undefined)         updatableFields.companyGst = companyGst;
    if (companyAddress !== undefined)     updatableFields.companyAddress = companyAddress;
    if (vendorBankDetails !== undefined)  updatableFields.vendorBankDetails = vendorBankDetails;
    if (vendorContact !== undefined)      updatableFields.vendorContact = vendorContact;
    if (vendorEmail !== undefined)        updatableFields.vendorEmail = vendorEmail;
    if (vendorAddress !== undefined)      updatableFields.vendorAddress = vendorAddress;
    if (items !== undefined)              updatableFields.items = items;
    if (totalValue !== undefined)         updatableFields.totalValue = totalValue;
    if (remark !== undefined)             updatableFields.remark = remark;

    po.set(updatableFields);
    await po.save({ validateModifiedOnly: true });
    // GRNs stay bill_rejected — accounts team must explicitly approve via approve-revision

    logAudit(req.user, "UPDATE", "PurchaseOrder", po.id, { action: "revision_submitted" });
    broadcast({ type: "DATA_UPDATED", path: "pos" });
    res.json({ success: true, message: "Revision submitted. Accounts team will approve before Doer can re-verify." });
  } catch (error) {
    logger.error("Submit revision error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to submit revision" });
  }
});

// POST /:id/approve-revision — L2 approver approves the revised PO, resets GRNs to unpaid for Doer re-verification
router.post("/:id/approve-revision", authenticate, async (req, res) => {
  try {
    const po = await PurchaseOrder.findOne({ id: req.params.id });
    if (!po) return res.status(404).json({ success: false, message: "PO not found" });
    if (!po.revisionSubmittedAt) {
      return res.status(400).json({ success: false, message: "PO has no pending revision" });
    }

    const timestamp = new Date().toISOString();
    // Approve revision — preserve original L1/L2/L3 approval stamps; track revision approval separately
    po.set({
      status: "Approved",
      revisionApprovedBy: req.user?.name || "Unknown",
      revisionApprovedAt: timestamp,
    });
    await po.save({ validateModifiedOnly: true });

    // Reset all linked bill_rejected GRN shipments to unpaid so Doer re-verifies against revised PO
    const linkedGRNs = await GRN.find({ poId: po.id });
    for (const grn of linkedGRNs) {
      let changed = false;
      if (["bill_rejected", "mismatch_pending"].includes(grn.paymentStatus)) {
        grn.paymentStatus = "unpaid";
        grn.rejectReason = "";
        grn.rejectedBy = "";
        grn.rejectedAt = "";
        changed = true;
      }
      for (const r of (grn.receipts || [])) {
        if (["bill_rejected", "mismatch_pending"].includes(r.paymentStatus)) {
          r.paymentStatus = "unpaid";
          r.rejectReason = "";
          r.rejectedBy = "";
          r.rejectedAt = "";
          changed = true;
        }
      }
      if (changed) await grn.save({ validateModifiedOnly: true });
    }

    logAudit(req.user, "UPDATE", "PurchaseOrder", po.id, { action: "revision_approved_l2" });
    broadcast({ type: "DATA_UPDATED", path: "pos" });
    broadcast({ type: "DATA_UPDATED", path: "grns" });
    res.json({ success: true, message: "Revision approved. Doer can now re-verify the bill." });
  } catch (error) {
    logger.error("Approve revision error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to approve revision" });
  }
});

// POST /:id/reject-revision — L2 sends revised PO back to owner for another round of revisions
router.post("/:id/reject-revision", authenticate, async (req, res) => {
  try {
    const po = await PurchaseOrder.findOne({ id: req.params.id });
    if (!po) return res.status(404).json({ success: false, message: "PO not found" });
    if (!["Pending L1", "Pending L2", "Ready for Payment"].includes(po.status) || !po.revisionSubmittedAt) {
      return res.status(400).json({ success: false, message: "PO is not awaiting revision approval" });
    }

    const { reason = "" } = req.body;
    const timestamp = new Date().toISOString();
    po.set({
      status: "Pending Revision",
      approvalL2: "Pending",
      revisionSubmittedBy: undefined,
      revisionSubmittedAt: undefined,
      revisionRejectedBy: req.user?.name || "L2 Approver",
      revisionRejectedAt: timestamp,
      revisionRejectedReason: reason,
    });
    await po.save({ validateModifiedOnly: true });

    logAudit(req.user, "UPDATE", "PurchaseOrder", po.id, { action: "revision_rejected_l2", reason });
    broadcast({ type: "DATA_UPDATED", path: "pos" });
    res.json({ success: true, message: "Revision rejected. PO owner must revise again." });
  } catch (error) {
    logger.error("Reject revision error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to reject revision" });
  }
});

// Migration: link existing POs to their source quotations via linkedPoId on quotation
router.post("/migrate-quotation-links", authenticate, async (req, res) => {
  try {
    const activePOs = await PurchaseOrder.find({
      mrId: { $exists: true, $ne: "" },
      status: { $nin: ["Rejected", "Blocked", "Cancelled"] }
    }).lean();

    const allSuppliers = await Supplier.find({}).lean();
    const supplierMap = new Map(
      allSuppliers.map(s => [s.id || s._id?.toString(), (s.companyName || s.name || "").toLowerCase()])
    );

    let linked = 0;
    for (const po of activePOs) {
      // PO already has quotationId — just ensure linkedPoId is set on the quotation
      if (po.quotationId) {
        await Quotation.findOneAndUpdate(
          { id: po.quotationId },
          { linkedPoId: po.id }
        );
        continue;
      }

      // Find candidates: same MR + category + not already linked to a different PO
      const poSupplierName = supplierMap.get(po.supplier) || (po.supplier || "").toLowerCase();
      const poDeliveryDate = (po.deliveryDetails?.deliveryDate || "").split("T")[0];

      const candidates = await Quotation.find({
        mrId: po.mrId,
        $or: [
          { linkedPoId: { $exists: false } },
          { linkedPoId: "" },
          { linkedPoId: po.id } // already correctly linked
        ]
      }).lean();

      // Filter by category
      const categoryMatches = candidates.filter(q =>
        !po.workType || !q.category || q.category === po.workType
      );

      // Filter by supplier name
      const supplierMatches = categoryMatches.filter(q => {
        const qName = (q.supplierName || "").toLowerCase();
        return qName === poSupplierName || (poSupplierName && qName.includes(poSupplierName));
      });

      if (!supplierMatches.length) continue;

      // Prefer approved, then match by totalAmount (±₹2 tolerance)
      const approved = supplierMatches.filter(q => q.status === "Approved");
      const pool = approved.length ? approved : supplierMatches;
      const amountMatch = pool.filter(q => Math.abs((q.totalAmount || 0) - (po.totalValue || 0)) <= 2);
      const afterAmount = amountMatch.length ? amountMatch : pool;

      // Further narrow by delivery date if available
      const deliveryMatch = poDeliveryDate
        ? afterAmount.filter(q => (q.deliveryDate || "").split("T")[0] === poDeliveryDate)
        : [];
      const final = deliveryMatch.length ? deliveryMatch : afterAmount;

      // Pick earliest quotation ID among finalists
      final.sort((a, b) => (a.id < b.id ? -1 : 1));
      const winner = final[0];

      if (winner) {
        // Clear any incorrect previous link for this PO first
        await Quotation.updateMany({ linkedPoId: po.id, id: { $ne: winner.id } }, { $unset: { linkedPoId: "" } });
        await Quotation.findOneAndUpdate({ id: winner.id }, { linkedPoId: po.id });
        await PurchaseOrder.findOneAndUpdate({ id: po.id }, { quotationId: winner.id });
        linked++;
      }
    }

    broadcast({ type: "DATA_UPDATED", path: "quotations" });
    res.json({ success: true, message: `Migration complete. Linked ${linked} PO(s) to quotations.`, linked });
  } catch (error) {
    logger.error("Error in migrate-quotation-links:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

createCrudRoutes(router, PurchaseOrder, "pos", "id", "PURCHASE_ORDERS", "PURCHASE_ORDER");
var stdin_default = router;
export {
  stdin_default as default
};
