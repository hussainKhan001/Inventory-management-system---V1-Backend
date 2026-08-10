import mongoose, { Schema } from "mongoose";

const DieselConsumptionSchema = new Schema({
  id:           { type: String, required: true, unique: true },
  date:         { type: String, required: true },
  driverName:   { type: String, required: true },
  equipment:    { type: String, required: true },
  site:         { type: String, required: true },
  qtyUsed:      { type: Number, required: true },
  meterReading: String,
  remarks:      String,
  submittedBy:  String,
  submittedAt:  String,
}, { timestamps: true });

DieselConsumptionSchema.index({ date: -1 });
DieselConsumptionSchema.index({ site: 1 });
DieselConsumptionSchema.index({ driverName: 1 });
DieselConsumptionSchema.index({ createdAt: -1 });

export const DieselConsumption = mongoose.model("DieselConsumption", DieselConsumptionSchema);
