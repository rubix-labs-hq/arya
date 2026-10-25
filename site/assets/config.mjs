export function safeDestination(value, allowedHosts = []) {
  if (typeof value !== 'string' || !value || value.length > 2048 || !Array.isArray(allowedHosts) || !allowedHosts.every(host => typeof host === 'string')) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !allowedHosts.includes(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}
export function contributionAmount(value, minimum = 5) {
  const raw = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return { error: 'Enter an amount in US dollars, with up to two decimal places.' };
  const cents = Math.round(Number(raw) * 100);
  if (!Number.isSafeInteger(cents) || cents < minimum * 100 || cents > 100000) return { error: `Choose an amount between $${minimum} and $1,000.` };
  return { cents, dollars: (cents / 100).toFixed(2) };
}
export function releaseDestination(config) {
  const release = config?.release;
  if (release?.ready !== true || release.notarized !== true || typeof release.version !== 'string' || !release.version.trim() || !/^[a-f0-9]{64}$/.test(release.sha256 || '')) return null;
  return safeDestination(release.macURL, release.allowedHosts);
}
export function mobileReleaseDestination(config) {
  const mobile = config?.mobileRelease;
  if (mobile?.ready !== true || typeof mobile.version !== 'string' || !mobile.version.trim()) return null;
  if (mobile.appId && String(mobile.appId).trim() !== '6826357116') return null;
  const destination = safeDestination(mobile.appStoreURL, mobile.allowedHosts);
  if (!destination) return null;
  try {
    const url = new URL(destination);
    if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== 'apps.apple.com' || url.port !== '') return null;
    if (!/^\/(?:[a-z]{2}\/)?app(?:\/[^/]+)?\/id6826357116\/?$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}
export function checkoutDestination(config, amount) {
  const result = contributionAmount(amount, config?.contributions?.minimum || 5);
  if (result.error) return result;
  const contribution = config?.contributions;
  const preset = String(Number(result.dollars));
  const direct = safeDestination(contribution?.checkoutURLs?.[preset], contribution?.allowedHosts);
  if (direct) return { ...result, url: direct, custom: false };
  const custom = safeDestination(contribution?.checkoutURLs?.custom, contribution?.allowedHosts);
  return { ...result, url: custom, custom: Boolean(custom) };
}
