var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
import { Router } from "express";
import mongoose from "mongoose";
import { Inward, Outward, InwardReturn, OutwardReturn, Transaction, Inventory, MRAllocation, MaterialRequirement, PurchaseOrder, GRN } from "../models/index.js";
import { authenticate, serverHasPermission } from "../middleware/auth.middleware.js";

function sanitizeFilter(raw) {
  const safe = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key.startsWith("$")) continue;
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      const unsafeOps = Object.keys(val).filter(k => k.startsWith("$") && !["$in", "$nin", "$exists", "$regex", "$options"].includes(k));
      if (unsafeOps.length > 0) continue;
    }
    safe[key] = val;
  }
  return safe;
}
import { createNotification } from "../utils/notification.js";
import { triggerN8nWebhook, checkAndFireLowStockWebhook } from "../utils/webhook.js";
import { broadcast } from "../utils/broadcaster.js";
import { createCrudRoutes } from "../utils/crud.js";
import { logAudit } from "../utils/audit.js";
import { getNextSequence } from "../utils/sequence.js";
const router = Router();

// Get site-specific stock: checks locationStock Map first, then falls back to sites[].liveStock
function getSiteStock(inv, siteName) {
  if (siteName && inv.locationStock) {
    const fromMap = inv.locationStock.get(siteName);
    if (fromMap !== undefined) return Number(fromMap);
  }
  if (siteName) {
    const siteEntry = (inv.sites || []).find(s => s.siteName === siteName);
    if (siteEntry) return Number(siteEntry.liveStock || 0);
  }
  return 0;
}
__name(getSiteStock, "getSiteStock");

// Update both locationStock and sites[] for the given site
function applyStoreDelta(inv, siteName, newQty) {
  if (!inv.locationStock) inv.locationStock = new Map();
  if (!inv.sites) inv.sites = [];
  inv.locationStock.set(siteName, newQty);
  inv.markModified("locationStock");
  const siteEntry = inv.sites.find(s => s.siteName === siteName);
  if (siteEntry) {
    siteEntry.liveStock = newQty;
  } else {
    inv.sites.push({ siteName, siteCode: "", openingStock: 0, liveStock: newQty });
  }
  inv.markModified("sites");
}
__name(applyStoreDelta, "applyStoreDelta");

// After any Transfer Inward create/edit/delete, recompute and persist status on the linked Transfer Outward
async function syncTransferOutwardStatus(gatePassNo) {
  if (!gatePassNo) return;
  const outward = await Outward.findOne({ gatePassNo, type: { $in: ["Transfer Outward", "Public Transfer Outward"] } });
  if (!outward) return;
  const inward = await Inward.findOne({ gatePassNo, type: { $in: ["Transfer Inward", "Public Transfer Inward"] } });
  if (!inward) {
    await Outward.findOneAndUpdate({ id: outward.id }, { transferStatus: "Pending", transferVariance: 0 });
    return;
  }
  const outwardQty = (outward.items || []).reduce((s, i) => s + (Number(i.qty) || 0), 0);
  const inwardQty  = (inward.items  || []).reduce((s, i) => s + (Number(i.qty) || 0), 0);
  const variance   = outwardQty - inwardQty;
  const status     = variance <= 0 ? "Fulfilled" : "Partially Complete";
  await Outward.findOneAndUpdate({ id: outward.id }, { transferStatus: status, transferVariance: variance });
}
__name(syncTransferOutwardStatus, "syncTransferOutwardStatus");

// Backfill: recompute transferStatus + transferVariance for all Transfer Outward records.
// Runs once at startup so existing records get correct status without any manual step.
async function syncAllTransferOutwardStatuses() {
  try {
    const outwards = await Outward.find({ type: { $in: ["Transfer Outward", "Public Transfer Outward"] }, gatePassNo: { $exists: true, $ne: "" } });
    for (const outward of outwards) {
      const inward = await Inward.findOne({ gatePassNo: outward.gatePassNo, type: { $in: ["Transfer Inward", "Public Transfer Inward"] } });
      let status = "Pending", variance = 0;
      if (inward) {
        const outwardQty = (outward.items || []).reduce((s, i) => s + (Number(i.qty) || 0), 0);
        const inwardQty  = (inward.items  || []).reduce((s, i) => s + (Number(i.qty) || 0), 0);
        variance = outwardQty - inwardQty;
        status   = variance <= 0 ? "Fulfilled" : "Partially Complete";
      }
      await Outward.findOneAndUpdate({ id: outward.id }, { transferStatus: status, transferVariance: variance });
    }
  } catch (err) {
    console.error("[syncAllTransferOutwardStatuses] error:", err.message);
  }
}
__name(syncAllTransferOutwardStatuses, "syncAllTransferOutwardStatuses");

// Run the backfill once after MongoDB connects
mongoose.connection.once("open", () => {
  syncAllTransferOutwardStatuses();
});

async function updateStock(type, sku, itemName, qty, unit, category, _session, store) {
  let isPositive = false;
  let isNegative = false;
  if (["Inward", "Outward Return", "Public Inward", "Public Outward Return", "Public Transfer Inward", "Transfer Inward", "GRN"].includes(type)) {
    isPositive = true;
  } else if (["Outward", "Inward Return", "Public Outward", "Public Inward Return", "Public Transfer Outward", "Transfer Outward"].includes(type)) {
    isNegative = true;
  }
  if (isPositive || isNegative) {
    const inv = await Inventory.findOne({ sku });
    if (inv) {
      if (isPositive) {
        inv.totalQty = Math.max(0, (inv.totalQty || 0) + qty);
        inv.availableQty = Math.max(0, (inv.availableQty || 0) + qty);
        if (store) {
          applyStoreDelta(inv, store, Math.max(0, getSiteStock(inv, store) + qty));
        }
      } else {
        inv.totalQty = Math.max(0, (inv.totalQty || 0) - qty);
        inv.availableQty = Math.max(0, (inv.availableQty || 0) - qty);
        if (store) {
          applyStoreDelta(inv, store, Math.max(0, getSiteStock(inv, store) - qty));
        }
      }
      inv.liveStock = Math.max(0, (inv.availableQty || 0) + (inv.allocatedQty || 0));
      await inv.save();
    } else if (isPositive) {
      await Inventory.create([{
        sku, itemName,
        category: category || "General",
        subCategory: "General",
        unit: unit || "NOS",
        openingStock: 0,
        totalQty: qty,
        availableQty: qty,
        allocatedQty: 0,
        issuedQty: 0,
        liveStock: qty,
        condition: "New",
        locationStock: store ? { [store]: qty } : {},
        sites: store ? [{ siteName: store, siteCode: "", openingStock: 0, liveStock: qty }] : [],
      }]);
    }
  }
}
__name(updateStock, "updateStock");
router.post("/inward", authenticate, async (req, res) => {
  try {
    const body = req.body;
    if (!body.items || !Array.isArray(body.items)) throw new Error("Items array required");
    const skus = body.items.map(i => i.sku);
    if (new Set(skus).size !== skus.length) throw new Error("Duplicate SKUs in items — combine quantities for the same item");
    const inwardType = body.type || "Manual";
    const inPrefix = inwardType.startsWith("Transfer") ? "TRF" : "INW";
    const inSeq = await getNextSequence(`txn-${inPrefix.toLowerCase()}`);
    const data = { ...body, id: `${inPrefix}-${new Date().getFullYear()}-${inSeq.toString().padStart(4, "0")}`, type: inwardType };
    const inward = await Inward.create(data);
    for (const item of body.items) {
      await updateStock(
        data.type === "Transfer" ? "Transfer Inward" : "Inward",
        item.sku,
        item.itemName,
        item.qty,
        item.unit,
        body.category,
        null,
        body.store
      );
    }
    await Transaction.create({
      ...data,
      type: data.type === "Transfer" ? "Transfer Inward" : (data.type === "Manual" ? "Inward" : data.type || "Inward")
    });
    // If this is a Transfer Inward, update the corresponding Transfer Outward's status
    if ((data.type || "").includes("Transfer")) {
      await syncTransferOutwardStatus(data.gatePassNo);
      broadcast({ type: "DATA_UPDATED", path: "outward" });
    }
    broadcast({ type: "DATA_UPDATED", path: "inward" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    logAudit(req.user, "CREATE", "Inward", data.id, { project: data.project, itemCount: body.items?.length });
    await createNotification({
      message: `New Inward transaction ${data.id} created by ${req.user.name}`,
      severity: "success",
      path: "inward",
      senderId: req.user._id
    });
    await triggerN8nWebhook("INWARD", { transactionId: data.id, ...data });
    await checkAndFireLowStockWebhook(body.items.map((i) => i.sku));
    res.json({ success: true, data: inward });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.put("/inward/:id", authenticate, async (req, res) => {
  try {
    const oldItem = await Inward.findOne({ id: req.params.id });
    if (!oldItem) throw new Error("Item not found");
    const newData = { ...req.body };
    delete newData._id;
    // For Transfer Inward, store = destination godown. Recompute in case frontend sent stale value.
    if ((newData.type || "").includes("Transfer") && (newData.type || "").includes("Inward") && newData.destinationProject) {
      newData.store = newData.destinationProject;
    }
    for (const item of oldItem.items) {
      await updateStock("Inward", item.sku, item.itemName, -item.qty, item.unit || "NOS", oldItem.category || "General", null, oldItem.store);
    }
    for (const item of newData.items) {
      await updateStock("Inward", item.sku, item.itemName, item.qty, item.unit || "NOS", newData.category || "General", null, newData.store);
    }
    const updated = await Inward.findOneAndUpdate({ id: req.params.id }, newData, { returnDocument: 'after' });
    await Transaction.findOneAndUpdate(
      { id: req.params.id },
      { ...newData, type: newData.type === "Transfer" ? "Transfer Inward" : newData.type || "Inward" }
    );
    // Re-sync Transfer Outward status for old and new gate pass (handles gate pass change on edit)
    if ((newData.type || "").includes("Transfer")) {
      if (oldItem.gatePassNo && oldItem.gatePassNo !== newData.gatePassNo) {
        await syncTransferOutwardStatus(oldItem.gatePassNo);
      }
      await syncTransferOutwardStatus(newData.gatePassNo);
      broadcast({ type: "DATA_UPDATED", path: "outward" });
    }
    broadcast({ type: "DATA_UPDATED", path: "inward" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    await triggerN8nWebhook("INWARD_UPDATE", {
      transactionId: req.params.id,
      updatedBy: req.user.name,
      items: newData.items,
      project: newData.project
    });
    await checkAndFireLowStockWebhook(newData.items.map((i) => i.sku));
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.delete("/inward/:id", authenticate, async (req, res) => {
  try {
    const item = await Inward.findOne({ id: req.params.id });
    if (item) {
      for (const it of item.items) {
        await updateStock("Inward", it.sku, it.itemName, -it.qty, it.unit || "NOS", item.category || "General", null, item.store);
      }
      await Inward.findOneAndDelete({ id: req.params.id });
      await Transaction.findOneAndDelete({ id: req.params.id });
      await createNotification({
        message: `Inward transaction ${req.params.id} was deleted by ${req.user.name}`,
        severity: "warning",
        path: "inward",
        senderId: req.user._id
      });
      await triggerN8nWebhook("INWARD_DELETE", {
        transactionId: req.params.id,
        deletedBy: req.user.name,
        itemSkus: item.items.map((i) => i.sku)
      });
      // If Transfer Inward deleted, reset linked Transfer Outward status to Pending
      if ((item.type || "").includes("Transfer") && item.gatePassNo) {
        await syncTransferOutwardStatus(item.gatePassNo);
        broadcast({ type: "DATA_UPDATED", path: "outward" });
      }
    }
    broadcast({ type: "DATA_UPDATED", path: "inward" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.post("/outward", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "CREATE_OUTWARD")) {
      return res.status(403).json({ success: false, message: "You do not have permission to issue materials (CREATE_OUTWARD required)." });
    }
    const body = req.body;
    if (!body.items || !Array.isArray(body.items)) throw new Error("Items array required");
    const outSkus = body.items.map(i => i.sku);
    if (new Set(outSkus).size !== outSkus.length) throw new Error("Duplicate SKUs in items — combine quantities for the same item");
    const txnType = body.type || (body.mrId ? "MR-Outward" : "Manual");
    const prefix = txnType.startsWith("Transfer") ? "TRF" : txnType === "MR-Outward" ? "MRO" : "OUT";
    const seq = await getNextSequence(`txn-${prefix.toLowerCase()}`);
    const generatedId = `${prefix}-${new Date().getFullYear()}-${seq.toString().padStart(4, "0")}`;
    const data = {
      ...body,
      id: generatedId,
      status: "Confirmed",
      type: txnType
    };
    // Pre-validate ALL items before creating any documents (prevents orphaned Outward on stock failure)
    for (const item of body.items) {
      const inv = await Inventory.findOne({ sku: item.sku });
      if (!inv) throw new Error(`Inventory item not found for SKU ${item.sku}`);
      if (body.mrId) {
        const mr = await MaterialRequirement.findOne({ id: body.mrId });
        if (!mr) throw new Error("Material Requirement not found");
        const mrItem = mr.items.find((i) => i.sku === item.sku);
        if (!mrItem) throw new Error(`Item ${item.sku} not found in MR ${body.mrId}`);
        const totalAfterThis = (mrItem.issuedQty || 0) + item.qty;
        if (totalAfterThis > mrItem.qty) {
          throw new Error(`Cannot issue ${item.qty} for ${item.itemName}. Total issued (${totalAfterThis}) would exceed requested quantity (${mrItem.qty}).`);
        }
        if (body.store && getSiteStock(inv, body.store) < item.qty) {
          throw new Error(`Insufficient stock at ${body.store} for ${item.itemName}. Available: ${getSiteStock(inv, body.store)}, Requested: ${item.qty}`);
        }
        const allocation = await MRAllocation.findOne({ mrId: body.mrId, sku: item.sku });
        const fromAllocation = allocation ? Math.min(item.qty, allocation.remainingQty || 0) : 0;
        const fromAvailable = item.qty - fromAllocation;
        if (fromAvailable > 0 && inv.availableQty < fromAvailable) {
          throw new Error(`Insufficient available stock for ${item.itemName}. Need ${fromAvailable} more, but only ${inv.availableQty} available.`);
        }
      } else {
        const storeAvail = body.store ? getSiteStock(inv, body.store) : inv.availableQty;
        if (storeAvail < item.qty) {
          const where = body.store ? ` at ${body.store}` : "";
          throw new Error(`Insufficient stock${where} for ${item.itemName}. Available: ${storeAvail}, Requested: ${item.qty}`);
        }
      }
    }
    // All validations passed — now create documents and apply stock changes
    const outward = await Outward.create([data]);
    if (body.mrId) {
      // Fetch MR once for all items so the final allClosed check sees ALL updates
      const mr = await MaterialRequirement.findOne({ id: body.mrId });
      if (!mr) throw new Error(`Material Requirement ${body.mrId} not found`);
      for (const item of body.items) {
        let allocation = await MRAllocation.findOne({ mrId: body.mrId, sku: item.sku });
        const mrItem = mr.items.find((i) => i.sku === item.sku);
        let fromAllocation = 0;
        if (allocation && allocation.remainingQty > 0) {
          fromAllocation = Math.min(item.qty, allocation.remainingQty);
        }
        if (allocation) {
          allocation.issuedQty = (allocation.issuedQty || 0) + fromAllocation;
          allocation.remainingQty = (allocation.remainingQty || 0) - fromAllocation;
          allocation.status = allocation.remainingQty === 0 ? "Closed" : "Partially Issued";
          await allocation.save({});
        }
        if (mrItem) {
          mrItem.issuedQty = (mrItem.issuedQty || 0) + item.qty;
          mrItem.status = mrItem.issuedQty >= mrItem.qty ? "Issued" : "Partial";
        }
        const inv = await Inventory.findOne({ sku: item.sku });
        inv.liveStock = Math.max(0, (inv.liveStock || 0) - item.qty);
        inv.allocatedQty = Math.max(0, (inv.allocatedQty || 0) - fromAllocation);
        inv.issuedQty = (inv.issuedQty || 0) + item.qty;
        inv.availableQty = Math.max(0, (inv.liveStock || 0) - inv.allocatedQty);
        if (body.store) {
          applyStoreDelta(inv, body.store, Math.max(0, getSiteStock(inv, body.store) - item.qty));
        }
        await inv.save({});
      }
      // After ALL items updated in memory, do ONE final status check and save
      // Use MRAllocation remaining qty: MR closes when nothing is left to issue
      // (avoids blocking on MR items that were never formally allocated/issued)
      const allItemsFulfilled = mr.items.every((i) => (i.issuedQty || 0) >= i.qty);
      const someIssued = mr.items.some((i) => (i.issuedQty || 0) > 0);
      const allFulfilled = allItemsFulfilled && someIssued;
      if (allFulfilled) {
        mr.status = "Closed";
      } else if (someIssued) {
        mr.status = "Partially Issued";
      }
      await mr.save({});
      // When MR is fully closed, lock all linked POs and their GRNs
      if (allFulfilled) {
        const now = new Date().toISOString();
        const linkedPOs = await PurchaseOrder.find({ mrId: mr.id }).select("id").lean();
        const poIds = linkedPOs.map(p => p.id);
        await PurchaseOrder.updateMany(
          { mrId: mr.id, isLocked: { $ne: true } },
          { isLocked: true, lockedAt: now, lockedReason: `MR ${mr.id} closed — all materials issued` }
        );
        if (poIds.length > 0) {
          await GRN.updateMany(
            { poId: { $in: poIds }, isLocked: { $ne: true } },
            { isLocked: true, lockedAt: now }
          );
        }
        broadcast({ type: "DATA_UPDATED", path: "pos" });
        broadcast({ type: "DATA_UPDATED", path: "grn" });
      }
    } else {
      for (const item of body.items) {
        await updateStock(
          data.type === "Transfer" ? "Transfer Outward" : "Outward",
          item.sku,
          item.itemName,
          item.qty,
          item.unit,
          body.category || "General",
          null,
          body.store
        );
      }
    }
    // H3: Map "MR-Outward" to "Outward" for Transaction (MR-Outward not in Transaction enum)
    await Transaction.create([{
      ...data,
      type: data.type === "Transfer" ? "Transfer Outward" : (data.type === "MR-Outward" ? "Outward" : data.type || "Outward")
    }]);
    logAudit(req.user, "CREATE", "Outward", data.id, { mrId: body.mrId, project: data.project, itemCount: body.items?.length });
    broadcast({ type: "DATA_UPDATED", path: "outward" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
    await createNotification({
      message: `New Outward transaction ${data.id} ${body.mrId ? `linked to MR ${body.mrId}` : ""} created by ${req.user.name}`,
      severity: "info",
      path: "outward",
      senderId: req.user._id
    });
    await triggerN8nWebhook("OUTWARD", { transactionId: data.id, ...data });
    await checkAndFireLowStockWebhook(body.items.map((i) => i.sku));
    res.json({ success: true, data: outward[0] });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.put("/outward/:id", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "EDIT_OUTWARD")) {
      return res.status(403).json({ success: false, message: "You do not have permission to edit outward transactions (EDIT_OUTWARD required)." });
    }
    const oldItem = await Outward.findOne({ id: req.params.id });
    if (!oldItem) throw new Error("Item not found");
    const data = req.body;
    // For Transfer Outward, store = source godown (project). Recompute in case frontend sent stale value.
    if ((data.type || "").includes("Transfer") && (data.type || "").includes("Outward") && data.project) {
      data.store = data.project;
    }
    const effectiveMrId = oldItem.mrId || oldItem.mrNo;
    if (effectiveMrId) {
      // MR-linked: reverse old inventory state using MR allocation fields
      for (const it of oldItem.items) {
        const inv = await Inventory.findOne({ sku: it.sku });
        if (inv) {
          let fromAllocation = 0;
          const allocations = await MRAllocation.find({ mrId: effectiveMrId, sku: it.sku });
          let remainingToReturn = it.qty;
          for (const allocation of allocations) {
            if (remainingToReturn <= 0) break;
            const fromThisAlloc = Math.min(remainingToReturn, allocation.issuedQty || 0);
            allocation.issuedQty = Math.max(0, (allocation.issuedQty || 0) - fromThisAlloc);
            allocation.remainingQty = (allocation.remainingQty || 0) + fromThisAlloc;
            allocation.status = (allocation.issuedQty || 0) === 0 ? "Allocated" : "Partially Issued";
            await allocation.save({});
            fromAllocation += fromThisAlloc;
            remainingToReturn -= fromThisAlloc;
          }
          const mr = await MaterialRequirement.findOne({ id: effectiveMrId });
          if (mr) {
            const mrItem = mr.items.find((mi) => (mi.sku || "").toLowerCase() === (it.sku || "").toLowerCase());
            if (mrItem) {
              mrItem.issuedQty = Math.max(0, (mrItem.issuedQty || 0) - it.qty);
              mrItem.allocatedQty = (mrItem.allocatedQty || 0) + fromAllocation;
              const totalFulfilled = (mrItem.issuedQty || 0) + (mrItem.allocatedQty || 0);
              if (mrItem.issuedQty >= mrItem.qty) mrItem.status = "Issued";
              else if (totalFulfilled >= mrItem.qty) mrItem.status = "Allocated";
              else if (totalFulfilled > 0) mrItem.status = "Partial";
              else mrItem.status = "In Stock";
            }
            const allIssued = mr.items.every((mi) => (mi.issuedQty || 0) >= mi.qty);
            const someIssued = mr.items.some((mi) => (mi.issuedQty || 0) > 0);
            const allAllocated = mr.items.every((mi) => (mi.issuedQty || 0) + (mi.allocatedQty || 0) >= mi.qty);
            const someAllocated = mr.items.some((mi) => (mi.issuedQty || 0) + (mi.allocatedQty || 0) > 0);
            if (allIssued) mr.status = "Closed";
            else if (someIssued) mr.status = "Partially Issued";
            else if (allAllocated) mr.status = "Allocated";
            else if (someAllocated) mr.status = "Partially Allocated";
            else mr.status = "Store Pending";
            await mr.save({});
          }
          inv.liveStock = (inv.liveStock || 0) + it.qty;
          inv.issuedQty = Math.max(0, (inv.issuedQty || 0) - it.qty);
          inv.allocatedQty = (inv.allocatedQty || 0) + fromAllocation;
          // H5: Restore locationStock/sites[] on MR-linked reversal
          if (oldItem.store) {
            applyStoreDelta(inv, oldItem.store, getSiteStock(inv, oldItem.store) + it.qty);
          }
          await inv.save({});
        }
      }
      // Apply new items using MR-linked issuance logic
      const newMrId = data.mrId || effectiveMrId;
      for (const it of data.items) {
        let allocation = await MRAllocation.findOne({ mrId: newMrId, sku: it.sku });
        const mr = await MaterialRequirement.findOne({ id: newMrId });
        if (!mr) throw new Error("Material Requirement not found");
        const mrItem = mr.items.find((i) => i.sku === it.sku);
        if (!mrItem) throw new Error(`Item ${it.sku} not found in MR ${newMrId}`);
        const totalAfterThis = (mrItem.issuedQty || 0) + it.qty;
        if (totalAfterThis > mrItem.qty) {
          throw new Error(`Cannot issue ${it.qty} for ${it.itemName}. Would exceed MR requested qty ${mrItem.qty}`);
        }
        const inv = await Inventory.findOne({ sku: it.sku });
        if (!inv) throw new Error(`Inventory not found for SKU ${it.sku}`);
        let fromAllocation = 0;
        let fromAvailable = 0;
        if (allocation && allocation.remainingQty > 0) {
          fromAllocation = Math.min(it.qty, allocation.remainingQty);
          fromAvailable = it.qty - fromAllocation;
        } else {
          fromAvailable = it.qty;
        }
        // H6: Validate store-level stock for MR-linked outward
        if (data.store && getSiteStock(inv, data.store) < it.qty) {
          throw new Error(`Insufficient stock at ${data.store} for ${it.itemName}. Available: ${getSiteStock(inv, data.store)}, Requested: ${it.qty}`);
        }
        if (fromAvailable > 0 && inv.availableQty < fromAvailable) {
          throw new Error(`Insufficient stock for ${it.itemName}. Available: ${inv.availableQty}, Needed: ${fromAvailable}`);
        }
        if (allocation) {
          allocation.issuedQty = (allocation.issuedQty || 0) + fromAllocation;
          allocation.remainingQty = (allocation.remainingQty || 0) - fromAllocation;
          allocation.status = allocation.remainingQty === 0 ? "Closed" : "Partially Issued";
          await allocation.save({});
        }
        mrItem.issuedQty = (mrItem.issuedQty || 0) + it.qty;
        mrItem.status = mrItem.issuedQty >= mrItem.qty ? "Issued" : "Partial";
        const allItemsFulfilledNow = mr.items.every((i) => (i.issuedQty || 0) >= i.qty);
        const someIssuedNow = mr.items.some((i) => (i.issuedQty || 0) > 0);
        const allFulfilledNow = allItemsFulfilledNow && someIssuedNow;
        mr.status = allFulfilledNow ? "Closed" : "Partially Issued";
        await mr.save({});
        inv.liveStock = Math.max(0, (inv.liveStock || 0) - it.qty);
        inv.allocatedQty = Math.max(0, (inv.allocatedQty || 0) - fromAllocation);
        inv.issuedQty = (inv.issuedQty || 0) + it.qty;
        // H5: Update locationStock/sites[] on MR-linked re-apply
        if (data.store) {
          applyStoreDelta(inv, data.store, Math.max(0, getSiteStock(inv, data.store) - it.qty));
        }
        await inv.save({});
      }
      // After all items re-applied, lock POs/GRNs if MR is now Closed
      const finalMr = await MaterialRequirement.findOne({ id: newMrId }).lean();
      if (finalMr && finalMr.status === "Closed") {
        const now = new Date().toISOString();
        const linkedPOs = await PurchaseOrder.find({ mrId: finalMr.id }).select("id").lean();
        const poIds = linkedPOs.map(p => p.id);
        await PurchaseOrder.updateMany(
          { mrId: finalMr.id, isLocked: { $ne: true } },
          { isLocked: true, lockedAt: now, lockedReason: `MR ${finalMr.id} closed — all materials issued` }
        );
        if (poIds.length > 0) {
          await GRN.updateMany(
            { poId: { $in: poIds }, isLocked: { $ne: true } },
            { isLocked: true, lockedAt: now }
          );
        }
        broadcast({ type: "DATA_UPDATED", path: "pos" });
        broadcast({ type: "DATA_UPDATED", path: "grn" });
      }
    } else {
      // Non-MR-linked: reverse old, check stock, apply new
      for (const it of oldItem.items) {
        await updateStock("Outward", it.sku, it.itemName, -it.qty, it.unit, oldItem.category || "General", null, oldItem.store);
      }
      for (const it of data.items) {
        const inv = await Inventory.findOne({ sku: it.sku });
        if (!inv) throw new Error(`Inventory not found for SKU ${it.sku}`);
        const storeAvail = data.store ? getSiteStock(inv, data.store) : inv.availableQty;
        if (storeAvail < it.qty) {
          const where = data.store ? ` at ${data.store}` : "";
          throw new Error(`Insufficient stock${where} for ${it.itemName}. Available: ${storeAvail}, Requested: ${it.qty}`);
        }
        await updateStock("Outward", it.sku, it.itemName, it.qty, it.unit, data.category || "General", null, data.store);
      }
    }
    const { _id: _oid, __v, ...updateData } = data;
    const historyEntry = {
      updatedBy: req.user?.name || "Unknown",
      updatedAt: new Date().toISOString(),
      changes: {
        project: oldItem.project,
        store: oldItem.store,
        personName: oldItem.personName,
        mrNo: oldItem.mrNo,
        items: oldItem.items.map(i => ({ sku: i.sku, itemName: i.itemName, qty: i.qty, unit: i.unit })),
      },
    };
    updateData.updateHistory = [...(oldItem.updateHistory || []), historyEntry];
    const item = await Outward.findOneAndUpdate({ id: req.params.id }, updateData, { returnDocument: 'after' });
    await Transaction.findOneAndUpdate({ id: req.params.id }, {
      ...updateData,
      type: updateData.type === "Transfer" ? "Transfer Outward" : updateData.type || "Outward"
    });
    broadcast({ type: "DATA_UPDATED", path: "outward" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
    broadcast({ type: "DATA_UPDATED", path: "mr-allocations" });
    await triggerN8nWebhook("OUTWARD_UPDATE", {
      transactionId: req.params.id,
      updatedBy: req.user.name,
      items: data.items,
      project: data.project
    });
    await checkAndFireLowStockWebhook(data.items.map((i) => i.sku));
    res.json({ success: true, data: item });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.delete("/outward/:id", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "DELETE_OUTWARD")) {
      return res.status(403).json({ success: false, message: "You do not have permission to delete outward transactions (DELETE_OUTWARD required)." });
    }
    const item = await Outward.findOne({ id: req.params.id });
    if (item) {
      const effectiveMrId = item.mrId || item.mrNo;
      for (const it of item.items) {
        const inv = await Inventory.findOne({ sku: it.sku });
        if (inv) {
          let fromAllocation = 0;
          if (effectiveMrId) {
            const allocations = await MRAllocation.find({ mrId: effectiveMrId, sku: it.sku });
            let remainingToReturn = it.qty;
            for (const allocation of allocations) {
              if (remainingToReturn <= 0) break;
              const fromThisAlloc = Math.min(remainingToReturn, allocation.issuedQty || 0);
              allocation.issuedQty = Math.max(0, (allocation.issuedQty || 0) - fromThisAlloc);
              allocation.remainingQty = (allocation.remainingQty || 0) + fromThisAlloc;
              allocation.status = (allocation.issuedQty || 0) === 0 ? "Allocated" : "Partially Issued";
              await allocation.save({});
              fromAllocation += fromThisAlloc;
              remainingToReturn -= fromThisAlloc;
            }
            const mr = await MaterialRequirement.findOne({ id: effectiveMrId });
            if (mr) {
              const mrItem = mr.items.find((mi) => (mi.sku || "").toLowerCase() === (it.sku || "").toLowerCase());
              if (mrItem) {
                mrItem.issuedQty = Math.max(0, (mrItem.issuedQty || 0) - it.qty);
                mrItem.allocatedQty = (mrItem.allocatedQty || 0) + fromAllocation;
                const totalFulfilled = (mrItem.issuedQty || 0) + (mrItem.allocatedQty || 0);
                if (mrItem.issuedQty >= mrItem.qty) mrItem.status = "Issued";
                else if (totalFulfilled >= mrItem.qty) mrItem.status = "Allocated";
                else if (totalFulfilled > 0) mrItem.status = "Partial";
                else mrItem.status = "In Stock";
              }
              const allIssued = mr.items.length > 0 && mr.items.every((mi) => (mi.issuedQty || 0) >= mi.qty);
              const someIssued = mr.items.some((mi) => (mi.issuedQty || 0) > 0);
              const allAllocated = mr.items.every((mi) => (mi.issuedQty || 0) + (mi.allocatedQty || 0) >= mi.qty);
              const someAllocated = mr.items.some((mi) => (mi.issuedQty || 0) + (mi.allocatedQty || 0) > 0);
              if (allIssued) mr.status = "Closed";
              else if (someIssued) mr.status = "Partially Issued";
              else if (allAllocated) mr.status = "Allocated";
              else if (someAllocated) mr.status = "Partially Allocated";
              else mr.status = "Store Pending";
              await mr.save({});
            }
          }
          inv.liveStock = (inv.liveStock || 0) + it.qty;
          if (effectiveMrId) {
            // MR-linked: reverse issuedQty and restore allocatedQty
            inv.issuedQty = Math.max(0, (inv.issuedQty || 0) - it.qty);
            inv.allocatedQty = (inv.allocatedQty || 0) + fromAllocation;
          } else {
            // Non-MR: only totalQty and availableQty were changed on creation
            inv.totalQty = (inv.totalQty || 0) + it.qty;
            inv.availableQty = (inv.availableQty || 0) + it.qty;
          }
          // Restore both locationStock AND sites[] when deleting outward
          if (item.store) {
            if (!inv.locationStock) inv.locationStock = new Map();
            if (!inv.sites) inv.sites = [];
            const curr = inv.locationStock.has(item.store) ? Number(inv.locationStock.get(item.store)) : (inv.sites.find(s => s.siteName === item.store)?.liveStock || 0);
            const newQty = curr + it.qty;
            inv.locationStock.set(item.store, newQty);
            inv.markModified("locationStock");
            const se = inv.sites.find(s => s.siteName === item.store);
            if (se) { se.liveStock = newQty; } else { inv.sites.push({ siteName: item.store, siteCode: "", openingStock: 0, liveStock: newQty }); }
            inv.markModified("sites");
          }
          await inv.save({});
        } else {
          await updateStock("Outward", it.sku, it.itemName, -it.qty, it.unit, item.category || "General", null, item.store);
        }
      }
      await Outward.findOneAndDelete({ id: req.params.id });
      await Transaction.findOneAndDelete({ id: req.params.id });
      await createNotification({
        message: `Outward transaction ${req.params.id} was deleted by ${req.user.name}`,
        severity: "warning",
        path: "outward",
        senderId: req.user._id
      });
      await triggerN8nWebhook("OUTWARD_DELETE", {
        transactionId: req.params.id,
        deletedBy: req.user.name,
        itemSkus: item.items.map((i) => i.sku)
      });
    }
    broadcast({ type: "DATA_UPDATED", path: "outward" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
    broadcast({ type: "DATA_UPDATED", path: "mr-allocations" });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.patch("/outward/:id/transfer-status", authenticate, async (req, res) => {
  try {
    const { status } = req.body;
    if (!["Pending", "Fulfilled", "Partially Complete"].includes(status)) {
      throw new Error("Invalid status");
    }
    const item = await Outward.findOneAndUpdate(
      { id: req.params.id },
      { transferStatus: status },
      { returnDocument: "after" }
    );
    if (!item) throw new Error("Transfer Outward not found");
    broadcast({ type: "DATA_UPDATED", path: "outward" });
    res.json({ success: true, data: item });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.post("/inward-returns", authenticate, async (req, res) => {
  try {
    const irSeq = await getNextSequence("txn-inr");
    const data = { ...req.body, id: `INR-${new Date().getFullYear()}-${irSeq.toString().padStart(4, "0")}` };
    if (!data.items || !Array.isArray(data.items)) throw new Error("Items array required");
    for (const it of data.items) {
      const invCheck = await Inventory.findOne({ sku: it.sku });
      if (!invCheck) throw new Error(`Item not found in inventory: ${it.sku}`);
      if (data.store) {
        const siteStock = getSiteStock(invCheck, data.store);
        if (siteStock < it.qty) throw new Error(`Insufficient stock at ${data.store} for ${it.itemName}. Available: ${siteStock}, Requested: ${it.qty}`);
      } else {
        if ((invCheck.availableQty || 0) < it.qty) throw new Error(`Insufficient stock to return for ${it.itemName}. Available: ${invCheck.availableQty || 0}, Requested: ${it.qty}`);
      }
    }
    const item = await InwardReturn.create([data]);
    for (const it of data.items) {
      await updateStock("Inward Return", it.sku, it.itemName, it.qty, it.unit, data.category || "General", null, data.store);
    }
    await Transaction.create([{ ...data, type: "Inward Return" }]);
    logAudit(req.user, "CREATE", "InwardReturn", data.id, { supplier: data.supplier, itemCount: data.items?.length });
    broadcast({ type: "DATA_UPDATED", path: "inward-returns" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    await createNotification({
      message: `New Inward Return ${data.id} created by ${req.user.name}`,
      severity: "warning",
      path: "inward-returns",
      senderId: req.user._id
    });
    await triggerN8nWebhook("INWARD_RETURN", {
      transactionId: data.id,
      createdBy: req.user.name,
      items: data.items,
      project: data.project
    });
    await checkAndFireLowStockWebhook(data.items.map((i) => i.sku));
    res.json({ success: true, data: item[0] });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.put("/inward-returns/:id", authenticate, async (req, res) => {
  try {
    const oldItem = await InwardReturn.findOne({ id: req.params.id });
    if (!oldItem) throw new Error("Item not found");
    const { _id: _oid1, __v: _v1, ...data } = req.body;
    for (const it of oldItem.items) {
      await updateStock("Inward Return", it.sku, it.itemName, -it.qty, it.unit, "General", null, oldItem.store);
    }
    for (const it of data.items) {
      await updateStock("Inward Return", it.sku, it.itemName, it.qty, it.unit, "General", null, data.store);
    }
    const item = await InwardReturn.findOneAndUpdate({ id: req.params.id }, data, { returnDocument: 'after' });
    await Transaction.findOneAndUpdate({ id: req.params.id }, { ...data, type: "Inward Return" });
    broadcast({ type: "DATA_UPDATED", path: "inward-returns" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    await triggerN8nWebhook("INWARD_RETURN_UPDATE", {
      transactionId: req.params.id,
      updatedBy: req.user.name,
      items: data.items,
      project: data.project
    });
    await checkAndFireLowStockWebhook(data.items.map((i) => i.sku));
    res.json({ success: true, data: item });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.delete("/inward-returns/:id", authenticate, async (req, res) => {
  try {
    const item = await InwardReturn.findOne({ id: req.params.id });
    if (item) {
      for (const it of item.items) {
        await updateStock("Inward Return", it.sku, it.itemName, -it.qty, it.unit, "General", null, item.store);
      }
      await InwardReturn.findOneAndDelete({ id: req.params.id });
      await Transaction.findOneAndDelete({ id: req.params.id });
      await createNotification({
        message: `Inward Return ${req.params.id} was deleted by ${req.user.name}`,
        severity: "warning",
        path: "inward-returns",
        senderId: req.user._id
      });
      await triggerN8nWebhook("INWARD_RETURN_DELETE", {
        transactionId: req.params.id,
        deletedBy: req.user.name,
        itemSkus: item.items.map((i) => i.sku)
      });
    }
    broadcast({ type: "DATA_UPDATED", path: "inward-returns" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.post("/outward-returns", authenticate, async (req, res) => {
  try {
    const orSeq = await getNextSequence("txn-our");
    const data = { ...req.body, id: `OUR-${new Date().getFullYear()}-${orSeq.toString().padStart(4, "0")}` };
    if (!data.items || !Array.isArray(data.items)) throw new Error("Items array required");
    const item = await OutwardReturn.create([data]);
    for (const it of data.items) {
      await updateStock("Outward Return", it.sku, it.itemName, it.qty, it.unit, data.category || "General", null, data.store);
    }
    await Transaction.create([{ ...data, type: "Outward Return" }]);
    logAudit(req.user, "CREATE", "OutwardReturn", data.id, { sourceSite: data.sourceSite, itemCount: data.items?.length });
    broadcast({ type: "DATA_UPDATED", path: "outward-returns" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    await createNotification({
      message: `New Outward Return ${data.id} created by ${req.user.name}`,
      severity: "info",
      path: "outward-returns",
      senderId: req.user._id
    });
    await triggerN8nWebhook("OUTWARD_RETURN", {
      transactionId: data.id,
      createdBy: req.user.name,
      items: data.items,
      project: data.project
    });
    await checkAndFireLowStockWebhook(data.items.map((i) => i.sku));
    res.json({ success: true, data: item[0] });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.put("/outward-returns/:id", authenticate, async (req, res) => {
  try {
    const oldItem = await OutwardReturn.findOne({ id: req.params.id });
    if (!oldItem) throw new Error("Item not found");
    const { _id: _oid2, __v: _v2, ...data } = req.body;
    for (const it of oldItem.items) {
      await updateStock("Outward Return", it.sku, it.itemName, -it.qty, it.unit, oldItem.category || "General", null, oldItem.store);
    }
    for (const it of data.items) {
      await updateStock("Outward Return", it.sku, it.itemName, it.qty, it.unit, data.category || "General", null, data.store);
    }
    const item = await OutwardReturn.findOneAndUpdate({ id: req.params.id }, data, { returnDocument: 'after' });
    await Transaction.findOneAndUpdate({ id: req.params.id }, { ...data, type: "Outward Return" });
    broadcast({ type: "DATA_UPDATED", path: "outward-returns" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    await triggerN8nWebhook("OUTWARD_RETURN_UPDATE", {
      transactionId: req.params.id,
      updatedBy: req.user.name,
      items: data.items,
      project: data.project
    });
    res.json({ success: true, data: item });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.delete("/outward-returns/:id", authenticate, async (req, res) => {
  try {
    const item = await OutwardReturn.findOne({ id: req.params.id });
    if (item) {
      for (const it of item.items) {
        await updateStock("Outward Return", it.sku, it.itemName, -it.qty, it.unit, "General", null, item.store);
      }
      await OutwardReturn.findOneAndDelete({ id: req.params.id });
      await Transaction.findOneAndDelete({ id: req.params.id });
      await createNotification({
        message: `Outward Return ${req.params.id} was deleted by ${req.user.name}`,
        severity: "warning",
        path: "outward-returns",
        senderId: req.user._id
      });
      await triggerN8nWebhook("OUTWARD_RETURN_DELETE", {
        transactionId: req.params.id,
        deletedBy: req.user.name,
        itemSkus: item.items.map((i) => i.sku)
      });
    }
    broadcast({ type: "DATA_UPDATED", path: "outward-returns" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
const inwardCrudRouter = Router();
createCrudRoutes(inwardCrudRouter, Inward, "inward", "id", void 0, "INWARD");
router.use("/inward", inwardCrudRouter);
const outwardCrudRouter = Router();
createCrudRoutes(outwardCrudRouter, Outward, "outward", "id", void 0, "OUTWARD");
router.use("/outward", outwardCrudRouter);
const inwardReturnCrudRouter = Router();
createCrudRoutes(inwardReturnCrudRouter, InwardReturn, "inward-returns", "id", void 0, "INWARD_RETURN");
router.use("/inward-returns", inwardReturnCrudRouter);
const outwardReturnCrudRouter = Router();
createCrudRoutes(outwardReturnCrudRouter, OutwardReturn, "outward-returns", "id", void 0, "OUTWARD_RETURN");
router.use("/outward-returns", outwardReturnCrudRouter);
// Custom DELETE for MRAllocation — reverses inventory + MR item allocatedQty
router.delete("/mr-allocations/:id", authenticate, async (req, res) => {
  try {
    const alc = await MRAllocation.findOne({ id: req.params.id });
    if (!alc) return res.status(404).json({ success: false, message: "Allocation not found" });
    if ((alc.issuedQty || 0) > 0) {
      return res.status(400).json({ success: false, message: `Cannot delete: ${alc.issuedQty} unit(s) already issued. Delete the outward transaction first.` });
    }
    const reverseQty = alc.remainingQty || alc.allocatedQty || 0;
    // Reverse inventory
    const inv = await Inventory.findOne({ sku: alc.sku });
    if (inv) {
      inv.allocatedQty = Math.max(0, (inv.allocatedQty || 0) - reverseQty);
      inv.availableQty = Math.max(0, (inv.liveStock || 0) - inv.allocatedQty);
      await inv.save({});
    }
    // Reverse MR item
    const mr = await MaterialRequirement.findOne({ id: alc.mrId });
    if (mr) {
      const mrItem = mr.items.find(i => i.sku === alc.sku);
      if (mrItem) {
        mrItem.allocatedQty = Math.max(0, (mrItem.allocatedQty || 0) - reverseQty);
        const totalFulfilled = (mrItem.issuedQty || 0) + (mrItem.allocatedQty || 0);
        if ((mrItem.issuedQty || 0) >= mrItem.qty) mrItem.status = "Issued";
        else if (totalFulfilled >= mrItem.qty) mrItem.status = "Allocated";
        else if (totalFulfilled > 0) mrItem.status = "Partial";
        else mrItem.status = "Needs Purchase";
      }
      const allAllocated = mr.items.every(i => i.status === "Allocated" || i.status === "Issued");
      const someAllocated = mr.items.some(i => (i.allocatedQty || 0) > 0);
      const someIssued = mr.items.some(i => (i.issuedQty || 0) > 0);
      if (someIssued) mr.status = "Partially Issued";
      else if (allAllocated) mr.status = "Allocated";
      else if (someAllocated) mr.status = "Partially Allocated";
      else mr.status = mr.status === "Fulfilled" || mr.status === "Partially Issued" ? "Approved by Store" : mr.status;
      await mr.save({});
    }
    await MRAllocation.findOneAndDelete({ id: req.params.id });
    broadcast({ type: "DATA_UPDATED", path: "mr-allocations" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
// Custom PUT for MRAllocation — adjust allocated qty
router.put("/mr-allocations/:id", authenticate, async (req, res) => {
  try {
    const alc = await MRAllocation.findOne({ id: req.params.id });
    if (!alc) return res.status(404).json({ success: false, message: "Allocation not found" });
    const { allocatedQty } = req.body;
    if (allocatedQty === undefined) return res.status(400).json({ success: false, message: "allocatedQty is required" });
    const newQty = Number(allocatedQty);
    const issuedQty = alc.issuedQty || 0;
    if (newQty < issuedQty) {
      return res.status(400).json({ success: false, message: `Cannot reduce below already issued qty (${issuedQty})` });
    }
    // Cap at MR item's required qty
    const mrForCheck = await MaterialRequirement.findOne({ id: alc.mrId });
    if (mrForCheck) {
      const mrItemForCheck = mrForCheck.items.find(i => i.sku === alc.sku);
      if (mrItemForCheck && newQty > mrItemForCheck.qty) {
        return res.status(400).json({ success: false, message: `Cannot allocate more than required qty (${mrItemForCheck.qty})` });
      }
    }
    const oldRemaining = alc.remainingQty || 0;
    const newRemaining = newQty - issuedQty;
    const delta = newRemaining - oldRemaining; // positive = need more from inventory, negative = return to inventory
    // Adjust inventory
    const inv = await Inventory.findOne({ sku: alc.sku });
    if (inv) {
      if (delta > 0) {
        const available = Math.max(0, (inv.liveStock || 0) - (inv.allocatedQty || 0));
        if (available < delta) return res.status(400).json({ success: false, message: `Insufficient stock. Available: ${available}, Need: ${delta}` });
      }
      inv.allocatedQty = Math.max(0, (inv.allocatedQty || 0) + delta);
      inv.availableQty = Math.max(0, (inv.liveStock || 0) - inv.allocatedQty);
      await inv.save({});
    }
    // Update MR item
    const mr = await MaterialRequirement.findOne({ id: alc.mrId });
    if (mr) {
      const mrItem = mr.items.find(i => i.sku === alc.sku);
      if (mrItem) {
        mrItem.allocatedQty = Math.max(0, (mrItem.allocatedQty || 0) + delta);
        const totalFulfilled = (mrItem.issuedQty || 0) + (mrItem.allocatedQty || 0);
        if ((mrItem.issuedQty || 0) >= mrItem.qty) mrItem.status = "Issued";
        else if (totalFulfilled >= mrItem.qty) mrItem.status = "Allocated";
        else if (totalFulfilled > 0) mrItem.status = "Partial";
        else mrItem.status = "Needs Purchase";
      }
      const allAllocated = mr.items.every(i => i.status === "Allocated" || i.status === "Issued");
      const someAllocated = mr.items.some(i => (i.allocatedQty || 0) > 0);
      const someIssued = mr.items.some(i => (i.issuedQty || 0) > 0);
      if (someIssued) mr.status = "Partially Issued";
      else if (allAllocated) mr.status = "Allocated";
      else if (someAllocated) mr.status = "Partially Allocated";
      await mr.save({});
    }
    // Update allocation record
    alc.allocatedQty = newQty;
    alc.remainingQty = newRemaining;
    alc.status = newRemaining === 0 ? "Closed" : issuedQty > 0 ? "Partially Issued" : "Allocated";
    await alc.save({});
    broadcast({ type: "DATA_UPDATED", path: "mr-allocations" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
    res.json({ success: true, data: alc });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
const mrAllocationsCrudRouter = Router();
createCrudRoutes(mrAllocationsCrudRouter, MRAllocation, "mr-allocations", "id", void 0, "MR_ALLOCATION");
router.use("/mr-allocations", mrAllocationsCrudRouter);
router.get("/transactions", authenticate, async (req, res) => {
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
      const searchRegex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [
        { id: searchRegex },
        { project: searchRegex },
        { store: searchRegex },
        { supplier: searchRegex },
        { vendor: searchRegex },
        { handoverTo: searchRegex },
        { handoverFrom: searchRegex },
        { personName: searchRegex },
        { location: searchRegex },
        { sourceSite: searchRegex },
        { destinationProject: searchRegex },
        { challanNo: searchRegex },
        { mrNo: searchRegex },
        { gatePassNo: searchRegex },
        { type: searchRegex },
        { "items.itemName": searchRegex },
        { "items.sku": searchRegex },
        { "items.mrNo": searchRegex },
        { "items.challanNo": searchRegex },
        { "items.remarks": searchRegex }
      ];
    }
    if (filterStr) {
      const { startDate: _, endDate: __, ...restFilter } = parsedFilter;
      // C6: Sanitize filter to prevent MongoDB operator injection
      query = { ...query, ...sanitizeFilter(restFilter) };
    }
    const [items, total] = await Promise.all([
      Transaction.find(query).sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments(query).lean()
    ]);
    res.json({
      success: true,
      data: items,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
router.post("/transactions", authenticate, async (req, res) => {
  try {
    const transactionData = { ...req.body };
    if (transactionData.condition && typeof transactionData.condition === "string") {
      transactionData.condition = transactionData.condition.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    }
    if (transactionData.items && Array.isArray(transactionData.items)) {
      transactionData.items = transactionData.items.map((item) => {
        if (item.condition && typeof item.condition === "string") {
          return { ...item, condition: item.condition.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) };
        }
        return item;
      });
    }
    for (const item of transactionData.items) {
      const invItem = await Inventory.findOne({ sku: item.sku });
      if (!invItem) throw new Error(`Item with SKU ${item.sku} not found in inventory`);
      let stockChange = 0;
      if (["Inward", "Public Inward", "Outward Return", "Transfer Inward"].includes(transactionData.type)) {
        stockChange = item.qty;
      } else if (["Outward", "Public Outward", "Inward Return", "Transfer Outward"].includes(transactionData.type)) {
        if (transactionData.type.includes("Outward") || transactionData.type === "Inward Return" || transactionData.type === "Transfer Outward") {
          if ((invItem.availableQty || 0) < item.qty) {
            throw new Error(`Insufficient available stock for ${invItem.itemName} (SKU: ${item.sku}). Available: ${invItem.availableQty || 0}, Requested: ${item.qty}`);
          }
        }
        stockChange = -item.qty;
      }
      invItem.liveStock = Math.max(0, invItem.liveStock + stockChange);
      if (transactionData.project) invItem.lastProject = transactionData.project;
      // H4: Also update locationStock and sites[] so per-godown stock stays in sync
      if (transactionData.store && stockChange !== 0) {
        applyStoreDelta(invItem, transactionData.store, Math.max(0, getSiteStock(invItem, transactionData.store) + stockChange));
      }
      await invItem.save({});
    }
    const txTypeRaw = transactionData.type || "Inward";
    const txPrefix = txTypeRaw.startsWith("Transfer") ? "TRF" : txTypeRaw.toLowerCase().includes("outward") ? "OUT" : "INW";
    const txSeq = await getNextSequence(`txn-${txPrefix.toLowerCase()}`);
    transactionData.id = `${txPrefix}-${new Date().getFullYear()}-${txSeq.toString().padStart(4, "0")}`;
    const transaction = await Transaction.create([transactionData]);
    logAudit(req.user, "CREATE", "Transaction", transactionData.id, { type: transactionData.type, project: transactionData.project, itemCount: transactionData.items?.length });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    const txType = (transactionData.type || "").toLowerCase();
    if (txType.includes("inward") && !txType.includes("return")) {
      await triggerN8nWebhook("INWARD", { transactionId: transactionData.id, ...transactionData });
    } else if (txType.includes("outward") && !txType.includes("return")) {
      await triggerN8nWebhook("OUTWARD", { transactionId: transactionData.id, ...transactionData });
    } else if (txType.includes("return")) {
      const evt = txType.includes("inward") ? "INWARD_RETURN" : "OUTWARD_RETURN";
      await triggerN8nWebhook(evt, { transactionId: transactionData.id, ...transactionData });
    }
    await checkAndFireLowStockWebhook(transactionData.items.map((i) => i.sku));
    res.json({ success: true, data: transaction[0] });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.delete("/transactions/:id", authenticate, async (req, res) => {
  try {
    const tx = await Transaction.findOne({ id: req.params.id });
    if (!tx) throw new Error("Transaction not found");
    const isOutward = ["Outward", "Transfer Outward", "MR-Outward", "Public Outward", "Public Transfer Outward"].includes(tx.type) || tx.id.startsWith("OUT") || tx.id.startsWith("MRO") || tx.type.toLowerCase().includes("outward");
    if (isOutward) {
      for (const it of tx.items || []) {
        if (!it.sku) continue;
        let fromAllocationTotal = 0;
        const effectiveMrId = tx.mrId || tx.mrNo;
        if (effectiveMrId) {
          const allocations = await MRAllocation.find({ mrId: effectiveMrId, sku: it.sku });
          let remainingToReturn = it.qty;
          for (const allocation of allocations) {
            if (remainingToReturn <= 0) break;
            const fromThisAlloc = Math.min(remainingToReturn, allocation.issuedQty || 0);
            allocation.issuedQty = Math.max(0, (allocation.issuedQty || 0) - fromThisAlloc);
            allocation.remainingQty = (allocation.remainingQty || 0) + fromThisAlloc;
            allocation.status = (allocation.issuedQty || 0) === 0 ? "Allocated" : "Partially Issued";
            await allocation.save({});
            fromAllocationTotal += fromThisAlloc;
            remainingToReturn -= fromThisAlloc;
          }
          const mr = await MaterialRequirement.findOne({ id: effectiveMrId });
          if (mr) {
            const mrItem = mr.items.find((mi) => (mi.sku || "").toLowerCase() === (it.sku || "").toLowerCase());
            if (mrItem) {
              mrItem.issuedQty = Math.max(0, (mrItem.issuedQty || 0) - it.qty);
              mrItem.allocatedQty = (mrItem.allocatedQty || 0) + fromAllocationTotal;
              const totalFulfilled = (mrItem.issuedQty || 0) + (mrItem.allocatedQty || 0);
              if (mrItem.issuedQty >= mrItem.qty) mrItem.status = "Issued";
              else if (totalFulfilled >= mrItem.qty) mrItem.status = "Allocated";
              else if (totalFulfilled > 0) mrItem.status = "Partial";
              else mrItem.status = "In Stock";
            }
            const allIssued = mr.items.length > 0 && mr.items.every((mi) => (mi.issuedQty || 0) >= mi.qty);
            const someIssued = mr.items.some((mi) => (mi.issuedQty || 0) > 0);
            const allAllocated = mr.items.every((mi) => (mi.issuedQty || 0) + (mi.allocatedQty || 0) >= mi.qty);
            const someAllocated = mr.items.some((mi) => (mi.issuedQty || 0) + (mi.allocatedQty || 0) > 0);
            if (allIssued) mr.status = "Closed";
            else if (someIssued) mr.status = "Partially Issued";
            else if (allAllocated) mr.status = "Allocated";
            else if (someAllocated) mr.status = "Partially Allocated";
            else mr.status = "Store Pending";
            await mr.save({});
          }
        }
        const inv = await Inventory.findOne({ sku: it.sku });
        if (inv) {
          inv.liveStock = (inv.liveStock || 0) + it.qty;
          const effectiveMrId = tx.mrId || tx.mrNo;
          if (effectiveMrId) {
            inv.issuedQty = Math.max(0, (inv.issuedQty || 0) - it.qty);
            inv.allocatedQty = (inv.allocatedQty || 0) + fromAllocationTotal;
          } else {
            inv.totalQty = (inv.totalQty || 0) + it.qty;
            inv.availableQty = (inv.availableQty || 0) + it.qty;
          }
          if (tx.store) {
            const curr = inv.locationStock && inv.locationStock.has(tx.store) ? Number(inv.locationStock.get(tx.store)) : ((inv.sites || []).find(s => s.siteName === tx.store)?.liveStock || 0);
            applyStoreDelta(inv, tx.store, curr + it.qty);
          }
          await inv.save({});
        }
      }
    } else {
      // Inward-type deletion — reverse stock additions
      const isInward = ["Inward", "Transfer Inward", "Public Inward", "Public Transfer Inward", "GRN"].includes(tx.type) || tx.type.toLowerCase().includes("inward");
      if (isInward) {
        for (const it of tx.items || []) {
          if (!it.sku) continue;
          const inv = await Inventory.findOne({ sku: it.sku });
          if (inv) {
            inv.liveStock = Math.max(0, (inv.liveStock || 0) - it.qty);
            inv.totalQty = Math.max(0, (inv.totalQty || 0) - it.qty);
            inv.availableQty = Math.max(0, (inv.availableQty || 0) - it.qty);
            if (tx.store) {
              const curr = getSiteStock(inv, tx.store);
              applyStoreDelta(inv, tx.store, Math.max(0, curr - it.qty));
            }
            await inv.save({});
          }
        }
      }
    }
    await Transaction.findOneAndDelete({ id: req.params.id });
    await Outward.findOneAndDelete({ id: req.params.id });
    await Inward.findOneAndDelete({ id: req.params.id });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    broadcast({ type: "DATA_UPDATED", path: "outward" });
    broadcast({ type: "DATA_UPDATED", path: "inward" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
    broadcast({ type: "DATA_UPDATED", path: "mr-allocations" });
    await triggerN8nWebhook("TRANSACTION_DELETE", {
      transactionId: req.params.id,
      type: tx.type,
      deletedBy: req.user?.name || "system"
    });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.get("/gate-passes/available", authenticate, async (req, res) => {
  try {
    const INVALID_GP = ["", "NA", "N/A", "na", "n/a", "null", "undefined"];
    const OUTWARD_TYPES = ["Transfer Outward", "Public Transfer Outward", "Transfer"];
    const INWARD_TYPES_TF = ["Transfer Inward", "Public Transfer Inward", "Transfer"];
    const GP_FILTER = { gatePassNo: { $exists: true, $nin: INVALID_GP } };
    const [txOutwards, dbOutwards, txInwards, dbInwards, allInwardsWithGP] = await Promise.all([
      Transaction.find({ type: { $in: OUTWARD_TYPES }, ...GP_FILTER }).lean(),
      Outward.find({ type: { $in: OUTWARD_TYPES }, ...GP_FILTER }).lean(),
      Transaction.find({ type: { $in: INWARD_TYPES_TF }, ...GP_FILTER }).lean(),
      // Inward collection is dedicated — exclude ANY doc with a gatePassNo regardless of type
      Inward.find(GP_FILTER).lean(),
      // Also catch Transfer Inwards stored in Transaction with any type variant
      Transaction.find({ ...GP_FILTER, type: { $regex: /inward/i } }).lean()
    ]);
    const seenOutward = new Set();
    const allOutwards = [...txOutwards, ...dbOutwards].filter((o) => {
      if (!o.gatePassNo || seenOutward.has(o.gatePassNo)) return false;
      seenOutward.add(o.gatePassNo);
      return true;
    });
    const receivedGPs = new Set(
      [...txInwards, ...dbInwards, ...allInwardsWithGP]
        .map((i) => i.gatePassNo)
        .filter(Boolean)
    );
    const available = allOutwards.filter((o) => !receivedGPs.has(o.gatePassNo));
    res.json({ success: true, data: available });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
router.get("/gate-passes/:gatePassNo", authenticate, async (req, res) => {
  try {
    const gp = req.params.gatePassNo.trim();
    const OUTWARD_TYPES = ["Transfer Outward", "Public Transfer Outward", "Transfer"];
    // Search both collections; fall back to any-type search if strict-type misses
    const [txResult, dbResult] = await Promise.all([
      Transaction.findOne({ gatePassNo: gp, type: { $in: OUTWARD_TYPES } }).lean(),
      Outward.findOne({ gatePassNo: gp, type: { $in: OUTWARD_TYPES } }).lean()
    ]);
    let result = txResult || dbResult;
    if (!result) {
      // Fallback: search by gatePassNo without type restriction
      const [txFallback, dbFallback] = await Promise.all([
        Transaction.findOne({ gatePassNo: gp }).lean(),
        Outward.findOne({ gatePassNo: gp }).lean()
      ]);
      result = txFallback || dbFallback;
    }
    if (!result) return res.status(404).json({ success: false, message: `Gate pass ${gp} not found` });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
var stdin_default = router;
export {
  stdin_default as default
};
