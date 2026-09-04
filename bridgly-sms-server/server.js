require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const express = require('express');
const compression = require('compression');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');

// MongoDB setup
const MONGO_URI = process.env.MONGODB_URI;
const MONGO_DB = process.env.MONGODB_DB || 'bridgly-v5';
let db = null;

async function connectMongo() {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        db = client.db(MONGO_DB);
        console.log(`Connected to MongoDB: ${MONGO_DB}`);

        // Create indexes
        try {
            await db.collection('message_history').createIndex({ createdAt: -1 });
            await db.collection('message_history').createIndex({ status: 1 });
            await db.collection('message_history').createIndex({ createdAt: -1, status: 1 });
            await db.collection('message_history').createIndex({ status: 1, createdAt: -1 });
            await db.collection('message_history').createIndex({ deviceModel: 1, createdAt: -1 });
            await db.collection('message_history').createIndex({ sender: 1, createdAt: -1 });
            await db.collection('bulk_queue').createIndex({ senderKey: 1 });
            await db.collection('bulk_queue').createIndex({ createdAt: 1 });
        } catch (idxErr) {
            console.warn('Note: Non-critical index creation warning:', idxErr.message);
        }
    } catch (e) {
        console.error('Failed to connect to MongoDB:', e.message);
        process.exit(1);
    }
}

// Generate unique message IDs
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Normalize phone numbers by keeping only the last 9 digits of digit-only string
function normalizePhoneNumber(num) {
    if (!num) return '';
    const digits = num.toString().replace(/\D/g, '');
    return digits.length >= 9 ? digits.slice(-9) : digits;
}

// Parse CSV text supporting quoted values and commas
function parseCSV(text) {
    const lines = [];
    let row = [];
    let inQuotes = false;
    let current = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i+1];
        if (c === '"') {
            if (inQuotes && next === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (c === ',' && !inQuotes) {
            row.push(current.trim());
            current = '';
        } else if ((c === '\r' || c === '\n') && !inQuotes) {
            if (c === '\r' && next === '\n') {
                i++;
            }
            row.push(current.trim());
            if (row.some(x => x !== '')) {
                lines.push(row);
            }
            row = [];
            current = '';
        } else {
            current += c;
        }
    }
    if (current !== '' || row.length > 0) {
        row.push(current.trim());
        if (row.some(x => x !== '')) {
            lines.push(row);
        }
    }
    return lines;
}

const app = express();
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('error', (err) => {
    console.error('WebSocket Server error:', err);
});

const connectedPhones = new Map();
const messageHistory = [];
const webClients = new Set();

// In-memory state (synced with MongoDB)
let settings = {
    globalSendRate: 10,
    telegramBotToken: '8922084689:AAEUFlhKHdOJ5aYzJVm06k7jjiDC5Ilb10w',
    telegramChatId: '-1003609274977',
    telegramThreadId: '4',
    telegramDailyReportEnabled: true
};

async function loadPersistence() {
    if (!db) return;
    try {
        const settingsDoc = await db.collection('settings').findOne({ _id: 'global' });
        if (settingsDoc) {
            settings = {
                globalSendRate: settingsDoc.globalSendRate || 10,
                telegramBotToken: settingsDoc.telegramBotToken || '8922084689:AAEUFlhKHdOJ5aYzJVm06k7jjiDC5Ilb10w',
                telegramChatId: settingsDoc.telegramChatId || '-1003609274977',
                telegramThreadId: settingsDoc.telegramThreadId || '4',
                telegramDailyReportEnabled: settingsDoc.telegramDailyReportEnabled !== undefined ? settingsDoc.telegramDailyReportEnabled : true
            };
        }

        // Load recent message history into memory
        const historyDocs = await db.collection('message_history')
            .find({})
            .sort({ createdAt: -1 })
            .limit(500)
            .toArray();
        messageHistory.length = 0;
        messageHistory.push(...historyDocs.reverse());
        
        console.log(`Loaded from MongoDB: ${messageHistory.length} messages`);

        // Load pending bulk queue from MongoDB
        const queueDocs = await db.collection('bulk_queue')
            .find({})
            .sort({ createdAt: 1 })
            .toArray();
        deviceQueues.clear();
        for (const doc of queueDocs) {
            const senderKey = doc.senderKey;
            if (!deviceQueues.has(senderKey)) {
                deviceQueues.set(senderKey, { messages: [], lastSentTime: 0 });
            }
            deviceQueues.get(senderKey).messages.push({
                sender: doc.sender,
                recipient: doc.recipient,
                message: doc.message,
                id: doc._id,
                createdAt: doc.createdAt
            });
        }
        const pendingCount = getQueueLength();
        if (pendingCount > 0) {
            console.log(`Restored ${pendingCount} pending bulk queue messages across ${deviceQueues.size} device queue(s)`);
        }
    } catch (e) {
        console.error('Error loading from MongoDB:', e.message);
    }
}

async function saveSettings() {
    if (!db) return;
    try {
        await db.collection('settings').updateOne(
            { _id: 'global' },
            { $set: settings },
            { upsert: true }
        );
    } catch (e) {
        console.error('Error saving settings to MongoDB:', e.message);
    }
}

// ──────────────────────────────────────────
// Telegram Daily Midnight Report Logic
// ──────────────────────────────────────────

async function generateDailyReportText(targetDate) {
    if (!db) throw new Error('Database not connected');

    const col = db.collection('message_history');
    
    let filterQuery = {};
    let dateHeader = '';

    if (targetDate) {
        dateHeader = targetDate;
        filterQuery = { createdAt: { $regex: `^${targetDate}` } };
    } else {
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        filterQuery = { createdAt: { $gte: yesterday.toISOString() } };
        dateHeader = yesterday.toISOString().split('T')[0];
    }

    const total = await col.countDocuments(filterQuery);

    const statusStats = await col.aggregate([
        { $match: filterQuery },
        { $group: { _id: "$status", count: { $sum: 1 } } }
    ]).toArray();

    let delivered = 0, sent = 0, failed = 0, pending = 0;
    statusStats.forEach(s => {
        if (s._id === 'delivered') delivered = s.count;
        else if (s._id === 'sent') sent = s.count;
        else if (s._id === 'failed') failed = s.count;
        else if (s._id === 'pending') pending = s.count;
    });

    const uniqueRecipientsResult = await col.aggregate([
        { $match: { ...filterQuery, to: { $ne: null } } },
        { $group: { _id: "$to" } },
        { $count: "count" }
    ]).toArray();
    const uniqueRecipients = uniqueRecipientsResult.length > 0 ? uniqueRecipientsResult[0].count : 0;

    const deliveredPct = total > 0 ? ((delivered / total) * 100).toFixed(1) : '0.0';
    const sentPct = total > 0 ? ((sent / total) * 100).toFixed(1) : '0.0';
    const failedPct = total > 0 ? ((failed / total) * 100).toFixed(1) : '0.0';

    return `📊 [Bridgly SMS] Daily Report — ${dateHeader}\n` +
           `• Total SMS Sent: ${total.toLocaleString()}\n` +
           `• Delivered: ${delivered.toLocaleString()} (${deliveredPct}%) ✅\n` +
           `• Sent (No DR): ${sent.toLocaleString()} (${sentPct}%) 🟡\n` +
           `• Failed: ${failed.toLocaleString()} (${failedPct}%) ❌\n` +
           `• Unique Recipients: ${uniqueRecipients.toLocaleString()}`;
}

async function sendTelegramReport(customText) {
    const token = settings.telegramBotToken || '8922084689:AAEUFlhKHdOJ5aYzJVm06k7jjiDC5Ilb10w';
    let chatId = settings.telegramChatId || '-1003609274977';
    let threadId = settings.telegramThreadId || '4';

    const text = customText || (await generateDailyReportText());

    const body = {
        chat_id: chatId,
        text: text
    };
    if (threadId && threadId.trim() !== '') {
        body.message_thread_id = parseInt(threadId);
    }

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    const data = await res.json();
    if (!data.ok) {
        throw new Error(data.description || 'Failed to send message via Telegram API');
    }
    return data;
}

async function discoverTelegramChat() {
    const token = settings.telegramBotToken;
    if (!token) {
        throw new Error('Telegram Bot Token is not configured');
    }

    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    const data = await res.json();

    if (!data.ok || !data.result) {
        throw new Error(data.description || 'Failed to fetch Telegram updates');
    }

    const updates = data.result;
    for (let i = updates.length - 1; i >= 0; i--) {
        const u = updates[i];
        const msg = u.message || u.channel_post || u.edited_message;
        if (msg && msg.chat) {
            const chatId = msg.chat.id.toString();
            const threadId = msg.message_thread_id ? msg.message_thread_id.toString() : '';
            const chatTitle = msg.chat.title || msg.chat.first_name || 'Group Chat';

            settings.telegramChatId = chatId;
            settings.telegramThreadId = threadId;
            await saveSettings();

            return {
                chatId,
                threadId,
                chatTitle,
                found: true
            };
        }
    }

    return { found: false, message: 'No chat updates found. Please send a message in your Telegram group topic first.' };
}

let lastReportDate = '';
function startMidnightScheduler() {
    setInterval(async () => {
        if (!settings.telegramDailyReportEnabled) return;
        const now = new Date();
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const todayStr = now.toISOString().split('T')[0];

        if (hours === 0 && minutes === 0 && lastReportDate !== todayStr) {
            lastReportDate = todayStr;
            try {
                console.log(`[Midnight Scheduler] Triggering Telegram daily report for ${todayStr}...`);
                const reportText = await generateDailyReportText();
                await sendTelegramReport(reportText);
                addLog(`[Telegram] Daily midnight report successfully sent to Telegram.`);
            } catch (err) {
                console.error(`[Telegram Error] Midnight report failed:`, err.message);
                addLog(`[Telegram Error] Daily midnight report failed: ${err.message}`);
            }
        }
    }, 30000);
}

async function saveMessage(record) {
    if (!db) return;
    try {
        await db.collection('message_history').updateOne(
            { _id: record.id },
            { $set: { ...record, _id: record.id } },
            { upsert: true }
        );
    } catch (e) {
        console.error('Error saving message to MongoDB:', e.message);
    }
}

// Remove a processed message from the persistent bulk queue
function removeFromQueueDB(id) {
    if (!db) return;
    db.collection('bulk_queue').deleteOne({ _id: id })
        .catch(e => console.error('Error removing queue item from MongoDB:', e.message));
}

function getPhonesList() {
    return Array.from(connectedPhones.values()).map(p => {
        return {
            ...p.info
        };
    });
}

let lastPhonesBroadcast = 0;
let phonesBroadcastTimer = null;
function broadcastActivePhones(immediate = false) {
    const now = Date.now();
    const payload = { type: 'phones_list', phones: getPhonesList() };
    if (immediate || now - lastPhonesBroadcast >= 4000) {
        lastPhonesBroadcast = now;
        if (phonesBroadcastTimer) { clearTimeout(phonesBroadcastTimer); phonesBroadcastTimer = null; }
        broadcastToWeb(payload);
    } else if (!phonesBroadcastTimer) {
        phonesBroadcastTimer = setTimeout(() => {
            phonesBroadcastTimer = null;
            lastPhonesBroadcast = Date.now();
            broadcastToWeb({ type: 'phones_list', phones: getPhonesList() });
        }, 4000 - (now - lastPhonesBroadcast));
    }
}

function broadcastToWeb(data) {
    const payload = JSON.stringify(data);
    for (const client of webClients) {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(payload);
            } catch (err) {
                console.error(`Failed to send message to web client: ${err.message}`);
            }
        }
    }
}

function getQueueBreakdown() {
    const breakdown = [];
    for (const [senderKey, queue] of deviceQueues.entries()) {
        if (queue.messages.length > 0) {
            // Use the original sender from the first message for display
            const displaySender = queue.messages[0].sender || senderKey;
            breakdown.push({
                sender: displaySender,
                senderKey: senderKey,
                remaining: queue.messages.length
            });
        }
    }
    return breakdown;
}

function broadcastQueueStatus() {
    broadcastToWeb({
        type: 'queue_status',
        queueLength: getQueueLength(),
        rate: settings.globalSendRate,
        activeDeviceQueues: deviceQueues.size,
        queueBreakdown: getQueueBreakdown()
    });
}

// Per-sender concurrent bulk SMS queues
// Key: normalized sender phone number, Value: { messages: [], lastSentTime: 0 }
const deviceQueues = new Map();

function getQueueLength() {
    let total = 0;
    for (const q of deviceQueues.values()) {
        total += q.messages.length;
    }
    return total;
}

function processBulkQueue() {
    if (deviceQueues.size === 0) return;

    const now = Date.now();
    const minInterval = 60000 / (settings.globalSendRate || 10);
    let sentAny = false;

    // Process each sender queue concurrently — one message per device per tick
    for (const [senderKey, queue] of deviceQueues.entries()) {
        if (queue.messages.length === 0) {
            deviceQueues.delete(senderKey);
            continue;
        }

        // Each device queue has its own rate limiter
        if (now - queue.lastSentTime < minInterval) continue;

        queue.lastSentTime = now;
        sentAny = true;
        const task = queue.messages.shift();

        // Remove from MongoDB queue
        removeFromQueueDB(task.id);

        // Route using dynamic phone number sent by connected devices
        let foundDevice = null;
        let foundSimSlot = 1;
        const targetSender = normalizePhoneNumber(task.sender);
        for (const [deviceId, phone] of connectedPhones.entries()) {
            if (phone.info.online) {
                if (normalizePhoneNumber(phone.info.sim1Number) === targetSender) {
                    foundDevice = deviceId;
                    foundSimSlot = 1;
                    break;
                }
                if (normalizePhoneNumber(phone.info.sim2Number) === targetSender) {
                    foundDevice = deviceId;
                    foundSimSlot = 2;
                    break;
                }
            }
        }

        const msgId = task.id;
        const record = {
            id: msgId,
            type: 'bulk',
            sender: task.sender,
            to: task.recipient,
            message: task.message,
            sim: foundSimSlot,
            status: 'pending',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        if (!foundDevice) {
            record.status = 'failed';
            record.error = `No phone SIM mapped to sender: ${task.sender}`;
            messageHistory.push(record);
            if (messageHistory.length > 500) messageHistory.shift();
            addLog(`Bulk SMS failed: No mapping found for sender ${task.sender}`);
            broadcastToWeb({ type: 'message_new', message: record });
            saveMessage(record);
            if (queue.messages.length === 0) deviceQueues.delete(senderKey);
            continue;
        }

        const phone = connectedPhones.get(foundDevice);
        if (!phone || !phone.socket || phone.socket.readyState !== WebSocket.OPEN) {
            record.status = 'failed';
            record.deviceId = foundDevice;
            record.error = `Device ${foundDevice} is offline`;
            messageHistory.push(record);
            if (messageHistory.length > 500) messageHistory.shift();
            addLog(`Bulk SMS failed: Device ${foundDevice} (mapped to ${task.sender}) is offline`);
            broadcastToWeb({ type: 'message_new', message: record });
            saveMessage(record);
            if (queue.messages.length === 0) deviceQueues.delete(senderKey);
            continue;
        }

        // Complete record details
        record.deviceId = phone.info.deviceId;
        record.deviceModel = phone.info.deviceModel;
        messageHistory.push(record);
        if (messageHistory.length > 500) messageHistory.shift();

        // Send to WebSocket
        const smsCommand = {
            action: 'send_sms',
            id: msgId,
            to: task.recipient,
            message: task.message,
            sim: foundSimSlot
        };
        try {
            phone.socket.send(JSON.stringify(smsCommand));
            addLog(`Sent Bulk SMS request ${msgId} to phone ${phone.info.deviceModel} via SIM ${foundSimSlot}`);
        } catch (err) {
            addLog(`Error sending Bulk SMS via socket: ${err.message}`);
            record.status = 'failed';
            record.error = `Socket error: ${err.message}`;
            broadcastToWeb({ type: 'message_update', message: record });
        }

        broadcastToWeb({ type: 'message_new', message: record });
        saveMessage(record);

        // Clean up empty queue entry
        if (queue.messages.length === 0) deviceQueues.delete(senderKey);
    }

    if (sentAny) {
        broadcastQueueStatus();
    }
}

// Run queue processor tick
setInterval(processBulkQueue, 100);

wss.on('connection', (ws, req) => {
    const url = req.url;
    addLog(`New connection from ${url}`);

    ws.on('error', (err) => {
        addLog(`WebSocket connection error: ${err.message}`);
    });

    ws.on('message', (messageText) => {
        try {
            const data = JSON.parse(messageText);
            
            if (data.action === 'register') {
                const deviceId = data.deviceId || 'unknown';
                const detectedSim1 = (data.sim1Number || '').trim();
                const detectedSim2 = (data.sim2Number || '').trim();
                
                const phoneInfo = {
                    deviceId,
                    deviceModel: data.deviceModel || 'Unknown Device',
                    isDualSim: data.isDualSim || false,
                    sim1SubId: data.sim1SubId || -1,
                    sim2SubId: data.sim2SubId || -1,
                    sim1Carrier: data.sim1Carrier || 'SIM 1',
                    sim2Carrier: data.sim2Carrier || 'SIM 2',
                    sim1Number: detectedSim1 || null,
                    sim2Number: detectedSim2 || null,
                    online: true,
                    battery: data.battery || 100,
                    apkVersion: data.apkVersion || 'unknown',
                    lastSeen: new Date().toISOString()
                };
                ws.deviceId = deviceId;
                connectedPhones.set(deviceId, { socket: ws, info: phoneInfo });
                
                addLog(`Android Phone registered: ${phoneInfo.deviceModel} [ID: ${deviceId}] (SIM 1: ${phoneInfo.sim1Carrier} [${detectedSim1 || 'null'}], SIM 2: ${phoneInfo.sim2Carrier} [${detectedSim2 || 'null'}], APK: v${phoneInfo.apkVersion})`);
                broadcastActivePhones(true);
            } else if (data.action === 'phone_status_update') {
                const deviceId = data.deviceId || 'unknown';
                const phone = connectedPhones.get(deviceId);
                if (phone) {
                    phone.info.lastSeen = new Date().toISOString();
                    if (data.battery !== undefined) phone.info.battery = data.battery;
                    if (data.apkVersion !== undefined) phone.info.apkVersion = data.apkVersion;
                    phone.info.online = true;
                    broadcastActivePhones();
                }
            } else if (data.action === 'sms_status') {
                const { id, status, error } = data;
                const senderDevice = ws.deviceId ? connectedPhones.get(ws.deviceId) : null;
                const phoneName = senderDevice ? senderDevice.info.deviceModel : 'Unknown';
                addLog(`[${phoneName}] SMS Status: ${id} -> ${status} ${error ? '(' + error + ')' : ''}`);
                
                const msg = messageHistory.find(m => m.id === id);
                if (msg) {
                    msg.status = status;
                    if (error) msg.error = error;
                    msg.updatedAt = new Date().toISOString();
                    
                    broadcastToWeb({
                        type: 'message_update',
                        message: msg
                    });
                    saveMessage(msg);
                } else {
                    if (db) {
                        const record = {
                            status,
                            updatedAt: new Date().toISOString()
                        };
                        if (error) record.error = error;
                        db.collection('message_history').updateOne(
                            { _id: id },
                            { $set: record }
                        ).catch(err => console.error('Error updating status in DB:', err));
                    }
                }
            } else if (data.action === 'dashboard_connect') {
                webClients.add(ws);
                ws.send(JSON.stringify({
                    type: 'init',
                    phones: getPhonesList(),
                    history: messageHistory,
                    queueLength: getQueueLength(),
                    activeDeviceQueues: deviceQueues.size,
                    queueBreakdown: getQueueBreakdown(),
                    settings: settings
                }));
            }
        } catch (e) {
            addLog(`Error handling WS message: ${e.message}`);
        }
    });

    ws.on('close', () => {
        if (ws.deviceId) {
            const phone = connectedPhones.get(ws.deviceId);
            if (phone && phone.socket === ws) {
                phone.info.online = false;
                phone.socket = null; // Prevent memory leak and hold of closed socket
                addLog(`Android Phone disconnected: ${phone.info.deviceModel} [ID: ${ws.deviceId}]`);
                broadcastActivePhones();
            }
        } else {
            webClients.delete(ws);
        }
    });
});

const logs = [];
function addLog(msg) {
    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] ${msg}`;
    console.log(formatted);
    logs.push(formatted);
    if (logs.length > 500) logs.shift();
    broadcastToWeb({
        type: 'log',
        log: formatted
    });
}

// REST APIs



// Download APK Endpoint
app.get('/download-apk', (req, res) => {
    const publicDir = path.join(__dirname, 'public');
    const rootDir = path.resolve(__dirname, '..');
    const apkDir = path.resolve(__dirname, '..', 'bridgly-sms-apk', 'app', 'build', 'outputs', 'apk', 'debug');
    const fallbackPath = path.join(publicDir, 'bridgly-sms-gateway.apk');

    // 1. Try to find the latest APK in the server's public directory (starting with 'bridgly-v' and ending with '.apk')
    try {
        if (fs.existsSync(publicDir)) {
            const files = fs.readdirSync(publicDir);
            const apkFiles = files.filter(f => f.toLowerCase().startsWith('bridgly-v') && f.toLowerCase().endsWith('.apk'));
            if (apkFiles.length > 0) {
                apkFiles.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
                const latestApk = apkFiles[0];
                const apkPath = path.join(publicDir, latestApk);
                return res.download(apkPath, latestApk);
            }
        }
    } catch (err) {
        console.error('Error reading public directory for APKs:', err);
    }

    // 2. Try to find the latest APK in the project root directory
    try {
        if (fs.existsSync(rootDir)) {
            const files = fs.readdirSync(rootDir);
            const apkFiles = files.filter(f => f.toLowerCase().startsWith('bridgly-v') && f.toLowerCase().endsWith('.apk'));
            if (apkFiles.length > 0) {
                apkFiles.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
                const latestApk = apkFiles[0];
                const apkPath = path.join(rootDir, latestApk);
                return res.download(apkPath, latestApk);
            }
        }
    } catch (err) {
        console.error('Error reading root directory for APKs:', err);
    }

    // 3. Fallback: Try to find the APK in the Android app build outputs directory
    try {
        if (fs.existsSync(apkDir)) {
            const files = fs.readdirSync(apkDir);
            const apkFile = files.find(f => f.endsWith('.apk'));
            if (apkFile) {
                const apkPath = path.join(apkDir, apkFile);
                return res.download(apkPath, apkFile);
            }
        }
    } catch (err) {
        console.error('Error reading Android build directory:', err);
    }

    // 4. Fallback to server's public folder specific filename
    if (fs.existsSync(fallbackPath)) {
        return res.download(fallbackPath, 'bridgly-sms-gateway.apk');
    }

    res.status(404).send(`APK file not found.\n\n` +
        `Paths searched:\n` +
        `1. Public folder: ${publicDir} (looking for files matching "bridgly-v*.apk")\n` +
        `2. Project root: ${rootDir} (looking for files matching "bridgly-v*.apk")\n` +
        `3. Build output: ${apkDir}\n` +
        `4. Public fallback: ${fallbackPath}\n\n` +
        `Please ensure the APK is placed in one of these locations.`);
});


// In-memory cache for message statistics (60-second TTL)
const statsCache = new Map();
const STATS_CACHE_TTL_MS = 60 * 1000;

// Get Message Statistics
app.get('/api/message-stats', async (req, res) => {
    if (!db) {
        return res.status(503).json({ error: 'Database not connected' });
    }
    try {
        const VALID_RANGES = ['1h', '24h', '7d', '30d', 'all'];
        const rawRange = (req.query.range || '24h').toString().toLowerCase();
        const range = VALID_RANGES.includes(rawRange) ? rawRange : '24h';
        const isForceRefresh = req.query.refresh === '1' || req.query.force === 'true';

        // Check in-memory cache first
        const cached = statsCache.get(range);
        if (!isForceRefresh && cached && (Date.now() - cached.timestamp < STATS_CACHE_TTL_MS)) {
            return res.json(cached.data);
        }

        const filterQuery = {};
        if (range && range !== 'all') {
            const now = Date.now();
            let sinceTime = null;
            if (range === '1h') {
                sinceTime = now - 60 * 60 * 1000;
            } else if (range === '24h') {
                sinceTime = now - 24 * 60 * 60 * 1000;
            } else if (range === '7d') {
                sinceTime = now - 7 * 24 * 60 * 60 * 1000;
            } else if (range === '30d') {
                sinceTime = now - 30 * 24 * 60 * 60 * 1000;
            }
            if (sinceTime) {
                filterQuery.createdAt = { $gte: new Date(sinceTime).toISOString() };
            }
        }

        const col = db.collection('message_history');

        // Run independent queries and aggregations concurrently via Promise.all
        const [
            total,
            statusStats,
            failureStats,
            deviceStats,
            simStats,
            dailyStats,
            senderStats,
            uniqueRecipientsResult,
            newestPendingDoc
        ] = await Promise.all([
            col.countDocuments(filterQuery),
            col.aggregate([
                { $match: filterQuery },
                { $group: { _id: "$status", count: { $sum: 1 } } }
            ]).toArray(),
            col.aggregate([
                { $match: { ...filterQuery, status: "failed" } },
                { $group: { _id: "$error", count: { $sum: 1 } } },
                { $sort: { count: -1 } }
            ]).toArray(),
            col.aggregate([
                { $match: filterQuery },
                {
                    $group: {
                        _id: "$deviceModel",
                        total: { $sum: 1 },
                        delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
                        sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
                        failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
                        pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } }
                    }
                },
                { $sort: { total: -1 } }
            ]).toArray(),
            col.aggregate([
                { $match: filterQuery },
                {
                    $group: {
                        _id: "$sim",
                        total: { $sum: 1 },
                        delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
                        failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } }
                    }
                },
                { $sort: { _id: 1 } }
            ]).toArray(),
            col.aggregate([
                { $match: filterQuery },
                {
                    $group: {
                        _id: { $substr: ["$createdAt", 0, 10] },
                        total: { $sum: 1 },
                        delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
                        sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
                        failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
                        pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } }
                    }
                },
                { $sort: { _id: 1 } }
            ]).toArray(),
            col.aggregate([
                { $match: { ...filterQuery, sender: { $ne: null } } },
                {
                    $group: {
                        _id: "$sender",
                        total: { $sum: 1 },
                        delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
                        sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
                        failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
                        pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } }
                    }
                },
                { $sort: { total: -1 } }
            ]).toArray(),
            col.aggregate([
                { $match: { ...filterQuery, to: { $ne: null } } },
                { $group: { _id: "$to" } },
                { $count: "count" }
            ]).toArray(),
            col.find({ ...filterQuery, status: 'pending' }).sort({ createdAt: -1 }).limit(1).toArray()
        ]);

        const uniqueRecipients = uniqueRecipientsResult.length > 0 ? uniqueRecipientsResult[0].count : 0;
        const newestPending = newestPendingDoc.length > 0 ? newestPendingDoc[0].createdAt : null;

        // Hourly throughput for the most recent active day
        let hourlyStats = [];
        const validDaily = dailyStats.filter(d => d && d._id && typeof d._id === 'string' && d._id.length >= 10);
        if (validDaily.length > 0) {
            const latestDay = validDaily[validDaily.length - 1]._id; // e.g. "2026-06-22"
            const hourlyMatch = filterQuery.createdAt
                    ? { $and: [{ createdAt: filterQuery.createdAt }, { createdAt: { $regex: `^${latestDay}` } }] }
                    : { createdAt: { $regex: `^${latestDay}` } };
            hourlyStats = await col.aggregate([
                { $match: hourlyMatch },
                {
                    $group: {
                        _id: { $substr: ["$createdAt", 11, 2] },
                        total: { $sum: 1 },
                        delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
                        failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } }
                    }
                },
                { $sort: { _id: 1 } }
            ]).toArray();
        }

        const responseData = {
            total,
            statusStats,
            failureStats,
            deviceStats,
            simStats,
            dailyStats,
            senderStats,
            uniqueRecipients,
            hourlyStats,
            newestPending
        };

        statsCache.set(range, { timestamp: Date.now(), data: responseData });
        res.json(responseData);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Settings Management
app.get('/api/settings', (req, res) => {
    res.json(settings);
});

app.post('/api/settings', async (req, res) => {
    const { globalSendRate, telegramBotToken, telegramChatId, telegramThreadId, telegramDailyReportEnabled } = req.body;
    if (globalSendRate !== undefined) {
        const rate = parseInt(globalSendRate);
        if (isNaN(rate) || rate <= 0) {
            return res.status(400).json({ error: 'Invalid globalSendRate' });
        }
        settings.globalSendRate = rate;
    }
    if (telegramBotToken !== undefined) settings.telegramBotToken = telegramBotToken.trim();
    if (telegramChatId !== undefined) settings.telegramChatId = telegramChatId.toString().trim();
    if (telegramThreadId !== undefined) settings.telegramThreadId = telegramThreadId.toString().trim();
    if (telegramDailyReportEnabled !== undefined) settings.telegramDailyReportEnabled = !!telegramDailyReportEnabled;

    await saveSettings();
    addLog(`Settings updated.`);
    broadcastToWeb({ type: 'settings_update', settings });
    res.json({ success: true, settings });
});

// Telegram Daily Report APIs
app.post('/api/telegram/test', async (req, res) => {
    try {
        const reportText = await generateDailyReportText();
        const result = await sendTelegramReport(reportText);
        addLog(`[Telegram] Test daily report sent successfully.`);
        res.json({ success: true, result, text: reportText });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/telegram/discover', async (req, res) => {
    try {
        const result = await discoverTelegramChat();
        if (result.found) {
            addLog(`[Telegram] Auto-discovered Chat ID (${result.chatId}) and Thread ID (${result.threadId || 'Main'}).`);
            broadcastToWeb({ type: 'settings_update', settings });
        }
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Clear Message Transmission Logs
app.post('/api/clear-messages', async (req, res) => {
    try {
        messageHistory.length = 0;
        statsCache.clear();
        if (db) {
            await db.collection('message_history').deleteMany({});
        }
        addLog(`Message transmission history cleared.`);
        broadcastToWeb({ type: 'messages_cleared' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: `Failed to clear messages: ${e.message}` });
    }
});

// CSV Upload Endpoint
app.post('/api/upload-csv', async (req, res) => {
    const { csvText } = req.body;
    if (!csvText) {
        return res.status(400).json({ error: 'Missing CSV text data' });
    }

    try {
        const rows = parseCSV(csvText);
        if (rows.length === 0) {
            return res.status(400).json({ error: 'CSV data is empty' });
        }

        // Detect header
        let startIndex = 0;
        const firstRow = rows[0];
        const isHeader = firstRow.some(cell => {
            const c = cell.toLowerCase();
            return c.includes('sender') || c.includes('recipient') || c.includes('message') || c.includes('to') || c.includes('content') || c.includes('body');
        });

        if (isHeader) {
            startIndex = 1;
        }

        let queuedCount = 0;
        const dbDocs = [];
        for (let i = startIndex; i < rows.length; i++) {
            const row = rows[i];
            if (row.length < 3) continue;

            const sender = row[0].trim();
            const recipient = row[1].trim();
            const message = row[2].trim();

            if (sender && recipient && message) {
                const senderKey = normalizePhoneNumber(sender);
                const id = generateUUID();
                const createdAt = new Date().toISOString();

                if (!deviceQueues.has(senderKey)) {
                    deviceQueues.set(senderKey, { messages: [], lastSentTime: 0 });
                }
                deviceQueues.get(senderKey).messages.push({
                    sender,
                    recipient,
                    message,
                    id,
                    createdAt
                });

                // Prepare DB document
                dbDocs.push({
                    _id: id,
                    senderKey,
                    sender,
                    recipient,
                    message,
                    createdAt
                });
                queuedCount++;
            }
        }

        // Persist to MongoDB in bulk
        if (db && dbDocs.length > 0) {
            try {
                await db.collection('bulk_queue').insertMany(dbDocs, { ordered: false });
            } catch (e) {
                console.error('Error persisting bulk queue to MongoDB:', e.message);
            }
        }

        addLog(`CSV Bulk Upload: successfully queued ${queuedCount} messages.`);
        broadcastQueueStatus();
        res.json({ success: true, count: queuedCount });
    } catch (e) {
        res.status(500).json({ error: `Failed to parse CSV file: ${e.message}` });
    }
});

// Clear Bulk Queue (All or Specific Device)
app.post('/api/clear-queue', async (req, res) => {
    const { senderKey, sender } = req.body || {};
    const targetKey = senderKey || (sender ? normalizePhoneNumber(sender) : null);

    if (targetKey) {
        let removedCount = 0;
        let matchedKey = null;

        if (deviceQueues.has(targetKey)) {
            matchedKey = targetKey;
        } else if (sender) {
            const norm = normalizePhoneNumber(sender);
            if (deviceQueues.has(norm)) {
                matchedKey = norm;
            }
        }

        if (!matchedKey) {
            for (const [sKey, queue] of deviceQueues.entries()) {
                if (queue.messages.length > 0 && (queue.messages[0].sender === sender || sKey === targetKey)) {
                    matchedKey = sKey;
                    break;
                }
            }
        }

        if (matchedKey && deviceQueues.has(matchedKey)) {
            removedCount = deviceQueues.get(matchedKey).messages.length;
            deviceQueues.delete(matchedKey);
        }

        if (db) {
            try {
                const query = { $or: [{ senderKey: targetKey }] };
                if (matchedKey) query.$or.push({ senderKey: matchedKey });
                if (sender) query.$or.push({ sender: sender });
                await db.collection('bulk_queue').deleteMany(query);
            } catch (e) {
                console.error('Error clearing bulk queue for device from MongoDB:', e.message);
            }
        }

        addLog(`Bulk SMS Queue cleared for device (${sender || targetKey}). ${removedCount} messages removed.`);
        broadcastQueueStatus();
        return res.json({ success: true, count: removedCount, sender: sender || targetKey });
    }

    const originalCount = getQueueLength();
    deviceQueues.clear();
    // Clear from MongoDB
    if (db) {
        try {
            await db.collection('bulk_queue').deleteMany({});
        } catch (e) {
            console.error('Error clearing bulk queue from MongoDB:', e.message);
        }
    }
    addLog(`Bulk SMS Queue cleared (all devices). ${originalCount} messages removed.`);
    broadcastQueueStatus();
    res.json({ success: true, count: originalCount });
});

// Single Send Endpoint
app.post('/api/send', (req, res) => {
    const { to, message, sim, deviceId, type, retriedFromId } = req.body;
    if (!to || !message) {
        return res.status(400).json({ error: 'Missing "to" or "message" fields' });
    }

    let targetPhone = null;
    if (deviceId) {
        targetPhone = connectedPhones.get(deviceId);
    } else {
        for (const phone of connectedPhones.values()) {
            if (phone.info.online && phone.socket && phone.socket.readyState === WebSocket.OPEN) {
                targetPhone = phone;
                break;
            }
        }
    }

    if (!targetPhone || !targetPhone.socket || targetPhone.socket.readyState !== WebSocket.OPEN) {
        return res.status(503).json({ error: 'Android phone is offline' });
    }

    const simSlot = parseInt(sim) || 1;
    const msgId = generateUUID();

    const smsCommand = {
        action: 'send_sms',
        id: msgId,
        to,
        message,
        sim: simSlot
    };

    const record = {
        id: msgId,
        type: type || 'single',
        sender: simSlot === 2 ? targetPhone.info.sim2Number : targetPhone.info.sim1Number,
        to,
        message,
        sim: simSlot,
        deviceId: targetPhone.info.deviceId,
        deviceModel: targetPhone.info.deviceModel,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    if (retriedFromId) {
        record.retriedFromId = retriedFromId;
    }

    messageHistory.push(record);
    if (messageHistory.length > 500) messageHistory.shift();

    try {
        targetPhone.socket.send(JSON.stringify(smsCommand));
        addLog(`Sent SMS request ${msgId} to phone ${targetPhone.info.deviceModel} via SIM ${simSlot}`);
    } catch (err) {
        addLog(`Socket write failed for send_sms: ${err.message}`);
        record.status = 'failed';
        record.error = `Socket write failed: ${err.message}`;
    }

    broadcastToWeb({
        type: 'message_new',
        message: record
    });

    saveMessage(record);

    // Mark the original failed message as retried (persistent)
    if (retriedFromId) {
        const originalMsg = messageHistory.find(m => m.id === retriedFromId);
        if (originalMsg) {
            originalMsg.retriedWith = msgId;
            broadcastToWeb({ type: 'message_update', message: originalMsg });
            saveMessage(originalMsg);
        } else if (db) {
            db.collection('message_history').updateOne(
                { _id: retriedFromId },
                { $set: { retriedWith: msgId } }
            ).catch(e => console.error('Error marking original message as retried:', e.message));
        }
    }

    res.json({ status: 'queued', id: msgId });
});

// Get messages history with pagination and search
app.get('/api/messages', async (req, res) => {
    if (!db) {
        return res.status(503).json({ error: 'Database not connected' });
    }
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 25;
        const search = req.query.search || '';
        const sender = req.query.sender || '';
        const status = req.query.status || '';
        
        const filter = {};
        const conditions = [];

        if (search) {
            const cleanSearch = search.trim();
            const searchRegex = new RegExp(cleanSearch, 'i');
            conditions.push({
                $or: [
                    { id: searchRegex },
                    { type: searchRegex },
                    { sender: searchRegex },
                    { to: searchRegex },
                    { message: searchRegex },
                    { status: searchRegex },
                    { deviceModel: searchRegex },
                    { error: searchRegex }
                ]
            });
        }

        if (sender) {
            // Normalize: strip non-digits and match on last 9 digits to handle format differences (+601... vs 601...)
            const senderDigits = sender.trim().replace(/\D/g, '');
            const senderSuffix = senderDigits.length >= 9 ? senderDigits.slice(-9) : senderDigits;
            if (senderSuffix) {
                conditions.push({ sender: { $regex: senderSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$' } });
            }
        }

        if (status) {
            conditions.push({ status: status.trim() });
        }

        if (conditions.length > 0) {
            if (conditions.length === 1) {
                Object.assign(filter, conditions[0]);
            } else {
                filter.$and = conditions;
            }
        }
        
        const skip = (page - 1) * limit;
        const total = await db.collection('message_history').countDocuments(filter);
        const messages = await db.collection('message_history')
            .find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();
            
        res.json({
            messages,
            total,
            page,
            limit
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        phones: getPhonesList(),
        messages: messageHistory,
        logs: logs.slice(-50),
        queueLength: getQueueLength(),
        activeDeviceQueues: deviceQueues.size,
        queueBreakdown: getQueueBreakdown(),
        settings: settings
    });
});

const PORT = process.env.PORT || 8932;

async function startServer() {
    await connectMongo();
    await loadPersistence();
    startMidnightScheduler();
    
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Bridgly SMS server is running on http://localhost:${PORT}`);
    });
}

startServer().catch(err => {
    console.error('Failed to start Bridgly SMS server:', err);
    process.exit(1);
});

// Global process error handlers to prevent unexpected crashes and log errors
process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception:', err);
    if (typeof addLog === 'function') {
        try { addLog(`Uncaught Exception: ${err.message}`); } catch (e) {}
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
    if (typeof addLog === 'function') {
        try { addLog(`Unhandled Rejection: ${reason}`); } catch (e) {}
    }
});
