import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const source = fileURLToPath(new URL('./webhook.cjs', import.meta.url));
export async function buildTipsFunction(destination) {
  const output = resolve(destination);
  await mkdir(output, { recursive: false });
  await build({ entryPoints: [source], outfile: resolve(output, 'index.js'), bundle: true,
    platform: 'node', target: 'node24', format: 'cjs', sourcemap: false });
  await writeFile(resolve(output, '.vc-config.json'), JSON.stringify({
    runtime: 'nodejs24.x', handler: 'index.js', launcherType: 'Nodejs', maxDuration: 10,
  }) + '\n', { flag: 'wx' });
  await writeFile(resolve(output, 'STRIPE_LICENSE.txt'),
    await readFile(new URL('./node_modules/stripe/LICENSE', import.meta.url)), { flag: 'wx' });
  return Promise.all(['index.js', '.vc-config.json', 'STRIPE_LICENSE.txt'].map(async name => {
    const bytes = await readFile(resolve(output, name));
    return { target: `api/tips/webhook.func/${name}`, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Pass a new .func output directory.');
  await buildTipsFunction(process.argv[2]);
}
