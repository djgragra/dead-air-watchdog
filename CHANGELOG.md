# Changelog

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
