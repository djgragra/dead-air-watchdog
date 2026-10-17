# Changelog

## 26.10.8 — 2026-10-17

- The tip jar in Help & about is a link too: a click on the jar does what the Tip jar button does.
- Dependencies: `http-cache-semantics` 4.2.0 → 4.3.0 (patch, build tooling only; clears the one "high" audit advisory). No other minor or patch update was available.
- Tests: 187 (2 new: the jar has the same handler and the three links as the button, and is hidden from keyboard and screen readers; hover and reduced motion).

## 26.10.7 — 2026-10-17

- **Alerts by email no longer go to the sender.** The message used the sender's own address in "To" with the real recipients in Bcc, so the mailbox of the sender received a copy of every alert (two mailboxes read by the same person meant every alert twice). "To" is now `undisclosed-recipients:;` and only the real recipients are in the message envelope. A sender that is also a recipient still gets one copy.
- **Tip card** in Help & about, at the bottom: the tip jar of the site, one line and a *Tip jar* button that opens the site page in your language. No pop-up, no reminder, nothing in the main window.
- **Shared `updater` module** unchanged (version 2). Dependencies updated: Electron 44.9.0, Nodemailer 10.1.2.
- Tests: 185 (4 new: the envelope with the real Nodemailer, a sender that is also a recipient, the tip card texts, link and packaging).

## 26.10.6 — 2026-10-15

- **New logo and new look.** The logo is drawn as SVG (`assets/logo.svg`, `assets/tray.svg`): level bars fading to a flat line above the three lamps of the traffic light; the app icons (Windows, macOS, Linux), the colour tray icons and the single-colour macOS menu-bar glyph are generated from it with `dev/make-icons.mjs`. The window has a header with the status pill (OK, silence, dead air, paused), softer cards and tiles, icon buttons, small transitions (off when the system asks for less motion), a light theme with more contrast, a welcome screen with the logo and settings in tabs (General, Inputs, Alerts, Updates, Backup). What the app does with the audio is unchanged.
- **Wall display: big logos.** Settings → General → Display → "Logo in the wall display": small next to the name (as before), **large** (a big column at the left of the tile) or a **soft background** behind the tile with adjustable strength. A logo with a transparent background (most PNG, SVG, WebP) no longer sits on a white box, anywhere; one that fills its picture keeps a light box so that it stays readable.
- **Wall display: clock and date as large as possible.** The time takes the top of the screen, the date under it in full; "Clock and date in the wall display" can also be Large or Normal.
- **Micro-silences.** Every drop below the threshold, however short, is now written in the event log with the time, the duration and the cause: silence (data with a low level), no data (the input stopped) or late measurements (nothing arrived for over 1.5 s: often an overloaded computer). No email or Telegram is sent for them and the moment the alarm starts does not change. Each tile counts them for today (click to see them), the dashboard shows the total, the log has a "Micro-silences" filter and the export includes them. They are kept for 30 days (Settings → General).
- **Pause the alerts of one input** (maintenance): a pause button on each tile, for 1 hour or until tomorrow 06:00. It ends by itself, so it cannot stay off by mistake and survives a restart. While paused the input is still measured and shown (PAUSED, also in the wall display) but nothing is judged, sent or sounded; the pause is written in the log; an alarm that was open ends there without a "back" message.
- **Grouped alerts.** When several inputs fail (or come back) together, the first alert goes out at once and the others within the window (60 s) follow in **one message with the list**, for the alarms and for the recoveries. Settings → Alerts: switch it off, change the window, or make the first one wait too.
- **Guided update.** The same flow as the other OnAir Garage apps: a banner with *Download and install*, *Remind me later*, *Skip this version* and the release notes; a progress bar with *Cancel*; the file is verified (SHA-256); *Close and install* (Windows starts the installer and the app quits; macOS opens the disk image; Linux shows the AppImage), after a confirmation because monitoring stops; a safety copy of the settings first (the last 3 are kept); after the update a **What's new** window and a notice. Last check and *Check now* are in Settings → Updates. Version 2 of the shared `updater` module: an interrupted or cancelled download no longer leaves a `.part` file behind.
- **Signature of the OnAir Garage apps.** A show/hide button on the email password, the Telegram token and on stream addresses that carry credentials; **name of this installation** (alerts start with `[Dead Air Watchdog · name]`, the computer name by default); Help & about with *Copy support info* (never settings, addresses or passwords), *Open logs folder* and *Check for updates*; log files per day (7 days, 5 MB each) in the `logs` folder; the window remembers its place and size.
- Tests: 178 (49 new cases: micro-silences, pause, grouped alerts, installation name, settings limits, backup keeps the machine-specific keys, updater v2, logs, support info, the icon files, logo transparency, the changelog entry).

## 26.10.5 — 2026-10-12

- **A stream that comes back turns green again.** When a stream stopped delivering data the input went to "dead air" and the alerts went out, but when the data resumed the tile and the wall display stayed red (and the recovery message could be missing) even though the meters were moving again. The web engine tells the app "stalled" when the data stops but does not say "playing" again when it resumes, and the app was waiting for that. Now the app also takes playback time moving again as proof that the audio is back. Sound cards and microphones were not affected.
- Tests: a stream that stalls and resumes (back to OK once), one that stalls and does not move (stays in fault), and the stall-then-wait-then-play case; they run the real `engine.js` against a stub of the browser audio.

## 26.10.4 — 2026-10-12

- **More than 10 streams.** With 12 streams switched on, two of them stayed "dead air", and moving them around moved the problem: the web engine inside the app opens at most 10 streams at a time (and at most 6 to the same server). The app now opens the streams in several hidden audio windows, up to 6 streams each, so all of them connect (up to 32 inputs). With 6 streams or fewer nothing changes: there is still a single window.
- **Wall display with many inputs.** Every input is now shown, from 1 up to 32: the tiles rearrange in the number of columns and rows that gives the biggest tiles, and their text scales with the tile. Before, only the first 8 fitted and the others were cut.
- **A field that fails the check is marked.** When saving is refused (for example a stream address without `http://`), the field itself turns red, its input is outlined, the message under it is red and the cursor goes to it. The same for the heartbeat address.
- Tests: how the inputs are split between the audio windows (the 12-stream case, 32 streams, the sound card, moving an input) and how the wall display picks columns and rows for 1 to 32 inputs.

## 26.10.3 — 2026-10-11

Thanks to Richard, who tried 26.10.2 on a real set of Icecast mounts and wrote to us with what did not work and what he missed: this release is made of his notes.

- **Long names in the wall display.** Mount and station names are no longer cut: they wrap on two lines and, in the new automatic mode, shrink until they fit; the same goes for the big line at the top ("DEAD AIR · name"). Settings → General → "Names in the wall display" also offers fixed sizes (large, medium, small). The dashboard tiles show the full name as a tooltip.
- **Order of the inputs.** Every input in Settings has ▲ ▼ buttons to move it up or down; the dashboard and the wall display follow the same order once you save.
- **Alerts that fail are no longer silent.** If an alert cannot be delivered (by email or Telegram) the dashboard now says so, with the reason from the server, and keeps trying as before; the notice goes away at the next delivery. Failures used to be written only in a log that the window never showed.
- **"Send test" is clearer about what is saved.** The test uses what is on the screen, while real alerts use the saved settings and only when the channel is switched on. When they differ the result now says it ("not saved yet: press Save settings", or "this channel is switched off"). If saving is refused because a field is wrong, the bar says "Not saved" and scrolls to the field.
- Tests: the whole chain from a stream going silent to the email on the wire (alarm and recovery, everybody in Bcc), the failure report, the order of the inputs and the new setting.

## 26.10.2 — 2026-10-11

- **Email to several people in one message.** The email settings take several recipients in one field (commas, spaces or new lines); one message is sent with everybody in **Bcc**, so nobody sees the other addresses. Addresses that are not valid or are repeated are left out and the app says which. The old single "To" field is converted at the first start, nothing is lost. If the server refuses an address the error names it.
- **Encrypted connection required with a user name.** With an SMTP user name the connection must be encrypted (STARTTLS, or TLS from the start): the password never travels in clear text. The email password is hidden (`***`) in error messages and in the log.
- **Telegram**: the bot token format is checked before sending and link previews are off.
- **New-version notice** by email and Telegram, once per version and per channel, switched on by default when email or Telegram is on (Settings → Updates). A channel counts as told only after the message was delivered, and what was told is kept across restarts in its own file, `alert-state.json`.
- **Configuration backup**: Settings → Configuration backup exports and imports the configuration as `dead-air-watchdog-backup-YYYY-MM-DD.json`. Passwords and tokens are left out unless you tick "Include passwords and tokens" (red warning, plain text). Import either replaces everything or adds only the inputs the computer does not have, then lists what must be typed again. The event log is not part of the backup.
- Help, README and screenshots updated; texts in English, Italian and Spanish.
- Retries of the dead-air alerts are unchanged: 30 s, 1 min, then every 2 min, for up to 30 minutes.

## 26.10.1 — 2026-10-02

- First version published with this numbering: silence monitor for a sound card and any number of Icecast / Shoutcast streams, alerts by email and Telegram, wall display, event log and chart, heartbeat, guided updates. The app starts with no inputs and no accounts.
