import mongoose, { Schema } from "mongoose";

const GRNItemSchema = new Schema({
  sku:       String,
  itemName:  String,
  ordered:   Number,
  received:  Number,
  variance:  Number,
  unit:      String,
  condition: String,
  images:    [String],
});

const GRNReceiptItemSchema = new Schema({
  sku:      String,
  itemName: String,
  received: Number,
  images:   [String],
}, { _id: false });

const GRNPaymentSchema = new Schema({
  amount:       Number,
  date:         String,
  mode:         String,
  ref:          String,
  utr:          String,
  chequeNo:     String,
  chequeDate:   String,
  screenshotUrl: String,
  bank:         String,
  fromCompany:  String,
  toCompany:    String,
  remarks:      String,
  vendorBankDetails: {
    accountHolder: String,
    bankName:      String,
    accountNo:     String,
    branchIFSC:    String,
  },
}, { _id: false });

const GRNReceiptSchema = new Schema({
  date:          String,
  challan:       String,
  mrNo:          String,
  docType:       String,
  personName:    String,
  challanPhotos: [String],
  personPhotos:  [String],
  items:         [GRNReceiptItemSchema],
  // Per-receipt payment tracking
  paymentStatus: { type: String, enum: ["unpaid", "bill_verified", "payment_pending", "paid"], default: "unpaid" },
  invoiceNo:     String,
  invoiceAmount: Number,
  verifiedBy:    String,
  verifiedAt:    String,
  verifyRemark:  String,
  approvedBy:    String,
  approvedAt:    String,
  payment:       GRNPaymentSchema,
}, { _id: false });

const GRNSchema = new Schema({
  id:                 { type: String, required: true, unique: true },
  poId:               String,
  project:            String,
  store:              String,
  destinationProject: String,
  supplier:           String,
  date:               String,
  challan:            String,
  mrNo:               String,
  gatePassNo:         String,
  docType:            { type: String, enum: ["Challan","Invoice","Bilty","Gate Pass","Without Challan","Without Gate Pass"] },
  items:              [GRNItemSchema],
  status:             { type: String, enum: ["Draft","Confirmed","Partial","Over-Received"], default: "Draft" },
  receipts:           { type: [GRNReceiptSchema], default: [] },
  materialImageUrl:   String,
  challanImageUrl:    String,
  challanPhotos:      [String],
  personName:         String,
  personPhotoUrl:     String,
  personPhotos:       [String],
  // Payment tracking (Accounts)
  paymentStatus:      { type: String, enum: ["unpaid", "bill_verified", "payment_pending", "paid"], default: "unpaid" },
  invoiceNo:          String,
  invoiceAmount:      Number,
  verifiedBy:         String,
  verifiedAt:         String,
  verifyRemark:       String,
  approvedBy:         String,
  approvedAt:         String,
  payment:            GRNPaymentSchema,
}, { timestamps: true });

GRNSchema.index({ poId: 1 });
GRNSchema.index({ project: 1 });
GRNSchema.index({ supplier: 1 });
GRNSchema.index({ status: 1 });
GRNSchema.index({ mrNo: 1 });
GRNSchema.index({ poId: 1, status: 1 });
GRNSchema.index({ createdAt: -1 });
GRNSchema.index({ updatedAt: -1 });

export const GRN = mongoose.model("GRN", GRNSchema);
