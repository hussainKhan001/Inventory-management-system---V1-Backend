var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
import { logger } from "../utils/logger.js";
import { Router } from "express";
import {
  SupplierModel,
  MaterialRequirement,
  Quotation,
  Inventory,
  Catalogue,
  Inward,
  Outward,
  Transaction,
  PurchaseOrder,
  GRN,
  InwardReturn,
  OutwardReturn
} from "../models/index.js";
import { getNextSequence } from "../utils/sequence.js";
import { broadcast } from "../utils/broadcaster.js";
import { getRolesWithPermission, createNotification } from "../utils/notification.js";
import { triggerN8nWebhook } from "../utils/webhook.js";
const router = Router();
const INWARD_TYPES = [
  "Inward",
  "Public Inward",
  "Public Transfer Inward",
  "Transfer Inward",
  "GRN",
  "Outward Return",
  "Public Outward Return"
];
const updatePublicStock = /* @__PURE__ */ __name(async (type, sku, itemName, qty, unit, category, store) => {
  const isPositive = INWARD_TYPES.includes(type);
  const inv = await Inventory.findOne({ sku });
  if (inv) {
    if (!inv.locationStock) inv.locationStock = new Map();
    if (!inv.sites) inv.sites = [];
    if (isPositive) {
      if (store) {
        const curr = inv.locationStock.has(store) ? Number(inv.locationStock.get(store)) : (inv.sites.find(s => s.siteName === store)?.liveStock || 0);
        const newQty = curr + qty;
        inv.locationStock.set(store, newQty);
        inv.markModified("locationStock");
        const siteEntry = inv.sites.find(s => s.siteName === store);
        if (siteEntry) { siteEntry.liveStock = newQty; } else { inv.sites.push({ siteName: store, siteCode: "", openingStock: 0, liveStock: newQty }); }
        inv.markModified("sites");
      } else {
        inv.totalQty = (inv.totalQty || 0) + qty;
        inv.availableQty = (inv.availableQty || 0) + qty;
        inv.liveStock = (inv.availableQty || 0) + (inv.allocatedQty || 0);
      }
    } else {
      if (store) {
        const curr = inv.locationStock.has(store) ? Number(inv.locationStock.get(store)) : (inv.sites.find(s => s.siteName === store)?.liveStock || 0);
        const newQty = Math.max(0, curr - qty);
        inv.locationStock.set(store, newQty);
        inv.markModified("locationStock");
        const siteEntry = inv.sites.find(s => s.siteName === store);
        if (siteEntry) { siteEntry.liveStock = newQty; } else { inv.sites.push({ siteName: store, siteCode: "", openingStock: 0, liveStock: newQty }); }
        inv.markModified("sites");
      } else {
        inv.totalQty = Math.max(0, (inv.totalQty || 0) - qty);
        inv.availableQty = Math.max(0, (inv.availableQty || 0) - qty);
        inv.liveStock = (inv.availableQty || 0) + (inv.allocatedQty || 0);
      }
    }
    await inv.save();
  } else if (isPositive) {
    await Inventory.create({
      sku,
      itemName,
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
    });
  }
}, "updatePublicStock");
router.get("/inventory", async (req, res) => {
  try {
    const search = (req.query.search || "").replace(/[.*+?^${}()|[]\]/g, "$&");
    const filter = req.query.filter;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    let query = {};
    if (search) {
      query.$or = [
        { itemName: new RegExp(search, "i") },
        { sku: new RegExp(search, "i") },
        { category: new RegExp(search, "i") }
      ];
    }
    if (filter) {
      try {
        Object.assign(query, JSON.parse(filter));
      } catch {
      }
    }
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      Inventory.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Inventory.countDocuments(query)
    ]);
    res.json({ success: true, data: items, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
router.post("/inventory", async (req, res) => {
  try {
    const data = req.body;
    if (!data.sku) data.sku = `SKU-PUB-${Date.now()}`;
    const item = await Inventory.create(data);
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    res.json({ success: true, data: item });
  } catch (error) {
    if (error.code === 11e3) {
      return res.status(400).json({ success: false, message: `SKU "${req.body.sku}" already exists in inventory.` });
    }
    res.status(400).json({ success: false, message: error.message });
  }
});
router.get("/catalogue", async (req, res) => {
  try {
    const search = (req.query.search || "").replace(/[.*+?^${}()|[]\]/g, "$&");
    const filter = req.query.filter;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    let query = {};
    if (search) {
      query.$or = [
        { itemName: new RegExp(search, "i") },
        { sku: new RegExp(search, "i") },
        { category: new RegExp(search, "i") },
        { brand: new RegExp(search, "i") }
      ];
    }
    if (filter) {
      try {
        Object.assign(query, JSON.parse(filter));
      } catch {
      }
    }
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      Catalogue.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Catalogue.countDocuments(query)
    ]);
    res.json({ success: true, data: items, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
router.get("/material-requirements", async (req, res) => {
  try {
    const search = (req.query.search || "").replace(/[.*+?^${}()|[]\]/g, "$&");
    const filter = req.query.filter;
    const unused = req.query.unused;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    let query = {};
    if (search) {
      query.$or = [
        { id: new RegExp(search, "i") },
        { project: new RegExp(search, "i") },
        { requesterName: new RegExp(search, "i") }
      ];
    }
    if (filter) {
      try {
        Object.assign(query, JSON.parse(filter));
      } catch {
      }
    }
    if (unused === "true") {
      const usedIds = (await PurchaseOrder.find({}, "mrId").lean()).map((po) => po.mrId).filter(Boolean);
      query.id = { $nin: usedIds };
    }
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      MaterialRequirement.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      MaterialRequirement.countDocuments(query)
    ]);
    res.json({ success: true, data: items, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
router.get("/quotations", async (req, res) => {
  try {
    const filter = req.query.filter;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    let query = {};
    if (filter) {
      try {
        Object.assign(query, JSON.parse(filter));
      } catch {
      }
    }
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      Quotation.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Quotation.countDocuments(query)
    ]);
    res.json({ success: true, data: items, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
router.get("/suppliers", async (req, res) => {
  try {
    const search = (req.query.search || "").replace(/[.*+?^${}()|[]\]/g, "$&");
    const limit = parseInt(req.query.limit) || 2e3;
    let query = { status: "Active" };
    if (search) {
      query.$or = [
        { companyName: new RegExp(search, "i") },
        { name: new RegExp(search, "i") }
      ];
    }
    const suppliers = await SupplierModel.find(query).limit(limit).lean();
    res.json({ success: true, data: suppliers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
router.get("/mr/:id", async (req, res) => {
  try {
    const mr = await MaterialRequirement.findOne({ id: req.params.id }).lean();
    if (!mr) {
      return res.status(404).json({ success: false, message: "Material Requirement not found" });
    }
    res.json({ success: true, data: mr });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
router.get("/tracking/:id", async (req, res) => {
  try {
    const queryId = req.params.id;
    let mr = null;
    let po = null;
    let grns = [];
    let quotations = [];
    if (queryId.startsWith("PO-")) {
      po = await PurchaseOrder.findOne({ id: queryId }).lean();
      if (po?.mrId) mr = await MaterialRequirement.findOne({ id: po.mrId }).lean();
    } else if (queryId.startsWith("GRN-")) {
      const grn = await GRN.findOne({ id: queryId }).lean();
      if (grn) {
        if (grn.poId) {
          po = await PurchaseOrder.findOne({ id: grn.poId }).lean();
          if (po?.mrId) mr = await MaterialRequirement.findOne({ id: po.mrId }).lean();
        } else if (grn.mrNo) {
          mr = await MaterialRequirement.findOne({ id: grn.mrNo }).lean();
        }
      }
    }
    if (!mr) {
      mr = await MaterialRequirement.findOne({ id: queryId }).lean();
    }
    if (!mr) {
      return res.status(404).json({ success: false, message: "Document not found. Please check the ID." });
    }
    quotations = await Quotation.find({ mrId: mr.id }).lean();
    // Fetch ALL POs linked to this MR
    const allPos = await PurchaseOrder.find({ mrId: mr.id }).sort({ createdAt: 1 }).lean();
    // If searched by specific PO/GRN, ensure that PO is first
    if (po && !allPos.find(p => p.id === po.id)) allPos.unshift(po);
    if (!po) po = allPos[0] || null;
    // Collect GRNs for all POs from GRN collection
    const poIds = allPos.map(p => p.id).filter(Boolean);
    if (poIds.length > 0) {
      grns = await GRN.find({ poId: { $in: poIds } }).lean();
    } else {
      grns = await GRN.find({ mrNo: mr.id }).lean();
    }
    return res.json({ success: true, data: { mr, po, pos: allPos, quotations, grns } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
router.post("/inward", async (req, res) => {
  try {
    const body = req.body;
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      throw new Error("At least one item is required");
    }
    const seq = await getNextSequence("IN");
    const year = (/* @__PURE__ */ new Date()).getFullYear();
    const id = body.id || `IN-${year}-${seq}`;
    const type = body.type || "Public Inward";
    const data = { ...body, id, type };
    const inward = await Inward.create(data);
    for (const item of body.items) {
      const inwardStore = type.includes("Transfer") ? (body.destinationProject || body.store) : body.store;
      await updatePublicStock(type, item.sku, item.itemName, item.qty, item.unit, null, inwardStore);
    }
    await Transaction.create({ ...data });
    broadcast({ type: "DATA_UPDATED", path: "inward" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    const storeRoles = await getRolesWithPermission("APPROVE_MR_STORE");
    await createNotification({
      message: `New Public Inward (${id}) recorded for project "${body.project || "N/A"}".`,
      severity: "info",
      path: "inward",
      targetRoles: storeRoles
    });
    triggerN8nWebhook("INWARD", { transactionId: data.id, ...data }).catch(err => logger.error("n8n Inward error:", err));
    res.json({ success: true, data: inward });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.post("/outward", async (req, res) => {
  try {
    const body = req.body;
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      throw new Error("At least one item is required");
    }
    const seq = await getNextSequence("OUT");
    const year = (/* @__PURE__ */ new Date()).getFullYear();
    const id = body.id || `OUT-${year}-${seq}`;
    const type = body.type || "Public Outward";
    const data = { ...body, id, type };
    const outward = await Outward.create(data);
    for (const item of body.items) {
      const outwardStore = type.includes("Transfer") ? (body.project || body.store) : body.store;
      await updatePublicStock(type, item.sku, item.itemName, item.qty, item.unit, null, outwardStore);
    }
    await Transaction.create({ ...data });
    broadcast({ type: "DATA_UPDATED", path: "outward" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    const storeRoles = await getRolesWithPermission("APPROVE_MR_STORE");
    await createNotification({
      message: `New Public Outward (${id}) recorded for project "${body.project || "N/A"}".`,
      severity: "info",
      path: "outward",
      targetRoles: storeRoles
    });
    triggerN8nWebhook("OUTWARD", { transactionId: data.id, ...data }).catch(err => logger.error("n8n Outward error:", err));
    res.json({ success: true, data: outward });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.post("/inward-returns", async (req, res) => {
  try {
    const body = req.body;
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      throw new Error("At least one item is required");
    }
    const seq = await getNextSequence("INR");
    const year = (/* @__PURE__ */ new Date()).getFullYear();
    const id = body.id || `INR-${year}-${seq}`;
    const data = { ...body, id, type: "Public Inward Return", vendor: body.supplier || body.vendor };
    const inwardReturn = await InwardReturn.create(data);
    for (const item of body.items) {
      await updatePublicStock("Public Inward Return", item.sku, item.itemName, item.qty, item.unit, null, body.store);
    }
    await Transaction.create({ ...data, type: "Public Inward Return" });
    broadcast({ type: "DATA_UPDATED", path: "inward-returns" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    const storeRoles = await getRolesWithPermission("APPROVE_MR_STORE");
    await createNotification({
      message: `New Public Inward Return (${id}) recorded for supplier "${body.supplier || "N/A"}".`,
      severity: "info",
      path: "inward-returns",
      targetRoles: storeRoles
    });
    res.json({ success: true, data: inwardReturn });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.post("/outward-returns", async (req, res) => {
  try {
    const body = req.body;
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      throw new Error("At least one item is required");
    }
    const seq = await getNextSequence("OUTR");
    const year = (/* @__PURE__ */ new Date()).getFullYear();
    const id = body.id || `OUTR-${year}-${seq}`;
    const data = { ...body, id, type: "Public Outward Return" };
    const outwardReturn = await OutwardReturn.create(data);
    for (const item of body.items) {
      await updatePublicStock("Public Outward Return", item.sku, item.itemName, item.qty, item.unit, null, body.store);
    }
    await Transaction.create({ ...data, type: "Public Outward Return" });
    broadcast({ type: "DATA_UPDATED", path: "outward-returns" });
    broadcast({ type: "DATA_UPDATED", path: "inventory" });
    broadcast({ type: "DATA_UPDATED", path: "transactions" });
    const storeRoles = await getRolesWithPermission("APPROVE_MR_STORE");
    await createNotification({
      message: `New Public Outward Return (${id}) recorded for project "${body.project || "N/A"}".`,
      severity: "info",
      path: "outward-returns",
      targetRoles: storeRoles
    });
    res.json({ success: true, data: outwardReturn });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.post("/po", async (req, res) => {
  try {
    const data = req.body;
    const year = (/* @__PURE__ */ new Date()).getFullYear();
    const seq = await getNextSequence("PO");
    const id = data.id || `PO-${year}-${seq}`;
    const po = await PurchaseOrder.create({
      ...data,
      id,
      status: data.status || "Pending L1",
      date: data.date || (/* @__PURE__ */ new Date()).toISOString().split("T")[0]
    });
    broadcast({ type: "DATA_UPDATED", path: "pos" });
    const l1Roles = await getRolesWithPermission("APPROVE_PO_L1");
    await createNotification({
      message: `New Purchase Order (${id}) submitted via Public Portal for project "${data.project || "N/A"}". L1 approval required.`,
      severity: "warning",
      path: "pos",
      targetRoles: l1Roles
    });
    res.json({ success: true, data: po });
  } catch (error) {
    if (error.code === 11e3) {
      return res.status(400).json({ success: false, message: "A Purchase Order with this ID already exists." });
    }
    res.status(400).json({ success: false, message: error.message });
  }
});
router.post("/quotation", async (req, res) => {
  try {
    const data = req.body;
    if (data.mrId) {
      const mr = await MaterialRequirement.findOne({ id: data.mrId });
      if (!mr) {
        return res.status(404).json({ success: false, message: "Material Requirement not found" });
      }
      if (mr.quotationLinkActive === false) {
        return res.status(400).json({ success: false, message: "This quotation link has been deactivated by the AGM." });
      }
    }
    const year = (/* @__PURE__ */ new Date()).getFullYear();
    const seq = await getNextSequence("QT");
    const customId = `QT-${year}-${seq}`;
    const quotation = await Quotation.create({
      ...data,
      id: customId,
      status: "Pending",
      date: (/* @__PURE__ */ new Date()).toISOString().split("T")[0]
    });
    broadcast({ type: "DATA_UPDATED", path: "quotations" });
    res.json({ success: true, data: quotation });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.post("/material-requirement", async (req, res) => {
  try {
    const year = (/* @__PURE__ */ new Date()).getFullYear();
    const seq = await getNextSequence("MR");
    const customId = `MR-${year}-${seq}`;
    const requirement = await MaterialRequirement.create({
      ...req.body,
      id: customId,
      mrNumber: customId,
      status: req.body.status || "Store Pending",
      date: req.body.date || (/* @__PURE__ */ new Date()).toISOString()
    });
    broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
    const storeRoles = await getRolesWithPermission("APPROVE_MR_STORE");
    await createNotification({
      message: `New Material Requirement (${requirement.id}) received from Public Portal for project "${requirement.project}". Store approval required.`,
      severity: "warning",
      path: "material-requirements",
      targetRoles: storeRoles
    });
    triggerN8nWebhook("MATERIAL_REQ", requirement.toObject ? requirement.toObject() : requirement).catch(err => logger.error("n8n MR error:", err));
    res.json({ success: true, data: requirement });
  } catch (error) {
    logger.error("Error creating public material requirement:", error);
    res.status(400).json({ success: false, message: error.message });
  }
});
router.get("/gate-passes/available", async (req, res) => {
  try {
    const INVALID_GP = ["", "NA", "N/A", "na", "n/a", "null", "undefined"];
    const OUTWARD_TYPES = ["Transfer Outward", "Public Transfer Outward"];
    const INWARD_TYPES_TF = ["Transfer Inward", "Public Transfer Inward"];
    const [txOutwards, dbOutwards, txInwards, dbInwards] = await Promise.all([
      Transaction.find({ type: { $in: OUTWARD_TYPES }, gatePassNo: { $exists: true, $nin: INVALID_GP } }).lean(),
      Outward.find({ type: { $in: OUTWARD_TYPES }, gatePassNo: { $exists: true, $nin: INVALID_GP } }).lean(),
      Transaction.find({ type: { $in: INWARD_TYPES_TF }, gatePassNo: { $exists: true, $nin: INVALID_GP } }).lean(),
      Inward.find({ type: { $in: INWARD_TYPES_TF }, gatePassNo: { $exists: true, $nin: INVALID_GP } }).lean()
    ]);
    const seenOutward = new Set();
    const allOutwards = [...txOutwards, ...dbOutwards].filter((o) => {
      if (!o.gatePassNo || seenOutward.has(o.gatePassNo)) return false;
      seenOutward.add(o.gatePassNo);
      return true;
    });
    const receivedGPs = new Set([...txInwards, ...dbInwards].map((i) => i.gatePassNo).filter(Boolean));
    const available = allOutwards.filter((o) => !receivedGPs.has(o.gatePassNo));
    res.json({ success: true, data: available });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
router.post("/supplier-registration", async (req, res) => {
  try {
    const data = req.body;
    if (data.companyName) {
      const existing = await SupplierModel.findOne({
        $or: [
          { companyName: new RegExp(`^${data.companyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
          { name: new RegExp(`^${data.companyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }
        ]
      });
      if (existing) {
        return res.status(400).json({ success: false, message: `A supplier named "${data.companyName}" already exists.` });
      }
    }
    const lastSupplier = await SupplierModel.findOne({ id: /^VND_\d+$/i }).sort({ id: -1 }).lean();
    const maxNum = lastSupplier ? (parseInt((lastSupplier.id.match(/VND_(\d+)/i) || [])[1] || "0", 10)) : 0;
    const id = `VND_${String(maxNum + 1).padStart(4, "0")}`;
    const supplier = await SupplierModel.create({
      ...data,
      id,
      name: data.name || data.companyName,
      supplierName: data.supplierName || data.companyName,
      contact: data.contact || data.ownerName,
      phone: data.phone || data.mobile,
      category: data.category || data.dealingProducts,
      gst: data.gst || data.gstNumber || "N/A",
      accountNo: data.accountNo || data.accountNumber,
      status: "Active"
    });
    broadcast({ type: "DATA_UPDATED", path: "suppliers" });
    res.json({ success: true, data: supplier });
  } catch (error) {
    if (error.code === 11e3) {
      const field = Object.keys(error.keyValue || {})[0] || "name";
      const value = error.keyValue?.[field] || "";
      const label = field === "companyName" || field === "name" ? "Company name" : field;
      return res.status(400).json({ success: false, message: `${label} "${value}" already exists.` });
    }
    res.status(400).json({ success: false, message: error.message });
  }
});
var stdin_default = router;
export {
  stdin_default as default
};
