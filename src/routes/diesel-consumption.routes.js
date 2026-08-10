import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { DieselConsumption } from "../models/index.js";
import { getNextSequence } from "../utils/sequence.js";
import { broadcast } from "../utils/broadcaster.js";
import { logAudit } from "../utils/audit.js";

const router = Router();

router.get("/", authenticate, async (req, res) => {
  try {
    const { site, driverName, equipment, startDate, endDate, page = 1, limit = 200 } = req.query;
    const filter = {};
    if (site) filter.site = { $regex: site, $options: "i" };
    if (driverName) filter.driverName = { $regex: driverName, $options: "i" };
    if (equipment) filter.equipment = { $regex: equipment, $options: "i" };
    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = startDate;
      if (endDate) filter.date.$lte = endDate;
    }
    const skip = (Number(page) - 1) * Number(limit);
    const [data, total] = await Promise.all([
      DieselConsumption.find(filter).sort({ date: -1, createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      DieselConsumption.countDocuments(filter),
    ]);
    res.json({ success: true, data, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/", authenticate, async (req, res) => {
  try {
    const { date, driverName, equipment, site, qtyUsed, meterReading, remarks } = req.body;
    if (!date || !driverName || !equipment || !site || !qtyUsed) {
      return res.status(400).json({ success: false, message: "Date, driver name, equipment, site and quantity are required" });
    }
    const year = new Date().getFullYear();
    const seq = await getNextSequence(`diesel-consumption-${year}`);
    const id = `DC-${year}-${String(seq).padStart(4, "0")}`;
    const entry = new DieselConsumption({
      id,
      date,
      driverName: String(driverName).trim(),
      equipment: String(equipment).trim(),
      site: String(site).trim(),
      qtyUsed: Number(qtyUsed),
      meterReading: meterReading ? String(meterReading).trim() : "",
      remarks: remarks ? String(remarks).trim() : "",
      submittedBy: req.user.name,
      submittedAt: new Date().toISOString(),
    });
    await entry.save();
    broadcast({ type: "DATA_UPDATED", path: "diesel-consumption" });
    logAudit(req.user, "CREATE", "DieselConsumption", id, { site, qtyUsed });
    res.json({ success: true, data: entry });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put("/:id", authenticate, async (req, res) => {
  try {
    const { date, driverName, equipment, site, qtyUsed, meterReading, remarks } = req.body;
    if (!date || !driverName || !equipment || !site || !qtyUsed) {
      return res.status(400).json({ success: false, message: "Date, driver name, equipment, site and quantity are required" });
    }
    const entry = await DieselConsumption.findOneAndUpdate(
      { id: req.params.id },
      { $set: { date, driverName: String(driverName).trim(), equipment: String(equipment).trim(), site: String(site).trim(), qtyUsed: Number(qtyUsed), meterReading: meterReading ? String(meterReading).trim() : "", remarks: remarks ? String(remarks).trim() : "" } },
      { new: true }
    );
    if (!entry) return res.status(404).json({ success: false, message: "Entry not found" });
    broadcast({ type: "DATA_UPDATED", path: "diesel-consumption" });
    logAudit(req.user, "UPDATE", "DieselConsumption", req.params.id, { site, qtyUsed });
    res.json({ success: true, data: entry });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/:id", authenticate, async (req, res) => {
  try {
    const roleLower = (req.user.role || "").toLowerCase().trim();
    const isSuperAdmin = ["super admin", "superadmin", "admin"].includes(roleLower);
    if (!isSuperAdmin) return res.status(403).json({ success: false, message: "Only Super Admin can delete entries" });
    const entry = await DieselConsumption.findOneAndDelete({ id: req.params.id });
    if (!entry) return res.status(404).json({ success: false, message: "Entry not found" });
    broadcast({ type: "DATA_UPDATED", path: "diesel-consumption" });
    logAudit(req.user, "DELETE", "DieselConsumption", req.params.id, {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
