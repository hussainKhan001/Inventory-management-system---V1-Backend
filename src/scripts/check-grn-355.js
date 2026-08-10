import "dotenv/config";
import mongoose from "mongoose";
import { GRN } from "../models/index.js";

await mongoose.connect(process.env.MONGODB_URI);

const grn = await GRN.findOne({ id: "GRN-2026-355" }).lean();
if (!grn) { console.log("GRN-2026-355 not found"); process.exit(1); }

console.log(`\nGRN-2026-355  status: ${grn.status}\n`);
console.log("=== ROOT ITEMS (running totals) ===");
grn.items.forEach(i => {
  console.log(`  ${i.sku.padEnd(15)} ${i.itemName?.substring(0,30).padEnd(32)} ordered:${String(i.ordered||0).padStart(6)}  received:${String(i.received||0).padStart(6)}  variance:${String(i.variance||0).padStart(6)}`);
});

console.log(`\n=== SHIPMENTS (${1 + (grn.receipts?.length||0)} total) ===`);

console.log(`\n  Shipment 1 (root)  challan:${grn.challan}  date:${grn.date}  by:${grn.personName}`);
(grn.items||[]).filter(i=>(i.received||0)>0).forEach(i => {
  console.log(`    ${i.sku.padEnd(15)} +${i.received}`);
});

(grn.receipts||[]).forEach((r, idx) => {
  console.log(`\n  Shipment ${idx+2} (receipt)  challan:${r.challan}  date:${r.date}  by:${r.personName}`);
  (r.items||[]).forEach(i => {
    console.log(`    ${i.sku.padEnd(15)} +${i.received}`);
  });
});

console.log("\n=== VARIANCE CHECK ===");
console.log("Re-computing received from receipts[]...");
const receiptTotals = {};
// Shipment 1 contributions (from items[] but only those that represent initial delivery)
// The root items[].received is the RUNNING TOTAL — so we need to sum receipt items separately
(grn.receipts||[]).forEach(r => {
  (r.items||[]).forEach(i => {
    receiptTotals[i.sku] = (receiptTotals[i.sku]||0) + (i.received||0);
  });
});

// Items total should = shipment1 qty + all receipt qtys
// Shipment 1 qty = root items[].received (which was set at creation)
// But after merge, root items[].received = shipment1 + receipts[] sum
// Let's check if sum of receipts + any "original shipment 1 only" matches items[].received

console.log("\nReceipt-only totals (Shipment 2..N):");
Object.entries(receiptTotals).forEach(([sku, qty]) => console.log(`  ${sku}: ${qty}`));

console.log("\nItems received vs (items.received - receiptTotal) = implies Shipment1 qty:");
grn.items.forEach(i => {
  const fromReceipts = receiptTotals[i.sku]||0;
  const impliedS1 = (i.received||0) - fromReceipts;
  const flag = impliedS1 < 0 ? " ⚠️ NEGATIVE" : "";
  console.log(`  ${i.sku.padEnd(15)} total:${String(i.received||0).padStart(6)}  from receipts:${String(fromReceipts).padStart(6)}  implied S1:${String(impliedS1).padStart(6)}${flag}`);
});

await mongoose.disconnect();
