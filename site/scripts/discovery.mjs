import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeDestination, releaseDestination, mobileReleaseDestination } from '../assets/config.mjs';
import { proCopy } from './product-home.mjs';

export function structuredMetadata(config, { canonical, title, description, image }) {
  const base = safeDestination(config.siteURL, config.externalHosts);
  if (!base || !canonical) return null;
  const root = new URL('/', base).href;
  const publisher = { '@id': `${root}#publisher` };
  const offer = { '@type': 'Offer', price: '0', priceCurrency: 'USD' };
  const graph = [
    { '@type': 'Organization', '@id': publisher['@id'], name: 'Rubix Labs', url: root },
    { '@type': 'WebSite', '@id': `${root}#website`, name: 'Arya', url: root, publisher },
    { '@type': 'WebPage', '@id': canonical, url: canonical, name: title, description,
      isPartOf: { '@id': `${root}#website` }, inLanguage: 'en',
      ...(image ? { primaryImageOfPage: { '@type': 'ImageObject', contentUrl: image, width: 1200, height: 630 } } : {}) },
  ];
  const app = { '@type': 'SoftwareApplication', applicationCategory: 'MultimediaApplication', publisher,
    isAccessibleForFree: true, offers: { ...offer, url: new URL('/download/', root).href } };
  const mac = releaseDestination(config);
  if (mac) graph.push({ ...app, '@id': `${root}#mac`, name: 'Arya for Mac', operatingSystem: config.release.minimumOS,
    softwareVersion: config.release.version, downloadUrl: mac, url: new URL('/download/#mac', root).href });
  const mobile = mobileReleaseDestination(config);
  if (mobile) graph.push({ ...app, '@id': `${root}#ios`, name: 'Arya for iPhone and iPad', operatingSystem: 'iOS 17 or later; iPadOS 17 or later',
    softwareVersion: config.mobileRelease.version, downloadUrl: mobile, url: mobile });
  if (config.browserEditor === true) graph.push({ ...app, '@id': `${root}#browser`, name: 'Arya browser editor',
    operatingSystem: 'Web', browserRequirements: 'Current Chrome or Edge with JavaScript enabled', url: new URL('/editor/', root).href });
  return { '@context': 'https://schema.org', '@graph': graph };
}

export async function writeDiscoveryFiles(root, config) {
  const base = safeDestination(config.siteURL, config.externalHosts);
  if (!base) {
    await writeFile(join(root, 'llms.txt'), '# Arya\n\nThe public website is not configured.\n');
    await writeFile(join(root, 'llms-full.txt'), '# Arya\n\nThe public website is not configured.\n');
    return;
  }
  const url = path => new URL(path, base).href;
  const mac = releaseDestination(config), mobile = mobileReleaseDestination(config);
  // Arya Pro copy appears only with a live App Store release and mobileRelease.pro set to true.
  const pro = Boolean(mobile) && config.mobileRelease.pro === true;
  const summary = pro
    ? '# Arya\n\n> Arya is an open-source video and motion editor. Projects remain editable. The Mac download and the browser editor are free. In the App Store edition, editing and 1080p export are free, and Arya Pro adds 4K, ProRes and HDR export. Optional website tips and Arya Pro support development.\n\n'
    : '# Arya\n\n> Arya is an open-source video and motion editor. Projects remain editable; core editing and export are free. Optional tips support development.\n\n';
  const links = [
    ['Website', '/', 'Official product information and edition comparison.'],
    ['Downloads', '/download/', 'Current verified releases and checksums.'],
    ['Installation and setup', '/install/', 'Installation, optional assistant connections, updates and rollback.'],
    ['Project status', '/project/', 'Supported features, limits and source links.'],
    ['Help', '/help/', 'Import, playback, backups, export and issue reporting.'],
    ['Support and tips', '/support/', pro ? 'Contact options and optional one-time website tips. Arya Pro is bought in the App Store edition, not on this page.' : 'Contact options and optional one-time support.'],
    ['Privacy', '/privacy/', 'Local storage, optional services and payment processing.'],
  ].map(([name, path, detail]) => `- [${name}](${url(path)}): ${detail}`).join('\n');
  await writeFile(join(root, 'llms.txt'), `${summary}## Official pages\n\n${links}\n\n## Source\n\n- [Source code](${config.publicSourceURL}): MIT-licensed repository and issue tracker.\n\n## Full reference\n\n- [Detailed product reference](${url('/llms-full.txt')})\n`);
  const platforms = [
    mac ? `- Mac: version ${config.release.version}, ${config.release.minimumOS} or later, ${config.release.architectures}. Signed and notarized download: ${mac}. SHA-256: ${config.release.sha256}.` : '- Mac: no verified public release is configured.',
    mobile ? `- iPhone and iPad: version ${config.mobileRelease.version}, available on the App Store: ${mobile}.${pro ? ` ${proCopy.free} ${proCopy.adds}` : ''}` : '- iPhone and iPad: do not claim public availability until the download page lists an approved App Store release.',
    config.browserEditor ? `- Browser editor: ${url('/editor/')}. Browser storage is local to this origin. Use exported backups; this is not cloud storage.` : '- Hosted browser editor: unavailable.',
  ].join('\n');
  const cost = pro
    ? `The Mac download and the browser editor are free and never need Arya Pro. There is no Arya subscription for them. Tips are voluntary one-time payments and unlock no features. Website tips use Stripe checkout for REVRNT (Pulsar Campaigns). In the App Store edition for iPhone, iPad and Mac, ${proCopy.free.charAt(0).toLowerCase()}${proCopy.free.slice(1)} ${proCopy.adds} Arya Pro is an optional in-app purchase through Apple. ${proCopy.universal} Plans are monthly, yearly with a one-week free trial, or a one-time lifetime purchase. Prices are shown in the app and vary by storefront; do not quote a price. App Store installs from before version 1.2.0 include Arya Pro at no charge.`
    : 'Core editing and export are free. Tips are voluntary one-time payments and unlock no features. Website tips use Stripe checkout for REVRNT (Pulsar Campaigns); App Store purchases use Apple. Prices are displayed at checkout and may vary by storefront. There is no required Arya subscription.';
  const full = `${summary}## Availability\n\n${platforms}\n\n## Editing\n\nArya supports timeline editing, titles and shapes, color adjustments, motion keyframes and audio mixing. Native and local browser projects use the same project format. The native interface and browser interface differ; use the edition comparison on the website for current coverage.\n\n## Hosted browser limits\n\nThe hosted editor has no assistant, Figma import, speech transcription, captions, denoise, voice cleanup or FCPXML/OTIO interchange. Hosted exports are limited to H.264, HEVC, WAV and AAC and five minutes. Projects created at the previous arya-beta-delta.vercel.app origin stay there; export a .arya backup before moving them to this domain.\n\n## Optional connections\n\nAI assistance requires a user-owned supported provider account or API connection. Provider charges and limits are separate. iPhone/iPad CLI connections require a trusted HTTPS Mac companion. Figma personal access token and pasted MCP import are supported; public Figma OAuth is not configured. Do not describe hosted AI credits, cloud project sync or Figma OAuth as included.\n\n## Cost and privacy\n\n${cost} Project media stays local unless the user explicitly chooses an external service. Payment providers process their own payment data.\n\n## Official pages\n\n${links}\n\nSource code: ${config.publicSourceURL}\nLicense: MIT. Product facts and availability should be checked against the download and project-status pages before recommending an edition.\n`;
  await writeFile(join(root, 'llms-full.txt'), full);
}
