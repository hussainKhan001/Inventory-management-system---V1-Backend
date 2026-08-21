import fs from "fs";
import path from "path";
import zlib from "zlib";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import mongoose from "mongoose";
import { logger } from "./logger.js";

// Where backups are stored — override with BACKUP_DIR env var
const BACKUP_ROOT = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.resolve("backups");

// How many days of backups to keep
const KEEP_DAYS = parseInt(process.env.BACKUP_KEEP_DAYS || "30", 10);

// Collections to skip (internal/large/transient data)
const SKIP_COLLECTIONS = new Set(["sessions", "auditlogs"]);

/**
 * Run a full database backup.
 * Exports every collection to <BACKUP_ROOT>/YYYY-MM-DD/<collection>.json.gz
 * Deletes backup folders older than KEEP_DAYS.
 * Returns a summary object.
 */
export async function runDatabaseBackup() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB not connected — cannot backup");

  // Date-stamped folder
  const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
  const backupDir = path.join(BACKUP_ROOT, dateStr);
  fs.mkdirSync(backupDir, { recursive: true });

  const collections = await db.listCollections().toArray();
  const summary = { date: dateStr, collections: [], totalDocs: 0, totalSizeKB: 0 };

  for (const col of collections) {
    const name = col.name;
    if (SKIP_COLLECTIONS.has(name.toLowerCase())) continue;

    const outPath = path.join(backupDir, `${name}.json.gz`);

    try {
      const docs = await db.collection(name).find({}).toArray();
      const json  = JSON.stringify(docs);
      const bytes = Buffer.from(json, "utf8");

      // Write as gzip-compressed JSON
      const readable = Readable.from([bytes]);
      const gzip     = zlib.createGzip({ level: 6 });
      const dest     = fs.createWriteStream(outPath);
      await pipeline(readable, gzip, dest);

      const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
      summary.collections.push({ name, docs: docs.length, sizeKB: Number(sizeKB) });
      summary.totalDocs    += docs.length;
      summary.totalSizeKB  += Number(sizeKB);

      logger.info(`[Backup] ${name}: ${docs.length} docs → ${sizeKB} KB`);
    } catch (err) {
      logger.error(`[Backup] Failed to backup collection ${name}:`, err.message);
      summary.collections.push({ name, error: err.message });
    }
  }

  // Write a human-readable manifest
  const manifest = {
    timestamp: new Date().toISOString(),
    date: dateStr,
    totalCollections: summary.collections.length,
    totalDocs: summary.totalDocs,
    totalSizeKB: Math.round(summary.totalSizeKB),
    collections: summary.collections,
  };
  fs.writeFileSync(path.join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  logger.info(`[Backup] Completed: ${summary.collections.length} collections, ${summary.totalDocs} docs, ${Math.round(summary.totalSizeKB)} KB total`);

  // Prune old backups
  await pruneOldBackups();

  return manifest;
}

async function pruneOldBackups() {
  if (!fs.existsSync(BACKUP_ROOT)) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS);

  const entries = fs.readdirSync(BACKUP_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Folder name must be YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;

    const folderDate = new Date(entry.name);
    if (isNaN(folderDate.getTime())) continue;

    if (folderDate < cutoff) {
      const fullPath = path.join(BACKUP_ROOT, entry.name);
      fs.rmSync(fullPath, { recursive: true, force: true });
      logger.info(`[Backup] Pruned old backup: ${entry.name}`);
    }
  }
}

/**
 * Restore a single collection from a .json.gz backup file.
 * Drops the collection first, then reinserts all documents.
 */
export async function restoreCollection(gzFilePath) {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB not connected");

  const colName = path.basename(gzFilePath, ".json.gz");
  const compressed = fs.readFileSync(gzFilePath);
  const json = zlib.gunzipSync(compressed).toString("utf8");
  const docs = JSON.parse(json);

  const col = db.collection(colName);
  await col.drop().catch(() => {}); // ignore if not exists
  if (docs.length > 0) await col.insertMany(docs);

  logger.info(`[Restore] ${colName}: ${docs.length} docs restored`);
  return { collection: colName, restored: docs.length };
}

export { BACKUP_ROOT, KEEP_DAYS };
