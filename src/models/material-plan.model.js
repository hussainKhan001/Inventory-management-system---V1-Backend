import mongoose, { Schema } from "mongoose";

const PlanLineItemSchema = new Schema({
  sku:       String,
  itemName:  String,
  required:  Number,
  unit:      String,
  available: Number,
  reusable:  Number,
  shortage:  Number,
  priority:  { type: String, enum: ["High","Medium","Low"] },
  delivery:  String,
  activity:  String,
}, { _id: false });

// Floor-based items for MP-type plans
const MPFloorItemSchema = new Schema({
  sku: String, itemName: String, brand: String, unit: String,
  qty: { type: Number, default: 0 }, remark: String,
}, { _id: false });

const MPFloorSchema = new Schema({
  floorNumber: String, location: String, dri: String, driName: String,
  items: [MPFloorItemSchema],
}, { _id: false });

const MaterialPlanSchema = new Schema({
  id:          { type: String, required: true, unique: true },
  planType:    { type: String, enum: ["Standard", "MP"], default: "Standard" },
  project:     String,
  milestone:   String,
  workType:    String,
  location:    String,
  engineer:    String,
  gmAgm:       String,
  agm:         String,
  agmName:     String,
  gm:          String,
  gmName:      String,
  dri:         String,
  driName:     String,
  dris:        [String],
  driNames:    [String],
  date:        String,
  status:      { type: String, enum: ["Draft","Pending Approval","Approved","Rejected","PO Raised","Fulfilled","Open"], default: "Draft" },
  submittedBy: String,
  submittedAt: Date,
  approvedBy:  String,
  approvedAt:  Date,
  rejectedBy:  String,
  rejectedAt:  Date,
  rejectionReason: String,
  items:       [PlanLineItemSchema],
  floors:      [MPFloorSchema],  // used when planType === "MP"
  editHistory: [{ date: Date, editedBy: String, previousItems: [PlanLineItemSchema] }],
}, { timestamps: true });

MaterialPlanSchema.index({ project: 1 });
MaterialPlanSchema.index({ status: 1 });
MaterialPlanSchema.index({ updatedAt: -1 });

export const MaterialPlan = mongoose.model("MaterialPlan", MaterialPlanSchema);
