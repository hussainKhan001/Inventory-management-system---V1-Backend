/**
 * One-time fix: set gstType = "Inclusive" on all items of PO-2026-174
 * Run: node src/scripts/fix-po-2026-174-gst.js
 *
 * Root cause: PO was created before per-item gstType was saved by the form,
 * so Mongoose stored the default "Exclusive". But totalValue = ₹4,500 (= qty×rate,
 * no GST added on top) confirms the intent was Inclusive. This fix corrects the stored field.
 */
import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import { PurchaseOrder } from "../models/index.js";

async function fix() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");

  const po = await PurchaseOrder.findOne({ id: "PO-2026-174" });
  if (!po) {
    console.error("PO-2026-174 not found");
    await mongoose.disconnect();
    return;
  }

  console.log("Before fix:");
  po.items.forEach((it, i) =>
    console.log(`  item[${i}] ${it.itemName}: gstType=${it.gstType}, gstPct=${it.gstPct}`)
  );

  po.items = po.items.map((it) => ({ ...it.toObject(), gstType: "Inclusive" }));
  po.markModified("items");

  await po.save();

  console.log("\nAfter fix:");
  const updated = await PurchaseOrder.findOne({ id: "PO-2026-174" }).lean();
  updated.items.forEach((it, i) =>
    console.log(`  item[${i}] ${it.itemName}: gstType=${it.gstType}`)
  );
  console.log("\nDone. PO-2026-174 items now have gstType=Inclusive.");

  await mongoose.disconnect();
}

fix().catch(err => { console.error(err); process.exit(1); });
