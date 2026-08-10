/**
 * safe-merge-grns.js
 *
 * Consolidates duplicate GRN documents (multiple active GRNs for the same PO)
 * into a single GRN per PO by folding source GRNs into the oldest target GRN
 * as receipt batches.
 *
 * SAFETY GUARANTEES:
 *   - Source GRNs are NOT hard-deleted; they are marked { status: "Merged", isActive: false }.
 *   - Inventory quantities (liveStock, allocatedQty, availableQty, issuedQty) are UNTOUCHED.
 *   - No new Inward or Transaction records are created.
 *   - Inward/Transaction records are re-pointed from source GRN ID → target GRN ID.
 *   - The script is IDEMPOTENT: running it twice produces the same result.
 *
 * USAGE:
 *   Dry run (inspect only, no writes):
 *     node src/scripts/safe-merge-grns.js --dry-run
 *
 *   Actual migration:
 *     node src/scripts/safe-merge-grns.js
 *
 *   Apply partial-unique index after clean data (run AFTER migration):
 *     node src/scripts/safe-merge-grns.js --apply-index
 *
 * IMPORTANT: Run the dry-run first, review output, then run actual migration.
 */

import "dotenv/config";
import mongoose from "mongoose";
import { GRN, Inward, Transaction } from "../models/index.js";

const DRY_RUN    = process.argv.includes("--dry-run");
const APPLY_IDX  = process.argv.includes("--apply-index");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("ERROR: MONGODB_URI is not set in environment.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB.\n");

  if (DRY_RUN) {
    console.log("===== GRN CONSOLIDATION DRY RUN — no writes will occur =====\n");
  } else if (!APPLY_IDX) {
    console.log("===== GRN CONSOLIDATION — ACTUAL MIGRATION =====\n");
  }

  if (!APPLY_IDX) {
    await runMigration();
  }

  if (APPLY_IDX) {
    await applyUniqueIndex();
  }

  await mongoose.disconnect();
  console.log("\nDone.");
}

async function runMigration() {
  // Load all active (non-merged) GRNs
  const activeGRNs = await GRN.find({
    status: { $ne: "Merged" },
    isActive: { $ne: false },
    poId:   { $exists: true, $ne: null, $gt: "" }
  }).lean();

  console.log(`Total active GRNs with a poId: ${activeGRNs.length}`);

  // Group by poId
  const byPO = new Map();
  for (const grn of activeGRNs) {
    if (!byPO.has(grn.poId)) byPO.set(grn.poId, []);
    byPO.get(grn.poId).push(grn);
  }

  // Find POs with duplicates
  const duplicatePOs = [];
  for (const [poId, grns] of byPO) {
    if (grns.length > 1) {
      // Sort by createdAt ascending — oldest becomes the target
      grns.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      duplicatePOs.push({ poId, grns });
    }
  }

  if (duplicatePOs.length === 0) {
    console.log("✅  No duplicate GRN groups found. Nothing to merge.\n");
    return;
  }

  console.log(`Duplicate PO groups found: ${duplicatePOs.length}\n`);

  let totalGRNsMerged  = 0;
  let totalShipments   = 0;

  for (const { poId, grns } of duplicatePOs) {
    const [target, ...sources] = grns;
    const totalShipmentsFromSources = sources.reduce((s, src) => s + 1 + (src.receipts?.length || 0), 0);

    console.log(`PO ${poId}`);
    console.log(`  Target  : ${target.id}  (${target.date || "no-date"}, status: ${target.status})`);
    for (const src of sources) {
      console.log(`  Merging : ${src.id}  (${src.date || "no-date"}, status: ${src.status}, receipts: ${src.receipts?.length || 0})`);
    }
    console.log(`  Shipments to add from sources: ${totalShipmentsFromSources}`);

    const skuSet = new Set();
    sources.forEach(src => {
      (src.items || []).forEach(i => { if (i.sku) skuSet.add(i.sku); });
      (src.receipts || []).forEach(r => (r.items || []).forEach(i => { if (i.sku) skuSet.add(i.sku); }));
    });
    console.log(`  Materials (SKUs) from sources: ${skuSet.size}`);
    console.log();

    if (DRY_RUN) {
      totalGRNsMerged  += sources.length;
      totalShipments   += totalShipmentsFromSources;
      continue;
    }

    // ── ACTUAL MERGE ──────────────────────────────────────────────────────────
    const targetDoc = await GRN.findOne({ id: target.id });
    if (!targetDoc) {
      console.warn(`  WARNING: Target GRN ${target.id} not found in DB — skipping.`);
      continue;
    }
    targetDoc.receipts = targetDoc.receipts || [];

    for (const src of sources) {
      // Skip already-merged sources (idempotency guard)
      const srcDoc = await GRN.findOne({ id: src.id });
      if (!srcDoc) {
        console.warn(`  WARNING: Source GRN ${src.id} not found — skipping.`);
        continue;
      }
      if (srcDoc.status === "Merged" || srcDoc.isActive === false) {
        console.log(`  SKIP (already merged): ${src.id}`);
        continue;
      }

      const srcObj = srcDoc.toObject();

      // Idempotency: avoid adding a receipt whose challan already exists on target
      const existingChallans = new Set([
        targetDoc.challan,
        ...(targetDoc.receipts || []).map(r => r.challan).filter(Boolean)
      ]);

      // Convert source's root delivery into a receipt batch on the target
      const rootItems = (srcObj.items || []).filter(i => (i.received || 0) > 0);
      if (rootItems.length > 0 && !existingChallans.has(srcObj.challan)) {
        targetDoc.receipts.push({
          date:          srcObj.date,
          challan:       srcObj.challan,
          mrNo:          srcObj.mrNo,
          docType:       srcObj.docType,
          personName:    srcObj.personName,
          challanPhotos: srcObj.challanPhotos || [],
          personPhotos:  srcObj.personPhotos  || [],
          items: rootItems.map(i => ({
            sku:      i.sku,
            itemName: i.itemName,
            received: i.received || 0,
            images:   i.images   || []
          })),
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
        existingChallans.add(srcObj.challan);
        totalShipments++;
      }

      // Carry over source's own receipt batches
      for (const r of (srcObj.receipts || [])) {
        if (!existingChallans.has(r.challan)) {
          targetDoc.receipts.push(r);
          if (r.challan) existingChallans.add(r.challan);
          totalShipments++;
        }
      }

      // Accumulate source received qtys into target items[] (keeps GRN totals correct)
      const qtyBySKU = {};
      (srcObj.items || []).forEach(i => { qtyBySKU[i.sku] = (qtyBySKU[i.sku] || 0) + (i.received || 0); });

      targetDoc.items = targetDoc.items.map(item => {
        const obj = item.toObject ? item.toObject() : { ...item };
        const added = qtyBySKU[obj.sku] || 0;
        if (!added) return obj;
        const totalReceived = (obj.received || 0) + added;
        return { ...obj, received: totalReceived, variance: totalReceived - (obj.ordered || 0) };
      });

      // Add any new SKUs that only exist in source
      for (const [sku, qty] of Object.entries(qtyBySKU)) {
        const exists = targetDoc.items.some(i => (i.toObject ? i.toObject() : i).sku === sku);
        if (!exists) {
          const si = srcObj.items.find(i => i.sku === sku) || {};
          targetDoc.items.push({ sku, itemName: si.itemName || sku, ordered: 0, received: qty, variance: qty, unit: si.unit || "NOS", images: si.images || [] });
        }
      }

      // Mark source as merged (soft-delete, preserves all history)
      await GRN.findOneAndUpdate(
        { id: srcDoc.id },
        { status: "Merged", isActive: false, mergedInto: target.id }
      );

      // Re-point Inward records from source → target (history preserved, just re-linked)
      const inwUpdate = await Inward.updateMany({ grnRef: srcDoc.id }, { grnRef: target.id });
      // Re-point Transaction records from source → target
      const trxUpdate = await Transaction.updateMany({ linkId: srcDoc.id }, { linkId: target.id });

      console.log(`  ✓ Merged ${srcDoc.id} → ${target.id} | Inward re-linked: ${inwUpdate.modifiedCount} | Txn re-linked: ${trxUpdate.modifiedCount}`);
      totalGRNsMerged++;
    }

    // Recalculate target GRN status from consolidated items
    const hasShortage = targetDoc.items.some(i => { const o = i.toObject ? i.toObject() : i; return (o.received || 0) < (o.ordered || 0); });
    const hasExcess   = targetDoc.items.some(i => { const o = i.toObject ? i.toObject() : i; return (o.received || 0) > (o.ordered || 0); });
    targetDoc.status = hasShortage ? "Partial" : hasExcess ? "Over-Received" : "Confirmed";
    targetDoc.markModified("items");
    targetDoc.markModified("receipts");
    await targetDoc.save();
    console.log(`  ✓ Target ${target.id} saved — new status: ${targetDoc.status}\n`);
  }

  console.log("─────────────────────────────────────────────────────────────");
  if (DRY_RUN) {
    console.log("DRY RUN SUMMARY (no data was changed):");
    console.log(`  Duplicate PO groups    : ${duplicatePOs.length}`);
    console.log(`  GRNs that would merge  : ${totalGRNsMerged}`);
    console.log(`  Shipments to consolidate: ${totalShipments}`);
    console.log(`  Inventory modified     : NO`);
    console.log(`  Transactions modified  : NO (Inward/Transaction re-linked, not altered)`);
    console.log("\nRun WITHOUT --dry-run to execute the migration.");
  } else {
    console.log("MIGRATION COMPLETE:");
    console.log(`  GRNs merged            : ${totalGRNsMerged}`);
    console.log(`  Shipments consolidated : ${totalShipments}`);
    console.log(`  Inventory modified     : NO`);
    console.log(`  Transactions created   : NONE`);
    console.log(`\nNext step (optional): apply the unique index to prevent future duplicates:`);
    console.log(`  node src/scripts/safe-merge-grns.js --apply-index`);
  }
}

async function applyUniqueIndex() {
  console.log("===== APPLYING PARTIAL UNIQUE INDEX =====\n");

  // Safety check: abort if any PO still has multiple active GRNs
  const duplicates = await GRN.aggregate([
    { $match: { poId: { $exists: true, $ne: null, $gt: "" }, status: { $ne: "Merged" }, isActive: { $ne: false } } },
    { $group: { _id: "$poId", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]);

  if (duplicates.length > 0) {
    console.error("ERROR: Duplicate active GRNs still exist for the following POs:");
    duplicates.forEach(d => console.error(`  PO ${d._id}: ${d.count} active GRNs`));
    console.error("\nRun the migration first: node src/scripts/safe-merge-grns.js");
    console.error("Then re-run with --apply-index.");
    process.exit(1);
  }

  try {
    await GRN.collection.createIndex(
      { poId: 1 },
      {
        unique: true,
        name: "one_active_grn_per_po",
        partialFilterExpression: {
          isActive: true,
          poId: { $type: "string", $gt: "" }
        }
      }
    );
    console.log("✅  Partial unique index 'one_active_grn_per_po' created on { poId: 1 }.");
    console.log("    Constraint: unique only where isActive=true and poId is a non-empty string.");
  } catch (err) {
    if (err.code === 85 || err.code === 86) {
      console.log("ℹ️   Index already exists — no action needed.");
    } else {
      throw err;
    }
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  mongoose.disconnect().finally(() => process.exit(1));
});
