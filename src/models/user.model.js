import mongoose, { Schema } from "mongoose";

const UserSchema = new Schema({
  name:          { type: String, required: true },
  email:         { type: String, required: true, unique: true },
  password:      { type: String, required: true },
  plainPassword: { type: String, default: "" },
  role:          { type: String, default: "staff" },
  permissions:   { type: [String], default: [] },
  isActive:      { type: Boolean, default: true },
  status:        { type: String, enum: ["Active","Inactive"], default: "Active" },
  phone:         { type: String, default: "" },
  designation:   { type: String, default: "" },
  department:    { type: String, default: "" },
  employeeId:        { type: String, default: "" },
  assignedProjects:  { type: [String], default: [] },
  // OTP / Two-factor login
  otpHash:     { type: String, select: false },
  otpExpiry:   { type: Date,   select: false },
  otpAttempts: { type: Number, default: 0, select: false },
}, { timestamps: true });

export const User = mongoose.model("User", UserSchema);
