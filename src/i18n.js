// Interface translations (AUD-33).
//
// One dictionary for every window. The main process owns the chosen language and
// hands the strings to each page over IPC (the pages run with contextIsolation,
// so they cannot require this file themselves).
//
// Adding a language: add it to LANGUAGES and give it a block in STRINGS. Any key
// it leaves out falls back to English, so a partial translation never shows a
// raw key to the user.

const LANGUAGES = {
  en: 'English',
  ru: 'Русский',
  zh: '中文',
};

const FALLBACK = 'en';

const STRINGS = {
  en: {
    // main window — menu
    'menu.settings': 'Settings',
    'menu.saveAll': 'Save all text',
    'menu.clearHistory': 'Clear history',
    'menu.exit': 'Exit',
    // main window — controls
    'btn.translate': 'Translate',
    'btn.go': 'Go',
    'translate.to': 'Translate to:',
    'title.record': 'Record',
    'title.stop': 'Stop',
    'title.saveAudio': 'Save audio',
    'title.saveAudioText': 'Save audio and text',
    'title.translate': 'Translate',
    'title.copy': 'Copy',
    // main window — history and status
    'history.header': '--- History ---',
    'history.original': 'Original',
    'history.translation': 'Translation',
    'status.transcribing': 'Transcribing…',
    'status.translating': 'Translating…',
    'status.noText': 'No speech recognized.',
    'error.transcribe': 'Could not transcribe',
    'error.translate': 'Could not translate',
    'toast.copied': 'Text copied — paste with Ctrl+V',
    'confirm.clearHistory': 'Clear the whole history? This cannot be undone.',
    'alert.noAudio': 'Nothing has been recorded yet.',
    'alert.noText': 'There is no text to save.',

    // settings
    'settings.title': 'Settings',
    'settings.language': 'Language',
    'settings.theme': 'Theme',
    'settings.themeDark': 'Dark',
    'settings.themeLight': 'Light',
    'settings.font': 'Font',
    'settings.fontSize': 'Font size',
    'settings.opacity': 'Opacity',
    'settings.cancel': 'Cancel',
    'settings.save': 'Save',
    'settings.version': 'Version:',
    'settings.loading': 'Loading…',
    'settings.unknown': 'Unknown',

    // activation
    'act.windowTitle': 'Audiator activation',
    'act.welcome': 'Welcome to Audiator',
    'act.subtitle': 'Transcribe and translate audio in one click',
    'act.trialBadge': '🎁 14 days free',
    'act.startTrial': 'Start free trial',
    'act.noCard': 'No bank card required',
    'act.or': 'OR',
    'act.choosePlan': 'Choose a plan:',
    'act.month1': '1 month',
    'act.months12': '12 months',
    'act.perMonth1': '299 ₽/month',
    'act.perMonth12': '~207 ₽/month',
    'act.bestValue': 'BEST VALUE',
    'act.subscribe': 'Subscribe',
    'act.paymentSoon': 'Payment coming soon',
    'act.planSoon': 'Online payment is coming soon. The free trial is available now.',
    'act.checkingServer': 'Checking server…',
    'act.serverUp': '● Server available',
    'act.serverDown': '● Server unavailable',
    'act.serverError': '● Connection error',
    'act.activating': 'Activating trial…',
    'act.activated': '✅ Trial activated! Starting…',
    'act.trialFailed': 'Could not activate the trial',
    'act.feat1': 'Unlimited transcription',
    'act.feat2': 'Translation into 6 languages',
    'act.feat3': 'History is kept',
    'act.feat4': 'Works in the background',

    // recording overlay (two short lines: the bar is 96px wide)
    'ov.busy1': 'Transcribing',
    'ov.busy2': 'please wait…',
    'ov.done1': 'Done!',
    'ov.done2': 'Ctrl+V',

    // tray and file dialogs
    'tray.show': 'Show',
    'tray.quit': 'Quit',
    'dlg.saveAudio': 'Save recording',
    'dlg.saveHistory': 'Save transcription history',
    'dlg.saveAudioText': 'Save audio and text',
    'dlg.filterAudio': 'WebM audio',
    'dlg.filterText': 'Text files',
  },

  ru: {
    'menu.settings': 'Настройки',
    'menu.saveAll': 'Сохранить весь текст',
    'menu.clearHistory': 'Очистить историю',
    'menu.exit': 'Выход',
    'btn.translate': 'Перевести',
    'btn.go': 'ОК',
    'translate.to': 'Перевести на:',
    'title.record': 'Запись',
    'title.stop': 'Стоп',
    'title.saveAudio': 'Сохранить аудио',
    'title.saveAudioText': 'Сохранить аудио и текст',
    'title.translate': 'Перевести',
    'title.copy': 'Копировать',
    'history.header': '--- История ---',
    'history.original': 'Оригинал',
    'history.translation': 'Перевод',
    'status.transcribing': 'Расшифровка…',
    'status.translating': 'Перевод…',
    'status.noText': 'Речь не распознана.',
    'error.transcribe': 'Не удалось расшифровать',
    'error.translate': 'Не удалось перевести',
    'toast.copied': 'Текст скопирован — вставьте через Ctrl+V',
    'confirm.clearHistory': 'Очистить всю историю? Это действие нельзя отменить.',
    'alert.noAudio': 'Аудио ещё не записано.',
    'alert.noText': 'Нет текста для сохранения.',

    'settings.title': 'Настройки',
    'settings.language': 'Язык',
    'settings.theme': 'Тема',
    'settings.themeDark': 'Тёмная',
    'settings.themeLight': 'Светлая',
    'settings.font': 'Шрифт',
    'settings.fontSize': 'Размер шрифта',
    'settings.opacity': 'Прозрачность',
    'settings.cancel': 'Отмена',
    'settings.save': 'Сохранить',
    'settings.version': 'Версия:',
    'settings.loading': 'Загрузка…',
    'settings.unknown': 'Неизвестна',

    'act.windowTitle': 'Активация Audiator',
    'act.welcome': 'Добро пожаловать в Audiator',
    'act.subtitle': 'Транскрибация и перевод аудио в один клик',
    'act.trialBadge': '🎁 14 дней бесплатно',
    'act.startTrial': 'Начать бесплатный период',
    'act.noCard': 'Не требуется банковская карта',
    'act.or': 'ИЛИ',
    'act.choosePlan': 'Выберите подписку:',
    'act.month1': '1 месяц',
    'act.months12': '12 месяцев',
    'act.perMonth1': '299 ₽/мес',
    'act.perMonth12': '~207 ₽/мес',
    'act.bestValue': 'ВЫГОДНО',
    'act.subscribe': 'Оформить подписку',
    'act.paymentSoon': 'Оплата скоро будет доступна',
    'act.planSoon': 'Онлайн-оплата скоро появится. Сейчас доступен бесплатный период.',
    'act.checkingServer': 'Проверка сервера…',
    'act.serverUp': '● Сервер доступен',
    'act.serverDown': '● Сервер недоступен',
    'act.serverError': '● Ошибка подключения',
    'act.activating': 'Активация триала…',
    'act.activated': '✅ Триал активирован! Запуск…',
    'act.trialFailed': 'Не удалось активировать триал',
    'act.feat1': 'Транскрибация без ограничений',
    'act.feat2': 'Перевод на 6 языков',
    'act.feat3': 'Сохранение истории',
    'act.feat4': 'Работа в фоновом режиме',

    'ov.busy1': 'Выполняется',
    'ov.busy2': 'транскрибация!',
    'ov.done1': 'Готово!',
    'ov.done2': 'Ctrl+V',

    'tray.show': 'Показать',
    'tray.quit': 'Выход',
    'dlg.saveAudio': 'Сохранить аудиозапись',
    'dlg.saveHistory': 'Сохранить историю расшифровок',
    'dlg.saveAudioText': 'Сохранить аудио и текст',
    'dlg.filterAudio': 'Аудио WebM',
    'dlg.filterText': 'Текстовые файлы',
  },

  zh: {
    'menu.settings': '设置',
    'menu.saveAll': '保存全部文本',
    'menu.clearHistory': '清除历史记录',
    'menu.exit': '退出',
    'btn.translate': '翻译',
    'btn.go': '确定',
    'translate.to': '翻译为：',
    'title.record': '录音',
    'title.stop': '停止',
    'title.saveAudio': '保存音频',
    'title.saveAudioText': '保存音频和文本',
    'title.translate': '翻译',
    'title.copy': '复制',
    'history.header': '--- 历史记录 ---',
    'history.original': '原文',
    'history.translation': '译文',
    'status.transcribing': '正在转写…',
    'status.translating': '正在翻译…',
    'status.noText': '未识别到语音。',
    'error.transcribe': '转写失败',
    'error.translate': '翻译失败',
    'toast.copied': '文本已复制 — 按 Ctrl+V 粘贴',
    'confirm.clearHistory': '确定清除全部历史记录吗？此操作无法撤销。',
    'alert.noAudio': '尚未录音。',
    'alert.noText': '没有可保存的文本。',

    'settings.title': '设置',
    'settings.language': '语言',
    'settings.theme': '主题',
    'settings.themeDark': '深色',
    'settings.themeLight': '浅色',
    'settings.font': '字体',
    'settings.fontSize': '字号',
    'settings.opacity': '透明度',
    'settings.cancel': '取消',
    'settings.save': '保存',
    'settings.version': '版本：',
    'settings.loading': '加载中…',
    'settings.unknown': '未知',

    'act.windowTitle': 'Audiator 激活',
    'act.welcome': '欢迎使用 Audiator',
    'act.subtitle': '一键转写和翻译音频',
    'act.trialBadge': '🎁 免费试用 14 天',
    'act.startTrial': '开始免费试用',
    'act.noCard': '无需银行卡',
    'act.or': '或',
    'act.choosePlan': '选择订阅方案：',
    'act.month1': '1 个月',
    'act.months12': '12 个月',
    'act.perMonth1': '299 ₽/月',
    'act.perMonth12': '约 207 ₽/月',
    'act.bestValue': '最划算',
    'act.subscribe': '订阅',
    'act.paymentSoon': '即将支持付款',
    'act.planSoon': '即将支持在线付款。现在可以免费试用。',
    'act.checkingServer': '正在检查服务器…',
    'act.serverUp': '● 服务器可用',
    'act.serverDown': '● 服务器不可用',
    'act.serverError': '● 连接错误',
    'act.activating': '正在激活试用…',
    'act.activated': '✅ 试用已激活！正在启动…',
    'act.trialFailed': '无法激活试用',
    'act.feat1': '无限制转写',
    'act.feat2': '支持 6 种语言翻译',
    'act.feat3': '保存历史记录',
    'act.feat4': '后台运行',

    'ov.busy1': '正在转写',
    'ov.busy2': '请稍候…',
    'ov.done1': '完成！',
    'ov.done2': 'Ctrl+V',

    'tray.show': '显示',
    'tray.quit': '退出',
    'dlg.saveAudio': '保存录音',
    'dlg.saveHistory': '保存转写历史',
    'dlg.saveAudioText': '保存音频和文本',
    'dlg.filterAudio': 'WebM 音频',
    'dlg.filterText': '文本文件',
  },
};

// The stored choice wins; otherwise follow the OS language, falling back to
// English for anything we do not ship.
function resolveLanguage(stored, osLocale) {
  if (stored && STRINGS[stored]) return stored;
  const l = String(osLocale || '').toLowerCase();
  if (l.startsWith('ru')) return 'ru';
  if (l.startsWith('zh')) return 'zh';
  return FALLBACK;
}

// Full string table for a language, English filling any gaps.
function stringsFor(lang) {
  return { ...STRINGS[FALLBACK], ...(STRINGS[lang] || {}) };
}

function t(lang, key) {
  const table = stringsFor(lang);
  return table[key] !== undefined ? table[key] : key;
}

module.exports = { LANGUAGES, FALLBACK, STRINGS, resolveLanguage, stringsFor, t };
