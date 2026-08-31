import mongoose, { Schema } from "mongoose";

const EMRItemSchema = new Schema({
  sku:      String,
  itemName: String,
  unit:     String,
  qty:      Number,
  remark:   String,
}, { _id: false });

const ExtraMaterialRequestSchema = new Schema({
  id:           { type: String, required: true, unique: true },
  masterPoId:   { type: String, required: true },
  planId:       String,
  project:      String,
  floor:        String,
  dri:          String,
  driName:      String,
  items:        [EMRItemSchema],
  status: {
    type: String,
    enum: ["Pending", "Approved", "Rejected", "PO Raised"],
    default: "Pending",
  },
  requestedBy:      String,
  requestedById:    String,
  approvedBy:       String,
  approvedAt:       Date,
  rejectedBy:       String,
  rejectedAt:       Date,
  rejectionReason:  String,
  linkedMasterPoId: String,
  remark:           String,
}, { timestamps: true });

ExtraMaterialRequestSchema.index({ masterPoId: 1 });
ExtraMaterialRequestSchema.index({ planId: 1 });
ExtraMaterialRequestSchema.index({ project: 1 });
ExtraMaterialRequestSchema.index({ dri: 1 });
ExtraMaterialRequestSchema.index({ status: 1 });
ExtraMaterialRequestSchema.index({ createdAt: -1 });

export const ExtraMaterialRequest = mongoose.model("ExtraMaterialRequest", ExtraMaterialRequestSchema);
