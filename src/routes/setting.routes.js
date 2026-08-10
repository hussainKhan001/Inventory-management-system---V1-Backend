import { Router } from "express";
import { Settings, Inventory, PurchaseOrder, WriteOff, Transaction, MaterialRequirement, MRAllocation, Quotation, User } from "../models/index.js";
import { authenticate } from "../middleware/auth.middleware.js";
import { broadcast } from "../utils/broadcaster.js";
import { triggerN8nWebhook } from "../utils/webhook.js";
const router = Router();
let statsCache = null;
const STATS_CACHE_TTL = 3e4;
router.get("/stats", authenticate, async (req, res) => {
  try {
    const now = Date.now();
    if (statsCache && now - statsCache.timestamp < STATS_CACHE_TTL) {
      return res.json({ success: true, data: statsCache.data, cached: true });
    }
    const [
      totalSKUs,
      totalStock,
      availableStock,
      allocatedStock,
      issuedStock,
      reusable,
      pendingPOs,
      lowStockCount,
      pendingWriteOffs,
      outOfStock,
      categoriesCount,
      stockByCategory,
      todayInward,
      todayOutward,
      mrStatusCounts,
      pendingQuotationCount,
      allPendingPOCount,
      grnPendingPOCount,
      outwardPendingCount
    ] = await Promise.all([
      Inventory.countDocuments().lean(),
      Inventory.aggregate([{ $group: { _id: null, total: { $sum: { $ifNull: ["$totalQty", { $add: ["$liveStock", "$issuedQty"] }] } } } }]).then((res2) => res2[0]?.total || 0),
      Inventory.aggregate([{ $group: { _id: null, total: { $sum: { $ifNull: ["$availableQty", { $subtract: ["$liveStock", "$allocatedQty"] }] } } } }]).then((res2) => res2[0]?.total || 0),
      Inventory.aggregate([{ $group: { _id: null, total: { $sum: { $ifNull: ["$allocatedQty", 0] } } } }]).then((res2) => res2[0]?.total || 0),
      Inventory.aggregate([{ $group: { _id: null, total: { $sum: { $ifNull: ["$issuedQty", 0] } } } }]).then((res2) => res2[0]?.total || 0),
      Inventory.countDocuments({ condition: { $in: ["Good", "Needs Repair", "GOOD", "NEEDS REPAIR"] } }).lean(),
      PurchaseOrder.aggregate([
        { $match: { status: { $in: ["Pending", "Pending L1", "Pending L2", "Pending L3"] } } },
        { $group: { _id: null, total: { $sum: "$totalValue" } } }
      ]).then((res2) => res2[0]?.total || 0),
      Inventory.aggregate([
        { $lookup: { from: "catalogues", localField: "sku", foreignField: "sku", as: "catalogue" } },
        { $unwind: { path: "$catalogue", preserveNullAndEmptyArrays: false } },
        {
          $addFields: {
            currentAvail: { $ifNull: ["$availableQty", { $subtract: ["$liveStock", { $ifNull: ["$allocatedQty", 0] }] }] }
          }
        },
        { $match: { $and: [
          { $expr: { $lte: ["$currentAvail", "$catalogue.minStock"] } },
          { $expr: { $gt: ["$currentAvail", 0] } }
        ] } },
        { $count: "count" }
      ]).then((res2) => res2[0]?.count || 0),
      WriteOff.countDocuments({ status: "Pending" }).lean(),
      Inventory.countDocuments({
        $or: [
          { availableQty: 0 },
          { $and: [{ availableQty: { $exists: false } }, { liveStock: 0 }] }
        ]
      }).lean(),
      Inventory.distinct("category").then((cats) => cats.length),
      Inventory.aggregate([
        { $group: {
          _id: "$category",
          count: { $sum: 1 },
          totalStock: { $sum: { $ifNull: ["$totalQty", "$liveStock"] } },
          availableStock: { $sum: { $ifNull: ["$availableQty", "$liveStock"] } },
          allocatedStock: { $sum: { $ifNull: ["$allocatedQty", 0] } },
          outOfStock: {
            $sum: { $cond: [{ $lte: [{ $ifNull: ["$availableQty", "$liveStock"] }, 0] }, 1, 0] }
          }
        } },
        { $sort: { count: -1 } },
        { $limit: 8 }
      ]),
      Transaction.aggregate([
        {
          $match: {
            date: (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
            type: { $in: ["Inward", "Inward Return", "Public Inward", "Public Inward Return", "Transfer Inward", "Public Transfer Inward", "GRN"] }
          }
        },
        { $unwind: "$items" },
        { $group: { _id: null, total: { $sum: "$items.qty" } } }
      ]).then((res2) => res2[0]?.total || 0),
      Transaction.aggregate([
        {
          $match: {
            date: (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
            type: { $in: ["Outward", "Outward Return", "Public Outward", "Public Outward Return", "Transfer Outward", "Public Transfer Outward"] }
          }
        },
        { $unwind: "$items" },
        { $group: { _id: null, total: { $sum: "$items.qty" } } }
      ]).then((res2) => res2[0]?.total || 0),
      MaterialRequirement.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } }
      ]).then(rows => Object.fromEntries(rows.map(r => [r._id, r.count]))),
      Quotation.countDocuments({ status: "Pending" }).lean(),
      PurchaseOrder.countDocuments({ status: { $in: ["Pending", "Pending L1", "Pending L2", "Pending L3"] } }).lean(),
      PurchaseOrder.countDocuments({ status: { $in: ["GRN Pending", "GRN Variance"] } }).lean(),
      MRAllocation.countDocuments({ $expr: { $lt: ["$issuedQty", "$allocatedQty"] } }).lean()
    ]);
    const statsData = {
      totalSKUs,
      totalStock,
      availableStock,
      allocatedStock,
      issuedStock,
      reusable,
      pendingPOs,
      lowStockCount,
      pendingWriteOffs,
      outOfStock,
      categoriesCount,
      stockByCategory,
      todayInward,
      todayOutward,
      mrStatusCounts,
      pendingQuotationCount,
      allPendingPOCount,
      grnPendingPOCount,
      outwardPendingCount
    };
    statsCache = { data: statsData, timestamp: now };
    res.json({
      success: true,
      data: statsData
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
const DEFAULT_GST_RATES = ["0%", "5%", "12%", "18%", "28%"];

async function getOrInitSettings() {
  let settings = await Settings.findOne();
  if (!settings) return Settings.create({});
  let dirty = false;
  if (!settings.gstRates?.length) { settings.gstRates = DEFAULT_GST_RATES; dirty = true; }

  // One-time migration: if sites is empty, populate it (stores first, then inventory)
  if (!settings.sites || settings.sites.length === 0) {
    if (settings.stores?.length > 0) {
      settings.sites = settings.stores.map(storeName => ({ siteName: storeName, siteCode: "" }));
      settings.markModified("sites");
      dirty = true;
    } else {
      // Discover from inventory (only runs once — after this, user manages sites manually)
      const allInv = await Inventory.find({}, { locationStock: 1, "sites.siteName": 1 }).lean();
      const discovered = new Set();
      for (const item of allInv) {
        (item.sites || []).forEach(s => s.siteName && discovered.add(s.siteName));
        const locStock = item.locationStock;
        if (locStock) {
          const keys = locStock instanceof Map ? [...locStock.keys()] : Object.keys(locStock);
          keys.forEach(k => k && discovered.add(k));
        }
      }
      if (discovered.size > 0) {
        settings.sites = [...discovered].sort().map(n => ({ siteName: n, siteCode: "" }));
        settings.markModified("sites");
        dirty = true;
      }
    }
  }

  if (dirty) await settings.save();
  return settings;
}

router.get("/public-settings", async (req, res) => {
  try {
    const settings = await getOrInitSettings();
    res.json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
router.get("/settings", authenticate, async (req, res) => {
  try {
    const settings = await getOrInitSettings();
    res.json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
// Collect all user IDs assigned to a given approver level across global + all companies
function getApproverIds(settings, level) {
  const ids = new Set();
  const gId = settings?.approvers?.[`${level}Id`];
  if (gId) ids.add(gId);
  (settings?.companyApprovers || []).forEach(ca => {
    const id = ca[`${level}Id`];
    if (id) ids.add(id);
  });
  return ids;
}

const LEVEL_PERM = {
  l1: "APPROVE_PURCHASE_ORDER_L1",
  l2: "APPROVE_PURCHASE_ORDER_L2",
  l3: "APPROVE_PURCHASE_ORDER_L3",
};

async function syncApproverPermissions(oldSettings, newBody) {
  for (const level of ["l1", "l2", "l3"]) {
    const oldIds = getApproverIds(oldSettings, level);
    // Build new effective settings by merging old with incoming body
    const newEffective = {
      approvers: newBody.approvers ?? oldSettings?.approvers,
      companyApprovers: newBody.companyApprovers ?? oldSettings?.companyApprovers,
    };
    const newIds = getApproverIds(newEffective, level);
    const perm = LEVEL_PERM[level];

    // Grant permission to newly added approvers
    for (const id of newIds) {
      if (!oldIds.has(id)) {
        await User.findByIdAndUpdate(id, { $addToSet: { permissions: perm } });
      }
    }
    // Revoke permission from removed approvers (only if not still assigned at this level)
    for (const id of oldIds) {
      if (!newIds.has(id)) {
        await User.findByIdAndUpdate(id, { $pull: { permissions: perm } });
      }
    }
  }
}

router.put("/settings", authenticate, async (req, res) => {
  try {
    const oldSettings = await Settings.findOne().lean();
    const { _id, __v, createdAt, updatedAt, ...updateBody } = req.body;
    const settings = await Settings.findOneAndUpdate({}, { $set: updateBody }, { returnDocument: 'after', upsert: true, new: true });
    // Auto-grant/revoke APPROVE_PURCHASE_ORDER_L1/L2/L3 based on approver changes
    if (req.body.approvers || req.body.companyApprovers) {
      await syncApproverPermissions(oldSettings, req.body).catch(err =>
        console.error("[Settings] syncApproverPermissions failed:", err.message)
      );
    }
    statsCache = null;
    broadcast({ type: "DATA_UPDATED", path: "settings" });
    await triggerN8nWebhook("SETTINGS", {
      updatedBy: req.user?.name || "system",
      changedFields: Object.keys(req.body)
    });
    res.json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
var stdin_default = router;
export {
  stdin_default as default
};
