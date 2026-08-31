import mongoose, { Schema } from "mongoose";

const LedgerEntrySchema = new Schema({
  date:      String,
  type:      { type: String, enum: ["GRN", "Allocation", "Return"] },
  refId:     String,
  sku:       String,
  itemName:  String,
  qty:       Number,
  floor:     String,
  dri:       String,
  driName:   String,
  createdBy: String,
  remark:    String,
}, { _id: false });

const MasterPOLedgerSchema = new Schema({
  id:         { type: String, required: true, unique: true },
  masterPoId: { type: String, required: true },
  project:    String,
  entries:    [LedgerEntrySchema],
}, { timestamps: true });

MasterPOLedgerSchema.index({ masterPoId: 1 }, { unique: true });
MasterPOLedgerSchema.index({ project: 1 });

export const MasterPOLedger = mongoose.model("MasterPOLedger", MasterPOLedgerSchema);
