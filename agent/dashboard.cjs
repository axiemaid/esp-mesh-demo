#!/usr/bin/env node
'use strict';

/**
 * ESP-NOW Mesh Dashboard — live web UI showing message relay and payments.
 * Also acts as the agent: listens on serial, relays messages, pays nodes.
 *
 * Usage: node dashboard.cjs
 * Open http://localhost:3010
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const PORT = parseInt(process.env.DASH_PORT || '3010');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const LOG_PATH = path.join(__dirname, 'mesh-log.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// --- State ---
const state = {
  nodes: {},       // mac → { name, role, bsv_address, lastSeen, online }
  messages: [],    // { id, text, hash, ts, userTxid?, status, from?, latency?, paymentTxid? }
  payments: [],    // { ts, node, mac, sats, txid }
  stats: { sent: 0, delivered: 0, failed: 0, totalPaid: 0 },
};

// Init nodes from config
for (const [mac, info] of Object.entries(config.nodes)) {
  state.nodes[mac] = { ...info, mac, lastSeen: null, online: false };
}

// Load existing log
if (fs.existsSync(LOG_PATH)) {
  try {
    const saved = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
    if (saved.messages) state.messages = saved.messages.slice(-200);
    if (saved.payments) state.payments = saved.payments.slice(-200);
    if (saved.stats) Object.assign(state.stats, saved.stats);
  } catch {}
}

function saveLog() {
  fs.writeFileSync(LOG_PATH, JSON.stringify({
    messages: state.messages.slice(-200),
    payments: state.payments.slice(-200),
    stats: state.stats,
  }, null, 2));
}

// --- SSE clients ---
const sseClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// --- Serial ---
let port = null;
let parser = null;

function connectSerial() {
  if (!config.serialPort) {
    console.log('⚠ No serial port configured');
    return;
  }

  try {
    port = new SerialPort({ path: config.serialPort, baudRate: config.baudRate || 115200 });
    parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

    port.on('open', () => {
      console.log(`✅ Serial: ${config.serialPort}`);
      state.nodes[Object.keys(config.nodes).find(m => config.nodes[m].role === 'gateway')] &&
        (state.nodes[Object.keys(config.nodes).find(m => config.nodes[m].role === 'gateway')].online = true);
      broadcast('node-update', state.nodes);
    });

    port.on('error', (err) => console.error(`Serial error: ${err.message}`));
    port.on('close', () => {
      console.log('Serial disconnected, reconnecting in 5s...');
      setTimeout(connectSerial, 5000);
    });

    parser.on('data', (line) => {
      line = line.trim();
      if (!line) return;

      // Try to parse as JSON confirmation from Node B
      try {
        const msg = JSON.parse(line);
        if (msg.status === 'delivered') {
          handleConfirmation(msg);
          return;
        }
        if (msg.error) {
          console.log(`ESP error: ${msg.error}`);
          broadcast('log', { ts: Date.now(), text: `ESP error: ${msg.error}` });
          return;
        }
      } catch {}

      // Non-JSON log line
      broadcast('log', { ts: Date.now(), text: line });
    });
  } catch (err) {
    console.error(`Serial connect failed: ${err.message}`);
    setTimeout(connectSerial, 5000);
  }
}

// --- Message handling ---
let pendingMessage = null;

function sendToMesh(text) {
  if (!port || !port.isOpen) throw new Error('Serial not connected');

  const id = crypto.randomUUID().slice(0, 8);
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  const payload = JSON.stringify({ id, data: text, ts: Date.now() });

  const msg = {
    id, text, hash, ts: Date.now(),
    status: 'sent', from: null, latency: null, paymentTxid: null,
  };

  state.messages.push(msg);
  state.stats.sent++;
  pendingMessage = msg;

  port.write(payload + '\n');
  broadcast('message', msg);
  broadcast('stats', state.stats);
  saveLog();

  return msg;
}

function handleConfirmation(confirmation) {
  const mac = confirmation.from;
  const now = Date.now();

  // Update node status
  if (state.nodes[mac]) {
    state.nodes[mac].lastSeen = now;
    state.nodes[mac].online = true;
    broadcast('node-update', state.nodes);
  }

  // Update pending message
  if (pendingMessage) {
    pendingMessage.status = 'delivered';
    pendingMessage.from = mac;
    pendingMessage.latency = confirmation.ms || null;
    state.stats.delivered++;
    broadcast('message-update', pendingMessage);
    broadcast('stats', state.stats);

    // Pay the relay node
    payNode(mac, 1000, pendingMessage.hash).then(txid => {
      if (txid) {
        pendingMessage.paymentTxid = txid;
        broadcast('message-update', pendingMessage);
        broadcast('payment', state.payments[state.payments.length - 1]);
      }
      saveLog();
    });

    pendingMessage = null;
  }
}

async function payNode(mac, sats, messageHash) {
  const node = state.nodes[mac];
  if (!node || !node.bsv_address) return null;

  try {
    const { execSync } = require('child_process');
    const bsvAmount = (sats / 1e8).toFixed(8);
    const skillDir = '/opt/homebrew/lib/node_modules/openclaw/skills/bsv/bsv-openclaw-skill';
    const result = execSync(
      `node ${skillDir}/scripts/wallet.cjs send ${node.bsv_address} ${bsvAmount}`,
      { encoding: 'utf8', timeout: 30000 }
    );

    const txidMatch = result.match(/TXID:\s*([a-f0-9]+)/i);
    const txid = txidMatch ? txidMatch[1] : null;

    const payment = { ts: Date.now(), node: node.name, mac, sats, txid };
    state.payments.push(payment);
    state.stats.totalPaid += sats;
    broadcast('stats', state.stats);

    console.log(`💰 Paid ${node.name}: ${sats} sats → ${txid?.slice(0, 12)}...`);
    return txid;
  } catch (err) {
    console.error(`Payment failed: ${err.message}`);
    return null;
  }
}

// --- HTML Dashboard ---
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ESP-NOW Mesh Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Fira Code', monospace; background: #0a0a0a; color: #e0e0e0; }
  .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 20px; color: #fff; margin-bottom: 20px; }
  h1 span { color: #4ade80; }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }

  .card { background: #111; border: 1px solid #222; border-radius: 12px; padding: 16px; }
  .card h2 { font-size: 13px; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }

  /* Stats */
  .stats { display: flex; gap: 24px; flex-wrap: wrap; }
  .stat { text-align: center; }
  .stat .value { font-size: 28px; font-weight: bold; color: #fff; }
  .stat .label { font-size: 11px; color: #666; margin-top: 2px; }
  .stat.green .value { color: #4ade80; }
  .stat.blue .value { color: #60a5fa; }
  .stat.yellow .value { color: #facc15; }

  /* Nodes */
  .node { display: flex; align-items: center; gap: 12px; padding: 10px; background: #1a1a1a; border-radius: 8px; margin-bottom: 8px; }
  .node .dot { width: 10px; height: 10px; border-radius: 50%; background: #333; flex-shrink: 0; }
  .node .dot.online { background: #4ade80; box-shadow: 0 0 6px #4ade80; }
  .node .name { font-weight: bold; color: #fff; font-size: 13px; }
  .node .mac { font-size: 11px; color: #555; }
  .node .role { font-size: 10px; color: #888; background: #222; padding: 2px 6px; border-radius: 4px; }

  /* Network viz */
  .network { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 20px 0; min-height: 80px; }
  .net-node { padding: 10px 16px; border-radius: 8px; text-align: center; font-size: 12px; font-weight: bold; }
  .net-node.gateway { background: #1a2a3a; color: #60a5fa; border: 1px solid #2a4a6a; }
  .net-node.relay { background: #1a3a1a; color: #4ade80; border: 1px solid #2a5a2a; }
  .net-node.agent { background: #2a1a3a; color: #c084fc; border: 1px solid #4a2a6a; }
  .net-link { color: #333; font-size: 20px; }
  .net-link.active { color: #4ade80; }

  /* Messages */
  .messages { max-height: 400px; overflow-y: auto; }
  .msg { padding: 10px; background: #1a1a1a; border-radius: 8px; margin-bottom: 6px; font-size: 12px; }
  .msg .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
  .msg .text { color: #ccc; }
  .msg .badge { font-size: 10px; padding: 2px 8px; border-radius: 4px; }
  .msg .badge.sent { background: #2a2a1a; color: #facc15; }
  .msg .badge.delivered { background: #1a3a1a; color: #4ade80; }
  .msg .badge.paid { background: #1a2a3a; color: #60a5fa; }
  .msg .meta { font-size: 10px; color: #555; margin-top: 4px; }
  .msg .meta a { color: #4a9eff; text-decoration: none; }

  /* Payments */
  .payments { max-height: 300px; overflow-y: auto; }
  .payment { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; background: #1a1a1a; border-radius: 8px; margin-bottom: 4px; font-size: 12px; }
  .payment .sats { color: #4ade80; font-weight: bold; }
  .payment a { color: #4a9eff; text-decoration: none; font-size: 11px; }

  /* Send bar */
  .send-bar { display: flex; gap: 12px; margin-bottom: 20px; }
  .send-bar input { flex: 1; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 12px 16px; color: #fff; font-family: inherit; font-size: 14px; outline: none; }
  .send-bar input:focus { border-color: #4a9eff; }
  .send-bar button { background: #4a9eff; color: #fff; border: none; border-radius: 8px; padding: 12px 24px; cursor: pointer; font-family: inherit; font-weight: bold; }
  .send-bar button:hover { background: #3a8fef; }
  .send-bar button:disabled { background: #333; cursor: not-allowed; }
</style>
</head>
<body>
<div class="container">
  <h1>📡 <span>ESP-NOW Mesh</span> Dashboard</h1>

  <div class="send-bar">
    <input type="text" id="msgInput" placeholder="Send a message through the mesh..." autocomplete="off" />
    <button id="sendBtn" onclick="sendMsg()">Send</button>
  </div>

  <div class="grid">
    <div class="card">
      <h2>📊 Stats</h2>
      <div class="stats">
        <div class="stat"><div class="value" id="s-sent">0</div><div class="label">Sent</div></div>
        <div class="stat green"><div class="value" id="s-delivered">0</div><div class="label">Delivered</div></div>
        <div class="stat blue"><div class="value" id="s-paid">0</div><div class="label">Sats Paid</div></div>
        <div class="stat yellow"><div class="value" id="s-failed">0</div><div class="label">Failed</div></div>
      </div>
    </div>

    <div class="card">
      <h2>🌐 Network</h2>
      <div class="network" id="network">
        <div class="net-node agent">🤖 Agent</div>
        <div class="net-link" id="link-serial">─ usb ─</div>
        <div class="net-node gateway">📡 Node A</div>
        <div class="net-link" id="link-espnow">┈ radio ┈</div>
        <div class="net-node relay">🔁 Node B</div>
      </div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>💬 Messages</h2>
      <div class="messages" id="messages"></div>
    </div>

    <div class="card">
      <h2>💰 Payments</h2>
      <div class="payments" id="payments"></div>
    </div>
  </div>

  <div class="card" style="margin-top:20px">
    <h2>🖥 Nodes</h2>
    <div id="nodes"></div>
  </div>
</div>

<script>
const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');

msgInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendMsg(); });

async function sendMsg() {
  const text = msgInput.value.trim();
  if (!text) return;
  sendBtn.disabled = true;
  msgInput.value = '';
  try {
    await fetch('/api/send', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({message: text}) });
  } catch(e) { console.error(e); }
  sendBtn.disabled = false;
  msgInput.focus();
}

// SSE
const es = new EventSource('/api/events');

es.addEventListener('message', e => {
  const msg = JSON.parse(e.data);
  addMessage(msg);
});

es.addEventListener('message-update', e => {
  const msg = JSON.parse(e.data);
  updateMessage(msg);
});

es.addEventListener('payment', e => {
  const p = JSON.parse(e.data);
  addPayment(p);
  flashLink('link-espnow');
});

es.addEventListener('stats', e => {
  const s = JSON.parse(e.data);
  document.getElementById('s-sent').textContent = s.sent;
  document.getElementById('s-delivered').textContent = s.delivered;
  document.getElementById('s-paid').textContent = s.totalPaid.toLocaleString();
  document.getElementById('s-failed').textContent = s.failed;
});

es.addEventListener('node-update', e => {
  const nodes = JSON.parse(e.data);
  renderNodes(nodes);
});

es.addEventListener('log', e => {
  // could show in a console panel
});

es.addEventListener('init', e => {
  const d = JSON.parse(e.data);
  document.getElementById('s-sent').textContent = d.stats.sent;
  document.getElementById('s-delivered').textContent = d.stats.delivered;
  document.getElementById('s-paid').textContent = d.stats.totalPaid.toLocaleString();
  document.getElementById('s-failed').textContent = d.stats.failed;
  renderNodes(d.nodes);
  for (const m of d.messages) addMessage(m);
  for (const p of d.payments) addPayment(p);
});

function addMessage(msg) {
  const el = document.createElement('div');
  el.className = 'msg';
  el.id = 'msg-' + msg.id;
  el.innerHTML = renderMsg(msg);
  const container = document.getElementById('messages');
  container.prepend(el);
  flashLink('link-serial');
}

function updateMessage(msg) {
  const el = document.getElementById('msg-' + msg.id);
  if (el) { el.innerHTML = renderMsg(msg); flashLink('link-espnow'); }
}

function renderMsg(msg) {
  const badge = msg.paymentTxid ? '<span class="badge paid">💰 paid</span>' :
                msg.status === 'delivered' ? '<span class="badge delivered">✅ delivered</span>' :
                '<span class="badge sent">📨 sent</span>';
  const time = new Date(msg.ts).toLocaleTimeString();
  let meta = msg.hash ? 'hash: ' + msg.hash : '';
  if (msg.from) meta += ' · relay: ' + msg.from;
  if (msg.latency) meta += ' · ' + msg.latency + 'ms';
  if (msg.paymentTxid) meta += ' · <a href="https://whatsonchain.com/tx/' + msg.paymentTxid + '" target="_blank">tx: ' + msg.paymentTxid.slice(0,8) + '…</a>';
  return '<div class="header"><span>' + time + '</span>' + badge + '</div>' +
         '<div class="text">' + escHtml(msg.text) + '</div>' +
         (meta ? '<div class="meta">' + meta + '</div>' : '');
}

function addPayment(p) {
  const el = document.createElement('div');
  el.className = 'payment';
  const time = new Date(p.ts).toLocaleTimeString();
  const txLink = p.txid ? '<a href="https://whatsonchain.com/tx/' + p.txid + '" target="_blank">' + p.txid.slice(0,10) + '…</a>' : '';
  el.innerHTML = '<span>' + time + ' → ' + (p.node || p.mac) + '</span><span class="sats">' + p.sats + ' sats</span>' + txLink;
  document.getElementById('payments').prepend(el);
}

function renderNodes(nodes) {
  const container = document.getElementById('nodes');
  container.innerHTML = '';
  for (const [mac, n] of Object.entries(nodes)) {
    const el = document.createElement('div');
    el.className = 'node';
    const online = n.online || n.lastSeen;
    el.innerHTML = '<div class="dot ' + (online ? 'online' : '') + '"></div>' +
      '<div><div class="name">' + (n.name || mac) + '</div><div class="mac">' + mac + (n.bsv_address ? ' · ' + n.bsv_address.slice(0,12) + '…' : '') + '</div></div>' +
      '<span class="role">' + (n.role || 'unknown') + '</span>';
    container.appendChild(el);
  }
}

function flashLink(id) {
  const el = document.getElementById(id);
  el.classList.add('active');
  setTimeout(() => el.classList.remove('active'), 800);
}

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
</script>
</body>
</html>`;

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }

  if (req.method === 'GET' && req.url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send current state
    res.write(`event: init\ndata: ${JSON.stringify({
      stats: state.stats,
      nodes: state.nodes,
      messages: state.messages.slice(-50),
      payments: state.payments.slice(-50),
    })}\n\n`);

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/send') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { message } = JSON.parse(body);
        if (!message) throw new Error('No message');
        const msg = sendToMesh(message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: msg.id }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log();
  console.log('═══════════════════════════════════════════════');
  console.log('  📡 ESP-NOW Mesh Dashboard');
  console.log('═══════════════════════════════════════════════');
  console.log(`  URL:    http://localhost:${PORT}`);
  console.log(`  Serial: ${config.serialPort || 'not configured'}`);
  console.log(`  Nodes:  ${Object.keys(config.nodes).length}`);
  console.log('═══════════════════════════════════════════════');
  console.log();

  connectSerial();
});
