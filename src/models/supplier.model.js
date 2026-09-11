import mongoose, { Schema } from "mongoose";

const SupplierSchema = new Schema({
  id:                 { type: String, required: true, unique: true },
  email:              { type: String, required: true },
  companyName:        { type: String, required: true, unique: true },
  ownerName:          { type: String, required: true },
  mobile:             { type: String, required: true },
  altMobile:          String,
  website:            String,
  address:            { type: String, required: true },
  dealingProducts:    { type: String, required: true },
  references:         String,
  avgTurnover:        String,
  additionalInfo:     String,
  accountHolderName:  String,
  bankName:           String,
  accountNumber:      String,
  ifscCode:           String,
  branch:             String,
  cashOnly:           { type: Boolean, default: false },
  panNumber:          { type: String, required: true },
  gstNumber:          String,
  gstCertificateUrl:  String,
  panCardUrl:         { type: String, required: true },
  bankProofUrl:       String,
  businessCardUrl:    String,
  processCoordinator: String,
  status:             { type: String, enum: ["Active","Inactive"], default: "Active" },
  // Alias fields
  name:         { type: String, required: true },   // = companyName
  supplierName: { type: String },                   // = companyName
  contact:      { type: String, required: true },   // = ownerName
  phone:        { type: String, required: true },   // = mobile
  category:     { type: String, required: true },   // = dealingProducts
  gst:          { type: String },                   // = gstNumber
  accountNo:    { type: String },                   // = accountNumber
  // Recycle bin
  isDeleted:  { type: Boolean, default: false },
  deletedAt:  Date,
  deletedBy:  String,
}, { timestamps: true });

// Keep all alias fields in sync with their canonical counterparts on every save
SupplierSchema.pre("save", async function () {
  if (this.isModified("companyName") || !this.name) this.name = this.companyName;
  if (this.isModified("companyName") || !this.supplierName) this.supplierName = this.companyName;
  if (this.isModified("ownerName")   || !this.contact)  this.contact  = this.ownerName;
  if (this.isModified("mobile")      || !this.phone)    this.phone     = this.mobile;
  if (this.isModified("dealingProducts") || !this.category) this.category = this.dealingProducts;
  if (this.isModified("gstNumber"))   this.gst       = this.gstNumber || this.gst;
  if (this.isModified("accountNumber") || !this.accountNo) this.accountNo = this.accountNumber;
});

SupplierSchema.index({ name: 1 });
SupplierSchema.index({ ownerName: 1 });
SupplierSchema.index({ email: 1 });
SupplierSchema.index({ mobile: 1 });
SupplierSchema.index({ contact: 1 });
SupplierSchema.index({ phone: 1 });
SupplierSchema.index({ status: 1 });
SupplierSchema.index({ status: 1, companyName: 1 });
SupplierSchema.index({ createdAt: -1 });
SupplierSchema.index({ updatedAt: -1 });

export const Supplier = mongoose.model("Supplier", SupplierSchema, "vendors");
export const Vendor = Supplier;
