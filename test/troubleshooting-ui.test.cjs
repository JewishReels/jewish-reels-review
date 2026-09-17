const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

test('idle saved-hit recheck remains clickable and explains missing consent',async()=>{
  const elements=new Map(),make=id=>({id,value:'',checked:false,disabled:false,textContent:'',innerHTML:'',className:'',title:'',style:{},selectedOptions:[],focus(){this.focused=true;},addEventListener(){},classList:{add(){},toggle(){}}});
  const $=id=>{if(!elements.has(id))elements.set(id,make(id));return elements.get(id);};
  const consentLabel=make('consent-label');let consentHighlighted=false;consentLabel.classList={add(name){if(name==='needs-consent')consentHighlighted=true;},toggle(name,value){if(name==='needs-consent')consentHighlighted=value;}};
  const progress=make('progress');progress.setAttribute=()=>{};
  let toastMessage='',calls=0;
  const context={window:{},project:{root:'test'},connected:true,$,document:{querySelector(selector){return selector==='.recheck-consent'?consentLabel:progress;},querySelectorAll(){return[];},addEventListener(){}},api:{call:async()=>{calls++;return{};},onHitRecheck(){}},controls(){},showView(){},toast(message){toastMessage=message;},act:fn=>fn,confirm:()=>false,console,attachZoom(){return{reset(){}};},getMatchImage:async()=>({}),prettyCue:value=>value,el:(tag,className,text)=>({tag,className,text,append(){}})};
  context.window=context;vm.createContext(context);
  $('primaryModel').value='model-a';$('primaryModel').selectedOptions=[{textContent:'Model A'}];$('secondaryModel').value='model-b';$('secondaryModel').selectedOptions=[{textContent:'Model B'}];
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../ui/troubleshooting.js'),'utf8'),context,{filename:'troubleshooting.js'});
  context.renderRecheck({status:'idle',uniqueImages:109,sourceEvidenceRows:174});
  assert.equal($('startRecheck').disabled,false);
  assert.match($('recheckDetail').textContent,/Check the consent box/);
  await $('startRecheck').onclick();
  assert.equal(calls,0);
  assert.match(toastMessage,/consent box/);
  assert.equal($('recheckConsent').focused,true);
  assert.equal(consentHighlighted,true);
});
