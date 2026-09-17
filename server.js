const express = require('express');
const compression = require('compression');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const cors = require('cors');
const QRCode = require('qrcode');
const db = require('./database');
const backupService = require('./backupService');

// Process-level guards against unhandled crashes
process.on('uncaughtException', (err) => {
  console.error('[Process Guard] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Process Guard] Unhandled Rejection:', reason);
});

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 50 * 1024 * 1024 // 50 MB max payload
});

const PORT = process.env.PORT || 3000;

// Ensure upload directory exists (support persistent cloud volume)
const UPLOADS_DIR = process.env.UPLOADS_DIR || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'uploads') : path.join(__dirname, 'uploads'));
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Health check endpoint for cloud load balancers and uptime monitors
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    service: "RegiusTax Workplace"
  });
});

// Multer storage for documents, images, and voice notes
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safeName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e5);
    cb(null, `${safeName}-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit for tax documents and scans
});

// Compression & Performance Middleware
app.use(compression({
  threshold: 1024,
  level: 6
}));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { 
  index: false,
  maxAge: '1d',
  etag: true
}));
app.use('/uploads', express.static(UPLOADS_DIR, {
  maxAge: '7d',
  etag: true
}));

// Auto-detect local network IPv4 address
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const ifaceList = interfaces[devName];
    for (const iface of ifaceList) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const localIp = getLocalIpAddress();
const networkUrl = `http://${localIp}:${PORT}`;

// Pre-generate QR code data URL for colleagues to scan on phone
let qrCodeDataUrl = '';
QRCode.toDataURL(networkUrl, { width: 280, margin: 2 }, (err, url) => {
  if (!err) qrCodeDataUrl = url;
});

// Online users tracking: userId -> Set of socketIds
const onlineUsers = new Map();

function isUserOnline(userId) {
  const sockets = onlineUsers.get(userId);
  return sockets && sockets.size > 0;
}

// REST API Endpoints

// In-memory HTML template caches (eliminates disk I/O latency on repeat requests)
let cachedIndexHtml = null;
function getIndexTemplate() {
  if (!cachedIndexHtml || process.env.NODE_ENV === 'development') {
    cachedIndexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  }
  return cachedIndexHtml;
}

let cachedGatewayHtml = null;
function getGatewayTemplate() {
  if (!cachedGatewayHtml || process.env.NODE_ENV === 'development') {
    const gatewayPath = path.join(__dirname, 'public', 'gateway.html');
    if (fs.existsSync(gatewayPath)) {
      cachedGatewayHtml = fs.readFileSync(gatewayPath, 'utf8');
    }
  }
  return cachedGatewayHtml;
}

// Helper to serve the main app with role-specific preloaded state
async function serveAppWithState(req, res, portalMode = 'admin') {
  try {
    let html = getIndexTemplate();

    const users = await db.getUsers();
    const departments = await db.getDepartments();
    
    let defaultUser;
    if (portalMode === 'admin') {
      defaultUser = users.find(u => u.role === 'Admin') || users[0];
    } else {
      const deptQuery = req.query.dept;
      const userQuery = req.query.user || req.query.userId || req.query.email;
      if (userQuery) {
        defaultUser = users.find(u => u.id === userQuery || u.email.toLowerCase() === userQuery.toLowerCase());
      }
      if (!defaultUser && deptQuery) {
        defaultUser = users.find(u => u.role === 'Employee' && (u.department || '').toLowerCase().includes(deptQuery.toLowerCase()));
      }
      if (!defaultUser) {
        defaultUser = users.find(u => u.role === 'Employee') || users[0];
      }
    }

    const channels = defaultUser ? await db.getChannelsForUser(defaultUser.id) : [];
    const activeChanId = channels.length > 0 ? channels[0].id : null;
    const initialMessages = activeChanId ? await db.getMessages(activeChanId) : [];

    const preloadedState = {
      portalMode,
      serverInfo: {
        appName: "RTwhat's up",
        companyName: 'RegiusTax',
        port: PORT,
        localIp,
        networkUrl,
        qrCode: qrCodeDataUrl
      },
      users,
      departments,
      defaultUser,
      channels,
      initialMessages
    };

    const scriptTag = `<script>window.__PRELOADED_STATE__ = ${JSON.stringify(preloadedState)};</script>`;
    html = html.replace('</head>', `${scriptTag}</head>`);
    res.send(html);
  } catch (err) {
    console.error(`Error preloading index.html for ${portalMode}:`, err);
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
}

// 1. Root route & /portal & /gateway: Serve the Workplace Portals Gateway
app.get(['/', '/portal', '/gateway'], (req, res) => {
  try {
    let html = getGatewayTemplate();
    if (!html) {
      return serveAppWithState(req, res, 'admin');
    }
    const gatewayState = {
      networkUrl,
      localIp,
      port: PORT,
      qrCode: qrCodeDataUrl
    };
    const scriptTag = `<script>window.__GATEWAY_STATE__ = ${JSON.stringify(gatewayState)};</script>`;
    html = html.replace('</head>', `${scriptTag}</head>`);
    res.send(html);
  } catch (err) {
    console.error('Error serving gateway.html:', err);
    res.sendFile(path.join(__dirname, 'public', 'gateway.html'));
  }
});

// 2. Admin Portal Route
app.get('/admin', (req, res) => {
  return serveAppWithState(req, res, 'admin');
});

// 3. Employee Portal Route
app.get('/employee', (req, res) => {
  return serveAppWithState(req, res, 'employee');
});

// Server info & LAN pairing details
app.get('/api/info', (req, res) => {
  res.json({
    appName: "RTwhat's up",
    companyName: 'RegiusTax',
    port: PORT,
    localIp,
    networkUrl,
    qrCode: qrCodeDataUrl,
    hostname: os.hostname(),
    platform: os.platform()
  });
});

// Get all staff users with live online status
app.get('/api/users', async (req, res) => {
  try {
    const users = await db.getUsers();
    const enriched = users.map(u => ({
      ...u,
      isOnline: isUserOnline(u.id)
    }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all departments
app.get('/api/departments', async (req, res) => {
  try {
    const departments = await db.getDepartments();
    res.json(departments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin creates a new/other department
app.post('/api/departments', async (req, res) => {
  try {
    const { name, adminId } = req.body;
    if (!name) return res.status(400).json({ error: 'Department name is required' });
    if (!adminId) return res.status(400).json({ error: 'adminId is required' });

    const newDept = await db.addDepartment(name, adminId);
    io.emit('department:added', newDept);
    
    // Broadcast newly created channel for this department
    const channels = await db.getChannelsForUser(adminId);
    const newChan = channels.find(c => c.name.toLowerCase() === name.trim().toLowerCase());
    if (newChan) {
      io.emit('channel:created', newChan);
    }

    res.json(newDept);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin deletes a department
app.delete('/api/departments/:id', async (req, res) => {
  try {
    const adminId = req.query.adminId || req.body.adminId;
    if (!adminId) return res.status(400).json({ error: 'adminId is required' });

    const result = await db.deleteDepartment(req.params.id, adminId);

    // Broadcast real-time events to all connected clients
    io.emit('department:deleted', result);
    if (result.deletedChannelId) {
      io.emit('channel:deleted', { channelId: result.deletedChannelId });
    }

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// User login verification endpoint (Email + Password)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, portalMode } = req.body;
    const user = await db.verifyLogin(email, password, portalMode);
    res.json({ success: true, user });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// Admin adds an employee by email with department assignment & password
app.post('/api/employees/add', async (req, res) => {
  try {
    const { email, full_name, department, password, adminId } = req.body;
    if (!email) return res.status(400).json({ error: 'Employee email is required' });
    if (!adminId) return res.status(400).json({ error: 'adminId is required' });

    const newEmployee = await db.addEmployee({ email, full_name, department, password, adminId });
    io.emit('employee:added', newEmployee);
    res.json(newEmployee);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin resets / updates an employee's password
app.post('/api/employees/:id/password', async (req, res) => {
  try {
    const { password, adminId } = req.body;
    if (!password) return res.status(400).json({ error: 'New password is required' });
    if (!adminId) return res.status(400).json({ error: 'adminId is required' });

    const result = await db.resetEmployeePassword(req.params.id, password, adminId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Any logged-in user (Admin or Employee) changes their own password
app.post('/api/users/change-password', async (req, res) => {
  try {
    const { userId, currentPassword, newPassword } = req.body;
    if (!userId) return res.status(400).json({ error: 'User ID is required' });
    if (!newPassword) return res.status(400).json({ error: 'New password is required' });

    const result = await db.changeOwnPassword(userId, currentPassword, newPassword);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin changes their own password (backward compatibility)
app.post('/api/admin/change-password', async (req, res) => {
  try {
    const { adminId, oldPassword, newPassword } = req.body;
    if (!adminId || !newPassword) return res.status(400).json({ error: 'adminId and newPassword are required' });

    const result = await db.changeAdminPassword(adminId, oldPassword, newPassword);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin updates employee department
app.post('/api/employees/:id/department', async (req, res) => {
  try {
    const { department, adminId } = req.body;
    if (!department || !adminId) return res.status(400).json({ error: 'department and adminId are required' });

    const updated = await db.updateEmployeeDepartment(req.params.id, department, adminId);
    io.emit('employee:department_updated', updated);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================================
// WORK ASSISTANCE TRACKER ENDPOINTS
// Employee -> WhatsApp Group -> HR/Coordinator -> Assign -> Track -> Complete -> Confirm -> Close
// ============================================================================

// Get work requests with optional filters
app.get('/api/tracker/requests', async (req, res) => {
  try {
    const { status, assigned_team, priority, requester_id, assigned_to_user_id, search } = req.query;
    const requests = await db.getAllWorkRequests({
      status,
      assigned_team,
      priority,
      requester_id,
      assigned_to_user_id,
      search
    });
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get tracker stats metrics
app.get('/api/tracker/stats', async (req, res) => {
  try {
    const stats = await db.getWorkTrackerStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single work request by ID
app.get('/api/tracker/requests/:id', async (req, res) => {
  try {
    const request = await db.getWorkRequestById(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    res.json(request);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new work request (Coordinator / Admin / Employee)
// Automatically posts ticket announcement message to Source Channel so channel employees get the message instantly
app.post('/api/tracker/requests', async (req, res) => {
  try {
    const newRequest = await db.createWorkRequest(req.body);
    io.emit('tracker:request_created', newRequest);

    // Auto-post request notification message to Source Channel
    let autoPostedMessage = null;
    try {
      const sourceChannel = await db.findChannelBySource(req.body.source_channel_id || req.body.source, req.body.assigned_team);
      if (sourceChannel) {
        const priorityEmoji = newRequest.priority === 'Urgent' ? '🔴' : (newRequest.priority === 'High' ? '🟠' : '🟢');
        const messageText = [
          `📋 *New Work Assistance Request [${newRequest.id}]*`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `📌 *Issue:* ${newRequest.title}`,
          `👤 *Requester:* ${newRequest.requester_name} (${newRequest.source})`,
          `🏢 *Assigned Team:* ${newRequest.assigned_team}${newRequest.assigned_to_name ? ' (' + newRequest.assigned_to_name + ')' : ''}`,
          `⚡ *Priority:* ${priorityEmoji} ${newRequest.priority}`,
          newRequest.description ? `📝 *Details:* ${newRequest.description}` : '',
          `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `💡 *Status:* New • Tracked via Work Assistance Tracker`
        ].filter(Boolean).join('\n');

        const senderId = req.body.requester_id || 'admin';
        autoPostedMessage = await db.saveMessage({
          channelId: sourceChannel.id,
          senderId: senderId,
          text: messageText,
          type: 'text'
        });

        // Broadcast to channel members viewing the conversation
        io.to(`channel:${sourceChannel.id}`).emit('message:received', autoPostedMessage);

        // Also broadcast channel notice to all connected employees for real-time unread badges & alerts
        io.emit('channel:message_notice', {
          channelId: sourceChannel.id,
          message: autoPostedMessage
        });

        console.log(`[Tracker] Auto-posted ticket [${newRequest.id}] to Source Channel: "${sourceChannel.name}" (${sourceChannel.id})`);
      }
    } catch (msgErr) {
      console.error('[Tracker] Error auto-posting request message to channel:', msgErr);
    }

    res.status(201).json({
      ...newRequest,
      auto_posted_message: autoPostedMessage
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update work request (status, team assignment, priority, notes)
app.put('/api/tracker/requests/:id', async (req, res) => {
  try {
    const updated = await db.updateWorkRequest(req.params.id, req.body);
    io.emit('tracker:request_updated', updated);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Employee confirms resolution
app.post('/api/tracker/requests/:id/confirm', async (req, res) => {
  try {
    const { userId, userName } = req.body;
    const updated = await db.confirmWorkRequestResolution(req.params.id, userId, userName);
    io.emit('tracker:request_updated', updated);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Close work request (with date/time + person who resolved it)
app.post('/api/tracker/requests/:id/close', async (req, res) => {
  try {
    const { closedByUserId, closedByName, resolutionNotes } = req.body;
    const closed = await db.closeWorkRequest(req.params.id, closedByUserId, closedByName, resolutionNotes);
    io.emit('tracker:request_closed', closed);
    res.json(closed);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin clears all work requests (Clean slate for Go-Live)
app.post('/api/tracker/clear-all-requests', async (req, res) => {
  try {
    const { adminId } = req.body;
    if (!adminId) return res.status(400).json({ error: 'adminId is required' });
    const result = await db.clearAllWorkRequests(adminId);
    io.emit('tracker:cleared', { all: true });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Outside Client Portal Route
app.get('/client', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'client.html');
  if (fs.existsSync(filePath)) {
    res.send(fs.readFileSync(filePath, 'utf8'));
  } else {
    res.status(404).send('Client portal not found');
  }
});

// Register or restore outside client session
app.post('/api/client/session', async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and Mobile Phone Number are required.' });
    }

    const session = await db.registerClientUserAndChannel({ name, phone, email });
    
    // Broadcast channel creation to Admin and Calling Team
    io.emit('channel:created', session.channel);

    res.json({
      user: session.user,
      channel: session.channel,
      messages: session.messages,
      serverInfo: {
        appName: "RTwhat's up Client Desk",
        companyName: 'RegiusTax',
        localIp,
        networkUrl
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin retrieves both outside links (Client link & Remote Employee link)
app.get('/api/admin/outside-links', async (req, res) => {
  try {
    const adminId = req.query.adminId;
    const admin = await db.getUserById(adminId);
    if (!admin || admin.role !== 'Admin') {
      return res.status(403).json({ error: 'Only an Admin can access outside links.' });
    }

    const savedBaseUrl = await db.getSetting('public_base_url', networkUrl);
    const baseUrl = (savedBaseUrl || networkUrl).replace(/\/+$/, '');

    const clientLink = `${baseUrl}/client`;
    const employeeLink = `${baseUrl}/employee`;
    const adminLink = `${baseUrl}/admin`;

    const clientQr = await QRCode.toDataURL(clientLink, { margin: 2, width: 220 });
    const employeeQr = await QRCode.toDataURL(employeeLink, { margin: 2, width: 220 });
    const adminQr = await QRCode.toDataURL(adminLink, { margin: 2, width: 220 });

    res.json({
      baseUrl,
      defaultLanUrl: networkUrl,
      localIp,
      port: PORT,
      adminLink,
      adminQr,
      clientLink,
      clientQr,
      employeeLink,
      employeeQr
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin updates base public URL (e.g. Cloudflare tunnel, ngrok domain, or static IP)
app.post('/api/admin/outside-links', async (req, res) => {
  try {
    const { baseUrl, adminId } = req.body;
    const admin = await db.getUserById(adminId);
    if (!admin || admin.role !== 'Admin') {
      return res.status(403).json({ error: 'Only an Admin can configure outside links.' });
    }

    const cleanUrl = (baseUrl && baseUrl.trim()) ? baseUrl.trim().replace(/\/+$/, '') : networkUrl;
    await db.setSetting('public_base_url', cleanUrl);

    const clientLink = `${cleanUrl}/client`;
    const employeeLink = `${cleanUrl}`;

    const clientQr = await QRCode.toDataURL(clientLink, { margin: 2, width: 220 });
    const employeeQr = await QRCode.toDataURL(employeeLink, { margin: 2, width: 220 });

    res.json({
      success: true,
      baseUrl: cleanUrl,
      clientLink,
      clientQr,
      employeeLink,
      employeeQr
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================================================
// BACKUP & RESTORE API (Strictly Restricted to Admin Portal & Administrator)
// ==========================================================================
async function requireAdminForBackup(req, res, next) {
  try {
    const adminId = req.query.adminId || (req.body && req.body.adminId) || req.headers['x-admin-id'];
    if (!adminId) {
      return res.status(403).json({ error: 'Access Denied: Only an Administrator can access or manage data backups.' });
    }
    const admin = await db.getUserById(adminId);
    if (!admin || admin.role !== 'Admin') {
      return res.status(403).json({ error: 'Access Denied: Only an Administrator can perform data backups.' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.get('/api/backup/status', requireAdminForBackup, (req, res) => {
  try {
    const status = backupService.getBackupStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backup/create', requireAdminForBackup, async (req, res) => {
  try {
    const manifest = await backupService.takeBackup(req.body.type || 'manual', req.body.note || 'Admin backup');
    io.emit('backup:completed', manifest);
    res.json(manifest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/backup/download/latest', requireAdminForBackup, (req, res) => {
  try {
    const status = backupService.getBackupStatus();
    if (!status.lastBackup || !status.lastBackup.filePath || !fs.existsSync(status.lastBackup.filePath)) {
      return res.status(404).json({ error: 'No backup file available yet.' });
    }
    res.download(status.lastBackup.filePath, status.lastBackup.filename);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/backup/download/:filename', requireAdminForBackup, (req, res) => {
  try {
    const file = req.params.filename;
    if (file.includes('..') || file.includes('/') || file.includes('\\')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path.join(backupService.BACKUP_DIR, file);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `Backup "${file}" not found.` });
    }
    res.download(filePath, file);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backup/restore', requireAdminForBackup, async (req, res) => {
  try {
    const { backupFileName } = req.body;
    const result = await backupService.restoreFromBackup(backupFileName || 'latest');
    io.emit('backup:restored', result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login by email
app.post('/api/users/login-by-email', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const user = await db.getUserByEmail(email);
    if (!user) {
      return res.status(404).json({ error: `Email "${email}" is not registered. Please ask the Admin to add your email.` });
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update user status message
app.post('/api/users/status', async (req, res) => {
  try {
    const { userId, status } = req.body;
    if (!userId || !status) return res.status(400).json({ error: 'User ID and status are required' });
    const updated = await db.updateUserStatus(userId, status);
    io.emit('user:status_updated', { userId, status });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all channels & chats for a user
app.get('/api/channels', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const channels = await db.getChannelsForUser(userId);
    const enriched = channels.map(c => {
      if (c.is_direct && c.direct_user) {
        c.direct_user.isOnline = isUserOnline(c.direct_user.id);
      }
      return c;
    });
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start or retrieve a direct message channel between 2 users
app.post('/api/channels/direct', async (req, res) => {
  try {
    const { user1Id, user2Id } = req.body;
    if (!user1Id || !user2Id) return res.status(400).json({ error: 'Both user IDs are required' });
    const channelId = await db.getOrCreateDirectChannel(user1Id, user2Id);
    const channel = await db.getChannelDetails(channelId, user1Id);
    res.json(channel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new department group channel (Admin only)
app.post('/api/channels/group', async (req, res) => {
  try {
    const { name, description, creatorId, memberIds } = req.body;
    if (!name || !creatorId) return res.status(400).json({ error: 'Name and creatorId are required' });
    const user = await db.getUserById(creatorId);
    if (!user || user.role !== 'Admin') {
      return res.status(403).json({ error: 'Only an Admin can create channels or groups.' });
    }
    const channelId = await db.createGroupChannel(name, description, creatorId, memberIds || []);
    const channel = await db.getChannelDetails(channelId, creatorId);
    io.emit('channel:created', channel);
    res.json(channel);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin adds an employee to a channel / group
app.post('/api/channels/:id/members', async (req, res) => {
  try {
    const { userId, adminId } = req.body;
    if (!userId || !adminId) return res.status(400).json({ error: 'userId and adminId are required' });
    const updated = await db.addMemberToChannel(req.params.id, userId, adminId);
    io.emit('channel:members_updated', { channelId: req.params.id, userId, action: 'added' });
    io.emit('channel:created', updated);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin removes an employee from a channel / group
app.delete('/api/channels/:id/members/:userId', async (req, res) => {
  try {
    const adminId = req.query.adminId || (req.body && req.body.adminId);
    if (!adminId) return res.status(400).json({ error: 'adminId is required' });
    const updated = await db.removeMemberFromChannel(req.params.id, req.params.userId, adminId);
    io.emit('channel:members_updated', { channelId: req.params.id, userId: req.params.userId, action: 'removed' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin deletes a channel
app.delete('/api/channels/:id', async (req, res) => {
  try {
    const adminId = req.query.adminId || (req.body && req.body.adminId);
    if (!adminId) return res.status(400).json({ error: 'adminId is required' });
    const result = await db.deleteChannel(req.params.id, adminId);
    io.emit('channel:deleted', { channelId: req.params.id });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin deletes an employee
app.delete('/api/employees/:id', async (req, res) => {
  try {
    const adminId = req.query.adminId || (req.body && req.body.adminId);
    if (!adminId) return res.status(400).json({ error: 'adminId is required' });
    const result = await db.deleteEmployee(req.params.id, adminId);
    io.emit('employee:deleted', { employeeId: req.params.id });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin clears all chat messages (Clean slate for Go-Live)
app.post('/api/admin/clear-all-messages', async (req, res) => {
  try {
    const { adminId } = req.body;
    if (!adminId) return res.status(400).json({ error: 'adminId is required' });
    const result = await db.clearAllMessages(adminId);
    io.emit('channel:cleared', { all: true });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get specific channel details
app.get('/api/channels/:id', async (req, res) => {
  try {
    const channel = await db.getChannelDetails(req.params.id, req.query.userId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    res.json(channel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get messages for a channel
app.get('/api/channels/:id/messages', async (req, res) => {
  try {
    const messages = await db.getMessages(req.params.id, parseInt(req.query.limit) || 100);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check and send polite automated out-of-office message if recipient or replied-to user is Unavailable
async function checkAndSendUnavailableAutoReply(channelId, senderId, savedMessage) {
  try {
    if (!savedMessage || (savedMessage.text && savedMessage.text.startsWith('[Auto-Reply]'))) {
      return; // Never auto-reply to an auto-reply
    }

    const channel = await db.getChannelDetails(channelId, senderId);
    if (!channel) return;

    let targetUser = null;
    let isDirectNotice = false;

    // Case 1: Direct Message Channel where the recipient is marked Unavailable
    if (channel.is_direct && Array.isArray(channel.members)) {
      const otherMember = channel.members.find(m => m.id !== senderId);
      if (otherMember && (otherMember.status || '').toLowerCase().includes('unavailable')) {
        targetUser = otherMember;
        isDirectNotice = true;
      }
    }

    // Case 2: In any channel where sender explicitly replied to a message from an unavailable colleague
    if (!targetUser && savedMessage.reply_to_id) {
      const origMsg = await db.get('SELECT sender_id FROM messages WHERE id = ?', [savedMessage.reply_to_id]);
      if (origMsg && origMsg.sender_id !== senderId) {
        const origUser = await db.getUserById(origMsg.sender_id);
        if (origUser && (origUser.status || '').toLowerCase().includes('unavailable')) {
          targetUser = origUser;
          isDirectNotice = false;
        }
      }
    }

    if (!targetUser) return;

    // Anti-spam protection: 5-minute cooldown per (channel, targetUser)
    const recentAuto = await db.getRecentAutoReply(channelId, targetUser.id, 5);
    if (recentAuto) {
      return;
    }

    const replyNotice = isDirectNotice
      ? `[Auto-Reply] Hello! I am currently marked Unavailable (Away from desk). I have received your message and will respond as soon as I return.`
      : `[Auto-Reply] ${targetUser.full_name} is currently marked Unavailable (Away from desk). They will review your reply upon returning.`;

    const autoMessage = await db.saveMessage({
      channelId,
      senderId: targetUser.id,
      text: replyNotice,
      type: 'text',
      replyToId: savedMessage.id
    });

    // Broadcast automated out-of-office notice
    io.to(`channel:${channelId}`).emit('message:received', autoMessage);
    io.emit('channel:message_notice', {
      channelId,
      message: autoMessage
    });
  } catch (err) {
    console.error('[Auto-Reply] Error handling unavailable auto reply:', err);
  }
}

// Send message via HTTP REST (instant fallback if WebSocket is reconnecting or down)
app.post('/api/messages', async (req, res) => {
  try {
    const { channelId, senderId, text, type, fileUrl, fileName, fileSize, replyToId } = req.body;
    if (!channelId || !senderId) {
      return res.status(400).json({ error: 'channelId and senderId are required' });
    }

    const savedMessage = await db.saveMessage({
      channelId,
      senderId,
      text,
      type: type || 'text',
      fileUrl,
      fileName,
      fileSize,
      replyToId
    });

    // Broadcast to WebSocket clients
    io.to(`channel:${channelId}`).emit('message:received', savedMessage);
    io.emit('channel:message_notice', {
      channelId,
      message: savedMessage
    });

    // Trigger out-of-office automated reply if recipient is unavailable
    checkAndSendUnavailableAutoReply(channelId, senderId, savedMessage).catch(e => {
      console.error('[Auto-Reply] Background check failed:', e);
    });

    res.json(savedMessage);
  } catch (err) {
    console.error('[API] Error saving message via HTTP:', err);
    res.status(500).json({ error: 'Failed to send message: ' + err.message });
  }
});

// Mark messages in a channel as read
app.post('/api/channels/:id/read', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    await db.markMessagesAsRead(req.params.id, userId);
    io.to(`channel:${req.params.id}`).emit('messages:read', { channelId: req.params.id, userId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload endpoint for documents, media, images, and voice recordings (with safe error handler)
app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('[Upload] Multer error:', err);
      return res.status(400).json({ error: 'Upload error: ' + err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileUrl = `/uploads/${req.file.filename}`;
    const isImage = req.file.mimetype.startsWith('image/');
    const isAudio = req.file.mimetype.startsWith('audio/') || req.file.originalname.endsWith('.webm');
    
    let type = 'file';
    if (isImage) type = 'image';
    else if (isAudio) type = 'audio';

    res.json({
      url: fileUrl,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      type
    });
  });
});

// Global message & file search
app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.json([]);
    const results = await db.searchMessages(query);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket.IO Real-time event handling
io.on('connection', (socket) => {
  let currentUserId = null;

  // Client connects and identifies with staff userId
  socket.on('user:join', ({ userId }) => {
    currentUserId = userId;
    socket.userId = userId;

    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId).add(socket.id);

    // Join personal notification room
    socket.join(`user:${userId}`);

    // Broadcast online presence to everyone
    io.emit('user:presence', { userId, isOnline: true });
    console.log(`[Socket] User joined: ${userId} (${onlineUsers.get(userId).size} active sessions)`);
  });

  // Client opens a channel / chat view
  socket.on('channel:join', ({ channelId }) => {
    socket.join(`channel:${channelId}`);
  });

  socket.on('channel:leave', ({ channelId }) => {
    socket.leave(`channel:${channelId}`);
  });

  // Sending a real-time message
  socket.on('message:send', async (data) => {
    try {
      const { channelId, senderId, text, type, fileUrl, fileName, fileSize, replyToId } = data;
      const savedMessage = await db.saveMessage({
        channelId,
        senderId,
        text,
        type: type || 'text',
        fileUrl,
        fileName,
        fileSize,
        replyToId
      });

      // Broadcast message to channel members viewing the conversation
      io.to(`channel:${channelId}`).emit('message:received', savedMessage);

      // Also notify channel members who might be in another tab
      io.emit('channel:message_notice', {
        channelId,
        message: savedMessage
      });

      // Trigger out-of-office automated reply if recipient is unavailable
      checkAndSendUnavailableAutoReply(channelId, senderId, savedMessage).catch(e => {
        console.error('[Auto-Reply] Background check failed:', e);
      });
    } catch (err) {
      console.error('[Socket] Error saving message:', err);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // Typing indicators
  socket.on('typing:start', ({ channelId, userId, userName }) => {
    socket.to(`channel:${channelId}`).emit('typing:status', {
      channelId,
      userId,
      userName,
      isTyping: true
    });
  });

  socket.on('typing:stop', ({ channelId, userId }) => {
    socket.to(`channel:${channelId}`).emit('typing:status', {
      channelId,
      userId,
      isTyping: false
    });
  });

  // Client disconnect
  socket.on('disconnect', () => {
    if (currentUserId && onlineUsers.has(currentUserId)) {
      const userSockets = onlineUsers.get(currentUserId);
      userSockets.delete(socket.id);
      if (userSockets.size === 0) {
        onlineUsers.delete(currentUserId);
        io.emit('user:presence', { userId: currentUserId, isOnline: false });
        console.log(`[Socket] User offline: ${currentUserId}`);
      }
    }
  });
});

// Start listening on 0.0.0.0 (all network interfaces)
server.listen(PORT, '0.0.0.0', async () => {
  await db.initDb();
  
  // Initialize Automated 12:00 PM Daily Backup Service
  backupService.initDailyScheduler((manifest) => {
    io.emit('backup:completed', manifest);
  });

  // 24/7 Keep-Alive Uptime Heartbeat: prevents cloud container idle spin-down delay
  const KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL || 'https://regiustax-workplace-app.onrender.com';
  console.log(`[Keep-Alive] 24/7 self-ping initialized for: ${KEEP_ALIVE_URL}`);
  setInterval(() => {
    try {
      fetch(`${KEEP_ALIVE_URL}/api/health`)
        .then(r => r.json())
        .then(data => {
          // Heartbeat active
        })
        .catch(() => {});
    } catch (e) {}
  }, 8 * 60 * 1000); // Ping every 8 minutes

  console.log('====================================================');
  console.log('       RTwhat\'s up - RegiusTax Local Messenger      ');
  console.log('====================================================');
  console.log(`  Local host:    http://localhost:${PORT}`);
  console.log(`  Office LAN:    ${networkUrl}`);
  console.log('----------------------------------------------------');
  console.log('  Share the Office LAN URL or QR Code with anyone on');
  console.log('  the office Wi-Fi network to connect immediately!');
  console.log('====================================================');
});

// Automatic pre-shutdown safety backup when stopping server or shutting down laptop
process.on('SIGINT', async () => {
  console.log('\n[Server] Shutdown signal received. Taking safety backup snapshot...');
  try {
    await backupService.takeBackup('pre_shutdown', 'Automatic safety backup on server shutdown');
  } catch (err) {
    console.error('[Server] Pre-shutdown backup error:', err);
  }
  process.exit(0);
});
