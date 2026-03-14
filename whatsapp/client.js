const { Client, LocalAuth } = require('whatsapp-web.js');
const { SESSION_DIR } = require('./session');

let client = null;
let isInitializing = false;

const PUPPETEER_CONFIG = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--single-process',
  ],
};

function createClient() {
  if (client) {
    return client;
  }

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: PUPPETEER_CONFIG,
    restartOnAuthFail: true,
  });

  return client;
}

function getClient() {
  return client;
}

function isReady() {
  return client !== null && !isInitializing;
}

async function initialize() {
  if (isInitializing) {
    throw new Error('Client is already initializing');
  }

  if (!client) {
    createClient();
  }

  isInitializing = true;

  try {
    await client.initialize();
  } finally {
    isInitializing = false;
  }
}

async function destroy() {
  if (!client) return;

  try {
    await client.destroy();
  } catch (err) {
    console.error('[WhatsApp Client] Destroy error:', err.message);
  } finally {
    client = null;
    isInitializing = false;
  }
}

function getInitializing() {
  return isInitializing;
}

module.exports = {
  createClient,
  getClient,
  isReady,
  initialize,
  destroy,
  getInitializing,
};
