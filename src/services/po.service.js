var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
import { GRN, Inward, Transaction, Outward, PurchaseOrder, MaterialRequirement, Quotation } from "../models/index.js";
import { broadcast } from "../utils/broadcaster.js";
class POService {
  static {
    __name(this, "POService");
  }
  static async cascadeDeletePO(poId, session) {
    const grns = await GRN.find({ poId }).session(session || null);
    for (const grn of grns) {
      await Inward.deleteMany({ grnRef: grn.id }).session(session || null);
      await GRN.deleteOne({ id: grn.id }).session(session || null);
    }
    await Transaction.deleteMany({ poId }).session(session || null);
    await Outward.deleteMany({ poId }).session(session || null);
    const po = await PurchaseOrder.findOne({ id: poId }).session(session || null);
    // Unlock the source quotation when PO is deleted
    if (po && po.quotationId) {
      await Quotation.findOneAndUpdate(
        { id: po.quotationId },
        { $unset: { linkedPoId: "" } }
      ).session(session || null);
      broadcast({ type: "DATA_UPDATED", path: "quotations" });
    }
    // Unlock the MR — reset to Quotation Phase so it can be re-used
    if (po && po.mrId) {
      const otherPOs = await PurchaseOrder.find({ mrId: po.mrId, id: { $ne: poId } }).session(session || null);
      if (otherPOs.length === 0) {
        await MaterialRequirement.updateOne(
          { id: po.mrId },
          { $set: { status: "Quotation Phase" } }
        ).session(session || null);
        broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
      }
    }
    await PurchaseOrder.deleteOne({ id: poId }).session(session || null);
  }

}
export {
  POService
};
