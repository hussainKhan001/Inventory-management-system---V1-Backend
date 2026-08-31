import mongoose, { Schema } from "mongoose";

const QuotationItemSchema = new Schema({
  materialName: { type: String, required: true },
  category:     String,
  mrQty:        Number,
  mrUnit:       String,
  qty:          { type: Number, required: true },
  unit:         String,
  rate:         { type: Number, required: true },
  gstPct:       Number,
  gstType:      { type: String, enum: ["Inclusive","Exclusive"] },
  brand:        String,
  approved:     { type: Boolean, default: false },
});

const QuotationSchema = new Schema({
  id:           { type: String, required: true, unique: true },
  mrId:         String,
  planId:       String,
  category:     String,
  supplierId:   String,
  supplierName: { type: String, required: true },
  ownerName:    String,
  mobile:       String,
  gstNumber:    String,
  items:        [QuotationItemSchema],
  deliveryDate: String,
  remarks:      String,
  token:        { type: String, unique: true, sparse: true },
  status:       { type: String, enum: ["Pending","Approved","Rejected"], default: "Pending" },
  totalAmount:  Number,
  freightAmount:     Number,
  freightGstPct:     Number,
  freightGstType:    { type: String, enum: ["Inclusive","Exclusive"] },
  loadingAmount:     Number,
  loadingGstPct:     Number,
  loadingGstType:    { type: String, enum: ["Inclusive","Exclusive"] },
  unloadingAmount:   Number,
  unloadingGstPct:   Number,
  unloadingGstType:  { type: String, enum: ["Inclusive","Exclusive"] },
  date: { type: String, default: () => new Date().toISOString().split("T")[0] },
  linkedPoId:       String,
  linkedMasterPoId: String,
}, { timestamps: true });

QuotationSchema.pre("save", async function () {
  if (!this.token) {
    this.token = `QT-TOKEN-${this.id || Math.random().toString(36).slice(2, 11)}-${Date.now()}`;
  }
});

QuotationSchema.index({ mrId: 1 });
QuotationSchema.index({ planId: 1 });
QuotationSchema.index({ linkedMasterPoId: 1 });
QuotationSchema.index({ supplierName: 1 });
QuotationSchema.index({ status: 1 });
QuotationSchema.index({ updatedAt: -1 });
QuotationSchema.index({ mrId: 1, status: 1 });
QuotationSchema.index({ supplierId: 1 });
QuotationSchema.index({ linkedPoId: 1 });
QuotationSchema.index({ category: 1 });
QuotationSchema.index({ createdAt: -1 });

export const Quotation = mongoose.model("Quotation", QuotationSchema);
