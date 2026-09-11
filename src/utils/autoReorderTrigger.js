import { ReorderRule, Inventory, PurchaseOrder, Settings, Supplier, Catalogue } from "../models/index.js";
import { getNextSequence } from "./sequence.js";
import { getQtyAlreadyOnOrder, hasOpenAutoReorderPO } from "./reorderCalc.js";
import { createNotification, getRolesWithPermission } from "./notification.js";
import { sendSlackApprovalMessage } from "./slack-po.js";
import { broadcast } from "./broadcaster.js";
import { logger } from "./logger.js";

// Site-specific stock: locationStock map first, then sites[].liveStock — mirrors
// transaction.routes.js's getSiteStock, adapted for .lean() plain objects (no Map methods).
function getSiteStock(inv, siteName) {
  if (siteName && inv.locationStock) {
    const fromMap = inv.locationStock instanceof Map
      ? inv.locationStock.get(siteName)
      : inv.locationStock[siteName];
    if (fromMap !== undefined) return Number(fromMap);
  }
  if (siteName) {
    const siteEntry = (inv.sites || []).find((s) => s.siteName === siteName);
    if (siteEntry) return Number(siteEntry.liveStock || 0);
  }
  return 0;
}

/**
 * Fire-and-forget entry point — call this (without awaiting) right after Outward decrements
 * Inventory stock for a batch of SKUs at a given store. Never throws; every failure is caught
 * and logged per-SKU so one bad rule can't stop the rest from being checked, and none of it can
 * affect the Outward transaction's own response.
 *
 * @param {string[]} skus
 * @param {string} [store] - the store/site the Outward was issued from. When given, the
 *   threshold check and the created PO are both scoped to that store (delivery location).
 */
export async function checkAutoReorder(skus, store) {
  try {
    const settings = await Settings.findOne({}, { autoReorder: 1 }).lean();
    if (!settings?.autoReorder?.enabled) return;

    for (const sku of [...new Set(skus)]) {
      await checkAutoReorderForSku(sku, store).catch((err) =>
        logger.error(`[AutoReorder] Failed for SKU ${sku}${store ? ` @ ${store}` : ""}:`, err.message)
      );
    }
  } catch (err) {
    logger.error("[AutoReorder] checkAutoReorder failed:", err.message);
  }
}

// Concurrent Outward requests for the same SKU+store can both pass the
// hasOpenAutoReorderPO check before either PO is committed, creating duplicates.
// Claim a short-lived, DB-atomic lock per (sku, store) first — findOneAndUpdate's
// filter only matches an unlocked/expired lock, so only one concurrent caller wins.
async function acquireReorderLock(sku, store) {
  const lockField = `_reorderLocks.${store || "_default"}`;
  const now = new Date();
  const lockExpiry = new Date(now.getTime() + 20_000); // auto-expires so a crash can't wedge it
  const claimed = await ReorderRule.findOneAndUpdate(
    {
      sku,
      isActive: true,
      $or: [{ [lockField]: { $exists: false } }, { [lockField]: { $lt: now } }],
    },
    { $set: { [lockField]: lockExpiry } },
    { new: true }
  ).lean();
  return claimed; // null if no active rule or another caller already holds the lock
}

async function releaseReorderLock(sku, store) {
  const lockField = `_reorderLocks.${store || "_default"}`;
  await ReorderRule.updateOne({ sku }, { $unset: { [lockField]: "" } }).catch(() => {});
}

async function checkAutoReorderForSku(sku, store) {
  const rule = await acquireReorderLock(sku, store);
  if (!rule) return; // no active rule, or another concurrent check already owns this sku+store

  try {
    const inv = await Inventory.findOne({ sku }, { liveStock: 1, sites: 1, locationStock: 1 }).lean();
    if (!inv) return;
    // Store-wise: check that store's own stock, not the site-wide total — a healthy total can
    // still mask one starving store. Falls back to the aggregate when no store is known (e.g. a
    // non-store-scoped manual outward).
    const currentStock = store ? getSiteStock(inv, store) : (inv.liveStock || 0);

    // Safeguard against duplicate/over-ordering — reused everywhere this decision is made,
    // scoped to the same store so stock already inbound to a different store doesn't count here.
    const qtyAlreadyOnOrder = await getQtyAlreadyOnOrder(sku, store);
    if (currentStock + qtyAlreadyOnOrder > rule.thresholdQty) return; // still above the reorder point

    if (await hasOpenAutoReorderPO(sku, store)) return; // one's already in the pipeline for this store

    await createAutoReorderPO(rule, currentStock, store);
  } finally {
    await releaseReorderLock(sku, store);
  }
}

async function createAutoReorderPO(rule, currentStock, store) {
  const [settings, supplier, catalogueItem] = await Promise.all([
    Settings.findOne({}, { companies: 1, approvers: 1, companyApprovers: 1 }).lean(),
    Supplier.findOne({ id: rule.vendor }).lean(),
    Catalogue.findOne({ sku: rule.sku }, { uom: 1, category: 1 }).lean(),
  ]);

  const company = (settings?.companies || []).find((c) => c.name === rule.companyName);
  const qty = rule.reorderQty;
  const total = qty * rule.rate;
  const totalWithGST = rule.gstType === "Exclusive" ? total * (1 + (rule.gstPct || 0) / 100) : total;

  const year = new Date().getFullYear();
  const seq = await getNextSequence("PO");
  const customId = `PO-${year}-${seq}`;

  // Same PO shape, same status default, same approval chain as a manually-created PO —
  // only `source` and the pre-filled item/vendor/rate distinguish this from a manual one.
  const po = await PurchaseOrder.create({
    id: customId,
    source: "Auto-Reorder",
    status: "Pending L1",
    supplier: rule.vendor,
    companyName: rule.companyName,
    companyGst: company?.gstin || "",
    companyAddress: company?.address || "",
    vendorContact: supplier?.mobile || "",
    vendorEmail: supplier?.email || "",
    vendorAddress: supplier?.address || "",
    project: "Inventory Reorder",
    location: store || "",
    // Delivery location = the store whose stock triggered this — so the vendor ships to
    // the right place, and so a different store's own reorder isn't blocked by this one.
    deliveryDetails: store ? { location: store } : undefined,
    items: [{
      sku: rule.sku,
      itemName: rule.itemName,
      qty,
      unit: catalogueItem?.uom || "",
      rate: rule.rate,
      gstPct: rule.gstPct || 0,
      gstType: rule.gstType || "Exclusive",
      total,
      totalWithGST,
      currentStock,
      category: catalogueItem?.category || "",
      requirementQty: qty,
    }],
    totalValue: totalWithGST,
    priority: "Normal",
    createdBy: "System (Auto-Reorder)",
    date: new Date().toISOString().split("T")[0],
  });

  broadcast({ type: "DATA_UPDATED", path: "pos" });

  // Same notification + Slack L1 approval-card path a manually-created "Pending L1" PO gets —
  // reused as-is, no separate notification logic for auto-reorder POs.
  const roles = await getRolesWithPermission("APPROVE_PURCHASE_ORDER_L1");
  await createNotification({
    message: `Auto-Reorder PO ${po.id} created for ${rule.itemName} (${rule.sku})${store ? ` @ ${store}` : ""} — requires L1 Approval`,
    severity: "warning",
    path: "pos",
    targetRoles: roles,
  });

  const companyApvCfg = (settings?.companyApprovers || []).find((ca) => ca.companyName === rule.companyName);
  const apv = companyApvCfg || settings?.approvers || {};
  const channelId = companyApvCfg?.l1SlackChannelId || settings?.approvers?.l1SlackChannelId || "";
  const dmUserId = companyApvCfg?.l1SlackId || settings?.approvers?.l1SlackId || "";
  const supplierName = supplier?.companyName || supplier?.supplierName || rule.vendor || "";

  sendSlackApprovalMessage({
    level: 1,
    poId: po.id,
    supplier: supplierName,
    companyName: po.companyName || "",
    totalValue: po.totalValue || 0,
    project: po.project || "",
    approvedBy: "System (Auto-Reorder)",
    approverName: apv.l1 || "",
    channelId,
    dmUserId,
  }).catch((err) => logger.error("[AutoReorder] Slack send failed:", err.message));

  logger.info(`[AutoReorder] Created ${po.id} for SKU ${rule.sku}${store ? ` @ ${store}` : ""} (qty ${qty})`);
}
