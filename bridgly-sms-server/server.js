const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { crypto } = require('crypto');

// Generate unique message IDs
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let phoneSocket = null;
let phoneDetails = { online: false, isDualSim: false };
const messageHistory = [];
const webClients = new Set();

function broadcastToWeb(data) {
    const payload = JSON.stringify(data);
    for (const client of webClients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    }
}

wss.on('connection', (ws, req) => {
    // We can distinguish client type by URL or register action.
    // Let's assume standard clients send a register action or we check URL.
    const url = req.url;
    addLog(`New connection from ${url}`);

    ws.on('message', (messageText) => {
        try {
            const data = JSON.parse(messageText);
            
            if (data.action === 'register') {
                // Connection from the Android Phone
                phoneSocket = ws;
                phoneDetails = {
                    online: true,
                    isDualSim: data.isDualSim || false
                };
                addLog('Android Phone registered. Dual SIM: ' + phoneDetails.isDualSim);
                broadcastToWeb({
                    type: 'phone_status',
                    details: phoneDetails
                });
            } else if (data.action === 'sms_status') {
                // Update from the Android Phone
                const { id, status, error } = data;
                addLog(`SMS Status update: ${id} -> ${status} ${error ? '(' + error + ')' : ''}`);
                
                const msg = messageHistory.find(m => m.id === id);
                if (msg) {
                    msg.status = status;
                    if (error) msg.error = error;
                    msg.updatedAt = new Date().toISOString();
                    
                    broadcastToWeb({
                        type: 'message_update',
                        message: msg
                    });
                }
            } else if (data.action === 'dashboard_connect') {
                // Connection from the Web Dashboard
                webClients.add(ws);
                // Send current state
                ws.send(JSON.stringify({
                    type: 'init',
                    phone: phoneDetails,
                    history: messageHistory
                }));
            }
        } catch (e) {
            addLog(`Error handling WS message: ${e.message}`);
        }
    });

    ws.on('close', () => {
        if (ws === phoneSocket) {
            phoneSocket = null;
            phoneDetails = { online: false, isDualSim: false };
            addLog('Android Phone disconnected');
            broadcastToWeb({
                type: 'phone_status',
                details: phoneDetails
            });
        } else {
            webClients.delete(ws);
        }
    });
});

// Logs list for API/UI
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

// REST API endpoint to send SMS
app.post('/api/send', (req, res) => {
    const { to, message, sim } = req.body;
    if (!to || !message) {
        return res.status(400).json({ error: 'Missing "to" or "message" fields' });
    }

    if (!phoneSocket || phoneSocket.readyState !== WebSocket.OPEN) {
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
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    messageHistory.push(record);
    if (messageHistory.length > 500) messageHistory.shift();

    // Send command to phone
    phoneSocket.send(JSON.stringify(smsCommand));
    addLog(`Sent SMS request ${msgId} to phone via SIM ${simSlot}`);

    // Notify dashboards
    broadcastToWeb({
        type: 'message_new',
        message: record
    });

    res.json({ status: 'queued', id: msgId });
});

// REST API endpoint to get connection status and logs
app.get('/api/status', (req, res) => {
    res.json({
        phone: phoneDetails,
        messages: messageHistory,
        logs: logs.slice(-50)
    });
});

const PORT = process.env.PORT || 8932;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Bridgly SMS server is running on http://0.0.0.0:${PORT}`);
});
