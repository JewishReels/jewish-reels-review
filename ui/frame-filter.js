(()=>{
  const bar=el('div','frame-filter-bar');
  bar.innerHTML='<div><strong>Frame filter</strong><span id="frameFilterSummary">Off</span></div><p id="frameFilterMetrics" aria-live="polite"></p><button class="button subtle" id="configureFrameFilter">People filter…</button>';
  document.querySelector('.configuration').append(bar);
  const dialog=el('dialog','modal frame-filter-modal');
  dialog.id='frameFilterDialog';
  dialog.setAttribute('aria-labelledby','frameFilterTitle');
  dialog.innerHTML=`
    <form method="dialog" class="modal-top">
      <h2 id="frameFilterTitle">People filter</h2>
      <button class="icon-button" aria-label="Close people filter">×</button>
    </form>
    <p class="filter-intro">Screen for people locally during preparation. Send matching whole frames to AI review.</p>
    <label class="filter-switch-row" for="frameFilterEnabled">
      <span><strong>Keep frames with people</strong><small>AI checks beard, headwear, and other cues.</small></span>
      <input type="checkbox" role="switch" id="frameFilterEnabled" aria-label="Keep frames with people">
    </label>
    <p id="filterLockNote" class="filter-lock-note" hidden>Pause review to change the filter or preview a video.</p>
    <p id="frameFilterError" class="filter-error" role="alert" hidden></p>
    <div class="filter-actions">
      <span id="filterSaveStatus" class="small" role="status"></span>
      <button type="button" class="button primary" id="saveFrameFilter">Save</button>
    </div>
    <details class="filter-preview-controls" id="filterPreviewSection">
      <summary>Preview a video <span>No AI charges</span></summary>
      <div class="filter-preview-body">
        <label for="filterVideoSearch">Search prepared videos</label>
        <input type="search" id="filterVideoSearch" placeholder="Search by ID or title">
        <label class="filter-sr-only" for="filterVideo">Prepared video</label>
        <select id="filterVideo"></select>
        <p id="filterVideoTitle" class="small"></p>
        <div class="filter-preview-buttons">
          <button type="button" class="button" id="previewFrameFilter">Preview</button>
          <button type="button" class="button subtle" id="cancelFrameFilter" hidden>Cancel</button>
        </div>
        <p id="filterPreviewStatus" role="status"></p>
        <div class="filter-pagination" id="filterPagination" hidden>
          <label>Show <select id="filterPreviewMode"><option value="selected">Retained people candidates</option><option value="all">All scored frames</option><option value="skipped">Skipped frames</option></select></label>
          <button type="button" class="button subtle" id="filterPrev" aria-label="Previous frames">←</button>
          <span id="filterPageLabel"></span>
          <button type="button" class="button subtle" id="filterNext" aria-label="Next frames">→</button>
        </div>
        <div id="filterPreviewGrid"></div>
      </div>
    </details>
    <details class="filter-info" id="filterInfoSection">
      <summary>How it works &amp; limitations</summary>
      <p>Preparation scores every source frame independently before a video becomes ready. A passing frame never pulls neighboring frames through the people filter. Retained frames are later packed, up to four independently retained frames per AI review card. Older footage or changed settings may need a local screening pass first. Whole frames are kept for possible people, including children, crowds, and partially visible people. Your Classification rules determine AI-confirmed hits.</p>
      <p id="frameFilterValidation"></p>
      <p>Completed filtered negatives can trigger cleanup of generated footage. Screening logs and AI review records are kept. Setting changes affect unfinished and future reviews; completed results keep their recorded settings.</p>
    </details>`;
  document.body.append(dialog);
  let config,assets,offset=0,total=0,busy=false,dirty=false;
  let videos=[],videosLoaded=false,videosLoading=false,videoRequest=0,previewVideo=null;
  function summary(){
    if(!config)return;
    window.frameFilterEnabled=config.enabled;
    $('frameFilterSummary').textContent=config.enabled?'People · whole frames':'Off · all prepared frames';
    $('detail').disabled=!!config.enabled||['running','pausing'].includes(state.status);
  }
  function lock(){
    const running=['running','pausing'].includes(state.status)||!!window.learningBusy;
    const locked=running||busy;
    $('frameFilterEnabled').disabled=locked;
    $('saveFrameFilter').disabled=locked||!dirty;
    $('filterVideoSearch').disabled=locked||videosLoading;
    $('filterVideo').disabled=locked||videosLoading;
    $('previewFrameFilter').disabled=locked||dirty||videosLoading||!$('filterVideo').value||!assets?.ready;
    $('cancelFrameFilter').hidden=!busy;
    $('filterLockNote').hidden=!running;
  }
  function clearPreview(){
    previewVideo=null;offset=0;
    $('filterPreviewGrid').replaceChildren();
    $('filterPagination').hidden=true;
    $('filterPreviewStatus').textContent='';
  }
  function validation(){
    const c=assets?.calibration;
    $('frameFilterError').hidden=!!assets?.ready;
    $('frameFilterError').textContent=assets?.ready?'':assets?.error||'The local model is unavailable. Reinstall this build.';
    $('frameFilterValidation').textContent='Provisional calibration: small or obscured people can be missed, and some empty frames can pass. '+
      (c?.held_out?c.held_out.positive_retained+'/'+c.held_out.positive+' labeled people frames were retained in the reserved sample. ':'')+
      'Labels have not been independently human-verified. Preview your footage before relying on the filter.';
  }
  async function load(){
    const d=await api.call('get-frame-filter');
    config=d.config;assets=d.assets;
    $('frameFilterEnabled').checked=config.enabled;
    dirty=false;$('filterSaveStatus').textContent='';
    validation();summary();lock();
  }
  function changed(){
    dirty=true;clearPreview();
    $('filterSaveStatus').textContent='Unsaved change';
    $('filterPreviewStatus').textContent='Save your change before previewing.';
    lock();
  }
  const searchable=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase();
  function updateVideo(){
    const video=videos.find(v=>v.id===$('filterVideo').value);
    $('filterVideoTitle').textContent=video?.title||'';
    $('filterVideoTitle').title=video?.title||'';
    $('filterVideo').title=video?(video.id+(video.title?' · '+video.title:'')):'';
    if(previewVideo!==video?.id)clearPreview();
    lock();
  }
  function renderVideos(){
    const before=$('filterVideo').value,query=searchable($('filterVideoSearch').value.trim());
    const matches=videos.filter(v=>searchable(v.id+' '+(v.title||'')).includes(query));
    $('filterVideo').replaceChildren(...(matches.length?matches.map(v=>{
      const title=(v.title||'').replace(/\s+/g,' ').trim();
      const short=title.length>52?title.slice(0,51)+'…':title;
      const option=el('option','',v.id+(short?' · '+short:'')+(v.compatible?'':' · prepare again'));
      option.value=v.id;option.disabled=!v.compatible;return option;
    }):[Object.assign(el('option','',query?'No matching videos':'Prepare a video to preview this filter'),{value:''})]));
    const previous=matches.find(v=>v.id===before&&v.compatible);
    $('filterVideo').value=previous?before:matches.find(v=>v.compatible)?.id||'';
    updateVideo();
  }
  async function loadVideos(){
    if(videosLoaded||videosLoading)return;
    const request=++videoRequest;
    videosLoading=true;lock();
    $('filterPreviewStatus').textContent='Loading prepared videos…';
    try{
      const result=await api.call('filter-videos');
      if(request!==videoRequest)return;
      videos=result;videosLoaded=true;renderVideos();
      $('filterPreviewStatus').textContent=dirty?'Save your change before previewing.':'';
    }finally{
      if(request===videoRequest){videosLoading=false;lock();}
    }
  }
  $('frameFilterEnabled').onchange=changed;
  $('saveFrameFilter').onclick=act(async()=>{
    config=await api.call('save-frame-filter',{version:2,enabled:$('frameFilterEnabled').checked,cues:['people']});
    dirty=false;clearPreview();summary();lock();
    $('filterSaveStatus').textContent='Saved';
  });
  $('configureFrameFilter').onclick=act(async()=>{
    await load();
    ++videoRequest;videosLoading=false;videosLoaded=false;videos=[];
    $('filterVideoSearch').value='';$('filterVideo').replaceChildren();$('filterVideoTitle').textContent='';
    $('filterPreviewSection').open=false;$('filterInfoSection').open=false;
    clearPreview();lock();dialog.showModal();
  });
  $('filterPreviewSection').ontoggle=act(async()=>{if($('filterPreviewSection').open)await loadVideos();});
  $('filterVideoSearch').oninput=renderVideos;
  $('filterVideo').onchange=updateVideo;
  async function page(){
    if(!previewVideo)return;
    const expectedVideo=previewVideo;
    const data=await api.call('filter-preview-page',{offset,mode:$('filterPreviewMode').value});
    if(expectedVideo!==previewVideo)return;
    total=data.total;
    $('filterPageLabel').textContent=total?(offset+1)+'–'+Math.min(offset+12,total)+' of '+total:'No frames';
    $('filterPrev').disabled=offset===0;$('filterNext').disabled=offset+12>=total;
    $('filterPagination').hidden=false;
    $('filterPreviewGrid').replaceChildren(...data.frames.map(f=>{
      const figure=el('figure',f.selected?'retained':'skipped'),img=el('img');
      img.src=f.image;img.alt='Whole frame '+(f.index+1)+' at '+f.timestamp.toFixed(2)+' seconds';
      const caption=el('figcaption','',(f.selected?'Retained people candidate':'Skipped by people filter')+' · '+f.timestamp.toFixed(2)+'s');
      figure.append(img,caption);return figure;
    }));
  }
  $('previewFrameFilter').onclick=act(async()=>{
    const videoId=$('filterVideo').value;
    busy=true;window.filterPreviewBusy=true;clearPreview();lock();controls();
    try{
      const r=await api.call('preview-frame-filter',videoId);
      previewVideo=videoId;$('filterPreviewMode').value='selected';
      $('filterPreviewStatus').textContent=r.selected+' retained people candidates · '+(r.frames-r.selected)+' skipped · showing retained candidates · '+(r.elapsed_ms/1000).toFixed(1)+'s';
      await page();
    }finally{busy=false;window.filterPreviewBusy=false;lock();controls();}
  });
  $('cancelFrameFilter').onclick=act(()=>api.call('cancel-filter-preview'));
  $('filterPrev').onclick=act(async()=>{offset=Math.max(0,offset-12);await page();});
  $('filterNext').onclick=act(async()=>{offset+=12;await page();});
  $('filterPreviewMode').onchange=act(async()=>{offset=0;await page();});
  api.onFilterProgress(p=>{
    if(busy&&p.status!=='idle')$('filterPreviewStatus').textContent='Screening '+p.screened+' / '+p.total+' · '+p.selected+' retained';
  });
  window.renderFrameFilterState=s=>{
    $('frameFilterMetrics').textContent=s.filterEnabled?(s.framesScreened||0)+' screened · '+(s.framesSelected||0)+' selected · '+(s.framesSkipped||0)+' skipped · '+(s.framesReviewed||0)+' AI reviewed':'';
    lock();
  };
  dialog.addEventListener('close',()=>{
    ++videoRequest;videosLoading=false;
    if(busy)api.call('cancel-filter-preview').catch(()=>{});
  });
  load().catch(e=>{$('frameFilterSummary').textContent=e.message;});
})();
