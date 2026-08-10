import "dotenv/config";
import mongoose from "mongoose";
import { Transaction, Inward } from "../models/index.js";

await mongoose.connect(process.env.MONGODB_URI);

const types = await Transaction.aggregate([
  { $group: { _id: "$type", count: { $sum: 1 } } },
  { $sort: { count: -1 } }
]);
console.log("Transaction types in DB:", JSON.stringify(types, null, 2));

const inwardCount = await Inward.countDocuments({});
console.log("\nTotal Inward records:", inwardCount);

const sample = await Inward.findOne({}).lean();
if (sample) console.log("Sample Inward keys:", Object.keys(sample));

const sampleTxn = await Transaction.findOne({}).lean();
if (sampleTxn) {
  console.log("\nSample Transaction keys:", Object.keys(sampleTxn));
  console.log("Sample Transaction type/qty:", { type: sampleTxn.type, qty: sampleTxn.qty, quantity: sampleTxn.quantity, sku: sampleTxn.sku });
}

await mongoose.disconnect();
