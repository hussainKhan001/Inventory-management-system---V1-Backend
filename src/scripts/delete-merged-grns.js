/**
 * delete-merged-grns.js
 * Hard-deletes GRN documents that were soft-marked as Merged.
 * Their data is already folded into the target GRN's receipts[].
 * Usage: node src/scripts/delete-merged-grns.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import { GRN } from "../models/index.js";

await mongoose.connect(process.env.MONGODB_URI);

const merged = await GRN.find({ status: "Merged", isActive: false }).lean();
console.log(`Found ${merged.length} merged GRN(s) to delete:`);
merged.forEach(g => console.log(`  ${g.id}  (mergedInto: ${g.mergedInto})`));

if (merged.length === 0) {
  console.log("Nothing to delete.");
  await mongoose.disconnect();
  process.exit(0);
}

const result = await GRN.deleteMany({ status: "Merged", isActive: false });
console.log(`\nDeleted: ${result.deletedCount} document(s)`);

const remaining = await GRN.countDocuments({});
console.log(`Remaining GRN documents: ${remaining}`);

await mongoose.disconnect();
console.log("Done.");
