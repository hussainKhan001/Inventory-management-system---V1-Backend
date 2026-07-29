import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import {
  MaterialRequirement, Quotation, PurchaseOrder, GRN,
  Inward, Outward, AccountEntry, Catalogue, Supplier, RolePermission,
} from "../models/index.js";

const router = Router();

// ── Permission gate: returns Set of allowed source names, or null (= no filter for admins) ──

const ADMIN_ROLES = new Set(["super admin", "superadmin", "admin", "director", "agm"]);

const MODULE_PERMS = {
  MR:        ["VIEW_MATERIAL_REQUIREMENT", "CREATE_MATERIAL_REQUIREMENT"],
  Quotation: ["VIEW_QUOTATIONS", "VIEW_PURCHASE_ORDERS", "CREATE_PURCHASE_ORDER"],
  PO:        ["VIEW_PURCHASE_ORDERS", "CREATE_PURCHASE_ORDER", "EDIT_PURCHASE_ORDER"],
  GRN:       ["VIEW_GRN", "CREATE_GRN"],
  Inward:    ["VIEW_INWARD"],
  Outward:   ["VIEW_OUTWARD"],
  Account:   ["VIEW_ACCOUNTS"],
};

async function getAllowedSources(user) {
  if (ADMIN_ROLES.has((user.role || "").toLowerCase().trim())) return null; // null = all allowed

  const rolePerm = await RolePermission.findOne({ role: user.role }).lean();
  const perms = new Set(rolePerm?.permissions || []);

  const allowed = new Set();
  for (const [source, requiredPerms] of Object.entries(MODULE_PERMS)) {
    if (requiredPerms.some(p => perms.has(p))) allowed.add(source);
  }
  return allowed;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fmtDate = (d) => (d ? new Date(d).toISOString() : null);

// ── Per-model summary (only display fields, no bulk subdocs) ──────────────────

const summarizers = {
  MR:        (d) => ({ id: d.id, status: d.status, date: fmtDate(d.date || d.createdAt), project: d.project, requesterName: d.requesterName, itemCount: d.items?.length || 0 }),
  Quotation: (d) => ({ id: d.id, status: d.status, date: fmtDate(d.updatedAt || d.createdAt), supplierName: d.supplierName, mrId: d.mrId, amount: d.totalAmount }),
  PO:        (d) => ({ id: d.id, status: d.status, date: fmtDate(d.createdAt), supplier: d.supplier, mrId: d.mrId, quotationId: d.quotationId, amount: d.totalAmount }),
  GRN:       (d) => ({ id: d.id, status: d.status, date: fmtDate(d.receivedDate || d.createdAt), supplier: d.supplier, poId: d.poId, project: d.project }),
  Inward:    (d) => ({ id: d.id, date: fmtDate(d.date || d.createdAt), supplier: d.supplier, grnRef: d.grnRef, project: d.project, type: d.type }),
  Outward:   (d) => ({ id: d.id, date: fmtDate(d.date || d.createdAt), mrId: d.mrId, project: d.project, type: d.type }),
  Account:   (d) => ({ id: d.id, accountStatus: d.accountStatus, date: fmtDate(d.createdAt), supplier: d.supplier, poId: d.poId, amount: d.totalAmount }),
};

const mkEntry = (source, doc) => ({ source, ...summarizers[source](doc) });

// ── Chain resolver ─────────────────────────────────────────────────────────────

async function resolveChain(anchorType, anchorDoc) {
  const map = new Map();
  const seen = new Set();
  const add = (src, doc) => {
    if (!doc?.id) return;
    const key = `${src}:${doc.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    map.set(key, mkEntry(src, doc));
  };

  add(anchorType, anchorDoc);

  let mrDoc = null, poDoc = null;
  const grnDocs = [];

  // ── Pivot: resolve MR and PO from anchor ──────────────────────────────────
  if (anchorType === "MR")        { mrDoc = anchorDoc; }
  if (anchorType === "PO")        { poDoc = anchorDoc; }
  if (anchorType === "Quotation") {
    if (anchorDoc.mrId) mrDoc = await MaterialRequirement.findOne({ id: anchorDoc.mrId }).lean();
    poDoc = await PurchaseOrder.findOne({ $or: [{ quotationId: anchorDoc.id }, { id: anchorDoc.linkedPoId }] }).lean();
  }
  if (anchorType === "GRN") {
    if (anchorDoc.poId) poDoc = await PurchaseOrder.findOne({ id: anchorDoc.poId }).lean();
  }
  if (anchorType === "Inward") {
    const grn = anchorDoc.grnRef ? await GRN.findOne({ id: anchorDoc.grnRef }).lean() : null;
    if (grn) { add("GRN", grn); grnDocs.push(grn); if (grn.poId) poDoc = await PurchaseOrder.findOne({ id: grn.poId }).lean(); }
  }
  if (anchorType === "Account") {
    if (anchorDoc.poId) poDoc = await PurchaseOrder.findOne({ id: anchorDoc.poId }).lean();
  }

  // From PO, resolve MR
  if (poDoc && !mrDoc && poDoc.mrId) mrDoc = await MaterialRequirement.findOne({ id: poDoc.mrId }).lean();

  // ── Add MR and its Quotations ──────────────────────────────────────────────
  if (mrDoc) {
    add("MR", mrDoc);
    const quotes = await Quotation.find({ mrId: mrDoc.id }).lean();
    quotes.forEach(q => add("Quotation", q));
  }

  // ── Resolve POs (from MR or direct) ───────────────────────────────────────
  const pos = mrDoc
    ? await PurchaseOrder.find({ mrId: mrDoc.id }).lean()
    : poDoc ? [poDoc] : [];

  for (const po of pos) {
    add("PO", po);
    if (!mrDoc && po.mrId) { const m = await MaterialRequirement.findOne({ id: po.mrId }).lean(); if (m) add("MR", m); }
    if (po.quotationId) { const q = await Quotation.findOne({ id: po.quotationId }).lean(); if (q) add("Quotation", q); }

    const pGrns = await GRN.find({ poId: po.id }).lean();
    pGrns.forEach(g => { add("GRN", g); grnDocs.push(g); });

    const accs = await AccountEntry.find({ poId: po.id }).lean();
    accs.forEach(a => add("Account", a));

    const outs = await Outward.find({ poId: po.id }).lean();
    outs.forEach(o => add("Outward", o));
  }

  // ── GRN from Account.grnIds ────────────────────────────────────────────────
  if (anchorType === "Account" && anchorDoc.grnIds?.length) {
    const moreGrns = await GRN.find({ id: { $in: anchorDoc.grnIds } }).lean();
    moreGrns.forEach(g => { add("GRN", g); grnDocs.push(g); });
  }

  // ── Inwards for all GRNs collected ────────────────────────────────────────
  for (const grn of grnDocs) {
    const inwards = await Inward.find({ grnRef: grn.id }).lean();
    inwards.forEach(i => add("Inward", i));

    const accs = await AccountEntry.find({ grnIds: grn.id }).lean();
    accs.forEach(a => add("Account", a));
  }

  // ── Outwards linked to MR ─────────────────────────────────────────────────
  if (mrDoc) {
    const outs = await Outward.find({ mrId: mrDoc.id }).lean();
    outs.forEach(o => add("Outward", o));
  }

  return [...map.values()];
}

// ── Vendor / Item cross-search ─────────────────────────────────────────────────

async function searchByVendorOrItem(term) {
  const re = new RegExp(esc(term), "i");
  const LIMIT = 25;

  const [vendor, catItem] = await Promise.all([
    Supplier.findOne({ $or: [{ companyName: re }, { name: re }] }).lean(),
    Catalogue.findOne({ $or: [{ itemName: re }, { sku: { $regex: `^${esc(term)}$`, $options: "i" } }] }).lean(),
  ]);

  if (!vendor && !catItem) return { searchType: "none", data: [] };

  const results = [];

  if (vendor) {
    const vRe = new RegExp(esc(vendor.companyName || vendor.name), "i");
    const [qs, ps, gs, is, os, as] = await Promise.all([
      Quotation.find({ supplierName: vRe }).limit(LIMIT).lean(),
      PurchaseOrder.find({ supplier: vRe }).limit(LIMIT).lean(),
      GRN.find({ supplier: vRe }).limit(LIMIT).lean(),
      Inward.find({ supplier: vRe }).limit(LIMIT).lean(),
      Outward.find({ supplier: vRe }).limit(LIMIT).lean(),
      AccountEntry.find({ supplier: vRe }).limit(LIMIT).lean(),
    ]);
    qs.forEach(d => results.push(mkEntry("Quotation", d)));
    ps.forEach(d => results.push(mkEntry("PO", d)));
    gs.forEach(d => results.push(mkEntry("GRN", d)));
    is.forEach(d => results.push(mkEntry("Inward", d)));
    os.forEach(d => results.push(mkEntry("Outward", d)));
    as.forEach(d => results.push(mkEntry("Account", d)));
  }

  if (catItem) {
    const sku = catItem.sku;
    const [mrs, ps, gs] = await Promise.all([
      MaterialRequirement.find({ "items.sku": sku }).limit(LIMIT).lean(),
      PurchaseOrder.find({ "items.sku": sku }).limit(LIMIT).lean(),
      GRN.find({ "items.sku": sku }).limit(LIMIT).lean(),
    ]);
    mrs.forEach(d => results.push({ ...mkEntry("MR", d), matchedSku: sku }));
    ps.forEach(d => results.push({ ...mkEntry("PO", d), matchedSku: sku }));
    gs.forEach(d => results.push({ ...mkEntry("GRN", d), matchedSku: sku }));
  }

  // Deduplicate by source:id
  const seen = new Set();
  const deduped = results.filter(r => {
    const k = `${r.source}:${r.id}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  return {
    searchType: vendor ? "vendor" : "item",
    matchedName: vendor ? (vendor.companyName || vendor.name) : catItem.itemName,
    matchedSku: catItem?.sku || null,
    data: deduped,
  };
}

// ── Route ──────────────────────────────────────────────────────────────────────

router.get("/search", authenticate, async (req, res) => {
  try {
    const q = req.query.q?.trim();
    if (!q) return res.json({ success: true, searchType: "none", anchor: null, data: [] });

    // Detect module by ID prefix
    let anchorType = null, anchorDoc = null;
    const term = q.toUpperCase();

    if (term.startsWith("MR-")) {
      anchorType = "MR";
      anchorDoc = await MaterialRequirement.findOne({ $or: [{ id: new RegExp(`^${esc(q)}$`, "i") }, { mrNumber: new RegExp(`^${esc(q)}$`, "i") }] }).lean();
    } else if (term.startsWith("QT-")) {
      anchorType = "Quotation";
      anchorDoc = await Quotation.findOne({ id: new RegExp(`^${esc(q)}$`, "i") }).lean();
    } else if (term.startsWith("PO-")) {
      anchorType = "PO";
      anchorDoc = await PurchaseOrder.findOne({ id: new RegExp(`^${esc(q)}$`, "i") }).lean();
    } else if (term.startsWith("GRN-")) {
      anchorType = "GRN";
      anchorDoc = await GRN.findOne({ id: new RegExp(`^${esc(q)}$`, "i") }).lean();
    } else if (term.startsWith("IN-")) {
      anchorType = "Inward";
      anchorDoc = await Inward.findOne({ id: new RegExp(`^${esc(q)}$`, "i") }).lean();
    } else if (term.startsWith("OUT-")) {
      anchorType = "Outward";
      anchorDoc = await Outward.findOne({ id: new RegExp(`^${esc(q)}$`, "i") }).lean();
    } else if (term.startsWith("ACC-")) {
      anchorType = "Account";
      anchorDoc = await AccountEntry.findOne({ id: new RegExp(`^${esc(q)}$`, "i") }).lean();
    }

    // Resolve allowed sources for this user (null = admin, no filter)
    const allowedSources = await getAllowedSources(req.user);
    const filterByAccess = (items) =>
      allowedSources ? items.filter(i => allowedSources.has(i.source)) : items;

    // If prefix matched but no doc found — fall through to vendor/item search
    if (anchorType && !anchorDoc) {
      return res.json({ success: true, searchType: "not_found", anchor: { source: anchorType, id: q }, data: [] });
    }

    if (anchorType && anchorDoc) {
      // Check user can access the anchor module itself
      if (allowedSources && !allowedSources.has(anchorType)) {
        return res.status(403).json({ success: false, message: "Access denied for this record type" });
      }
      const data = filterByAccess(await resolveChain(anchorType, anchorDoc));
      data.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
      return res.json({ success: true, searchType: "chain", anchor: { source: anchorType, id: q }, data });
    }

    // Vendor / Item fallback
    const result = await searchByVendorOrItem(q);
    result.data = filterByAccess(result.data);
    result.data.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    return res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
