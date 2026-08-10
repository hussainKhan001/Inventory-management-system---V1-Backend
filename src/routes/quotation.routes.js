import { Router } from "express";
import { createCrudRoutes } from "../utils/crud.js";
import { Quotation, MaterialRequirement } from "../models/index.js";
import { authenticate } from "../middleware/auth.middleware.js";
import { broadcast } from "../utils/broadcaster.js";
import { triggerN8nWebhook } from "../utils/webhook.js";
import { createNotification } from "../utils/notification.js";
const router = Router();
router.put("/:id", authenticate, async (req, res) => {
  try {
    const data = { ...req.body };
    const oldQuote = await Quotation.findOne({ id: req.params.id });
    const quote = await Quotation.findOneAndUpdate({ id: req.params.id }, data, { returnDocument: 'after' });
    if (!quote) return res.status(404).json({ success: false, message: "Quotation not found" });
    broadcast({ type: "DATA_UPDATED", path: "quotations" });
    if (quote.mrId) {
      const allQuotes = await Quotation.find({ mrId: quote.mrId });
      const approvedQuotes = allQuotes.filter((q) => q.status === "Approved");
      if (approvedQuotes.length > 0) {
        const approvals = approvedQuotes.map((q) => ({
          category: q.category || "General",
          quotationId: q.id,
          supplierName: q.supplierName,
          approvedAt: /* @__PURE__ */ new Date()
        }));
        await MaterialRequirement.findOneAndUpdate(
          { id: quote.mrId },
          {
            approvedQuotationId: approvedQuotes[0].id,
            approvedSupplier: approvedQuotes[0].supplierName,
            approvals
          }
        );
        if (oldQuote && oldQuote.status !== quote.status && quote.status === "Approved") {
          await createNotification({
            message: `MR ${quote.mrId} approved by AGM as Quotation ${quote.id} was selected`,
            severity: "success",
            path: "material-requirements"
          });
        }
      } else {
        await MaterialRequirement.findOneAndUpdate(
          { id: quote.mrId },
          {
            status: "Quotation Phase",
            $unset: { approvedQuotationId: "", approvedSupplier: "" },
            approvals: []
          }
        );
        if (oldQuote && oldQuote.status === "Approved" && quote.status !== "Approved") {
          await createNotification({
            message: `MR ${quote.mrId} reset to Pending because approved Quotation ${quote.id} was ${quote.status}`,
            severity: "warning",
            path: "material-requirements"
          });
        }
      }
      broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
    }
    if (oldQuote && oldQuote.status !== quote.status) {
      await createNotification({
        message: `QUOTATION ${quote.id} status changed to ${quote.status} by ${req.user.name}`,
        severity: quote.status === "Approved" ? "success" : "info",
        path: "quotations",
        senderId: req.user._id
      });
    }
    await triggerN8nWebhook("QUOTATION_UPDATE", {
      quotationId: quote.id,
      mrId: quote.mrId,
      supplierName: quote.supplierName,
      previousStatus: oldQuote?.status,
      newStatus: quote.status,
      updatedBy: req.user.name
    });
    res.json({ success: true, data: quote });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
createCrudRoutes(router, Quotation, "quotations", "id", void 0, "QUOTATION");
var stdin_default = router;
export {
  stdin_default as default
};
