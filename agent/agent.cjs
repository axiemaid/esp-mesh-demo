#!/usr/bin/env node
'use strict';

/**
 * ESP-NOW Mesh Agent — sends messages through the ESP-NOW mesh network
 * and pays relay nodes in BSV on confirmed delivery.
 *
 * Usage:
 *   node agent.cjs send "Hello from the agent"
 *   node agent.cjs listen          (just listen for messages)
 *   node agent.cjs demo            (send + wait for confirm + pay)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// --- Serial connection ---
let port = null;
let parser = null;

function connect() {
  if (!config.serialPort) {
    console.error('❌ No serial port configured. Run: node agent.cjs detect');
    process.exit(1);
  }

  port = new SerialPort({
    path: config.serialPort,
    baudRate: config.baudRate || 115200,
  });

  parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

  port.on('open', () => {
    console.log(`✅ Connected to ${config.serialPort} @ ${config.baudRate}`);
  });

  port.on('error', (err) => {
    console.error(`❌ Serial error: ${err.message}`);
  });

  return { port, parser };
}

// --- Send message to mesh ---
function sendToMesh(message) {
  const payload = JSON.stringify({
    id: crypto.randomUUID().slice(0, 8),
    data: message,
    ts: Date.now(),
  });

  return new Promise((resolve, reject) => {
    port.write(payload + '\n', (err) => {
      if (err) reject(err);
      else resolve(payload);
    });
  });
}

// --- Wait for delivery confirmation ---
function waitForConfirmation(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      parser.removeListener('data', onData);
      reject(new Error('Timeout waiting for confirmation'));
    }, timeoutMs);

    function onData(line) {
      line = line.trim();
      // Skip Node A debug lines
      if (line.startsWith('[NODE-A]')) {
        console.log(`  ${line}`);
        return;
      }

      try {
        const msg = JSON.parse(line);
        if (msg.status === 'delivered') {
          clearTimeout(timer);
          parser.removeListener('data', onData);
          resolve(msg);
        }
      } catch {
        // Not JSON — just log it
        console.log(`  📡 ${line}`);
      }
    }

    parser.on('data', onData);
  });
}

// --- BSV Payment ---
async function payNode(macAddress, satoshis, messageHash) {
  const node = config.nodes[macAddress];
  if (!node || !node.bsv_address) {
    console.log(`  ⚠ No BSV address registered for ${macAddress}`);
    return null;
  }

  try {
    // Use the BSV wallet skill to send payment
    const { execSync } = require('child_process');
    const bsvAmount = (satoshis / 1e8).toFixed(8);
    const skillDir = '/opt/homebrew/lib/node_modules/openclaw/skills/bsv/bsv-openclaw-skill';
    const result = execSync(
      `node ${skillDir}/scripts/wallet.cjs send ${node.bsv_address} ${bsvAmount}`,
      { encoding: 'utf8', timeout: 30000 }
    );

    // Extract txid from output
    const txidMatch = result.match(/TXID:\s*([a-f0-9]+)/i);
    const txid = txidMatch ? txidMatch[1] : null;

    console.log(`  💰 Paid ${node.name || macAddress}: ${satoshis} sats → ${node.bsv_address.slice(0, 12)}...`);
    if (txid) console.log(`  🔗 TX: ${txid}`);

    return txid;
  } catch (err) {
    console.error(`  ❌ Payment failed: ${err.message}`);
    return null;
  }
}

// --- Commands ---

async function cmdDetect() {
  console.log('🔍 Scanning for serial ports...\n');
  const ports = await SerialPort.list();
  const espPorts = ports.filter(p =>
    p.path.includes('usbserial') ||
    p.path.includes('SLAB_USB') ||
    p.path.includes('wchusbserial') ||
    p.path.includes('cu.usb')
  );

  if (espPorts.length === 0) {
    console.log('No ESP32 serial ports found.');
    console.log('Make sure an ESP32 is plugged in via USB.');
    console.log('\nAll ports:');
    for (const p of ports) {
      console.log(`  ${p.path} — ${p.manufacturer || 'unknown'}`);
    }
  } else {
    console.log('ESP32 serial ports found:');
    for (const p of espPorts) {
      console.log(`  ${p.path} — ${p.manufacturer || 'unknown'}`);
    }
    console.log(`\nTo configure, update config.json "serialPort" to one of these.`);
  }
}

async function cmdListen() {
  connect();
  console.log('👂 Listening for messages... (Ctrl+C to stop)\n');

  parser.on('data', (line) => {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] ${line.trim()}`);
  });
}

async function cmdSend(message) {
  connect();

  // Wait for connection to establish
  await new Promise(r => setTimeout(r, 1000));

  console.log(`📨 Sending: "${message}"`);
  const payload = await sendToMesh(message);
  console.log(`  Payload: ${payload}`);
  console.log('  Waiting for delivery confirmation...\n');

  try {
    const confirmation = await waitForConfirmation(10000);
    console.log('\n✅ DELIVERED!');
    console.log(`  From: ${confirmation.from}`);
    console.log(`  RSSI: ${confirmation.rssi || 'N/A'}`);
    console.log(`  Time: ${confirmation.ms || 'N/A'}ms`);
  } catch (err) {
    console.log(`\n❌ ${err.message}`);
  }

  port.close();
}

async function cmdDemo(message) {
  connect();

  await new Promise(r => setTimeout(r, 1000));

  const msg = message || 'Hello from the agent — this message travels by radio, not internet';
  const msgHash = crypto.createHash('sha256').update(msg).digest('hex').slice(0, 16);

  console.log('═══════════════════════════════════════════════');
  console.log('  🤖 ESP-NOW Mesh Demo + BSV Micropayments');
  console.log('═══════════════════════════════════════════════\n');
  console.log(`  Message: "${msg}"`);
  console.log(`  Hash:    ${msgHash}\n`);

  // Step 1: Send
  console.log('Step 1: Broadcasting to mesh...');
  const payload = await sendToMesh(msg);
  console.log(`  ✅ Sent via serial → Node A → ESP-NOW\n`);

  // Step 2: Wait for confirmation
  console.log('Step 2: Waiting for delivery confirmation...');
  try {
    const confirmation = await waitForConfirmation(10000);
    console.log(`  ✅ Delivered!`);
    console.log(`  From: ${confirmation.from}`);
    console.log(`  RSSI: ${confirmation.rssi || 'N/A'}`);
    console.log(`  Latency: ${confirmation.ms || 'N/A'}ms\n`);

    // Step 3: Pay
    console.log('Step 3: Paying relay node in BSV...');
    const txid = await payNode(confirmation.from, 1000, msgHash);

    // Summary
    console.log('\n═══════════════════════════════════════════════');
    console.log('  📋 DEMO COMPLETE');
    console.log('═══════════════════════════════════════════════');
    console.log(`  Message:  ${msg}`);
    console.log(`  Hash:     ${msgHash}`);
    console.log(`  Relay:    ${confirmation.from}`);
    console.log(`  RSSI:     ${confirmation.rssi || 'N/A'}`);
    console.log(`  Payment:  1000 sats`);
    if (txid) console.log(`  BSV TX:   https://whatsonchain.com/tx/${txid}`);
    console.log('═══════════════════════════════════════════════\n');

  } catch (err) {
    console.log(`  ❌ ${err.message}`);
  }

  port.close();
}

// --- Main ---
const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'detect':
    cmdDetect();
    break;
  case 'listen':
    cmdListen();
    break;
  case 'send':
    cmdSend(args.join(' ') || 'ping');
    break;
  case 'demo':
    cmdDemo(args.join(' '));
    break;
  default:
    console.log('ESP-NOW Mesh Agent');
    console.log('');
    console.log('Commands:');
    console.log('  detect          Scan for ESP32 serial ports');
    console.log('  listen          Listen for messages from mesh');
    console.log('  send <message>  Send a message into the mesh');
    console.log('  demo [message]  Full demo: send + confirm + BSV payment');
    break;
}
