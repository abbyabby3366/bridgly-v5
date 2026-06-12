require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
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
        await db.collection('message_history').createIndex({ createdAt: -1 });
        await db.collection('message_history').createIndex({ status: 1 });
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
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const connectedPhones = new Map();
const messageHistory = [];
const webClients = new Set();

// In-memory state (synced with MongoDB)
let settings = { globalSendRate: 10 };

async function loadPersistence() {
    if (!db) return;
    try {
        const settingsDoc = await db.collection('settings').findOne({ _id: 'global' });
        if (settingsDoc) {
            settings = { globalSendRate: settingsDoc.globalSendRate || 10 };
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
    } catch (e) {
        console.error('Error loading from MongoDB:', e.message);
    }
}

async function saveSettings() {
    if (!db) return;
    try {
        await db.collection('settings').updateOne(
            { _id: 'global' },
            { $set: { globalSendRate: settings.globalSendRate } },
            { upsert: true }
        );
    } catch (e) {
        console.error('Error saving settings to MongoDB:', e.message);
    }
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
            client.send(payload);
        }
    }
}

function broadcastQueueStatus() {
    broadcastToWeb({
        type: 'queue_status',
        queueLength: bulkQueue.length,
        rate: settings.globalSendRate
    });
}

// Bulk SMS Send Queue
let bulkQueue = [];
let lastSentTime = 0;

function processBulkQueue() {
    if (bulkQueue.length === 0) return;

    const now = Date.now();
    const minInterval = 60000 / (settings.globalSendRate || 10);
    if (now - lastSentTime >= minInterval) {
        lastSentTime = now;
        const task = bulkQueue.shift();

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
            to: task.recipient,
            message: task.message,
            sim: foundSimSlot,
            status: 'pending',
            createdAt: task.createdAt,
            updatedAt: new Date().toISOString()
        };

        if (!foundDevice) {
            record.status = 'failed';
            record.error = `No phone SIM mapped to sender: ${task.sender}`;
            messageHistory.push(record);
            if (messageHistory.length > 500) messageHistory.shift();
            addLog(`Bulk SMS failed: No mapping found for sender ${task.sender}`);
            broadcastToWeb({ type: 'message_new', message: record });
            broadcastQueueStatus();
            saveMessage(record);
            return;
        }

        const phone = connectedPhones.get(foundDevice);
        if (!phone || phone.socket.readyState !== WebSocket.OPEN) {
            record.status = 'failed';
            record.deviceId = foundDevice;
            record.error = `Device ${foundDevice} is offline`;
            messageHistory.push(record);
            if (messageHistory.length > 500) messageHistory.shift();
            addLog(`Bulk SMS failed: Device ${foundDevice} (mapped to ${task.sender}) is offline`);
            broadcastToWeb({ type: 'message_new', message: record });
            broadcastQueueStatus();
            saveMessage(record);
            return;
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
        broadcastQueueStatus();
        saveMessage(record);
    }
}

// Run queue processor tick
setInterval(processBulkQueue, 100);

wss.on('connection', (ws, req) => {
    const url = req.url;
    addLog(`New connection from ${url}`);

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
                    lastSeen: new Date().toISOString()
                };
                ws.deviceId = deviceId;
                connectedPhones.set(deviceId, { socket: ws, info: phoneInfo });
                
                addLog(`Android Phone registered: ${phoneInfo.deviceModel} [ID: ${deviceId}] (SIM 1: ${phoneInfo.sim1Carrier} [${detectedSim1 || 'null'}], SIM 2: ${phoneInfo.sim2Carrier} [${detectedSim2 || 'null'}])`);
                broadcastActivePhones(true);
            } else if (data.action === 'phone_status_update') {
                const deviceId = data.deviceId || 'unknown';
                const phone = connectedPhones.get(deviceId);
                if (phone) {
                    phone.info.lastSeen = new Date().toISOString();
                    if (data.battery !== undefined) phone.info.battery = data.battery;
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
                    queueLength: bulkQueue.length,
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



// Settings Management
app.get('/api/settings', (req, res) => {
    res.json(settings);
});

app.post('/api/settings', (req, res) => {
    const { globalSendRate } = req.body;
    if (globalSendRate !== undefined) {
        const rate = parseInt(globalSendRate);
        if (isNaN(rate) || rate <= 0) {
            return res.status(400).json({ error: 'Invalid globalSendRate' });
        }
        settings.globalSendRate = rate;
        saveSettings();
        addLog(`Global sending rate updated to ${rate} msg/min`);
        broadcastToWeb({ type: 'settings_update', settings });
    }
    res.json({ success: true, settings });
});

// CSV Upload Endpoint
app.post('/api/upload-csv', (req, res) => {
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
        for (let i = startIndex; i < rows.length; i++) {
            const row = rows[i];
            if (row.length < 3) continue;

            const sender = row[0].trim();
            const recipient = row[1].trim();
            const message = row[2].trim();

            if (sender && recipient && message) {
                bulkQueue.push({
                    sender,
                    recipient,
                    message,
                    id: generateUUID(),
                    createdAt: new Date().toISOString()
                });
                queuedCount++;
            }
        }

        addLog(`CSV Bulk Upload: successfully queued ${queuedCount} messages.`);
        broadcastQueueStatus();
        res.json({ success: true, count: queuedCount });
    } catch (e) {
        res.status(500).json({ error: `Failed to parse CSV file: ${e.message}` });
    }
});

// Clear Bulk Queue
app.post('/api/clear-queue', (req, res) => {
    const originalCount = bulkQueue.length;
    bulkQueue = [];
    addLog(`Bulk SMS Queue cleared. ${originalCount} messages removed.`);
    broadcastQueueStatus();
    res.json({ success: true, count: originalCount });
});

// Single Send Endpoint
app.post('/api/send', (req, res) => {
    const { to, message, sim, deviceId } = req.body;
    if (!to || !message) {
        return res.status(400).json({ error: 'Missing "to" or "message" fields' });
    }

    let targetPhone = null;
    if (deviceId) {
        targetPhone = connectedPhones.get(deviceId);
    } else {
        for (const phone of connectedPhones.values()) {
            if (phone.info.online && phone.socket.readyState === WebSocket.OPEN) {
                targetPhone = phone;
                break;
            }
        }
    }

    if (!targetPhone || targetPhone.socket.readyState !== WebSocket.OPEN) {
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
        to,
        message,
        sim: simSlot,
        deviceId: targetPhone.info.deviceId,
        deviceModel: targetPhone.info.deviceModel,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

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
        
        const filter = {};
        if (search) {
            const cleanSearch = search.trim();
            const searchRegex = new RegExp(cleanSearch, 'i');
            filter.$or = [
                { id: searchRegex },
                { to: searchRegex },
                { message: searchRegex },
                { status: searchRegex },
                { deviceModel: searchRegex },
                { error: searchRegex }
            ];
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
        queueLength: bulkQueue.length,
        settings: settings
    });
});

const PORT = process.env.PORT || 8932;

async function startServer() {
    await connectMongo();
    await loadPersistence();
    
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Bridgly SMS server is running on http://0.0.0.0:${PORT}`);
    });
}

startServer().catch(err => {
    console.error('Failed to start Bridgly SMS server:', err);
    process.exit(1);
});
