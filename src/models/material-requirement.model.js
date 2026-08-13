import mongoose, { Schema } from "mongoose";

const MaterialRequirementItemSchema = new Schema({
  materialName:     { type: String, required: true },
  sku:              { type: String },
  category:         String,
  qty:              { type: Number, required: true },
  unit:             String,
  allocatedQty:     { type: Number, default: 0 },
  issuedQty:        { type: Number, default: 0 },
  availableInStock: { type: Number, default: 0 },
  remainingQty:     { type: Number, default: 0 },
  condition:        { type: String, default: "New" },
  status:           { type: String, enum: ["In Stock","Needs Purchase","Partial","Allocated","Issued"], default: "Needs Purchase" },
});

const MaterialRequirementSchema = new Schema({
  id:            { type: String, required: true, unique: true },
  mrNumber:      String,
  engineerId:    String,
  planId:        String,
  requesterName: { type: String, required: true },
  project:       { type: String, required: true },
  projectName:   String,
  location:      String,
  workType:      String,
  purpose:       String,
  requirementDate: String,
  date:          { type: String, required: true },
  items:         { type: [MaterialRequirementItemSchema], required: true },
  status:        { type: String, enum: ["Draft","Pending","Rejected","Allocated","Partially Allocated","Partially Issued","Closed","Fulfilled","Approved by Store","Approved by AGM","Store Pending","Quotation Phase","PO Created"], default: "Store Pending" },
  approvedSupplier:    String,
  approvedQuotationId: String,
  approvals: [{
    category:     String,
    quotationId:  String,
    supplierName: String,
    approvedAt:   { type: Date, default: Date.now },
  }],
  quotationLinkActive: { type: Boolean, default: true },
}, { timestamps: true });

MaterialRequirementSchema.index({ project: 1 });
MaterialRequirementSchema.index({ requesterName: 1 });
MaterialRequirementSchema.index({ status: 1 });
MaterialRequirementSchema.index({ status: 1, createdAt: -1 });
MaterialRequirementSchema.index({ createdAt: -1 });
MaterialRequirementSchema.index({ updatedAt: -1 });
MaterialRequirementSchema.index({ mrNumber: 1 });
MaterialRequirementSchema.index({ engineerId: 1 });
MaterialRequirementSchema.index({ planId: 1 });
MaterialRequirementSchema.index({ project: 1, status: 1 });

export const MaterialRequirement = mongoose.model("MaterialRequirement", MaterialRequirementSchema);

// MR Stock Allocation record
const MRAllocationSchema = new Schema({
  id:            { type: String, required: true, unique: true },
  mrId:          { type: String, required: true },
  mrNumber:      String,
  engineerName:  String,
  projectName:   String,
  itemId:        String,
  sku:           String,
  itemName:      String,
  allocatedQty:  { type: Number, default: 0 },
  issuedQty:     { type: Number, default: 0 },
  remainingQty:  { type: Number, default: 0 },
  allocatedBy:   String,
  allocationDate: { type: String, default: () => new Date().toISOString() },
  date:           { type: String, default: () => new Date().toISOString().split("T")[0] },
  status:         { type: String, enum: ["Allocated","Partially Issued","Closed"], default: "Allocated" },
}, { timestamps: true });

MRAllocationSchema.index({ mrId: 1 });
MRAllocationSchema.index({ sku: 1 });
MRAllocationSchema.index({ status: 1 });
MRAllocationSchema.index({ sku: 1, status: 1 });
MRAllocationSchema.index({ mrId: 1, sku: 1 });

export const MRAllocation = mongoose.model("MRAllocation", MRAllocationSchema);
