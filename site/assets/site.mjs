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
menu?.querySelectorAll('a').forEach(anchor => anchor.addEventListener('click', closeNavigation));
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
  const releaseURL=releaseDestination(config);
  if(releaseURL){
    document.querySelector('#release-state')?.replaceChildren(document.createTextNode(`Version ${config.release.version}`));
    document.querySelector('#release-heading')?.replaceChildren(document.createTextNode('The official Mac release is available.'));
    const description=document.querySelector('#release-description');
    if(description)description.textContent=`Signed and notarized Mac build${config.release.size?`. Download size ${config.release.size}`:''}. SHA-256: ${config.release.sha256}`;
    const action=document.querySelector('#release-action');
    if(action){const anchor=document.createElement('a');anchor.href=releaseURL;anchor.className='button';anchor.textContent='Download Arya for Mac';anchor.rel='noopener noreferrer';action.replaceChildren(anchor);}
  } else {
    document.querySelector('#release-state')?.replaceChildren(document.createTextNode('Release validation in progress'));
    document.querySelector('#release-heading')?.replaceChildren(document.createTextNode('The public installer is not ready.'));
    document.querySelector('#release-description')?.replaceChildren(document.createTextNode('There is no approved public Mac download in the current release configuration.'));
    document.querySelector('#release-action')?.replaceChildren();
  }
  return config;
}).catch(()=>{
  config=null;
  document.querySelector('#release-state')?.replaceChildren(document.createTextNode('Release status unavailable'));
  document.querySelector('#release-heading')?.replaceChildren(document.createTextNode('We could not check the current release.'));
  document.querySelector('#release-description')?.replaceChildren(document.createTextNode('Reload this page to check the release status before downloading.'));
  document.querySelector('#release-action')?.replaceChildren();
  const state=document.querySelector('#contribution-state');
  if(state)state.textContent='Contribution setup could not be loaded. No payment has been taken. Try reloading this page.';
  return null;
}).finally(()=>clearTimeout(configTimeout));
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
