var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
import { logger } from "../utils/logger.js";
import { Router } from "express";
import { generateMRReportPDF } from "../utils/mrPdfGenerator.js";
import mongoose from "mongoose";
import { MaterialRequirement, Inventory, MRAllocation, RolePermission, Settings, Quotation, MaterialPlan } from "../models/index.js";
import { uploadPDFToSlack } from "../scheduler.js";
import { authenticate, serverHasPermission } from "../middleware/auth.middleware.js";
import { getRolesWithPermission, createNotification } from "../utils/notification.js";
import { triggerN8nWebhook } from "../utils/webhook.js";
import { broadcast } from "../utils/broadcaster.js";
import { getNextSequence } from "../utils/sequence.js";
import { createCrudRoutes } from "../utils/crud.js";
import { logAudit } from "../utils/audit.js";
const router = Router();
router.get("/", authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const skip = (page - 1) * limit;
    const search = req.query.search;
    const unused = req.query.unused === "true";
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
    const userRole = req.user.role;
    const rolePerm = await RolePermission.findOne({ role: userRole });
    const perms = rolePerm?.permissions || [];
    const isTracking = req.query.isTracking === "true";
    let roleFilterOr = null;
    if (!isTracking && userRole !== "Super Admin" && userRole !== "admin" && userRole !== "Director") {
      const allowedStatuses = /* @__PURE__ */ new Set();
      const roleNorm = (userRole || "").toLowerCase().trim();
      const canApproveStore = perms.includes("APPROVE_MR_STORE") || roleNorm === "store incharge" || roleNorm === "inventory manager" || roleNorm === "store assistant";
      if (canApproveStore) {
        allowedStatuses.add("Store Pending");
        allowedStatuses.add("Approved by Store");
      }
      if (perms.includes("VIEW_MATERIAL_REQUIREMENT") || perms.includes("CREATE_MATERIAL_REQUIREMENT") || perms.includes("CREATE_PURCHASE_ORDER") || perms.includes("VIEW_PURCHASE_ORDERS") || perms.includes("EDIT_PURCHASE_ORDER")) {
        ["Quotation Phase", "Approved by AGM", "Approved by Director", "Allocated", "Partially Allocated", "Partially Issued", "Closed", "Fulfilled", "PO Created"].forEach((s) => allowedStatuses.add(s));
      }
      roleFilterOr = [
        { status: { $in: Array.from(allowedStatuses) } },
        { engineerId: req.user._id.toString() },
        { requesterName: req.user.name }
      ];
      // PO creators must also see MRs whose quotation is already Approved,
      // regardless of what status the MR itself is in
      if (perms.includes("CREATE_PURCHASE_ORDER") || perms.includes("VIEW_PURCHASE_ORDERS") || perms.includes("EDIT_PURCHASE_ORDER")) {
        const approvedMrIds = await Quotation.distinct("mrId", { status: "Approved" });
        if (approvedMrIds.length) roleFilterOr.push({ id: { $in: approvedMrIds } });
      }
      query.$or = roleFilterOr;
    }
    if (unused) {
      const linkedMrIds = await mongoose.model("PurchaseOrder").find({ mrId: { $nin: [null, ""] } }).distinct("mrId");
      query.id = { $nin: linkedMrIds };
    }
    if (search) {
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchRegex = new RegExp(escapedSearch, "i");
      const searchOr = [
        { id: searchRegex },
        { mrNumber: searchRegex },
        { project: searchRegex },
        { requesterName: searchRegex },
        { location: searchRegex },
        { purpose: searchRegex },
      ];
      if (roleFilterOr) {
        // Combine role access filter + search via $and so neither overwrites the other
        query.$and = [{ $or: roleFilterOr }, { $or: searchOr }];
        delete query.$or;
      } else {
        query.$or = searchOr;
      }
    }
    if (filterStr) {
      const { startDate: _, endDate: __, ...restFilter } = parsedFilter;
      if (restFilter.status === "PO Phase") {
        const linkedMrIds = await mongoose.model("PurchaseOrder").find({ mrId: { $nin: [null, ""] } }).distinct("mrId");
        if (query.id) {
          query.id = { ...query.id, $in: linkedMrIds };
        } else {
          query.id = { $in: linkedMrIds };
        }
        delete restFilter.status;
      }
      query = { ...query, ...restFilter };
    }
    const [items, total] = await Promise.all([
      MaterialRequirement.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      MaterialRequirement.countDocuments(query).lean()
    ]);
    res.json({
      success: true,
      data: items,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    logger.error(`Error fetching material-requirements:`, error);
    res.status(500).json({ success: false, message: error.message });
  }
});
// DELETE /material-requirements/:mrId/allocation — de-allocate a specific MR item
router.delete("/:mrId/allocation", authenticate, async (req, res) => {
  try {
    const rawSku = req.query.sku;
    const sku = rawSku ? decodeURIComponent(rawSku).trim() : null;
    if (!sku) return res.status(400).json({ success: false, message: "sku query param required" });
    const mr = await MaterialRequirement.findOne({ id: req.params.mrId });
    if (!mr) return res.status(404).json({ success: false, message: "MR not found" });

    // Get all MRAllocation records for this MR+SKU (the source of truth for allocated qty)
    const alcRecords = await MRAllocation.find({ mrId: req.params.mrId, sku });
    const totalIssuedInAlc = alcRecords.reduce((s, a) => s + (a.issuedQty || 0), 0);
    if (totalIssuedInAlc > 0) {
      return res.status(400).json({ success: false, message: `Cannot de-allocate: ${totalIssuedInAlc} unit(s) already issued` });
    }
    const reverseQty = alcRecords.reduce((s, a) => s + (a.allocatedQty || 0), 0);

    // Reverse inventory allocation
    if (reverseQty > 0) {
      const inv = await Inventory.findOne({ sku });
      if (inv) {
        inv.allocatedQty = Math.max(0, (inv.allocatedQty || 0) - reverseQty);
        inv.availableQty = Math.max(0, (inv.liveStock || 0) - inv.allocatedQty);
        await inv.save({});
      }
    }

    // Update MR item — try by sku (case-insensitive), then by itemName from allocation record
    const skuLower = sku.toLowerCase();
    let mrItem = mr.items.find(i => i.sku && i.sku.trim().toLowerCase() === skuLower);
    if (!mrItem && alcRecords[0]?.itemName) {
      const nameLower = alcRecords[0].itemName.trim().toLowerCase();
      mrItem = mr.items.find(i => i.materialName && i.materialName.trim().toLowerCase() === nameLower);
    }
    if (mrItem) {
      mrItem.allocatedQty = 0;
      mrItem.status = "Needs Purchase";
    }

    await MRAllocation.deleteMany({ mrId: req.params.mrId, sku });

    const allAllocated = mr.items.every(i => (i.allocatedQty || 0) >= i.qty || i.status === "Issued");
    const someAllocated = mr.items.some(i => (i.allocatedQty || 0) > 0);
    const someIssued = mr.items.some(i => (i.issuedQty || 0) > 0);
    if (someIssued) mr.status = "Partially Issued";
    else if (allAllocated) mr.status = "Allocated";
    else if (someAllocated) mr.status = "Partially Allocated";
    else mr.status = "Store Pending";
    await mr.save({});

    broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "mr-allocations" });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
// PUT /material-requirements/:mrId/allocation — edit allocated qty for an MR item (sku via query param)
router.put("/:mrId/allocation", authenticate, async (req, res) => {
  try {
    const rawSku = req.query.sku;
    const sku = rawSku ? decodeURIComponent(rawSku).trim() : null;
    if (!sku) return res.status(400).json({ success: false, message: "sku query param required" });
    const { allocatedQty } = req.body;
    const newQty = Number(allocatedQty);
    const mr = await MaterialRequirement.findOne({ id: req.params.mrId });
    if (!mr) return res.status(404).json({ success: false, message: "MR not found" });
    const skuLower = sku.toLowerCase();
    let mrItem = mr.items.find(i => i.sku && i.sku.trim().toLowerCase() === skuLower);
    if (!mrItem) {
      // Fallback: match by itemName from MRAllocation record
      const alcRecord = await MRAllocation.findOne({ mrId: req.params.mrId, sku });
      if (alcRecord?.itemName) {
        const nameLower = alcRecord.itemName.trim().toLowerCase();
        mrItem = mr.items.find(i => i.materialName && i.materialName.trim().toLowerCase() === nameLower);
      }
    }
    if (!mrItem) return res.status(404).json({ success: false, message: "Item not found in MR" });
    const issuedQty = mrItem.issuedQty || 0;
    if (newQty < issuedQty) {
      return res.status(400).json({ success: false, message: `Cannot reduce below issued qty (${issuedQty})` });
    }
    if (newQty > mrItem.qty) {
      return res.status(400).json({ success: false, message: `Cannot allocate more than required qty (${mrItem.qty})` });
    }
    const oldQty = mrItem.allocatedQty || 0;
    const delta = newQty - oldQty;
    const inv = await Inventory.findOne({ sku });
    if (inv) {
      if (delta > 0) {
        const available = Math.max(0, (inv.liveStock || 0) - (inv.allocatedQty || 0));
        if (available < delta) return res.status(400).json({ success: false, message: `Insufficient stock. Available: ${available}, Need: ${delta}` });
      }
      inv.allocatedQty = Math.max(0, (inv.allocatedQty || 0) + delta);
      inv.availableQty = Math.max(0, (inv.liveStock || 0) - inv.allocatedQty);
      await inv.save({});
    }
    mrItem.allocatedQty = newQty;
    const totalFulfilled = issuedQty + newQty;
    if (issuedQty >= mrItem.qty) mrItem.status = "Issued";
    else if (totalFulfilled >= mrItem.qty) mrItem.status = "Allocated";
    else if (totalFulfilled > 0) mrItem.status = "Partial";
    else mrItem.status = "Needs Purchase";
    const allAllocated = mr.items.every(i => i.status === "Allocated" || i.status === "Issued");
    const someAllocated = mr.items.some(i => (i.allocatedQty || 0) > 0);
    const someIssued = mr.items.some(i => (i.issuedQty || 0) > 0);
    if (someIssued) mr.status = "Partially Issued";
    else if (allAllocated) mr.status = "Allocated";
    else if (someAllocated) mr.status = "Partially Allocated";
    else mr.status = "Store Pending";
    await mr.save({});
    // Also update the MRAllocation document so Allocated Stock Registry reflects the change
    const alloc = await MRAllocation.findOne({ mrId: mr.id, sku });
    if (alloc) {
      alloc.allocatedQty = newQty;
      alloc.remainingQty = Math.max(0, newQty - issuedQty);
      alloc.status = alloc.remainingQty === 0 ? "Closed" : issuedQty > 0 ? "Partially Issued" : "Allocated";
      await alloc.save({});
    }
    broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "mr-allocations" });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.post("/allocate", authenticate, async (req, res) => {
  const session = { startTransaction: /* @__PURE__ */ __name(() => {
  }, "startTransaction"), commitTransaction: /* @__PURE__ */ __name(async () => {
  }, "commitTransaction"), abortTransaction: /* @__PURE__ */ __name(async () => {
  }, "abortTransaction"), endSession: /* @__PURE__ */ __name(() => {
  }, "endSession") };
  session.startTransaction();
  try {
    const { mrId, items } = req.body;
    const mr = await MaterialRequirement.findOne({ id: mrId });
    if (!mr) throw new Error("Material Requisition not found");
    for (const allocReq of items) {
      if (!allocReq.sku || !allocReq.qty || allocReq.qty <= 0) continue;
      const reqSkuLower = (allocReq.sku || "").trim().toLowerCase();
      const mrItem = mr.items.find((i) => i.sku && i.sku.trim().toLowerCase() === reqSkuLower);
      if (!mrItem) continue;
      const needed = Math.max(0, mrItem.qty - (mrItem.allocatedQty || 0));
      const finalAllocQty = Math.min(allocReq.qty, needed);
      if (finalAllocQty <= 0) continue;
      const inv = await Inventory.findOne({ sku: allocReq.sku });
      if (!inv) throw new Error(`Item ${allocReq.sku} not found in inventory`);
      // Sync liveStock from sites array (authoritative) or locationStock map
      const sitesTotal = (inv.sites || []).reduce((s, v) => s + Math.max(0, Number(v.liveStock) || 0), 0);
      if (sitesTotal > 0 && sitesTotal !== (inv.liveStock || 0)) inv.liveStock = sitesTotal;
      else if (inv.locationStock && inv.locationStock.size > 0) {
        const locTotal = [...inv.locationStock.values()].reduce((s, v) => s + Math.max(0, Number(v) || 0), 0);
        if (locTotal > (inv.liveStock || 0)) inv.liveStock = locTotal;
      }
      // Use per-store stock when a godown is specified; otherwise use global available
      let actualAvailable;
      if (allocReq.store) {
        // Check sites array first (authoritative), then locationStock map
        const siteEntry = (inv.sites || []).find(s => s.siteName === allocReq.store);
        const siteQty = siteEntry !== undefined ? (Number(siteEntry?.liveStock) || 0) : null;
        const locQty = inv.locationStock ? Number(inv.locationStock.get(allocReq.store) ?? 0) : 0;
        const rawSiteStock = siteQty !== null ? siteQty : locQty;
        const globalAvailable = Math.max(0, (inv.liveStock || 0) - (inv.allocatedQty || 0));
        actualAvailable = Math.min(rawSiteStock, globalAvailable);
      } else {
        actualAvailable = Math.max(0, (inv.liveStock || 0) - (inv.allocatedQty || 0));
      }
      if (actualAvailable < finalAllocQty) {
        throw new Error(`Insufficient available stock for ${inv.itemName} (${allocReq.sku}). Available: ${actualAvailable}, Requested: ${finalAllocQty}`);
      }
      inv.allocatedQty = (inv.allocatedQty || 0) + finalAllocQty;
      inv.availableQty = Math.max(0, (inv.liveStock || 0) - inv.allocatedQty);
      inv.totalQty = (inv.liveStock || 0) + (inv.issuedQty || 0);
      await inv.save({});
      await MRAllocation.create([{
        id: `ALC-${mr.id}-${allocReq.sku}-${Date.now()}`,
        mrId: mr.id,
        mrNumber: mr.mrNumber || mr.id,
        engineerName: mr.requesterName,
        projectName: mr.project,
        sku: allocReq.sku,
        itemName: inv.itemName,
        allocatedQty: finalAllocQty,
        remainingQty: finalAllocQty,
        issuedQty: 0,
        allocatedBy: req.user.name,
        allocationDate: (/* @__PURE__ */ new Date()).toISOString(),
        date: (/* @__PURE__ */ new Date()).toISOString().split("T")[0]
      }]);
      mrItem.allocatedQty = (mrItem.allocatedQty || 0) + finalAllocQty;
      if (mrItem.allocatedQty >= mrItem.qty) {
        mrItem.status = "Allocated";
      } else {
        mrItem.status = "Partial";
      }
    }
    const allAllocated = mr.items.every((i) => i.status === "Allocated" || i.status === "Issued");
    const someAllocated = mr.items.some((i) => (i.allocatedQty || 0) > 0);
    const someIssuedNow = mr.items.some((i) => (i.issuedQty || 0) > 0);
    if (someIssuedNow && !allAllocated) mr.status = "Partially Issued";
    else if (allAllocated) mr.status = "Allocated";
    else if (someAllocated) mr.status = "Partially Allocated";
    await mr.save({});
    await session.commitTransaction();
    logAudit(req.user, "UPDATE", "MRAllocation", mrId, { allocatedBy: req.user.name, items: items.map((i) => i.sku) });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
    broadcast({ type: "DATA_UPDATED", path: "mr-allocations" });
    res.json({ success: true, message: "Material allocated successfully" });
  } catch (error) {
    await session.abortTransaction();
    logger.error("Allocation Error:", error);
    res.status(400).json({ success: false, message: error.message });
  } finally {
    session.endSession();
  }
});
router.post("/", authenticate, async (req, res) => {
  try {
    if (!await serverHasPermission(req.user, "CREATE_MATERIAL_REQUIREMENT")) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const year = (/* @__PURE__ */ new Date()).getFullYear();
    const seq = await getNextSequence("MR");
    const customId = `MR-${year}-${seq}`;

    // Validate against material plan — flag excess requests for AGM approval
    let mrStatus = req.body.status || "Store Pending";
    if (req.body.planId) {
      const plan = await MaterialPlan.findOne({ id: req.body.planId, status: "Approved" }).lean();
      if (plan) {
        const existingMrs = await MaterialRequirement.find({ planId: req.body.planId, status: { $nin: ["Rejected"] } }).lean();
        const usedMap = {};
        for (const mr of existingMrs) {
          for (const it of mr.items || []) {
            const k = it.sku || it.materialName;
            if (k) usedMap[k] = (usedMap[k] || 0) + (Number(it.qty) || 0);
          }
        }
        const isExtra = (req.body.items || []).some((it) => {
          const planItem = plan.items.find((pi) => (pi.sku && pi.sku === it.sku) || (pi.itemName && pi.itemName === it.materialName));
          if (!planItem) return true;
          const remaining = Math.max(0, (Number(planItem.required) || 0) - (usedMap[it.sku || it.materialName] || 0));
          return Number(it.qty) > remaining;
        });
        if (isExtra) mrStatus = "Extra Pending AGM";
      }
    }

    const requirement = await MaterialRequirement.create({
      ...req.body,
      id: customId,
      mrNumber: customId,
      status: mrStatus,
      date: req.body.date || (/* @__PURE__ */ new Date()).toISOString()
    });
    broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
    logAudit(req.user, "CREATE", "MaterialRequirement", requirement.id, { project: requirement.project, requesterName: requirement.requesterName });
    const storeRoles = await getRolesWithPermission("APPROVE_MR_STORE");
    await createNotification({
      message: `New Material Requirement ${requirement.id} received for project ${requirement.project}. Store approval required.`,
      severity: "warning",
      path: "material-requirements",
      senderId: req.user._id,
      targetRoles: storeRoles
    });
    await triggerN8nWebhook("MATERIAL_REQ", {
      mrId: requirement.id,
      mrNumber: requirement.mrNumber || requirement.id,
      status: requirement.status,
      date: requirement.date,
      project: requirement.project,
      location: requirement.location,
      purpose: requirement.purpose,
      requesterName: requirement.requesterName || req.user.name,
      requesterEmail: requirement.requesterEmail || req.user.email,
      engineerId: requirement.engineerId,
      items: (requirement.items || []).map(i => ({
        itemName: i.materialName,
        sku: i.sku,
        qty: i.qty,
        unit: i.unit,
        remarks: i.remarks,
      })),
      totalItems: (requirement.items || []).length,
      createdBy: req.user.name,
      createdByEmail: req.user.email,
    });
    res.json({ success: true, data: requirement });
  } catch (error) {
    logger.error("Error creating material requirement:", error);
    res.status(400).json({ success: false, message: error.message });
  }
});
router.get("/export", authenticate, async (req, res) => {
  try {
    const { startDate, endDate, project, requesterName, status, search } = req.query;

    const day = startDate ? new Date(startDate) : new Date();
    const start = new Date(day); start.setHours(0, 0, 0, 0);
    const endDay = endDate ? new Date(endDate) : new Date(day);
    const end = new Date(endDay); end.setHours(23, 59, 59, 999);

    const query = { createdAt: { $gte: start, $lte: end } };
    if (project) query.project = project;
    if (requesterName) query.requesterName = requesterName;
    if (status) query.status = status;
    if (search) {
      const re = new RegExp(search, "i");
      query.$or = [{ mrNumber: re }, { requesterName: re }, { project: re }, { "items.materialName": re }];
    }

    const mrs = await MaterialRequirement.find(query).sort({ createdAt: 1 }).lean();

    const dateStr = start.toISOString().slice(0, 10);
    const isSameDay = start.toDateString() === end.toDateString();
    const dateLabel = isSameDay
      ? start.toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" })
      : `${start.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })} – ${end.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`;

    const pdfBuffer = await generateMRReportPDF(mrs, dateLabel);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="MR-Report-${dateStr}.pdf"`);
    res.send(pdfBuffer);

    // After download, silently push to Slack channels from active MR automations
    setImmediate(async () => {
      try {
        const botToken = process.env.SLACK_BOT_TOKEN;
        if (!botToken) return;
        const settings = await Settings.findOne().lean();
        const automations = settings?.reportAutomations || [];
        const slackIds = [...new Set(
          automations
            .filter(a => a.enabled && (!a.module || a.module === "MR") && a.slackIds?.length)
            .flatMap(a => a.slackIds)
        )];
        if (!slackIds.length) return;
        const pdfFilename = `MR-Report-${dateStr}.pdf`;
        const exportedBy = req.user?.name || "User";
        const message = `📋 *MR Report — ${dateLabel}*\nManually exported by *${exportedBy}*\n*Total MRs:* ${mrs.length}`;
        for (const channelId of slackIds) {
          try {
            await uploadPDFToSlack(botToken, channelId, pdfBuffer, pdfFilename, message);
            logger.info(`[MR Export] PDF sent to Slack channel ${channelId}`);
          } catch (err) {
            logger.error(`[MR Export] Slack upload to ${channelId} failed: ${err.message}`);
          }
        }
      } catch (err) {
        logger.error("[MR Export] Slack auto-send error:", err.message);
      }
    });
  } catch (err) {
    logger.error("Error exporting MR report:", err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

const AGM_ROLES = ["AGM", "Head", "Super Admin", "Director", "admin"];
const GM_ROLES_MR = ["Director", "GM", "Super Admin", "admin"];

// AGM approves extra requirement → escalates to GM
router.post("/:id/extra-approve-agm", authenticate, async (req, res) => {
  try {
    const canApprove = AGM_ROLES.includes(req.user.role) || await serverHasPermission(req.user, "APPROVE_EXTRA_MR");
    if (!canApprove) return res.status(403).json({ success: false, message: "Forbidden" });
    const mr = await MaterialRequirement.findOne({ id: req.params.id });
    if (!mr) return res.status(404).json({ success: false, message: "MR not found" });
    if (mr.status !== "Extra Pending AGM") return res.status(400).json({ success: false, message: "MR is not pending AGM approval" });
    mr.status = "Extra Pending GM";
    mr.extraApprovals = [...(mr.extraApprovals || []), { by: req.user.name, role: "AGM", at: new Date(), action: "Approved", remark: req.body.remark || "" }];
    await mr.save();
    broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
    const gmRoles = await getRolesWithPermission("APPROVE_MATERIAL_PLAN");
    await createNotification({ message: `Extra MR ${mr.id} approved by AGM — pending GM approval`, severity: "warning", path: "material-requirements", senderId: req.user._id, targetRoles: gmRoles.length ? gmRoles : ["Director", "Super Admin"] });
    res.json({ success: true, data: mr });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GM approves extra requirement → enters normal MR flow
router.post("/:id/extra-approve-gm", authenticate, async (req, res) => {
  try {
    const canApprove = GM_ROLES_MR.includes(req.user.role) || await serverHasPermission(req.user, "APPROVE_MATERIAL_PLAN");
    if (!canApprove) return res.status(403).json({ success: false, message: "Forbidden" });
    const mr = await MaterialRequirement.findOne({ id: req.params.id });
    if (!mr) return res.status(404).json({ success: false, message: "MR not found" });
    if (!["Extra Pending AGM", "Extra Pending GM"].includes(mr.status)) return res.status(400).json({ success: false, message: "MR is not pending extra approval" });
    mr.status = "Store Pending";
    mr.extraApprovals = [...(mr.extraApprovals || []), { by: req.user.name, role: "GM", at: new Date(), action: "Approved", remark: req.body.remark || "" }];
    await mr.save();
    broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
    const storeRoles = await getRolesWithPermission("APPROVE_MR_STORE");
    await createNotification({ message: `Extra MR ${mr.id} fully approved by GM — store processing required`, severity: "success", path: "material-requirements", senderId: req.user._id, targetRoles: storeRoles });
    res.json({ success: true, data: mr });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// AGM or GM rejects extra requirement
router.post("/:id/extra-reject", authenticate, async (req, res) => {
  try {
    const mr = await MaterialRequirement.findOne({ id: req.params.id });
    if (!mr) return res.status(404).json({ success: false, message: "MR not found" });
    if (!["Extra Pending AGM", "Extra Pending GM"].includes(mr.status)) return res.status(400).json({ success: false, message: "MR is not pending extra approval" });
    mr.status = "Rejected";
    mr.extraApprovals = [...(mr.extraApprovals || []), { by: req.user.name, role: req.user.role, at: new Date(), action: "Rejected", remark: req.body.reason || "" }];
    await mr.save();
    broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
    res.json({ success: true, data: mr });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

createCrudRoutes(router, MaterialRequirement, "material-requirements", "id", "MATERIAL_REQUIREMENT", "MR");
var stdin_default = router;
export {
  stdin_default as default
};
