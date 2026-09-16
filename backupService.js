const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const db = require('./database');

const ROOT_DIR = __dirname;
const BACKUP_DIR = path.join(ROOT_DIR, 'backups');
const LATEST_DIR = path.join(BACKUP_DIR, 'latest');
const HISTORY_FILE = path.join(BACKUP_DIR, 'backup_history.json');
const MAX_BACKUP_RETENTION = 30; // Keep last 30 daily backups

// Ensure backup directories exist
function ensureDirs() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (!fs.existsSync(LATEST_DIR)) fs.mkdirSync(LATEST_DIR, { recursive: true });
}

// Read / write backup history
function readHistory() {
  ensureDirs();
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch (e) {
      return [];
    }
  }
  return [];
}

function writeHistory(history) {
  ensureDirs();
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

// Format local timestamp YYYY-MM-DD_HH-mm-ss
function formatTimestamp(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const min = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return `${y}-${m}-${day}_${h}-${min}-${s}`;
}

// Copy directory recursively
function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Take an immediate backup (SQLite flushed + uploads + zip + latest mirror)
 */
async function takeBackup(type = 'manual', note = '') {
  ensureDirs();

  // 1. Flush all pending WAL transactions into primary SQLite file
  try {
    if (db.checkpointWal) {
      await db.checkpointWal();
    }
  } catch (err) {
    console.warn('[BackupService] WAL checkpoint warning:', err.message);
  }

  const timestamp = formatTimestamp();
  const zipFileName = `rtwhatsup_backup_${timestamp}.zip`;
  const zipFilePath = path.join(BACKUP_DIR, zipFileName);

  // 2. Mirror into backups/latest/ directory for 1-click zero-extraction restore
  const dbSrc = path.join(ROOT_DIR, 'rtwhatsup.db');
  const dbDest = path.join(LATEST_DIR, 'rtwhatsup.db');
  if (fs.existsSync(dbSrc)) {
    fs.copyFileSync(dbSrc, dbDest);
  }

  const uploadsSrc = path.join(ROOT_DIR, 'uploads');
  const uploadsDest = path.join(LATEST_DIR, 'uploads');
  if (fs.existsSync(uploadsSrc)) {
    copyDirRecursive(uploadsSrc, uploadsDest);
  }

  // 3. Compress using Windows built-in tar.exe into zip
  await new Promise((resolve, reject) => {
    const cmd = `tar -a -cf "${zipFilePath}" rtwhatsup.db uploads`;
    exec(cmd, { cwd: ROOT_DIR }, (err, stdout, stderr) => {
      if (err) {
        console.warn('[BackupService] tar zip warning:', err);
        if (fs.existsSync(zipFilePath)) resolve();
        else reject(err);
      } else {
        resolve();
      }
    });
  });

  // Calculate file size
  let sizeBytes = 0;
  if (fs.existsSync(zipFilePath)) {
    sizeBytes = fs.statSync(zipFilePath).size;
  }

  // 4. Save metadata manifest
  const manifest = {
    id: `bak-${Date.now()}`,
    filename: zipFileName,
    filePath: zipFilePath,
    timestamp: new Date().toISOString(),
    formattedTime: new Date().toLocaleString(),
    type, // 'daily_12pm', 'manual', 'catch_up', 'pre_shutdown'
    sizeBytes,
    sizeFormatted: `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`,
    note: note || (type === 'daily_12pm' ? 'Automated daily 12:00 PM backup' : 'Manual snapshot backup')
  };

  fs.writeFileSync(path.join(LATEST_DIR, 'backup_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // Update history
  const history = readHistory();
  history.unshift(manifest);

  // Cleanup backups beyond retention limit
  if (history.length > MAX_BACKUP_RETENTION) {
    const toDelete = history.slice(MAX_BACKUP_RETENTION);
    for (const old of toDelete) {
      if (old.filePath && fs.existsSync(old.filePath)) {
        try { fs.unlinkSync(old.filePath); } catch (e) {}
      }
    }
    history.splice(MAX_BACKUP_RETENTION);
  }

  writeHistory(history);

  console.log(`[BackupService] ✅ Backup created: ${zipFileName} (${manifest.sizeFormatted}) [${type}]`);
  return manifest;
}

/**
 * Get status of backups, last backup info, and next scheduled daily run
 */
function getBackupStatus() {
  ensureDirs();
  const history = readHistory();
  const now = new Date();
  
  // Calculate next 12:00 PM run
  const nextNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  if (now.getTime() >= nextNoon.getTime()) {
    nextNoon.setDate(nextNoon.getDate() + 1);
  }

  const msUntilNext = nextNoon.getTime() - now.getTime();
  const hoursUntil = Math.floor(msUntilNext / (1000 * 60 * 60));
  const minsUntil = Math.floor((msUntilNext % (1000 * 60 * 60)) / (1000 * 60));

  return {
    dailySchedule: {
      enabled: true,
      time: '12:00 PM',
      nextRunAt: nextNoon.toISOString(),
      nextRunFormatted: nextNoon.toLocaleString(),
      countdownFormatted: `${hoursUntil}h ${minsUntil}m`
    },
    lastBackup: history[0] || null,
    totalBackups: history.length,
    recentBackups: history.slice(0, 10),
    backupDirectory: BACKUP_DIR,
    latestMirrorDirectory: LATEST_DIR
  };
}

/**
 * Restore from latest or specific backup file
 */
async function restoreFromBackup(backupFileName = 'latest') {
  ensureDirs();

  let srcDb = null;
  let srcUploads = null;

  if (backupFileName === 'latest') {
    srcDb = path.join(LATEST_DIR, 'rtwhatsup.db');
    srcUploads = path.join(LATEST_DIR, 'uploads');
  } else {
    const zipPath = path.join(BACKUP_DIR, backupFileName);
    if (!fs.existsSync(zipPath)) {
      throw new Error(`Backup file "${backupFileName}" not found in backups directory`);
    }

    const tempExtract = path.join(BACKUP_DIR, 'temp_restore_' + Date.now());
    fs.mkdirSync(tempExtract, { recursive: true });

    await new Promise((resolve, reject) => {
      exec(`tar -xf "${zipPath}" -C "${tempExtract}"`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    srcDb = path.join(tempExtract, 'rtwhatsup.db');
    srcUploads = path.join(tempExtract, 'uploads');
  }

  if (!fs.existsSync(srcDb)) {
    throw new Error('Backup archive is missing rtwhatsup.db database file.');
  }

  // Stop SQLite WAL
  try {
    if (db.checkpointWal) await db.checkpointWal();
  } catch (e) {}

  // Restore database file
  const destDb = path.join(ROOT_DIR, 'rtwhatsup.db');
  fs.copyFileSync(srcDb, destDb);

  // Restore uploads
  if (fs.existsSync(srcUploads)) {
    const destUploads = path.join(ROOT_DIR, 'uploads');
    copyDirRecursive(srcUploads, destUploads);
  }

  console.log(`[BackupService] 🔄 Restored database and uploads from: ${backupFileName}`);
  return { success: true, restoredFrom: backupFileName, restoredAt: new Date().toISOString() };
}

/**
 * Initialize 12:00 PM Daily Schedule and catch-up check
 */
let dailyTimerHandle = null;

function initDailyScheduler(onBackupTriggered = null) {
  if (dailyTimerHandle) {
    clearTimeout(dailyTimerHandle);
    dailyTimerHandle = null;
  }

  const now = new Date();
  const nextNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  if (now.getTime() >= nextNoon.getTime()) {
    nextNoon.setDate(nextNoon.getDate() + 1);
  }

  const msUntilNextNoon = nextNoon.getTime() - now.getTime();
  console.log(`[BackupService] 🕒 Automated Daily 12:00 PM Backup active! Next trigger in ${(msUntilNextNoon / 1000 / 60 / 60).toFixed(2)} hours (${nextNoon.toLocaleTimeString()})`);

  dailyTimerHandle = setTimeout(async () => {
    try {
      console.log(`[BackupService] ⏰ 12:00 PM Noon reached! Executing automated daily backup...`);
      const manifest = await takeBackup('daily_12pm', 'Scheduled daily 12:00 PM backup');
      if (typeof onBackupTriggered === 'function') {
        onBackupTriggered(manifest);
      }
    } catch (err) {
      console.error('[BackupService] Automated daily backup failed:', err);
    } finally {
      // Reschedule for next day
      initDailyScheduler(onBackupTriggered);
    }
  }, msUntilNextNoon);

  // Catch-up check: If server started today after 12:00 PM and no backup was taken today, take one now!
  const history = readHistory();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const hadBackupToday = history.some(b => (b.timestamp || '').startsWith(todayStr));

  if (!hadBackupToday && now.getHours() >= 12) {
    console.log(`[BackupService] Notice: Today's 12:00 PM backup was missed (laptop was off). Taking catch-up backup now...`);
    takeBackup('catch_up', "Catch-up backup (laptop was shut down at 12:00 PM)").catch(e => {
      console.error('[BackupService] Catch-up backup error:', e);
    });
  }
}

module.exports = {
  takeBackup,
  getBackupStatus,
  restoreFromBackup,
  initDailyScheduler,
  BACKUP_DIR,
  LATEST_DIR
};
