// Texts used by the main process (alerts, tray, dialogs), in the three app languages.
// The window has its own table in renderer/i18n.js.
import { formatDuration, formatDateTime } from './core/format.js';

const MSG = {
  en: {
    'cause.silence': 'silence (audio below the threshold)',
    'cause.offline': 'input offline (no audio delivered)',
    'cause.frozen': 'frozen audio (the level does not move)',
    'alarm.subject': '[Dead Air Watchdog] DEAD AIR: {input}',
    'alarm.body': 'Dead air on "{input}".\nCause: {cause}\nStarted: {start}\nThreshold: {threshold} dBFS, alert after {seconds} s.\nAlert sent: {now}\nMachine: {host}',
    'alarm.bodyFrozen': 'Frozen audio on "{input}".\nCause: {cause}\nStarted: {start}\nThe level stayed within {tolerance} dB for {seconds} s, above the threshold of {threshold} dBFS: a steady tone, a stuck loop or constant noise.\nAlert sent: {now}\nMachine: {host}',
    'reminder.subject': '[Dead Air Watchdog] STILL DEAD AIR: {input}',
    'reminder.body': 'Still dead air on "{input}" for {duration}.\nCause: {cause}\nStarted: {start}\nMachine: {host}',
    'recovered.subject': '[Dead Air Watchdog] Audio back: {input}',
    'recovered.body': 'Audio is back on "{input}".\nFrom {start} to {end}\nDuration: {duration}\nMachine: {host}',
    'test.subject': '[Dead Air Watchdog] Test message',
    'test.body': 'Test message from Dead Air Watchdog. The channel works.',
    'err.emailIncomplete': 'Email settings incomplete (server or recipients missing)',
    'err.telegramIncomplete': 'Telegram settings incomplete (bot token or recipients missing)',
    'err.telegramFailed': 'Telegram not delivered to: ',
    'err.emailFailed': 'Email not sent: ',
    'err.emailRejected': 'rejected by the server',
    'err.telegramToken': 'Telegram bot token not valid (expected something like 123456789:AA…)',
    'err.webhookIncomplete': 'HTTP alert address missing or not valid (it must start with http:// or https://)',
    'err.webhookFailed': 'HTTP alert not delivered: ',
    'update.subject': '[Dead Air Watchdog] New version {latest} available',
    'update.body': 'Version {latest} of Dead Air Watchdog is available (installed: {current}).\nOpen the app: Settings → Updates offers "Download installer".\n{url}',
    'group.alarm.subject': '[Dead Air Watchdog] DEAD AIR on {n} inputs',
    'group.alarm.body': 'These {n} inputs have gone down together:\n{list}\nAlert sent: {now}\nMachine: {host}',
    'group.alarm.line': '- {input}: {cause}, since {start}',
    'group.recovered.subject': '[Dead Air Watchdog] Audio back on {n} inputs',
    'group.recovered.body': 'Audio is back on these {n} inputs:\n{list}\nMachine: {host}',
    'group.recovered.line': '- {input}: {duration} (from {start} to {end})',
    'tip.paused': 'Alerts paused',
    'desktop.updatedTo': 'Updated to version {version}',
    'tray.open': 'Open Dead Air Watchdog',
    'tray.start': 'Start monitoring',
    'tray.stop': 'Stop monitoring',
    'tray.compact': 'Compact view',
    'tray.hideMenu': 'Hide the menu bar in the compact view',
    'ctx.menuBar': 'Menu bar',
    'ctx.zoomIn': 'Zoom in',
    'ctx.zoomOut': 'Zoom out',
    'ctx.zoomReset': 'Actual size',
    'tray.top': 'Always on top',
    'tray.quit': 'Quit',
    'tip.idle': 'Monitoring stopped',
    'tip.starting': 'Starting…',
    'tip.ok': 'Audio OK',
    'tip.counting': 'Silence detected: counting',
    'tip.alarm': 'DEAD AIR',
    'closeHint.title': 'Still running',
    'closeHint.detail': 'Dead Air Watchdog keeps monitoring from the menu bar / system tray. Use the tray icon to reopen the window or to quit.',
    'desktop.alarm': 'Dead air on {input}',
    'desktop.recovered': 'Audio back on {input} after {duration}',
    'input.stream': 'stream {host}',
    'input.defaultDevice': 'default audio input'
  },
  it: {
    'cause.silence': 'silenzio (audio sotto soglia)',
    'cause.offline': 'ingresso offline (nessun audio ricevuto)',
    'cause.frozen': 'audio bloccato (il livello non si muove)',
    'alarm.subject': '[Dead Air Watchdog] DEAD AIR: {input}',
    'alarm.body': 'Dead air su "{input}".\nCausa: {cause}\nInizio: {start}\nSoglia: {threshold} dBFS, avviso dopo {seconds} s.\nAvviso inviato: {now}\nMacchina: {host}',
    'alarm.bodyFrozen': 'Audio bloccato su "{input}".\nCausa: {cause}\nInizio: {start}\nIl livello è rimasto entro {tolerance} dB per {seconds} s, sopra la soglia di {threshold} dBFS: un tono fisso, un loop bloccato o rumore costante.\nAvviso inviato: {now}\nMacchina: {host}',
    'reminder.subject': '[Dead Air Watchdog] ANCORA DEAD AIR: {input}',
    'reminder.body': 'Ancora dead air su "{input}" da {duration}.\nCausa: {cause}\nInizio: {start}\nMacchina: {host}',
    'recovered.subject': '[Dead Air Watchdog] Audio ripristinato: {input}',
    'recovered.body': 'L\'audio è tornato su "{input}".\nDa {start} a {end}\nDurata: {duration}\nMacchina: {host}',
    'test.subject': '[Dead Air Watchdog] Messaggio di prova',
    'test.body': 'Messaggio di prova da Dead Air Watchdog. Il canale funziona.',
    'err.emailIncomplete': 'Impostazioni email incomplete (server o destinatari mancanti)',
    'err.telegramIncomplete': 'Impostazioni Telegram incomplete (token del bot o destinatari mancanti)',
    'err.telegramFailed': 'Telegram non consegnato a: ',
    'err.emailFailed': 'Email non inviata: ',
    'err.emailRejected': 'respinto dal server',
    'err.telegramToken': 'Token del bot Telegram non valido (atteso qualcosa come 123456789:AA…)',
    'err.webhookIncomplete': 'Indirizzo dell’avviso HTTP mancante o non valido (deve iniziare con http:// o https://)',
    'err.webhookFailed': 'Avviso HTTP non consegnato: ',
    'update.subject': '[Dead Air Watchdog] Nuova versione {latest} disponibile',
    'update.body': 'È disponibile la versione {latest} di Dead Air Watchdog (installata: {current}).\nApri l\'app: Impostazioni → Aggiornamenti propone "Scarica l\'installer".\n{url}',
    'group.alarm.subject': '[Dead Air Watchdog] DEAD AIR su {n} ingressi',
    'group.alarm.body': 'Questi {n} ingressi sono caduti insieme:\n{list}\nAvviso inviato: {now}\nMacchina: {host}',
    'group.alarm.line': '- {input}: {cause}, dalle {start}',
    'group.recovered.subject': '[Dead Air Watchdog] Audio ripristinato su {n} ingressi',
    'group.recovered.body': 'L\'audio è tornato su questi {n} ingressi:\n{list}\nMacchina: {host}',
    'group.recovered.line': '- {input}: {duration} (da {start} a {end})',
    'tip.paused': 'Avvisi in pausa',
    'desktop.updatedTo': 'Aggiornato alla versione {version}',
    'tray.open': 'Apri Dead Air Watchdog',
    'tray.start': 'Avvia il monitoraggio',
    'tray.stop': 'Ferma il monitoraggio',
    'tray.compact': 'Vista compatta',
    'tray.hideMenu': 'Nascondi la barra dei menu nella vista compatta',
    'ctx.menuBar': 'Barra dei menu',
    'ctx.zoomIn': 'Ingrandisci',
    'ctx.zoomOut': 'Riduci',
    'ctx.zoomReset': 'Dimensione reale',
    'tray.top': 'Sempre in primo piano',
    'tray.quit': 'Esci',
    'tip.idle': 'Monitoraggio fermo',
    'tip.starting': 'Avvio…',
    'tip.ok': 'Audio OK',
    'tip.counting': 'Silenzio rilevato: conteggio',
    'tip.alarm': 'DEAD AIR',
    'closeHint.title': 'Ancora in esecuzione',
    'closeHint.detail': 'Dead Air Watchdog continua a monitorare dalla barra dei menu / area di notifica. Usa l\'icona per riaprire la finestra o per uscire.',
    'desktop.alarm': 'Dead air su {input}',
    'desktop.recovered': 'Audio tornato su {input} dopo {duration}',
    'input.stream': 'stream {host}',
    'input.defaultDevice': 'ingresso audio predefinito'
  },
  es: {
    'cause.silence': 'silencio (audio por debajo del umbral)',
    'cause.offline': 'entrada sin conexión (no llega audio)',
    'cause.frozen': 'audio bloqueado (el nivel no se mueve)',
    'alarm.subject': '[Dead Air Watchdog] DEAD AIR: {input}',
    'alarm.body': 'Dead air en "{input}".\nCausa: {cause}\nInicio: {start}\nUmbral: {threshold} dBFS, aviso tras {seconds} s.\nAviso enviado: {now}\nEquipo: {host}',
    'alarm.bodyFrozen': 'Audio bloqueado en "{input}".\nCausa: {cause}\nInicio: {start}\nEl nivel se mantuvo dentro de {tolerance} dB durante {seconds} s, por encima del umbral de {threshold} dBFS: un tono fijo, un bucle atascado o ruido constante.\nAviso enviado: {now}\nEquipo: {host}',
    'reminder.subject': '[Dead Air Watchdog] SIGUE EL DEAD AIR: {input}',
    'reminder.body': 'Sigue el dead air en "{input}" desde hace {duration}.\nCausa: {cause}\nInicio: {start}\nEquipo: {host}',
    'recovered.subject': '[Dead Air Watchdog] Audio recuperado: {input}',
    'recovered.body': 'El audio ha vuelto en "{input}".\nDe {start} a {end}\nDuración: {duration}\nEquipo: {host}',
    'test.subject': '[Dead Air Watchdog] Mensaje de prueba',
    'test.body': 'Mensaje de prueba de Dead Air Watchdog. El canal funciona.',
    'err.emailIncomplete': 'Ajustes de correo incompletos (falta servidor o destinatarios)',
    'err.telegramIncomplete': 'Ajustes de Telegram incompletos (falta el token del bot o destinatarios)',
    'err.telegramFailed': 'Telegram no entregado a: ',
    'err.emailFailed': 'Correo no enviado: ',
    'err.emailRejected': 'rechazado por el servidor',
    'err.telegramToken': 'Token del bot de Telegram no válido (se espera algo como 123456789:AA…)',
    'err.webhookIncomplete': 'Dirección del aviso HTTP ausente o no válida (debe empezar por http:// o https://)',
    'err.webhookFailed': 'Aviso HTTP no entregado: ',
    'update.subject': '[Dead Air Watchdog] Nueva versión {latest} disponible',
    'update.body': 'Ya está disponible la versión {latest} de Dead Air Watchdog (instalada: {current}).\nAbre la aplicación: Ajustes → Actualizaciones ofrece "Descargar el instalador".\n{url}',
    'group.alarm.subject': '[Dead Air Watchdog] DEAD AIR en {n} entradas',
    'group.alarm.body': 'Estas {n} entradas han caído a la vez:\n{list}\nAviso enviado: {now}\nEquipo: {host}',
    'group.alarm.line': '- {input}: {cause}, desde {start}',
    'group.recovered.subject': '[Dead Air Watchdog] Audio recuperado en {n} entradas',
    'group.recovered.body': 'El audio ha vuelto en estas {n} entradas:\n{list}\nEquipo: {host}',
    'group.recovered.line': '- {input}: {duration} (de {start} a {end})',
    'tip.paused': 'Avisos en pausa',
    'desktop.updatedTo': 'Actualizado a la versión {version}',
    'tray.open': 'Abrir Dead Air Watchdog',
    'tray.start': 'Iniciar la monitorización',
    'tray.stop': 'Detener la monitorización',
    'tray.compact': 'Vista compacta',
    'tray.hideMenu': 'Ocultar la barra de menús en la vista compacta',
    'ctx.menuBar': 'Barra de menús',
    'ctx.zoomIn': 'Acercar',
    'ctx.zoomOut': 'Alejar',
    'ctx.zoomReset': 'Tamaño real',
    'tray.top': 'Siempre visible',
    'tray.quit': 'Salir',
    'tip.idle': 'Monitorización detenida',
    'tip.starting': 'Iniciando…',
    'tip.ok': 'Audio OK',
    'tip.counting': 'Silencio detectado: contando',
    'tip.alarm': 'DEAD AIR',
    'closeHint.title': 'Sigue en marcha',
    'closeHint.detail': 'Dead Air Watchdog sigue monitorizando desde la barra de menús / bandeja del sistema. Usa el icono para reabrir la ventana o salir.',
    'desktop.alarm': 'Dead air en {input}',
    'desktop.recovered': 'Audio recuperado en {input} tras {duration}',
    'input.stream': 'stream {host}',
    'input.defaultDevice': 'entrada de audio predeterminada'
  }
};

export const APP_NAME = 'Dead Air Watchdog';
const HAS_PREFIX = /^\[Dead Air Watchdog( · [^\]\n]*)?\]/;
// Which installation speaks: the name the user gave, else the computer name (several PCs in a studio).
export const installationName = (settings, host = '') => String(settings?.installationName || host || '').trim();
export const alertPrefix = (settings, host = '') => {
  const n = installationName(settings, host);
  return n ? `[${APP_NAME} · ${n}]` : `[${APP_NAME}]`;
};
// Puts the prefix with the installation name in place of the plain one at the start of a subject or text.
export const withPrefix = (text, prefix) => (HAS_PREFIX.test(text) ? text.replace(HAS_PREFIX, prefix) : text);
export const hasPrefix = (text) => HAS_PREFIX.test(text);

export const MESSAGE_KEYS = Object.keys(MSG.en);
export const MESSAGES = MSG;

export function t(lang, key, vars = {}) {
  const table = MSG[lang] || MSG.en;
  const s = table[key] ?? MSG.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// Human-readable name of an input for alerts and the log: the name given by the user, else the
// stream host (never the full URL: it can carry credentials) or the device name.
export function inputLabel(lang, input) {
  if (input.name) return input.name;
  if (input.type === 'stream') {
    try {
      return t(lang, 'input.stream', { host: new URL(input.streamUrl).host.replace(/^.*@/, '') });
    } catch {
      return t(lang, 'input.stream', { host: '?' });
    }
  }
  return input.deviceLabel || t(lang, 'input.defaultDevice');
}

// Messages the user can word differently (Settings → Alerts). Empty = the text of the app. The placeholders of each one:
export const TEMPLATE_KINDS = ['alarm', 'frozen', 'reminder', 'recovered', 'groupAlarm', 'groupRecovered'];
export const TEMPLATE_VARS = {
  single: ['input', 'cause', 'start', 'end', 'now', 'threshold', 'seconds', 'tolerance', 'duration', 'host'],
  group: ['n', 'list', 'now', 'host']
};
export const TEMPLATE_LIMITS = { subject: 200, body: 4000 };
const SUBJECT_PREFIX = `[${APP_NAME}] `;

// A subject or body written by the user, if there is one for `kind`; unknown {words} stay as typed.
function custom(templates, kind, part, vars) {
  const raw = templates?.[kind]?.[part];
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  const filled = text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  // the prefix [Dead Air Watchdog · installation] stays at the start of every subject, so several PCs can be told apart
  return part === 'subject' && !HAS_PREFIX.test(filled) ? SUBJECT_PREFIX + filled : filled;
}

// Builds subject and body of an alert. kind: 'alarm' | 'reminder' | 'recovered'. templates: settings.notifications.templates.
export function buildAlert(lang, kind, d, templates) {
  const when = (ts) => formatDateTime(ts, lang);
  const vars = {
    input: d.input,
    cause: t(lang, `cause.${d.cause || 'silence'}`),
    start: when(d.start),
    end: d.end ? when(d.end) : '',
    now: when(d.now),
    threshold: d.thresholdDb,
    seconds: d.cause === 'frozen' ? d.frozenSec : d.minSilenceSec,
    tolerance: d.frozenToleranceDb,
    duration: formatDuration(d.durationMs ?? 0),
    host: d.host
  };
  const body = kind === 'alarm' && d.cause === 'frozen' ? 'alarm.bodyFrozen' : `${kind}.body`;
  const key = kind === 'alarm' && d.cause === 'frozen' ? 'frozen' : kind;
  return { subject: custom(templates, key, 'subject', vars) ?? t(lang, `${kind}.subject`, vars), text: custom(templates, key, 'body', vars) ?? t(lang, body, vars) };
}

// One message for several inputs that failed (kind 'alarm') or came back (kind 'recovered') together.
// items: [{ input, cause, start, end, durationMs }]; d: { now, host }.
export function buildGroupAlert(lang, kind, items, d, templates) {
  const when = (ts) => formatDateTime(ts, lang);
  const list = items
    .map((i) => t(lang, `group.${kind}.line`, { input: i.input, cause: t(lang, `cause.${i.cause || 'silence'}`), start: when(i.start), end: i.end ? when(i.end) : '', duration: formatDuration(i.durationMs ?? 0) }))
    .join('\n');
  const vars = { n: items.length, list, now: when(d.now), host: d.host };
  const key = kind === 'alarm' ? 'groupAlarm' : 'groupRecovered';
  return { subject: custom(templates, key, 'subject', vars) ?? t(lang, `group.${kind}.subject`, vars), text: custom(templates, key, 'body', vars) ?? t(lang, `group.${kind}.body`, vars) };
}
