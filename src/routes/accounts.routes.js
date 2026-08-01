import { Router } from "express";
import { AccountEntry, PurchaseOrder } from "../models/index.js";
import { authenticate } from "../middleware/auth.middleware.js";
import { broadcast } from "../utils/broadcaster.js";
import { logAudit } from "../utils/audit.js";
import { getNextSequence } from "../utils/sequence.js";

const router = Router();

// ── GET /api/accounts — list enriched with PO data ───────────────────────────
router.get("/", authenticate, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const skip  = (page - 1) * limit;

    let query = {};

    if (req.query.search) {
      const re = new RegExp(req.query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [{ id: re }, { poId: re }, { supplier: re }, { project: re }];
    }
    if (req.query.status)  query.accountStatus = req.query.status;
    if (req.query.project) query.project = req.query.project;

    const [docs, total] = await Promise.all([
      AccountEntry.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AccountEntry.countDocuments(query),
    ]);

    // Join PO data: supplier name, items (for rate lookup), date, totalValue
    const poIds = [...new Set(docs.map(d => d.poId).filter(Boolean))];
    const pos = poIds.length
      ? await PurchaseOrder.find({ id: { $in: poIds } }, {
          id: 1, supplier: 1, project: 1, date: 1, totalValue: 1,
          items: 1, status: 1, companyName: 1, vendorBankDetails: 1,
          payment: 1, auditTrail: 1, paymentHistory: 1, totalPaid: 1,
          invoice: 1, grn: 1,
        }).lean()
      : [];
    const poMap = Object.fromEntries(pos.map(p => [p.id, p]));

    const enriched = docs.map(acc => {
      const po = poMap[acc.poId] || {};
      return {
        ...acc,
        // Recalculate payableAmount in case totalPaid changed
        payableAmount: Math.max(0, (acc.grnReceivedValue || 0) - (acc.totalPaid || 0)),
        // Denormalized PO fields for display
        poDate: po.date,
        poStatus: acc.poStatus || po.status,
        poTotalValue: acc.poTotalValue || po.totalValue,
        poItems: po.items || [],
        supplierRef: po.supplier,
        companyName: po.companyName,
        vendorBankDetails: po.vendorBankDetails,
        // Keep payment from Account; fallback to PO for legacy
        payment: acc.payment || po.payment,
        paymentHistory: acc.paymentHistory?.length ? acc.paymentHistory : (po.paymentHistory || []),
        totalPaid: acc.totalPaid || po.totalPaid || 0,
        invoice: acc.invoice || po.invoice,
        auditTrail: acc.auditTrail?.length ? acc.auditTrail : (po.auditTrail || []),
      };
    });

    res.json({ success: true, data: enriched, total, page, limit });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/accounts/by-po/:poId — fetch account for a specific PO ──────────
router.get("/by-po/:poId", authenticate, async (req, res) => {
  try {
    const doc = await AccountEntry.findOne({ poId: req.params.poId }).lean();
    res.json({ success: true, data: doc || null });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/accounts/:id ────────────────────────────────────────────────────
router.get("/:id", authenticate, async (req, res) => {
  try {
    const doc = await AccountEntry.findOne({ id: req.params.id }).lean();
    if (!doc) return res.status(404).json({ success: false, message: "Account not found" });
    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/accounts — create account entry (bill approved → payment_pending)
router.post("/", authenticate, async (req, res) => {
  try {
    const { poId, project, supplier, accountStatus, invoice, billApprovedBy, billApprovedAt,
            poTotalValue, auditTrail, ...rest } = req.body;

    if (!poId) return res.status(400).json({ success: false, message: "poId is required" });

    // Upsert — one Account per PO
    let existing = await AccountEntry.findOne({ poId });
    if (existing) {
      // Already exists — return it (caller can PATCH instead)
      return res.json({ success: true, data: existing, created: false });
    }

    const seq = await getNextSequence("account");
    const year = new Date().getFullYear();
    const id = `ACC-${year}-${String(seq).padStart(3, "0")}`;

    const doc = await AccountEntry.create({
      id, poId, project, supplier, accountStatus: accountStatus || "payment_pending",
      invoice, billApprovedBy, billApprovedAt, poTotalValue,
      totalPaid: 0, paymentHistory: [], auditTrail: auditTrail || [], ...rest,
    });

    // Mirror accountStatus back on PO
    await PurchaseOrder.updateOne({ id: poId }, {
      $set: { accountStatus: doc.accountStatus, billApprovedBy, billApprovedAt },
    });

    broadcast({ type: "account_created", data: doc });
    await logAudit({ action: "account.created", resourceId: doc.id, done_by: req.user?.name, details: { poId } });

    res.status(201).json({ success: true, data: doc, created: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /api/accounts/by-po/:poId — patch by PO ID ────────────────────────
router.patch("/by-po/:poId", authenticate, async (req, res) => {
  try {
    const doc = await AccountEntry.findOne({ poId: req.params.poId });
    if (!doc) return res.status(404).json({ success: false, message: "Account not found for this PO" });

    const { auditTrail: newAudit, paymentHistory: newHistory, ...fields } = req.body;

    if (Array.isArray(newHistory) && newHistory.length > 0) {
      const existingNos = new Set((doc.paymentHistory || []).map(p => p.installmentNo));
      for (const entry of newHistory) {
        if (!existingNos.has(entry.installmentNo)) {
          doc.paymentHistory.push(entry);
          existingNos.add(entry.installmentNo);
        }
      }
    }
    if (Array.isArray(newAudit) && newAudit.length > 0) {
      doc.auditTrail.push(...newAudit);
    }
    Object.assign(doc, fields);
    await doc.save();

    res.json({ success: true, data: doc.toObject() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /api/accounts/:id — partial update (payment, status change, reject) ─
router.patch("/:id", authenticate, async (req, res) => {
  try {
    const doc = await AccountEntry.findOne({ id: req.params.id });
    if (!doc) return res.status(404).json({ success: false, message: "Account not found" });

    const { auditTrail: newAudit, paymentHistory: newHistory, ...fields } = req.body;

    // Merge paymentHistory array (append new entries, don't overwrite)
    if (Array.isArray(newHistory) && newHistory.length > 0) {
      const existingNos = new Set((doc.paymentHistory || []).map(p => p.installmentNo));
      for (const entry of newHistory) {
        if (!existingNos.has(entry.installmentNo)) {
          doc.paymentHistory.push(entry);
          existingNos.add(entry.installmentNo);
        }
      }
    }

    // Append audit entries
    if (Array.isArray(newAudit) && newAudit.length > 0) {
      doc.auditTrail.push(...newAudit);
    }

    // Apply scalar fields
    Object.assign(doc, fields);
    await doc.save();

    // Mirror accountStatus + payment fields back on PO
    const poUpdate = { accountStatus: doc.accountStatus, totalPaid: doc.totalPaid };
    if (fields.billApprovedBy)  poUpdate.billApprovedBy  = fields.billApprovedBy;
    if (fields.billApprovedAt)  poUpdate.billApprovedAt  = fields.billApprovedAt;
    if (fields.billRejectedBy)  poUpdate.billRejectedBy  = fields.billRejectedBy;
    if (fields.billRejectedAt)  poUpdate.billRejectedAt  = fields.billRejectedAt;
    if (fields.rejectionReason) poUpdate.rejectionReason = fields.rejectionReason;
    if (fields.payment)         poUpdate.payment          = fields.payment;
    if (fields.paymentHistory)  poUpdate.paymentHistory   = doc.paymentHistory;
    await PurchaseOrder.updateOne({ id: doc.poId }, { $set: poUpdate });

    broadcast({ type: "account_updated", data: doc.toObject() });

    res.json({ success: true, data: doc.toObject() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/accounts/:id ─────────────────────────────────────────────────
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const doc = await AccountEntry.findOneAndDelete({ id: req.params.id });
    if (!doc) return res.status(404).json({ success: false, message: "Account not found" });

    // Revert PO accountStatus to payment_pending
    await PurchaseOrder.updateOne({ id: doc.poId }, {
      $set: { accountStatus: "payment_pending", payment: null, totalPaid: 0 },
    });

    broadcast({ type: "account_deleted", data: { id: req.params.id } });
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
