import { Router } from "express";
import { createCrudRoutes } from "../utils/crud.js";
import { Inventory, Catalogue } from "../models/index.js";
const router = Router();
router.get("/next-sku", async (req, res) => {
  try {
    const { prefix } = req.query;
    if (!prefix) return res.status(400).json({ success: false, message: "prefix is required" });
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^${escaped}`, "i");
    const [invDocs, catDocs] = await Promise.all([
      Inventory.find({ sku: regex }, { sku: 1, _id: 0 }).lean(),
      Catalogue.find({ sku: regex }, { sku: 1, _id: 0 }).lean()
    ]);
    let maxNum = 0;
    for (const doc of [...invDocs, ...catDocs]) {
      const parts = doc.sku.split("/");
      const n = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(n)) maxNum = Math.max(maxNum, n);
    }
    const nextSku = `${prefix.toUpperCase()}${String(maxNum + 1).padStart(4, "0")}`;
    res.json({ success: true, data: nextSku });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
createCrudRoutes(router, Inventory, "inventory", "sku", void 0, "INVENTORY", { softDelete: true });
var stdin_default = router;
export {
  stdin_default as default
};
