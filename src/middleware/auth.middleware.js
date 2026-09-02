var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
import jwt from "jsonwebtoken";
import { User, RolePermission } from "../models/index.js";
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV !== "production" ? "dev-only-secret" : "");

// Cache user lookups for 60 seconds to avoid a DB hit on every request
const _userCache = new Map();
const USER_CACHE_TTL = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _userCache) if (v.exp < now) _userCache.delete(k);
}, 120_000);

const authenticate = /* @__PURE__ */ __name(async (req, res, next) => {
  let token = req.headers.authorization?.split(" ")[1] || req.cookies?.token;
  if (token === "null" || token === "undefined") {
    token = null;
  }
  if (!token) return res.status(401).json({ success: false, message: "Unauthorized" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const cached = _userCache.get(token);
    if (cached && cached.exp > Date.now()) {
      req.user = cached.user;
    } else {
      req.user = await User.findById(decoded.id);
      if (req.user) _userCache.set(token, { user: req.user, exp: Date.now() + USER_CACHE_TTL });
    }
    if (!req.user || !req.user.isActive) return res.status(401).json({ success: false, message: "Unauthorized" });
    next();
  } catch (error) {
    res.status(401).json({ success: false, message: "Unauthorized" });
  }
}, "authenticate");
async function serverHasPermission(user, permission) {
  if (!user) return false;
  const roleLower = (user.role || "").toLowerCase().trim();
  if (roleLower === "super admin" || roleLower === "superadmin" || roleLower === "admin") return true;
  if (permission.startsWith("VIEW_")) return true;
  // Escape special regex chars so role names like "L1 (AGM)" don't break the pattern
  const escapedRole = (user.role || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rolePerm = await RolePermission.findOne({ role: { $regex: new RegExp(`^${escapedRole}$`, "i") } });
  if (rolePerm?.permissions.includes(permission)) return true;
  if (user.permissions?.includes(permission)) return true;
  if (Array.isArray(user.rolePermissions) && user.rolePermissions.includes(permission)) return true;
  return false;
}
__name(serverHasPermission, "serverHasPermission");
// Machine-to-machine auth for internal/n8n calls — no user session required.
// Set INTERNAL_API_KEY in .env and pass it as the x-api-key request header.
const authenticateInternal = /* @__PURE__ */ __name((req, res, next) => {
  const key = req.headers["x-api-key"];
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    return res.status(503).json({ success: false, message: "Internal API key not configured on server" });
  }
  if (!key || key !== expected) {
    return res.status(401).json({ success: false, message: "Invalid or missing x-api-key" });
  }
  next();
}, "authenticateInternal");

export {
  authenticate,
  authenticateInternal,
  serverHasPermission
};
