import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { safeDestination, contributionAmount, releaseDestination, checkoutDestination } from '../assets/config.mjs';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const routes=['','download','install','support','privacy','project'];
const config=JSON.parse(await readFile(join(root,'config.json'),'utf8'));
test('contribution amounts reject ambiguous, invalid and excessive values',()=>{
  for(const value of ['','0','4.99','5.001','-5','1e2','Infinity','NaN','5,00','1000.01','9999999999999999999'])assert.ok(contributionAmount(value).error,value);
  for(const [value,cents] of [['5',500],['15',1500],['30.05',3005],['1000',100000],[' 5.00 ',500]])assert.equal(contributionAmount(value).cents,cents);
});
test('destinations require HTTPS, no credentials and an explicit host allowlist',()=>{
  for(const value of ['javascript:alert(1)','http://example.com','https://user:secret@example.com','https://example.com.evil.test','/checkout','https://example.com'])assert.equal(safeDestination(value,[]),null);
  assert.equal(safeDestination('https://example.com/pay',['example.com']),'https://example.com/pay');
  assert.equal(safeDestination('https://example.com.evil.test',['example.com']),null);
});
test('a release cannot offer a URL without reviewed readiness, notarization and checksum fields',()=>{
  const shipped=releaseDestination(config);
  assert.ok(shipped===null||shipped.startsWith(`https://github.com/rubix-labs-hq/arya/releases/download/v${config.release.version}/`),shipped);
  const ready={release:{ready:true,notarized:true,version:'1.0',sha256:'a'.repeat(64),macURL:'https://example.com/Arya.dmg',allowedHosts:['example.com']}};
  assert.equal(releaseDestination(ready),'https://example.com/Arya.dmg');
  for(const key of ['ready','notarized','version','sha256','allowedHosts'])assert.equal(releaseDestination({release:{...ready.release,[key]:null}}),null,key);
});
test('checkout keeps preset URLs exact and custom amounts explicitly provider-selected',()=>{
  assert.equal(checkoutDestination(config,15).url,null);
  const configured={contributions:{minimum:5,allowedHosts:['example.com'],checkoutURLs:{'15':'https://example.com/preset?sku=fifteen',custom:'https://example.com/custom'}}};
  assert.deepEqual(checkoutDestination(configured,15),{cents:1500,dollars:'15.00',url:'https://example.com/preset?sku=fifteen',custom:false});
  assert.equal(checkoutDestination(configured,16).custom,true);
  assert.ok(checkoutDestination(configured,4).error);
});
test('all local links and assets resolve, fragments exist and all pages have landmarks',async()=>{
  const pages=new Map(await Promise.all(routes.map(async route=>[route,await readFile(join(root,route,'index.html'),'utf8')])));
  for(const [route,html] of pages){
    assert.equal((html.match(/<h1(?:\s|>)/g)||[]).length,1,route);
    for(const marker of ['<html lang="en"','<main id="main"','<header','<footer','<title>','name="description"','class="skip-link"'])assert.ok(html.includes(marker),`${route}: ${marker}`);
    assert.ok(!/href=["']#(?:["'])/.test(html),`empty link in ${route}`);
    assert.ok(!/(?:https?:\/\/127\.0\.0\.1|Catalyst|testimonials|million creators|lorem ipsum|TODO)/i.test(html),route);
    assert.ok(!/\bstyle=/.test(html),'inline style would conflict with CSP');
    for(const match of html.matchAll(/(?:href|src)="([^"]+)"/g)){
      const href=match[1];if(/^(https:|data:)/.test(href))continue;
      const [pathWithQuery,hash]=href.split('#');
      const [path,query]=pathWithQuery.split('?');
      if(path==='/editor/'){const mapped=JSON.parse(await readFile(join(root,'../editor/browser-public-files.json'),'utf8'));assert.ok(mapped.some(row=>row.target==='editor/index.html'),'hosted editor entry is not packaged');continue;}
      let target=path?join(root,path.replace(/^\//,'')):join(root,route,'index.html');
      const info=await stat(target);if(info.isDirectory())target=join(target,'index.html');
      await stat(target);
      const version=new URLSearchParams(query).get('v');
      if(version)assert.equal(version,createHash('sha256').update(await readFile(target)).digest('hex').slice(0,12),`${route} stale asset version ${href}`);
      if(hash){const content=await readFile(target,'utf8');assert.ok(content.includes(`id="${hash}"`),`${route} broken fragment ${href}`);}
    }
  }
});
test('public defaults cannot bill, download, expose private source or track visitors',async()=>{
  if(config.release.ready){assert.equal(config.release.notarized,true);assert.match(config.release.sha256,/^[a-f0-9]{64}$/);assert.ok(releaseDestination(config));}else assert.equal(releaseDestination(config),null);
  for(const url of Object.values(config.contributions.checkoutURLs))if(url!==null)assert.ok(safeDestination(url,config.contributions.allowedHosts),url);
  for(const url of [config.publicSourceURL,config.contactURL,config.requestAccessURL])if(url!==null)assert.ok(safeDestination(url,config.externalHosts),url);
  const js=await readFile(join(root,'assets/site.mjs'),'utf8');
  assert.ok(!/(localStorage|sessionStorage|document\.cookie|sendBeacon|analytics|window\.open)/.test(js));
  assert.ok(!/fetch\([^\n]+(?:POST|payment|charge)/.test(js));
  const headers=await readFile(join(root,'_headers'),'utf8');assert.ok(headers.includes("object-src 'none'"));assert.ok(headers.includes("frame-ancestors 'none'"));
  const robots=await readFile(join(root,'robots.txt'),'utf8');
  if(config.indexing===true){assert.ok(robots.includes('Allow: /')&&robots.includes('Disallow: /editor/'));assert.ok((await readFile(join(root,'sitemap.xml'),'utf8')).includes('<loc>'));}else assert.ok(robots.includes('Disallow: /'));
});
test('focus, reduced motion and readable color tokens exist',async()=>{
  const css=await readFile(join(root,'assets/site.css'),'utf8');
  assert.ok(css.includes(':focus-visible'));assert.ok(css.includes('prefers-reduced-motion'));assert.ok(css.includes('max-width:650px'));
  const luminance=hex=>{const rgb=hex.match(/.{2}/g).map(c=>parseInt(c,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};
  const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  for(const [a,b] of [['f2f0e9','151615'],['b5b8ae','151615'],['b5b8ae','20211f'],['151615','efbc68'],['586050','f2f0e9'],['6b4a16','f2f0e9']])assert.ok(contrast(a,b)>=4.5,`${a}/${b}`);
});
test('375px phone layout prevents horizontal overflow and keeps tap targets at least 44px',async()=>{
  const css=await readFile(join(root,'assets/site.css'),'utf8');
  const download=await readFile(join(root,'download/index.html'),'utf8');
  assert.ok(css.includes('.article-layout{grid-template-columns:minmax(0,1fr)}'),'.article-layout must use minmax(0,1fr) to prevent mobile overflow');
  assert.ok(css.includes('.hash,#release-description{overflow-wrap:anywhere;word-break:break-word}'),'SHA-256 hash and release description must wrap on narrow screens');
  assert.ok(download.includes('<code class="hash">'),'download page SHA-256 must use .hash class');
  assert.ok(css.includes('.button.small{min-height:44px;padding:0 16px;font-size:14.5px;border-radius:7px}'),'.button.small must be at least 44px tall');
  assert.ok(css.includes('.footer-nav a{display:inline-flex;align-items:center;min-height:44px;min-width:44px'),'.footer-nav links must meet 44x44 tap target');
  assert.ok(css.includes('.article-aside a{display:flex;align-items:center;min-height:44px;min-width:44px'),'.article-aside links must meet 44x44 tap target');
  assert.ok(download.includes('<a class="button small" href="/download/#mac">Download for Mac</a>'),'navigation CTA must state Download for Mac');
});
test('font distributions include their actual licenses',async()=>{
  for(const family of ['manrope','newsreader']){
    const text=await readFile(join(root,'assets/fonts',`${family}-OFL.txt`),'utf8');assert.ok(text.includes('SIL OPEN FONT LICENSE'));
    const font=await stat(join(root,'assets/fonts',`${family}${family==='newsreader'?'-italic':''}.ttf`));assert.ok(font.size>100000);
  }
});
