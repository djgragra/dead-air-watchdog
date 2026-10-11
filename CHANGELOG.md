# Changelog

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
