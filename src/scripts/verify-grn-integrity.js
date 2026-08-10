/**
 * verify-grn-integrity.js
 *
 * Verification script for the GRN consolidation.
 * Run this BEFORE migration (to see problem) and AFTER (to confirm clean state).
 *
 * Usage:
 *   node src/scripts/verify-grn-integrity.js
 */

import "dotenv/config";
import mongoose from "mongoose";
import { GRN, Inward, Transaction } from "../models/index.js";

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error("MONGODB_URI not set"); process.exit(1); }
  await mongoose.connect(uri);
  console.log("Connected.\n");

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      const result = await fn();
      if (result.ok) {
        console.log(`  ✅  PASS: ${name}`);
        if (result.detail) console.log(`         ${result.detail}`);
        passed++;
      } else {
        console.log(`  ❌  FAIL: ${name}`);
        console.log(`         ${result.detail}`);
        failed++;
      }
    } catch (err) {
      console.log(`  💥  ERROR: ${name} — ${err.message}`);
      failed++;
    }
  }

  console.log("=== GRN INTEGRITY TESTS ===\n");

  // TEST 1: No PO should have more than one active GRN
  await test("T1 — One active GRN per PO", async () => {
    const dups = await GRN.aggregate([
      { $match: { poId: { $exists: true, $ne: null, $gt: "" }, status: { $ne: "Merged" }, isActive: { $ne: false } } },
      { $group: { _id: "$poId", count: { $sum: 1 }, ids: { $push: "$id" } } },
      { $match: { count: { $gt: 1 } } }
    ]);
    if (dups.length === 0) return { ok: true, detail: "No PO has multiple active GRNs" };
    return { ok: false, detail: `${dups.length} PO(s) still have multiple active GRNs: ${dups.map(d => `${d._id} (${d.ids.join(", ")})`).join(" | ")}` };
  });

  // TEST 2: All merged GRNs must have a valid mergedInto field pointing to an active GRN
  await test("T2 — Merged GRNs have valid mergedInto pointer", async () => {
    const merged = await GRN.find({ status: "Merged" }, { id: 1, mergedInto: 1 }).lean();
    const broken = [];
    for (const g of merged) {
      if (!g.mergedInto) { broken.push(`${g.id}: no mergedInto`); continue; }
      const target = await GRN.findOne({ id: g.mergedInto, status: { $ne: "Merged" } }, { id: 1 }).lean();
      if (!target) broken.push(`${g.id}: mergedInto="${g.mergedInto}" does not exist or is itself merged`);
    }
    if (!broken.length) return { ok: true, detail: `${merged.length} merged GRN(s) all have valid pointers` };
    return { ok: false, detail: broken.join("; ") };
  });

  // TEST 3: Inventory totals not modified (basic sanity — no negative liveStock)
  await test("T3 — No negative inventory liveStock", async () => {
    const { Inventory } = await import("../models/index.js");
    const bad = await Inventory.find({ liveStock: { $lt: 0 } }, { sku: 1, liveStock: 1 }).lean();
    if (!bad.length) return { ok: true, detail: "All inventory liveStock >= 0" };
    return { ok: false, detail: `${bad.length} SKU(s) have negative liveStock: ${bad.map(b => `${b.sku}=${b.liveStock}`).join(", ")}` };
  });

  // TEST 4: No duplicate Inward records per GRN (grnRef should be unique per inward)
  await test("T4 — No duplicate Inward records per GRN", async () => {
    const dups = await Inward.aggregate([
      { $match: { grnRef: { $exists: true, $ne: null } } },
      { $group: { _id: "$grnRef", count: { $sum: 1 }, ids: { $push: "$id" } } },
      { $match: { count: { $gt: 1 } } }
    ]);
    if (!dups.length) return { ok: true, detail: "No duplicate Inward records found" };
    return { ok: false, detail: `${dups.length} GRN(s) have multiple Inward records: ${dups.map(d => d._id).join(", ")}` };
  });

  // TEST 5: No Inward record points to a merged GRN
  await test("T5 — Inward records point to active GRNs only", async () => {
    const mergedIds = (await GRN.find({ status: "Merged" }, { id: 1 }).lean()).map(g => g.id);
    if (!mergedIds.length) return { ok: true, detail: "No merged GRNs in DB" };
    const orphaned = await Inward.find({ grnRef: { $in: mergedIds } }, { id: 1, grnRef: 1 }).lean();
    if (!orphaned.length) return { ok: true, detail: "All Inward records point to active GRNs" };
    return { ok: false, detail: `${orphaned.length} Inward record(s) still point to merged GRNs` };
  });

  // TEST 6: No Transaction record points to a merged GRN
  await test("T6 — Transaction records point to active GRNs only", async () => {
    const mergedIds = (await GRN.find({ status: "Merged" }, { id: 1 }).lean()).map(g => g.id);
    if (!mergedIds.length) return { ok: true, detail: "No merged GRNs in DB" };
    const orphaned = await Transaction.find({ linkId: { $in: mergedIds } }, { id: 1, linkId: 1 }).lean();
    if (!orphaned.length) return { ok: true, detail: "All Transaction records point to active GRNs" };
    return { ok: false, detail: `${orphaned.length} Transaction record(s) still point to merged GRNs` };
  });

  // TEST 7: Different PO GRNs are never merged into each other
  await test("T7 — Cross-PO merges never occurred", async () => {
    const merged = await GRN.find({ status: "Merged", mergedInto: { $exists: true, $ne: null } }, { id: 1, poId: 1, mergedInto: 1 }).lean();
    const crossPO = [];
    for (const src of merged) {
      const target = await GRN.findOne({ id: src.mergedInto }, { id: 1, poId: 1 }).lean();
      if (target && target.poId && src.poId && target.poId !== src.poId) {
        crossPO.push(`${src.id} (PO: ${src.poId}) merged into ${src.mergedInto} (PO: ${target.poId})`);
      }
    }
    if (!crossPO.length) return { ok: true, detail: "No cross-PO merges detected" };
    return { ok: false, detail: `CROSS-PO MERGE DETECTED: ${crossPO.join("; ")}` };
  });

  // TEST 8: Active GRN target has receipts[] for each merged source
  await test("T8 — Merged sources have their data folded into target receipts", async () => {
    const merged = await GRN.find({ status: "Merged", mergedInto: { $exists: true, $ne: null } }, { id: 1, challan: 1, mergedInto: 1 }).lean();
    const issues = [];
    for (const src of merged) {
      if (!src.challan) continue;
      const target = await GRN.findOne({ id: src.mergedInto }, { challan: 1, receipts: 1 }).lean();
      if (!target) continue;
      const found = target.challan === src.challan || (target.receipts || []).some(r => r.challan === src.challan);
      if (!found) issues.push(`Source ${src.id} challan "${src.challan}" not found in target ${src.mergedInto}`);
    }
    if (!issues.length) return { ok: true, detail: `${merged.length} source(s) verified — challan data present in targets` };
    return { ok: false, detail: issues.join("; ") };
  });

  // TEST 9: Summary stats
  const totalGRNs   = await GRN.countDocuments({});
  const activeGRNs  = await GRN.countDocuments({ status: { $ne: "Merged" }, isActive: { $ne: false } });
  const mergedGRNs  = await GRN.countDocuments({ status: "Merged" });

  console.log(`\n=== DB STATS ===`);
  console.log(`  Total GRN documents : ${totalGRNs}`);
  console.log(`  Active GRNs         : ${activeGRNs}`);
  console.log(`  Merged GRNs         : ${mergedGRNs}`);

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);

  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal:", err);
  mongoose.disconnect().finally(() => process.exit(1));
});
