import mongoose, { Schema } from "mongoose";

const POLineItemSchema = new Schema({
  sku:            String,
  itemName:       String,
  qty:            Number,
  unit:           String,
  rate:           Number,
  gstPct:         Number,
  gstType:        { type: String, enum: ["Inclusive","Exclusive"], default: "Exclusive" },
  total:          Number,
  totalWithGST:   Number,
  currentStock:   Number,
  category:       String,
  requirementQty: Number,
  uqc:            String,
  condition:      String,
});

const PaymentTimelineSchema = new Schema({
  date:     String,
  type:     String,
  mode:     String,
  amount:   Number,
  gstPct:   String,
  gstType:  { type: String, enum: ["Inclusive","Exclusive"], default: "Exclusive" },
  ifPayable: Number,
});

const POSchema = new Schema({
  id:          { type: String, required: true, unique: true },
  mrId:        String,
  quotationId: String,
  project:     String,
  phase:       String,
  workType:    String,
  milestone:   String,
  supplier:    String,
  items:       [POLineItemSchema],
  totalValue:  Number,
  status:      { type: String, enum: ["Approved","Cancelled","Pending","Pending GRN","Pending L1","Pending L2","Pending L3","Fulfilled","Blocked","Draft","GRN Pending","GRN Fulfilled","GRN Variance","Ready for Payment","PO Closed","On Hold"], default: "Draft" },
  previousStatus: String,
  holdReason:    String,
  approvalL1:  { type: String, enum: ["N/A","Pending","Approved"], default: "Pending" },
  approvalL2:  { type: String, enum: ["N/A","Pending","Approved"], default: "Pending" },
  approvalL3:  { type: String, enum: ["N/A","Pending","Approved"], default: "Pending" },
  approvalL1At: String,
  approvalL2At: String,
  approvalL3At: String,
  justification: String,
  createdBy:    String,
  date:         String,
  priority:     { type: String, enum: ["Urgent","Normal","Low"], default: "Normal" },
  applicatedArea: String,
  requirementBy:  String,
  location:       String,
  vendorBankDetails: {
    accountHolder: String,
    bankName:      String,
    accountNo:     String,
    branchIFSC:    String,
  },
  deliveryDetails: {
    location:      String,
    deliveryDate:  String,
    contactPerson: String,
    contactPhone:  String,
  },
  paymentTimelines: [PaymentTimelineSchema],
  priceComparison: {
    vendors: [{ name: String, gstType: String, gstPct: Number }],
    items:   [{ materialName: String, unit: String, qty: Number, rates: [Number], gstPcts: [Number] }],
    remarks: String,
  },
  remark:         String,
  panNo:          String,
  gstNo:          String,
  companyName:    String,
  companyGst:     String,
  companyAddress: String,
  vendorContact:  String,
  vendorEmail:    String,
  vendorAddress:  String,
  accountStatus:      String,
  verifiedBy:         String,
  verifiedAt:         String,
  verifyRemark:       String,
  billApprovedBy:     String,
  billApprovedDate:   String,
  billRejectedBy:     String,
  billRejectedDate:   String,
  rejectionReason:    String,
  invoice: { number: String, amount: Number, gst: Number, date: String, filename: String },
  grn:     { number: String, qty: String, receivedBy: String, date: String, remark: String },
  payment: {
    amountPaid:   Number,
    date:         String,
    mode:         String,
    utr:          String,
    chequeNo:     String,
    chequeDate:   String,
    screenshotUrl:  String,
    screenshotName: String,
    paidBy:       String,
    fromCompany:  String,
    toCompany:    String,
    bank:         String,
    ref:          String,
    remarks:      String,
    vendorBankDetails: { accountHolder: String, bankName: String, accountNo: String, branchIFSC: String },
  },
  paymentHistory: { type: [Schema.Types.Mixed], default: undefined },
  totalPaid: { type: Number, default: 0 },
  // Multi-level payment approval chain (AGM -> GM -> Director) — Mixed because the exact
  // shape (level, role, label, status, approvedBy, approvedAt, remark) is assembled entirely
  // on the frontend; these fields were previously missing from the schema, which meant
  // Mongoose silently dropped them on every save (Object.assign + save() only persists
  // schema-declared paths) — approvals looked like they worked in the UI until a refresh,
  // then reverted because nothing had actually been written to the database.
  paymentApprovals: { type: [Schema.Types.Mixed], default: undefined },
  pendingPaymentData: { type: Schema.Types.Mixed, default: undefined },
  paymentInitiatedBy: String,
  paymentInitiatedAt: String,
  paymentRejectionReason: String,
  auditTrail: [Schema.Types.Mixed],
  // Cancellation
  cancelNote:  String,
  cancelledBy: String,
  cancelledAt: String,
  // Other charges
  freightAmount:    { type: Number, default: 0 },
  freightGstPct:    { type: Number, default: 0 },
  freightGstType:   { type: String, enum: ["Inclusive","Exclusive"], default: "Exclusive" },
  loadingAmount:    { type: Number, default: 0 },
  loadingGstPct:    { type: Number, default: 0 },
  loadingGstType:   { type: String, enum: ["Inclusive","Exclusive"], default: "Exclusive" },
  unloadingAmount:  { type: Number, default: 0 },
  unloadingGstPct:  { type: Number, default: 0 },
  unloadingGstType: { type: String, enum: ["Inclusive","Exclusive"], default: "Exclusive" },
  closedItems: { type: [Schema.Types.Mixed], default: undefined },
  approverSnapshot: { type: Schema.Types.Mixed, default: undefined },
}, { timestamps: true });

POSchema.index({ project: 1 });
POSchema.index({ supplier: 1 });
POSchema.index({ status: 1 });
POSchema.index({ accountStatus: 1 });
POSchema.index({ mrId: 1 });
POSchema.index({ mrId: 1, status: 1 });
POSchema.index({ quotationId: 1 });
POSchema.index({ createdAt: -1 });
POSchema.index({ updatedAt: -1 });

export const PurchaseOrder = mongoose.model("PurchaseOrder", POSchema);
