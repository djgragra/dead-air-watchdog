# Dead Air Watchdog manual

Dead Air Watchdog listens around the clock to the computer's **sound card** and to **any number of Icecast / Shoutcast streams** at the same time (up to 32 inputs) and sends an alert by **email, Telegram and/or HTTP** when the level stays below a threshold for longer than N seconds. It lives in the system tray, keeps a local event log (exportable) and charts the silences of the last 7, 14 or 30 days. It is a free desktop app for Windows, macOS and Linux from OnAir Garage.

## Install and first launch

Download the installer for your system from the [Releases](https://github.com/djgragra/dead-air-watchdog/releases) page and check it against `SHA256SUMS.txt`:
`Dead-Air-Watchdog-Setup-<V>.exe` (Windows), `Dead-Air-Watchdog-<V>-arm64.dmg` (Mac with Apple silicon), `Dead-Air-Watchdog-<V>-x64.dmg` (Mac with Intel), `Dead-Air-Watchdog-<V>.AppImage` (Linux).
The app is free and has no Apple or Microsoft certificate, so the first launch may show a warning.

- **Windows**: run the installer. If SmartScreen says "Windows protected your PC", click *More info* → *Run anyway*.
- **macOS**: open the disk image and drag the app to Applications. The app is signed ad hoc, which is what an Apple silicon Mac needs to open it. The first start still shows the "unidentified developer" notice: open *System Settings → Privacy & Security*, scroll down and click *Open Anyway* (right-click → Open no longer exists on macOS 15 and later). If an earlier version says the app is "damaged", run this once in Terminal: `xattr -cr "/Applications/Dead Air Watchdog.app" && codesign --force --deep -s - "/Applications/Dead Air Watchdog.app"`
- **Linux**: make the AppImage executable (`chmod +x Dead-Air-Watchdog-*.AppImage`) and run it.

The app always opens in English; choose Italiano or Español in the settings and the choice is remembered. The theme is dark by default, with light and system available.

**Why it asks for the microphone.** Operating systems treat every audio input (sound card, interface, USB mixer) as a "microphone", so the permission prompt is the same. The app only measures the level ten times per second: it does **not** record, store, play back or send audio. The input is opened with automatic gain, noise suppression and echo cancellation switched off, so that the measured level is the real one. Monitoring a stream address needs no permission.

## How it works

Every 100 ms the audio engine (a hidden window, so it keeps running when the main window is closed) computes the level of each channel, in **dBFS**. The loudest channel is compared with the threshold; **silence means all the channels are below it**.

- Below the threshold the input is *counting* (yellow). When it lasts at least the configured time, it becomes an *alarm* (red) and the alerts go out. The silence is dated from its first quiet moment.
- The audio is *back* only after it stays at or above the threshold for 2 seconds in a row, or 2 seconds in total within 5 seconds: one click in a silent stretch does not restart the countdown, and speech with pauses between the words counts as audio.
- If the input delivers nothing (device removed, stream down, engine stalled) this counts as dead air with the cause **offline**.
- If the program does not run for more than 10 seconds (the computer sleeps or freezes), the countdown is dropped and the period is written in the log as a monitoring gap.

The default threshold is −50 dBFS and the default time 30 seconds. The level is a plain level, **not** a loudness: this is not a certified instrument.

## Inputs

In *Settings → Inputs* you add up to 32 inputs, in any mix:

- **Add sound card**: choose the *Device* (sound card or audio interface) and the **channels to monitor**: Channels 1–2, 3–4, 5–6 or 7–8. Several cards, or several pairs of the same card, can be monitored together (add one input per pair). Two cards with the same name are numbered, a device already used by another input is marked in the list, and a saved device that is gone is shown as "not found": it is never swapped for another card.
- **Add stream**: the address of an Icecast / Shoutcast stream (MP3, AAC, Ogg Vorbis or Opus, starting with `http://` or `https://`). A user name and password written inside the address are masked, with an eye button to show them. HLS (`.m3u8`) streams are not supported.
- For each input you can set the **name** (shown on the tile, in the alerts and in the log), a **logo** (PNG, JPG, WebP, GIF or SVG up to 5 MB, kept on this computer), the **silence threshold**, the time to **alert after**, and switch **Monitor this input** off. The arrows ▲ ▼ change the order of the inputs, which is also the order of the tiles.
- **More options** of each input: *Yellow after…* (2 seconds by default: the traffic light stays green until the audio has been below the threshold that long), the **monitoring hours** (days and hours, also past midnight, in which the input is not monitored or has its own threshold and time) and the **frozen-audio alarm** (off by default: the level stays within a small range, 1 dB by default, for at least 10 seconds although it is above the threshold: a steady tone, a stuck loop or constant noise).

## Dashboard and wall display

The **Dashboard** shows one big traffic light with the worst state of all the inputs (green: all OK; yellow: a countdown is running; red: dead air; grey: stopped) and one tile per input with its state, its countdown and a live level meter with the threshold marked.

On each tile, **Pause alerts for this input** switches the alerts of that input off for 1 hour or until tomorrow at 06:00 (for maintenance). The pause ends by itself, survives a restart and is written in the log; the input is still measured and shown as PAUSED.

**Compact view** (button *Compact view* at the bottom of the side bar, or in the tray menu) turns the window into a small one for a screen full of other programs: no side bar and no summary, one row per input with its name, its state and two thin level meters, and a smallest window of about 280 × 110 pixels. *Normal view* (in the same place and in the top bar) brings the window back to its size and place. **Always on top** keeps the window above the others, in either view. Both choices, and the place and size of each view, are remembered. In the compact view you can **hide the menu bar** (*Settings → General → Display*, or the tray menu; Windows and Linux): right-click the window to bring it back, or press Alt for a moment. The page zooms with Ctrl +, Ctrl − and Ctrl 0 or with Ctrl and the mouse wheel; the zoom and the size are remembered. In a narrow window the buttons stay on top and the status badge goes to the next line; in a very narrow one the level bars give way to the names. Nothing changes in the detection or in the alerts; the wall display always uses the whole screen as before.

The **Wall display** is for an always-on screen in a newsroom or a studio: full screen, the screen kept awake, the clock and date as large as the screen allows, one large tile per input (from 1 to 32; the tiles rearrange to fit) and a glow around the screen edge when something is wrong. In *Settings → General → Display* you choose the glow (only in wall display, always, off), the size of the names (automatic, very large, large, medium, small), the logos (small next to the name, medium, large, or a soft background) and whether the app opens straight in the wall display.

## Alerts

In *Settings → Alerts* switch on the channels you want. Every message names the input, and starts with `[Dead Air Watchdog · name of the installation]` (the name is set in *Settings → General*).

- **Email (SMTP)**: server, port, user, password, sender and recipients (several in one field, separated by commas). **One message goes to everybody with the recipients in Bcc.** With a user name the connection must be encrypted (*Use TLS from the start*, usually port 465, or STARTTLS). *Send test* checks it.
- **Telegram**: the bot token and one or more recipients (chat IDs), each with a note. *Send test* checks that it reaches everybody.
- **HTTP (webhook)**: a request to an address you choose, POST with JSON or GET, with an optional Authorization header, for a studio screen or an automation.
- **Desktop notification** and an optional **alarm sound** on the computer: one sound for all the inputs (two-tone beeps with pauses), silenced with one button and re-armed by every new alarm. The sound plays on the default output; with a microphone input near the speakers a line input is safer.
- **Repeat the alert every N minutes** while the alarm lasts (0 = never).
- **Alerts for several inputs at once**: when several inputs fail, or come back, together, the first alert goes out at once and the others within the grouping window (60 seconds by default) follow in one message with the list.
- **Wording of the alerts**: you can write your own text for each kind of message (dead air, frozen audio, reminder, audio back, several inputs down or back), with the words the dialog lists; *Back to the text of the app* restores the default.

All passwords, tokens and addresses are stored encrypted with the system keystore (Keychain, DPAPI, libsecret) when it is available. They are only ever sent to your own mail server, to Telegram and to the HTTP address you set.

## Event log and summary

The **Event log** lists, for each input, the start, the end, the duration, the cause (silence, input offline, frozen audio) and the note; also the periods when nothing was monitored (app closed, computer asleep), the **pauses** and the **micro-silences**. Filter it by type or by input, and *Export CSV* or *Export JSON*. *Clear log…* deletes everything after confirmation. A **chart** shows the dead air per day over 7, 14 or 30 days, for all the inputs or one.

- **Micro-silences**: every drop below the threshold, however short, is logged with its time, duration and cause, counted per input and in total for today, and kept for 30 days by default. No alert is sent for them and the alarm rule does not change: they help you tune the threshold and tell a fault of the program from one of the stream or of the network. With spoken-word channels, or music without crossfades, they can fill the log: switch them off in *Settings → General → Write micro-silences in the event log* for all the inputs, or for one input in *Settings → Inputs → More options → Micro-silences in the log* (*Same as in General*, *Write them*, *Do not write them*). An input that has them off writes, counts and shows none, and the summary cannot use its micro-silences to tell a fault of the stream from one of the network; the ones already in the log stay until they expire. They are on by default.
- **Summary and common problems**: for each input the availability (the share of the monitored time without dead air; the time the app was not running, the pauses and the hours switched off do not count), the number of alarms, the total and the longest dead air, for this month, last month or the last 7 or 30 days, with CSV export. When several inputs lose their data or go into alarm within 10 seconds of each other, the events are marked **Common problem**: probably the network or the computer, not the streams.

## Heartbeat

The app cannot warn you that the computer itself is down. The optional **Heartbeat** (*Settings → Alerts*) sends a plain GET request to an address you choose every 1 to 60 minutes while monitoring. A service that alerts when these requests stop (for example Healthchecks.io) then warns you when the computer is off or asleep, the app has crashed or the network is down. The request carries no data besides a User-Agent, and its address (usually a secret token) is stored encrypted. *Send test ping* checks it.

## Settings

Settings are in tabs, in the same order as in every OnAir Garage app. Press *Save settings* to keep your changes (*Discard changes* goes back); a field marked in red must be corrected first.

| Tab | Content |
|---|---|
| General | Start the app when you sign in, start hidden in the tray, start monitoring when the app opens, keep the computer from sleeping while monitoring, whether to write the micro-silences in the log and how long to keep them, how long to keep the event log, the **name of this installation** (shown in the alerts), language and theme, check for updates, and the **Display** options of the wall display |
| Inputs | The inputs, with their device or address, name, logo, threshold, time and options |
| Alerts | Email, Telegram, HTTP, the sound, the repeat, the grouping, the wording of the alerts and the heartbeat |
| Updates | The guided update (see below) |
| Backup | Export and import of the configuration |

**Backup**: *Export* saves inputs, thresholds, alerts, heartbeat and general settings as `dead-air-watchdog-backup-YYYY-MM-DD.json`. Passwords and tokens (the email password, the Telegram token, the heartbeat address, the user name and password inside a stream address, the HTTP address and header) are **left out** unless you tick *Include passwords and tokens* (a red warning says the file will hold them in plain text). *Import* can replace everything or add only the inputs this computer does not have, and the app lists what must be typed again. A value stored encrypted cannot be read on another computer or account, so a backup never carries it.

**Help & about** has the version, the licence and the credits, *Copy support info* (version, system, last check and last error: never settings, addresses or passwords), *Open logs folder* (one log per day, 7 days, 5 MB each) and the tip card: the jar and the button both open the support page of the website in the language of the app; nothing is asked inside the app. The window remembers its place and size.

## Updates

The app looks for a new version 15 seconds after it starts and then every 24 hours (switch it off in *Settings → Updates*). A banner offers *Download and install*, *Remind me later* (24 hours) and *Skip this version*, with the release notes. The download shows a progress bar, can be cancelled and is checked against the SHA-256 in the release (`SHA256SUMS.txt`). *Close and install* asks first (monitoring stops), saves a safety copy of the settings, then starts the installer (Windows), opens the disk image (macOS) or shows the AppImage (Linux). After the update a *What's new* window appears once. Nothing is downloaded or installed without a click.

Because the machines that run this app are often left alone, a new version is also announced **once per version** by email and Telegram, when they are set up (switchable): a computer left on an older version cannot announce anything until it has been updated by hand.

## Limits

- Not a certified instrument. The level is a plain level, not a loudness.
- A stream is heard like any listener: it shows in the server's listener statistics, it arrives delayed by the stream's buffer, and if the server plays a filler when the source drops, the monitor hears that audio, not silence.
- While the computer is asleep or off, or the app is closed, nothing is monitored and no alert can be sent: that is what the heartbeat is for.
- Every stream is an extra decoder, and every sound card an extra capture in the system; the limit is the 32 inputs of the app. A card in exclusive use by another program on Windows cannot be opened (the input then says so).

## Troubleshooting

| Problem | What to do |
|---|---|
| macOS: "the app is damaged / cannot be opened" | Open *System Settings → Privacy & Security → Open Anyway*; for an earlier version, run in Terminal `xattr -cr "/Applications/Dead Air Watchdog.app" && codesign --force --deep -s - "/Applications/Dead Air Watchdog.app"`. |
| Windows: "Windows protected your PC" | *More info* → *Run anyway*. |
| Linux: the AppImage does not start | Make it executable (`chmod +x`) and install FUSE (`libfuse2`) if your system needs it. |
| The sound card says "not found" | The saved device is gone: reconnect it, press *Refresh list* and choose it again. |
| An input shows "offline" | The device is missing or the stream is down; the app reconnects by itself. |
| No alert arrives | Use *Send test* in *Settings → Alerts* and read the error message. |
| False alarms during speech | Lower the threshold or raise *Alert after*; pauses between words are not counted as silence once the audio has been back for 2 seconds. |
| The update download failed with "checksum mismatch" | The file was deleted automatically. Try again, or download the installer by hand from the releases page. |

## Contacts

Graziano Melzi · OnAir Garage — `https://onairgarage.com` — `hello@onairgarage.com`. Tool page: `https://onairgarage.com/tools/dead-air-watchdog/`. Source code and releases: `https://github.com/djgragra/dead-air-watchdog`. Licence: MIT © 2026 Graziano Melzi.
