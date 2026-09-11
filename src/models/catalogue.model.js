import mongoose, { Schema } from "mongoose";

const CatalogueSchema = new Schema({
  sku:         { type: String, required: true, unique: true },
  itemName:    { type: String, required: true },
  brand:       { type: String, required: true },
  description: { type: String, required: true },
  category:    { type: String, required: true },
  uom:         { type: String, required: true },
  location:    { type: String, required: true },
  minStock:    { type: Number, default: 0 },
  imageUrl:    String,
  status:      { type: String, enum: ["Draft","Approved"], default: "Draft" },
  // Recycle bin
  isDeleted:  { type: Boolean, default: false },
  deletedAt:  Date,
  deletedBy:  String,
}, { timestamps: true });

CatalogueSchema.index({ itemName: 1 });
CatalogueSchema.index({ category: 1 });
CatalogueSchema.index({ updatedAt: -1 });

export const Catalogue = mongoose.model("Catalogue", CatalogueSchema);
