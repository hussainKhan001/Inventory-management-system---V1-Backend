/**
 * One-time backfill: set poLineId + rate on GRN items that predate the
 * rate-tier-split fix, for PO-2026-693 and its GRN(s) ONLY.
 *
 * Root cause: before the fix, GRN items had no reference back to the exact
 * PO line they were received against, so the Accounts screen matched them
 * back to a PO line by sku/itemName — which collapses onto the FIRST
 * matching PO line whenever a PO has multiple lines sharing a sku/name at
 * different rates (a rate-tier split), understating the amount for every
 * line after the first.
 *
 * This script finds GRN items still missing poLineId, tries to match each
 * one to its PO line by sku/itemName, and if that's ambiguous (2+ PO lines
 * share the sku/name), disambiguates by an EXACT received-qty === PO-line-qty
 * match — rate-tier lines are split by quantity, so a unique qty match is a
 * safe, confident signal. Anything still ambiguous after that is printed for
 * manual review and left untouched — never guessed.
 *
 * Usage:
 *   node src/scripts/backfill-po-2026-693-poLineId.js                       (dry run — preview only)
 *   node src/scripts/backfill-po-2026-693-poLineId.js --apply               (writes the confident/unique matches)
 *   node src/scripts/backfill-po-2026-693-poLineId.js --apply --apply-hints (also writes the positional-hint
 *                                                                            matches for same-qty duplicate lines
 *                                                                            — only once you've reviewed and
 *                                                                            confirmed them from a prior dry run)
 */
import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import { PurchaseOrder, GRN } from "../models/index.js";

const TARGET_PO_ID = "PO-2026-693";
const APPLY = process.argv.includes("--apply");
// Off by default — only pass this once you've reviewed the ambiguous list from a
// prior dry run and decided the positional hints are correct for your data.
const APPLY_HINTS = process.argv.includes("--apply-hints");

function matchesSkuOrName(poItem, giItem) {
  return (
    (poItem.sku && giItem.sku && poItem.sku === giItem.sku) ||
    (poItem.itemName || "").toLowerCase() === (giItem.itemName || "").toLowerCase()
  );
}

function resolveMatch(poItems, giItem) {
  const candidates = poItems.filter((pi) => matchesSkuOrName(pi, giItem));
  if (candidates.length === 0) return { status: "no_candidates", candidates: [] };
  if (candidates.length === 1) return { status: "confident", match: candidates[0], candidates };
  const rcv = giItem.received ?? giItem.qty ?? 0;
  const byQty = candidates.filter((pi) => (pi.qty || 0) === rcv);
  if (byQty.length === 1) return { status: "confident", match: byQty[0], candidates, disambiguatedBy: "qty" };
  return { status: "ambiguous", candidates };
}

// NOT used to auto-resolve anything — only printed alongside an ambiguous item as a
// hint. The GRN's items[] was originally built by iterating po.items in order
// (GRN.jsx's po.items.map(...)), so an item's position within its own
// sku/name-duplicate group often lines up with the same position in the PO's
// duplicate group. That's a real signal but not proof (a PO edited after the GRN
// was created could break the alignment), so it stays a suggestion for you to
// visually confirm against the PO/GRN screens — never written automatically.
function positionalHint(poItems, allGiItemsInSameArray, giItem, candidates) {
  const key = (it) => (it.sku || (it.itemName || "").toLowerCase());
  const giKey = key(giItem);
  const giGroup = allGiItemsInSameArray.filter((it) => key(it) === giKey);
  const giIdx = giGroup.indexOf(giItem);
  const poGroup = poItems.filter((it) => key(it) === giKey);
  if (giGroup.length !== poGroup.length || giIdx === -1) return null;
  return poGroup[giIdx];
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to MongoDB. Target PO: ${TARGET_PO_ID}. Mode: ${APPLY ? "APPLY (writing)" : "DRY RUN (preview only)"}`);

  const po = await PurchaseOrder.findOne({ id: TARGET_PO_ID }).lean();
  if (!po) {
    console.log(`\nPO ${TARGET_PO_ID} not found in this database — nothing to do. (Point MONGODB_URI at the right environment.)`);
    await mongoose.disconnect();
    return;
  }

  console.log(`\nPO ${po.id} line items:`);
  po.items.forEach((it, i) =>
    console.log(`  [${i}] _id=${it._id}  sku=${it.sku}  itemName="${it.itemName}"  qty=${it.qty}  rate=${it.rate}`)
  );

  const grns = await GRN.find({ poId: TARGET_PO_ID });
  if (grns.length === 0) {
    console.log(`\nNo GRNs found for ${TARGET_PO_ID}.`);
    await mongoose.disconnect();
    return;
  }

  let confidentCount = 0, ambiguousCount = 0, alreadySetCount = 0, noMatchCount = 0;
  const ambiguousList = [];

  for (const grn of grns) {
    console.log(`\n=== GRN ${grn.id} (status: ${grn.status}, isDeleted: ${!!grn.isDeleted}) ===`);
    let grnChanged = false;

    const processItemArray = (items, label) => {
      items.forEach((it, idx) => {
        if (it.poLineId) {
          alreadySetCount++;
          console.log(`  [${label}#${idx}] sku=${it.sku} "${it.itemName}" — already has poLineId, skipping`);
          return;
        }
        const result = resolveMatch(po.items, it);
        if (result.status === "confident") {
          const oldRate = it.rate;
          console.log(
            `  [${label}#${idx}] sku=${it.sku} "${it.itemName}" received=${it.received ?? it.qty} -> MATCH PO line _id=${result.match._id} qty=${result.match.qty} rate=${result.match.rate}` +
            (result.disambiguatedBy ? ` (disambiguated by ${result.disambiguatedBy})` : "") +
            ` | rate: ${oldRate ?? "(none)"} -> ${result.match.rate}`
          );
          confidentCount++;
          if (APPLY) {
            it.poLineId = String(result.match._id);
            it.rate = result.match.rate;
            grnChanged = true;
          }
        } else if (result.status === "ambiguous") {
          console.log(`  [${label}#${idx}] sku=${it.sku} "${it.itemName}" received=${it.received ?? it.qty} -> AMBIGUOUS, candidates:`);
          result.candidates.forEach((c) => console.log(`      candidate _id=${c._id} qty=${c.qty} rate=${c.rate}`));
          const hint = positionalHint(po.items, items, it, result.candidates);
          const resolvedByHint = hint && APPLY_HINTS;
          if (hint) {
            const oldRate = it.rate;
            console.log(
              `      hint: position within its sku/name group lines up with PO line _id=${hint._id} qty=${hint.qty} rate=${hint.rate}` +
              (resolvedByHint ? ` | rate: ${oldRate ?? "(none)"} -> ${hint.rate} (APPLYING — you confirmed positional hints)` : ` (NOT applied — re-run with --apply-hints once you've confirmed)`)
            );
          }
          if (resolvedByHint) {
            confidentCount++;
            if (APPLY) {
              it.poLineId = String(hint._id);
              it.rate = hint.rate;
              grnChanged = true;
            }
          } else {
            ambiguousCount++;
            ambiguousList.push({ grnId: grn.id, label, idx, sku: it.sku, itemName: it.itemName, received: it.received ?? it.qty, candidates: result.candidates, hint });
          }
        } else {
          console.log(`  [${label}#${idx}] sku=${it.sku} "${it.itemName}" -> NO MATCHING PO LINE FOUND (left untouched)`);
          noMatchCount++;
        }
      });
    };

    processItemArray(grn.items || [], "items");
    (grn.receipts || []).forEach((r, ridx) => processItemArray(r.items || [], `receipt${ridx}.items`));

    if (APPLY && grnChanged) {
      grn.markModified("items");
      grn.markModified("receipts");
      await grn.save();
      console.log(`  -> saved GRN ${grn.id}`);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Confident matches: ${confidentCount}${APPLY ? " (written)" : " (would be written — re-run with --apply)"}`);
  console.log(`Already had poLineId: ${alreadySetCount}`);
  console.log(`Ambiguous (needs manual decision, NOT touched): ${ambiguousCount}`);
  console.log(`No matching PO line found (NOT touched): ${noMatchCount}`);
  if (ambiguousList.length) {
    console.log(`\nAmbiguous items requiring manual confirmation:`);
    ambiguousList.forEach((a) =>
      console.log(
        `  GRN ${a.grnId} ${a.label}[${a.idx}] sku=${a.sku} "${a.itemName}" received=${a.received} candidates=[${a.candidates.map((c) => `_id=${c._id},qty=${c.qty},rate=${c.rate}`).join(" | ")}]` +
        (a.hint ? `  hint: _id=${a.hint._id},qty=${a.hint.qty},rate=${a.hint.rate}` : "")
      )
    );
  }

  if (!APPLY) console.log(`\nDRY RUN complete — no changes written. Re-run with --apply to write the confident matches above.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
