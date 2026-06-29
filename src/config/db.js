var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
import crypto from "crypto";
import { logger } from "../utils/logger.js";
import mongoose from "mongoose";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import { User } from "../models/index.js";
dotenv.config();
const MONGODB_URI = process.env.MONGODB_URI || "";
if (!MONGODB_URI) {
  logger.error("[DB] MONGODB_URI environment variable is not set. Please configure it in your deployment environment.");
}
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || "neotericgrp.in").toLowerCase().trim();
async function connectDB() {
  try {
    if (!MONGODB_URI) throw new Error("MONGODB_URI is not set");
    await mongoose.connect(MONGODB_URI);
    logger.info("[DB] Connected to MongoDB");
    try {
      const password = await bcrypt.hash("password123", 10);
      const demoUsers = [
        {
          name: "Hussain Khan",
          email: "hussain@neotericgrp.in",
          password,
          role: "Super Admin",
          isActive: true,
          permissions: []
        },
        {
          name: "Super Admin",
          email: `superadmin@${ALLOWED_DOMAIN}`,
          password,
          role: "Super Admin",
          isActive: true,
          permissions: []
          // Rely on role permissions
        },
        {
          name: "System Admin",
          email: `admin@${ALLOWED_DOMAIN}`,
          password,
          role: "admin",
          isActive: true,
          permissions: []
        },
        {
          name: "Manager User",
          email: `manager@${ALLOWED_DOMAIN}`,
          password,
          role: "manager",
          isActive: true,
          permissions: []
        },
        {
          name: "Staff User",
          email: `staff@${ALLOWED_DOMAIN}`,
          password,
          role: "staff",
          isActive: true,
          permissions: []
        }
      ];
      for (const demoUser of demoUsers) {
        await User.findOneAndUpdate(
          { email: demoUser.email },
          { $set: demoUser },
          { upsert: true, returnDocument: 'after' }
        );
      }
      const RolePermission = mongoose.model("RolePermission");
      const allPerms = [
        "VIEW_DASHBOARD",
        "VIEW_ADMIN_DASHBOARD",
        "VIEW_AGM_DASHBOARD",
        "VIEW_STORE_DASHBOARD",
        "VIEW_ENGINEER_DASHBOARD",
        "MANAGE_USERS",
        "VIEW_REPORTS",
        "VIEW_AUDIT_LOGS",
        "VIEW_PUBLIC_PORTAL",
        "VIEW_CATALOGUE",
        "CREATE_CATALOGUE",
        "EDIT_CATALOGUE",
        "DELETE_CATALOGUE",
        "VIEW_SUPPLIERS",
        "CREATE_SUPPLIER",
        "EDIT_SUPPLIER",
        "DELETE_SUPPLIER",
        "VIEW_INVENTORY",
        "CREATE_INVENTORY",
        "EDIT_INVENTORY",
        "DELETE_INVENTORY",
        "VIEW_MATERIAL_PLAN",
        "CREATE_MATERIAL_PLAN",
        "EDIT_MATERIAL_PLAN",
        "DELETE_MATERIAL_PLAN",
        "VIEW_MATERIAL_REQUIREMENT",
        "CREATE_MATERIAL_REQUIREMENT",
        "EDIT_MATERIAL_REQUIREMENT",
        "DELETE_MATERIAL_REQUIREMENT",
        "APPROVE_MATERIAL_REQUIREMENT",
        "TOGGLE_QUOTATION_LINK",
        "VIEW_QUOTATIONS",
        "CREATE_QUOTATION",
        "EDIT_QUOTATION",
        "DELETE_QUOTATION",
        "APPROVE_QUOTATION",
        "VIEW_PURCHASE_ORDERS",
        "CREATE_PURCHASE_ORDER",
        "EDIT_PURCHASE_ORDER",
        "DELETE_PURCHASE_ORDER",
        "APPROVE_PURCHASE_ORDER_L1",
        "APPROVE_PURCHASE_ORDER_L2",
        "APPROVE_PURCHASE_ORDER_L3",
        "REJECT_PURCHASE_ORDER",
        "VIEW_PO_REPORT",
        "VIEW_GRN",
        "CREATE_GRN",
        "EDIT_GRN",
        "DELETE_GRN",
        "VIEW_INWARD",
        "CREATE_INWARD",
        "EDIT_INWARD",
        "DELETE_INWARD",
        "VIEW_OUTWARD",
        "CREATE_OUTWARD",
        "EDIT_OUTWARD",
        "DELETE_OUTWARD",
        "VIEW_INWARD_RETURN",
        "CREATE_INWARD_RETURN",
        "EDIT_INWARD_RETURN",
        "DELETE_INWARD_RETURN",
        "VIEW_OUTWARD_RETURN",
        "CREATE_OUTWARD_RETURN",
        "EDIT_OUTWARD_RETURN",
        "DELETE_OUTWARD_RETURN",
        "VIEW_TRANSFER_INWARD",
        "CREATE_TRANSFER_INWARD",
        "EDIT_TRANSFER_INWARD",
        "DELETE_TRANSFER_INWARD",
        "VIEW_TRANSFER_OUTWARD",
        "CREATE_TRANSFER_OUTWARD",
        "EDIT_TRANSFER_OUTWARD",
        "DELETE_TRANSFER_OUTWARD",
        "VIEW_WRITE_OFFS",
        "CREATE_WRITE_OFF",
        "EDIT_WRITE_OFF",
        "DELETE_WRITE_OFF",
        "APPROVE_WRITE_OFF",
        "VIEW_STOCK_CHECK",
        "CREATE_STOCK_CHECK",
        "APPROVE_STOCK_CHECK",
        "VIEW_STOCK_CHECK_REPORTS",
        "DELETE_STOCK_CHECK_REPORT",
        "VIEW_ACCOUNTS",
        "VERIFY_BILL",
        "REJECT_BILL",
        "MAKE_PAYMENT",
        "VIEW_PAYMENTS",
        "VIEW_ARCHIVE",
        "RESTORE_ARCHIVE"
      ];
      await RolePermission.findOneAndUpdate(
        { role: "Super Admin" },
        { $set: { permissions: allPerms } },
        { upsert: true }
      );
      await RolePermission.findOneAndUpdate(
        { role: "admin" },
        { $set: { permissions: ["VIEW_DASHBOARD", "MANAGE_USERS", "VIEW_INVENTORY"] } },
        { upsert: true }
      );
    } catch (seedError) {
      logger.error("Failed to seed demo users:", seedError);
    }
  } catch (error) {
    logger.error("CRITICAL: MongoDB connection failed.");
    logger.error("Error details:", error instanceof Error ? error.message : error);
    logger.error("Please ensure MONGODB_URI is correctly set in your environment variables.");
    logger.error("If you are using a local URI (127.0.0.1), it will not work in this environment.");
  }
}
__name(connectDB, "connectDB");
export {
  connectDB
};
