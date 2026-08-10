/**
 * inward-vs-inventory.js
 * Compares current inventory liveStock vs total received from Inward records.
 * Shows discrepancies and optionally overwrites liveStock from Inward totals.
 *
 * Usage:
 *   node src/scripts/inward-vs-inventory.js            ← analysis only
 *   node src/scripts/inward-vs-inventory.js --apply    ← overwrite liveStock from inward
 */
import "dotenv/config";
import mongoose from "mongoose";
import { Inventory, Inward } from "../models/index.js";

const APPLY = process.argv.includes("--apply");

await mongoose.connect(process.env.MONGODB_URI);
console.log(`\n=== INWARD vs INVENTORY ${APPLY ? "(APPLY)" : "(ANALYSIS ONLY)"} ===\n`);

// Sum all inward qty per SKU
const inwardDocs = await Inward.find({}).lean();
const inwardBySku = {};
for (const doc of inwardDocs) {
  const sku = doc.sku;
  if (!sku) continue;
  inwardBySku[sku] = (inwardBySku[sku] || 0) + (doc.qty || 0);
}

// Get all inventory items
const invItems = await Inventory.find({}).lean();
const invBySku = {};
for (const item of invItems) {
  if (item.sku) invBySku[item.sku] = item;
}

// Find discrepancies
const higher   = []; // liveStock > inward total (over-counted)
const lower    = []; // liveStock < inward total (under-counted, or outward not tracked)
const noInward = []; // inventory item with 0 inward records
const matched  = [];

for (const item of invItems) {
  const sku      = item.sku;
  const live     = item.liveStock ?? 0;
  const inTotal  = inwardBySku[sku] ?? 0;
  const diff     = live - inTotal;

  if (inTotal === 0 && live !== 0)   noInward.push({ sku, itemName: item.itemName || item.name, live, inTotal, diff });
  else if (Math.abs(diff) < 0.01)   matched.push(sku);
  else if (diff > 0)                 higher.push({ sku, itemName: item.itemName || item.name, live, inTotal, diff });
  else                               lower.push({ sku, itemName: item.itemName || item.name, live, inTotal, diff });
}

const fmt = (r) =>
  `  ${r.sku.padEnd(16)} "${(r.itemName||"").substring(0,28).padEnd(30)}"  live:${String(r.live).padStart(8)}  inward:${String(r.inTotal).padStart(8)}  diff:${String(r.diff.toFixed(2)).padStart(8)}`;

console.log(`=== liveStock HIGHER than Inward total (${higher.length} SKUs) ===`);
higher.slice(0, 20).forEach(r => console.log(fmt(r)));
if (higher.length > 20) console.log(`  ... and ${higher.length - 20} more`);

console.log(`\n=== liveStock LOWER than Inward total (${lower.length} SKUs) ===`);
lower.slice(0, 20).forEach(r => console.log(fmt(r)));
if (lower.length > 20) console.log(`  ... and ${lower.length - 20} more`);

console.log(`\n=== Inventory items with NO Inward records (${noInward.length} SKUs) ===`);
noInward.slice(0, 20).forEach(r => console.log(fmt(r)));
if (noInward.length > 20) console.log(`  ... and ${noInward.length - 20} more`);

console.log(`\n=== SUMMARY ===`);
console.log(`  Total inventory SKUs     : ${invItems.length}`);
console.log(`  Total Inward records     : ${inwardDocs.length}`);
console.log(`  Matched (no diff)        : ${matched.length}`);
console.log(`  liveStock > inward       : ${higher.length}`);
console.log(`  liveStock < inward       : ${lower.length}`);
console.log(`  No inward records        : ${noInward.length}`);

if (!APPLY) {
  console.log(`\nTo overwrite liveStock from Inward totals, run:`);
  console.log(`  node src/scripts/inward-vs-inventory.js --apply`);
  await mongoose.disconnect();
  process.exit(0);
}

// ── APPLY: overwrite liveStock = inward total ──────────────────────────────
console.log(`\nApplying overwrite — liveStock = total inward received per SKU...`);
let updated = 0;
const allSkus = new Set([...Object.keys(inwardBySku), ...invItems.map(i => i.sku).filter(Boolean)]);

for (const sku of allSkus) {
  const inTotal  = inwardBySku[sku] ?? 0;
  const item     = invBySku[sku];
  if (!item) continue; // skip if not in inventory
  const oldLive  = item.liveStock ?? 0;
  if (Math.abs(oldLive - inTotal) < 0.01) continue; // already correct
  const newAvail = Math.max(0, inTotal - (item.allocatedQty || 0));
  await Inventory.findOneAndUpdate(
    { sku },
    { $set: { liveStock: inTotal, availableQty: newAvail } }
  );
  console.log(`  ✓ ${sku.padEnd(16)}  ${oldLive} → ${inTotal}`);
  updated++;
}

console.log(`\nUpdated: ${updated} SKU(s)`);
await mongoose.disconnect();
