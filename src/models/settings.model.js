import mongoose, { Schema } from "mongoose";

const SettingsSchema = new Schema({
  poThreshold:    { type: Number, default: 25000 },
  minQuotesLow:   { type: Number, default: 2 },
  minQuotesHigh:  { type: Number, default: 3 },
  projects:       { type: [String], default: [] },
  requesters:     { type: [String], default: [] },
  categories:     { type: [String], default: [] },
  units:          { type: [String], default: [] },
  workTypes:      { type: [String], default: [] },
  companies:      [{ name: String, gstin: String, address: String }],
  appName:        { type: String, default: "Garden City" },
  companyFullName:{ type: String, default: "Neoteric Properties" },
  footerText:     { type: String, default: "" },
  logoUrl:        { type: String, default: "" },
  faviconUrl:     { type: String, default: "" },
  themeColor:     { type: String, default: "#F97316" },
  fontFamily:     { type: String, default: "Inter" },
  approvers: {
    purchaseCoord:      { type: String, default: "Vijay Kushwah" },
    purchaseCoordId:    { type: String, default: "" },
    purchaseCoordTitle: { type: String, default: "" },
    l1:      { type: String, default: "Akhilesh Singh" },
    l1Id:    { type: String, default: "" },
    l1Title: { type: String, default: "" },
    l2:      { type: String, default: "Jinesh Jain" },
    l2Id:    { type: String, default: "" },
    l2Title: { type: String, default: "" },
    l3:      { type: String, default: "Rahul Gupta" },
    l3Id:    { type: String, default: "" },
    l3Title: { type: String, default: "" },
  },
  bypassApprovals: {
    l1: { type: Boolean, default: false },
    l2: { type: Boolean, default: false },
    l3: { type: Boolean, default: false },
  },
  stores:    { type: [String], default: [] },
  sites:     [{ siteName: String, siteCode: String }],
  gstRates:  { type: [String], default: ["0%", "5%", "12%", "18%", "28%"] },
  companyBankDetails: {
    accountHolderName: { type: String, default: "" },
    bankName:          { type: String, default: "" },
    accountNumber:     { type: String, default: "" },
    ifscCode:          { type: String, default: "" },
    branch:            { type: String, default: "" },
  },

  // Procurement Task SLA Configuration
  slaConfig: {
    defaultSLA: {
      value: { type: Number, default: 3 },
      unit:  { type: String, default: "days" },
    },
    byPriority: {
      urgent: { value: { type: Number, default: 1 }, unit: { type: String, default: "days" } },
      normal: { value: { type: Number, default: 3 }, unit: { type: String, default: "days" } },
      low:    { value: { type: Number, default: 7 }, unit: { type: String, default: "days" } },
    },
    defaultAssigneeId:   { type: String, default: "" },
    defaultAssigneeName: { type: String, default: "" },
    backupAssigneeId:    { type: String, default: "" },
    backupAssigneeName:  { type: String, default: "" },
    workingHours: {
      start: { type: String, default: "09:00" },
      end:   { type: String, default: "18:00" },
    },
    workingDays:      { type: [Number], default: [1, 2, 3, 4, 5, 6] },
    warnBeforeHours:  { type: Number, default: 6 },
    escalateToRole:   { type: String, default: "Super Admin" },
  },
  mrReportConfig: {
    enabled:         { type: Boolean, default: false },
    slackWebhookUrl: { type: String,  default: "" },
    scheduleTime:    { type: String,  default: "20:00" },
    dataRange:       { type: String,  default: "today" },
    recipientUserIds:{ type: [String], default: [] },
  },
  reportAutomations: { type: Array, default: [] },
}, { timestamps: true });

export const Settings = mongoose.model("Settings", SettingsSchema);
