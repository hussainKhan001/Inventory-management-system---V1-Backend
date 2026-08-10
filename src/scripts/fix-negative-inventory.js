/**
 * fix-negative-inventory.js
 * Sets liveStock (and derived availableQty) to 0 for any SKU where liveStock < 0.
 * Physical stock cannot be negative — these arose from legacy/manual issuances
 * with no corresponding inward records.
 *
 * Usage:
 *   Dry run : node src/scripts/fix-negative-inventory.js --dry-run
 *   Apply   : node src/scripts/fix-negative-inventory.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import { Inventory } from "../models/index.js";

const DRY_RUN = process.argv.includes("--dry-run");

await mongoose.connect(process.env.MONGODB_URI);
console.log(`\n=== FIX NEGATIVE INVENTORY ${DRY_RUN ? "(DRY RUN)" : "(ACTUAL)"} ===\n`);

const negatives = await Inventory.find({ liveStock: { $lt: 0 } }).lean();
console.log(`Found ${negatives.length} SKU(s) with negative liveStock:\n`);

negatives.forEach(i => {
  const avail = (i.liveStock || 0) - (i.allocatedQty || 0);
  console.log(`  ${i.sku.padEnd(16)} "${(i.itemName || i.name || "").substring(0, 32).padEnd(34)}"  liveStock:${String(i.liveStock).padStart(7)}  allocatedQty:${String(i.allocatedQty||0).padStart(5)}  → will set liveStock=0, availableQty=0`);
});

if (DRY_RUN) {
  console.log("\nDRY RUN — no changes made. Run without --dry-run to apply.");
  await mongoose.disconnect();
  process.exit(0);
}

console.log("\nApplying fixes...");
let fixed = 0;
for (const item of negatives) {
  const newAvailable = Math.max(0, 0 - (item.allocatedQty || 0)); // clamp at 0
  await Inventory.findOneAndUpdate(
    { sku: item.sku },
    { $set: { liveStock: 0, availableQty: newAvailable } }
  );
  console.log(`  ✓ ${item.sku}  liveStock: ${item.liveStock} → 0`);
  fixed++;
}

console.log(`\nFixed: ${fixed} SKU(s)`);
console.log("Inventory negative values cleared.");
await mongoose.disconnect();
