/**
 * analyze-inventory.js
 * Shows all inventory discrepancies: current liveStock vs recomputed from transactions.
 * Run: node src/scripts/analyze-inventory.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import { Inventory, Transaction } from "../models/index.js";

await mongoose.connect(process.env.MONGODB_URI);

// Get all inventory items
const items = await Inventory.find({}).lean();

// Get all transactions grouped by SKU
const txns = await Transaction.find({
  type: { $in: ["Inward", "Outward", "Issue", "Return", "Transfer", "Adjustment"] }
}).lean();

// Build per-SKU transaction totals
const bysku = {};
for (const t of txns) {
  const sku = t.sku;
  if (!sku) continue;
  if (!bysku[sku]) bysku[sku] = { inward: 0, outward: 0, adjustment: 0, txnCount: 0 };
  bysku[sku].txnCount++;
  const qty = t.qty ?? t.quantity ?? 0;
  if (["Inward"].includes(t.type))                bysku[sku].inward     += qty;
  else if (["Outward","Issue"].includes(t.type))   bysku[sku].outward    += qty;
  else if (["Return"].includes(t.type))            bysku[sku].inward     += qty; // returns go back to stock
  else if (["Adjustment"].includes(t.type))        bysku[sku].adjustment += qty; // can be +/-
}

console.log("\n=== INVENTORY ANALYSIS ===\n");
console.log("Checking all items...\n");

const negatives   = [];
const mismatches  = [];

for (const item of items) {
  const sku  = item.sku;
  const live = item.liveStock ?? 0;
  const t    = bysku[sku] || { inward: 0, outward: 0, adjustment: 0, txnCount: 0 };
  const computed = t.inward - t.outward + t.adjustment;
  const diff = live - computed;

  if (live < 0) {
    negatives.push({ sku, itemName: item.itemName || item.name, live, computed, diff, txns: t });
  } else if (Math.abs(diff) > 0.01) {
    mismatches.push({ sku, itemName: item.itemName || item.name, live, computed, diff, txns: t });
  }
}

console.log(`=== NEGATIVE liveStock (${negatives.length} SKUs) ===`);
negatives.forEach(({ sku, itemName, live, computed, diff, txns }) => {
  console.log(`  ${sku.padEnd(16)} "${(itemName||"").substring(0,30).padEnd(32)}"  live:${String(live).padStart(8)}  computed:${String(computed.toFixed(2)).padStart(8)}  diff:${String(diff.toFixed(2)).padStart(8)}  (in:${txns.inward} out:${txns.outward} adj:${txns.adjustment})`);
});

console.log(`\n=== liveStock MISMATCH vs Transactions (${mismatches.length} SKUs) ===`);
if (mismatches.length === 0) {
  console.log("  None — liveStock matches transaction history for all non-negative items.");
} else {
  mismatches.slice(0, 30).forEach(({ sku, itemName, live, computed, diff, txns }) => {
    const flag = Math.abs(diff) > 10 ? " ⚠️ LARGE" : "";
    console.log(`  ${sku.padEnd(16)} "${(itemName||"").substring(0,30).padEnd(32)}"  live:${String(live).padStart(8)}  computed:${String(computed.toFixed(2)).padStart(8)}  diff:${String(diff.toFixed(2)).padStart(8)}${flag}`);
  });
  if (mismatches.length > 30) console.log(`  ... and ${mismatches.length - 30} more`);
}

console.log(`\n=== SUMMARY ===`);
console.log(`  Total inventory SKUs   : ${items.length}`);
console.log(`  Negative liveStock     : ${negatives.length}`);
console.log(`  Mismatch vs txns       : ${mismatches.length}`);
console.log(`  Total transactions     : ${txns.length}`);

await mongoose.disconnect();
