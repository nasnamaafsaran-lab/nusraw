import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import cors from 'cors';
import multer from 'multer';
import cron from 'node-cron';
import db from './server/db.js';
import { comparePasswordSync, hashPasswordSync } from './server/utils/password.js';
import CryptoJS from 'crypto-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ENCRYPTION_KEY = 'secret-key-kurdistan-regional-government';

const encrypt = (text: string) => {
  if (!text) return text;
  return CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();
};

const decrypt = (ciphertext: string) => {
  if (!ciphertext) return ciphertext;
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY);
    const originalText = bytes.toString(CryptoJS.enc.Utf8);
    return originalText || ciphertext;
  } catch (e) {
    return ciphertext;
  }
};

const app = express();
const httpServer = createServer(app);

// Simple file logger
const logStream = fs.createWriteStream(path.join(__dirname, 'server.log'), { flags: 'a' });
const logError = (err: any) => {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ERROR: ${err.stack || err}\n`;
  console.error(message);
  logStream.write(message);
};

// Global error handler
process.on('uncaughtException', (err) => {
  logError(err);
  // Optional: exit to let the batch script restart
  process.exit(1); 
});

process.on('unhandledRejection', (reason, promise) => {
  logError(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
});

const PORT = 3000;

app.use(express.json({ limit: '50mb' })); // Increase limit for signatures/files
app.use(cors());

// File Upload Setup
const uploadDir = path.resolve('uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const backupDir = path.resolve('backups');
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  }
});

const uploadMiddleware = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});
app.use('/uploads', express.static(uploadDir));

// Notifications
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    userId TEXT,
    title TEXT,
    message TEXT,
    type TEXT,
    docId TEXT,
    read INTEGER DEFAULT 0,
    timestamp TEXT
  )
`);

const sendNotification = (userId: string, title: string, message: string, type: string, docId?: string) => {
  const id = Math.random().toString(36).substr(2, 9);
  const timestamp = new Date().toISOString();
  
  try {
      db.prepare('INSERT INTO notifications (id, userId, title, message, type, docId, read, timestamp) VALUES (?, ?, ?, ?, ?, ?, 0, ?)').run(id, userId, title, message, type, docId || null, timestamp);
  } catch (e) {
      console.error("Error saving notification", e);
  }

  io.to(userId).emit('notification', { id, userId, title, message, type, docId, read: false, timestamp });
};

const sendBroadcastNotification = (title: string, message: string, type: string, docId?: string) => {
   // For broadcast, we emit to all but don't save to individual history to avoid DB spam in this demo version.
   // Real systems would use a fan-out job.
   io.emit('notification', { id: Math.random().toString(36).substr(2, 9), userId: 'ALL', title, message, type, docId, read: false, timestamp: new Date().toISOString() });
}

app.get('/api/notifications', (req, res) => {
  const { userId } = req.query;
  try {
    const notifs = db.prepare('SELECT * FROM notifications WHERE userId = ? ORDER BY timestamp DESC LIMIT 100').all(userId);
    res.json(notifs.map((n: any) => ({...n, read: Boolean(n.read)})));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/notifications/:id/read', (req, res) => {
  const { id } = req.params;
  try {
    db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Hand Delivery Records
db.exec(`
  CREATE TABLE IF NOT EXISTS hand_delivery_records (
    id TEXT PRIMARY KEY,
    documentId TEXT,
    receiverName TEXT,
    receiverId TEXT,
    receiverDept TEXT,
    receiverRank TEXT,
    receiverPhone TEXT,
    receiverPhotoUrl TEXT,
    documentPhotoUrl TEXT,
    deliveredBy TEXT,
    timestamp TEXT,
    notes TEXT,
    FOREIGN KEY(documentId) REFERENCES documents(id)
  )
`);

app.get('/api/hand-delivery', (req, res) => {
  try {
    const records = db.prepare('SELECT * FROM hand_delivery_records ORDER BY timestamp DESC').all();
    res.json(records);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/hand-delivery', (req, res) => {
  const record = req.body;
  try {
    // Check if columns exist, if not add them (migration for existing db)
    try {
        db.prepare('ALTER TABLE hand_delivery_records ADD COLUMN receiverRank TEXT').run();
        db.prepare('ALTER TABLE hand_delivery_records ADD COLUMN receiverPhone TEXT').run();
    } catch (e) {
        // Columns likely exist
    }

    db.prepare(`
      INSERT INTO hand_delivery_records (id, documentId, receiverName, receiverId, receiverDept, receiverRank, receiverPhone, receiverPhotoUrl, documentPhotoUrl, deliveredBy, timestamp, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.documentId,
      record.receiverName,
      record.receiverId,
      record.receiverDept,
      record.receiverRank || null,
      record.receiverPhone || null,
      record.receiverPhotoUrl,
      record.documentPhotoUrl,
      record.deliveredBy,
      record.timestamp,
      record.notes
    );
    
    // Also update document history
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(record.documentId) as any;
    if (doc) {
        db.prepare(`
            INSERT INTO history (id, documentId, action, fromUser, toUser, timestamp, note)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(Math.random().toString(36).substr(2, 9), record.documentId, 'hand_delivered', record.deliveredBy, record.receiverName, record.timestamp, `Radestkrdn ba zma: ${record.notes || ''}`);
        
        // Notify All Participants
        const participants = JSON.parse(doc.participants || '[]');
        const uniqueRecipients = new Set([...participants, doc.senderId, doc.currentHolderId]);
        
        const docNum = doc.incomingNumber || doc.referenceNumber;
        const sourceText = doc.source ? ` لە ${doc.source}` : '';
        const deptText = doc.senderDepartment ? ` (لەلایەن: ${doc.senderDepartment})` : '';
        const docInfo = `ژمارە ${docNum}${sourceText}${deptText}`;

        uniqueRecipients.forEach((userId: string) => {
             // Don't notify the person who delivered it (if they are a system user)
             // But usually deliveredBy is the current user, so maybe we skip them?
             // Let's notify everyone for now as confirmation.
             sendNotification(userId, 'ڕادەستکردن بە زمە', `نوسراوی ${docInfo} بە دەستی ڕادەستی ${record.receiverName} کرا`, 'success', record.documentId);
        });

        // Notify Receiver if they are a system user and not already in participants (unlikely but possible)
        if (record.receiverId && !uniqueRecipients.has(record.receiverId)) {
            sendNotification(record.receiverId, 'نوسراوی نوێ (زمە)', `نوسراوی ${docInfo} بە دەستی ڕادەستی تۆ کرا`, 'info', record.documentId);
        }
    }

    io.emit('handDelivery:update');
    io.emit('documents:update');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Activity Logs
db.exec(`
  CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY,
    userId TEXT,
    userName TEXT,
    action TEXT,
    target TEXT,
    timestamp TEXT,
    type TEXT
  )
`);

app.get('/api/activity-logs', (req, res) => {
  try {
    const logs = db.prepare('SELECT * FROM activity_logs ORDER BY timestamp DESC LIMIT 50').all();
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// ToDo Items
db.exec(`
  CREATE TABLE IF NOT EXISTS todo_items (
    id TEXT PRIMARY KEY,
    userId TEXT,
    text TEXT,
    completed INTEGER,
    createdAt TEXT,
    dueDate TEXT
  )
`);

app.get('/api/todos', (req, res) => {
  const { userId } = req.query;
  try {
    const todos = db.prepare('SELECT * FROM todo_items WHERE userId = ? ORDER BY createdAt DESC').all(userId);
    res.json(todos.map((t: any) => ({ ...t, completed: Boolean(t.completed) })));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/todos', (req, res) => {
  const { userId, text, dueDate } = req.body;
  const id = Math.random().toString(36).substr(2, 9);
  const createdAt = new Date().toISOString();
  try {
    db.prepare('INSERT INTO todo_items (id, userId, text, completed, createdAt, dueDate) VALUES (?, ?, ?, 0, ?, ?)').run(id, userId, text, createdAt, dueDate || null);
    io.emit('toDoItems:update');
    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/todos/:id/toggle', (req, res) => {
  const { id } = req.params;
  try {
    const todo = db.prepare('SELECT completed FROM todo_items WHERE id = ?').get(id) as any;
    if (!todo) return res.status(404).json({ error: 'Todo not found' });
    db.prepare('UPDATE todo_items SET completed = ? WHERE id = ?').run(todo.completed ? 0 : 1, id);
    io.emit('toDoItems:update');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.delete('/api/todos/:id', (req, res) => {
  const { id } = req.params;
  try {
    db.prepare('DELETE FROM todo_items WHERE id = ?').run(id);
    io.emit('toDoItems:update');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// --- Constants ---
const WORKFLOW_STAGES = {
  DISPATCH: 'DISPATCH',
  DEPT_HEAD: 'DEPT_HEAD',
  SECTION_HEAD: 'SECTION_HEAD',
  EMPLOYEE: 'EMPLOYEE',
  DEPUTY: 'DEPUTY',
  DIRECTOR: 'DIRECTOR',
  PRINT: 'PRINT',
  ARCHIVE: 'ARCHIVE'
};

import os from 'os';

// --- Helper Functions ---
const getLocalIpAddress = () => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      // Skip internal (i.e. 127.0.0.1) and non-ipv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
};

const generateReferenceNumber = () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `${year}${month}-${random}`;
};

import archiver from 'archiver';
import AdmZip from 'adm-zip';

// Backup Logic
const createBackup = async (saveToDisk = false) => {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backup-${timestamp}.zip`;
  
  let output;
  if (saveToDisk) {
    const filePath = path.join(backupDir, filename);
    output = fs.createWriteStream(filePath);
    archive.pipe(output);
  }

  // 1. Dump Database
  const tables = ['users', 'departments', 'workflow_templates', 'documents', 'history', 'attachments', 'chats', 'messages', 'notifications'];
  const dbDump: Record<string, any[]> = {};
  
  for (const table of tables) {
      try {
          dbDump[table] = db.prepare(`SELECT * FROM ${table}`).all();
      } catch (e) {
          console.warn(`Table ${table} might not exist or error reading:`, e);
          dbDump[table] = [];
      }
  }
  
  archive.append(JSON.stringify(dbDump, null, 2), { name: 'database.json' });

  // 2. Add Uploads Directory
  archive.directory(uploadDir, 'uploads');

  await archive.finalize();
  
  if (saveToDisk && output) {
    return new Promise((resolve, reject) => {
      output.on('close', () => {
        console.log(`Backup created: ${filename}`);
        resolve(filename);
      });
      output.on('error', reject);
    });
  }
  
  return archive;
};

// Schedule Automatic Backups (Every 2 weeks on Sunday at 2 AM)
cron.schedule('0 2 * * 0', async () => {
  const weekNumber = Math.floor(new Date().getDate() / 7);
  // Run on 1st and 3rd week (approx every 2 weeks)
  if (weekNumber % 2 === 0) {
    console.log('Running scheduled backup...');
    try {
      await createBackup(true);
    } catch (error) {
      console.error('Scheduled backup failed:', error);
    }
  }
});

// SLA Check (Daily at 9 AM)
cron.schedule('0 9 * * *', () => {
  console.log('Running SLA check...');
  try {
    const docs = db.prepare("SELECT * FROM documents WHERE status NOT IN ('Approved', 'Rejected', 'Archived')").all();
    const now = new Date();
    const SLA_DAYS = 7;
    
    docs.forEach((doc: any) => {
      // Find last history entry to determine when it arrived at this stage
      const lastHistory = db.prepare("SELECT timestamp FROM history WHERE documentId = ? ORDER BY timestamp DESC LIMIT 1").get(doc.id) as any;
      const lastActionTime = lastHistory ? new Date(lastHistory.timestamp) : new Date(doc.createdAt);
      
      const diffTime = Math.abs(now.getTime() - lastActionTime.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
      
      if (diffDays >= SLA_DAYS - 1) { // 1 day remaining or overdue
         // Send notification
         const message = diffDays > SLA_DAYS 
            ? `نوسراوی ${doc.title} وادەی بەسەرچووە بە ${diffDays - SLA_DAYS} ڕۆژ`
            : `تەنها ١ ڕۆژ ماوە بۆ نوسراوی ${doc.title}`;
            
         io.to(doc.currentHolderId).emit('notification', {
           title: 'ئاگادارکردنەوەی وادە (SLA)',
           message,
           type: 'warning',
           docId: doc.id
         });
      }
    });
  } catch (error) {
    console.error('SLA check failed:', error);
  }
});

// --- API Routes ---

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  try {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
    if (!user) {
      return res.status(401).json({ success: false, error: 'ناوی بەکارهێنەر یان وشەی نهێنی هەڵەیە' });
    }

    if (user.isLocked) {
      return res.status(403).json({ success: false, error: 'ئەم هەژمارە داخراوە' });
    }

    const isValid = comparePasswordSync(password, user.password);
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'ناوی بەکارهێنەر یان وشەی نهێنی هەڵەیە' });
    }

    // Don't send password back
    const { password: _, ...userWithoutPassword } = user;
    res.json({ success: true, user: userWithoutPassword });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// List Backups Endpoint
app.get('/api/backups', (req, res) => {
  try {
    const files = fs.readdirSync(backupDir)
      .filter(file => file.endsWith('.zip'))
      .map(file => {
        const stats = fs.statSync(path.join(backupDir, file));
        return {
          filename: file,
          date: stats.mtime,
          size: stats.size
        };
      })
      .sort((a, b) => b.date.getTime() - a.date.getTime());
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: 'Failed to list backups' });
  }
});

// Restore from Server Backup Endpoint
app.post('/api/restore/:filename', async (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(backupDir, filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup file not found' });
  }

  try {
    const zip = new AdmZip(filePath);
    const zipEntries = zip.getEntries();

    // 1. Restore Database
    const dbEntry = zipEntries.find(entry => entry.entryName === 'database.json');
    if (dbEntry) {
      const dbData = JSON.parse(dbEntry.getData().toString('utf8'));
      
      db.transaction(() => {
        db.pragma('foreign_keys = OFF');
        for (const [table, rows] of Object.entries(dbData)) {
            if (!Array.isArray(rows)) continue;
            try { db.prepare(`DELETE FROM ${table}`).run(); } catch (e) { continue; }
            if (rows.length === 0) continue;
            const columns = Object.keys(rows[0]);
            const placeholders = columns.map(() => '?').join(',');
            const stmt = db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`);
            for (const row of rows) { stmt.run(...Object.values(row as any)); }
        }
        db.pragma('foreign_keys = ON');
      })();
    }

    // 2. Restore Uploads
    const uploadEntries = zipEntries.filter(entry => entry.entryName.startsWith('uploads/'));
    for (const entry of uploadEntries) {
        const fileName = entry.entryName.replace('uploads/', '');
        if (!fileName) continue;
        const fullPath = path.join(uploadDir, fileName);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullPath, entry.getData());
    }

    io.emit('users:update');
    io.emit('departments:update');
    io.emit('documents:update');
    io.emit('workflowTemplates:update');
    io.emit('chats:update');

    res.json({ success: true });
  } catch (error) {
    console.error('Restore failed:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Backup Endpoint (Download)
app.get('/api/backup', async (req, res) => {
  try {
    const archive = await createBackup(false) as archiver.Archiver;
    res.attachment(`backup-${new Date().toISOString().split('T')[0]}.zip`);
    archive.pipe(res);
  } catch (error) {
    console.error('Backup failed:', error);
    res.status(500).send('Backup failed');
  }
});

// Restore Endpoint
app.post('/api/restore', uploadMiddleware.single('backup'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No backup file uploaded' });
  }

  try {
    const zip = new AdmZip(req.file.path);
    const zipEntries = zip.getEntries();

    // 1. Restore Database
    const dbEntry = zipEntries.find(entry => entry.entryName === 'database.json');
    if (dbEntry) {
      const dbData = JSON.parse(dbEntry.getData().toString('utf8'));
      
      db.transaction(() => {
        // Disable foreign keys temporarily
        db.pragma('foreign_keys = OFF');

        for (const [table, rows] of Object.entries(dbData)) {
            if (!Array.isArray(rows)) continue;
            
            // Clear table
            try {
                db.prepare(`DELETE FROM ${table}`).run();
            } catch (e) {
                console.warn(`Could not clear table ${table}:`, e);
                continue;
            }

            if (rows.length === 0) continue;

            // Insert rows
            const columns = Object.keys(rows[0]);
            const placeholders = columns.map(() => '?').join(',');
            const stmt = db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`);
            
            for (const row of rows) {
                stmt.run(...Object.values(row as any));
            }
        }
        
        db.pragma('foreign_keys = ON');
      })();
    }

    // 2. Restore Uploads
    const uploadEntries = zipEntries.filter(entry => entry.entryName.startsWith('uploads/'));
    for (const entry of uploadEntries) {
        const fileName = entry.entryName.replace('uploads/', '');
        if (!fileName) continue; // Skip directory entry itself
        
        // Ensure directory exists if nested (though uploads is flat usually)
        const fullPath = path.join(uploadDir, fileName);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        fs.writeFileSync(fullPath, entry.getData());
    }

    // Cleanup uploaded backup file
    fs.unlinkSync(req.file.path);

    // Notify clients to refresh
    io.emit('users:update');
    io.emit('departments:update');
    io.emit('documents:update');
    io.emit('workflowTemplates:update');
    io.emit('chats:update');

    res.json({ success: true });
  } catch (error) {
    console.error('Restore failed:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Network Info Endpoint
app.get('/api/network-info', (req, res) => {
  const ip = getLocalIpAddress();
  res.json({ ip, port: PORT });
});

// Upload Endpoint
app.post('/api/upload', uploadMiddleware.array('files'), (req, res) => {
  if (!req.files || (req.files as Express.Multer.File[]).length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }
  
  const uploadedFiles = (req.files as Express.Multer.File[]).map(file => {
    let type: 'pdf' | 'word' | 'excel' | 'image' | 'other' = 'other';
    if (file.mimetype.includes('pdf')) type = 'pdf';
    else if (file.mimetype.includes('word') || file.mimetype.includes('document')) type = 'word';
    else if (file.mimetype.includes('sheet') || file.mimetype.includes('excel')) type = 'excel';
    else if (file.mimetype.includes('image')) type = 'image';

    return {
      id: Math.random().toString(36).substr(2, 9),
      name: file.originalname,
      type,
      url: `/uploads/${file.filename}`
    };
  });
  
  res.json(uploadedFiles);
});

// Users
// Migration for new columns
try {
  db.prepare('ALTER TABLE users ADD COLUMN password TEXT').run();
  db.prepare('UPDATE users SET password = "123"').run();
} catch (e) { /* Column exists */ }

try {
  db.prepare('ALTER TABLE users ADD COLUMN signature TEXT').run();
} catch (e) { /* Column exists */ }

app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT id, name, username, role, department, title, avatar, signature, isLocked FROM users').all();
  res.json(users);
});

app.post('/api/users', (req, res) => {
  const { username, name, role, department, title, password } = req.body;
  const id = 'u_' + Math.random().toString(36).substr(2, 9);
  try {
    const hashedPassword = hashPasswordSync(password || '123');
    db.prepare('INSERT INTO users (id, username, name, role, department, title, isLocked, password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, username, name, role, department, title, 0, hashedPassword);
    io.emit('users:update');
    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/users/change-password', (req, res) => {
  const { userId, currentPassword, newPassword } = req.body;
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Verify current password
    if (user.password && !comparePasswordSync(currentPassword, user.password)) {
        return res.status(400).json({ error: 'وشەی نهێنی ئێستا هەڵەیە' });
    }

    const hashedNewPassword = hashPasswordSync(newPassword);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedNewPassword, userId);
    io.emit('users:update');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/users/:id/signature', (req, res) => {
  const { id } = req.params;
  const { signature } = req.body;
  try {
    db.prepare('UPDATE users SET signature = ? WHERE id = ?').run(signature, id);
    io.emit('users:update');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.put('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const { username, name, role, department, title, isLocked } = req.body;
  try {
    if (isLocked !== undefined) {
      db.prepare('UPDATE users SET username = ?, name = ?, role = ?, department = ?, title = ?, isLocked = ? WHERE id = ?').run(username, name, role, department, title, isLocked ? 1 : 0, id);
    } else {
      db.prepare('UPDATE users SET username = ?, name = ?, role = ?, department = ?, title = ? WHERE id = ?').run(username, name, role, department, title, id);
    }
    io.emit('users:update');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.delete('/api/users/:id', (req, res) => {
  const { id } = req.params;
  try {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    io.emit('users:update');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/users/:id/toggle-lock', (req, res) => {
  const { id } = req.params;
  try {
    const user = db.prepare('SELECT isLocked FROM users WHERE id = ?').get(id) as any;
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.prepare('UPDATE users SET isLocked = ? WHERE id = ?').run(user.isLocked ? 0 : 1, id);
    io.emit('users:update');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Departments
app.get('/api/departments', (req, res) => {
  const departments = db.prepare('SELECT * FROM departments').all();
  const parsedDepts = departments.map((d: any) => ({
    ...d,
    allowedDestinations: d.allowedDestinations ? JSON.parse(d.allowedDestinations) : []
  }));
  res.json(parsedDepts);
});

app.post('/api/departments', (req, res) => {
  const { id, name, type, parentDept } = req.body;
  try {
    db.prepare('INSERT INTO departments (id, name, type, parentDept, allowedDestinations) VALUES (?, ?, ?, ?, ?)').run(id, name, type, parentDept || null, JSON.stringify([]));
    io.emit('departments:update');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.put('/api/departments/:id', (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  try {
    const current = db.prepare('SELECT * FROM departments WHERE id = ?').get(id) as any;
    if (!current) return res.status(404).json({ error: 'Department not found' });

    db.prepare(`
      UPDATE departments 
      SET name = COALESCE(?, name),
          type = COALESCE(?, type),
          parentDept = COALESCE(?, parentDept),
          allowedDestinations = COALESCE(?, allowedDestinations)
      WHERE id = ?
    `).run(
      updates.name, 
      updates.type, 
      updates.parentDept, 
      updates.allowedDestinations ? JSON.stringify(updates.allowedDestinations) : null, 
      id
    );
    
    io.emit('departments:update');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.delete('/api/departments/:id', (req, res) => {
  const { id } = req.params;
  try {
    db.prepare('DELETE FROM departments WHERE id = ?').run(id);
    io.emit('departments:update');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});
app.get('/api/workflow-templates', (req, res) => {
  const templates = db.prepare('SELECT * FROM workflow_templates').all();
  res.json(templates.map((t: any) => ({ ...t, steps: JSON.parse(t.steps) })));
});

app.post('/api/workflow-templates', (req, res) => {
  const { id, name, description, steps, createdBy } = req.body;
  const createdAt = new Date().toISOString();
  try {
    db.prepare('INSERT INTO workflow_templates (id, name, description, steps, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, description, JSON.stringify(steps), createdBy, createdAt);
    io.emit('workflowTemplates:update');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.put('/api/workflow-templates/:id', (req, res) => {
  const { id } = req.params;
  const { name, description, steps } = req.body;
  try {
    db.prepare('UPDATE workflow_templates SET name = ?, description = ?, steps = ? WHERE id = ?').run(name, description, JSON.stringify(steps), id);
    io.emit('workflowTemplates:update');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.delete('/api/workflow-templates/:id', (req, res) => {
  const { id } = req.params;
  try {
    db.prepare('DELETE FROM workflow_templates WHERE id = ?').run(id);
    io.emit('workflowTemplates:update');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Documents
app.get('/api/documents', (req, res) => {
  const { userId, role, department } = req.query;
  
  let query = 'SELECT * FROM documents';
  const params: any[] = [];

  // RBAC for Documents
  // Super Admin: Sees all
  // Dispatch: Sees all
  // Others: See documents where they are participant OR current holder OR sender
  if (role !== 'super_admin' && role !== 'dispatch') {
     // This is a simplified check. In production, use a more robust query.
     // We filter in memory for simplicity here, or use LIKE for participants JSON
     // But better to fetch all and filter in code for this scale
  }

  const docs = db.prepare(query).all(params);
  
  const fullDocs = docs.map((doc: any) => {
    const history = db.prepare('SELECT * FROM history WHERE documentId = ? ORDER BY timestamp ASC').all(doc.id);
    const attachments = db.prepare('SELECT * FROM attachments WHERE documentId = ?').all(doc.id);
    const comments = db.prepare('SELECT * FROM comments WHERE documentId = ? ORDER BY timestamp ASC').all(doc.id);
    
    const participants = doc.participants ? JSON.parse(doc.participants) : [];
    const circularReadBy = doc.circularReadBy ? JSON.parse(doc.circularReadBy) : [];
    const signatureData = doc.signatureData ? JSON.parse(doc.signatureData) : null;
    const relatedDocIds = doc.relatedDocIds ? JSON.parse(doc.relatedDocIds) : [];

    // Filter logic if not super admin/dispatch
    if (role && role !== 'super_admin' && role !== 'dispatch') {
        const isParticipant = participants.includes(userId) || participants.includes(department);
        const isHolder = doc.currentHolderId === userId;
        const isSender = doc.senderId === userId;
        const isDeptHolder = doc.currentHolderId === department; 
        const isCircular = doc.isCircular === 1;

        if (!isParticipant && !isHolder && !isSender && !isDeptHolder && !isCircular) {
            return null;
        }
    }

    return { 
      ...doc, 
      content: decrypt(doc.content), 
      history: history.map((h: any) => ({ ...h, metadata: h.metadata ? JSON.parse(h.metadata) : undefined })), 
      attachments,
      comments,
      participants,
      circularReadBy,
      signatureData,
      relatedDocIds,
      isCircular: Boolean(doc.isCircular)
    };
  }).filter(Boolean); // Remove nulls

  res.json(fullDocs);
});

try {
  db.prepare('ALTER TABLE documents ADD COLUMN relatedRoomName TEXT').run();
} catch (e) { /* Column exists */ }

app.post('/api/documents', (req, res) => {
  const doc = req.body;
  const { title, content, senderId, senderName, senderDepartment, currentHolderId, status, priority, confidentiality, deadline, attachments, isCircular, workflowStage, workflowTemplateId, currentStepIndex, incomingNumber, incomingDate, source, relatedDocIds, relatedRoomName } = doc;

  const id = Math.random().toString(36).substr(2, 9);
  const referenceNumber = generateReferenceNumber();
  const createdAt = new Date().toISOString();
  const participants = [senderId, senderDepartment];
  
  // Also add current holder's department to participants
  if (currentHolderId) {
    if (!participants.includes(currentHolderId)) participants.push(currentHolderId);
    const holder = db.prepare('SELECT department FROM users WHERE id = ?').get(currentHolderId) as any;
    if (holder && !participants.includes(holder.department)) {
        participants.push(holder.department);
    }
  }

  try {
    const insertDoc = db.transaction(() => {
      db.prepare(`
        INSERT INTO documents (id, referenceNumber, title, content, senderId, senderName, senderDepartment, currentHolderId, status, priority, confidentiality, deadline, createdAt, participants, workflowStage, workflowTemplateId, currentStepIndex, isCircular, circularReadBy, signatureData, incomingNumber, incomingDate, source, relatedDocIds, relatedRoomName)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, referenceNumber, title, encrypt(content), senderId, senderName, senderDepartment, currentHolderId, status, priority, confidentiality, deadline, createdAt, JSON.stringify(participants), workflowStage || WORKFLOW_STAGES.DISPATCH, workflowTemplateId || null, currentStepIndex || 0, isCircular ? 1 : 0, '[]', null, incomingNumber || null, incomingDate || null, source || null, JSON.stringify(relatedDocIds || []), relatedRoomName || null);

      db.prepare(`
        INSERT INTO history (id, documentId, action, fromUser, toUser, timestamp, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(Math.random().toString(36).substr(2, 9), id, 'CREATED', senderId, currentHolderId, createdAt, 'Document Created');

      db.prepare(`
        INSERT INTO activity_logs (id, userId, userName, action, target, timestamp, type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(Math.random().toString(36).substr(2, 9), senderId, senderName, 'نوسراوێکی نوێی دروستکرد', title, createdAt, 'create');

      const insertAtt = db.prepare(`
        INSERT INTO attachments (id, documentId, name, type, url)
        VALUES (?, ?, ?, ?, ?)
      `);

      if (attachments) {
        attachments.forEach((a: any) => {
          insertAtt.run(a.id, id, a.name, a.type, a.url);
        });
      }
    });

    insertDoc();
    io.emit('documents:update');
    
    const docNum = incomingNumber || referenceNumber;
    const sourceText = source ? ` لە ${source}` : '';
    const deptText = senderDepartment ? ` (لەلایەن: ${senderDepartment})` : '';
    const docInfo = `ژمارە ${docNum}${sourceText}${deptText}`;

    if (isCircular) {
        sendBroadcastNotification('نوسراوی گشتاندن', `نوسراوێکی گشتاندنی نوێ (${docInfo}): ${title}`, 'info', id);
    } else {
        sendNotification(currentHolderId, 'نوسراوی نوێ', `نوسراوێکی نوێت بۆ هاتوە (${docInfo}): ${title}`, 'info', id);
    }
    
    res.json({ success: true, id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: (error as Error).message });
  }
});

app.put('/api/documents/:id', (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  
  try {
    const currentDoc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as any;
    if (!currentDoc) return res.status(404).json({ error: 'Document not found' });

    let participants = JSON.parse(currentDoc.participants || '[]');
    if (updates.currentHolderId) {
        if (!participants.includes(updates.currentHolderId)) {
            participants.push(updates.currentHolderId);
        }
        // Also add the holder's department
        const holder = db.prepare('SELECT department FROM users WHERE id = ?').get(updates.currentHolderId) as any;
        if (holder && !participants.includes(holder.department)) {
            participants.push(holder.department);
        }
    }

    const updateStmt = db.prepare(`
      UPDATE documents 
      SET currentHolderId = COALESCE(?, currentHolderId),
          status = COALESCE(?, status),
          workflowStage = COALESCE(?, workflowStage),
          currentStepIndex = COALESCE(?, currentStepIndex),
          participants = ?,
          signatureData = COALESCE(?, signatureData),
          circularReadBy = COALESCE(?, circularReadBy),
          title = COALESCE(?, title),
          content = COALESCE(?, content),
          priority = COALESCE(?, priority),
          confidentiality = COALESCE(?, confidentiality)
      WHERE id = ?
    `);

    updateStmt.run(
        updates.currentHolderId || null,
        updates.status || null,
        updates.workflowStage || null,
        updates.currentStepIndex !== undefined ? updates.currentStepIndex : null,
        JSON.stringify(participants),
        updates.signatureData ? JSON.stringify(updates.signatureData) : null,
        updates.circularReadBy ? JSON.stringify(updates.circularReadBy) : null,
        updates.title || null,
        updates.content || null,
        updates.priority || null,
        updates.confidentiality || null,
        id
    );

    if (updates.history && Array.isArray(updates.history)) {
      const h = updates.history[updates.history.length - 1];
      db.prepare(`
        INSERT INTO history (id, documentId, action, fromUser, toUser, timestamp, note, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(Math.random().toString(36).substr(2, 9), id, h.action, h.fromUser, h.toUser || null, h.timestamp, h.note || null, h.metadata ? JSON.stringify(h.metadata) : null);
    } else if (updates.newHistory) {
      const h = updates.newHistory;
      db.prepare(`
        INSERT INTO history (id, documentId, action, fromUser, toUser, timestamp, note, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(Math.random().toString(36).substr(2, 9), id, h.action, h.fromUser, h.toUser || null, h.timestamp, h.note || null, h.metadata ? JSON.stringify(h.metadata) : null);
    }

    if (updates.attachments && Array.isArray(updates.attachments)) {
      db.prepare('DELETE FROM attachments WHERE documentId = ?').run(id);
      const insertAtt = db.prepare(`
        INSERT INTO attachments (id, documentId, name, type, url)
        VALUES (?, ?, ?, ?, ?)
      `);
      updates.attachments.forEach((a: any) => {
        insertAtt.run(a.id, id, a.name, a.type, a.url);
      });
    }

    io.emit('documents:update');
    
    const docNum = currentDoc.incomingNumber || currentDoc.referenceNumber;
    const sourceText = currentDoc.source ? ` لە ${currentDoc.source}` : '';
    const deptText = currentDoc.senderDepartment ? ` (لەلایەن: ${currentDoc.senderDepartment})` : '';
    const docInfo = `ژمارە ${docNum}${sourceText}${deptText}`;

    // Notifications for updates
    if (updates.currentHolderId && updates.currentHolderId !== currentDoc.currentHolderId) {
       sendNotification(updates.currentHolderId, 'نوسراوی نوێ', `نوسراوێکی نوێت بۆ هاتوە (${docInfo}): ${currentDoc.title}`, 'info', id);
    }

    // Workflow Stage Change Notification
    if (updates.workflowStage && updates.workflowStage !== currentDoc.workflowStage) {
        const stageName = updates.workflowStage; // You might want to map this to a friendly name
        sendNotification(currentDoc.senderId, 'گۆڕانی قۆناغی نوسراو', `نوسراوی ${docInfo} گواسترایەوە بۆ قۆناغی ${stageName}`, 'info', id);
        
        if (currentDoc.currentHolderId && currentDoc.currentHolderId !== currentDoc.senderId) {
             sendNotification(currentDoc.currentHolderId, 'گۆڕانی قۆناغی نوسراو', `نوسراوی ${docInfo} گواسترایەوە بۆ قۆناغی ${stageName}`, 'info', id);
        }
    }

    if (updates.status && updates.status !== currentDoc.status) {
        // Log activity
        const user = db.prepare('SELECT name FROM users WHERE id = ?').get(updates.currentHolderId || currentDoc.currentHolderId) as any;
        if (user) {
          let action = 'دۆخی نوسراوی گۆڕی';
          let type = 'comment';
          if (updates.status === 'Approved') { action = 'نوسراوی پەسەند کرد'; type = 'approve'; }
          else if (updates.status === 'Rejected') { action = 'نوسراوی ڕەتکردەوە'; type = 'reject'; }
          else if (updates.status === 'Archived') { action = 'نوسراوی ئەرشیف کرد'; type = 'archive'; }

          db.prepare(`
            INSERT INTO activity_logs (id, userId, userName, action, target, timestamp, type)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(Math.random().toString(36).substr(2, 9), updates.currentHolderId || currentDoc.currentHolderId, user.name, action, currentDoc.title, new Date().toISOString(), type);
          
          io.emit('activityLogs:update');
        }

        // Notify the sender about status change
        sendNotification(currentDoc.senderId, 'گۆڕانی دۆخی نوسراو', `دۆخی نوسراوی ${docInfo} گۆڕا بۆ ${updates.status}`, updates.status === 'Approved' ? 'success' : updates.status === 'Rejected' ? 'error' : 'info', id);
    }

    // Notify about new comments/history
    const latestHistory = updates.newHistory || (updates.history && updates.history[updates.history.length - 1]);
    if (latestHistory && latestHistory.action === 'comment') {
        // Notify the current holder if someone else comments
        if (currentDoc.currentHolderId && latestHistory.fromUser !== currentDoc.currentHolderId) {
            sendNotification(currentDoc.currentHolderId, 'تێبینی نوێ', `${latestHistory.fromUser} تێبینییەکی بۆ نوسراوی "${currentDoc.title}" زیاد کرد`, 'info', id);
        }
    }

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Comments
app.post('/api/documents/:id/comments', (req, res) => {
  const { id } = req.params;
  const { userId, userName, content } = req.body;
  
  try {
    const currentDoc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as any;
    if (!currentDoc) return res.status(404).json({ error: 'Document not found' });

    const commentId = Math.random().toString(36).substr(2, 9);
    const timestamp = new Date().toISOString();

    db.prepare(`
      INSERT INTO comments (id, documentId, userId, userName, content, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(commentId, id, userId, userName, content, timestamp);

    io.emit('documents:update');
    
    // Notify the current holder if someone else comments
    if (currentDoc.currentHolderId && userId !== currentDoc.currentHolderId) {
        const docNum = currentDoc.incomingNumber || currentDoc.referenceNumber;
        const sourceText = currentDoc.source ? ` لە ${currentDoc.source}` : '';
        const deptText = currentDoc.senderDepartment ? ` (لەلایەن: ${currentDoc.senderDepartment})` : '';
        const docInfo = `ژمارە ${docNum}${sourceText}${deptText}`;
        sendNotification(currentDoc.currentHolderId, 'تێبینی نوێ', `${userName} تێبینییەکی بۆ نوسراوی "${docInfo}" زیاد کرد`, 'info', id);
    }

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Chats
app.get('/api/chats', (req, res) => {
  const { userId } = req.query;
  // Get chats where user is participant
  const allChats = db.prepare('SELECT * FROM chats').all();
  const userChats = allChats.filter((c: any) => {
      const parts = JSON.parse(c.participants);
      return parts.includes(userId);
  });
  res.json(userChats);
});

app.post('/api/chats', (req, res) => {
    const { type, name, participants } = req.body;
    const id = Math.random().toString(36).substr(2, 9);
    const createdAt = new Date().toISOString();
    
    try {
        db.prepare(`
            INSERT INTO chats (id, type, name, participants, createdAt)
            VALUES (?, ?, ?, ?, ?)
        `).run(id, type, name, JSON.stringify(participants), createdAt);
        
        io.emit('chats:update');
        res.json({ success: true, id });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

app.get('/api/chats/:id/messages', (req, res) => {
    const { id } = req.params;
    const messages = db.prepare('SELECT * FROM messages WHERE chatId = ? ORDER BY createdAt ASC').all(id);
    res.json(messages);
});

app.post('/api/messages', (req, res) => {
    const { chatId, senderId, content, type, fileUrl } = req.body;
    const id = Math.random().toString(36).substr(2, 9);
    const createdAt = new Date().toISOString();
    
    try {
        db.prepare(`
            INSERT INTO messages (id, chatId, senderId, content, type, fileUrl, createdAt, readBy)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, chatId, senderId, content, type, fileUrl, createdAt, JSON.stringify([senderId]));
        
        // Notify participants
        const chat = db.prepare('SELECT participants FROM chats WHERE id = ?').get(chatId) as any;
        if (chat) {
            const participants = JSON.parse(chat.participants);
            participants.forEach((p: string) => {
                io.to(p).emit('message:new', { chatId, message: { id, chatId, senderId, content, type, fileUrl, createdAt } });
            });
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// Settings
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

app.get('/api/settings', (req, res) => {
  try {
    const settings = db.prepare('SELECT * FROM settings').all();
    const settingsObj = settings.reduce((acc: any, curr: any) => {
      acc[curr.key] = curr.value;
      return acc;
    }, {});
    res.json(settingsObj);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/settings', (req, res) => {
  const { key, value } = req.body;
  try {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/settings/optimize', (req, res) => {
  try {
    db.exec('VACUUM');
    res.json({ success: true, message: 'Database optimized successfully' });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/settings/cleanup-attachments', (req, res) => {
  const { beforeDate } = req.body;
  try {
    // Find attachments for documents created before the date
    // In a real app, we would also delete files from disk here
    
    // Get count first
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM attachments 
      WHERE documentId IN (SELECT id FROM documents WHERE createdAt < ?)
    `).get(beforeDate) as any;
    
    const count = result.count;

    if (count > 0) {
      db.prepare(`
        DELETE FROM attachments 
        WHERE documentId IN (SELECT id FROM documents WHERE createdAt < ?)
      `).run(beforeDate);
    }

    res.json({ success: true, count, message: `${count} attachments deleted` });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Socket.io
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join', (userId) => {
    socket.join(userId);
    console.log(`User ${userId} joined their room`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Global error:', err);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File is too large. Max limit is 50MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Internal Server Error' });
});

// Vite Middleware
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve('dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve('dist', 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
