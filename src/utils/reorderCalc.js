import { PurchaseOrder, GRN } from "../models/index.js";

// A PO in any of these statuses is no longer "open" — its remaining qty (if any) doesn't count
// toward stock already on order.
const CLOSED_STATUSES = ["PO Closed", "Cancelled", "Blocked"];

/** Sum GRN.items[].received for a given PO + SKU across all active, non-merged GRNs. */
async function getReceivedQty(poId, sku) {
  const grns = await GRN.find(
    { poId, status: { $ne: "Merged" }, isActive: { $ne: false } },
    { items: 1 }
  ).lean();
  return grns.reduce((sum, g) => {
    const item = (g.items || []).find((i) => i.sku === sku);
    return sum + (item?.received || 0);
  }, 0);
}

/**
 * Total remaining (undelivered) quantity of `sku` across all open Purchase Orders —
 * auto-generated and manual/requirement-based alike. Open = status not in CLOSED_STATUSES.
 * Scope: regular PurchaseOrder only — Master PO has no working remaining-qty tracking
 * anywhere in the codebase yet, so it's intentionally excluded here.
 *
 * @param {string} sku
 * @param {string} [store] - when given, only counts POs being delivered to this store/site
 *   (deliveryDetails.location) — stock arriving at a different store doesn't cover this one.
 */
export async function getQtyAlreadyOnOrder(sku, store) {
  const filter = { "items.sku": sku, status: { $nin: CLOSED_STATUSES } };
  if (store) filter["deliveryDetails.location"] = store;

  const openPOs = await PurchaseOrder.find(filter, { id: 1, items: 1 }).lean();

  let total = 0;
  for (const po of openPOs) {
    const item = (po.items || []).find((i) => i.sku === sku);
    if (!item) continue;
    const received = await getReceivedQty(po.id, sku);
    total += Math.max(0, (item.qty || 0) - received);
  }
  return total;
}

/**
 * True if an open (non-closed/cancelled/blocked) Auto-Reorder PO already exists for this SKU.
 * @param {string} sku
 * @param {string} [store] - when given, scoped to that store's delivery location, so different
 *   stores can each have their own pending auto-PO without blocking one another.
 */
export async function hasOpenAutoReorderPO(sku, store) {
  const filter = { "items.sku": sku, source: "Auto-Reorder", status: { $nin: CLOSED_STATUSES } };
  if (store) filter["deliveryDetails.location"] = store;

  const existing = await PurchaseOrder.findOne(filter, { _id: 1 }).lean();
  return !!existing;
}
