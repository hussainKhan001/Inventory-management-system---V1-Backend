import mongoose, { Schema } from "mongoose";

const WriteOffSchema = new Schema({
  id:          { type: String, required: true, unique: true },
  sku:         String,
  itemName:    String,
  qty:         Number,
  unit:        String,
  reason:      String,
  requestedBy: String,
  date:        String,
  status:      { type: String, enum: ["Pending","Approved","Rejected"], default: "Pending" },
  // Recycle bin
  isDeleted:  { type: Boolean, default: false },
  deletedAt:  Date,
  deletedBy:  String,
}, { timestamps: true });

export const WriteOff = mongoose.model("WriteOff", WriteOffSchema);
