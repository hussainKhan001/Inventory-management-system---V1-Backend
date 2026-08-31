import mongoose, { Schema } from "mongoose";

const ProjectPlanItemSchema = new Schema({
  sku:      { type: String, required: true },
  itemName: String,
  brand:    String,
  unit:     String,
  qty:      { type: Number, required: true },
  remark:   String,
}, { _id: false });

const ProjectPlanFloorSchema = new Schema({
  floorNumber: { type: String, required: true },
  location:    String,
  dri:         String,
  driName:     String,
  items:       [ProjectPlanItemSchema],
}, { _id: false });

const ProjectPlanSchema = new Schema({
  id:          { type: String, required: true, unique: true },
  project:     { type: String, required: true },
  title:       String,
  workType:    String,
  floors:      [ProjectPlanFloorSchema],
  status: {
    type: String,
    enum: ["Draft", "Pending Approval", "Approved", "Rejected", "PO Raised"],
    default: "Draft",
  },
  createdBy:       String,
  createdById:     String,
  submittedBy:     String,
  submittedAt:     Date,
  approvedBy:      String,
  approvedAt:      Date,
  rejectedBy:      String,
  rejectedAt:      Date,
  rejectionReason: String,
}, { timestamps: true });

ProjectPlanSchema.index({ project: 1 });
ProjectPlanSchema.index({ status: 1 });
ProjectPlanSchema.index({ createdAt: -1 });
ProjectPlanSchema.index({ updatedAt: -1 });

export const MPlan = mongoose.model("MPlan", ProjectPlanSchema);
