# Dead Air Watchdog

Free desktop app (Windows / macOS / Linux) that listens around the clock to the computer's **sound card** and to **any number of Icecast / Shoutcast streams** at the same time (up to 32 inputs) and sends an alert by **email and/or Telegram** when the level stays below a threshold for longer than N seconds. It lives in the system tray, keeps a local event log (exportable) and charts the silences of the last 7, 14 or 30 days.

By Graziano Melzi · [OnAir Garage](https://onairgarage.com) — contact: hello@onairgarage.com

- Tool page: https://onairgarage.com/tools/dead-air-watchdog/
- License: MIT (see `LICENSE`)
- Categories: Monitoring (primary), On-Air, Streaming

## Features

- **Inputs**: any mix of sound cards / audio interfaces and streams (MP3 / AAC / Ogg Vorbis / Opus URLs), up to 32 in total. Each sound-card input has its own device and its own pair of channels (1–2 by default, or 3–4, 5–6, 7–8), so several cards, or several pairs of the same card, can be monitored together; two cards with the same name are numbered, a device already chosen by another input is marked in the list, a saved device that is gone is shown as "not found" (it is never swapped for another card), and each input in Settings shows its level so you can tell which is which (the streams are opened in hidden audio windows of up to 6 streams each, because the web engine allows only 10 streams per window and 6 per server). Each input has its own **name**, optional **logo**, threshold and alert time, a **yellow delay**, optional **frozen-audio alarm** and **monitoring hours**, and can be **paused for maintenance**; alert channels, alarm sound and heartbeat are shared. Inputs can be added, edited and removed while monitoring runs.
- **Dashboard**: one big traffic light with the worst state of all inputs (green all OK, yellow a countdown is running, red dead air, grey stopped) and one tile per input with its state, countdown and live level meter (RMS per channel, peak hold, threshold marked).
- **Wall display** (clock and date as large as the screen allows, logos small / large / as a soft background, every input from 1 to 32 is shown, the tiles rearrange to fit the screen; long names wrap on two lines and shrink to fit, or use a fixed size; the order is the one of the inputs in Settings, which you can change with ▲ ▼) for an always-on screen in a newsroom, studio or the technical manager's office: full screen, the screen kept awake, one large tile per input and a **glow around the screen edge** — green and slowly breathing while all is well, yellow while a countdown runs, flashing red during dead air (steady under *reduced motion*). The glow can also be shown in the normal window. The app can open straight into it.
- **Settings**: silence threshold (dBFS), minimum silence duration (seconds), alert channels, optional repeat while the alarm lasts.
- **Alerts**: SMTP email (several recipients in one field: **one message with everybody in Bcc**; with a user name the connection must be encrypted) Telegram (several recipients, each with a note) and **HTTP** (a request to an address you choose, POST with JSON or GET, for a studio screen or an automation), always naming the input, a desktop notification and an optional **alarm sound** on the computer: a single sound for all inputs (two-tone beeps with pauses), silenced with one button, re-armed by every new alarm, stopped when the last alarm ends. One alert when dead air starts, one when audio is back (with the duration). The **subject and text of each alert can be your own** (Settings → Alerts → Wording of the alerts, with `{input}`, `{cause}`, `{start}` … placeholders; empty = the text of the app). Failed deliveries are retried for up to 30 minutes, and the dashboard says when an alert could not be delivered (with the reason) until the next one goes through.
- **Names and logos**: the name appears on the tile, in the alerts and in the log; the logo (PNG, JPG, WebP, GIF or SVG up to 5 MB, shrunk to 256 px) on the tile, also in the wall display. Logos are stored as small PNG files in the `logos` folder next to the settings and never leave the computer.
- **Event log**: input, start, end, duration, cause (silence / input offline) and also the periods when nothing was monitored (app closed, computer asleep), the **pauses** and the **micro-silences**. Export to CSV and JSON.
- **Micro-silences**: every drop below the threshold, however short, is logged with time, duration and cause (silence, no data, late measurements), counted per input and in total for today, kept for 30 days by default. No alert is sent for them and the alarm rule does not change: they are there to tune the threshold, to tell a fault of the program from one of the stream or of the network, and to show data to whoever provides the stream.
- **Pause for maintenance**: a button on each tile switches off the alerts of that input for 1 hour or until tomorrow 06:00; it ends by itself, survives a restart and is written in the log. The input is still measured and shown as PAUSED.
- **Yellow after…** (per input, 2 s by default, 0 = as before): the traffic light of the input stays green until the audio has been below the threshold for that long, so the pauses of a speaker do not flash yellow, above all with many inputs on the wall display. Only the colour changes: the red alarm still counts from the first quiet moment, and an input that delivers no data turns yellow at once.
- **Monitoring hours** (per input, Settings → Inputs → More options): days and hours (also past midnight) in which the input is **not monitored** (no alarm, no alert, no sound; it is still measured and shown as PAUSED until the end of the window) or has **its own threshold and time before the alarm**. An alarm that is open when the hours begin is closed in the log without a "back" message; when they end the countdown starts again from there.
- **Frozen-audio alarm** (per input, off by default): the level stays within a small range (1 dB by default) for the time you set (at least 10 s) although it is above the threshold: a steady tone, a stuck loop or constant noise. It has its own cause in the log and in the alerts ("Frozen audio") and ends, with a "back" message, when the level moves again.
- **Summary and common problems** (Event log → Summary): per input the availability (share of the monitored time without dead air; the time the app was not running, pauses and hours switched off do not count), the number of alarms, the total and the longest dead air, for this month, last month or the last 7 / 30 days, with **CSV export**. When at least 3 inputs (or 2 when there are fewer, or 30% of them if that is lower) lose their data or go into alarm within 10 s of each other, the events are marked **Common problem** in the log (and in the CSV, column `common_problem`) and listed under the summary: the cause is probably the network or the computer that monitors, not the stream servers; the table also gives the availability without them.
- **Grouped alerts**: when several inputs fail (or come back) together, the first alert goes out at once and the others within the window (60 s by default) follow in one message with the list.
- **Chart** of dead air per day (7 / 14 / 30 days), for all inputs or one; the log can be filtered by input too.
- **Heartbeat** (optional): while monitoring, the app sends a plain GET to an address you choose every 1–60 minutes. A service that alerts when these requests stop (for example Healthchecks.io) then warns you when the computer is off or asleep, the app crashed or the network is down: things the app cannot report itself.
- **Runs unattended**: tray icon with status colour, start at login, keeps the computer awake while monitoring, automatic reconnection of devices and streams, restart of the audio engine if it stops responding.
- **Languages**: English (always the starting language), Italiano, Español. Dark theme by default, light and system available.
- **Backup of the configuration**: Settings → Configuration backup exports and imports inputs, thresholds, alerts, heartbeat and general settings as `dead-air-watchdog-backup-YYYY-MM-DD.json`. Passwords and tokens (email password, Telegram token, heartbeat address, user name and password inside a stream address) are **left out unless you tick “Include passwords and tokens”** (red warning, plain text, file readable only by you where the system allows it). Import: replace everything, or add only the inputs the computer does not have; then the app lists what must be typed again. The event log and the “already told” flags are not part of the backup.
- **Guided updates**: the app checks the public GitHub releases and shows a banner with *Download and install*, *Remind me later*, *Skip this version* and the release notes; the download has a progress bar and a *Cancel* button and is verified against `SHA256SUMS.txt` (SHA-256); *Close and install* asks first (monitoring stops), makes a safety copy of the settings, starts the installer (Windows), opens the disk image (macOS) or shows the AppImage (Linux); after the update a *What's new* window lists the changes. Nothing is installed without a click. If email or Telegram is on, the app also tells you **once per version and per channel** that a new version is out (switch off with “Tell me by email or Telegram…” in Settings → Updates); a channel counts as told only after the message was delivered, and what was told survives restarts (`alert-state.json`).

- **Help & about**: *Copy support info* (version, system, last check, last error: never settings, addresses or passwords), *Open logs folder*, installation name shown in the alerts, log files per day (7 days, 5 MB each), the window remembers its place and size, a show/hide button on passwords.

## Screenshots

![Dashboard with one input in dead air](docs/screenshots/01-dashboard.png)
![Event log](docs/screenshots/02-event-log.png)
![Alerts settings: email with several recipients, Telegram](docs/screenshots/03-alerts.png)
![Configuration backup and updates](docs/screenshots/04-backup.png)
![Wall display with long names](docs/screenshots/05-wall-display.png)
![Inputs with the buttons to change their order](docs/screenshots/06-inputs-order.png)
![Wall display with 32 inputs](docs/screenshots/07-wall-32-inputs.png)

![Wall display: the large ALL OK](docs/screenshots/17-wall-all-ok.png)
![A field that failed the check, marked in red](docs/screenshots/08-invalid-field.png)
![Micro-silences in the event log](docs/screenshots/09-micro-silences.png)

![Summary: availability per input and common problems](docs/screenshots/18-summary.png)
![Update banner](docs/screenshots/10-update-banner.png)
![Updates settings with the download verified](docs/screenshots/11-update-settings.png)
![Wall display with large logos](docs/screenshots/12-wall-large-logo.png)
![Wall display with a soft logo background](docs/screenshots/13-wall-faded-logo.png)
![An input paused for maintenance](docs/screenshots/14-paused-input.png)
![Welcome screen](docs/screenshots/15-welcome.png)
![Settings in tabs](docs/screenshots/16-settings-general.png)

Invented data only (no real streams, names or addresses). Taken with Chromium on the real window files with a stand-in for the Electron bridge, not from the packaged app: `node dev/make-screenshots.mjs`.

## Install

Download the installer for your system from the [Releases](https://github.com/djgragra/dead-air-watchdog/releases) page and verify it against `SHA256SUMS.txt`. The app is free and **not code-signed**:

- **macOS**: the app is signed ad hoc (no Apple account), so the first start says "unidentified developer": open *System Settings → Privacy & Security*, scroll down and click *Open Anyway* (tested on an Apple Silicon Mac from 26.10.9; earlier versions said "damaged"). **Second method**, in Terminal: `xattr -cr "/Applications/Dead Air Watchdog.app" && codesign --force --deep -s - "/Applications/Dead Air Watchdog.app"` (it also opens an earlier version that says "damaged"; change the name to open another OnAir Garage app).
- **Windows**: if SmartScreen appears, click *More info* → *Run anyway*.
- **Linux**: `chmod +x Dead-Air-Watchdog-*.AppImage`, then run it.

### Why it asks for the microphone

Operating systems treat every audio input (sound card, interface, USB mixer) as a "microphone", so the permission prompt is the same. The app only measures the level ten times per second. It does **not** record, store, play back or send audio. The input is opened with automatic gain, noise suppression and echo cancellation switched off so that the measured level is the real one. Monitoring a stream URL needs no permission.

## How it works

Every 100 ms the audio engine (a hidden window, so it keeps running when the main window is closed) computes the RMS level of each channel in an `AudioWorklet`: `10·log10(mean(x²))`, samples in −1…+1, result in **dBFS**. A full-scale sine reads −3.01 dBFS, a full-scale square wave 0 dBFS. The loudest channel is compared with the threshold; **silence means all channels are below it**.

- Below the threshold → *counting* (yellow). When it lasts at least the configured time → *alarm* (red), alert sent. The silence is dated from its first quiet sample.
- Audio is *back* only after it stays at or above the threshold for **2 s in a row, or 2 s in total within 5 s**: one click in a silent stretch does not restart the countdown, and speech, with pauses below the threshold between the words, counts as audio (before 26.10.8 it could raise a false alarm after the alert time even though somebody was talking).
- If the input delivers nothing (device removed, stream down, engine stalled, no level report for 1.5 s) this counts as dead air with cause **offline**.
- If the process does not run for more than 10 s (sleep, freeze) the countdown is dropped and the period is logged as a monitoring gap.

## Formulas and sources

| Value / formula | Source | Status |
|---|---|---|
| RMS level in dBFS, `10·log10(mean(x²))`, full-scale sine = −3.01 dBFS | Defined by this tool; checked against ffmpeg `astats` (see Validation). Other meters (e.g. the AES17 convention) may differ by +3.01 dB for sine waves; AES17 was **not read** (paid standard): *Dati insufficienti per verificare* | Tool definition |
| Default threshold −50 dBFS, default time 30 s | No official source found. For context, ffmpeg's `silencedetect` defaults are −60 dB and 2 s (ffmpeg filters documentation, read 2026-10-01). Liquidsoap's `blank.detect` defaults could not be read | **Recommended** (common practice) |
| Release time 2 s (in a row, or in total within 5 s), level window 100 ms, stale-input limit 1.5 s | Own design choices | Recommended |
| Yellow delay 2 s by default; frozen audio: tolerance 1 dB, at least 10 s, level kept per second; common problem: window 10 s, at least 3 inputs (or 2 / 30%) | Own design choices; no standard found for any of them. The values are a starting point to tune on real programmes | Recommended |
| Email: one message with the recipients in `bcc` and `to` = sender; `requireTLS` when there is a user name and TLS is not from the start; timeouts 15 s / 15 s / 20 s | nodemailer SMTP options (`nodemailer.com/smtp`); house rule in `apps/COMMON-FEATURES.md` | Dati insufficienti per verificare (nodemailer documentation not read for this release; behaviour checked with a stand-in transport) |
| Telegram bot token format `^\d+:[\w-]{20,}$`, page preview off (`link_preview_options.is_disabled`) | House rule in `apps/COMMON-FEATURES.md`; Bot API | Dati insufficienti per verificare (`link_preview_options` not read for this release) |
| Telegram message limit 4096 characters, `sendMessage` with `chat_id` and `text` | Telegram Bot API 10.3 (24 Aug 2026), read 2026-10-01 | Official |
| Microphone permission on macOS: `NSMicrophoneUsageDescription` and `askForMediaAccess` | Electron `systemPreferences` documentation, read 2026-10-01 | Official |
| Healthchecks.io success pings accept `HEAD`, `GET` or `POST` (used as an example of a service for the heartbeat; the app only sends `GET`) | Healthchecks.io HTTP API documentation, read 2026-10-01 (that page does not describe what happens when pings stop) | Official |
| Keep-awake uses `prevent-app-suspension` (system stays active, screen may turn off) | Electron `powerSaveBlocker` documentation, read 2026-10-01 | Official |

## Assumptions and limits

- Not a certified instrument. The level is a plain RMS value, **not** a loudness (no K-weighting, no gating).
- Each stream is an extra listener on its server and an extra decoder in the app (light for MP3/AAC); several sound cards can be monitored, each input measures one pair of channels (add one input per pair), and every open card is one more capture in the system: the limit is the 32 inputs of the app. Opening more than one card, channel selection and the alarm sound could not be tried with real hardware (a card in exclusive use by another program on Windows cannot be opened; the input then reports it). Pairs beyond 7–8 are not offered.
- The alarm sound plays on the default output. With a microphone input near the speakers the beeps could be picked up; the pauses between bursts (0.36 s of sound, 0.84 s of silence) keep them from being read as returning audio, but a line input is safer.
- A stream is heard like any listener: it shows in the server's listener statistics, it arrives delayed by the stream's buffer, and if the server plays a fallback or filler when the source drops, the monitor sees that audio, not silence.
- HLS (`.m3u8`) streams are not supported by this tool. Shoutcast (ICY) servers and servers with redirects were not tested.
- While the computer is asleep or switched off, or the app is closed, nothing is monitored and no alert can be sent. The app cannot warn you that the computer itself is down: that is what the heartbeat is for. It is an extra request to an address of your choice, sends no data besides the request and a User-Agent, and its address (usually a secret token) is stored encrypted when the keystore is available.
- Email, Telegram and HTTP-alert credentials (the address and the header) are stored in the app's data folder, encrypted with the system keystore (Keychain / DPAPI / libsecret) when available, in clear otherwise. They are only ever sent to your own mail server, to `api.telegram.org` and to the HTTP address you set. A backup written with “Include passwords and tokens” holds them in **plain text**; a sealed value cannot be read on another computer or user account, so a backup never carries it (the app asks to type it again).
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
| Detector unit tests | Counting, alarm, 2 s release, blips, offline cause, abort, live reconfiguration; speech with pauses (no false alarm), yellow delay | 20 cases pass | `node --test dev/detector.test.js` |
| 26.10.8 features (`dev/schedule.test.js`, `dev/frozen.test.js`, `dev/monitor-hours.test.js`, `dev/report.test.js`) | Monitoring hours (windows through midnight, off and custom, an open alarm closes without a message), frozen audio (steady level vs a moving programme, tolerance, end by silence), yellow delay with the real monitor, availability and common problems (gaps, pauses and hours not counted, overlaps, CSV) | 34 cases pass, with a fake clock; the window was also driven in a headless Chromium with a stand-in `api` (wall display 16:9 and 4:3, summary, settings) | `npm test` |
| 26.10.6 features (`dev/features.test.js`) | Micro-silences (cause nodata / late / silence, nothing sent, the alarm time unchanged, kept 30 days and capped), pause (no alarm or alert, ends by itself, survives a restart, an open alarm closes without a message), grouped alerts (first at once, the rest in one list, alarms and recoveries apart, flush on stop), installation name in subject and Telegram text, new settings limits, what a backup keeps on this PC | 22 cases pass, with a fake clock | `node --test dev/features.test.js` |
| Packaged-style run in Electron 44.5.1 on Linux under Xvfb (2026-10-15, local synthetic stream with credentials in the address) | Stream added and saved from the real window; the address with `user:password@` starts masked with an eye button; monitoring started; the silence was counted, a 0.3 s drop was written as a micro-silence; pause and resume from the tile menu (state PAUSED, pause in the log); *Check now* against GitHub; *Copy support info*; the wall display with the large clock; the window position was saved; log file written; no error in the window console | Pass (manual run, screenshots kept out of the repo) | start `node dev/test-stream-server.js 8765 "6@-20,40@off,6@-20"`, then `electron .` and add `http://127.0.0.1:8765/test.wav` |
| Guided update (`dev/updater-guided.test.js`, copied from G-Clock) | Download with a leftover `.part` removed on error, cancel and stall; installer choice per system; banner states (remind, skip); the safety copy keeps 3; install plan per system; What's new from `CHANGELOG.md`; first start versus update | 17 cases pass | `node --test dev/updater-guided.test.js` |
| Signature (`dev/signature.test.js`) | Log files per day with rotation at 5 MB and 7 days; support info without settings and with `~` for the home folder; the `garage-common` headers; every icon file and its size; logo transparency; the changelog entry of the current version | 9 cases pass | `node --test dev/signature.test.js` |
| Engine events | An input that had a transient stream error returns to normal when the engine reports it OK (the fault is routed by input id; it once stayed "offline" forever) | covered by the monitor tests | `node --test dev/monitor.test.js` |
| Monitor with a fake clock | Alert on alarm and on recovery, reminders, gap on suspension, recovery after a crash, retry of failed channels, no credentials in alerts; **several inputs**: independent detectors and thresholds, one log entry and one alert (with the input name) each, a single alarm sound that re-arms on new alarms and stops with the last, adding/removing/disabling inputs while running | 19 cases pass (monitor, retry dispatcher, translations) | `node --test dev/monitor.test.js` |
| 26.10.10 (`dev/templates.test.js`, `dev/engine-devices.test.js`, `dev/store.test.js`, `dev/wall-grid.test.js`, `dev/update-notice.test.js`) | Own alert wording (placeholders, empty = default, frozen and grouped messages, the prefix with the installation name, limits); eight cards open together in the real engine against a stub, one device with several pairs asks the same channels, a missing device and a missing pair are reported; several cards in the store (limit 32 shared with streams) and in the first audio window; the update alert links the site page in each language and never GitHub | Pass | `npm test` |
| 26.10.9 (`dev/webhook.test.js`, `dev/engine-recovery.test.js`, `dev/signature.test.js`) | HTTP alerts against a real local HTTP server: POST JSON and GET fields, the Authorization header, the whole chain from a silent stream to the alarm and recovery requests, a receiver that fails once and is retried, address and token never in an error, settings and secrets (sealed, stripped from a backup); a stream whose first audio comes after 3.3 s is not given up, one that stalls after playing is reported at 3 s; the ad-hoc signature hook is wired in and ignores Windows and Linux | Pass (243 tests); the ad-hoc signature itself was not run (no Mac in the build environment) | `npm test` |
| Notification tests (`dev/notifications.test.js`) | Email: one message, recipients in Bcc, `requireTLS` with a user name, timeouts, rejected addresses named, password masked, incomplete settings; recipients field (separators, repeats, limit of 20) and migration of the old single `to`; Telegram token format, page preview off, one failing recipient does not stop the others and the token never shows; same keys in the three languages | Pass, with a stand-in transport and a stand-in `fetch` | `npm test` |
| Update notice tests (`dev/update-notice.test.js`) | Once per version and channel, three tries, failed send retried at the next check, channel switched on later, nothing without email/Telegram or when switched off, state survives a restart, damaged state file | Pass | `npm test` |
| Backup tests (`dev/backup.test.js`) | File name and fields, no secret without the box, plain secrets with it, sealed values dropped, same server and user keeps the password, replace and add-only, wrong app, damaged or oversized file, limits, the single list of secrets | Pass | `npm test` |
| Alert chain (`dev/alert-chain.test.js`) | A stream going silent and coming back with the real monitor, dispatcher and nodemailer against a local SMTP server: one email for the alarm and one for the recovery, everybody in Bcc; email switched off in the saved settings sends nothing; a refusing server is reported with its reason and the app says it gave up | Pass | `npm test` |
| 26.10.8 tip jar link (`dev/tip.test.js`) | The jar and the Tip jar button share one handler and the same page in the window language; the jar is `aria-hidden` with `tabindex="-1"`; hover tilt and reduced motion in the CSS. Click checked in Chromium on the real `renderer/` files with a stand-in API | Pass | `node --test dev/tip.test.js` |
| 26.10.7 sender and tip card (`dev/notifications.test.js`, `dev/alert-chain.test.js`, `dev/tip.test.js`) | The email "To" is `undisclosed-recipients:;` and the SMTP envelope holds only the real recipients (checked with the real Nodemailer and with a local SMTP server that logs `RCPT TO`): the sender gets no copy unless it is a recipient, and then one; the tip card texts exist in three languages, the link is the site page in the window language, the jar ships in `renderer/` | Pass | `node --test dev/notifications.test.js dev/alert-chain.test.js dev/tip.test.js` |
| Order and wall name size tests (`dev/order.test.js`, `dev/store.test.js`) | Moving an input up or down, the order of the settings is the order of the tiles, the name size setting and its default | Pass | `npm test` |
| Audio windows and wall grid (`dev/wall-grid.test.js`) | How the inputs are split between the hidden audio windows (6 streams or fewer: one window as before; the 12-stream case; 32 streams; the sound card in the first window; moving an input) and the columns and rows of the wall display for 1 to 32 inputs on several window shapes | Pass | `npm test` |
| Streams per window, measured in Chromium 1194 (Playwright, local endless WAV streams) | One page opened 10 streams and no more (even on different hosts), and 6 per host; a plain `fetch` was limited to 6 per host but not in total; separate browser contexts each got their own 10 / 6 | Measured, the reason for the audio windows | `node dev/stream-limits.mjs 24 audio 4 1` (10), `... 24 audio 1 1` (6), `... 10 audio 4 3` (30), `... 24 fetch 4 1` (24) |
| Heartbeat tests | Request is a bare GET with the app's User-Agent, interval, disabled/invalid address sends nothing, errors never contain the secret address, settings limits | 5 cases pass | `node --test dev/heartbeat.test.js` |
| Wall display, logos and several inputs in Electron 44.4.3 | Two local synthetic streams (one falling silent, one steady tone) and one disabled input: only the first raised an alarm, the second stayed green, the disabled tile stayed grey; the wall display went full screen and the red edge glow showed; the glow is absent outside the wall display; a 600×400 PNG and an SVG chosen as logos were shrunk to 256×171 and 256×154, saved and shown on the tiles | Pass (manual run with screenshots, 2026-10-01) | as below, with a second server `node dev/test-stream-server.js 8767 "120@-20"` |
| End-to-end run in Electron 44.4.3 with a local synthetic WAV stream (no CORS headers) played in a loop | Whole chain: stream → engine → worklet → detector → log, CORS workaround, window rendering. The meter read −23.0 dBFS for a −20 dBFS-peak sine; two consecutive 10 s silences were logged as 9.78 s and 9.82 s | Pass (manual run, 2026-10-01) | `node dev/test-stream-server.js 8765 "8@-20,10@off,8@-20"`, then start the app with a stream input `http://127.0.0.1:8765/test.wav`, 3 s alert time |

**Not validated:** the ad-hoc signature of the macOS apps (the build checks it on the Mac runner; whether an installed app from the DMG opens on a clean Apple Silicon Mac must be tried by hand); HTTP alerts against a real studio screen; the 128 kbit/s Winchester stream itself (the cause was measured in Chromium against the real server, the fix is tested with the real engine and a stand-in browser). the author reports having tried the app by hand on Windows and macOS (declared 17 October 2026), including the packaged installers, *Close and install* and the update window, so those items are no longer listed. Still not validated: the 26.10.8 features with real audio (yellow delay with real speech, frozen-audio tolerance on real tones and encoder noise, monitoring hours across a real night, a real network drop shown as a common problem, the summary after weeks of use) and in the installed app; Linux on a real desktop (the run above was `electron .` on Linux under a virtual screen); a flow that falls and comes back with 12 or more real streams; many simultaneous real streams over hours (CPU and memory with 10+ streams); the wall display on a real always-on monitor (burn-in, display sleep, multi-monitor); real sound cards and interfaces (including the channel-pair selection on multichannel devices); whether the alarm sound is audible and at what volume; the heartbeat against a real monitoring service (only a local server was used: one request at start and one for the test button were received); real Icecast / Shoutcast servers; stream formats other than WAV; real email and Telegram delivery, including the grouped message (tested with stubs only: whether real servers accept the Bcc message with the `undisclosed-recipients:;` header (and whether spam filters like it) and refuse a connection that cannot be encrypted was not tried); the new-version notice against a real new release; stability over days.

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
- `src/core/` — pure logic: detector state machine, frozen-audio detector, monitoring hours, availability report and common problems, level conversions, statistics, export, formatting.
- `src/` — store (settings, log), secrets (the one list of secret places), backup, alert-state, update-notice, addresses, logos, monitor (orchestration), heartbeat, notifications, updater, messages.
- `renderer/` — the window (`index.html`, `app.js`, `i18n.js`, `style.css`) and the audio engine (`engine.html`, `engine.js`, `level-worklet.js`).
- `dev/` — tests, the synthetic stream server, the icon generator and the screenshot script.

Settings and the event log are in the OS user-data folder (`alert-state.json`, what the alerts already said, sits next to them) (`~/Library/Application Support/dead-air-watchdog` on macOS, `%APPDATA%\dead-air-watchdog` on Windows, `~/.config/dead-air-watchdog` on Linux).

## Credits

No third-party fonts or assets. Dependencies: [nodemailer](https://nodemailer.com) (MIT-0), [Electron](https://www.electronjs.org) (MIT). Versions are `YY.M.N` (e.g. `26.10.1`), tags `vYY.M.N`.

## Italiano

App gratuita che ascolta giorno e notte un ingresso audio del computer o uno stream Icecast/Shoutcast e invia un avviso via email e/o Telegram se il livello resta sotto soglia per più di N secondi. Registro eventi locale esportabile, grafico dei silenzi a 7/14/30 giorni, riepilogo con la disponibilità per ingresso (anche in CSV) e segnalazione dei problemi comuni (più ingressi giù insieme: probabile problema di rete o del computer). Giallo con ritardo, orari di monitoraggio e allarme per audio bloccato, per ogni ingresso. Dashboard e Wall display per uno schermo sempre acceso. Più destinatari email in un solo messaggio (tutti in Bcc), backup della configurazione (password e token esclusi di default) e avviso su email/Telegram quando esce una nuova versione. L'app non è firmata: su macOS usa clic destro → Apri; su Windows SmartScreen → «Ulteriori informazioni» → «Esegui comunque». Non è uno strumento certificato.

## License

[MIT](LICENSE) © 2026 Graziano Melzi
