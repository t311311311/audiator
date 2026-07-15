const auth = require('./auth');

// === КОНФИГУРАЦИЯ ===
// Транскрибация и перевод идут через аутентифицирующий гейтвей на auth-сервере:
// он проверяет токен подписки и уже сам проксирует во внутренние Whisper /
// LibreTranslate (AUD-8). Клиент больше не обращается к ним напрямую.
const GATEWAY_URL = process.env.AUDIATOR_GATEWAY_URL || 'http://31.192.110.207:3000';

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
 * Транскрибация аудио
 * @param {Buffer|Uint8Array} audioBuffer - Аудиоданные (Blob не проходит через IPC)
 * @param {string} language - Код языка (опционально)
 * @returns {Promise<{text: string, language?: string}>}
 */
async function transcribe(audioBuffer, language = '') {
  const formData = new FormData();
  formData.append('audio_file', new Blob([audioBuffer], { type: 'audio/webm' }), 'recording.webm');

  const url = new URL(`${GATEWAY_URL}/asr`);
  url.searchParams.set('encode', 'true');
  url.searchParams.set('task', 'transcribe');
  url.searchParams.set('output', 'json');
  if (language) {
    url.searchParams.set('language', language);
  }

  const response = await fetch(url.toString(), {
    method: 'POST',
    body: formData,
    headers: authHeaders()
  });

  if (!response.ok) {
    await raiseGatewayError(response);
  }

  return await response.json();
}

/**
 * Перевод текста
 * @param {string} text - Текст для перевода
 * @param {string} targetLang - Целевой язык (ru, en, es, de, fr, zh, ja)
 * @param {string} sourceLang - Исходный язык (auto для автоопределения)
 * @returns {Promise<{translatedText: string, detectedLanguage?: string}>}
 */
async function translate(text, targetLang = 'ru', sourceLang = 'auto') {
  const response = await fetch(`${GATEWAY_URL}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      q: text,
      source: sourceLang,
      target: targetLang,
      format: 'text'
    })
  });

  if (!response.ok) {
    await raiseGatewayError(response);
  }

  const result = await response.json();
  return {
    translatedText: result.translatedText,
    detectedLanguage: result.detectedLanguage?.language
  };
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
