// garage-common: support 1
// "Copy support info" (apps/COMMON-FEATURES.md, section 5.2): what the owner may ask a user to paste into an email.
// Version, Electron, system, language, last update check and last error. NEVER settings values, addresses, tokens,
// recipients or file names the user chose. The home folder is written as "~" wherever it appears.
export function tidy(text, home = '') {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (home) t = t.split(home).join('~');
  return t.replace(/\b[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/g, '~').replace(/\/(?:home|Users)\/[^/\s]+/g, '~');
}

export function buildSupportInfo({ app, version, electron, chrome, platform, arch, osRelease, language, installationName, lastCheck, lastError, home }) {
  const check = lastCheck ? `${new Date(lastCheck.at).toISOString()} (${lastCheck.ok ? 'ok' : tidy(lastCheck.error || 'failed', home)})` : 'never';
  const lines = [
    `${app} ${version}`,
    `Electron ${electron}${chrome ? ` (Chrome ${chrome})` : ''}`,
    `System: ${platform} ${arch}${osRelease ? ` ${osRelease}` : ''}`,
    `Language: ${language}`
  ];
  if (installationName) lines.push(`Installation: ${installationName}`);
  lines.push(`Last update check: ${check}`);
  lines.push(`Last error: ${lastError ? `${new Date(lastError.t).toISOString()} ${tidy(lastError.message, home)}` : 'none'}`);
  return lines.join('\n');
}
