import mongoose, { Schema } from "mongoose";

// Per-field change entry (used when a field-level diff is captured)
const ChangeSchema = new Schema({
  field:    String,
  oldValue: Schema.Types.Mixed,
  newValue: Schema.Types.Mixed,
  summary:  String,
}, { _id: false });

const AuditLogSchema = new Schema({
  // ── Existing fields (kept as-is for backward compat) ──────────────────
  userId:     { type: Schema.Types.ObjectId, ref: "User", required: true },
  userName:   String,
  userEmail:  String,
  action:     { type: String, required: true }, // CREATE, UPDATE, DELETE, APPROVE, REJECT, CANCEL, LOGIN, LOGOUT …
  resource:   { type: String, required: true }, // entity type string, e.g. "PurchaseOrder"
  resourceId: String,
  details:    Schema.Types.Map,

  // ── New fields ─────────────────────────────────────────────────────────
  entityType: String,   // mirrors `resource`  — used by new entity-history queries
  entityId:   String,   // mirrors `resourceId` — used by new entity-history queries
  changes:    [ChangeSchema], // field-level diff list
  summary:    String,   // human-readable one-liner, e.g. "Stock qty changed from 150 to 120"
}, { timestamps: true });

// ── Indexes ───────────────────────────────────────────────────────────────
// Existing: none beyond _id
// New compound indexes for the three query patterns:
AuditLogSchema.index({ resource: 1, resourceId: 1, createdAt: -1 });   // entity history (backward compat field)
AuditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });   // entity history (new field)
AuditLogSchema.index({ userId: 1, createdAt: -1 });                    // per-user activity

export const AuditLog = mongoose.model("AuditLog", AuditLogSchema);
