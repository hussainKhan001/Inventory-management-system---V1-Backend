import mongoose, { Schema } from "mongoose";

const MPOItemSchema = new Schema({
  sku:       String,
  itemName:  String,
  brand:     String,
  unit:      String,
  qty:       Number,
  rate:      Number,
  gst:       Number,
  amount:    Number,
  delivered: { type: Number, default: 0 },
}, { _id: false });

const MPOApprovalSchema = new Schema({
  level:      String,
  approver:   String,
  approverId: String,
  status:     { type: String, enum: ["Pending", "Approved", "Rejected"], default: "Pending" },
  approvedAt: Date,
  remark:     String,
}, { _id: false });

const MasterPOSchema = new Schema({
  id:                  { type: String, required: true, unique: true },
  planId:              { type: String, required: true },
  categoryQuotationId: String,
  project:             String,
  supplier:            String,
  supplierId:          String,
  category:            String,
  items:               [MPOItemSchema],
  totalAmount:         Number,
  status: {
    type: String,
    enum: [
      "Draft", "Pending L1", "Pending L2", "Pending L3",
      "Approved", "Rejected", "Cancelled", "GRN Pending", "GRN Done", "Closed",
    ],
    default: "Draft",
  },
  approvals:        [MPOApprovalSchema],
  approverSnapshot: { type: Schema.Types.Mixed },
  createdBy:        String,
  createdById:      String,
  submittedAt:      Date,
  approvedBy:       String,
  approvedAt:       Date,
  rejectedBy:       String,
  rejectedAt:       Date,
  rejectionReason:  String,
  cancelledBy:      String,
  cancelledAt:      Date,
  cancelReason:     String,
  paymentStatus: {
    type: String,
    enum: ["unpaid", "bill_verified", "bill_approved", "bill_rejected", "payment_pending", "paid"],
    default: "unpaid",
  },
  paymentApprovals:    { type: Schema.Types.Mixed },
  paymentTimelines:    [{ type: Schema.Types.Mixed }],
  terms:               String,
  deliveryAddress:     String,
  expectedDeliveryDate: String,
}, { timestamps: true });

MasterPOSchema.index({ planId: 1 });
MasterPOSchema.index({ project: 1 });
MasterPOSchema.index({ status: 1 });
MasterPOSchema.index({ supplier: 1 });
MasterPOSchema.index({ categoryQuotationId: 1 });
MasterPOSchema.index({ createdAt: -1 });
MasterPOSchema.index({ updatedAt: -1 });
MasterPOSchema.index({ paymentStatus: 1 });

export const MasterPO = mongoose.model("MasterPO", MasterPOSchema);
