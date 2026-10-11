# Dead Air Watchdog

Free desktop app (Windows / macOS / Linux) that listens around the clock to the computer's **sound card** and to **any number of Icecast / Shoutcast streams** at the same time (up to 32 inputs) and sends an alert by **email and/or Telegram** when the level stays below a threshold for longer than N seconds. It lives in the system tray, keeps a local event log (exportable) and charts the silences of the last 7, 14 or 30 days.

By Graziano Melzi · [OnAir Garage](https://onairgarage.com) — contact: hello@onairgarage.com

- Tool page: https://onairgarage.com/tools/dead-air-watchdog/
- License: MIT (see `LICENSE`)
- Categories: Monitoring (primary), On-Air, Streaming

## Features

- **Inputs**: one sound card / audio interface (channels 1–2 by default, or another pair: 3–4, 5–6, 7–8) and any number of streams (MP3 / AAC / Ogg Vorbis / Opus URLs), up to 32 in total. Each input has its own **name**, optional **logo**, threshold and alert time; alert channels, alarm sound and heartbeat are shared. Inputs can be added, edited and removed while monitoring runs.
- **Dashboard**: one big traffic light with the worst state of all inputs (green all OK, yellow a countdown is running, red dead air, grey stopped) and one tile per input with its state, countdown and live level meter (RMS per channel, peak hold, threshold marked).
- **Wall display** for an always-on screen in a newsroom, studio or the technical manager's office: full screen, the screen kept awake, one large tile per input and a **glow around the screen edge** — green and slowly breathing while all is well, yellow while a countdown runs, flashing red during dead air (steady under *reduced motion*). The glow can also be shown in the normal window. The app can open straight into it.
- **Settings**: silence threshold (dBFS), minimum silence duration (seconds), alert channels, optional repeat while the alarm lasts.
- **Alerts**: SMTP email (several recipients in one field: **one message with everybody in Bcc**; with a user name the connection must be encrypted) and Telegram (several recipients, each with a note), always naming the input, a desktop notification and an optional **alarm sound** on the computer: a single sound for all inputs (two-tone beeps with pauses), silenced with one button, re-armed by every new alarm, stopped when the last alarm ends. One alert when dead air starts, one when audio is back (with the duration). Failed deliveries are retried for up to 30 minutes.
- **Names and logos**: the name appears on the tile, in the alerts and in the log; the logo (PNG, JPG, WebP, GIF or SVG up to 5 MB, shrunk to 256 px) on the tile, also in the wall display. Logos are stored as small PNG files in the `logos` folder next to the settings and never leave the computer.
- **Event log**: input, start, end, duration, cause (silence / input offline) and also the periods when nothing was monitored (app closed, computer asleep). Export to CSV and JSON.
- **Chart** of dead air per day (7 / 14 / 30 days), for all inputs or one; the log can be filtered by input too.
- **Heartbeat** (optional): while monitoring, the app sends a plain GET to an address you choose every 1–60 minutes. A service that alerts when these requests stop (for example Healthchecks.io) then warns you when the computer is off or asleep, the app crashed or the network is down: things the app cannot report itself.
- **Runs unattended**: tray icon with status colour, start at login, keeps the computer awake while monitoring, automatic reconnection of devices and streams, restart of the audio engine if it stops responding.
- **Languages**: English (always the starting language), Italiano, Español. Dark theme by default, light and system available.
- **Backup of the configuration**: Settings → Configuration backup exports and imports inputs, thresholds, alerts, heartbeat and general settings as `dead-air-watchdog-backup-YYYY-MM-DD.json`. Passwords and tokens (email password, Telegram token, heartbeat address, user name and password inside a stream address) are **left out unless you tick “Include passwords and tokens”** (red warning, plain text, file readable only by you where the system allows it). Import: replace everything, or add only the inputs the computer does not have; then the app lists what must be typed again. The event log and the “already told” flags are not part of the backup.
- **Guided updates**: the app checks the public GitHub releases, downloads the installer for your system, verifies its SHA-256 against `SHA256SUMS.txt` and shows it to you. Nothing is installed automatically. If email or Telegram is on, the app also tells you **once per version and per channel** that a new version is out (switch off with “Tell me by email or Telegram…” in Settings → Updates); a channel counts as told only after the message was delivered, and what was told survives restarts (`alert-state.json`).

## Screenshots

![Dashboard with one input in dead air](docs/screenshots/01-dashboard.png)
![Event log](docs/screenshots/02-event-log.png)
![Alerts settings: email with several recipients, Telegram](docs/screenshots/03-alerts.png)
![Configuration backup and updates](docs/screenshots/04-backup.png)

Invented data only (no real streams, names or addresses). Taken with Chromium on the real window files with a stand-in for the Electron bridge, not from the packaged app: `node dev/make-screenshots.mjs`.

## Install

Download the installer for your system from the [Releases](https://github.com/djgragra/dead-air-watchdog/releases) page and verify it against `SHA256SUMS.txt`. The app is free and **not code-signed**:

- **macOS**: if you see "app is damaged", right-click the app → *Open*, or run `xattr -dr com.apple.quarantine "/Applications/Dead Air Watchdog.app"`.
- **Windows**: if SmartScreen appears, click *More info* → *Run anyway*.
- **Linux**: `chmod +x Dead-Air-Watchdog-*.AppImage`, then run it.

### Why it asks for the microphone

Operating systems treat every audio input (sound card, interface, USB mixer) as a "microphone", so the permission prompt is the same. The app only measures the level ten times per second. It does **not** record, store, play back or send audio. The input is opened with automatic gain, noise suppression and echo cancellation switched off so that the measured level is the real one. Monitoring a stream URL needs no permission.

## How it works

Every 100 ms the audio engine (a hidden window, so it keeps running when the main window is closed) computes the RMS level of each channel in an `AudioWorklet`: `10·log10(mean(x²))`, samples in −1…+1, result in **dBFS**. A full-scale sine reads −3.01 dBFS, a full-scale square wave 0 dBFS. The loudest channel is compared with the threshold; **silence means all channels are below it**.

- Below the threshold → *counting* (yellow). When it lasts at least the configured time → *alarm* (red), alert sent. The silence is dated from its first quiet sample.
- Audio is *back* only after it stays at or above the threshold for **2 s**, so one click in a silent stretch does not restart the countdown.
- If the input delivers nothing (device removed, stream down, engine stalled, no level report for 1.5 s) this counts as dead air with cause **offline**.
- If the process does not run for more than 10 s (sleep, freeze) the countdown is dropped and the period is logged as a monitoring gap.

## Formulas and sources

| Value / formula | Source | Status |
|---|---|---|
| RMS level in dBFS, `10·log10(mean(x²))`, full-scale sine = −3.01 dBFS | Defined by this tool; checked against ffmpeg `astats` (see Validation). Other meters (e.g. the AES17 convention) may differ by +3.01 dB for sine waves; AES17 was **not read** (paid standard): *Dati insufficienti per verificare* | Tool definition |
| Default threshold −50 dBFS, default time 30 s | No official source found. For context, ffmpeg's `silencedetect` defaults are −60 dB and 2 s (ffmpeg filters documentation, read 2026-10-01). Liquidsoap's `blank.detect` defaults could not be read | **Recommended** (common practice) |
| Release time 2 s, level window 100 ms, stale-input limit 1.5 s | Own design choices | Recommended |
| Email: one message with the recipients in `bcc` and `to` = sender; `requireTLS` when there is a user name and TLS is not from the start; timeouts 15 s / 15 s / 20 s | nodemailer SMTP options (`nodemailer.com/smtp`); house rule in `apps/COMMON-FEATURES.md` | Dati insufficienti per verificare (nodemailer documentation not read for this release; behaviour checked with a stand-in transport) |
| Telegram bot token format `^\d+:[\w-]{20,}$`, page preview off (`link_preview_options.is_disabled`) | House rule in `apps/COMMON-FEATURES.md`; Bot API | Dati insufficienti per verificare (`link_preview_options` not read for this release) |
| Telegram message limit 4096 characters, `sendMessage` with `chat_id` and `text` | Telegram Bot API 10.3 (24 Aug 2026), read 2026-10-01 | Official |
| Microphone permission on macOS: `NSMicrophoneUsageDescription` and `askForMediaAccess` | Electron `systemPreferences` documentation, read 2026-10-01 | Official |
| Healthchecks.io success pings accept `HEAD`, `GET` or `POST` (used as an example of a service for the heartbeat; the app only sends `GET`) | Healthchecks.io HTTP API documentation, read 2026-10-01 (that page does not describe what happens when pings stop) | Official |
| Keep-awake uses `prevent-app-suspension` (system stays active, screen may turn off) | Electron `powerSaveBlocker` documentation, read 2026-10-01 | Official |

## Assumptions and limits

- Not a certified instrument. The level is a plain RMS value, **not** a loudness (no K-weighting, no gating).
- Each stream is an extra listener on its server and an extra decoder in the app (light for MP3/AAC); only one sound card can be monitored. Only one pair of channels of a device is measured (choose which in the settings). Channel selection and the alarm sound could not be tried with real multichannel hardware.
- The alarm sound plays on the default output. With a microphone input near the speakers the beeps could be picked up; the pauses between bursts (0.36 s of sound, 0.84 s of silence) keep them from being read as returning audio, but a line input is safer.
- A stream is heard like any listener: it shows in the server's listener statistics, it arrives delayed by the stream's buffer, and if the server plays a fallback or filler when the source drops, the monitor sees that audio, not silence.
- HLS (`.m3u8`) streams are not supported by this tool. Shoutcast (ICY) servers and servers with redirects were not tested.
- While the computer is asleep or switched off, or the app is closed, nothing is monitored and no alert can be sent. The app cannot warn you that the computer itself is down: that is what the heartbeat is for. It is an extra request to an address of your choice, sends no data besides the request and a User-Agent, and its address (usually a secret token) is stored encrypted when the keystore is available.
- Email and Telegram credentials are stored in the app's data folder, encrypted with the system keystore (Keychain / DPAPI / libsecret) when available, in clear otherwise. They are only ever sent to your own mail server and to `api.telegram.org`. A backup written with “Include passwords and tokens” holds them in **plain text**; a sealed value cannot be read on another computer or user account, so a backup never carries it (the app asks to type it again).
- A new-version notice needs the app to be running when the check happens (at start and every 24 hours); machines left on an older version without this feature cannot announce anything until they are updated by hand.

## Validation and references

Results as of October 2026 (macOS, Node 24, Electron 44.4.3, ffmpeg 9.0.1). Run everything with `npm test` (`node --test dev/*.test.js`).

| Reference | What it validates | Result | How to re-run |
|---|---|---|---|
| Synthetic sine at −6 / −20 / −40 / −60 dBFS peak, theory `peak − 3.0103` | Level formula of `renderer/level-worklet.js` (the real file, run in a stub of the AudioWorklet scope) | Matches theory within 0.05 dB | `node --test dev/level-worklet.test.js` |
| ffmpeg 9.0.1 `astats` (independent implementation) on the same signals | Same levels, measured independently | −9.011 / −23.010 / −43.005 / −63.048 dBFS (worklet) vs −9.010 / −23.010 / −43.005 / −63.048 (ffmpeg): within 0.002 dB | `node --test dev/ffmpeg-validation.test.js` (skipped if ffmpeg is missing) |
| ffmpeg `silencedetect` (−50 dB, 3 s) on tone 8 s / digital silence 10 s / tone 8 s | Silence start and duration seen by the detector | Start 8.0 s vs 8.0 s; duration 9.8 s vs 10.0 s (the detector reports the end after its 100 ms block and 0.2 s of evaluation; tolerance ±0.25 s) | same file |
| Settings tests | Inputs list (ids, one sound card at most, limit of 32, defaults), migration of the single-input settings, sealed secrets in every input, display settings | 10 cases pass | `node --test dev/store.test.js` |
| Logo store tests | Only small PNG data URLs are accepted (signature, size, 512 px limit), ids cannot leave the folder, damaged files are ignored, logos of deleted inputs are pruned | 4 cases pass | `node --test dev/logos.test.js` |
| Detector unit tests | Counting, alarm, 2 s release, blips, offline cause, abort, live reconfiguration | 13 cases pass | `node --test dev/detector.test.js` |
| Engine events | An input that had a transient stream error returns to normal when the engine reports it OK (the fault is routed by input id; it once stayed "offline" forever) | covered by the monitor tests | `node --test dev/monitor.test.js` |
| Monitor with a fake clock | Alert on alarm and on recovery, reminders, gap on suspension, recovery after a crash, retry of failed channels, no credentials in alerts; **several inputs**: independent detectors and thresholds, one log entry and one alert (with the input name) each, a single alarm sound that re-arms on new alarms and stops with the last, adding/removing/disabling inputs while running | 19 cases pass (monitor, retry dispatcher, translations) | `node --test dev/monitor.test.js` |
| Notification tests (`dev/notifications.test.js`) | Email: one message, recipients in Bcc, `requireTLS` with a user name, timeouts, rejected addresses named, password masked, incomplete settings; recipients field (separators, repeats, limit of 20) and migration of the old single `to`; Telegram token format, page preview off, one failing recipient does not stop the others and the token never shows; same keys in the three languages | Pass, with a stand-in transport and a stand-in `fetch` | `npm test` |
| Update notice tests (`dev/update-notice.test.js`) | Once per version and channel, three tries, failed send retried at the next check, channel switched on later, nothing without email/Telegram or when switched off, state survives a restart, damaged state file | Pass | `npm test` |
| Backup tests (`dev/backup.test.js`) | File name and fields, no secret without the box, plain secrets with it, sealed values dropped, same server and user keeps the password, replace and add-only, wrong app, damaged or oversized file, limits, the single list of secrets | Pass | `npm test` |
| Heartbeat tests | Request is a bare GET with the app's User-Agent, interval, disabled/invalid address sends nothing, errors never contain the secret address, settings limits | 5 cases pass | `node --test dev/heartbeat.test.js` |
| Wall display, logos and several inputs in Electron 44.4.3 | Two local synthetic streams (one falling silent, one steady tone) and one disabled input: only the first raised an alarm, the second stayed green, the disabled tile stayed grey; the wall display went full screen and the red edge glow showed; the glow is absent outside the wall display; a 600×400 PNG and an SVG chosen as logos were shrunk to 256×171 and 256×154, saved and shown on the tiles | Pass (manual run with screenshots, 2026-10-01) | as below, with a second server `node dev/test-stream-server.js 8767 "120@-20"` |
| End-to-end run in Electron 44.4.3 with a local synthetic WAV stream (no CORS headers) played in a loop | Whole chain: stream → engine → worklet → detector → log, CORS workaround, window rendering. The meter read −23.0 dBFS for a −20 dBFS-peak sine; two consecutive 10 s silences were logged as 9.78 s and 9.82 s | Pass (manual run, 2026-10-01) | `node dev/test-stream-server.js 8765 "8@-20,10@off,8@-20"`, then start the app with a stream input `http://127.0.0.1:8765/test.wav`, 3 s alert time |

**Not validated**: many simultaneous real streams over hours (CPU and memory with 10+ streams); the wall display on a real always-on monitor (burn-in, display sleep, multi-monitor); real sound cards and interfaces (including the channel-pair selection on multichannel devices); whether the alarm sound is audible and at what volume; the heartbeat against a real monitoring service (only a local server was used: one request at start and one for the test button were received); real Icecast / Shoutcast servers; stream formats other than WAV; the packaged installers and the first-run permission prompts; Windows and Linux builds; real email and Telegram delivery (tested with stubs only: whether real servers accept the Bcc message and refuse a connection that cannot be encrypted was not tried); the backup buttons, the file dialogs and the “Include passwords and tokens” export in the packaged app (the Electron binary could not be downloaded where release 26.10.2 was prepared: the new settings cards were checked only in Chromium with a stand-in bridge, and the save/open dialogs, `safeStorage` sealing and the file permission were never run); the new-version notice against a real new release; stability over days.

## Sources to re-check

Last read on 2026-10-01:

| Document | Version read |
|---|---|
| nodemailer SMTP documentation (`nodemailer.com/smtp`) | not read for this release |
| Telegram Bot API (`core.telegram.org/bots/api`) | 10.3, 24 August 2026 |
| Electron docs: `systemPreferences`, `powerSaveBlocker` | latest at the date (app built with Electron 44.4.3) |
| FFmpeg filters documentation: `silencedetect`, `astats` | online documentation at the date; local ffmpeg 9.0.1 |
| Healthchecks.io HTTP API (`healthchecks.io/docs/http_api/`) | online page at the date, no version shown |
| Liquidsoap `blank.detect` defaults | not read (page content not retrievable) |
| AES17 (dBFS convention) | not read (paid standard) |

## Run locally

Requires [Node.js](https://nodejs.org) 20+.

```bash
npm install
npm start
```

Tests: `npm test`. Installers (output in `release/`): `npm run dist:win`, `npm run dist:mac`, `npm run dist:linux`. Releases are built by GitHub Actions when a `v*` tag is pushed. Icons are generated by `python3 dev/make-icons.py`. Screenshots: `node dev/make-screenshots.mjs` (needs Playwright with Chromium; not a dependency of the app).

## Structure

- `main.js`, `preload.cjs`, `engine-preload.cjs` — Electron main process and bridges.
- `src/core/` — pure logic: detector state machine, level conversions, statistics, export, formatting.
- `src/` — store (settings, log), secrets (the one list of secret places), backup, alert-state, update-notice, addresses, logos, monitor (orchestration), heartbeat, notifications, updater, messages.
- `renderer/` — the window (`index.html`, `app.js`, `i18n.js`, `style.css`) and the audio engine (`engine.html`, `engine.js`, `level-worklet.js`).
- `dev/` — tests, the synthetic stream server, the icon generator and the screenshot script.

Settings and the event log are in the OS user-data folder (`alert-state.json`, what the alerts already said, sits next to them) (`~/Library/Application Support/dead-air-watchdog` on macOS, `%APPDATA%\dead-air-watchdog` on Windows, `~/.config/dead-air-watchdog` on Linux).

## Credits

No third-party fonts or assets. Dependencies: [nodemailer](https://nodemailer.com) (MIT-0), [Electron](https://www.electronjs.org) (MIT). Versions are `YY.M.N` (e.g. `26.10.1`), tags `vYY.M.N`.

## Italiano

App gratuita che ascolta giorno e notte un ingresso audio del computer o uno stream Icecast/Shoutcast e invia un avviso via email e/o Telegram se il livello resta sotto soglia per più di N secondi. Registro eventi locale esportabile, grafico dei silenzi a 7/14/30 giorni. Più destinatari email in un solo messaggio (tutti in Bcc), backup della configurazione (password e token esclusi di default) e avviso su email/Telegram quando esce una nuova versione. L'app non è firmata: su macOS usa clic destro → Apri; su Windows SmartScreen → «Ulteriori informazioni» → «Esegui comunque». Non è uno strumento certificato.

## License

[MIT](LICENSE) © 2026 Graziano Melzi
