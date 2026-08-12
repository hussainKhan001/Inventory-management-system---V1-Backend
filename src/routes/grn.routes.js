var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
import { logger } from "../utils/logger.js";
import { Router } from "express";
import { GRN, Inward, Transaction, Inventory, PurchaseOrder, Counter } from "../models/index.js";
import { authenticate, serverHasPermission } from "../middleware/auth.middleware.js";
import { getRolesWithPermission, createNotification } from "../utils/notification.js";
import { triggerN8nWebhook, checkAndFireLowStockWebhook } from "../utils/webhook.js";
import { broadcast } from "../utils/broadcaster.js";
import { logAudit } from "../utils/audit.js";
import { getNextSequence } from "../utils/sequence.js";

// Sanitize filter to prevent MongoDB operator injection — allow only safe value types
function sanitizeFilter(raw) {
  const safe = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key.startsWith("$")) continue; // block top-level operators like $where
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      const opKeys = Object.keys(val);
      const unsafeOps = opKeys.filter(k => k.startsWith("$") && !["$in", "$nin", "$exists", "$regex", "$options"].includes(k));
      if (unsafeOps.length > 0) continue;
    }
    safe[key] = val;
  }
  return safe;
}
const router = Router();
router.get("/", authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const skip = (page - 1) * limit;
    const search = req.query.search;
    const filterStr = req.query.filter;
    let query = {};
    let parsedFilter = {};
    if (typeof filterStr === "string") {
      try {
        parsedFilter = JSON.parse(filterStr);
      } catch (e) {
      }
    } else if (filterStr && typeof filterStr === "object") {
      parsedFilter = filterStr;
    }
    const startDate = req.query.startDate || parsedFilter?.startDate;
    const endDate = req.query.endDate || parsedFilter?.endDate;
    if (startDate || endDate) {
      query.date = {};
      if (startDate) {
        query.date.$gte = startDate;
      }
      if (endDate) {
        query.date.$lte = typeof endDate === "string" && endDate.length === 10 ? `${endDate}T23:59:59.999Z` : endDate;
      }
    }
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchRegex = new RegExp(escaped, "i");
      const poExactRegex = new RegExp("^" + escaped + "$", "i");
      // Use anchored exact match when input is a full GRN ID (GRN-YYYY-NNN)
      const isFullGrnId = /^GRN-\d{4}-\d+$/i.test(search);
      const idMatcher = isFullGrnId ? poExactRegex : searchRegex;
      query.$or = [
        { id: idMatcher },
        { poId: poExactRegex },
        { mrNo: searchRegex },
        { supplier: searchRegex },
        { vendor: searchRegex },
        { project: searchRegex },
        { "items.itemName": searchRegex },
        { "items.sku": searchRegex }
      ];
    }
    if (filterStr) {
      const { startDate: _, endDate: __, ...restFilter } = parsedFilter;
      query = { ...query, ...sanitizeFilter(restFilter) };
    }
    // Always exclude merged/inactive GRNs unless admin explicitly requests them
    if (req.query.showMerged !== "1") {
      query.isActive = { $ne: false };
    }
    // slim=1 excludes photo arrays — reduces payload ~70% for list/tracker views
    const slimProjection = req.query.slim === "1" ? {
      challanPhotos: 0,
      personPhotos: 0,
      "items.images": 0,
      "receipts.challanPhotos": 0,
      "receipts.personPhotos": 0,
      "receipts.items.images": 0,
    } : {};
    const [items, total] = await Promise.all([
      GRN.find(query, slimProjection).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      GRN.countDocuments(query)
    ]);
    res.json({
      success: true,
      data: items,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    logger.error("Error fetching grn:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});
router.post("/", authenticate, async (req, res) => {
  let createdGrnId = null;
  let savedItems = [];
  let savedStore = null;
  try {
    if (!await serverHasPermission(req.user, "CREATE_GRN")) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const rawGrnData = req.body;
    // H11: Server-side enforcement — one active GRN per PO prevents duplicates
    // regardless of which client or concurrent request triggers the create.
    if (rawGrnData.poId) {
      const existingActiveGRN = await GRN.findOne({
        poId: rawGrnData.poId,
        isActive: { $ne: false },
        status: { $ne: "Merged" }
      }, { id: 1, status: 1 }).lean();
      if (existingActiveGRN) {
        return res.status(409).json({
          success: false,
          message: `An active GRN (${existingActiveGRN.id}) already exists for this PO. Add a new shipment to the existing GRN instead.`,
          existingGrnId: existingActiveGRN.id,
          action: "add_receipt"
        });
      }
    }
    const grnData = {
      ...rawGrnData,
      items: (rawGrnData.items || []).map((item) => ({
        ...item,
        itemName: item.itemName || "Unknown Item",
        unit: item.unit || "NOS"
      }))
    };
    // Always server-generate the GRN id. Sync the counter to the actual DB
    // max before incrementing so it self-heals if it ever gets out of sync.
    const year = new Date().getFullYear();
    const existing = await GRN.find({ id: { $regex: /^GRN-\d{4}-\d+$/ } }, { id: 1 }).lean();
    const maxGrnNum = existing.reduce((max, g) => {
      const n = parseInt(g.id.split("-").pop(), 10);
      return isNaN(n) ? max : Math.max(max, n);
    }, 0);
    // Also guard against orphaned Transaction docs left behind by a prior
    // renumber (their "TRX-GRN-<year>-<n>" id can collide with a fresh GRN
    // even when no live GRN currently holds that number).
    const existingTrx = await Transaction.find({ id: { $regex: /^TRX-GRN-\d{4}-\d+$/ } }, { id: 1 }).lean();
    const maxTrxNum = existingTrx.reduce((max, t) => {
      const n = parseInt(t.id.split("-").pop(), 10);
      return isNaN(n) ? max : Math.max(max, n);
    }, 0);
    const maxNum = Math.max(maxGrnNum, maxTrxNum);
    // Atomically raise the counter to at least maxNum.
    // $max only updates if maxNum is greater than the current value; upsert creates it if missing.
    await Counter.findOneAndUpdate(
      { name: "GRN" },
      { $max: { seq: maxNum } },
      { upsert: true }
    );
    const seq = await getNextSequence("GRN");
    grnData.id = `GRN-${year}-${seq}`;

    // Compute GRN status based on received qty vs PO ordered qty
    if (grnData.poId) {
      const linkedPO = await PurchaseOrder.findOne({ id: grnData.poId }, { items: 1 }).lean();
      if (linkedPO?.items?.length) {
        const grnSkus = new Map(grnData.items.map(i => [i.sku, i.received || 0]));
        let anyShort = false;
        let anyOver  = false;
        for (const poItem of linkedPO.items) {
          const received = grnSkus.get(poItem.sku) || 0;
          const ordered  = poItem.qty || 0;
          if (received < ordered) anyShort = true;
          if (received > ordered) anyOver  = true;
        }
        grnData.status = anyOver ? "Over-Received" : anyShort ? "Partial" : "Confirmed";
      }
    }

    const grn = await GRN.create([grnData]);
    createdGrnId = grn[0].id;
    const inwardRecord = {
      id: `INW-${grnData.id}`,
      date: grnData.date,
      challanNo: grnData.challan,
      mrNo: grnData.mrNo,
      supplier: grnData.supplier || grnData.vendor,
      type: "GRN",
      grnRef: grnData.id,
      project: grnData.project,
      store: grnData.store || "",
      materialPhotoUrl: grnData.materialImageUrl,
      challanPhotoUrl: grnData.challanImageUrl,
      items: grnData.items.map((item) => ({
        sku: item.sku,
        itemName: item.itemName,
        qty: item.received,
        unit: item.unit || "Unit",
        condition: item.condition
      }))
    };
    savedItems = grnData.items;
    savedStore = grnData.store || null;
    for (const item of grnData.items) {
      const qty = item.received || 0;
      const invItem = await Inventory.findOne({ sku: item.sku });
      if (invItem) {
        invItem.totalQty = (invItem.totalQty || 0) + qty;
        invItem.availableQty = (invItem.availableQty || 0) + qty;
        invItem.liveStock = (invItem.liveStock || 0) + qty;
        invItem.lastProject = grnData.project;
        if (grnData.store) {
          if (!invItem.locationStock) invItem.locationStock = new Map();
          if (!invItem.sites) invItem.sites = [];
          let curr = 0;
          if (invItem.locationStock.has(grnData.store)) {
            curr = Number(invItem.locationStock.get(grnData.store));
          } else {
            const se = invItem.sites.find(s => s.siteName === grnData.store);
            if (se) curr = Number(se.liveStock || 0);
          }
          const newQty = curr + qty;
          invItem.locationStock.set(grnData.store, newQty);
          invItem.markModified("locationStock");
          const siteEntry = invItem.sites.find(s => s.siteName === grnData.store);
          if (siteEntry) { siteEntry.liveStock = newQty; } else { invItem.sites.push({ siteName: grnData.store, siteCode: "", openingStock: 0, liveStock: newQty }); }
          invItem.markModified("sites");
        }
        await invItem.save({});
      } else {
        await Inventory.create([{
          sku: item.sku,
          itemName: item.itemName,
          category: "General",
          subCategory: "General",
          unit: item.unit || "NOS",
          openingStock: 0,
          totalQty: qty,
          availableQty: qty,
          allocatedQty: 0,
          issuedQty: 0,
          liveStock: qty,
          condition: "New",
          lastProject: grnData.project,
          locationStock: grnData.store ? { [grnData.store]: qty } : {},
          sites: grnData.store ? [{ siteName: grnData.store, siteCode: "", openingStock: 0, liveStock: qty }] : [],
        }]);
      }
    }
    await Inward.create([inwardRecord]);
    const firstItem = grnData.items[0];
    const transactionData = {
      id: `TRX-${grnData.id}`,
      type: "Inward",
      date: grnData.date,
      project: grnData.project,
      store: grnData.store || "",
      destinationProject: grnData.destinationProject,
      gatePassNo: grnData.gatePassNo,
      personName: grnData.personName,
      personPhotoUrl: grnData.personPhotoUrl,
      personPhotos: grnData.personPhotos,
      vendor: grnData.supplier || grnData.vendor,
      supplier: grnData.supplier || grnData.vendor,
      challanNo: grnData.challan,
      mrNo: grnData.mrNo,
      remarks: `From GRN: ${grnData.id}`,
      sku: firstItem?.sku || "",
      itemName: firstItem?.itemName || "",
      qty: grnData.items.reduce((sum, i) => sum + (i.received || 0), 0),
      unit: firstItem?.unit || "Unit",
      items: grnData.items.map((item) => ({
        sku: item.sku,
        itemName: item.itemName,
        qty: item.received,
        unit: item.unit || "Unit",
        images: item.images || [],
        materialPhotoUrl: item.images?.[0] || ""
      })),
      materialPhotoUrl: grnData.materialImageUrl,
      challanPhotoUrl: grnData.challanImageUrl,
      linkId: grnData.id,
      createdBy: req.user.name
    };
    await Transaction.create([transactionData]);
    if (grnData.poId) {
      const po = await PurchaseOrder.findOne({ id: grnData.poId });
      if (po) {
        const allGrns = await GRN.find({ poId: grnData.poId, status: { $ne: "Merged" }, isActive: { $ne: false } });
        let allFulfilled = true;
        let anyVariance = false;
        for (const poItem of po.items) {
          const totalReceived = allGrns.reduce((sum, g) => {
            const grnItem = g.items.find((i) => i.sku === poItem.sku);
            return sum + (grnItem?.received || 0);
          }, 0);
          if (totalReceived < (poItem.qty || 0)) {
            allFulfilled = false;
            if (totalReceived > 0) anyVariance = true;
          } else if (totalReceived > (poItem.qty || 0)) {
            anyVariance = true;
          }
        }
        const newStatus = allFulfilled ? "GRN Fulfilled" : anyVariance ? "GRN Variance" : "GRN Pending";
        if (po.status !== newStatus) {
          po.status = newStatus;
          await po.save({});
        }
        if (allFulfilled) {
          const accountRoles = await getRolesWithPermission("REVIEW_PO_BILL");
          await createNotification({
            message: `PO ${po.id} is now GRN Fulfilled. Ready for account verification and payment.`,
            severity: "info",
            path: "pos",
            senderId: req.user._id,
            targetRoles: accountRoles.length ? accountRoles : ["Accountant", "Finance Manager", "Super Admin"]
          });
        }
        await createNotification({
          message: `GRN ${grn[0].id} created. PO ${grnData.poId} status: ${newStatus}`,
          severity: allFulfilled ? "success" : "warning",
          path: "grn",
          senderId: req.user._id
        });
        await triggerN8nWebhook("PO_APPROVAL", {
          poId: grnData.poId,
          newStatus,
          grnId: grn[0].id,
          changedBy: req.user.name
        });
      }
    } else {
      await createNotification({
        message: `New GRN ${grn[0].id} created`,
        severity: "success",
        path: "grn",
        senderId: req.user._id
      });
    }
    logAudit(req.user, "CREATE", "GRN", grn[0].id, { poId: grnData.poId, supplier: grnData.supplier, project: grnData.project });
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    broadcast({ type: "DATA_UPDATED", path: "inward" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "pos" });
    await triggerN8nWebhook("GRN", {
      grnId: grn[0].id,
      poId: grnData.poId,
      vendor: grnData.supplier || grnData.vendor,
      supplier: grnData.supplier || grnData.vendor,
      project: grnData.project,
      items: grnData.items,
      createdBy: req.user.name
    });
    await checkAndFireLowStockWebhook(grnData.items.map((i) => i.sku));
    res.json({ success: true, data: grn[0] });
  } catch (error) {
    // C1: Compensate partial writes on failure
    if (createdGrnId) {
      await GRN.findOneAndDelete({ id: createdGrnId }).catch((e) => logger.error("[GRN] cleanup GRN failed:", e.message));
      // Delete by both grnRef AND id to catch orphans left by prior failed cleanups
      await Inward.deleteMany({
        $or: [{ grnRef: createdGrnId }, { id: `INW-${createdGrnId}` }]
      }).catch((e) => logger.error("[GRN] cleanup Inward failed:", e.message));
      await Transaction.deleteMany({ linkId: createdGrnId }).catch((e) => logger.error("[GRN] cleanup Transaction failed:", e.message));
    }
    // C2: Rollback inventory increments that were applied before the failure
    for (const item of savedItems) {
      const qty = item.received || 0;
      if (qty <= 0) continue;
      try {
        const invItem = await Inventory.findOne({ sku: item.sku });
        if (!invItem) continue;
        invItem.totalQty     = Math.max(0, (invItem.totalQty     || 0) - qty);
        invItem.availableQty = Math.max(0, (invItem.availableQty || 0) - qty);
        invItem.liveStock    = Math.max(0, (invItem.liveStock    || 0) - qty);
        if (savedStore && invItem.locationStock) {
          const curr = Number(invItem.locationStock.get(savedStore) || 0);
          invItem.locationStock.set(savedStore, Math.max(0, curr - qty));
          invItem.markModified("locationStock");
          const siteEntry = invItem.sites?.find(s => s.siteName === savedStore);
          if (siteEntry) siteEntry.liveStock = Math.max(0, (siteEntry.liveStock || 0) - qty);
          invItem.markModified("sites");
        }
        await invItem.save({});
      } catch (rollbackErr) {
        logger.error(`[GRN] inventory rollback failed for sku ${item.sku}:`, rollbackErr.message);
      }
    }
    res.status(400).json({ success: false, message: error.message });
  }
});
router.put("/:id", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "EDIT_GRN")) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const rawGrnData = req.body;
    const oldGRN = await GRN.findOne({ id: req.params.id });
    if (!oldGRN) throw new Error("GRN not found");
    const { _id, __v, createdAt, updatedAt, id: bodyId, ...grnData } = rawGrnData;
    const sanitizedItems = (rawGrnData.items || []).map((item) => {
      const { _id: itemId, ...itemWithoutId } = item;
      return {
        ...itemWithoutId,
        itemName: item.itemName || "Unknown Item",
        unit: item.unit || "NOS"
      };
    });
    grnData.items = sanitizedItems;
    // Recompute status from actual received vs ordered quantities
    const _hasShortage = sanitizedItems.some((it) => (it.received || 0) < (it.ordered || 0));
    const _hasExcess   = sanitizedItems.some((it) => (it.received || 0) > (it.ordered || 0));
    grnData.status = _hasShortage ? "Partial" : _hasExcess ? "Over-Received" : "Confirmed";
    // C3: Use oldStore for reversal, newStore for re-apply (prevents double-count when store changes)
    const oldStore = oldGRN.store;
    const newStore = grnData.store || oldGRN.store;
    for (const item of oldGRN.items) {
      const inv = await Inventory.findOne({ sku: item.sku });
      if (inv) {
        if (!inv.locationStock) inv.locationStock = new Map();
        if (!inv.sites) inv.sites = [];
        const qty = item.received || 0;
        inv.liveStock = Math.max(0, (inv.liveStock || 0) - qty);
        if (oldStore) {
          const curr = inv.locationStock.has(oldStore) ? Number(inv.locationStock.get(oldStore)) : (inv.sites.find(s => s.siteName === oldStore)?.liveStock || 0);
          const newQty = Math.max(0, curr - qty);
          inv.locationStock.set(oldStore, newQty);
          inv.markModified("locationStock");
          const se = inv.sites.find(s => s.siteName === oldStore);
          if (se) { se.liveStock = newQty; } else { inv.sites.push({ siteName: oldStore, siteCode: "", openingStock: 0, liveStock: newQty }); }
          inv.markModified("sites");
        }
        await inv.save({});
      }
    }
    for (const item of sanitizedItems) {
      const inv = await Inventory.findOne({ sku: item.sku });
      if (inv) {
        if (!inv.locationStock) inv.locationStock = new Map();
        if (!inv.sites) inv.sites = [];
        const qty = item.received || 0;
        inv.liveStock = (inv.liveStock || 0) + qty;
        inv.lastProject = grnData.project || oldGRN.project;
        if (newStore) {
          const curr = inv.locationStock.has(newStore) ? Number(inv.locationStock.get(newStore)) : (inv.sites.find(s => s.siteName === newStore)?.liveStock || 0);
          const newQty = curr + qty;
          inv.locationStock.set(newStore, newQty);
          inv.markModified("locationStock");
          const se = inv.sites.find(s => s.siteName === newStore);
          if (se) { se.liveStock = newQty; } else { inv.sites.push({ siteName: newStore, siteCode: "", openingStock: 0, liveStock: newQty }); }
          inv.markModified("sites");
        }
        await inv.save({});
      }
    }
    const grn = await GRN.findOneAndUpdate({ id: req.params.id }, grnData, { returnDocument: 'after' });
    await Inward.findOneAndUpdate({ grnRef: req.params.id }, {
      date: grnData.date,
      challanNo: grnData.challan,
      mrNo: grnData.mrNo,
      supplier: grnData.supplier || grnData.vendor,
      project: grnData.project,
      materialPhotoUrl: grnData.materialImageUrl,
      challanPhotoUrl: grnData.challanImageUrl,
      items: sanitizedItems.map((item) => ({
        sku: item.sku,
        itemName: item.itemName,
        qty: item.received,
        unit: item.unit,
        condition: item.condition
      }))
    });
    await Transaction.findOneAndUpdate({ linkId: req.params.id }, {
      date: grnData.date,
      project: grnData.project,
      supplier: grnData.supplier || grnData.vendor,
      items: sanitizedItems.map((item) => ({
        sku: item.sku,
        itemName: item.itemName,
        qty: item.received,
        unit: item.unit
      })),
      materialPhotoUrl: grnData.materialImageUrl,
      challanPhotoUrl: grnData.challanImageUrl
    });
    const poId = grnData.poId || oldGRN.poId;
    if (poId) {
      const po = await PurchaseOrder.findOne({ id: poId });
      if (po) {
        const allGrns = await GRN.find({ poId, status: { $ne: "Merged" }, isActive: { $ne: false } });
        const updatedGrnsList = allGrns.map((g) => g.id === req.params.id ? grn : g);
        let allFulfilled = true;
        let anyVariance = false;
        for (const poItem of po.items) {
          const totalReceived = updatedGrnsList.reduce((sum, g) => {
            const grnItem = g?.items?.find((i) => i.sku === poItem.sku);
            return sum + (grnItem?.received || 0);
          }, 0);
          if (totalReceived < (poItem.qty || 0)) {
            allFulfilled = false;
            if (totalReceived > 0) anyVariance = true;
          } else if (totalReceived > (poItem.qty || 0)) {
            anyVariance = true;
          }
        }
        const newStatus = allFulfilled ? "GRN Fulfilled" : anyVariance ? "GRN Variance" : "GRN Pending";
        if (po.status !== newStatus) {
          po.status = newStatus;
          await po.save({});
          broadcast({ type: "DATA_UPDATED", path: "pos" });
        }
      }
    }
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    broadcast({ type: "DATA_UPDATED", path: "inward" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    await triggerN8nWebhook("GRN_UPDATE", {
      grnId: req.params.id,
      poId: grnData.poId || oldGRN.poId,
      supplier: grnData.supplier || grnData.vendor,
      project: grnData.project,
      items: sanitizedItems,
      updatedBy: req.user.name
    });
    await checkAndFireLowStockWebhook(sanitizedItems.map((i) => i.sku));
    res.json({ success: true, data: grn });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.post("/:id/receipt", authenticate, async (req, res) => {
  try {
    const grn = await GRN.findOne({ id: req.params.id });
    if (!grn) return res.status(404).json({ success: false, message: "GRN not found" });
    const receipt = {
      date: new Date().toISOString(),
      challan: req.body.challan,
      mrNo: req.body.mrNo,
      docType: req.body.docType,
      personName: req.body.personName,
      challanPhotos: req.body.challanPhotos || [],
      personPhotos: req.body.personPhotos || [],
      items: (req.body.items || []).map((i) => ({
        sku: i.sku,
        itemName: i.itemName,
        received: i.received || 0,
        images: i.images || []
      }))
    };
    grn.receipts = grn.receipts || [];
    grn.receipts.push(receipt);
    // C2: Accumulate — add only the NEW receipt qty onto existing total (preserves initial received)
    const newReceiptBySKU = {};
    (receipt.items || []).forEach((item) => {
      newReceiptBySKU[item.sku] = (newReceiptBySKU[item.sku] || 0) + (item.received || 0);
    });
    grn.items = grn.items.map((item) => {
      const obj = item.toObject ? item.toObject() : { ...item };
      const addedQty = newReceiptBySKU[obj.sku] || 0;
      const totalReceived = (obj.received || 0) + addedQty;
      return { ...obj, received: totalReceived, variance: totalReceived - (obj.ordered || 0) };
    });
    const hasShortage = grn.items.some((i) => i.received < i.ordered);
    const hasExcess = grn.items.some((i) => i.received > i.ordered);
    grn.status = hasShortage ? "Partial" : hasExcess ? "Over-Received" : "Confirmed";
    // Update inventory for newly received items (site-aware)
    const store = grn.store;
    for (const item of receipt.items) {
      const qty = item.received || 0;
      const inv = await Inventory.findOne({ sku: item.sku });
      if (inv) {
        inv.totalQty = (inv.totalQty || 0) + qty;
        inv.availableQty = (inv.availableQty || 0) + qty;
        inv.liveStock = (inv.liveStock || 0) + qty;
        if (store) {
          if (!inv.locationStock) inv.locationStock = new Map();
          if (!inv.sites) inv.sites = [];
          const curr = inv.locationStock.has(store) ? Number(inv.locationStock.get(store)) : (inv.sites.find(s => s.siteName === store)?.liveStock || 0);
          const newQty = curr + qty;
          inv.locationStock.set(store, newQty);
          inv.markModified("locationStock");
          const se = inv.sites.find(s => s.siteName === store);
          if (se) { se.liveStock = newQty; } else { inv.sites.push({ siteName: store, siteCode: "", openingStock: 0, liveStock: newQty }); }
          inv.markModified("sites");
        }
        await inv.save();
      }
    }
    await grn.save();
    // H6: Update PO status by aggregating ALL active GRNs for this PO (not just current GRN status)
    if (grn.poId) {
      const po = await PurchaseOrder.findOne({ id: grn.poId });
      if (po) {
        const allGrns = await GRN.find({ poId: grn.poId, status: { $ne: "Merged" }, isActive: { $ne: false } });
        let allFulfilled = true;
        let anyVariance = false;
        for (const poItem of po.items) {
          const totalReceived = allGrns.reduce((sum, g) => {
            const grnItem = g.items.find((i) => i.sku === poItem.sku);
            return sum + (grnItem?.received || 0);
          }, 0);
          if (totalReceived < (poItem.qty || 0)) {
            allFulfilled = false;
            if (totalReceived > 0) anyVariance = true;
          } else if (totalReceived > (poItem.qty || 0)) {
            anyVariance = true;
          }
        }
        const newPoStatus = allFulfilled ? "GRN Fulfilled" : anyVariance ? "GRN Variance" : "GRN Pending";
        if (po.status !== newPoStatus) {
          po.status = newPoStatus;
          await po.save();
          broadcast({ type: "DATA_UPDATED", path: "pos" });
        }
      }
    }
    logAudit(req.user, "ADD_RECEIPT", "GRN", grn.id, { challan: receipt.challan, items: receipt.items.length });
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    res.json({ success: true, data: grn });
  } catch (error) {
    logger.error("Error adding GRN receipt:", error);
    res.status(400).json({ success: false, message: error.message });
  }
});
router.put("/:id/receipt/:idx", authenticate, async (req, res) => {
  try {
    const idx = parseInt(req.params.idx);
    const grn = await GRN.findOne({ id: req.params.id });
    if (!grn) return res.status(404).json({ success: false, message: "GRN not found" });
    if (!grn.receipts || idx < 0 || idx >= grn.receipts.length)
      return res.status(404).json({ success: false, message: "Receipt not found" });

    const oldReceipt = grn.receipts[idx];
    const oldReceiptObj = oldReceipt.toObject ? oldReceipt.toObject() : { ...oldReceipt };

    // Build delta map: newQty - oldQty per SKU (for inventory adjustment)
    const newItems = req.body.items && Array.isArray(req.body.items) ? req.body.items : null;
    const deltaMap = {}; // sku -> delta
    if (newItems) {
      (oldReceiptObj.items || []).forEach(i => { deltaMap[i.sku] = -(i.received || 0); });
      newItems.forEach(i => { deltaMap[i.sku] = (deltaMap[i.sku] || 0) + (i.received || 0); });
    }

    // Update the receipt
    grn.receipts[idx] = {
      ...oldReceiptObj,
      challan: req.body.challan ?? oldReceiptObj.challan,
      personName: req.body.personName ?? oldReceiptObj.personName,
      items: newItems
        ? newItems.map(ni => {
            const old = (oldReceiptObj.items || []).find(oi => oi.sku === ni.sku) || {};
            return { ...old, received: ni.received ?? old.received ?? 0 };
          })
        : oldReceiptObj.items,
    };
    grn.markModified("receipts");

    if (newItems) {
      // M9: Use delta to update grn.items[].received — preserves initial received from GRN creation
      grn.items = grn.items.map(item => {
        const obj = item.toObject ? item.toObject() : { ...item };
        const delta = deltaMap[obj.sku] || 0;
        const totalReceived = Math.max(0, (obj.received || 0) + delta);
        return { ...obj, received: totalReceived, variance: totalReceived - (obj.ordered || 0) };
      });
      grn.markModified("items");

      // Recalculate GRN status
      const hasShortage = grn.items.some(i => i.received < i.ordered);
      const hasExcess = grn.items.some(i => i.received > i.ordered);
      grn.status = hasShortage ? "Partial" : hasExcess ? "Over-Received" : "Confirmed";

      // Adjust inventory by delta
      const receiptStore = grn.store;
      for (const [sku, delta] of Object.entries(deltaMap)) {
        if (delta === 0) continue;
        const inv = await Inventory.findOne({ sku });
        if (inv) {
          if (!inv.locationStock) inv.locationStock = new Map();
          if (!inv.sites) inv.sites = [];
          inv.liveStock = Math.max(0, (inv.liveStock || 0) + delta);
          if (receiptStore) {
            const curr = inv.locationStock.has(receiptStore) ? Number(inv.locationStock.get(receiptStore)) : (inv.sites.find(s => s.siteName === receiptStore)?.liveStock || 0);
            const newQty = Math.max(0, curr + delta);
            inv.locationStock.set(receiptStore, newQty);
            inv.markModified("locationStock");
            const se = inv.sites.find(s => s.siteName === receiptStore);
            if (se) { se.liveStock = newQty; } else { inv.sites.push({ siteName: receiptStore, siteCode: "", openingStock: 0, liveStock: newQty }); }
            inv.markModified("sites");
          }
          await inv.save();
        }
      }

      // Update PO status by aggregating ALL active GRNs for this PO (H8 fix)
      if (grn.poId) {
        const po = await PurchaseOrder.findOne({ id: grn.poId });
        if (po) {
          const allGrns = await GRN.find({ poId: grn.poId, status: { $ne: "Merged" }, isActive: { $ne: false } });
          let allFulfilled = true;
          let anyVariance = false;
          for (const poItem of po.items) {
            const totalReceived = allGrns.reduce((sum, g) => {
              const grnItem = g.items.find((i) => i.sku === poItem.sku);
              return sum + (grnItem?.received || 0);
            }, 0);
            if (totalReceived < (poItem.qty || 0)) {
              allFulfilled = false;
              if (totalReceived > 0) anyVariance = true;
            } else if (totalReceived > (poItem.qty || 0)) {
              anyVariance = true;
            }
          }
          const newPoStatus = allFulfilled ? "GRN Fulfilled" : anyVariance ? "GRN Variance" : "GRN Pending";
          if (po.status !== newPoStatus) {
            po.status = newPoStatus;
            await po.save();
            broadcast({ type: "DATA_UPDATED", path: "pos" });
          }
        }
      }

      broadcast({ type: "DATA_UPDATED", path: "inventory" });
    }

    await grn.save();
    logAudit(req.user, "EDIT_RECEIPT", "GRN", grn.id, { receiptIdx: idx, challan: grn.receipts[idx].challan, itemsEdited: !!newItems });
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    res.json({ success: true, data: grn });
  } catch (error) {
    logger.error("Error editing GRN receipt:", error);
    res.status(400).json({ success: false, message: error.message });
  }
});
router.delete("/:id", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "DELETE_GRN")) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const grn = await GRN.findOne({ id: req.params.id });
    if (!grn) throw new Error("GRN not found");
    const poId = grn.poId;
    const grnStore = grn.store;
    // C4: Reverse both liveStock AND locationStock/sites[] when deleting GRN
    for (const item of grn.items) {
      const inv = await Inventory.findOne({ sku: item.sku });
      if (inv) {
        const qty = item.received || 0;
        if (!inv.locationStock) inv.locationStock = new Map();
        if (!inv.sites) inv.sites = [];
        inv.liveStock = Math.max(0, (inv.liveStock || 0) - qty);
        if (grnStore) {
          const curr = inv.locationStock.has(grnStore) ? Number(inv.locationStock.get(grnStore)) : (inv.sites.find(s => s.siteName === grnStore)?.liveStock || 0);
          const newQty = Math.max(0, curr - qty);
          inv.locationStock.set(grnStore, newQty);
          inv.markModified("locationStock");
          const se = inv.sites.find(s => s.siteName === grnStore);
          if (se) { se.liveStock = newQty; } else { inv.sites.push({ siteName: grnStore, siteCode: "", openingStock: 0, liveStock: newQty }); }
          inv.markModified("sites");
        }
        await inv.save({});
      }
    }
    await GRN.findOneAndDelete({ id: req.params.id });
    await Inward.deleteMany({ grnRef: req.params.id });
    await Transaction.deleteMany({ linkId: req.params.id });
    if (poId) {
      const po = await PurchaseOrder.findOne({ id: poId });
      if (po) {
        const remainingGrns = await GRN.find({ poId, status: { $ne: "Merged" }, isActive: { $ne: false } });
        let allFulfilled = true;
        let anyVariance = false;
        let hasAnyReceipt = remainingGrns.length > 0;
        for (const poItem of po.items) {
          const totalReceived = remainingGrns.reduce((sum, g) => {
            const grnItem = g.items.find((i) => i.sku === poItem.sku);
            return sum + (grnItem?.received || 0);
          }, 0);
          if (totalReceived < (poItem.qty || 0)) {
            allFulfilled = false;
            if (totalReceived > 0) anyVariance = true;
          } else if (totalReceived > (poItem.qty || 0)) {
            anyVariance = true;
          }
        }
        let newStatus = allFulfilled && hasAnyReceipt ? "GRN Fulfilled" : anyVariance ? "GRN Variance" : "GRN Pending";
        if (po.status !== newStatus) {
          po.status = newStatus;
          await po.save({});
          broadcast({ type: "DATA_UPDATED", path: "pos" });
        }
      }
    }
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    broadcast({ type: "DATA_UPDATED", path: "inward" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    await triggerN8nWebhook("GRN_DELETE", {
      grnId: req.params.id,
      poId,
      deletedBy: req.user.name,
      itemSkus: grn.items.map((i) => i.sku)
    });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
// POST /grn/:id/merge — fold one or more source GRNs into a target GRN
// Inventory quantities are NOT changed (stock already moved when original GRNs were created).
// Source GRNs are marked { status: "Merged", isActive: false, mergedInto: targetId }.
router.post("/:id/merge", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "EDIT_GRN")) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const targetId = req.params.id;
    const sourceIds = req.body.grnIds;
    if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
      return res.status(400).json({ success: false, message: "grnIds must be a non-empty array of source GRN IDs to merge" });
    }
    if (sourceIds.includes(targetId)) {
      return res.status(400).json({ success: false, message: "Target GRN cannot appear in the source list" });
    }

    const target = await GRN.findOne({ id: targetId });
    if (!target) return res.status(404).json({ success: false, message: `Target GRN ${targetId} not found` });
    if (!target.isActive || target.status === "Merged") {
      return res.status(400).json({ success: false, message: `Target GRN ${targetId} is already merged — cannot use it as a merge target` });
    }

    const sources = await GRN.find({ id: { $in: sourceIds } });
    if (sources.length !== sourceIds.length) {
      const found = new Set(sources.map(s => s.id));
      const missing = sourceIds.filter(id => !found.has(id));
      return res.status(404).json({ success: false, message: `Source GRNs not found: ${missing.join(", ")}` });
    }
    for (const src of sources) {
      if (!src.isActive || src.status === "Merged") {
        return res.status(400).json({ success: false, message: `GRN ${src.id} is already merged — cannot merge it again` });
      }
      if (target.poId && src.poId !== target.poId) {
        return res.status(400).json({ success: false, message: `GRN ${src.id} belongs to PO ${src.poId}, but target belongs to PO ${target.poId}. Cannot merge across POs.` });
      }
    }

    const mergedIds = [];
    const shipmentsAdded = [];
    target.receipts = target.receipts || [];

    for (const src of sources) {
      const srcObj = src.toObject();

      // Convert source's initial delivery (root fields) into a receipt batch on the target
      const rootItems = (srcObj.items || []).filter(i => (i.received || 0) > 0);
      if (rootItems.length > 0) {
        target.receipts.push({
          date:          srcObj.date,
          challan:       srcObj.challan,
          mrNo:          srcObj.mrNo,
          docType:       srcObj.docType,
          personName:    srcObj.personName,
          challanPhotos: srcObj.challanPhotos || [],
          personPhotos:  srcObj.personPhotos  || [],
          items: rootItems.map(i => ({ sku: i.sku, itemName: i.itemName, received: i.received || 0, images: i.images || [] })),
          paymentStatus: srcObj.paymentStatus || "unpaid",
          invoiceNo:     srcObj.invoiceNo,
          invoiceAmount: srcObj.invoiceAmount,
          verifiedBy:    srcObj.verifiedBy,
          verifiedAt:    srcObj.verifiedAt,
          verifyRemark:  srcObj.verifyRemark,
          approvedBy:    srcObj.approvedBy,
          approvedAt:    srcObj.approvedAt,
          rejectedBy:    srcObj.rejectedBy,
          rejectedAt:    srcObj.rejectedAt,
          rejectReason:  srcObj.rejectReason,
          payment:       srcObj.payment
        });
        shipmentsAdded.push({ fromGrn: src.id, type: "initial", challan: srcObj.challan });
      }

      // Bring over each of source's subsequent receipt batches as-is
      for (const r of (srcObj.receipts || [])) {
        target.receipts.push(r);
        shipmentsAdded.push({ fromGrn: src.id, type: "receipt", challan: r.challan });
      }

      // Accumulate source received qtys onto target items[] so GRN totals stay correct
      const qtyBySKU = {};
      (srcObj.items || []).forEach(i => { qtyBySKU[i.sku] = (qtyBySKU[i.sku] || 0) + (i.received || 0); });

      target.items = target.items.map(item => {
        const obj = item.toObject ? item.toObject() : { ...item };
        const added = qtyBySKU[obj.sku] || 0;
        const totalReceived = (obj.received || 0) + added;
        return { ...obj, received: totalReceived, variance: totalReceived - (obj.ordered || 0) };
      });

      // Append any SKUs from source that do not exist in target at all
      for (const [sku, qty] of Object.entries(qtyBySKU)) {
        const exists = target.items.some(i => (i.toObject ? i.toObject() : i).sku === sku);
        if (!exists) {
          const si = srcObj.items.find(i => i.sku === sku) || {};
          target.items.push({ sku, itemName: si.itemName || sku, ordered: 0, received: qty, variance: qty, unit: si.unit || "NOS", images: si.images || [] });
        }
      }

      // Mark source as merged — soft-delete preserves history
      await GRN.findOneAndUpdate({ id: src.id }, { status: "Merged", isActive: false, mergedInto: targetId });

      // Re-point Inward + Transaction records so history still links to the surviving GRN
      await Inward.updateMany({ grnRef: src.id }, { grnRef: targetId });
      await Transaction.updateMany({ linkId: src.id }, { linkId: targetId });

      mergedIds.push(src.id);
    }

    // Recalculate consolidated GRN status
    const hasShortage = target.items.some(i => { const o = i.toObject ? i.toObject() : i; return (o.received || 0) < (o.ordered || 0); });
    const hasExcess   = target.items.some(i => { const o = i.toObject ? i.toObject() : i; return (o.received || 0) > (o.ordered || 0); });
    target.status = hasShortage ? "Partial" : hasExcess ? "Over-Received" : "Confirmed";
    target.markModified("items");
    target.markModified("receipts");
    await target.save();

    logAudit(req.user, "GRN_MERGED", "GRN", targetId, {
      mergedFrom: mergedIds, poId: target.poId,
      shipmentsAdded: shipmentsAdded.length, mergedBy: req.user.name
    });
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    broadcast({ type: "DATA_UPDATED", path: "inward" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    broadcast({ type: "DATA_UPDATED", path: "pos" });

    res.json({
      success: true,
      message: `Merged ${mergedIds.length} GRN(s) into ${targetId}`,
      data: { targetGrnId: targetId, mergedGrnIds: mergedIds, shipmentsAdded: shipmentsAdded.length, newStatus: target.status }
    });
  } catch (error) {
    logger.error("Error merging GRNs:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// One-time migration: recompute status for all existing GRNs
router.post("/migrate-status", authenticate, async (req, res) => {
  try {
    const roleLower = (req.user.role || "").toLowerCase();
    if (!["super admin", "superadmin", "admin"].includes(roleLower)) {
      return res.status(403).json({ success: false, message: "Super Admin only" });
    }
    const grns = await GRN.find({ status: { $ne: "Merged" }, isActive: { $ne: false } }, { id: 1, items: 1, status: 1 }).lean();
    let updated = 0;
    for (const grn of grns) {
      const hasShortage = (grn.items || []).some((it) => (it.received || 0) < (it.ordered || 0));
      const hasExcess   = (grn.items || []).some((it) => (it.received || 0) > (it.ordered || 0));
      const newStatus   = hasShortage ? "Partial" : hasExcess ? "Over-Received" : "Confirmed";
      if (newStatus !== grn.status) {
        await GRN.updateOne({ id: grn.id }, { status: newStatus });
        updated++;
      }
    }
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    res.json({ success: true, message: `Migration complete. Updated ${updated} GRN(s).`, updated });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
// Renumber ALL GRNs from 1 ordered by createdAt (Super Admin only)
router.post("/renumber", authenticate, async (req, res) => {
  try {
    const roleLower = (req.user.role || "").toLowerCase();
    if (!["super admin", "superadmin", "admin"].includes(roleLower)) {
      return res.status(403).json({ success: false, message: "Super Admin only" });
    }
    const allGRNs = await GRN.find({}).sort({ createdAt: 1 }).lean();
    if (!allGRNs.length) return res.json({ success: true, message: "No GRNs found", updated: 0 });

    const year = new Date().getFullYear();
    let seq = 1;
    for (const grn of allGRNs) {
      const grnYear = grn.createdAt ? new Date(grn.createdAt).getFullYear() : year;
      const newId = `GRN-${grnYear}-${seq}`;
      const oldId = grn.id;
      if (oldId !== newId) {
        await GRN.updateOne({ _id: grn._id }, { id: newId });
        // Transactions reference their GRN via linkId (not grnId), and carry
        // their own "TRX-<grnId>" id — both must be renamed in lockstep or
        // the old id lingers and can collide with a future GRN reusing that number.
        await Transaction.updateMany({ linkId: oldId }, { linkId: newId, id: `TRX-${newId}` });
      }
      // Always fix Inward: find by current grnRef (oldId) and update both grnRef AND id
      const inwards = await Inward.find({ grnRef: oldId }).lean();
      for (let i = 0; i < inwards.length; i++) {
        const newInwId = i === 0 ? `INW-${newId}` : `INW-${newId}-${i + 1}`;
        await Inward.updateOne({ _id: inwards[i]._id }, { grnRef: newId, id: newInwId });
      }
      seq++;
    }
    // Reset counter so new GRNs continue from the last assigned number
    await Counter.findOneAndUpdate({ name: "GRN" }, { seq: seq - 1 }, { upsert: true });
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    broadcast({ type: "DATA_UPDATED", path: "inward" });
    res.json({ success: true, message: `Renumbered ${allGRNs.length} GRN(s) from 1 to ${seq - 1}.`, updated: allGRNs.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
// ─── Helper: compute PO payment status from ALL GRNs + ALL receipt batches ───
async function updatePOPaymentStatus(poId) {
  if (!poId) return;
  const allPOGRNs = await GRN.find({ poId, status: { $ne: "Merged" }, isActive: { $ne: false } });
  let allPaid = allPOGRNs.length > 0;
  let somePaid = false;
  let totalPaid = 0;
  const paymentHistory = [];

  for (const g of allPOGRNs) {
    // Root shipment
    if (g.paymentStatus === "paid") {
      somePaid = true;
      totalPaid += g.payment?.amount || 0;
      paymentHistory.push({ grnId: g.id, receiptIdx: null, shipmentLabel: "Shipment 1 (Initial)", amountPaid: g.payment?.amount || 0, date: g.payment?.date, mode: g.payment?.mode, utr: g.payment?.utr, ref: g.payment?.ref });
    } else {
      allPaid = false;
    }
    // Receipt batches
    for (let i = 0; i < (g.receipts || []).length; i++) {
      const r = g.receipts[i];
      if (r.paymentStatus === "paid") {
        somePaid = true;
        totalPaid += r.payment?.amount || 0;
        paymentHistory.push({ grnId: g.id, receiptIdx: i, shipmentLabel: `Shipment ${i + 2}`, amountPaid: r.payment?.amount || 0, date: r.payment?.date, mode: r.payment?.mode, utr: r.payment?.utr, ref: r.payment?.ref });
      } else {
        allPaid = false;
      }
    }
  }

  paymentHistory.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0))
                .forEach((h, i) => { h.installmentNo = i + 1; });

  const newStatus = allPaid ? "paid" : somePaid ? "partial_paid" : "bill_verify";
  await PurchaseOrder.updateOne({ id: poId }, { accountStatus: newStatus, totalPaid, paymentHistory });
  broadcast({ type: "DATA_UPDATED", path: "purchase-orders" });
}

// PUT /grns/:id/bill-verify — Accounts verifies GRN root shipment bill
router.put("/:id/bill-verify", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "VERIFY_BILL")) {
      return res.status(403).json({ success: false, message: "Unauthorized: Access to verify bills is restricted." });
    }
    const grn = await GRN.findOne({ id: req.params.id });
    if (!grn) return res.status(404).json({ success: false, message: "GRN not found" });
    if (grn.paymentStatus === "paid") return res.status(400).json({ success: false, message: "This shipment is locked — already paid" });
    const { remark, invoiceNo, invoiceAmount } = req.body;
    if (!invoiceAmount || Number(invoiceAmount) <= 0) return res.status(400).json({ success: false, message: "Invoice amount is required and must be greater than 0" });
    // Validate invoiceAmount does not exceed computed shipment value
    if (grn.poId) {
      const po = await PurchaseOrder.findOne({ id: grn.poId });
      if (po) {
        const grnValue = (grn.items || []).reduce((sum, gi) => {
          const rcv = gi.received ?? 0;
          const poItem = (po.items || []).find(pi =>
            (pi.sku && gi.sku && pi.sku === gi.sku) ||
            (pi.itemName || "").toLowerCase() === (gi.itemName || "").toLowerCase()
          );
          const rate = gi.rate || poItem?.rate || 0;
          const gstPct = gi.gstPct ?? poItem?.gstPct ?? 0;
          const gstType = gi.gstType || poItem?.gstType || "Exclusive";
          const base = rcv * rate;
          const total = gstType === "Exclusive" ? base * (1 + gstPct / 100) : base;
          return sum + total;
        }, 0);
        if (grnValue > 0 && Number(invoiceAmount) > grnValue + 0.5) {
          return res.status(400).json({ success: false, message: `Invoice amount ₹${Number(invoiceAmount).toLocaleString("en-IN")} exceeds shipment value ₹${grnValue.toLocaleString("en-IN")}` });
        }
      }
    }
    grn.paymentStatus = "bill_verified";
    grn.verifiedBy    = req.user.name;
    grn.verifiedAt    = new Date().toISOString();
    grn.invoiceAmount = Number(invoiceAmount);
    if (remark)    grn.verifyRemark = remark;
    if (invoiceNo) grn.invoiceNo    = invoiceNo;
    await grn.save();
    logAudit(req.user, "UPDATE", "GRN", grn.id, { paymentStatus: "bill_verified" });
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    res.json({ success: true });
  } catch (error) {
    logger.error("GRN bill-verify error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /grns/:id/bill-approve — Accounts approves GRN bill for payment
router.put("/:id/bill-approve", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "APPROVE_BILL")) {
      return res.status(403).json({ success: false, message: "Unauthorized: Access to approve bills is restricted." });
    }
    const grn = await GRN.findOne({ id: req.params.id });
    if (!grn) return res.status(404).json({ success: false, message: "GRN not found" });
    if (grn.paymentStatus !== "bill_verified") return res.status(400).json({ success: false, message: "GRN must be verified before approval" });
    grn.paymentStatus = "payment_pending";
    grn.approvedBy = req.user.name;
    grn.approvedAt = new Date().toISOString();
    await grn.save();
    logAudit(req.user, "UPDATE", "GRN", grn.id, { paymentStatus: "payment_pending" });
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    res.json({ success: true });
  } catch (error) {
    logger.error("GRN bill-approve error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /grns/:id/payment — Root shipment paid, updates PO status
router.put("/:id/payment", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "APPROVE_BILL")) {
      return res.status(403).json({ success: false, message: "Unauthorized: Access to record payments is restricted." });
    }
    const grn = await GRN.findOne({ id: req.params.id });
    if (!grn) return res.status(404).json({ success: false, message: "GRN not found" });
    if (grn.paymentStatus === "paid") return res.status(400).json({ success: false, message: "This shipment is locked — already paid" });
    if (grn.paymentStatus !== "payment_pending") return res.status(400).json({ success: false, message: "GRN must be approved before payment" });
    const { amountPaid, date, mode, ref, utr, chequeNo, chequeDate, screenshotUrl, bank, fromCompany, toCompany, remarks, vendorBankDetails } = req.body;
    if (!amountPaid || amountPaid <= 0) return res.status(400).json({ success: false, message: "Payment amount required" });
    if (grn.invoiceAmount && Number(amountPaid) > grn.invoiceAmount) {
      return res.status(400).json({ success: false, message: `Payment ₹${Number(amountPaid).toLocaleString("en-IN")} cannot exceed invoice amount ₹${grn.invoiceAmount.toLocaleString("en-IN")}` });
    }
    grn.paymentStatus = "paid";
    grn.payment = { amount: amountPaid, date, mode, ref, utr, chequeNo, chequeDate, screenshotUrl, bank, fromCompany, toCompany, remarks, vendorBankDetails };
    await grn.save();
    await updatePOPaymentStatus(grn.poId);
    logAudit(req.user, "UPDATE", "GRN", grn.id, { paymentStatus: "paid", amount: amountPaid });
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    res.json({ success: true });
  } catch (error) {
    logger.error("GRN payment error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PATCH /grns/:id/payment — Edit existing payment details (keeps status "paid")
router.patch("/:id/payment", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "APPROVE_BILL")) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }
    const grn = await GRN.findOne({ id: req.params.id });
    if (!grn) return res.status(404).json({ success: false, message: "GRN not found" });
    if (grn.paymentStatus !== "paid") return res.status(400).json({ success: false, message: "Shipment is not paid yet" });
    const { amountPaid, date, mode, ref, utr, chequeNo, chequeDate, screenshotUrl, bank, fromCompany, toCompany, remarks, vendorBankDetails } = req.body;
    grn.payment = { amount: amountPaid ?? grn.payment?.amount, date, mode, ref, utr, chequeNo, chequeDate, screenshotUrl, bank, fromCompany, toCompany, remarks, vendorBankDetails };
    await grn.save();
    logAudit(req.user, "UPDATE", "GRN", grn.id, { action: "payment_edited", amount: amountPaid });
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /grns/:id/payment — Revert payment back to payment_pending
router.delete("/:id/payment", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "APPROVE_BILL")) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }
    const grn = await GRN.findOne({ id: req.params.id });
    if (!grn) return res.status(404).json({ success: false, message: "GRN not found" });
    if (grn.paymentStatus !== "paid") return res.status(400).json({ success: false, message: "Shipment is not paid" });
    grn.paymentStatus = "payment_pending";
    grn.payment = undefined;
    await grn.save();
    await updatePOPaymentStatus(grn.poId);
    logAudit(req.user, "UPDATE", "GRN", grn.id, { action: "payment_reverted" });
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /grns/:id/bill-reject — Reject root shipment bill at verify stage
router.put("/:id/bill-reject", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "VERIFY_BILL")) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }
    const grn = await GRN.findOne({ id: req.params.id });
    if (!grn) return res.status(404).json({ success: false, message: "GRN not found" });
    if (grn.paymentStatus === "paid") return res.status(400).json({ success: false, message: "Cannot reject a paid shipment — it is locked" });
    const { reason } = req.body;
    grn.paymentStatus = "bill_rejected";
    grn.rejectedBy = req.user.name;
    grn.rejectedAt = new Date().toISOString();
    if (reason) grn.rejectReason = reason;
    await grn.save();
    logAudit(req.user, "UPDATE", "GRN", grn.id, { paymentStatus: "bill_rejected", reason });
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    res.json({ success: true });
  } catch (error) {
    logger.error("GRN bill-reject error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /grns/:id/receipt/:idx/bill-reject — Reject receipt-level shipment bill
router.put("/:id/receipt/:idx/bill-reject", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "VERIFY_BILL")) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }
    const grn = await GRN.findOne({ id: req.params.id });
    if (!grn) return res.status(404).json({ success: false, message: "GRN not found" });
    const idx = parseInt(req.params.idx, 10);
    const receipt = grn.receipts?.[idx];
    if (!receipt) return res.status(404).json({ success: false, message: "Receipt batch not found" });
    if (receipt.paymentStatus === "paid") return res.status(400).json({ success: false, message: "Cannot reject a paid shipment — it is locked" });
    const { reason } = req.body;
    grn.receipts[idx].paymentStatus = "bill_rejected";
    grn.receipts[idx].rejectedBy = req.user.name;
    grn.receipts[idx].rejectedAt = new Date().toISOString();
    if (reason) grn.receipts[idx].rejectReason = reason;
    grn.markModified("receipts");
    await grn.save();
    logAudit(req.user, "UPDATE", "GRN", grn.id, { action: "receipt_bill_rejected", receiptIdx: idx, reason });
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    res.json({ success: true });
  } catch (error) {
    logger.error("GRN receipt bill-reject error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /grns/:id/bill-verify-revert — Revert root shipment back to unpaid
router.put("/:id/bill-verify-revert", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "VERIFY_BILL")) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }
    const grn = await GRN.findOne({ id: req.params.id });
    if (!grn) return res.status(404).json({ success: false, message: "GRN not found" });
    if (grn.paymentStatus === "paid") return res.status(400).json({ success: false, message: "Cannot revert a paid shipment — it is locked" });
    grn.paymentStatus = "unpaid";
    grn.verifiedBy = null; grn.verifiedAt = null; grn.verifyRemark = null;
    grn.approvedBy = null; grn.approvedAt = null;
    grn.invoiceAmount = null; grn.invoiceNo = null;
    await grn.save();
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Receipt-level payment routes (:idx = index in grn.receipts[]) ────────────

// PUT /grns/:id/receipt/:idx/bill-verify
router.put("/:id/receipt/:idx/bill-verify", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "VERIFY_BILL")) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }
    const grn = await GRN.findOne({ id: req.params.id });
    if (!grn) return res.status(404).json({ success: false, message: "GRN not found" });
    const idx = parseInt(req.params.idx, 10);
    const receipt = grn.receipts?.[idx];
    if (!receipt) return res.status(404).json({ success: false, message: "Receipt batch not found" });
    if (receipt.paymentStatus === "paid") return res.status(400).json({ success: false, message: "This shipment is locked — already paid" });
    const { remark, invoiceNo, invoiceAmount } = req.body;
    if (!invoiceAmount || Number(invoiceAmount) <= 0) return res.status(400).json({ success: false, message: "Invoice amount is required and must be greater than 0" });
    // Validate invoiceAmount does not exceed computed receipt shipment value
    if (grn.poId) {
      const po = await PurchaseOrder.findOne({ id: grn.poId });
      if (po) {
        const receiptValue = (receipt.items || []).reduce((sum, ri) => {
          const rcv = ri.received ?? 0;
          const poItem = (po.items || []).find(pi =>
            (pi.sku && ri.sku && pi.sku === ri.sku) ||
            (pi.itemName || "").toLowerCase() === (ri.itemName || "").toLowerCase()
          );
          // Fall back to root GRN item rate if available
          const rootItem = (grn.items || []).find(gi =>
            (gi.sku && ri.sku && gi.sku === ri.sku) ||
            (gi.itemName || "").toLowerCase() === (ri.itemName || "").toLowerCase()
          );
          const rate = poItem?.rate || rootItem?.rate || 0;
          // Neither the receipt nor the root GRN item schema stores GST — the PO line item
          // is the only place it's tracked, same as the frontend's calculation.
          const gstPct = poItem?.gstPct ?? 0;
          const gstType = poItem?.gstType || "Exclusive";
          const base = rcv * rate;
          const total = gstType === "Exclusive" ? base * (1 + gstPct / 100) : base;
          return sum + total;
        }, 0);
        if (receiptValue > 0 && Number(invoiceAmount) > receiptValue + 0.5) {
          return res.status(400).json({ success: false, message: `Invoice amount ₹${Number(invoiceAmount).toLocaleString("en-IN")} exceeds shipment value ₹${receiptValue.toLocaleString("en-IN")}` });
        }
      }
    }
    grn.receipts[idx].paymentStatus = "bill_verified";
    grn.receipts[idx].verifiedBy    = req.user.name;
    grn.receipts[idx].verifiedAt    = new Date().toISOString();
    grn.receipts[idx].invoiceAmount = Number(invoiceAmount);
    if (remark)    grn.receipts[idx].verifyRemark = remark;
    if (invoiceNo) grn.receipts[idx].invoiceNo    = invoiceNo;
    grn.markModified("receipts");
    await grn.save();
    logAudit(req.user, "UPDATE", "GRN", grn.id, { action: "receipt_bill_verified", receiptIdx: idx });
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /grns/:id/receipt/:idx/bill-approve
router.put("/:id/receipt/:idx/bill-approve", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "APPROVE_BILL")) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }
    const grn = await GRN.findOne({ id: req.params.id });
    if (!grn) return res.status(404).json({ success: false, message: "GRN not found" });
    const idx = parseInt(req.params.idx, 10);
    const receipt = grn.receipts?.[idx];
    if (!receipt) return res.status(404).json({ success: false, message: "Receipt batch not found" });
    if (receipt.paymentStatus === "paid") return res.status(400).json({ success: false, message: "This shipment is locked — already paid" });
    if (receipt.paymentStatus !== "bill_verified") return res.status(400).json({ success: false, message: "Receipt must be verified before approval" });
    grn.receipts[idx].paymentStatus = "payment_pending";
    grn.receipts[idx].approvedBy    = req.user.name;
    grn.receipts[idx].approvedAt    = new Date().toISOString();
    grn.markModified("receipts");
    await grn.save();
    logAudit(req.user, "UPDATE", "GRN", grn.id, { action: "receipt_bill_approved", receiptIdx: idx });
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /grns/:id/receipt/:idx/payment
router.put("/:id/receipt/:idx/payment", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "APPROVE_BILL")) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }
    const grn = await GRN.findOne({ id: req.params.id });
    if (!grn) return res.status(404).json({ success: false, message: "GRN not found" });
    const idx = parseInt(req.params.idx, 10);
    const receipt = grn.receipts?.[idx];
    if (!receipt) return res.status(404).json({ success: false, message: "Receipt batch not found" });
    if (receipt.paymentStatus === "paid") return res.status(400).json({ success: false, message: "This shipment is locked — already paid" });
    if (receipt.paymentStatus !== "payment_pending") return res.status(400).json({ success: false, message: "Receipt must be approved before payment" });
    const { amountPaid, date, mode, ref, utr, chequeNo, chequeDate, screenshotUrl, bank, fromCompany, toCompany, remarks, vendorBankDetails } = req.body;
    if (!amountPaid || amountPaid <= 0) return res.status(400).json({ success: false, message: "Payment amount required" });
    if (receipt.invoiceAmount && Number(amountPaid) > receipt.invoiceAmount) {
      return res.status(400).json({ success: false, message: `Payment ₹${Number(amountPaid).toLocaleString("en-IN")} cannot exceed invoice amount ₹${receipt.invoiceAmount.toLocaleString("en-IN")}` });
    }
    grn.receipts[idx].paymentStatus = "paid";
    grn.receipts[idx].payment = { amount: amountPaid, date, mode, ref, utr, chequeNo, chequeDate, screenshotUrl, bank, fromCompany, toCompany, remarks, vendorBankDetails };
    grn.markModified("receipts");
    await grn.save();
    await updatePOPaymentStatus(grn.poId);
    logAudit(req.user, "UPDATE", "GRN", grn.id, { action: "receipt_paid", receiptIdx: idx, amount: amountPaid });
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PATCH /grns/:id/receipt/:idx/payment — Edit existing receipt payment details
router.patch("/:id/receipt/:idx/payment", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "APPROVE_BILL")) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }
    const grn = await GRN.findOne({ id: req.params.id });
    if (!grn) return res.status(404).json({ success: false, message: "GRN not found" });
    const idx = parseInt(req.params.idx, 10);
    const receipt = grn.receipts?.[idx];
    if (!receipt) return res.status(404).json({ success: false, message: "Receipt batch not found" });
    if (receipt.paymentStatus !== "paid") return res.status(400).json({ success: false, message: "Receipt is not paid yet" });
    const { amountPaid, date, mode, ref, utr, chequeNo, chequeDate, screenshotUrl, bank, fromCompany, toCompany, remarks, vendorBankDetails } = req.body;
    grn.receipts[idx].payment = { amount: amountPaid ?? receipt.payment?.amount, date, mode, ref, utr, chequeNo, chequeDate, screenshotUrl, bank, fromCompany, toCompany, remarks, vendorBankDetails };
    grn.markModified("receipts");
    await grn.save();
    logAudit(req.user, "UPDATE", "GRN", grn.id, { action: "receipt_payment_edited", receiptIdx: idx });
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /grns/:id/receipt/:idx/payment — Revert receipt payment back to payment_pending
router.delete("/:id/receipt/:idx/payment", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "APPROVE_BILL")) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }
    const grn = await GRN.findOne({ id: req.params.id });
    if (!grn) return res.status(404).json({ success: false, message: "GRN not found" });
    const idx = parseInt(req.params.idx, 10);
    const receipt = grn.receipts?.[idx];
    if (!receipt) return res.status(404).json({ success: false, message: "Receipt batch not found" });
    if (receipt.paymentStatus !== "paid") return res.status(400).json({ success: false, message: "Receipt is not paid" });
    grn.receipts[idx].paymentStatus = "payment_pending";
    grn.receipts[idx].payment = undefined;
    grn.markModified("receipts");
    await grn.save();
    await updatePOPaymentStatus(grn.poId);
    logAudit(req.user, "UPDATE", "GRN", grn.id, { action: "receipt_payment_reverted", receiptIdx: idx });
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /grns/:id/receipt/:idx/bill-verify-revert
router.put("/:id/receipt/:idx/bill-verify-revert", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "VERIFY_BILL")) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }
    const grn = await GRN.findOne({ id: req.params.id });
    if (!grn) return res.status(404).json({ success: false, message: "GRN not found" });
    const idx = parseInt(req.params.idx, 10);
    const receipt = grn.receipts?.[idx];
    if (!receipt) return res.status(404).json({ success: false, message: "Receipt batch not found" });
    if (receipt.paymentStatus === "paid") return res.status(400).json({ success: false, message: "Cannot revert a paid shipment — it is locked" });
    grn.receipts[idx].paymentStatus = "unpaid";
    grn.receipts[idx].verifiedBy    = null;
    grn.receipts[idx].verifiedAt    = null;
    grn.receipts[idx].verifyRemark  = null;
    grn.receipts[idx].approvedBy    = null;
    grn.receipts[idx].approvedAt    = null;
    grn.receipts[idx].invoiceAmount = null;
    grn.receipts[idx].invoiceNo     = null;
    grn.markModified("receipts");
    await grn.save();
    broadcast({ type: "DATA_UPDATED", path: "grn" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

var stdin_default = router;
export {
  stdin_default as default
};
