import mongoose, { Schema } from "mongoose";

const ReorderRuleSchema = new Schema({
  sku:              { type: String, required: true, unique: true },
  itemName:         String,
  companyName:      { type: String, required: true },
  thresholdQty:     { type: Number, required: true },
  reorderQty:       { type: Number, required: true },
  vendor:           { type: String, required: true },
  rate:             { type: Number, required: true },
  gstPct:           { type: Number, default: 0 },
  gstType:          { type: String, enum: ["Inclusive","Exclusive"], default: "Exclusive" },
  isActive:         { type: Boolean, default: true },
  lastReviewedDate: { type: Date, default: Date.now },
  createdBy:        String,
  updatedBy:        String,
}, { timestamps: true });

ReorderRuleSchema.index({ isActive: 1 });
ReorderRuleSchema.index({ companyName: 1 });

export const ReorderRule = mongoose.model("ReorderRule", ReorderRuleSchema);
