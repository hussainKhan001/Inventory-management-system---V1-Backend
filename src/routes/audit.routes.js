import { Router } from "express";
import { AuditLog } from "../models/index.js";
import { authenticate } from "../middleware/auth.middleware.js";

const router = Router();

// ── Shared helpers ────────────────────────────────────────────────────────

const isAdmin = (user) =>
  ["super admin", "superadmin", "admin"].includes((user?.role || "").toLowerCase().trim());

/** Parse common query params into a Mongoose filter object + pagination. */
const parseQuery = (query) => {
  const page  = Math.max(1, parseInt(query.page)  || 1);
  const limit = Math.min(500, parseInt(query.limit) || 50);
  const skip  = (page - 1) * limit;

  const filter = {};

  // full-text search across key string fields
  if (query.search?.trim()) {
    const re = new RegExp(query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { userName: re }, { userEmail: re },
      { action: re },   { resource: re }, { resourceId: re }, { summary: re },
    ];
  }

  // action type filter  e.g. ?action=APPROVE
  if (query.action?.trim()) {
    filter.action = query.action.trim().toUpperCase();
  }

  // user name filter (existing behaviour)
  if (query.user?.trim()) {
    filter.userName = query.user.trim();
  }

  // date range
  if (query.startDate || query.endDate) {
    filter.createdAt = {};
    if (query.startDate) filter.createdAt.$gte = new Date(query.startDate);
    if (query.endDate)   filter.createdAt.$lte = new Date(query.endDate);
  }

  return { filter, page, limit, skip };
};

const paginate = async (filter, sort, skip, limit) => {
  const [data, total] = await Promise.all([
    AuditLog.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  return { data, total };
};

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * GET /api/audit-logs
 * Existing endpoint — all logs (admin only), with pagination + search + date + action filter.
 */
router.get("/", authenticate, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, message: "Forbidden" });

    const { filter, page, limit, skip } = parseQuery(req.query);
    const { data, total } = await paginate(filter, { createdAt: -1 }, skip, limit);

    res.json({ success: true, data, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/audit-logs/entity/:entityType/:entityId
 * Full history for a specific record (any authenticated user who can see the entity).
 * Supports: ?action=, ?startDate=, ?endDate=, ?page=, ?limit=
 */
router.get("/entity/:entityType/:entityId", authenticate, async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    const { filter, page, limit, skip } = parseQuery(req.query);

    // Match on EITHER the new entityType/entityId fields OR the legacy resource/resourceId fields
    filter.$and = [
      {
        $or: [
          { entityType, entityId },
          { resource: entityType, resourceId: entityId },
        ],
      },
    ];

    const { data, total } = await paginate(filter, { createdAt: -1 }, skip, limit);
    res.json({ success: true, data, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/audit-logs/user/:userId
 * Activity for a specific user (admin only).
 * Supports: ?action=, ?startDate=, ?endDate=, ?page=, ?limit=
 */
router.get("/user/:userId", authenticate, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, message: "Forbidden" });

    const { filter, page, limit, skip } = parseQuery(req.query);
    filter.userId = req.params.userId;

    const { data, total } = await paginate(filter, { createdAt: -1 }, skip, limit);
    res.json({ success: true, data, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/audit-logs/my-activity
 * Logged-in user's own activity — no admin gate.
 * Supports: ?action=, ?startDate=, ?endDate=, ?page=, ?limit=
 */
router.get("/my-activity", authenticate, async (req, res) => {
  try {
    const { filter, page, limit, skip } = parseQuery(req.query);
    filter.userId = req.user._id;

    const { data, total } = await paginate(filter, { createdAt: -1 }, skip, limit);
    res.json({ success: true, data, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
