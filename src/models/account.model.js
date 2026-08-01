import mongoose, { Schema } from "mongoose";

const PaymentInstallmentSchema = new Schema({
  installmentNo:    Number,
  grnId:            String,
  grnReceivedValue: Number,
  amountPaid:       Number,
  date:             String,
  mode:             String,
  ref:              String,
  bank:             String,
  utr:              String,
  chequeNo:         String,
  chequeDate:       String,
  paidBy:           String,
  fromCompany:      String,
  toCompany:        String,
  screenshotUrl:    String,
  screenshotName:   String,
  remarks:          String,
  vendorBankDetails: {
    accountHolder: String,
    bankName:      String,
    accountNo:     String,
    branchIFSC:    String,
  },
}, { _id: false });

const AccountSchema = new Schema({
  id:          { type: String, required: true, unique: true },
  poId:        { type: String, required: true },
  project:     String,
  supplier:    String,

  accountStatus: {
    type: String,
    enum: ["bill_verify", "payment_pending", "partial_paid", "paid", "rejected"],
    default: "bill_verify",
  },

  // Invoice / Bill
  invoice: {
    number:       String,
    amount:       Number,
    gst:          Number,
    grandTotal:   Number,
    date:         String,
    filename:     String,
    screenshotUrl: String,
  },

  // Bill approval
  billVerifiedBy:   String,
  billVerifiedAt:   String,
  billApprovedBy:   String,
  billApprovedAt:   String,

  // Bill rejection
  billRejectedBy:   String,
  billRejectedAt:   String,
  rejectionReason:  String,

  // Payment approval & physical check
  paymentApprovals:   { type: [Schema.Types.Mixed], default: [] },
  paymentInitiatedBy: String,
  paymentInitiatedAt: String,
  physicalCheckData:  Schema.Types.Mixed,
  physicalCheckBy:    String,
  physicalCheckAt:    String,

  // GRN tracking
  grnIds:           { type: [String], default: [] },
  grnReceivedValue: { type: Number, default: 0 },  // sum of received qty × PO rate across all GRNs
  payableAmount:    { type: Number, default: 0 },  // grnReceivedValue - totalPaid
  poStatus:         String,                         // mirror of PO status (GRN Fulfilled, etc.)

  // Payment summary
  totalPaid:    { type: Number, default: 0 },
  poTotalValue: Number,   // full PO grand total (items + GST + charges) for reference

  // All payment installments
  paymentHistory: { type: [PaymentInstallmentSchema], default: [] },

  // Legacy single-payment object (for backward compat)
  payment: {
    amountPaid:    Number,
    date:          String,
    mode:          String,
    utr:           String,
    chequeNo:      String,
    chequeDate:    String,
    screenshotUrl: String,
    screenshotName:String,
    paidBy:        String,
    fromCompany:   String,
    toCompany:     String,
    bank:          String,
    ref:           String,
    remarks:       String,
    isPartial:     Boolean,
    vendorBankDetails: {
      accountHolder: String,
      bankName:      String,
      accountNo:     String,
      branchIFSC:    String,
    },
  },

  auditTrail: { type: [Schema.Types.Mixed], default: [] },
}, { timestamps: true });

AccountSchema.index({ poId: 1 });
AccountSchema.index({ accountStatus: 1 });
AccountSchema.index({ project: 1 });
AccountSchema.index({ supplier: 1 });
AccountSchema.index({ createdAt: -1 });
AccountSchema.index({ grnIds: 1 });

export const AccountEntry = mongoose.model("AccountEntry", AccountSchema, "accounts");
