const auth = require('./auth');
const engine = require('./engine');

// === КОНФИГУРАЦИЯ ===
// Транскрибация и перевод идут в локальный движок на этом компьютере
// (engine.js); гейтвей на auth-сервере остаётся для входа и проверки сервиса.
const GATEWAY_URL = process.env.AUDIATOR_GATEWAY_URL || 'http://127.0.0.1:3000';

/**
 * Ошибка, означающая, что нужна активация (нет токена, истёк, нет подписки).
 */
class AuthRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthRequiredError';
    this.authRequired = true;
  }
}

function authHeaders() {
  const token = auth.getToken();
  if (!token) {
    throw new AuthRequiredError('Требуется активация');
  }
  return { 'Authorization': `Bearer ${token}` };
}

/**
 * Превратить неуспешный ответ гейтвея в осмысленную ошибку.
 */
async function raiseGatewayError(response) {
  const body = await response.text();
  if (response.status === 401) {
    throw new AuthRequiredError('Сессия истекла, требуется повторная активация');
  }
  if (response.status === 403) {
    throw new AuthRequiredError('Подписка не активна');
  }
  throw new Error(`${response.status} - ${body}`);
}

/**
 * Транскрибация аудио — на этом компьютере, в локальном движке (engine.js),
 * а не через гейтвей: голос никуда не уходит. Учёт минут переедет в
 * приложение вместе с новыми аккаунтами (docs/PRODUCT-PLAN.md, шаг 4).
 * @param {Buffer|Uint8Array} audioBuffer - Аудиоданные (Blob не проходит через IPC)
 * @param {string} language - Код языка (опционально)
 * @returns {Promise<{text: string, language?: string}>}
 */
async function transcribe(audioBuffer, language = '') {
  // Waits while the model downloads or loads (the main window shows progress).
  const base = await engine.whenModelReady();

  const formData = new FormData();
  formData.append('audio_file', new Blob([audioBuffer], { type: 'audio/webm' }), 'recording.webm');

  const url = new URL(`${base}/asr`);
  url.searchParams.set('task', 'transcribe');
  url.searchParams.set('output', 'json');
  if (language) {
    url.searchParams.set('language', language);
  }

  const response = await fetch(url.toString(), { method: 'POST', body: formData });
  if (!response.ok) {
    throw new Error(`${response.status} - ${await response.text()}`);
  }
  return await response.json();
}

/**
 * Перевод текста — на этом компьютере, в локальном движке (Argos Translate),
 * между установленными языками. Язык текста известен из распознавания.
 * Если нужный язык не установлен, ошибка несёт его код в .missing.
 * @param {string} text - Текст для перевода
 * @param {string} targetLang - Целевой язык (код Argos: ru, en, fr, zh…)
 * @param {string} sourceLang - Язык текста (как его определило распознавание)
 * @returns {Promise<{translatedText: string}>}
 */
async function translate(text, targetLang, sourceLang) {
  return { translatedText: await engine.translateText(text, sourceLang, targetLang) };
}

/**
 * Получить список доступных языков перевода
 * @returns {Promise<Array<{code: string, name: string}>>}
 */
async function getSupportedLanguages() {
  const response = await fetch(`${GATEWAY_URL}/languages`, { headers: authHeaders() });

  if (!response.ok) {
    await raiseGatewayError(response);
  }

  return await response.json();
}

/**
 * Проверить доступность сервисов (через гейтвей, токен не нужен)
 * @returns {Promise<{whisper: boolean, translate: boolean}>}
 */
async function checkServicesHealth() {
  try {
    const response = await fetch(`${GATEWAY_URL}/health`, { method: 'GET' });
    const ok = response.ok;
    return { whisper: ok, translate: ok };
  } catch (e) {
    console.warn('Gateway health check failed:', e.message);
    return { whisper: false, translate: false };
  }
}

module.exports = {
  transcribe,
  translate,
  getSupportedLanguages,
  checkServicesHealth,
  AuthRequiredError
};
