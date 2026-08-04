// Merge GRN-2026-346 into GRN-2026-176 as a new shipment, then delete GRN-2026-346
// Run: node merge-grns.js

import dotenv from "dotenv";
import mongoose from "mongoose";
import { GRN } from "./src/models/index.js";

dotenv.config();

const SOURCE_ID = "GRN-2026-346"; // will be deleted after merge
const TARGET_ID = "GRN-2026-176"; // will receive the new shipment

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");

  const source = await GRN.findOne({ id: SOURCE_ID }).lean();
  const target = await GRN.findOne({ id: TARGET_ID });

  if (!source) { console.error(`ERROR: ${SOURCE_ID} not found`); process.exit(1); }
  if (!target) { console.error(`ERROR: ${TARGET_ID} not found`); process.exit(1); }

  console.log(`\nSource ${SOURCE_ID}: ${source.items?.length} items, challan=${source.challan}`);
  console.log(`Target ${TARGET_ID}: ${target.items?.length} items, ${target.receipts?.length} receipts so far`);

  // Build new receipt from source GRN top-level data
  const newReceipt = {
    date:          source.date,
    challan:       source.challan,
    mrNo:          source.mrNo,
    docType:       source.docType || "Challan",
    personName:    source.personName || "",
    challanPhotos: source.challanPhotos || [],
    personPhotos:  source.personPhotos  || [],
    items: (source.items || [])
      .filter(it => (it.received || 0) > 0)
      .map(it => ({
        sku:      it.sku,
        itemName: it.itemName,
        received: it.received,
        images:   it.images || [],
      })),
  };

  console.log(`\nNew receipt items (received > 0):`);
  newReceipt.items.forEach(it => console.log(`  ${it.itemName}: +${it.received}`));

  // Merge received quantities into target items
  const extraBySku = {};
  (source.items || []).forEach(it => {
    if ((it.received || 0) > 0) extraBySku[it.sku] = it.received;
  });

  for (const item of target.items) {
    const add = extraBySku[item.sku] || 0;
    if (add > 0) {
      item.received = (item.received || 0) + add;
      item.variance = item.received - (item.ordered || 0);
      console.log(`  Updated ${item.itemName}: received=${item.received}, variance=${item.variance}`);
    }
  }
  target.markModified("items");

  // Push the new receipt
  target.receipts.push(newReceipt);

  // Recalculate status
  const hasShortage = target.items.some(it => (it.received || 0) < (it.ordered || 0));
  const hasExcess   = target.items.some(it => (it.received || 0) > (it.ordered || 0));
  target.status = hasShortage ? "Partial" : hasExcess ? "Over-Received" : "Confirmed";

  console.log(`\nNew status: ${target.status}`);
  console.log(`Total receipts after merge: ${target.receipts.length}`);

  await target.save();
  console.log(`\n✓ ${TARGET_ID} saved with new shipment`);

  await GRN.deleteOne({ id: SOURCE_ID });
  console.log(`✓ ${SOURCE_ID} deleted`);

  console.log("\nMerge complete!");
  await mongoose.disconnect();
}

run().catch(err => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
