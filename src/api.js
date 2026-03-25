// === КОНФИГУРАЦИЯ ===
const WHISPER_URL = 'http://31.192.110.207:8000';
const TRANSLATE_URL = 'http://31.192.110.207:5000';

/**
 * Транскрибация аудиофайла
 * @param {Blob} audioBlob - Аудиофайл (webm/wav/mp3)
 * @param {string} language - Код языка (опционально)
 * @returns {Promise<{text: string, language?: string}>}
 */
async function transcribe(audioBlob, language = '') {
  const formData = new FormData();
  formData.append('audio_file', audioBlob, 'recording.webm');
  
  const url = new URL(`${WHISPER_URL}/asr`);
  url.searchParams.set('encode', 'true');
  url.searchParams.set('task', 'transcribe');
  url.searchParams.set('output', 'json');
  if (language) {
    url.searchParams.set('language', language);
  }
  
  const response = await fetch(url.toString(), {
    method: 'POST',
    body: formData
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Transcription failed: ${response.status} - ${error}`);
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
  const response = await fetch(`${TRANSLATE_URL}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: text,
      source: sourceLang,
      target: targetLang,
      format: 'text'
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Translation failed: ${response.status} - ${error}`);
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
  const response = await fetch(`${TRANSLATE_URL}/languages`);
  
  if (!response.ok) {
    throw new Error('Failed to get supported languages');
  }
  
  return await response.json();
}

/**
 * Проверить доступность сервисов
 * @returns {Promise<{whisper: boolean, translate: boolean}>}
 */
async function checkServicesHealth() {
  const results = { whisper: false, translate: false };
  
  try {
    // Whisper не имеет /health эндпоинта, проверяем корень
    const whisperRes = await fetch(`${WHISPER_URL}/`, { method: 'GET' });
    results.whisper = whisperRes.ok || whisperRes.status === 307;
  } catch (e) {
    console.warn('Whisper health check failed:', e.message);
  }
  
  try {
    // LibreTranslate не имеет /health эндпоинта, проверяем языки
    const translateRes = await fetch(`${TRANSLATE_URL}/languages`, { method: 'GET' });
    results.translate = translateRes.ok;
  } catch (e) {
    console.warn('Translate health check failed:', e.message);
  }
  
  return results;
}

module.exports = {
  transcribe,
  translate,
  getSupportedLanguages,
  checkServicesHealth
};
