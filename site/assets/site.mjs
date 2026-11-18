import { contributionAmount, checkoutDestination, releaseDestination, safeDestination } from './config.mjs';
const menuButton = document.querySelector('.menu-button');
const menu = document.querySelector('#site-nav');
const navigationHeader = document.querySelector('.header-inner');
const closeNavigation = () => {
  menuButton?.setAttribute('aria-expanded', 'false');
  menu?.classList.remove('is-open');
};
menuButton?.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') !== 'true';
  menuButton.setAttribute('aria-expanded', String(open));
  menu.classList.toggle('is-open', open);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menuButton?.getAttribute('aria-expanded') === 'true') {
    const returnToMenu = document.activeElement === menuButton || menu?.contains(document.activeElement);
    closeNavigation();
    if (returnToMenu) menuButton.focus();
  }
});
navigationHeader?.addEventListener('focusout', event => {
  if (menuButton?.getAttribute('aria-expanded') === 'true' && !navigationHeader.contains(event.relatedTarget)) closeNavigation();
});
menu?.querySelectorAll('a').forEach(anchor => anchor.addEventListener('click', event => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  if (menuButton?.getAttribute('aria-expanded') !== 'true') return;
  if (anchor.pathname === location.pathname && anchor.hash) {
    const target = document.getElementById(anchor.hash.slice(1));
    target?.focus({ preventScroll: true });
  }
  closeNavigation();
}));
if (menu && menuButton) document.documentElement.classList.add('has-navigation');
const stage = document.querySelector('.stage');
const layerDescription = document.querySelector('#layer-description');
const artboard = document.querySelector('.artboard');
const layerAction = document.querySelector('[data-layer-action]');
const layers = {
  title: { name: 'Afterlight', property: 'Position Y', value: '0 px', editedValue: '−40 px', description: 'Title selected. Text stays separate from the composition.', action: 'Move the title', result: 'Title moved. The other layers keep their positions.' },
  motion: { name: 'Orbital paths', property: 'Rotation', value: '0°', editedValue: '30°', description: 'Motion selected. The paths are their own graphic layer.', action: 'Rotate the graphic', result: 'Graphic rotated. The title and scenery stay separate.' },
  scenery: { name: 'Light & form', property: 'Layer view', value: 'Composed', editedValue: 'Separated', description: 'Scenery selected. The image is built from original shape layers.', action: 'See the separate layers', result: 'Layers separated for this illustration. Select a layer to restore the composition.' }
};
let activeLayer='title';let demoChanged=false;
const updateInspector=()=>{
  const layer=layers[activeLayer];
  document.querySelector('#inspector-name').textContent=layer.name;
  document.querySelector('#inspector-property').textContent=layer.property;
  document.querySelector('#inspector-value').textContent=demoChanged?layer.editedValue:layer.value;
  document.querySelector('#mobile-inspector-property').textContent=`${layer.name} · ${layer.property}`;
  document.querySelector('#mobile-inspector-value').textContent=demoChanged?layer.editedValue:layer.value;
};
document.querySelectorAll('[data-layer]').forEach(button => button.addEventListener('click',()=>{
  activeLayer=button.dataset.layer;demoChanged=false;
  document.querySelectorAll('[data-layer]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
  stage.classList.remove('selection-title','selection-motion','selection-scenery','stage-exploded');
  stage.classList.add(`selection-${activeLayer}`);artboard.classList.remove('demo-title','demo-motion');
  layerDescription.textContent=layers[activeLayer].description;layerAction.textContent=layers[activeLayer].action;updateInspector();
}));
layerAction?.addEventListener('click',()=>{
  demoChanged=!demoChanged;
  artboard.classList.toggle('demo-title',demoChanged&&activeLayer==='title');
  artboard.classList.toggle('demo-motion',demoChanged&&activeLayer==='motion');
  stage.classList.toggle('stage-exploded',demoChanged&&activeLayer==='scenery');
  layerDescription.textContent=demoChanged?layers[activeLayer].result:layers[activeLayer].description;
  layerAction.textContent=demoChanged?'Restore composition':layers[activeLayer].action;updateInspector();
});
if (stage && artboard && layerDescription && layerAction) {
  document.querySelectorAll('[data-layer]').forEach(button => { button.disabled=false; });
  layerAction.disabled=false;
}
let config;
const directDownload = document.querySelector('[data-direct-download]');
const releaseAction = document.querySelector('#release-action');
const releaseDetails = document.querySelector('#release-details');
const currentDownload = document.querySelector('#release-action a');
// The generated links also work without JavaScript. While refreshing their destinations,
// send early clicks to the release information instead of an installer that may be stale.
if (directDownload) directDownload.href = '/download/#mac';
if (currentDownload) currentDownload.href = '#release-state';
// Say so when the check is slow. A quick check never changes the label.
const slowCheck = currentDownload ? setTimeout(() => { currentDownload.textContent = 'Checking release…'; }, 400) : 0;
const configController=new AbortController();
const configTimeout=setTimeout(()=>configController.abort(),8000);
const configLoad=fetch('/config.json',{cache:'no-store',signal:configController.signal}).then(async response=>{
  if(!response.ok)throw new Error('Configuration unavailable');
  const loaded=await response.json();
  if (typeof loaded?.release?.ready !== 'boolean' || typeof loaded?.release?.notarized !== 'boolean' ||
      !['optional-support','paid-download'].includes(loaded?.contributions?.policy) ||
      loaded.contributions.currency !== 'USD' || loaded.contributions.minimum !== 5 || loaded.contributions.suggested !== 15) {
    throw new Error('Unsupported configuration');
  }
  config=loaded;
  const releaseURL = config.contributions.policy === 'optional-support' ? releaseDestination(config) : null;
  if(releaseURL){
    if (directDownload) directDownload.href = releaseURL;
    document.querySelector('#release-state')?.replaceChildren(document.createTextNode(`Version ${config.release.version}`));
    document.querySelector('#release-description')?.replaceChildren(document.createTextNode('Free to edit and export in every format the Mac app supports.'));
    document.querySelector('#release-checksum')?.replaceChildren(document.createTextNode(config.release.sha256));
    document.querySelector('#release-size')?.replaceChildren(document.createTextNode(config.release.size ? ` · ${config.release.size}` : ''));
    if (releaseDetails) releaseDetails.hidden = false;
    if (releaseAction) {
      const anchor = currentDownload || document.createElement('a');
      anchor.href = releaseURL;
      anchor.className = 'button';
      anchor.textContent = 'Download Arya for Mac';
      if (!currentDownload) releaseAction.replaceChildren(anchor);
    }
  } else {
    if (directDownload) directDownload.textContent = 'Check Mac availability';
    document.querySelector('#hero-release')?.replaceChildren(document.createTextNode('Check the download page for the Mac release.'));
    document.querySelector('#release-state')?.replaceChildren(document.createTextNode('Release validation in progress'));
    document.querySelector('#release-description')?.replaceChildren(document.createTextNode('The public installer is not ready.'));
    document.querySelector('.download-hero .lead')?.replaceChildren(document.createTextNode('See which editions are available.'));
    if (releaseDetails) releaseDetails.hidden = true;
    releaseAction?.replaceChildren();
  }
  return config;
}).catch(()=>{
  config=null;
  if (directDownload) directDownload.textContent = 'Check Mac availability';
  document.querySelector('#hero-release')?.replaceChildren(document.createTextNode('Check the download page for the Mac release.'));
  document.querySelector('#release-state')?.replaceChildren(document.createTextNode('Release status unavailable'));
  document.querySelector('#release-description')?.replaceChildren(document.createTextNode('Reload this page to check the release status before downloading.'));
  document.querySelector('.download-hero .lead')?.replaceChildren(document.createTextNode('See which editions are available.'));
  if (releaseDetails) releaseDetails.hidden = true;
  releaseAction?.replaceChildren();
  const state=document.querySelector('#contribution-state');
  if(state)state.textContent='Contribution setup could not be loaded. No payment has been taken. Try reloading this page.';
  return null;
}).finally(()=>{clearTimeout(configTimeout);clearTimeout(slowCheck);});
const form=document.querySelector('#contribution-form');
const input=document.querySelector('#custom-amount');
const state=document.querySelector('#contribution-state');
const amountButtons=document.querySelectorAll('[data-amount]');
amountButtons.forEach(button=>button.addEventListener('click',()=>{
  input.value=button.dataset.amount;input.removeAttribute('aria-invalid');
  amountButtons.forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
  state.classList.remove('error');state.textContent=`$${button.dataset.amount} selected. No payment has been made.`;
}));
input?.addEventListener('input',()=>{
  amountButtons.forEach(button=>button.setAttribute('aria-pressed',String(input.value===button.dataset.amount)));
  input.removeAttribute('aria-invalid');state.classList.remove('error');
  state.textContent='Your amount has changed. No payment has been made.';
});
form?.addEventListener('submit',async event=>{
  event.preventDefault();state.replaceChildren();state.classList.remove('error');
  const result=contributionAmount(input.value,5);
  if(result.error){state.textContent=result.error;state.classList.add('error');input.setAttribute('aria-invalid','true');input.focus();return;}
  input.removeAttribute('aria-invalid');
  const capturedAmount=input.value;
  state.textContent='Checking contribution setup. No payment has been taken.';
  const submit=form.querySelector('[type=submit]');submit.disabled=true;
  await configLoad;submit.disabled=false;
  if(!config){state.textContent='Contribution setup could not be loaded. No payment has been taken. Try reloading this page.';return;}
  if(input.value!==capturedAmount){state.textContent='Your amount changed. Check contribution options again before continuing.';return;}
  const checkout=checkoutDestination(config,capturedAmount);
  if(!checkout.url){
    const otherOptions=Object.values(config.contributions.checkoutURLs || {}).some(value=>safeDestination(value,config.contributions.allowedHosts));
    state.textContent=otherOptions ? `There is no checkout for $${result.dollars}. Choose a different amount or check again later. No payment has been taken.` : `$${result.dollars} selected. Contributions are not open yet. No payment has been taken.${config.contributions.policy==='paid-download'?' Official download checkout is still in setup.':' The planned free download is separate from support.'}`;
    return;
  }
  const text=document.createElement('span');
  text.textContent=checkout.custom?`You selected $${result.dollars}. Set this amount at the provider's checkout before paying. `:`You selected $${result.dollars} as a one-time contribution. `;
  const anchor=document.createElement('a');anchor.href=checkout.url;anchor.rel='noopener noreferrer';anchor.textContent='Continue to secure checkout';
  state.append(text,anchor);
});
if (form) form.querySelectorAll('[data-amount], input, [type=submit]').forEach(control => { control.disabled=false; });

const workspaceImage=document.querySelector('#workspace-image');
const workspaceCaption=document.querySelector('#workspace-caption');
const workspaceFull=document.querySelector('#workspace-full');
const reconcileCapture=()=>{
  if(!workspaceImage)return;
  const selected=Array.from(document.querySelectorAll('[data-workspace]')).find(anchor=>anchor.getAttribute('aria-current')==='true');
  if(!selected)return;
  const expected=new URL(selected.dataset.src,document.baseURI).href;
  if(workspaceFull)workspaceFull.style.display='none';
  if(workspaceImage.src!==expected||!workspaceImage.complete||(workspaceImage.currentSrc&&workspaceImage.currentSrc!==expected))return;
  if(workspaceImage.naturalWidth===0){
    if(workspaceCaption)workspaceCaption.textContent='The workspace capture could not load. Select another workspace or reload this page to try again.';
    return;
  }
  if(workspaceCaption)workspaceCaption.textContent=selected.dataset.caption;
  if(workspaceFull)workspaceFull.style.display='';
};
workspaceImage?.addEventListener('error',reconcileCapture);
workspaceImage?.addEventListener('load',reconcileCapture);
reconcileCapture();
document.querySelectorAll('[data-workspace]').forEach(button=>button.addEventListener('click',event=>{
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  document.querySelectorAll('[data-workspace]').forEach(item=>item.setAttribute('aria-current',String(item===button)));
  workspaceImage.src=button.dataset.src;
  workspaceImage.alt=button.dataset.alt;
  workspaceCaption.textContent=button.dataset.caption;
  workspaceFull.href=button.dataset.src;
  reconcileCapture();
}));

// Beta access placeholder. It validates in the browser and never sends or stores what was typed.
const accessForm=document.querySelector('#access-form');
const accessEmail=document.querySelector('#access-email');
const accessState=document.querySelector('#access-state');
accessEmail?.addEventListener('input',()=>{accessEmail.removeAttribute('aria-invalid');accessState?.classList.remove('error');});
accessForm?.addEventListener('submit',event=>{
  event.preventDefault();
  if(!accessEmail||!accessState)return;
  accessState.classList.remove('error');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(accessEmail.value).trim())){
    accessState.textContent='Enter an email address, for example name@example.com.';
    accessState.classList.add('error');accessEmail.setAttribute('aria-invalid','true');accessEmail.focus();return;
  }
  accessEmail.removeAttribute('aria-invalid');
  accessState.textContent='Access requests are not connected yet. Nothing you typed left this page.';
});
if (accessForm) accessForm.querySelectorAll('input, select, textarea, [type=submit]').forEach(control => { control.disabled=false; });

// The six-page rail marks the chapter on screen. Without this script the links still work.
const railLinks = [...document.querySelectorAll('.page-rail a')];
if (railLinks.length && typeof IntersectionObserver === 'function') {
  const onScreen = new Set();
  const watcher = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) onScreen.add(entry.target.id); else onScreen.delete(entry.target.id);
    }
    const current = railLinks.find(item => onScreen.has(item.hash.slice(1)));
    for (const item of railLinks) {
      if (item === current) item.setAttribute('aria-current', 'true'); else item.removeAttribute('aria-current');
    }
  }, { rootMargin: '-35% 0px -55% 0px' });
  document.querySelectorAll('[data-chapter]').forEach(chapter => watcher.observe(chapter));
}
