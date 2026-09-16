const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'rtwhatsup.db');

// If DB does not exist on persistent cloud disk, copy seed database
if (!fs.existsSync(DB_PATH)) {
  const seedCandidates = [
    path.join(__dirname, 'seed_rtwhatsup.db'),
    path.join(__dirname, 'rtwhatsup.db')
  ];
  for (const seed of seedCandidates) {
    if (fs.existsSync(seed) && path.resolve(seed) !== path.resolve(DB_PATH)) {
      try {
        fs.copyFileSync(seed, DB_PATH);
        console.log(`[Database] Seeded initial database to persistent volume at ${DB_PATH}`);
        break;
      } catch (err) {
        console.error('[Database] Failed to seed database:', err.message);
      }
    }
  }
}

const db = new sqlite3.Database(DB_PATH);

// Configure SQLite for high concurrency, zero deadlocks, and WAL mode
db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA busy_timeout = 5000;');
  db.run('PRAGMA synchronous = NORMAL;');
});

// Helper for running queries with promises
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

async function initDb() {
  // Users table: Two levels only (Admin, Employee), identified by email with assigned department
  await run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('Admin', 'Employee')),
    department TEXT DEFAULT 'Calling Team',
    avatar TEXT DEFAULT '👤',
    status TEXT DEFAULT 'Available',
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Migration: add department column if it doesn't exist yet
  try {
    await run(`ALTER TABLE users ADD COLUMN department TEXT DEFAULT 'Calling Team'`);
  } catch (e) {
    // Column already exists
  }

  // Migration: add password column if it doesn't exist yet
  try {
    await run(`ALTER TABLE users ADD COLUMN password TEXT`);
  } catch (e) {
    // Column already exists
  }

  // Set default password for admin (admin123) if unset
  await run(`UPDATE users SET password = 'admin123' WHERE role = 'Admin' AND (password IS NULL OR password = '')`);

  // Set default password for employees (emp123) if unset
  await run(`UPDATE users SET password = 'emp123' WHERE role = 'Employee' AND (password IS NULL OR password = '')`);

  // Channels table (Groups and 1-on-1 Direct Messages)
  await run(`CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    is_direct INTEGER DEFAULT 0,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Channel Members
  await run(`CREATE TABLE IF NOT EXISTS channel_members (
    channel_id TEXT,
    user_id TEXT,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel_id, user_id)
  )`);

  // Messages table
  await run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    text TEXT,
    type TEXT DEFAULT 'text',
    file_url TEXT,
    file_name TEXT,
    file_size INTEGER,
    reply_to_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Message read receipts
  await run(`CREATE TABLE IF NOT EXISTS message_receipts (
    message_id TEXT,
    user_id TEXT,
    status TEXT DEFAULT 'delivered',
    read_at DATETIME,
    PRIMARY KEY (message_id, user_id)
  )`);

  // Departments table (Admin can add any department)
  await run(`CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Settings table (stores public URL, customizations, etc.)
  await run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  // Work Assistance Tracker (Employee -> WhatsApp Group -> HR/Coordinator -> Assign -> Track -> Complete -> Confirm -> Close)
  await run(`CREATE TABLE IF NOT EXISTS work_requests (
    id TEXT PRIMARY KEY,
    request_number INTEGER UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    requester_name TEXT NOT NULL,
    requester_id TEXT,
    source TEXT DEFAULT 'WhatsApp Group',
    assigned_team TEXT NOT NULL DEFAULT 'IT',
    assigned_to_user_id TEXT,
    assigned_to_name TEXT,
    priority TEXT NOT NULL DEFAULT 'Normal' CHECK(priority IN ('Urgent', 'High', 'Normal')),
    status TEXT NOT NULL DEFAULT 'New' CHECK(status IN ('New', 'Assigned', 'In Progress', 'Waiting', 'Completed', 'Closed')),
    employee_confirmed INTEGER DEFAULT 0,
    employee_confirmed_at DATETIME,
    closed_at DATETIME,
    closed_by_user_id TEXT,
    closed_by_name TEXT,
    resolution_notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Performance & Concurrency Indexes (Avoids full-table scans)
  await run(`CREATE INDEX IF NOT EXISTS idx_messages_channel_date ON messages(channel_id, created_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_channel_members_chan ON channel_members(channel_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_receipts_lookup ON message_receipts(user_id, status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_work_requests_status ON work_requests(status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_work_requests_team ON work_requests(assigned_team)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_work_requests_priority ON work_requests(priority)`);

  const deptCount = await get('SELECT COUNT(*) as count FROM departments');
  if (deptCount.count === 0) {
    const seedDepts = ['Calling Team', 'Preparation Team', 'Review Team'];
    for (const dName of seedDepts) {
      const dId = 'dept-' + dName.toLowerCase().replace(/[^a-z0-9]/g, '-');
      await run('INSERT OR IGNORE INTO departments (id, name, created_by) VALUES (?, ?, ?)', [dId, dName, 'admin']);
    }
  }

  // Ensure default department channels exist
  const defaultDepartmentChannels = [
    {
      id: 'chan-general',
      name: 'General Announcements',
      description: 'Official RegiusTax company announcements and updates',
      is_direct: 0,
      created_by: 'admin'
    },
    {
      id: 'chan-calling',
      name: 'Calling Team',
      description: 'Client outreach, calling queries, document collection & follow-ups',
      is_direct: 0,
      created_by: 'admin'
    },
    {
      id: 'chan-prep',
      name: 'Preparation Team',
      description: 'Tax return preparation, computational sheets & schedules',
      is_direct: 0,
      created_by: 'admin'
    },
    {
      id: 'chan-review',
      name: 'Review Team',
      description: 'Quality audit, review check, partner verification & filing sign-offs',
      is_direct: 0,
      created_by: 'admin'
    }
  ];

  for (const c of defaultDepartmentChannels) {
    await run(
      `INSERT OR IGNORE INTO channels (id, name, description, is_direct, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [c.id, c.name, c.description, c.is_direct, c.created_by]
    );
    await run(
      `INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, 'admin')`,
      [c.id]
    );
  }

  await seedData();
}

async function seedData() {
  const userCount = await get('SELECT COUNT(*) as count FROM users');
  if (userCount.count === 0) {
    console.log('Seeding initial RegiusTax Admin and channels...');

    // Default Admin Account
    const defaultAdmin = {
      id: 'admin',
      email: 'admin@regiustax.com',
      full_name: 'Admin',
      role: 'Admin',
      avatar: '🛡️',
      status: 'System Administrator'
    };

    await run(
      `INSERT INTO users (id, email, full_name, role, avatar, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [defaultAdmin.id, defaultAdmin.email, defaultAdmin.full_name, defaultAdmin.role, defaultAdmin.avatar, defaultAdmin.status]
    );

    // Default group channels
    const defaultChannels = [
      {
        id: 'chan-general',
        name: 'General Announcements',
        description: 'Official RegiusTax company announcements and updates',
        is_direct: 0,
        created_by: 'admin'
      },
      {
        id: 'chan-team',
        name: 'Team Discussion',
        description: 'Internal team collaboration and work queries',
        is_direct: 0,
        created_by: 'admin'
      }
    ];

    for (const c of defaultChannels) {
      await run(
        `INSERT INTO channels (id, name, description, is_direct, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [c.id, c.name, c.description, c.is_direct, c.created_by]
      );

      // Add admin to default channels
      await run(
        `INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)`,
        [c.id, defaultAdmin.id]
      );
    }

    // Seed welcoming message from Admin
    await run(
      `INSERT INTO messages (id, channel_id, sender_id, text, type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        'msg-init-1',
        'chan-general',
        'admin',
        'Welcome to **RTwhat\'s up** for RegiusTax! 🛡️ This system has two levels: **Admin** and **Employee**. Admin can add employees by email to grant them access to this network.',
        'text',
        new Date().toISOString()
      ]
    );

    console.log('RegiusTax clean Admin setup completed successfully!');
  }
}

// Database helper functions
async function getUsers() {
  return await all("SELECT id, email, full_name, role, department, avatar, status, created_at FROM users WHERE department != 'Outside Client' ORDER BY role ASC, full_name ASC");
}

async function getUserById(id) {
  return await get('SELECT * FROM users WHERE id = ?', [id]);
}

async function getUserByEmail(email) {
  return await get('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [email.trim()]);
}

// Departments helper functions (Admin can add any other department)
async function getDepartments() {
  return await all('SELECT * FROM departments ORDER BY created_at ASC');
}

async function addDepartment(name, adminId) {
  const admin = await getUserById(adminId);
  if (!admin || admin.role !== 'Admin') {
    throw new Error('Only an Admin can add new departments.');
  }

  const cleanName = name.trim();
  if (!cleanName) {
    throw new Error('Department name cannot be empty.');
  }

  const existing = await get('SELECT * FROM departments WHERE LOWER(name) = LOWER(?)', [cleanName]);
  if (existing) {
    return existing;
  }

  const id = 'dept-' + Date.now();
  await run('INSERT INTO departments (id, name, created_by) VALUES (?, ?, ?)', [id, cleanName, adminId]);

  // Automatically create a corresponding room/channel for this department if none exists
  const existingChan = await get('SELECT id FROM channels WHERE LOWER(name) = LOWER(?) AND is_direct = 0', [cleanName]);
  if (!existingChan) {
    const chanId = 'chan-' + Date.now();
    await run(`
      INSERT INTO channels (id, name, description, is_direct, created_by)
      VALUES (?, ?, ?, 0, ?)
    `, [chanId, cleanName, `${cleanName} room`, adminId]);
    await run('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)', [chanId, adminId]);
  }

  return await get('SELECT * FROM departments WHERE id = ?', [id]);
}

// Admin deletes a department
async function deleteDepartment(departmentId, adminId) {
  const admin = await getUserById(adminId);
  if (!admin || admin.role !== 'Admin') {
    throw new Error('Only an Admin can delete departments.');
  }

  const dept = await get('SELECT * FROM departments WHERE id = ? OR LOWER(name) = LOWER(?)', [departmentId, departmentId]);
  if (!dept) {
    throw new Error('Department not found.');
  }

  // Find fallback department for affected employees
  const remaining = await all('SELECT name FROM departments WHERE id != ? AND LOWER(name) != LOWER(?) LIMIT 1', [dept.id, dept.name]);
  const fallbackDept = remaining.length > 0 ? remaining[0].name : 'General';

  // Reassign affected employees to fallback department
  await run('UPDATE users SET department = ? WHERE LOWER(department) = LOWER(?)', [fallbackDept, dept.name]);

  // Delete associated department group channel if it exists and is not chan-general
  const assocChannel = await get('SELECT id FROM channels WHERE LOWER(name) = LOWER(?) AND is_direct = 0', [dept.name]);
  let deletedChannelId = null;
  if (assocChannel && assocChannel.id !== 'chan-general') {
    deletedChannelId = assocChannel.id;
    await run('DELETE FROM message_receipts WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)', [assocChannel.id]);
    await run('DELETE FROM messages WHERE channel_id = ?', [assocChannel.id]);
    await run('DELETE FROM channel_members WHERE channel_id = ?', [assocChannel.id]);
    await run('DELETE FROM channels WHERE id = ?', [assocChannel.id]);
  }

  // Delete the department record
  await run('DELETE FROM departments WHERE id = ?', [dept.id]);

  return {
    success: true,
    deletedId: dept.id,
    deletedName: dept.name,
    fallbackDept,
    deletedChannelId
  };
}

// Settings management (e.g. public URL for outside access)
async function getSetting(key, defaultValue = null) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : defaultValue;
}

async function setSetting(key, value) {
  await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?', [key, value, value]);
  return value;
}

// Outside Client registration and dedicated inquiry channel
async function registerClientUserAndChannel({ name, phone, email = '' }) {
  const cleanPhone = (phone || '').trim().replace(/[^0-9+]/g, '');
  const cleanName = (name || '').trim();
  if (!cleanPhone || !cleanName) {
    throw new Error('Name and Phone number are required for outside client access.');
  }

  const userId = 'client-' + cleanPhone.replace(/\+/g, '');

  let userEmail = email && email.trim() ? email.trim() : `${cleanPhone}@client.regiustax.com`;
  const existingEmailOwner = await getUserByEmail(userEmail);
  if (existingEmailOwner && existingEmailOwner.id !== userId) {
    userEmail = `${cleanPhone}.${userEmail}`;
  }

  // Upsert user
  const existingUser = await getUserById(userId);
  if (!existingUser) {
    await run(`
      INSERT INTO users (id, email, full_name, role, department, avatar, status)
      VALUES (?, ?, ?, 'Employee', 'Outside Client', '📱', 'Outside Client')
    `, [userId, userEmail, cleanName]);
  } else {
    await run(`
      UPDATE users SET full_name = ?, email = ? WHERE id = ?
    `, [cleanName, userEmail, userId]);
  }

  const clientUser = await getUserById(userId);

  // Channel for this client inquiry
  const channelId = 'chan-client-' + cleanPhone.replace(/\+/g, '');
  const channelName = `📞 Client: ${cleanName} (${cleanPhone})`;
  const existingChannel = await get('SELECT * FROM channels WHERE id = ?', [channelId]);

  if (!existingChannel) {
    await run(`
      INSERT INTO channels (id, name, description, is_direct, created_by)
      VALUES (?, ?, ?, 0, 'system')
    `, [channelId, channelName, `Outside Client Inquiry: ${cleanName} (${cleanPhone})`]);

    // Add Client to channel
    await run('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)', [channelId, userId]);

    // Add Admin to channel
    await run('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)', [channelId, 'admin']);

    // Add Calling Team members to channel
    const callingTeamMembers = await all(`SELECT id FROM users WHERE role = 'Employee' AND LOWER(department) = 'calling team'`);
    for (const emp of callingTeamMembers) {
      await run('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)', [channelId, emp.id]);
    }
  } else {
    // Ensure Client, Admin, and Calling Team are members
    await run('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)', [channelId, userId]);
    await run('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)', [channelId, 'admin']);
    const callingTeamMembers = await all(`SELECT id FROM users WHERE role = 'Employee' AND LOWER(department) = 'calling team'`);
    for (const emp of callingTeamMembers) {
      await run('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)', [channelId, emp.id]);
    }
  }

  const channel = await getChannelDetails(channelId, userId);
  const messages = await getMessages(channelId);

  return {
    user: clientUser,
    channel,
    messages
  };
}

// Admin adds an employee by email with department assignment & initial password
async function addEmployee({ email, full_name, department = 'Calling Team', password, adminId }) {
  const cleanEmail = email.trim().toLowerCase();
  const cleanPassword = (password && password.trim()) ? password.trim() : 'emp123';
  
  // Verify that requester is Admin
  const admin = await getUserById(adminId);
  if (!admin || admin.role !== 'Admin') {
    throw new Error('Only an Admin can add employees.');
  }

  const cleanDept = (department && department.trim()) ? department.trim() : 'Calling Team';

  // Ensure department is registered in departments table
  const deptExists = await get('SELECT * FROM departments WHERE LOWER(name) = LOWER(?)', [cleanDept]);
  if (!deptExists) {
    const dId = 'dept-' + Date.now();
    await run('INSERT OR IGNORE INTO departments (id, name, created_by) VALUES (?, ?, ?)', [dId, cleanDept, adminId]);
  }

  // Check if email already exists
  const existing = await getUserByEmail(cleanEmail);
  if (existing) {
    throw new Error(`Email "${cleanEmail}" is already registered.`);
  }

  const id = 'emp-' + Date.now();
  const displayName = full_name && full_name.trim() ? full_name.trim() : cleanEmail.split('@')[0];

  await run(
    `INSERT INTO users (id, email, full_name, role, department, avatar, status, password)
     VALUES (?, ?, ?, 'Employee', ?, '👤', 'Available', ?)`,
    [id, cleanEmail, displayName, cleanDept, cleanPassword]
  );

  // Automatically add the new employee to:
  // 1. General announcements channel
  await run('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)', ['chan-general', id]);

  // 2. Department channel corresponding to their department
  let targetChannel = await get('SELECT id FROM channels WHERE LOWER(name) = LOWER(?) AND is_direct = 0', [cleanDept]);
  if (!targetChannel) {
    const defaultDeptMap = {
      'Calling Team': 'chan-calling',
      'Preparation Team': 'chan-prep',
      'Review Team': 'chan-review'
    };
    if (defaultDeptMap[cleanDept]) {
      targetChannel = { id: defaultDeptMap[cleanDept] };
    } else {
      // Create channel for this custom department
      const newChanId = 'chan-' + Date.now();
      await run(`
        INSERT INTO channels (id, name, description, is_direct, created_by)
        VALUES (?, ?, ?, 0, ?)
      `, [newChanId, cleanDept, `${cleanDept} room`, adminId]);
      await run('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)', [newChanId, adminId]);
      targetChannel = { id: newChanId };
    }
  }

  if (targetChannel && targetChannel.id) {
    await run('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)', [targetChannel.id, id]);
  }

  const created = await getUserById(id);
  const { password: _, ...safeEmployee } = created;
  return safeEmployee;
}

// Admin updates an employee's department
async function updateEmployeeDepartment(employeeId, newDepartment, adminId) {
  const admin = await getUserById(adminId);
  if (!admin || admin.role !== 'Admin') {
    throw new Error('Only an Admin can change employee departments.');
  }

  const cleanDept = newDepartment ? newDepartment.trim() : '';
  if (!cleanDept) {
    throw new Error('Department cannot be empty.');
  }

  const employee = await getUserById(employeeId);
  if (!employee || employee.role !== 'Employee') {
    throw new Error('Employee not found or cannot change Admin department.');
  }

  const oldDept = employee.department;

  // Ensure department is registered in departments table
  const deptExists = await get('SELECT * FROM departments WHERE LOWER(name) = LOWER(?)', [cleanDept]);
  if (!deptExists) {
    const dId = 'dept-' + Date.now();
    await run('INSERT OR IGNORE INTO departments (id, name, created_by) VALUES (?, ?, ?)', [dId, cleanDept, adminId]);
  }

  await run('UPDATE users SET department = ? WHERE id = ?', [cleanDept, employeeId]);

  // Remove from old department channel if changing
  if (oldDept && oldDept !== cleanDept) {
    const oldChannel = await get('SELECT id FROM channels WHERE LOWER(name) = LOWER(?) AND is_direct = 0', [oldDept]);
    if (oldChannel) {
      await run('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', [oldChannel.id, employeeId]);
    }
  }

  // Add to new department channel
  let newChannel = await get('SELECT id FROM channels WHERE LOWER(name) = LOWER(?) AND is_direct = 0', [cleanDept]);
  if (!newChannel) {
    const newChanId = 'chan-' + Date.now();
    await run(`
      INSERT INTO channels (id, name, description, is_direct, created_by)
      VALUES (?, ?, ?, 0, ?)
    `, [newChanId, cleanDept, `${cleanDept} room`, adminId]);
    await run('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)', [newChanId, adminId]);
    newChannel = { id: newChanId };
  }

  if (newChannel && newChannel.id) {
    await run('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)', [newChannel.id, employeeId]);
  }

  return await getUserById(employeeId);
}

// Admin deletes an employee
async function deleteEmployee(employeeId, adminId) {
  const admin = await getUserById(adminId);
  if (!admin || admin.role !== 'Admin') {
    throw new Error('Only an Admin can delete employees.');
  }

  const targetUser = await getUserById(employeeId);
  if (!targetUser) {
    throw new Error('Employee not found.');
  }

  if (targetUser.role === 'Admin') {
    throw new Error('Cannot delete an Admin account.');
  }

  // Clean up references
  await run('DELETE FROM message_receipts WHERE user_id = ?', [employeeId]);
  await run('DELETE FROM channel_members WHERE user_id = ?', [employeeId]);
  
  // Delete direct message channels involving this employee
  const directChannels = await all(`
    SELECT channel_id FROM channel_members WHERE user_id = ?
  `, [employeeId]);
  for (const dc of directChannels) {
    const isDirect = await get('SELECT is_direct FROM channels WHERE id = ?', [dc.channel_id]);
    if (isDirect && isDirect.is_direct) {
      await run('DELETE FROM messages WHERE channel_id = ?', [dc.channel_id]);
      await run('DELETE FROM channel_members WHERE channel_id = ?', [dc.channel_id]);
      await run('DELETE FROM channels WHERE id = ?', [dc.channel_id]);
    }
  }

  await run('DELETE FROM messages WHERE sender_id = ?', [employeeId]);
  await run('DELETE FROM users WHERE id = ?', [employeeId]);

  return { success: true, deletedId: employeeId };
}

async function updateUserStatus(userId, status) {
  await run('UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?', [status, userId]);
  return await getUserById(userId);
}

async function getChannelsForUser(userId) {
  const user = await getUserById(userId);
  if (!user) return [];

  let rows;
  if (user.role === 'Admin') {
    // Admin sees all group channels plus any direct messages Admin is part of
    rows = await all(`
      SELECT c.*, 
        (SELECT text FROM messages m WHERE m.channel_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message,
        (SELECT type FROM messages m WHERE m.channel_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message_type,
        (SELECT created_at FROM messages m WHERE m.channel_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message_time,
        (SELECT sender_id FROM messages m WHERE m.channel_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message_sender,
        (SELECT COUNT(*) FROM messages m 
         WHERE m.channel_id = c.id 
         AND m.sender_id != ? 
         AND m.id NOT IN (SELECT message_id FROM message_receipts WHERE user_id = ? AND status = 'read')
        ) as unread_count
      FROM channels c
      WHERE c.is_direct = 0
         OR c.id IN (SELECT channel_id FROM channel_members WHERE user_id = ?)
      ORDER BY COALESCE(last_message_time, c.created_at) DESC
    `, [userId, userId, userId]);
  } else {
    // Employee only sees group channels they are assigned to, plus their direct messages
    rows = await all(`
      SELECT c.*, 
        (SELECT text FROM messages m WHERE m.channel_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message,
        (SELECT type FROM messages m WHERE m.channel_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message_type,
        (SELECT created_at FROM messages m WHERE m.channel_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message_time,
        (SELECT sender_id FROM messages m WHERE m.channel_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message_sender,
        (SELECT COUNT(*) FROM messages m 
         WHERE m.channel_id = c.id 
         AND m.sender_id != ? 
         AND m.id NOT IN (SELECT message_id FROM message_receipts WHERE user_id = ? AND status = 'read')
        ) as unread_count
      FROM channels c
      JOIN channel_members cm ON c.id = cm.channel_id
      WHERE cm.user_id = ?
      ORDER BY COALESCE(last_message_time, c.created_at) DESC
    `, [userId, userId, userId]);
  }

  for (const row of rows) {
    if (row.is_direct) {
      const otherMember = await get(`
        SELECT u.id, u.email, u.full_name, u.role, u.avatar, u.status, u.last_seen
        FROM channel_members cm
        JOIN users u ON cm.user_id = u.id
        WHERE cm.channel_id = ? AND cm.user_id != ?
      `, [row.id, userId]);
      if (otherMember) {
        row.name = otherMember.full_name;
        row.direct_user = otherMember;
      }
    }
  }
  return rows;
}

async function getOrCreateDirectChannel(user1Id, user2Id) {
  const existing = await get(`
    SELECT c.id FROM channels c
    JOIN channel_members cm1 ON c.id = cm1.channel_id AND cm1.user_id = ?
    JOIN channel_members cm2 ON c.id = cm2.channel_id AND cm2.user_id = ?
    WHERE c.is_direct = 1
  `, [user1Id, user2Id]);

  if (existing) {
    return existing.id;
  }

  const channelId = `dm-${Date.now()}`;
  await run(
    `INSERT INTO channels (id, name, description, is_direct, created_by)
     VALUES (?, ?, ?, 1, ?)`,
    [channelId, 'Direct Message', 'Private conversation', user1Id]
  );
  await run(`INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?), (?, ?)`, [
    channelId, user1Id,
    channelId, user2Id
  ]);
  return channelId;
}

async function createGroupChannel(name, description, creatorId, memberIds = []) {
  const creator = await getUserById(creatorId);
  if (!creator || creator.role !== 'Admin') {
    throw new Error('Only an Admin can create channels or groups.');
  }

  const channelId = `grp-${Date.now()}`;
  await run(
    `INSERT INTO channels (id, name, description, is_direct, created_by)
     VALUES (?, ?, ?, 0, ?)`,
    [channelId, name, description || '', creatorId]
  );

  // Admin and explicitly divided/assigned employee members
  const allMembers = Array.from(new Set([creatorId, ...memberIds]));
  for (const uid of allMembers) {
    await run(`INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)`, [channelId, uid]);
  }
  return channelId;
}

async function addMemberToChannel(channelId, userId, adminId) {
  const admin = await getUserById(adminId);
  if (!admin || admin.role !== 'Admin') {
    throw new Error('Only an Admin can manage group members.');
  }
  const channel = await get('SELECT * FROM channels WHERE id = ?', [channelId]);
  if (!channel || channel.is_direct) {
    throw new Error('Channel not found or is a direct message.');
  }
  await run('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)', [channelId, userId]);
  return await getChannelDetails(channelId, adminId);
}

async function removeMemberFromChannel(channelId, userId, adminId) {
  const admin = await getUserById(adminId);
  if (!admin || admin.role !== 'Admin') {
    throw new Error('Only an Admin can manage group members.');
  }
  const channel = await get('SELECT * FROM channels WHERE id = ?', [channelId]);
  if (!channel || channel.is_direct) {
    throw new Error('Channel not found or is a direct message.');
  }
  const targetUser = await getUserById(userId);
  if (targetUser && targetUser.role === 'Admin') {
    throw new Error('Cannot remove Admin from channel.');
  }
  await run('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', [channelId, userId]);
  return await getChannelDetails(channelId, adminId);
}

async function getChannelDetails(channelId, currentUserId) {
  const channel = await get('SELECT * FROM channels WHERE id = ?', [channelId]);
  if (!channel) return null;

  const members = await all(`
    SELECT u.id, u.email, u.full_name, u.role, u.department, u.avatar, u.status, u.last_seen
    FROM channel_members cm
    JOIN users u ON cm.user_id = u.id
    WHERE cm.channel_id = ?
  `, [channelId]);

  channel.members = members;

  if (channel.is_direct && currentUserId) {
    const otherMember = members.find(m => m.id !== currentUserId);
    if (otherMember) {
      channel.name = otherMember.full_name;
      channel.direct_user = otherMember;
    }
  }

  return channel;
}

async function getMessages(channelId, limit = 100) {
  const messages = await all(`
    SELECT m.*, 
           u.email as sender_email, u.full_name as sender_name, u.role as sender_role, u.department as sender_department, u.avatar as sender_avatar,
           rm.text as reply_to_text, rm.type as reply_to_type, rm.file_name as reply_to_file_name,
           ru.full_name as reply_to_sender_name
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    LEFT JOIN messages rm ON m.reply_to_id = rm.id
    LEFT JOIN users ru ON rm.sender_id = ru.id
    WHERE m.channel_id = ?
    ORDER BY m.created_at ASC
    LIMIT ?
  `, [channelId, limit]);
  return messages;
}

async function saveMessage({ channelId, senderId, text, type = 'text', fileUrl = null, fileName = null, fileSize = null, replyToId = null }) {
  const messageId = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  await run(
    `INSERT INTO messages (id, channel_id, sender_id, text, type, file_url, file_name, file_size, reply_to_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [messageId, channelId, senderId, text, type, fileUrl, fileName, fileSize, replyToId]
  );

  const saved = await get(`
    SELECT m.*, 
           u.email as sender_email, u.full_name as sender_name, u.role as sender_role, u.department as sender_department, u.avatar as sender_avatar,
           rm.text as reply_to_text, rm.type as reply_to_type, rm.file_name as reply_to_file_name,
           ru.full_name as reply_to_sender_name
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    LEFT JOIN messages rm ON m.reply_to_id = rm.id
    LEFT JOIN users ru ON rm.sender_id = ru.id
    WHERE m.id = ?
  `, [messageId]);

  return saved;
}

async function markMessagesAsRead(channelId, userId) {
  const unreadMessages = await all(`
    SELECT id FROM messages 
    WHERE channel_id = ? AND sender_id != ?
  `, [channelId, userId]);

  for (const m of unreadMessages) {
    await run(`
      INSERT INTO message_receipts (message_id, user_id, status, read_at)
      VALUES (?, ?, 'read', CURRENT_TIMESTAMP)
      ON CONFLICT(message_id, user_id) DO UPDATE SET status = 'read', read_at = CURRENT_TIMESTAMP
    `, [m.id, userId]);
  }
}

async function searchMessages(query) {
  const pattern = `%${query}%`;
  return await all(`
    SELECT m.*, u.full_name as sender_name, u.email as sender_email, c.name as channel_name, c.is_direct
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    JOIN channels c ON m.channel_id = c.id
    WHERE m.text LIKE ? OR m.file_name LIKE ?
    ORDER BY m.created_at DESC
    LIMIT 50
  `, [pattern, pattern]);
}

// Admin deletes a channel
async function deleteChannel(channelId, adminId) {
  const admin = await getUserById(adminId);
  if (!admin || admin.role !== 'Admin') {
    throw new Error('Only an Admin can delete channels.');
  }

  const channel = await get('SELECT * FROM channels WHERE id = ?', [channelId]);
  if (!channel) {
    throw new Error('Channel not found.');
  }

  // Delete message receipts for messages in this channel
  await run(`
    DELETE FROM message_receipts 
    WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)
  `, [channelId]);

  // Delete messages
  await run('DELETE FROM messages WHERE channel_id = ?', [channelId]);

  // Delete channel members
  await run('DELETE FROM channel_members WHERE channel_id = ?', [channelId]);

  // Delete channel
  await run('DELETE FROM channels WHERE id = ?', [channelId]);

  return { success: true, deletedId: channelId };
}

// Admin clears all chat messages (clean slate for Go-Live)
async function clearAllMessages(adminId = null) {
  if (adminId) {
    const admin = await getUserById(adminId);
    if (!admin || admin.role !== 'Admin') {
      throw new Error('Only an Admin can clear all messages.');
    }
  }

  await run('DELETE FROM message_receipts');
  await run('DELETE FROM messages');
  await run('PRAGMA wal_checkpoint(TRUNCATE)');
  return { success: true, message: 'All messages cleared successfully.' };
}

// Verify user credentials for login
async function verifyLogin(email, password, portalMode = null) {
  if (!email || !password) {
    throw new Error('Email and password are required.');
  }
  const cleanEmail = email.trim().toLowerCase();
  const user = await get('SELECT * FROM users WHERE LOWER(email) = ?', [cleanEmail]);
  if (!user) {
    throw new Error('No registered account found with that email.');
  }
  if (!user.password || user.password !== password.trim()) {
    throw new Error('Incorrect password. Please contact Admin if you need a password reset.');
  }
  if (portalMode === 'admin' && user.role !== 'Admin') {
    throw new Error('This account does not have Administrator privileges.');
  }

  const { password: _, ...safeUser } = user;
  return safeUser;
}

// Admin resets or updates an employee's password
async function resetEmployeePassword(employeeId, newPassword, adminId) {
  const admin = await getUserById(adminId);
  if (!admin || admin.role !== 'Admin') {
    throw new Error('Only an Admin can change employee passwords.');
  }

  const cleanPass = newPassword ? newPassword.trim() : '';
  if (!cleanPass) {
    throw new Error('Password cannot be empty.');
  }

  const targetUser = await getUserById(employeeId);
  if (!targetUser || targetUser.role !== 'Employee') {
    throw new Error('Employee not found or cannot change Admin password via this method.');
  }

  await run('UPDATE users SET password = ? WHERE id = ?', [cleanPass, employeeId]);
  return {
    success: true,
    employeeId,
    message: `Password for ${targetUser.full_name} (${targetUser.email}) has been updated.`
  };
}

// Any user (both Admin and Employee) changes their own password
async function changeOwnPassword(userId, currentPassword, newPassword) {
  const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) {
    throw new Error('User account not found.');
  }
  if (user.password && user.password !== currentPassword) {
    throw new Error('Current password does not match.');
  }
  const cleanPass = newPassword ? newPassword.trim() : '';
  if (!cleanPass || cleanPass.length < 3) {
    throw new Error('New password must be at least 3 characters.');
  }
  await run('UPDATE users SET password = ? WHERE id = ?', [cleanPass, userId]);
  return {
    success: true,
    userId,
    message: `Password for ${user.full_name} (${user.email}) updated successfully.`
  };
}

// Backward compatibility alias for changeAdminPassword
async function changeAdminPassword(adminId, oldPassword, newPassword) {
  return await changeOwnPassword(adminId, oldPassword, newPassword);
}

// ============================================================================
// WORK ASSISTANCE TRACKER
// Employee -> WhatsApp Group -> HR/Coordinator -> Assign -> Track -> Complete -> Confirm -> Close
// ============================================================================

async function createWorkRequest(data) {
  const {
    title,
    description = '',
    requester_name,
    requester_id = null,
    source = 'WhatsApp Group',
    assigned_team = 'IT',
    assigned_to_user_id = null,
    assigned_to_name = null,
    priority = 'Normal'
  } = data;

  if (!title || !title.trim()) {
    throw new Error('Request title is required');
  }
  if (!requester_name || !requester_name.trim()) {
    throw new Error('Requester name is required');
  }

  // Get next sequential integer
  const maxRow = await get('SELECT MAX(request_number) as maxNum FROM work_requests');
  const nextNum = (maxRow && maxRow.maxNum) ? (Number(maxRow.maxNum) + 1) : 1;
  const id = `WA-${String(nextNum).padStart(3, '0')}`;
  const validPriority = ['Urgent', 'High', 'Normal'].includes(priority) ? priority : 'Normal';
  const initialStatus = assigned_to_name ? 'Assigned' : 'New';

  await run(`INSERT INTO work_requests (
    id, request_number, title, description, requester_name, requester_id, source,
    assigned_team, assigned_to_user_id, assigned_to_name, priority, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
    id,
    nextNum,
    title.trim(),
    description ? description.trim() : '',
    requester_name.trim(),
    requester_id || null,
    source || 'WhatsApp Group',
    assigned_team || 'IT',
    assigned_to_user_id || null,
    assigned_to_name || null,
    validPriority,
    initialStatus
  ]);

  return await getWorkRequestById(id);
}

async function getWorkRequestById(id) {
  return await get('SELECT * FROM work_requests WHERE id = ?', [id]);
}

async function getAllWorkRequests(filters = {}) {
  let sql = 'SELECT * FROM work_requests WHERE 1=1';
  const params = [];

  if (filters.status && filters.status !== 'All') {
    if (filters.status === 'Active') {
      sql += " AND status NOT IN ('Closed', 'Completed')";
    } else {
      sql += ' AND status = ?';
      params.push(filters.status);
    }
  }

  if (filters.assigned_team && filters.assigned_team !== 'All') {
    sql += ' AND assigned_team = ?';
    params.push(filters.assigned_team);
  }

  if (filters.priority && filters.priority !== 'All') {
    sql += ' AND priority = ?';
    params.push(filters.priority);
  }

  if (filters.requester_id) {
    sql += ' AND requester_id = ?';
    params.push(filters.requester_id);
  }

  if (filters.assigned_to_user_id) {
    sql += ' AND assigned_to_user_id = ?';
    params.push(filters.assigned_to_user_id);
  }

  if (filters.search && filters.search.trim()) {
    const q = `%${filters.search.trim()}%`;
    sql += ' AND (id LIKE ? OR title LIKE ? OR requester_name LIKE ? OR description LIKE ? OR assigned_team LIKE ? OR assigned_to_name LIKE ?)';
    params.push(q, q, q, q, q, q);
  }

  // Priority sort: Urgent first, then High, then Normal; newest first
  sql += " ORDER BY CASE priority WHEN 'Urgent' THEN 1 WHEN 'High' THEN 2 ELSE 3 END, created_at DESC";

  return await all(sql, params);
}

async function updateWorkRequest(id, updates = {}) {
  const existing = await getWorkRequestById(id);
  if (!existing) throw new Error(`Work request "${id}" not found`);

  const allowedFields = [
    'title', 'description', 'assigned_team', 'assigned_to_user_id',
    'assigned_to_name', 'priority', 'status', 'resolution_notes'
  ];

  const setClauses = [];
  const params = [];

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      if (field === 'priority' && !['Urgent', 'High', 'Normal'].includes(updates[field])) {
        continue;
      }
      if (field === 'status' && !['New', 'Assigned', 'In Progress', 'Waiting', 'Completed', 'Closed'].includes(updates[field])) {
        continue;
      }
      setClauses.push(`${field} = ?`);
      params.push(updates[field]);
    }
  }

  if (setClauses.length === 0) {
    return existing;
  }

  setClauses.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);

  await run(`UPDATE work_requests SET ${setClauses.join(', ')} WHERE id = ?`, params);
  return await getWorkRequestById(id);
}

async function confirmWorkRequestResolution(id, confirmedByUserId = null, confirmedByName = null) {
  const existing = await getWorkRequestById(id);
  if (!existing) throw new Error(`Work request "${id}" not found`);

  await run(`UPDATE work_requests SET 
    employee_confirmed = 1, 
    employee_confirmed_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`, [id]);

  return await getWorkRequestById(id);
}

async function closeWorkRequest(id, closedByUserId = null, closedByName = 'Coordinator', resolutionNotes = '') {
  const existing = await getWorkRequestById(id);
  if (!existing) throw new Error(`Work request "${id}" not found`);

  await run(`UPDATE work_requests SET 
    status = 'Closed',
    closed_at = CURRENT_TIMESTAMP,
    closed_by_user_id = ?,
    closed_by_name = ?,
    resolution_notes = COALESCE(NULLIF(?, ''), resolution_notes),
    updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`, [closedByUserId, closedByName, resolutionNotes, id]);

  return await getWorkRequestById(id);
}

async function getWorkTrackerStats() {
  const totalRow = await get('SELECT COUNT(*) as count FROM work_requests');
  const urgentRow = await get("SELECT COUNT(*) as count FROM work_requests WHERE priority = 'Urgent'");
  const inProgRow = await get("SELECT COUNT(*) as count FROM work_requests WHERE status = 'In Progress'");
  const waitingRow = await get("SELECT COUNT(*) as count FROM work_requests WHERE status = 'Waiting'");
  const completedRow = await get("SELECT COUNT(*) as count FROM work_requests WHERE status = 'Completed'");
  const closedRow = await get("SELECT COUNT(*) as count FROM work_requests WHERE status = 'Closed'");

  return {
    total: totalRow ? totalRow.count : 0,
    urgent: urgentRow ? urgentRow.count : 0,
    inProgress: inProgRow ? inProgRow.count : 0,
    waiting: waitingRow ? waitingRow.count : 0,
    completed: completedRow ? completedRow.count : 0,
    closed: closedRow ? closedRow.count : 0
  };
}

// Admin clears all tracker work requests (clean slate for Go-Live)
async function clearAllWorkRequests(adminId = null) {
  if (adminId) {
    const admin = await getUserById(adminId);
    if (!admin || admin.role !== 'Admin') {
      throw new Error('Only an Admin can clear all work requests.');
    }
  }

  await run('DELETE FROM work_requests');
  await run('PRAGMA wal_checkpoint(TRUNCATE)');
  return { success: true, message: 'All tracker work requests cleared successfully.' };
}

async function findChannelBySource(source, assignedTeam = null) {
  if (!source) return null;

  // 1. Match by channel ID directly (e.g. 'chan-calling')
  let chan = await get('SELECT * FROM channels WHERE id = ?', [source]);
  if (chan) return chan;

  // 2. Match by exact or lowercase name (e.g. 'Calling Team')
  chan = await get('SELECT * FROM channels WHERE LOWER(name) = LOWER(?)', [source.trim()]);
  if (chan) return chan;

  // 3. Clean and substring match (e.g. 'Calling' in 'Calling Team')
  const cleanSource = source.replace(/^[^\w\s]+/, '').trim().toLowerCase();
  chan = await get('SELECT * FROM channels WHERE LOWER(name) = ? OR LOWER(name) LIKE ?', [cleanSource, `%${cleanSource}%`]);
  if (chan) return chan;

  // 4. If source is external (e.g. 'WhatsApp Group'), try matching the assignedTeam
  if (assignedTeam) {
    const cleanTeam = assignedTeam.replace(/^[^\w\s]+/, '').trim().toLowerCase();
    chan = await get('SELECT * FROM channels WHERE LOWER(name) = ? OR LOWER(name) LIKE ?', [cleanTeam, `%${cleanTeam}%`]);
    if (chan) return chan;
  }

  // 5. Fallback to General Announcements channel
  chan = await get("SELECT * FROM channels WHERE id = 'chan-general' OR LOWER(name) = 'general announcements'");
  if (chan) return chan;

  // 6. Any active company group channel
  return await get("SELECT * FROM channels WHERE is_direct = 0 ORDER BY created_at ASC LIMIT 1");
}

async function checkpointWal() {
  return await get('PRAGMA wal_checkpoint(TRUNCATE);');
}

async function getRecentAutoReply(channelId, senderId, minutes = 5) {
  return await get(
    `SELECT id FROM messages 
     WHERE channel_id = ? AND sender_id = ? AND text LIKE '[Auto-Reply]%' 
     AND datetime(created_at) > datetime('now', '-' || ? || ' minutes')`,
    [channelId, senderId, minutes]
  );
}

module.exports = {
  get,
  all,
  run,
  initDb,
  getUsers,
  getUserById,
  getUserByEmail,
  addEmployee,
  deleteEmployee,
  updateUserStatus,
  getChannelsForUser,
  getOrCreateDirectChannel,
  createGroupChannel,
  deleteChannel,
  addMemberToChannel,
  removeMemberFromChannel,
  getDepartments,
  addDepartment,
  deleteDepartment,
  updateEmployeeDepartment,
  getSetting,
  setSetting,
  registerClientUserAndChannel,
  getChannelDetails,
  getMessages,
  saveMessage,
  markMessagesAsRead,
  searchMessages,
  verifyLogin,
  resetEmployeePassword,
  changeAdminPassword,
  changeOwnPassword,
  createWorkRequest,
  getWorkRequestById,
  getAllWorkRequests,
  updateWorkRequest,
  confirmWorkRequestResolution,
  closeWorkRequest,
  getWorkTrackerStats,
  findChannelBySource,
  checkpointWal,
  getRecentAutoReply,
  clearAllMessages,
  clearAllWorkRequests
};

