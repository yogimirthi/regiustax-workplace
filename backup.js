const backupService = require('./backupService');

async function main() {
  const arg = process.argv[2];

  if (arg === '--restore') {
    const file = process.argv[3] || 'latest';
    console.log(`[RegiusTax Backup CLI] Restoring from: ${file}...`);
    const result = await backupService.restoreFromBackup(file);
    console.log('✅ Restore completed successfully:', result);
    process.exit(0);
  } else if (arg === '--status') {
    const status = backupService.getBackupStatus();
    console.log('[RegiusTax Backup Status]');
    console.log(`Daily Schedule: ${status.dailySchedule.time} (Next: ${status.dailySchedule.nextRunFormatted}, in ${status.dailySchedule.countdownFormatted})`);
    console.log(`Total Backups: ${status.totalBackups}`);
    if (status.lastBackup) {
      console.log(`Last Backup: ${status.lastBackup.filename} (${status.lastBackup.sizeFormatted}) on ${status.lastBackup.formattedTime}`);
    } else {
      console.log('Last Backup: None yet');
    }
    process.exit(0);
  } else {
    // Default action: Take backup now
    console.log('====================================================');
    console.log('      RegiusTax RTwhat\'s up - Data Backup Utility   ');
    console.log('====================================================');
    console.log('Flushing database & taking snapshot...');
    const manifest = await backupService.takeBackup('manual', 'Manual CLI / Batch backup');
    console.log('====================================================');
    console.log(`✅ Backup Successful!`);
    console.log(`📁 File:     ${manifest.filename}`);
    console.log(`📦 Size:     ${manifest.sizeFormatted}`);
    console.log(`🕒 Time:     ${manifest.formattedTime}`);
    console.log(`📍 Location: ${manifest.filePath}`);
    console.log('====================================================');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('❌ Backup utility error:', err);
  process.exit(1);
});
