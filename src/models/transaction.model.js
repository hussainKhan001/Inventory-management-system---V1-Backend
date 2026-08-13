import mongoose, { Schema } from "mongoose";

// Shared sub-schema used by Inward, Outward, InwardReturn, OutwardReturn, Transaction
const TransactionItemSchema = new Schema({
  sku:            { type: String, required: true },
  itemName:       { type: String, required: true },
  qty:            { type: Number, required: true },
  outwardQty:     Number,
  variance:       Number,
  unit:           { type: String, required: true },
  remarks:        String,
  images:         [String],
  challanNo:      String,
  mrNo:           String,
  challanPhotoUrl:  String,
  challanPhotos:    [String],
  condition:        String,
});

const InwardItemSchema = new Schema({
  sku:             { type: String, required: true },
  itemName:        { type: String, required: true },
  qty:             { type: Number, required: true },
  unit:            String,
  remarks:         String,
  images:          [String],
  materialPhotoUrl: String,
  challanNo:       String,
  mrNo:            String,
  challanPhotoUrl:  String,
  challanPhotos:    [String],
  condition:        String,
});

const InwardSchema = new Schema({
  id:                 { type: String, required: true, unique: true },
  date:               String,
  challanNo:          String,
  mrNo:               String,
  supplier:           String,
  vendor:             String,
  project:            String,
  store:              String,
  destinationProject: String,
  gatePassNo:         String,
  personPhotoUrl:     String,
  personPhotos:       [String],
  personName:         String,
  batchId:            String,
  status:             String,
  type:               { type: String, enum: ["Manual","Transfer","GRN","Public Inward","Public Transfer Inward","Inward","Transfer Inward","Inward Return","Public Inward Return"], default: "Manual" },
  challanPhotoUrl:    String,
  challanPhotos:      [String],
  materialPhotoUrl:   String,
  grnRef:             String,
  extras:             { type: mongoose.Schema.Types.Mixed, default: {} },
  items:              { type: [InwardItemSchema], required: true },
}, { timestamps: true, collection: "inwards" });

InwardSchema.index({ project: 1 });
InwardSchema.index({ type: 1 });
InwardSchema.index({ gatePassNo: 1 });
InwardSchema.index({ type: 1, gatePassNo: 1 });
InwardSchema.index({ supplier: 1 });
InwardSchema.index({ grnRef: 1 });
InwardSchema.index({ createdAt: -1 });
InwardSchema.index({ updatedAt: -1 });

export const Inward = mongoose.model("Inward", InwardSchema);

const OutwardSchema = new Schema({
  id:                 { type: String, required: true, unique: true },
  date:               String,
  location:           String,
  handoverTo:         String,
  batchId:            String,
  project:            String,
  store:              String,
  destinationProject: String,
  gatePassNo:         String,
  category:           String,
  type:               { type: String, enum: ["Manual","Transfer","MR-Outward","Public Outward","Public Transfer Outward","Outward","Transfer Outward","Outward Return","Public Outward Return"], default: "Manual" },
  materialPhotoUrl:   String,
  handoverPhotoUrl:   String,
  personPhotoUrl:     String,
  personPhotos:       [String],
  personName:         String,
  challanNo:          String,
  challanPhotos:      [String],
  challanPhotoUrl:    String,
  mrNo:               String,
  supplier:           String,
  vendor:             String,
  items:              { type: [TransactionItemSchema], required: true },
  mrId:               String,
  poId:               String,
  transferStatus:     { type: String, enum: ["Pending", "Fulfilled", "Partially Complete"], default: "Pending" },
  transferVariance:   { type: Number, default: 0 },
  extras:             { type: mongoose.Schema.Types.Mixed, default: {} },
  updateHistory:      [{
    updatedBy:  String,
    updatedAt:  String,
    changes:    { type: mongoose.Schema.Types.Mixed },
  }],
}, { timestamps: true });

OutwardSchema.index({ project: 1 });
OutwardSchema.index({ type: 1 });
OutwardSchema.index({ gatePassNo: 1 });
OutwardSchema.index({ type: 1, gatePassNo: 1 });
OutwardSchema.index({ supplier: 1 });
OutwardSchema.index({ mrId: 1 });
OutwardSchema.index({ poId: 1 });
OutwardSchema.index({ createdAt: -1 });
OutwardSchema.index({ updatedAt: -1 });

export const Outward = mongoose.model("Outward", OutwardSchema);

const InwardReturnSchema = new Schema({
  id:               { type: String, required: true, unique: true },
  date:             { type: String, required: true },
  condition:        { type: String, enum: ["New","Good","Old","Needs Repair","Damaged","NEW","GOOD","OLD","NEEDS REPAIR","DAMAGED"], default: "Good" },
  supplier:         { type: String, required: true },
  remarks:          String,
  handoverTo:       String,
  store:            String,
  project:          String,
  materialPhotoUrl: String,
  challanPhotoUrl:  String,
  items:            { type: [TransactionItemSchema], required: true },
}, { timestamps: true });

InwardReturnSchema.index({ project: 1 });
InwardReturnSchema.index({ supplier: 1 });
InwardReturnSchema.index({ store: 1 });
InwardReturnSchema.index({ createdAt: -1 });

export const InwardReturn = mongoose.model("InwardReturn", InwardReturnSchema);

const OutwardReturnSchema = new Schema({
  id:               { type: String, required: true, unique: true },
  date:             { type: String, required: true },
  condition:        { type: String, enum: ["New","Good","Old","Needs Repair","Damaged","NEW","GOOD","OLD","NEEDS REPAIR","DAMAGED"], default: "Good" },
  sourceSite:       { type: String, required: true },
  remarks:          String,
  handoverFrom:     String,
  store:            String,
  project:          String,
  personName:       String,
  personPhotoUrl:   String,
  personPhotos:     [String],
  materialPhotoUrl: String,
  items:            { type: [TransactionItemSchema], required: true },
}, { timestamps: true });

OutwardReturnSchema.index({ project: 1 });
OutwardReturnSchema.index({ sourceSite: 1 });
OutwardReturnSchema.index({ store: 1 });
OutwardReturnSchema.index({ createdAt: -1 });

export const OutwardReturn = mongoose.model("OutwardReturn", OutwardReturnSchema);

const TransactionSchema = new Schema({
  id:   { type: String, required: true, unique: true },
  type: { type: String, required: true, enum: ["Inward","Outward","MR-Outward","Inward Return","Outward Return","Public Inward","Public Outward","Public Inward Return","Public Outward Return","Transfer Inward","Transfer Outward","Public Transfer Inward","Public Transfer Outward","Transfer","GRN"] },
  date:               { type: String, required: true },
  items:              { type: [TransactionItemSchema], required: true },
  project:            String,
  store:              String,
  destinationProject: String,
  gatePassNo:         String,
  supplier:           String,
  vendor:             String,
  challanNo:          String,
  mrNo:               String,
  location:           String,
  handoverTo:         String,
  handoverFrom:       String,
  sourceSite:         String,
  createdBy:          String,
  status:             { type: String, default: "Completed" },
  linkId:             String,
  materialPhotoUrl:   String,
  challanPhotoUrl:    String,
  challanPhotos:      [String],
  handoverPhotoUrl:   String,
  personPhotoUrl:     String,
  personPhotos:       [String],
  personName:         String,
  mrId:               String,
  poId:               String,
}, { timestamps: true });

TransactionSchema.index({ type: 1 });
TransactionSchema.index({ date: -1 });
TransactionSchema.index({ type: 1, date: -1 });
TransactionSchema.index({ gatePassNo: 1 });
TransactionSchema.index({ type: 1, gatePassNo: 1 });
TransactionSchema.index({ project: 1 });
TransactionSchema.index({ mrId: 1 });
TransactionSchema.index({ poId: 1 });
TransactionSchema.index({ createdAt: -1 });
TransactionSchema.index({ updatedAt: -1 });
TransactionSchema.index({ supplier: 1 });
TransactionSchema.index({ linkId: 1 });
TransactionSchema.index({ project: 1, type: 1 });
TransactionSchema.index({ createdBy: 1 });

export const Transaction = mongoose.model("Transaction", TransactionSchema);
