// Texts used by the main process (alerts, tray, dialogs), in the three app languages.
// The window has its own table in renderer/i18n.js.
import { formatDuration, formatDateTime } from './core/format.js';

const MSG = {
  en: {
    'cause.silence': 'silence (audio below the threshold)',
    'cause.offline': 'input offline (no audio delivered)',
    'alarm.subject': '[Dead Air Watchdog] DEAD AIR: {input}',
    'alarm.body': 'Dead air on "{input}".\nCause: {cause}\nStarted: {start}\nThreshold: {threshold} dBFS, alert after {seconds} s.\nAlert sent: {now}\nMachine: {host}',
    'reminder.subject': '[Dead Air Watchdog] STILL DEAD AIR: {input}',
    'reminder.body': 'Still dead air on "{input}" for {duration}.\nCause: {cause}\nStarted: {start}\nMachine: {host}',
    'recovered.subject': '[Dead Air Watchdog] Audio back: {input}',
    'recovered.body': 'Audio is back on "{input}".\nFrom {start} to {end}\nDuration: {duration}\nMachine: {host}',
    'test.subject': '[Dead Air Watchdog] Test message',
    'test.body': 'Test message from Dead Air Watchdog. The channel works.',
    'err.emailIncomplete': 'Email settings incomplete (server or recipients missing)',
    'err.telegramIncomplete': 'Telegram settings incomplete (bot token or recipients missing)',
    'err.telegramFailed': 'Telegram not delivered to: ',
    'tray.open': 'Open Dead Air Watchdog',
    'tray.start': 'Start monitoring',
    'tray.stop': 'Stop monitoring',
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
    'alarm.subject': '[Dead Air Watchdog] DEAD AIR: {input}',
    'alarm.body': 'Dead air su "{input}".\nCausa: {cause}\nInizio: {start}\nSoglia: {threshold} dBFS, avviso dopo {seconds} s.\nAvviso inviato: {now}\nMacchina: {host}',
    'reminder.subject': '[Dead Air Watchdog] ANCORA DEAD AIR: {input}',
    'reminder.body': 'Ancora dead air su "{input}" da {duration}.\nCausa: {cause}\nInizio: {start}\nMacchina: {host}',
    'recovered.subject': '[Dead Air Watchdog] Audio ripristinato: {input}',
    'recovered.body': 'L\'audio è tornato su "{input}".\nDa {start} a {end}\nDurata: {duration}\nMacchina: {host}',
    'test.subject': '[Dead Air Watchdog] Messaggio di prova',
    'test.body': 'Messaggio di prova da Dead Air Watchdog. Il canale funziona.',
    'err.emailIncomplete': 'Impostazioni email incomplete (server o destinatari mancanti)',
    'err.telegramIncomplete': 'Impostazioni Telegram incomplete (token del bot o destinatari mancanti)',
    'err.telegramFailed': 'Telegram non consegnato a: ',
    'tray.open': 'Apri Dead Air Watchdog',
    'tray.start': 'Avvia il monitoraggio',
    'tray.stop': 'Ferma il monitoraggio',
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
    'alarm.subject': '[Dead Air Watchdog] DEAD AIR: {input}',
    'alarm.body': 'Dead air en "{input}".\nCausa: {cause}\nInicio: {start}\nUmbral: {threshold} dBFS, aviso tras {seconds} s.\nAviso enviado: {now}\nEquipo: {host}',
    'reminder.subject': '[Dead Air Watchdog] SIGUE EL DEAD AIR: {input}',
    'reminder.body': 'Sigue el dead air en "{input}" desde hace {duration}.\nCausa: {cause}\nInicio: {start}\nEquipo: {host}',
    'recovered.subject': '[Dead Air Watchdog] Audio recuperado: {input}',
    'recovered.body': 'El audio ha vuelto en "{input}".\nDe {start} a {end}\nDuración: {duration}\nEquipo: {host}',
    'test.subject': '[Dead Air Watchdog] Mensaje de prueba',
    'test.body': 'Mensaje de prueba de Dead Air Watchdog. El canal funciona.',
    'err.emailIncomplete': 'Ajustes de correo incompletos (falta servidor o destinatarios)',
    'err.telegramIncomplete': 'Ajustes de Telegram incompletos (falta el token del bot o destinatarios)',
    'err.telegramFailed': 'Telegram no entregado a: ',
    'tray.open': 'Abrir Dead Air Watchdog',
    'tray.start': 'Iniciar la monitorización',
    'tray.stop': 'Detener la monitorización',
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

// Builds subject and body of an alert. kind: 'alarm' | 'reminder' | 'recovered'.
export function buildAlert(lang, kind, d) {
  const when = (ts) => formatDateTime(ts, lang);
  const vars = {
    input: d.input,
    cause: t(lang, `cause.${d.cause || 'silence'}`),
    start: when(d.start),
    end: d.end ? when(d.end) : '',
    now: when(d.now),
    threshold: d.thresholdDb,
    seconds: d.minSilenceSec,
    duration: formatDuration(d.durationMs ?? 0),
    host: d.host
  };
  return { subject: t(lang, `${kind}.subject`, vars), text: t(lang, `${kind}.body`, vars) };
}
