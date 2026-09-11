import mongoose, { Schema } from "mongoose";

const SiteSchema = new Schema({
  siteName: String,
  siteCode: String,
  openingStock: { type: Number, default: 0 },
  liveStock: { type: Number, default: 0 }
}, { _id: false });

const InventorySchema = new Schema({
  sku:          { type: String, required: true, unique: true },
  itemName:     { type: String, required: true },
  category:     { type: String, required: true },
  subCategory:  { type: String, required: true },
  unit:         { type: String, required: true },
  sites:        [SiteSchema],
  totalStock:   { type: Number, default: 0 },
  maxLevel:     { type: Number, default: 0 },
  openingStock: { type: Number, default: 0 },
  totalQty:     { type: Number, default: 0 },      // total_qty = available + allocated + issued
  availableQty: { type: Number, default: 0 },      // Layer 1: Free stock
  allocatedQty: { type: Number, default: 0 },      // Layer 2: Reserved/Locked for MR
  issuedQty:    { type: Number, default: 0 },      // Layer 3: Physically moved out
  liveStock:    { type: Number, default: 0 },      // Legacy/Compatibility
  condition:     { type: String, enum: ["New","Good","Old","Needs Repair","Damaged","NEW","GOOD","OLD","NEEDS REPAIR","DAMAGED"], default: "New" },
  sourceSite:    String,
  lastProject:   String,
  locationStock: { type: Map, of: Number, default: {} },
  // Recycle bin
  isDeleted:  { type: Boolean, default: false },
  deletedAt:  Date,
  deletedBy:  String,
}, { timestamps: true });

InventorySchema.pre("save", async function () {
  // When site-level stock exists, liveStock must equal the sum of all locationStock values.
  // This self-corrects any global/site divergence that accumulated from legacy operations.
  if (this.locationStock && this.locationStock.size > 0) {
    const siteTotal = [...this.locationStock.values()].reduce(
      (sum, v) => sum + Math.max(0, Number(v) || 0), 0
    );
    this.liveStock = siteTotal;
  }
  if (this.liveStock !== undefined) {
    this.availableQty = Math.max(0, (this.liveStock || 0) - (this.allocatedQty || 0));
    this.totalQty     = (this.liveStock || 0) + (this.issuedQty || 0);
    this.totalStock   = (this.liveStock || 0) + (this.issuedQty || 0);
  }
});

InventorySchema.index({ itemName: 1 });
InventorySchema.index({ category: 1 });
InventorySchema.index({ subCategory: 1 });
InventorySchema.index({ category: 1, subCategory: 1 });
InventorySchema.index({ liveStock: -1 });
InventorySchema.index({ createdAt: -1 });
InventorySchema.index({ updatedAt: -1 });

export const Inventory = mongoose.model("Inventory", InventorySchema);
