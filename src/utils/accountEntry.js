var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
import { AccountEntry } from "../models/account.model.js";
import { Counter } from "../models/counter.model.js";
import { broadcast } from "./broadcaster.js";
import { logger } from "./logger.js";

// Imports go straight to the individual model files (not the models/index.js
// barrel) so this can be called from po.model.js/po.routes.js/grn.routes.js
// without risking a circular import back through the barrel.

async function nextAccountId() {
  const year = new Date().getFullYear();
  const counter = await Counter.findOneAndUpdate(
    { name: "account" },
    { $inc: { seq: 1 } },
    { returnDocument: "after", upsert: true }
  );
  return `ACC-${year}-${String(counter.seq).padStart(3, "0")}`;
}

/**
 * Creates the AccountEntry document for a PO the moment it first becomes
 * eligible for the Accounts module (GRN Fulfilled/Variance, Ready for
 * Payment, PO Closed) — mirrors the field mapping in the one-time backfill
 * script scripts/migrate-accounts.js, but runs automatically instead of
 * needing a manual migration. Idempotent: no-ops if one already exists for
 * this PO, so it's safe to call from every status-recompute call site.
 */
async function ensureAccountEntry(po) {
  if (!po?.id) return null;
  try {
    const existing = await AccountEntry.findOne({ poId: po.id }).lean();
    if (existing) return existing;

    const id = await nextAccountId();
    const doc = await AccountEntry.create({
      id,
      poId: po.id,
      project: po.project,
      supplier: po.supplier,
      accountStatus: po.accountStatus || "bill_verify",
      invoice: po.invoice || undefined,
      billApprovedBy: po.billApprovedBy,
      billApprovedAt: po.billApprovedDate,
      billRejectedBy: po.billRejectedBy,
      billRejectedAt: po.billRejectedDate,
      rejectionReason: po.rejectionReason,
      totalPaid: po.totalPaid || po.payment?.amountPaid || 0,
      poTotalValue: po.totalValue,
      paymentHistory: po.paymentHistory || [],
      payment: po.payment || undefined,
      auditTrail: po.auditTrail || [],
    });

    broadcast({ type: "account_created", data: doc });
    broadcast({ type: "DATA_UPDATED", path: "accounts" });
    return doc;
  } catch (err) {
    // Never let account-entry bookkeeping break the GRN/PO flow that triggered it.
    logger.error(`[AccountEntry] Failed to auto-create entry for PO ${po.id}:`, err.message);
    return null;
  }
}
__name(ensureAccountEntry, "ensureAccountEntry");

export { ensureAccountEntry };
