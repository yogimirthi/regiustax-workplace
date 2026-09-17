const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const db = require('./database.js');
const qrcode = require('qrcode');

const ROOT_DIR = __dirname;
const DESKTOP_DIR = path.join(process.env.USERPROFILE || 'C:\\Users\\yugandhar', 'Desktop');
const DESKTOP_LINK_FILE = path.join(DESKTOP_DIR, 'RegiusTax_Active_Link.txt');
const ARTIFACT_DIR = 'C:\\Users\\yugandhar\\.gemini\\antigravity\\brain\\276d8d60-1855-45bc-b682-e7462e603055';

console.log('====================================================');
console.log('   RegiusTax Workplace Auto-Runner & Tunnel Manager ');
console.log('====================================================');

// 1. Check if Node server is running on port 3000
function checkServerRunning() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:3000/api/health', (res) => {
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function startServerIfNeeded() {
  const isRunning = await checkServerRunning();
  if (isRunning) {
    console.log('✅ Local server is already running on port 3000.');
    return;
  }

  console.log('⏳ Starting local server (server.js)...');
  const serverProcess = spawn(process.execPath, [path.join(ROOT_DIR, 'server.js')], {
    cwd: ROOT_DIR,
    detached: false,
    stdio: 'ignore'
  });

  serverProcess.unref();

  // Wait for server to start
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 600));
    const ready = await checkServerRunning();
    if (ready) {
      console.log('✅ Local server started successfully on port 3000!');
      return;
    }
  }
  console.log('⚠️ Server started, continuing...');
}

// 2. Start Cloudflare Tunnel and monitor URL
async function startTunnel() {
  await startServerIfNeeded();

  console.log('⏳ Connecting secure Cloudflare tunnel to port 3000...');
  const cloudflaredExe = path.join(ROOT_DIR, 'cloudflared.exe');
  
  if (!fs.existsSync(cloudflaredExe)) {
    console.error('❌ cloudflared.exe not found at:', cloudflaredExe);
    return;
  }

  const tunnel = spawn(cloudflaredExe, ['tunnel', '--protocol', 'http2', '--metrics', '127.0.0.1:0', '--url', 'http://localhost:3000'], {
    cwd: ROOT_DIR
  });

  let detectedUrl = null;

  function processOutput(data) {
    const text = data.toString();
    // Look for trycloudflare.com URL
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && !detectedUrl) {
      detectedUrl = match[0];
      handleNewTunnelUrl(detectedUrl);
    }
  }

  tunnel.stdout.on('data', processOutput);
  tunnel.stderr.on('data', processOutput);

  tunnel.on('close', (code) => {
    console.log(`⚠️ Tunnel process exited with code ${code}. Reconnecting in 5s...`);
    setTimeout(startTunnel, 5000);
  });
}

async function handleNewTunnelUrl(url) {
  console.log('\n====================================================');
  console.log('🎉 ACTIVE PUBLIC HTTPS LINK IS LIVE!');
  console.log('====================================================');
  console.log(`\n👉 Gateway:   ${url}/gateway`);
  console.log(`👉 Employee:  ${url}/employee  (Password: RegiusStaff@2026)`);
  console.log(`👉 Admin:     ${url}/admin     (Password: RegiusAdmin@2026)\n`);
  console.log('====================================================');

  try {
    // 1. Save in database
    await db.setSetting('public_base_url', url);

    // 2. Generate QR codes
    const qrs = [
      { file: 'qr_remote_gateway.png', target: `${url}/gateway`, color: '#1e1b4b' },
      { file: 'qr_remote_employee.png', target: `${url}/employee`, color: '#065f46' },
      { file: 'qr_remote_admin.png', target: `${url}/admin`, color: '#312e81' }
    ];

    for (const q of qrs) {
      if (fs.existsSync(ARTIFACT_DIR)) {
        await qrcode.toFile(path.join(ARTIFACT_DIR, q.file), q.target, {
          width: 350, margin: 2, color: { dark: q.color, light: '#ffffff' }
        });
      }
      const publicImgDir = path.join(ROOT_DIR, 'public', 'images');
      if (fs.existsSync(publicImgDir)) {
        await qrcode.toFile(path.join(publicImgDir, q.file), q.target, {
          width: 350, margin: 2, color: { dark: q.color, light: '#ffffff' }
        });
      }
    }

    // 3. Write active link info directly to Desktop file
    const desktopContent = `====================================================
   RegiusTax Workplace - Active Online Link
====================================================
Status: ONLINE (Encrypted HTTPS)
Updated: ${new Date().toLocaleString()}

👉 Workplace Gateway (Share with All Staff):
${url}/gateway

👉 Direct Employee Portal:
${url}/employee
(Default Password: RegiusStaff@2026)

👉 Direct Admin Console:
${url}/admin
(Default Password: RegiusAdmin@2026)

👉 Outside Client Helpdesk:
${url}/client
====================================================
Note: Keep this laptop on and connected to internet.
Whenever the laptop restarts, this file auto-updates!
====================================================
`;
    fs.writeFileSync(DESKTOP_LINK_FILE, desktopContent, 'utf8');
    console.log(`✅ Saved active link to your Desktop: ${DESKTOP_LINK_FILE}`);

    // 4. Copy URL to Windows clipboard
    try {
      const proc = spawn('clip');
      proc.stdin.write(`${url}/gateway`);
      proc.stdin.end();
      console.log('📋 Copied Gateway URL to your clipboard! (Press Ctrl+V to paste)');
    } catch (e) {}

  } catch (err) {
    console.error('Error handling tunnel URL:', err);
  }
}

startTunnel();
