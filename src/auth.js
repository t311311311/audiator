const https = require('https');
const http = require('http');

// === КОНФИГУРАЦИЯ ===
const AUTH_SERVER_URL = 'http://31.192.110.207:3000';

/**
 * HTTP запрос к серверу авторизации
 */
function request(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, AUTH_SERVER_URL);
    const lib = url.protocol === 'https:' ? https : http;
    
    const reqOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    };
    
    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(json.detail || `HTTP ${res.statusCode}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    
    req.end();
  });
}

/**
 * Получить токен из хранилища
 */
function getToken() {
  const fs = require('fs');
  const path = require('path');
  const tokenPath = path.join(process.env.APPDATA || process.env.HOME, 'audiator', 'token.json');
  
  try {
    if (fs.existsSync(tokenPath)) {
      const data = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
      return data.token;
    }
  } catch (e) {
    console.error('Failed to read token:', e);
  }
  return null;
}

/**
 * Сохранить токен в хранилище
 */
function saveToken(token) {
  const fs = require('fs');
  const path = require('path');
  const tokenDir = path.join(process.env.APPDATA || process.env.HOME, 'audiator');
  const tokenPath = path.join(tokenDir, 'token.json');
  
  try {
    if (!fs.existsSync(tokenDir)) {
      fs.mkdirSync(tokenDir, { recursive: true });
    }
    fs.writeFileSync(tokenPath, JSON.stringify({ token, savedAt: new Date().toISOString() }));
    return true;
  } catch (e) {
    console.error('Failed to save token:', e);
    return false;
  }
}

/**
 * Удалить токен
 */
function removeToken() {
  const fs = require('fs');
  const path = require('path');
  const tokenPath = path.join(process.env.APPDATA || process.env.HOME, 'audiator', 'token.json');
  
  try {
    if (fs.existsSync(tokenPath)) {
      fs.unlinkSync(tokenPath);
    }
    return true;
  } catch (e) {
    console.error('Failed to remove token:', e);
    return false;
  }
}

/**
 * Сгенерировать уникальный device_id
 */
function generateDeviceId() {
  const crypto = require('crypto');
  const os = require('os');

  // Collect a stable, machine-unique signature from all non-internal MAC
  // addresses. The previous implementation read only `eth0`, which does not
  // exist on Windows/macOS, so every such device produced the same id.
  let mac = '';
  try {
    const interfaces = os.networkInterfaces();
    const macs = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          macs.push(iface.mac);
        }
      }
    }
    macs.sort(); // deterministic regardless of interface enumeration order
    mac = macs[0] || '';
  } catch (e) {
    console.error('Failed to read network interfaces:', e);
  }

  // Fallback for machines with no usable MAC (e.g. all interfaces filtered).
  const fallback = `${os.hostname()}|${os.userInfo().username}`;
  const signature = `${mac || fallback}|${process.platform}|${os.arch()}`;

  return crypto.createHash('sha256').update(signature).digest('hex').slice(0, 16);
}

/**
 * Получить или создать device_id
 */
function getDeviceId() {
  const fs = require('fs');
  const path = require('path');
  const configPath = path.join(process.env.APPDATA || process.env.HOME, 'audiator', 'device.json');
  
  try {
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return data.device_id;
    }
  } catch (e) {
    console.error('Failed to read device_id:', e);
  }
  
  // Создать новый device_id
  const deviceId = generateDeviceId();
  try {
    const configDir = path.join(process.env.APPDATA || process.env.HOME, 'audiator');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify({ device_id: deviceId, createdAt: new Date().toISOString() }));
  } catch (e) {
    console.error('Failed to save device_id:', e);
  }
  
  return deviceId;
}

// === ПУБЛИЧНЫЕ МЕТОДЫ ===

/**
 * Проверить доступность сервера
 */
async function checkServerHealth() {
  try {
    const result = await request('/health');
    return result.status === 'ok';
  } catch (e) {
    console.error('Server health check failed:', e.message);
    return false;
  }
}

/**
 * Начать триал-период
 */
async function startTrial(deviceName) {
  try {
    const deviceId = getDeviceId();
    const result = await request('/api/auth/trial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { device_id: deviceId, device_name: deviceName || 'Desktop App' }
    });
    
    if (result.access_token) {
      saveToken(result.access_token);
    }
    
    return result;
  } catch (e) {
    console.error('Trial start failed:', e.message);
    throw e;
  }
}

/**
 * Проверить статус подписки
 */
async function checkStatus() {
  try {
    const token = getToken();
    if (!token) {
      return { authenticated: false, reason: 'no_token' };
    }
    
    const result = await request('/api/auth/status', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    return {
      authenticated: true,
      subscriptionEnd: result.subscription_end,
      expiresAt: result.expires_at,
      hasActiveSubscription: result.subscription_end && new Date(result.subscription_end) > new Date()
    };
  } catch (e) {
    console.error('Status check failed:', e.message);
    if (e.message.includes('expired') || e.message.includes('Invalid')) {
      removeToken();
      return { authenticated: false, reason: 'token_expired' };
    }
    return { authenticated: false, reason: 'error', error: e.message };
  }
}

/**
 * Активировать подписку
 */
async function activateSubscription(plan, paymentId) {
  try {
    const deviceId = getDeviceId();
    const result = await request('/api/auth/subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { device_id: deviceId, plan, payment_id: paymentId }
    });
    
    if (result.access_token) {
      saveToken(result.access_token);
    }
    
    return result;
  } catch (e) {
    console.error('Subscription activation failed:', e.message);
    throw e;
  }
}

/**
 * Получить доступные планы
 */
async function getPlans() {
  try {
    return await request('/api/auth/plans');
  } catch (e) {
    console.error('Get plans failed:', e.message);
    return { plans: {}, trial_days: 14 };
  }
}

/**
 * Выйти (удалить токен)
 */
function logout() {
  removeToken();
}

module.exports = {
  checkServerHealth,
  startTrial,
  checkStatus,
  activateSubscription,
  getPlans,
  logout,
  getToken,
  getDeviceId
};
