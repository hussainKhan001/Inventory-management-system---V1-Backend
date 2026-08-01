var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
import { logger } from "../utils/logger.js";
import mongoose from "mongoose";
import { MaterialRequirement, MRAllocation, Quotation, Inventory, MaterialPlan } from "../models/index.js";
import { getNextSequence } from "../utils/sequence.js";
import { triggerN8nWebhook } from "../utils/webhook.js";
import { POService } from "./po.service.js";
import { broadcast } from "../utils/broadcaster.js";
class MRService {
  static {
    __name(this, "MRService");
  }
  static async query(params) {
    const page = parseInt(params.page) || 1;
    const limit = parseInt(params.limit) || 100;
    const skip = (page - 1) * limit;
    const search = params.search || "";
    const status = params.status;
    let query = {};
    if (search) {
      const searchRegex = new RegExp(search.replace(/[.*+?^${}()|[]\]/g, "$&"), "i");
      query.$or = [
        { id: searchRegex },
        { project: searchRegex },
        { requesterName: searchRegex },
        { status: searchRegex }
      ];
    }
    if (status) query.status = status;
    const [items, total] = await Promise.all([
      MaterialRequirement.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      MaterialRequirement.countDocuments(query).lean()
    ]);
    return {
      items,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
    };
  }
  static async getById(id) {
    const mr = await MaterialRequirement.findOne({ id });
    if (!mr) throw new Error("Material Requirement not found");
    return mr;
  }
  static async create(data, createdBy) {
    if (data.planId) {
      const plan = await MaterialPlan.findOne({ id: data.planId }).lean();
      if (!plan) throw new Error(`Material plan ${data.planId} not found`);
      const planEngineer = (plan.engineer || "").trim().toLowerCase();
      const requester = (data.requesterName || "").trim().toLowerCase();
      if (planEngineer && planEngineer !== requester) {
        throw new Error(`You (${data.requesterName}) are not assigned to plan ${data.planId}`);
      }
      const existingMRs = await MaterialRequirement.find({ planId: data.planId }).lean();
      for (const item of data.items || []) {
        const planItem = (plan.items || []).find(
          (pi) => item.sku && item.sku !== "N/A" && pi.sku && pi.sku === item.sku || (pi.itemName || pi.materialName || "").toLowerCase().trim() === (item.materialName || "").toLowerCase().trim()
        );
        if (!planItem) {
          throw new Error(`"${item.materialName}" is not in material plan ${data.planId}`);
        }
        const usedQty = existingMRs.reduce((sum, mr2) => {
          const mi = (mr2.items || []).find(
            (i) => item.sku && item.sku !== "N/A" && i.sku && i.sku === item.sku || (i.materialName || "").toLowerCase().trim() === (item.materialName || "").toLowerCase().trim()
          );
          return sum + (mi?.qty || 0);
        }, 0);
        const remaining = Math.max(0, (planItem.required || 0) - usedQty);
        if ((item.qty || 0) > remaining) {
          throw new Error(`"${item.materialName}": plan allows ${planItem.required}, already requested ${usedQty}, only ${remaining} remaining`);
        }
      }
    }
    const year = (/* @__PURE__ */ new Date()).getFullYear();
    const seq = await getNextSequence("MR");
    const customId = `MR-${year}-${seq}`;
    const mr = await MaterialRequirement.create({
      ...data,
      id: customId,
      mrNumber: customId,
      status: data.status || "Store Pending",
      date: data.date || (/* @__PURE__ */ new Date()).toISOString()
    });
    triggerN8nWebhook("MATERIAL_REQ", {
      requirementId: mr.id,
      requesterName: mr.requesterName,
      project: mr.project,
      items: (mr.items || []).map(item => ({
        name: item.materialName || item.itemName || item.name || "",
        sku: item.sku || "",
        qty: item.qty,
        unit: item.unit || "",
      })),
      location: mr.location,
      createdBy
    }).catch((err) => logger.error("[MRService] MR create webhook failed:", err));
    return mr;
  }
  static async update(id, data, updatedBy) {
    const mr = await MaterialRequirement.findOneAndUpdate({ id }, { $set: data }, { returnDocument: 'after' });
    if (!mr) throw new Error("Material Requirement not found");
    triggerN8nWebhook("MR_UPDATE", {
      requirementId: mr.id,
      project: mr.project,
      status: mr.status,
      updatedBy
    }).catch((err) => logger.error("[MRService] MR update webhook failed:", err));
    return mr;
  }
  static async delete(id, deletedBy) {
    const mr = await MaterialRequirement.findOne({ id });
    if (!mr) throw new Error("Material Requirement not found");
    await this.cascadeDeleteMR(id);
    triggerN8nWebhook("MR_DELETE", {
      requirementId: id,
      project: mr.project,
      deletedBy
    }).catch((err) => logger.error("[MRService] MR delete webhook failed:", err));
    return true;
  }
  static async cascadeDeleteMR(mrId) {
    await Quotation.deleteMany({ mrId });
    await MRAllocation.deleteMany({ mrId });
    const pos = await mongoose.model("PurchaseOrder").find({ mrId });
    for (const po of pos) {
      await POService.cascadeDeletePO(po.id);
    }
    await MaterialRequirement.deleteOne({ id: mrId });
    broadcast({ type: "DATA_UPDATED", path: "material-requirements" });
    broadcast({ type: "DATA_UPDATED", path: "quotations" });
    broadcast({ type: "DATA_UPDATED", path: "mr-allocations" });
  }
  // --- Stock Allocation Logic ---
  static async allocate(mrId, allocItems, allocatedBy) {
    const session = { startTransaction: /* @__PURE__ */ __name(() => {
    }, "startTransaction"), commitTransaction: /* @__PURE__ */ __name(async () => {
    }, "commitTransaction"), abortTransaction: /* @__PURE__ */ __name(async () => {
    }, "abortTransaction"), endSession: /* @__PURE__ */ __name(() => {
    }, "endSession") };
    session.startTransaction();
    try {
      const mr = await MaterialRequirement.findOne({ id: mrId });
      if (!mr) throw new Error("Material Requisition not found");
      for (const allocReq of allocItems) {
        if (!allocReq.sku || !allocReq.qty || allocReq.qty <= 0) continue;
        const mrItem = mr.items.find((i) => i.sku === allocReq.sku);
        if (!mrItem) continue;
        const needed = Math.max(0, mrItem.qty - (mrItem.allocatedQty || 0));
        const finalAllocQty = Math.min(allocReq.qty, needed);
        if (finalAllocQty <= 0) continue;
        const inv = await Inventory.findOne({ sku: allocReq.sku });
        if (!inv) throw new Error(`Item ${allocReq.sku} not found in inventory`);
        const actualAvailable = Math.max(0, (inv.liveStock || 0) - (inv.allocatedQty || 0));
        if (actualAvailable < finalAllocQty) {
          throw new Error(`Insufficient available stock for ${inv.itemName} (${allocReq.sku}). Available: ${actualAvailable}, Requested: ${finalAllocQty}`);
        }
        inv.allocatedQty = (inv.allocatedQty || 0) + finalAllocQty;
        inv.availableQty = Math.max(0, (inv.liveStock || 0) - inv.allocatedQty);
        inv.totalQty = (inv.liveStock || 0) + (inv.issuedQty || 0);
        await inv.save({});
        await MRAllocation.create([{
          id: `ALC-${mr.id}-${allocReq.sku}-${Date.now()}`,
          mrId: mr.id,
          mrNumber: mr.mrNumber || mr.id,
          engineerName: mr.requesterName,
          projectName: mr.project,
          sku: allocReq.sku,
          itemName: inv.itemName,
          allocatedQty: finalAllocQty,
          remainingQty: finalAllocQty,
          issuedQty: 0,
          allocatedBy,
          allocationDate: (/* @__PURE__ */ new Date()).toISOString(),
          date: (/* @__PURE__ */ new Date()).toISOString().split("T")[0]
        }]);
        mrItem.allocatedQty = (mrItem.allocatedQty || 0) + finalAllocQty;
        if (mrItem.allocatedQty >= mrItem.qty) {
          mrItem.status = "Allocated";
        } else {
          mrItem.status = "Partial";
        }
      }
      const allAllocated = mr.items.every((i) => i.status === "Allocated" || i.status === "Issued");
      mr.status = allAllocated ? "Allocated" : "Store Pending";
      await mr.save({});
      await session.commitTransaction();
      return true;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }
  // --- Allocations queries ---
  static async queryAllocations(params) {
    const page = parseInt(params.page) || 1;
    const limit = parseInt(params.limit) || 100;
    const skip = (page - 1) * limit;
    const search = params.search || "";
    let query = {};
    if (search) {
      const searchRegex = new RegExp(search.replace(/[.*+?^${}()|[]\]/g, "$&"), "i");
      query.$or = [
        { id: searchRegex },
        { mrId: searchRegex },
        { sku: searchRegex },
        { projectName: searchRegex }
      ];
    }
    const [items, total] = await Promise.all([
      MRAllocation.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      MRAllocation.countDocuments(query).lean()
    ]);
    return {
      items,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
    };
  }
  static async getAllocationById(id) {
    const allocation = await MRAllocation.findOne({ id });
    if (!allocation) throw new Error("Allocation not found");
    return allocation;
  }
}
export {
  MRService
};
