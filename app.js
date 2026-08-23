
(() => {
  'use strict';

  const Q = window.IKT_QUESTIONS;
  const FIREBASE_CONFIG = window.IKT_FIREBASE_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const VIEW = params.get('view') === 'tv' ? 'tv' : 'host';
  const REQUESTED_CODE = (params.get('code') || '').toUpperCase();
  const app = document.getElementById('app');

  const MODES = {
    nextgen:{label:'NEXT GEN', total:10},
    oldschool:{label:'OLD SCHOOL', total:10},
    showdown:{label:'FAMILY SHOWDOWN', total:20}
  };

  const deepClone = obj => JSON.parse(JSON.stringify(obj));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  const uid = () => Math.random().toString(36).slice(2,9);
  const code4 = () => {
    const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s=''; for(let i=0;i<4;i++) s += chars[Math.floor(Math.random()*chars.length)];
    return s;
  };
  const now = () => Date.now();

  class Cloud {
    constructor(){
      this.db = null;
      this.enabled = Boolean(FIREBASE_CONFIG.projectId && FIREBASE_CONFIG.apiKey);
      if(this.enabled){
        try{
          if(!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
          this.db = firebase.firestore();
        }catch(err){
          console.error(err);
          this.enabled = false;
        }
      }
    }
    doc(code){ return this.db.collection('iktSessions').doc(code); }

    async save(code,state){
      if(!this.enabled) return;
      const clean = deepClone(state);
      const gameUpdatedAtMs = Date.now();
      clean.updatedAtMs = gameUpdatedAtMs;
      await this.doc(code).set({
        gameState: clean,
        gameUpdatedAtMs
      },{merge:true});
    }

    async load(code){
      if(!this.enabled) return null;
      const snap = await this.doc(code).get();
      if(!snap.exists) return null;
      const data = snap.data();
      return data.gameState || data;
    }

    subscribeGame(code,cb){
      if(!this.enabled) return () => {};
      let lastRevision = null;
      return this.doc(code).onSnapshot(s => {
        if(!s.exists) return;
        const root = s.data();
        const game = root.gameState || root;
        const revision = root.gameUpdatedAtMs || game.updatedAtMs || 0;
        if(revision === lastRevision) return;
        lastRevision = revision;
        cb(game, root);
      }, err => console.error('Game subscription failed', err));
    }

    subscribeConnection(code,cb){
      if(!this.enabled) return () => {};
      let lastSeen = null;
      return this.doc(code).onSnapshot(s => {
        if(!s.exists) return;
        const root = s.data();
        const seen = root.displayLastSeenMs || 0;
        if(seen === lastSeen) return;
        lastSeen = seen;
        cb(seen, root);
      }, err => console.error('Connection subscription failed', err));
    }

    async displayHeartbeat(code){
      if(!this.enabled) return;
      await this.doc(code).set({displayLastSeenMs:Date.now()},{merge:true});
    }
  }

  const cloud = new Cloud();

  function initialState(){
    return {
      code:'',
      mode:'',
      phase:'home',
      players:[],
      teams:{nextgen:{name:'NEXT GEN',score:0,members:[]},oldschool:{name:'OLD SCHOOL',score:0,members:[]}},
      questionIndex:0,
      questionOrder:[],
      currentQuestion:null,
      hintsUsed:[],
      revealed:false,
      resolved:false,
      activeTeam:'nextgen',
      stealTeam:null,
      resolution:'',
      tvOverride:'',
      resultOverlay:null,
      displayLastSeenMs:0,
      special:null,
      createdAtMs:Date.now(),
      updatedAtMs:Date.now(),
      syncRevision:0
    };
  }

  let state = initialState();
  let history = [];
  let tvPreviewOpen = false;
  let connectWatcher = null;
  let rapidTimerHandle = null;

  function questionBank(mode){
    return mode === 'showdown' ? Q.showdown : Q[mode];
  }
  function getQuestion(id){
    for(const bank of [Q.nextgen,Q.oldschool,Q.showdown,Q.bonus,Q.omega]){
      const f=bank.find(x=>x.id===id); if(f) return f;
    }
    return null;
  }
  function shuffledIds(arr){
    return arr.map(x=>x.id).sort(()=>Math.random()-.5);
  }
  function currentPoints(){
    if(state.mode!=='showdown') return 1;
    const n=state.questionIndex+1;
    if(n<=5) return 1;
    if(n<=10) return 2;
    if(n<=15) return 3;
    return 4;
  }

  async function sync(){
    state.updatedAtMs = Date.now();
    state.syncRevision = (state.syncRevision||0) + 1;
    renderHost();
    if(tvPreviewOpen) renderTVPreview();
    if(cloud.enabled && state.code){
      try{ await cloud.save(state.code,state); }
      catch(err){ console.error('Cloud save failed',err); }
    }
  }
  function snapshotForUndo(){
    history.push(deepClone(state));
    if(history.length>30) history.shift();
  }
  async function undo(){
    if(!history.length) return;
    const currentTvOverride = state.tvOverride;
    state = history.pop();
    // Undo reverses the last GAME action without changing whether the TV is
    // currently showing the score or paused.
    state.tvOverride = currentTvOverride;
    await sync();
  }

  function setMode(mode){
    snapshotForUndo();
    state = initialState();
    state.code = code4();
    state.mode = mode;
    state.phase='players';
    if(mode==='showdown'){
      state.teams.nextgen.members=['Emma','Ryan','Maya','Noah'];
      state.teams.oldschool.members=['Kim','Mike','Grandpa','Lisa'];
    }else{
      state.players=['Emma','Ryan','Jake','Olivia','Maya','Tyler'].map(n=>({id:uid(),name:n,score:0}));
    }
    sync();
  }

  function prepareGame(){
    const bank=questionBank(state.mode);
    state.questionOrder = state.mode==='showdown' ? bank.map(x=>x.id) : shuffledIds(bank);
    state.questionIndex=0;
    loadCurrentQuestion();
  }

  function loadCurrentQuestion(){
    const id=state.questionOrder[state.questionIndex];
    state.currentQuestion = getQuestion(id);
    state.hintsUsed=[];
    state.revealed=false;
    state.resolved=false;
    state.resolution='';
    state.resultOverlay=null;
    state.stealTeam=null;
    if(state.mode==='showdown') state.activeTeam = state.questionIndex%2===0 ? 'nextgen':'oldschool';
  }

  async function startInstructions(){
    snapshotForUndo();
    prepareGame();
    state.phase='instructions';
    await sync();
  }
  async function startGame(){
    state.phase='question';
    // Start gameplay with a clean undo stack. Undo should reverse game actions,
    // not send the host back into setup/instructions.
    history=[];
    await sync();
  }
  async function useHint(n){
    if(state.hintsUsed.includes(n)) return;
    snapshotForUndo();
    state.hintsUsed.push(n);
    await sync();
  }
  async function revealAnswer(){
    if(state.revealed) return;
    // In Family Showdown, do not allow the TV answer to appear until the
    // answering/steal sequence is fully resolved.
    if(state.mode==='showdown' && !state.resolved) return;
    snapshotForUndo();
    state.revealed=true;
    await sync();
  }

  function addResultOverlay(big,sub,kind='score'){
    state.resultOverlay={big,sub,kind};

    // Functional-test mode: there is no separate Firebase TV yet, so a TV
    // reaction would otherwise expire before the Host manually opens Preview.
    // Open the built-in TV immediately for visible reactions.
    if(!cloud.enabled && !tvPreviewOpen){
      setTimeout(()=>openTVPreview(),0);
    }

    setTimeout(async()=>{
      if(state.resultOverlay && state.resultOverlay.big===big){
        state.resultOverlay=null;
        await sync();
      }
    },2500);
  }

  async function revealThenResult(big,sub,kind='score'){
    // Phase 1: answer is visible by itself.
    // Phase 2: after 2 seconds, show score / no-points overlay for 2 seconds.
    // Phase 3: overlay disappears and the revealed answer remains visible.
    await sync();

    setTimeout(async()=>{
      state.resultOverlay={big,sub,kind};

      if(!cloud.enabled && !tvPreviewOpen){
        setTimeout(()=>openTVPreview(),0);
      }

      await sync();

      setTimeout(async()=>{
        if(
          state.resultOverlay &&
          state.resultOverlay.big===big &&
          state.resultOverlay.sub===sub
        ){
          state.resultOverlay=null;
          await sync();
        }
      },2000);
    },2000);
  }

  async function wrongGuess(){
    if(state.mode==='showdown' || state.resolved || state.revealed) return;
    addResultOverlay('✕','WRONG — SOMEONE ELSE CAN ANSWER','wrong');
    await sync();
  }

  async function awardIndividual(playerId){
    if(state.resolved) return;
    snapshotForUndo();
    const p=state.players.find(x=>x.id===playerId);
    if(!p) return;

    p.score += 1;
    state.resolved=true;
    state.revealed=true;
    state.resolution=`${p.name.toUpperCase()} +1 POINT`;

    await revealThenResult(
      `${p.name.toUpperCase()} +1`,
      'POINT AWARDED',
      'score'
    );
  }

  async function passQuestion(){
    if(state.resolved) return;
    snapshotForUndo();

    state.resolved=true;
    state.revealed=true;
    state.resolution='NO POINTS';

    await revealThenResult('NO POINTS','NO POINTS AWARDED','neutral');
  }

  async function awardTeam(team){
    if(state.resolved) return;

    // Before a steal, only the active team can score.
    // During a steal, only the stealing team can score.
    if(state.stealTeam){
      if(team!==state.stealTeam) return;
    }else if(team!==state.activeTeam){
      return;
    }

    snapshotForUndo();

    const pts=currentPoints();
    state.teams[team].score += pts;

    // FAMILY SHOWDOWN scoring is one Host tap:
    // add the points + reveal the answer + show who received the points.
    state.resolved=true;
    state.revealed=true;
    state.resolution=`${state.teams[team].name} +${pts}`;

    await revealThenResult(
      `${state.teams[team].name} +${pts}`,
      `POINT${pts===1?'':'S'} AWARDED`,
      'score'
    );
  }

  async function offerSteal(){
    if(state.mode!=='showdown' || state.revealed || state.resolved || state.stealTeam) return;
    snapshotForUndo();
    state.stealTeam = state.activeTeam==='nextgen'?'oldschool':'nextgen';
    state.resolution=`${state.teams[state.stealTeam].name} CAN STEAL`;
    addResultOverlay('✕','WRONG — STEAL CHANCE','wrong');
    await sync();
  }

  async function stealMissed(){
    if(!state.stealTeam || state.resolved) return;
    snapshotForUndo();

    state.resolved=true;
    state.revealed=true;
    state.resolution='NO POINTS';

    await revealThenResult('NO POINTS','NO POINTS AWARDED','neutral');
  }

  async function nextQuestion(){
    if(!state.resolved || !state.revealed) return;
    snapshotForUndo();
    if(state.questionIndex >= state.questionOrder.length-1){
      finishGame();
      return;
    }
    state.questionIndex++;
    loadCurrentQuestion();
    await sync();
  }
  async function changeQuestion(){
    snapshotForUndo();
    const bank=questionBank(state.mode).filter(q=>q.id!==state.currentQuestion?.id);
    const q=bank[Math.floor(Math.random()*bank.length)];
    state.currentQuestion=q;
    state.questionOrder[state.questionIndex]=q.id;
    state.hintsUsed=[];
    state.revealed=false;
    state.resolved=false;
    state.resolution='';
    state.stealTeam=null;
    state.resultOverlay=null;
    await sync();
  }
  async function toggleTvOverride(type){
    // Score and Pause are display controls, not gameplay actions, so they do
    // not belong in the Undo history.
    state.tvOverride = state.tvOverride===type ? '' : type;
    await sync();
    // During local/demo testing, automatically surface the TV so the control
    // visibly does something even without a second device connected.
    if(!cloud.enabled && !tvPreviewOpen) openTVPreview();
  }
  async function clearOverride(){
    if(!state.tvOverride) return;
    state.tvOverride='';
    await sync();
  }

  function sortedPlayers(){
    return [...state.players].sort((a,b)=>b.score-a.score || a.name.localeCompare(b.name));
  }
  async function finishGame(){
    snapshotForUndo();
    state.phase='final';
    state.tvOverride='';
    state.special=null;
    await sync();
  }

  function showSpecialMenu(){
    const existing=document.getElementById('specialMenu');
    if(existing) existing.remove();

    const shared = `
      <button class="secondary" data-sp="logo">LOGO CHALLENGE</button>
      <button class="secondary" data-sp="who">WHO AM I?</button>
      <button class="secondary" data-sp="object">WHAT IS THIS?</button>
      <button class="secondary" data-sp="artist">NAME THAT ARTIST</button>
      <button class="secondary" data-sp="movie">MOVIE / TV CHALLENGE</button>
    `;

    const showdownOnly = `
      <button class="secondary" data-sp="bonus">★+ BONUS VAULT</button>
      <button class="secondary" data-sp="rapid">⚡ RAPID FIRE</button>
      <button class="secondary" data-sp="omega">Ω OMEGA</button>
    `;

    const o=document.createElement('div');
    o.id='specialMenu';o.className='overlay';
    o.innerHTML=`<div class="modal">
      <h2>SPECIAL ROUNDS</h2>
      <div class="modal-actions">
        ${state.mode==='showdown' ? showdownOnly + shared : shared}
      </div>
      ${state.mode!=='showdown'?`<div class="small-muted" style="margin-top:10px">Individual specials are worth 1 point and do not advance the regular question count.</div>`:''}
      <div style="margin-top:10px;text-align:right"><button class="secondary" id="closeSpecial">CLOSE</button></div>
    </div>`;
    document.body.appendChild(o);
    o.querySelector('#closeSpecial').onclick=()=>o.remove();
    o.querySelectorAll('[data-sp]').forEach(b=>b.onclick=()=>{o.remove();startSpecial(b.dataset.sp);});
  }

  function visualSpecialBank(type){
    const bank = Q.specials?.[type] || Q.specials?.logo || [];
    return deepClone(bank);
  }

  async function startSpecial(type){
    snapshotForUndo();
    if(type==='bonus'){
      const q=Q.bonus[Math.floor(Math.random()*Q.bonus.length)];
      state.special={
        type:'bonus',
        stage:'question',
        question:q,
        value:3,
        revealed:false,
        resolved:false,
        result:'',
        hintsUsed:[]
      };
    }else if(type==='rapid'){
      const items=deepClone(Q.rapid).sort(()=>Math.random()-.5);
      state.special={
        type:'rapid',
        stage:'intro',
        team:'nextgen',
        items,
        index:0,
        correct:0,
        passed:[],
        running:false,
        endAt:0,
        advancing:false,
        results:{}
      };
    }else if(type==='omega'){
      const q=Q.omega[Math.floor(Math.random()*Q.omega.length)];
      state.special={
        type:'omega',
        stage:'intro',
        question:q,
        revealed:false,
        locked:false,
        hintsUsed:[]
      };
    }else{
      const bank=visualSpecialBank(type);
      state.special={
        type:'visual',
        kind:type,
        title:bank[0]?.title || 'SPECIAL ROUND',
        icon:bank[0]?.icon || '?',
        stage:'question',
        questions:bank,
        index:0,
        question:bank[0] || null,
        revealed:false,
        resolved:false,
        resolution:'',
        hintsUsed:[]
      };
    }
    state.phase='special';
    await sync();
  }

  async function exitSpecial(){
    stopRapidTimer();
    state.special=null;
    state.phase='question';
    await sync();
  }

  async function bonusSetValue(v){
    const s=state.special;
    if(!s || s.type!=='bonus' || s.resolved) return;
    s.value=v;
    await sync();
  }

  async function bonusHint(n){
    const s=state.special;
    if(!s || s.type!=='bonus') return;
    snapshotForUndo();
    s.hintsUsed=[...(s.hintsUsed||[]),n].filter((x,i,a)=>a.indexOf(x)===i);
    await sync();
  }

  async function bonusWrong(){
    const s=state.special;
    if(!s || s.type!=='bonus' || s.resolved || s.revealed) return;
    addResultOverlay('✕','WRONG — SOMEONE ELSE CAN ANSWER','wrong');
    await sync();
  }

  async function bonusAward(team){
    const s=state.special;
    if(!s || s.type!=='bonus' || s.resolved) return;
    snapshotForUndo();

    const pts=Number(s.value||0);
    state.teams[team].score += pts;
    s.resolved=true;
    s.revealed=true;
    s.result=`${state.teams[team].name} +${pts}`;

    await revealThenResult(
      `${state.teams[team].name} +${pts}`,
      `BONUS POINT${pts===1?'':'S'} AWARDED`,
      'score'
    );
  }

  async function bonusPass(){
    const s=state.special;
    if(!s || s.type!=='bonus' || s.resolved) return;
    snapshotForUndo();

    s.resolved=true;
    s.revealed=true;
    s.result='NO POINTS';

    await revealThenResult('NO POINTS','NO POINTS AWARDED','neutral');
  }

  async function bonusNext(){
    const s=state.special;
    if(!s || s.type!=='bonus' || !s.resolved || !s.revealed) return;
    snapshotForUndo();

    const choices=Q.bonus.filter(q=>q.id!==s.question?.id);
    const bank=choices.length?choices:Q.bonus;
    const q=bank[Math.floor(Math.random()*bank.length)];

    s.question=q;
    s.revealed=false;
    s.resolved=false;
    s.result='';
    s.hintsUsed=[];
    state.resultOverlay=null;
    await sync();
  }

  function stopRapidTimer(){
    if(rapidTimerHandle){clearInterval(rapidTimerHandle);rapidTimerHandle=null;}
  }
  async function rapidStart(){
    const s=state.special;
    s.stage='game';s.running=true;s.endAt=Date.now()+60000;
    await sync();
    stopRapidTimer();
    rapidTimerHandle=setInterval(async()=>{
      if(!state.special || state.special.type!=='rapid'){stopRapidTimer();return;}
      if(Date.now()>=state.special.endAt){
        state.special.running=false;state.special.stage='finish';
        stopRapidTimer();await sync();
      }else{
        renderHost();
        if(tvPreviewOpen) renderTVPreview();
      }
    },250);
  }
  async function rapidAdvance(awardPoint){
    const s=state.special;
    if(!s || s.type!=='rapid' || !s.running || s.stage!=='game' || s.advancing) return;

    s.advancing=true;
    const item=s.items[s.index];

    if(awardPoint){
      s.correct += 1;
      state.teams[s.team].score += 1;
    }else if(item){
      s.passed.push(item);
    }

    s.index += 1;

    if(s.index>=s.items.length){
      s.running=false;
      s.stage='finish';
      stopRapidTimer();
    }

    s.advancing=false;

    // Immediate local redraw so the next logo changes the instant the
    // Host taps the button instead of waiting for a sync round-trip.
    renderHost();
    if(tvPreviewOpen) renderTVPreview();

    await sync();
  }

  async function rapidCorrect(){
    await rapidAdvance(true);
  }

  async function rapidPass(){
    await rapidAdvance(false);
  }

  async function rapidSwitchTeam(){
    const s=state.special;
    if(!s || s.type!=='rapid') return;

    s.results=s.results||{};
    s.results[s.team]={correct:s.correct,passed:s.passed.length};

    s.team = s.team==='nextgen'?'oldschool':'nextgen';
    s.items=deepClone(Q.rapid).sort(()=>Math.random()-.5);
    s.index=0;
    s.correct=0;
    s.passed=[];
    s.stage='intro';
    s.running=false;
    s.endAt=0;
    s.advancing=false;
    await sync();
  }

  async function omegaHint(n){
    const s=state.special;
    if(!s || s.type!=='omega') return;
    snapshotForUndo();
    s.hintsUsed=[...(s.hintsUsed||[]),n].filter((x,i,a)=>a.indexOf(x)===i);
    await sync();
  }

  async function omegaStage(stage){
    state.special.stage=stage;
    if(stage==='reveal') state.special.revealed=true;
    await sync();
  }
  async function omegaAward(team){
    snapshotForUndo();
    state.teams[team].score += 1;
    state.special.stage='winner';
    state.special.winner=team;
    await sync();
  }

  /* ---------------- HOST RENDER ---------------- */
  function headerHtml(){
    const mode=MODES[state.mode]?.label || 'I KNOW THAT!';
    const cloudClass=cloud.enabled?'on':'demo';
    const cloudText=cloud.enabled?'FIREBASE ON':'DEMO MODE';
    const tvOn = state.displayLastSeenMs && (Date.now()-state.displayLastSeenMs)<25000;
    return `<header class="host-header">
      <div class="left-actions">
        <button class="secondary" id="homeBtn">⌂ HOME</button>
        ${state.phase!=='home'&&state.mode?`<button class="secondary" id="tvPreviewBtn">TV PREVIEW</button>`:''}
      </div>
      <div class="brand">
        <img src="assets/compact_logo.png" class="logo" alt="I KNOW THAT!">
        <div class="brandtext"><div class="tiny">HOST CONTROLS</div><div class="mode">${esc(mode)}</div></div>
      </div>
      <div class="right-status">
        <div class="cloud-pill ${cloudClass}">${cloudText}</div>
        <div class="tv-pill ${tvOn?'on':''}">${tvOn?'TV CONNECTED':cloud.enabled?'TV WAITING':'BUILT-IN PREVIEW'}</div>
      </div>
    </header>`;
  }

  function renderHost(){
    if(VIEW!=='host') return;
    app.innerHTML=`<div class="host-shell">${headerHtml()}<main class="host-main" id="hostMain">${hostPhaseHtml()}</main></div>`;
    bindHost();
  }

  function hostPhaseHtml(){
    switch(state.phase){
      case 'home': return homeHtml();
      case 'players': return playersHtml();
      case 'connect': return connectHtml();
      case 'instructions': return instructionsHostHtml();
      case 'question': return questionHostHtml();
      case 'special': return specialHostHtml();
      case 'final': return finalHostHtml();
      default:return homeHtml();
    }
  }

  function homeHtml(){
    return `<div class="home-wrap"><section class="home-card">
      <div class="home-hero">
        <img src="assets/compact_logo.png" class="logo" alt="">
        <h1>THE FAMILY GAME OF THEN, NOW & EVERYTHING IN BETWEEN</h1>
        <p>Choose a game. The full flow is now wired for testing.</p>
      </div>
      <div class="mode-grid">
        <button class="mode-card" data-mode="nextgen"><div class="icon">!</div><div><h2>NEXT GEN</h2><p>Individual game for the younger generation.</p></div><div class="go">START GAME →</div></button>
        <button class="mode-card" data-mode="oldschool"><div class="icon">◉</div><div><h2>OLD SCHOOL</h2><p>Individual game for the adults.</p></div><div class="go">START GAME →</div></button>
        <button class="mode-card showdown" data-mode="showdown"><div class="icon">⚡</div><div><h2>FAMILY SHOWDOWN</h2><p>Next Gen vs Old School. Generations collide. Bragging begins.</p></div><div class="go">START SHOWDOWN →</div></button>
      </div>
      ${cloud.enabled?`<div class="home-bottom"><input class="resume-code" id="resumeCode" maxlength="4" placeholder="GAME CODE"><button class="secondary" id="resumeBtn">RESUME GAME</button></div>`:
      `<div class="home-bottom"><div class="demo-note">Firebase is not configured yet. Everything can be tested with the built-in TV Preview.</div></div>`}
    </section></div>`;
  }

  function playersHtml(){
    if(state.mode==='showdown') return showdownPlayersHtml();
    return `<div class="setup-wrap"><section class="setup-card">
      <div class="setup-head"><div><h1>WHO'S PLAYING?</h1><p>Add only the players actually playing. Up to 10.</p></div><div class="setup-count">${state.players.length}/10</div></div>
      <div class="setup-body">
        <div class="add-row"><input id="playerInput" maxlength="18" placeholder="Enter player name"><button class="teal-btn" id="addPlayer">+ ADD PLAYER</button></div>
        <div class="player-grid">${state.players.map((p,i)=>`<div class="player-chip"><span class="player-num">${i+1}</span><span class="player-name">${esc(p.name)}</span><button class="xbtn" data-remove-player="${p.id}">×</button></div>`).join('')}</div>
      </div>
      <div class="setup-footer"><span class="small-muted">Only these names will appear on the TV.</span><button class="primary" id="continueSetup" ${state.players.length<2?'disabled':''}>CONTINUE TO TV →</button></div>
    </section></div>`;
  }

  function showdownPlayersHtml(){
    const team=(key,old='')=>`<section class="team-box ${old}">
      <div class="team-title-row"><div class="team-title">${state.teams[key].name}</div><div class="badge">${state.teams[key].members.length}</div></div>
      <div class="team-add"><input id="${key}Input" maxlength="18" placeholder="Add name"><button class="teal-btn" data-add-team="${key}">+</button></div>
      <div class="team-people">${state.teams[key].members.map((n,i)=>`<div class="team-person"><span>${esc(n)}</span><button class="xbtn" data-remove-team="${key}" data-index="${i}">×</button></div>`).join('')}</div>
    </section>`;
    return `<div class="setup-wrap"><section class="setup-card">
      <div class="setup-head"><div><h1>BUILD THE TEAMS</h1><p>Assign everyone to Next Gen or Old School.</p></div><div class="setup-count">${state.teams.nextgen.members.length+state.teams.oldschool.members.length} PLAYERS</div></div>
      <div class="setup-body team-setup">${team('nextgen')}<div class="vs">VS</div>${team('oldschool','old')}</div>
      <div class="setup-footer"><span class="small-muted">The TV scores the teams, not individual players.</span><button class="primary" id="continueSetup" ${(!state.teams.nextgen.members.length||!state.teams.oldschool.members.length)?'disabled':''}>CONTINUE TO TV →</button></div>
    </section></div>`;
  }

  function displayUrl(){
    const base=location.href.split('?')[0].split('#')[0];
    return `${base}?view=tv&code=${state.code}`;
  }

  function connectHtml(){
    const tvOn = state.displayLastSeenMs && (Date.now()-state.displayLastSeenMs)<25000;
    const ready = cloud.enabled ? tvOn : true;
    return `<div class="setup-wrap"><section class="connect-card">
      <div class="connect-head"><h1>CONNECT THE TV</h1><p>${cloud.enabled?'Open the TV display URL on the second device.':'Use the built-in TV Preview for this first functional test.'}</p></div>
      <div class="connect-grid">
        <div class="code-pane"><div><div class="game-code-label">GAME CODE</div><div class="game-code">${state.code}</div><div class="display-url">${esc(displayUrl())}</div><div style="margin-top:12px"><button class="secondary" id="copyUrl">COPY TV LINK</button></div></div></div>
        <div class="status-pane">
          <div>
            <div class="status-circle ${tvOn?'on':''}">${tvOn?'✓':'•••'}</div>
            <h2>${tvOn?'TV CONNECTED':cloud.enabled?'WAITING FOR TV':'DEMO TV READY'}</h2>
            <p>${tvOn?'The display is ready.':cloud.enabled?'Keep this screen open while the TV joins.':'Open TV Preview and we can test the entire game immediately.'}</p>
          </div>
        </div>
      </div>
      <div class="connect-actions"><div class="demo-note">${cloud.enabled?'Firestore session is live.':'Cross-device sync turns on as soon as firebase-config.js is filled.'}</div><div style="display:flex;gap:8px"><button class="secondary" id="openPreviewConnect">OPEN TV PREVIEW</button><button class="primary" id="showInstructions" ${ready?'':'disabled'}>SHOW INSTRUCTIONS →</button></div></div>
    </section></div>`;
  }

  function rulesForMode(){
    if(state.mode==='showdown') return [
      ['NEXT GEN VS OLD SCHOOL.','Work with your team before giving the final answer.'],
      ['THE POINTS GO UP.','Questions are worth 1, then 2, then 3, then 4 points.'],
      ['A MISS CAN BECOME A STEAL.','The other team may get one shot at the points.'],
      ['EXPECT A FEW SURPRISES.','Bonus Vault, Rapid Fire, and maybe Ω Omega.']
    ];
    return [
      ['LISTEN TO THE QUESTION.','Keep your answer to yourself until you are called on.'],
      ['USE A HINT IF YOU NEED IT.','Hints do not normally cost points.'],
      ['GET IT RIGHT. GET THE POINT.','If you miss, someone else may get a steal chance.'],
      ['HIGHEST SCORE WINS.','Bragging rights are absolutely included.']
    ];
  }

  function instructionsHostHtml(){
    return `<div class="setup-wrap"><section class="instructions-host">
      <h1>INSTRUCTIONS ARE ON THE TV</h1>
      <div class="rule-grid">${rulesForMode().map((r,i)=>`<div class="rule"><div class="rule-num">${i+1}</div><div><b>${r[0]}</b><span>${r[1]}</span></div></div>`).join('')}</div>
      <div class="center-actions"><button class="secondary" id="previewInstructions">TV PREVIEW</button><button class="primary" id="startGame">START GAME →</button></div>
    </section></div>`;
  }

  function questionHostHtml(){
    const q=state.currentQuestion;
    if(!q) return `<div class="setup-wrap"><div class="modal"><h2>No question loaded.</h2></div></div>`;
    const points=currentPoints();
    const teamTurn=state.mode==='showdown'
      ? `<div class="turn-banner">${state.stealTeam ? `STEAL CHANCE — ${state.teams[state.stealTeam].name} ANSWERS` : `${state.teams[state.activeTeam].name} ANSWERS FIRST`}</div>`
      : '';
    const revealLocked = state.mode==='showdown' && !state.resolved;

    return `<div class="game-grid">
      <section class="question-panel">
        <div class="qtop">
          <div class="qcount">QUESTION <b>${state.questionIndex+1}</b> OF ${state.questionOrder.length}</div>
          <div class="qcat">${esc(q.category)}</div>
          <div class="qpts">${points} POINT${points===1?'':'S'}</div>
        </div>

        <div class="qcard">
          ${teamTurn}
          <div class="qtext">${esc(q.question)}</div>

          <div class="host-private">
            <div class="host-answer">
              <div class="private-label">ANSWER · HOST ONLY</div>
              <div class="private-answer">${esc(q.answer)}</div>
            </div>
            <div class="host-hints">
              <div class="host-hint ${state.hintsUsed.includes(1)?'sent':''}">
                <div class="private-label">HINT 1 · ${state.hintsUsed.includes(1)?'ON TV':'HOST ONLY'}</div>
                <div>${esc(q.hint1)}</div>
              </div>
              <div class="host-hint ${state.hintsUsed.includes(2)?'sent':''}">
                <div class="private-label">HINT 2 · ${state.hintsUsed.includes(2)?'ON TV':'HOST ONLY'}</div>
                <div>${esc(q.hint2||'No second hint.')}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="primary-controls">
          <button class="secondary" id="hint1" ${state.hintsUsed.includes(1)?'disabled':''}>${state.hintsUsed.includes(1)?'✓ HINT 1 ON TV':'💡 SHOW HINT 1 ON TV'}</button>
          <button class="secondary" id="hint2" ${state.hintsUsed.includes(2)?'disabled':''}>${state.hintsUsed.includes(2)?'✓ HINT 2 ON TV':'💡 SHOW HINT 2 ON TV'}</button>
          <button class="green-btn" id="reveal" ${(state.revealed||revealLocked)?'disabled':''}>${state.revealed?'✓ ANSWER IS ON TV':revealLocked?'RESOLVE ANSWER / STEAL FIRST':'SHOW ANSWER ON TV'}</button>
        </div>

        <div class="sub-controls">
          <button class="secondary" id="changeQ">↻ CHANGE QUESTION</button>
          <button class="secondary" id="undoBtn" ${history.length?'':'disabled'}>↶ UNDO</button>
          <button class="secondary" id="showScore">${state.tvOverride==='scoreboard'?'← RETURN TO QUESTION':'▤ SHOW SCORE'}</button>
          <button class="secondary" id="pauseTv">${state.tvOverride==='pause'?'▶ RESUME TV':'Ⅱ PAUSE TV'}</button>
          <button class="secondary" id="specialsBtn">★ SPECIALS</button>
        </div>
      </section>

      ${state.mode==='showdown'?showdownControlHtml():individualControlHtml()}
    </div>`;
  }

  function individualControlHtml(){
    const wrongActive=state.resultOverlay?.kind==='wrong';
    const canAnswer=!state.resolved && !state.revealed && !wrongActive;
    const readyForNext=state.resolved && state.revealed;
    return `<aside class="score-control">
      <div class="score-title">ANSWER RESULT</div>
      <div class="small-muted" style="text-align:center">
        ${state.resolved
          ? 'Question complete.'
          : (state.revealed?'Answer is already on TV. Record the result.':'Host knows the answer. Keep taking guesses until someone gets it.')}
      </div>

      <button class="wrong-btn ${wrongActive?'active':''}" id="wrongGuess" ${canAnswer?'':'disabled'}>${wrongActive?'✕ WRONG SENT TO TV':'✕ WRONG'}</button>

      <div class="small-muted" style="text-align:center">AWARD 1 POINT</div>
      <div class="player-score-list">
        ${sortedPlayers().map(p=>`<button class="pscore ${!state.resolved?'enabled':''}" data-award-player="${p.id}" ${state.resolved?'disabled':''}><span>${esc(p.name)}</span><strong>${p.score}</strong></button>`).join('')}
      </div>

      <button class="secondary" id="passQ" ${state.resolved?'disabled':''}>PASS · NOBODY KNOWS</button>

      <div class="resolution ${state.resolved?'done':''}">${esc(state.resolution||'WAITING FOR AN ANSWER')}</div>

      <button class="primary next-button" id="nextQ" ${readyForNext?'':'disabled'}>NEXT QUESTION →</button>
      <div class="gate">
        ${readyForNext
          ? 'Question complete.'
          : 'Wrong guesses do not end the question. Award a point or Pass when finished.'}
      </div>
    </aside>`;
  }

  function showdownControlHtml(){
    const pts=currentPoints();
    const steal=state.stealTeam;
    const wrongActive=state.resultOverlay?.kind==='wrong';
    const readyForNext=state.resolved && state.revealed;

    return `<aside class="score-control">
      <div class="score-title">TEAM SCORE</div>

      <div class="team-score-card ${state.resolution.startsWith('NEXT GEN +')?'winner':''}">
        <span class="tname">NEXT GEN</span><span class="tscore">${state.teams.nextgen.score}</span>
      </div>

      <div class="team-score-card old ${state.resolution.startsWith('OLD SCHOOL +')?'winner':''}">
        <span class="tname">OLD SCHOOL</span><span class="tscore">${state.teams.oldschool.score}</span>
      </div>

      <div class="action-stack">
        ${wrongActive?`<div class="host-wrong-confirm">✕ WRONG SENT TO TV</div>`:''}
        ${state.resolved ? `
          <div style="text-align:center;color:#a9e8bd;font-size:10px;font-weight:1000">${state.revealed?'✓ ANSWER REVEALED':'RESULT RECORDED'}</div>
          <div class="small-muted" style="text-align:center">${state.revealed?'Answer shown first, then score/pass result.':'Result recorded.'}</div>
        ` : !steal ? `
          <div style="text-align:center;color:#9bded9;font-size:10px;font-weight:1000">${state.teams[state.activeTeam].name} ANSWERS FIRST</div>
          <button class="teal-btn" data-award-team="${state.activeTeam}">${state.teams[state.activeTeam].name} +${pts}</button>
          <button class="wrong-btn" id="offerSteal">✕ ${state.teams[state.activeTeam].name} WRONG → STEAL</button>
          <button class="secondary" id="passQ">PASS · NOBODY KNOWS</button>
        ` : `
          <div style="text-align:center;color:#ffaf78;font-size:10px;font-weight:1000">STEAL CHANCE — ${state.teams[steal].name}</div>
          <button class="primary" data-award-team="${steal}">${state.teams[steal].name} STEAL +${pts}</button>
          <button class="wrong-btn" id="stealMiss">✕ STEAL MISSED</button>
        `}
      </div>

      <div class="resolution ${state.resolved?'done':''}">${esc(state.resolution||'WAITING FOR AN ANSWER')}</div>

      <button class="primary next-button" id="nextQ" ${readyForNext?'':'disabled'}>NEXT QUESTION →</button>
      <div class="gate">
        ${readyForNext
          ? 'Question complete — ready for Next.'
          : steal
            ? 'Let the stealing team answer. The TV still cannot see the answer.'
            : 'Award points or Pass. Wrong sends the question to the other generation for a steal.'}
      </div>
    </aside>`;
  }

  function specialHostHtml(){
    const s=state.special;
    if(!s) return questionHostHtml();
    if(s.type==='bonus') return bonusHostHtml(s);
    if(s.type==='rapid') return rapidHostHtml(s);
    if(s.type==='omega') return omegaHostHtml(s);
    return visualHostHtml(s);
  }

  function bonusHostHtml(s){
    const q=s.question;
    const wrongActive=state.resultOverlay?.kind==='wrong';
    const ready=s.resolved && s.revealed;

    return `<div class="game-grid">
      <section class="question-panel">
        <div class="qtop">
          <div class="qcount">SPECIAL</div>
          <div class="qcat">★+ BONUS VAULT</div>
          <div class="qpts">+${s.value} POINT${s.value===1?'':'S'}</div>
        </div>

        <div class="qcard">
          <div class="qtext">${esc(q.question)}</div>

          <div class="host-private">
            <div class="host-answer">
              <div class="private-label">ANSWER · HOST ONLY</div>
              <div class="private-answer">${esc(q.answer)}</div>
            </div>

            <div class="host-hints">
              <div class="host-hint ${s.hintsUsed?.includes(1)?'sent':''}">
                <div class="private-label">HINT 1 · ${s.hintsUsed?.includes(1)?'ON TV':'HOST ONLY'}</div>
                <div>${esc(q.hint1)}</div>
              </div>
              <div class="host-hint ${s.hintsUsed?.includes(2)?'sent':''}">
                <div class="private-label">HINT 2 · ${s.hintsUsed?.includes(2)?'ON TV':'HOST ONLY'}</div>
                <div>${esc(q.hint2)}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="primary-controls">
          <button class="secondary" id="bonusHint1" ${s.hintsUsed?.includes(1)?'disabled':''}>${s.hintsUsed?.includes(1)?'✓ HINT 1 ON TV':'💡 SHOW HINT 1 ON TV'}</button>
          <button class="secondary" id="bonusHint2" ${s.hintsUsed?.includes(2)?'disabled':''}>${s.hintsUsed?.includes(2)?'✓ HINT 2 ON TV':'💡 SHOW HINT 2 ON TV'}</button>
          <button class="green-btn" disabled>${s.revealed?'✓ ANSWER IS ON TV':'ANSWER REVEALS WITH SCORE / PASS'}</button>
        </div>

        <div class="sub-controls">
          <button class="secondary" id="undoBtn" ${history.length?'':'disabled'}>↶ UNDO</button>
          <button class="secondary" id="showScore">${state.tvOverride==='scoreboard'?'← RETURN TO QUESTION':'▤ SHOW SCORE'}</button>
          <button class="secondary" id="pauseTv">${state.tvOverride==='pause'?'▶ RESUME TV':'Ⅱ PAUSE TV'}</button>
          <button class="secondary" id="exitSpecial">← RETURN TO SHOWDOWN</button>
        </div>
      </section>

      <aside class="score-control">
        <div class="score-title">TEAM SCORE</div>

        <div class="team-score-card">
          <span class="tname">NEXT GEN</span>
          <span class="tscore">${state.teams.nextgen.score}</span>
        </div>
        <div class="team-score-card old">
          <span class="tname">OLD SCHOOL</span>
          <span class="tscore">${state.teams.oldschool.score}</span>
        </div>

        <div class="bonus-value-box">
          <div class="bonus-value-label">BONUS POINT VALUE</div>
          <div class="value-row">
            ${[1,2,3,5].map(v=>`<button class="secondary bonus-value-btn ${s.value===v?'selected':''}" data-bonus-value="${v}" ${s.resolved?'disabled':''}>+${v}</button>`).join('')}
          </div>
        </div>

        ${wrongActive?`<div class="host-wrong-confirm">✕ WRONG SENT TO TV</div>`:''}

        <button class="wrong-btn ${wrongActive?'active':''}" id="bonusWrong" ${(!s.resolved&&!s.revealed&&!wrongActive)?'':'disabled'}>
          ${wrongActive?'✕ WRONG SENT TO TV':'✕ WRONG · KEEP QUESTION OPEN'}
        </button>

        <button class="teal-btn" data-bonus-team="nextgen" ${s.resolved?'disabled':''}>NEXT GEN +${s.value}</button>
        <button class="primary" data-bonus-team="oldschool" ${s.resolved?'disabled':''}>OLD SCHOOL +${s.value}</button>
        <button class="secondary" id="bonusPass" ${s.resolved?'disabled':''}>PASS · NO POINTS</button>

        <div class="resolution ${s.resolved?'done':''}">${esc(s.result||'WAITING FOR AN ANSWER')}</div>

        <button class="primary next-button" id="bonusNext" ${ready?'':'disabled'}>DRAW ANOTHER BONUS →</button>
      </aside>
    </div>`;
  }

  function rapidRemaining(s){
    if(!s.running) return s.stage==='finish'?0:60;
    return Math.max(0,Math.ceil((s.endAt-Date.now())/1000));
  }

  function rapidHostHtml(s){
    const item=s.items[Math.min(s.index,s.items.length-1)];
    const itemNum=Math.min(s.index+1,s.items.length);

    return `<div class="game-grid">
      <section class="question-panel">
        <div class="qtop">
          <div class="qcount">${s.stage==='game'?`LOGO ${itemNum} OF ${s.items.length}`:'SPECIAL'}</div>
          <div class="qcat">⚡ RAPID FIRE · ${state.teams[s.team].name}</div>
          <div class="qpts">1 POINT EACH</div>
        </div>

        <div class="qcard rapid-qcard">
          ${s.stage==='intro'?`
            <div class="rapid-intro-big">60 SECONDS</div>
            <div class="qtext">NAME EACH LOGO AS FAST AS YOU CAN.</div>
          `:s.stage==='finish'?`
            <div class="rapid-intro-big">ROUND COMPLETE</div>
            <div class="qtext">${s.correct} POINT${s.correct===1?'':'S'} EARNED</div>
          `:`
            <div class="rapid-host-logo">${esc(item?.visual||'?')}</div>
            <div class="host-private rapid-answer-private">
              <div class="host-answer">
                <div class="private-label">ANSWER · HOST ONLY</div>
                <div class="private-answer">${esc(item?.answer||'')}</div>
              </div>
            </div>
          `}
        </div>

        <div class="sub-controls">
          <button class="secondary" id="exitSpecial">← RETURN TO SHOWDOWN</button>
        </div>
      </section>

      <aside class="score-control rapid-control">
        <div class="score-title">RAPID FIRE</div>
        <div class="rapid-team-label">${state.teams[s.team].name}</div>

        <div class="rapid-timer-box">
          <div class="rapid-timer-label">TIME</div>
          <div class="timer-host">${rapidRemaining(s)}</div>
        </div>

        <div class="team-score-card">
          <span class="tname">NEXT GEN</span>
          <span class="tscore">${state.teams.nextgen.score}</span>
        </div>
        <div class="team-score-card old">
          <span class="tname">OLD SCHOOL</span>
          <span class="tscore">${state.teams.oldschool.score}</span>
        </div>

        ${s.stage==='intro'?`
          <button class="primary" id="rapidStart">START 60 SECONDS</button>
        `:s.stage==='game'?`
          <button class="green-btn rapid-big-action" id="rapidCorrect" ${s.advancing?'disabled':''}>+1 · NEXT LOGO</button>
          <button class="secondary rapid-big-action" id="rapidPass" ${s.advancing?'disabled':''}>PASS · NEXT LOGO</button>
          <div class="resolution done">${s.correct} POINT${s.correct===1?'':'S'} · ${s.passed.length} PASSED · ${Math.max(0,s.items.length-s.index)} LEFT</div>
        `:`
          <button class="teal-btn" id="rapidSwitch">RUN OTHER TEAM</button>
        `}
      </aside>
    </div>`;
  }

  function omegaHostHtml(s){
    const q=s.question;

    return `<div class="game-grid">
      <section class="question-panel">
        <div class="qtop">
          <div class="qcount">FINAL SPECIAL</div>
          <div class="qcat">Ω OMEGA</div>
          <div class="qpts">FINAL CHALLENGE</div>
        </div>

        <div class="qcard">
          ${s.stage==='intro'
            ? `<div class="qtext">BOTH TEAMS ANSWER PRIVATELY. NO SPEED ADVANTAGE.</div>`
            : `<div class="qtext">${esc(q.question)}</div>`}

          <div class="host-private">
            <div class="host-answer">
              <div class="private-label">ANSWER · HOST ONLY</div>
              <div class="private-answer">${esc(q.answer)}</div>
            </div>
            <div class="host-hints">
              <div class="host-hint ${s.hintsUsed?.includes(1)?'sent':''}">
                <div class="private-label">HINT 1 · ${s.hintsUsed?.includes(1)?'ON TV':'HOST ONLY'}</div>
                <div>${esc(q.hint1)}</div>
              </div>
              <div class="host-hint ${s.hintsUsed?.includes(2)?'sent':''}">
                <div class="private-label">HINT 2 · ${s.hintsUsed?.includes(2)?'ON TV':'HOST ONLY'}</div>
                <div>${esc(q.hint2)}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="primary-controls">
          <button class="secondary" id="omegaHint1" ${s.hintsUsed?.includes(1)?'disabled':''}>${s.hintsUsed?.includes(1)?'✓ HINT 1 ON TV':'💡 SHOW HINT 1 ON TV'}</button>
          <button class="secondary" id="omegaHint2" ${s.hintsUsed?.includes(2)?'disabled':''}>${s.hintsUsed?.includes(2)?'✓ HINT 2 ON TV':'💡 SHOW HINT 2 ON TV'}</button>
          ${s.stage==='intro'
            ? `<button class="primary" data-omega-stage="question">SHOW OMEGA QUESTION</button>`
            : s.stage==='question'
              ? `<button class="secondary" data-omega-stage="locked">LOCK ANSWERS</button>`
              : s.stage==='locked'
                ? `<button class="green-btn" data-omega-stage="reveal">SHOW ANSWER ON TV</button>`
                : `<button class="green-btn" disabled>✓ ANSWER IS ON TV</button>`}
        </div>

        <div class="sub-controls">
          <button class="secondary" id="exitSpecial">← RETURN TO SHOWDOWN</button>
        </div>
      </section>

      <aside class="score-control">
        <div class="score-title">TEAM SCORE</div>
        <div class="team-score-card"><span class="tname">NEXT GEN</span><span class="tscore">${state.teams.nextgen.score}</span></div>
        <div class="team-score-card old"><span class="tname">OLD SCHOOL</span><span class="tscore">${state.teams.oldschool.score}</span></div>

        ${s.stage==='reveal'
          ? `<button class="teal-btn" data-omega-award="nextgen">NEXT GEN +1</button>
             <button class="primary" data-omega-award="oldschool">OLD SCHOOL +1</button>`
          : s.stage==='winner'
            ? `<div class="resolution done">${state.teams[s.winner]?.name||''} +1</div>`
            : `<div class="gate">Both teams answer privately. Lock answers before revealing.</div>`}
      </aside>
    </div>`;
  }

  async function visualAwardIndividual(playerId){
    const s=state.special;
    if(state.mode==='showdown' || !s || s.resolved) return;
    snapshotForUndo();

    const p=state.players.find(x=>x.id===playerId);
    if(!p) return;

    p.score += 1;
    s.resolved=true;
    s.revealed=true;
    s.resolution=`${p.name.toUpperCase()} +1 POINT`;

    await revealThenResult(`${p.name.toUpperCase()} +1`,'POINT AWARDED','score');
  }

  async function visualPassIndividual(){
    const s=state.special;
    if(state.mode==='showdown' || !s || s.resolved) return;
    snapshotForUndo();

    s.resolved=true;
    s.revealed=true;
    s.resolution='NO POINTS';

    await revealThenResult('NO POINTS','NO POINTS AWARDED','neutral');
  }

  async function visualAwardTeam(team){
    const s=state.special;
    if(state.mode!=='showdown' || !s || s.type!=='visual' || s.resolved) return;
    snapshotForUndo();

    state.teams[team].score += 1;
    s.resolved=true;
    s.revealed=true;
    s.resolution=`${state.teams[team].name} +1 POINT`;

    await revealThenResult(`${state.teams[team].name} +1`,'POINT AWARDED','score');
  }

  async function visualWrongTeam(){
    const s=state.special;
    if(state.mode!=='showdown' || !s || s.type!=='visual' || s.resolved || s.revealed) return;
    addResultOverlay('✕','WRONG — OTHER TEAM CAN ANSWER','wrong');
    await sync();
  }

  async function visualPassTeam(){
    const s=state.special;
    if(state.mode!=='showdown' || !s || s.type!=='visual' || s.resolved) return;
    snapshotForUndo();

    s.resolved=true;
    s.revealed=true;
    s.resolution='NO POINTS';

    await revealThenResult('NO POINTS','NO POINTS AWARDED','neutral');
  }

  async function nextVisualSpecialQuestion(){
    const s=state.special;
    if(!s || s.type!=='visual' || !s.resolved || !s.revealed) return;

    snapshotForUndo();

    if(s.index >= s.questions.length-1){
      s.stage='complete';
      await sync();
      return;
    }

    s.index += 1;
    s.question = s.questions[s.index];
    s.title = s.question.title || s.title;
    s.icon = s.question.icon || s.icon;
    s.hintsUsed = [];
    s.revealed = false;
    s.resolved = false;
    s.resolution = '';
    state.resultOverlay = null;
    await sync();
  }

  async function visualWrongIndividual(){
    const s=state.special;
    if(state.mode==='showdown' || !s || s.resolved || s.revealed) return;
    addResultOverlay('✕','WRONG — SOMEONE ELSE CAN ANSWER','wrong');
    await sync();
  }

  function visualHostHtml(s){
    const q=s.question;
    if(!q) return `<div class="setup-wrap"><div class="modal"><h2>No special question loaded.</h2></div></div>`;

    if(s.stage==='complete'){
      return `<div class="setup-wrap"><section class="instructions-host">
        <h1>${esc(s.title)} COMPLETE</h1>
        <div style="text-align:center;color:var(--teal);font-size:28px;font-weight:1000">5 QUESTIONS COMPLETE</div>
        <div class="center-actions">
          <button class="secondary" id="restartSpecialRound">PLAY THIS SPECIAL AGAIN</button>
          <button class="primary" id="exitSpecial">RETURN TO MAIN GAME</button>
        </div>
      </section></div>`;
    }

    const wrongActive=state.resultOverlay?.kind==='wrong';
    const individualScoring = state.mode!=='showdown';
    const readyForNext = s.resolved && s.revealed;
    const specialNum=(s.index||0)+1;
    const specialTotal=s.questions?.length||1;

    return `<div class="game-grid">
      <section class="question-panel">
        <div class="qtop">
          <div class="qcount">SPECIAL <b>${specialNum}</b> OF ${specialTotal}</div>
          <div class="qcat">${esc(s.title||q.category||'SPECIAL ROUND')}</div>
          <div class="qpts">1 POINT</div>
        </div>

        <div class="qcard">
          <div class="special-visual-inline">${esc(q.visual||s.icon||'?')}</div>
          <div class="qtext">${esc(q.question)}</div>

          <div class="host-private">
            <div class="host-answer">
              <div class="private-label">ANSWER · HOST ONLY</div>
              <div class="private-answer">${esc(q.answer)}</div>
            </div>

            <div class="host-hints">
              <div class="host-hint ${s.hintsUsed?.includes(1)?'sent':''}">
                <div class="private-label">HINT 1 · ${s.hintsUsed?.includes(1)?'ON TV':'HOST ONLY'}</div>
                <div>${esc(q.hint1)}</div>
              </div>
              <div class="host-hint ${s.hintsUsed?.includes(2)?'sent':''}">
                <div class="private-label">HINT 2 · ${s.hintsUsed?.includes(2)?'ON TV':'HOST ONLY'}</div>
                <div>${esc(q.hint2)}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="primary-controls">
          <button class="secondary" id="visualHint1" ${s.hintsUsed?.includes(1)?'disabled':''}>${s.hintsUsed?.includes(1)?'✓ HINT 1 ON TV':'💡 SHOW HINT 1 ON TV'}</button>
          <button class="secondary" id="visualHint2" ${s.hintsUsed?.includes(2)?'disabled':''}>${s.hintsUsed?.includes(2)?'✓ HINT 2 ON TV':'💡 SHOW HINT 2 ON TV'}</button>
          <button class="green-btn" disabled>${s.revealed?'✓ ANSWER IS ON TV':'ANSWER REVEALS WITH SCORE / PASS'}</button>
        </div>

        <div class="sub-controls">
          <button class="secondary" id="undoBtn" ${history.length?'':'disabled'}>↶ UNDO</button>
          <button class="secondary" id="showScore">${state.tvOverride==='scoreboard'?'← RETURN TO QUESTION':'▤ SHOW SCORE'}</button>
          <button class="secondary" id="pauseTv">${state.tvOverride==='pause'?'▶ RESUME TV':'Ⅱ PAUSE TV'}</button>
          <button class="secondary" id="exitSpecial">← RETURN TO MAIN GAME</button>
          <button class="secondary" disabled>${esc(s.title)}</button>
        </div>
      </section>

      ${individualScoring ? `
        <aside class="score-control">
          <div class="score-title">ANSWER RESULT</div>
          <div class="small-muted" style="text-align:center">
            ${s.resolved
              ? 'Special question complete.'
              : 'Keep taking guesses until somebody gets it.'}
          </div>

          <button class="wrong-btn ${wrongActive?'active':''}" id="visualWrong" ${(!s.resolved&&!s.revealed&&!wrongActive)?'':'disabled'}>
            ${wrongActive?'✕ WRONG SENT TO TV':'✕ WRONG'}
          </button>

          <div class="small-muted" style="text-align:center">AWARD 1 POINT</div>

          <div class="player-score-list">
            ${sortedPlayers().map(p=>`<button class="pscore ${!s.resolved?'enabled':''}" data-special-player="${p.id}" ${s.resolved?'disabled':''}>
              <span>${esc(p.name)}</span><strong>${p.score}</strong>
            </button>`).join('')}
          </div>

          <button class="secondary" id="visualPass" ${s.resolved?'disabled':''}>PASS · NOBODY KNOWS</button>

          <div class="resolution ${s.resolved?'done':''}">${esc(s.resolution||'WAITING FOR AN ANSWER')}</div>

          <button class="primary next-button" id="nextVisualSpecial" ${readyForNext?'':'disabled'}>
            ${specialNum>=specialTotal?'FINISH SPECIAL ROUND →':'NEXT SPECIAL QUESTION →'}
          </button>

          <div class="gate">
            ${readyForNext
              ? (specialNum>=specialTotal?'Finish this special round.':'Continue to the next special question.')
              : 'Wrong guesses do not end the question.'}
          </div>
        </aside>
      ` : `
        <aside class="score-control">
          <div class="score-title">TEAM SCORE</div>
          <div class="team-score-card"><span class="tname">NEXT GEN</span><span class="tscore">${state.teams.nextgen.score}</span></div>
          <div class="team-score-card old"><span class="tname">OLD SCHOOL</span><span class="tscore">${state.teams.oldschool.score}</span></div>

          ${wrongActive?`<div class="host-wrong-confirm">✕ WRONG SENT TO TV</div>`:''}

          <button class="wrong-btn ${wrongActive?'active':''}" id="visualWrongTeam" ${(!s.resolved&&!s.revealed&&!wrongActive)?'':'disabled'}>
            ${wrongActive?'✕ WRONG SENT TO TV':'✕ WRONG · OTHER TEAM CAN ANSWER'}
          </button>

          <button class="teal-btn" data-visual-team="nextgen" ${s.resolved?'disabled':''}>NEXT GEN +1</button>
          <button class="primary" data-visual-team="oldschool" ${s.resolved?'disabled':''}>OLD SCHOOL +1</button>
          <button class="secondary" id="visualPassTeam" ${s.resolved?'disabled':''}>PASS · NO POINTS</button>

          <div class="resolution ${s.resolved?'done':''}">${esc(s.resolution||'WAITING FOR AN ANSWER')}</div>

          <button class="primary next-button" id="nextVisualSpecial" ${readyForNext?'':'disabled'}>${specialNum>=specialTotal?'FINISH SPECIAL ROUND →':'NEXT SPECIAL QUESTION →'}</button>
        </aside>
      `}
    </div>`;
  }

  function finalHostHtml(){
    const winner=state.mode==='showdown'
      ? (state.teams.nextgen.score===state.teams.oldschool.score?'TIE GAME':(state.teams.nextgen.score>state.teams.oldschool.score?'NEXT GEN':'OLD SCHOOL'))
      : (sortedPlayers()[0]?.name || 'WINNER');
    return `<div class="setup-wrap"><section class="instructions-host"><h1>GAME COMPLETE</h1>
      <div style="text-align:center;font-size:48px;color:var(--orange);font-weight:1000">${esc(winner)}</div>
      <div class="center-actions">${state.mode==='showdown'?`<button class="secondary" id="omegaFromFinal">Ω OMEGA</button>`:''}<button class="primary" id="newGame">NEW GAME</button><button class="secondary" id="previewFinal">TV PREVIEW</button></div>
    </section></div>`;
  }

  function bindHost(){
    document.getElementById('homeBtn')?.addEventListener('click',()=>{state=initialState();history=[];renderHost();});
    document.getElementById('tvPreviewBtn')?.addEventListener('click',openTVPreview);

    document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
    document.getElementById('resumeBtn')?.addEventListener('click',async()=>{
      const code=document.getElementById('resumeCode').value.trim().toUpperCase();
      if(code.length!==4)return;
      const loaded=await cloud.load(code);
      if(loaded){state=loaded;watchHostConnection();renderHost();}
      else alert('Game code not found.');
    });

    document.getElementById('addPlayer')?.addEventListener('click',addPlayerFromInput);
    document.getElementById('playerInput')?.addEventListener('keydown',e=>{if(e.key==='Enter')addPlayerFromInput();});
    document.querySelectorAll('[data-remove-player]').forEach(b=>b.addEventListener('click',async()=>{state.players=state.players.filter(p=>p.id!==b.dataset.removePlayer);await sync();}));
    document.querySelectorAll('[data-add-team]').forEach(b=>b.addEventListener('click',()=>addTeamMember(b.dataset.addTeam)));
    document.querySelectorAll('[data-remove-team]').forEach(b=>b.addEventListener('click',async()=>{state.teams[b.dataset.removeTeam].members.splice(Number(b.dataset.index),1);await sync();}));
    document.getElementById('continueSetup')?.addEventListener('click',async()=>{snapshotForUndo();state.phase='connect';await sync();watchHostConnection();});
    document.getElementById('copyUrl')?.addEventListener('click',()=>navigator.clipboard?.writeText(displayUrl()));
    document.getElementById('openPreviewConnect')?.addEventListener('click',openTVPreview);
    document.getElementById('showInstructions')?.addEventListener('click',startInstructions);
    document.getElementById('previewInstructions')?.addEventListener('click',openTVPreview);
    document.getElementById('startGame')?.addEventListener('click',startGame);

    document.getElementById('hint1')?.addEventListener('click',()=>useHint(1));
    document.getElementById('hint2')?.addEventListener('click',()=>useHint(2));
    document.getElementById('reveal')?.addEventListener('click',revealAnswer);
    document.getElementById('changeQ')?.addEventListener('click',changeQuestion);
    document.getElementById('undoBtn')?.addEventListener('click',undo);
    document.getElementById('showScore')?.addEventListener('click',()=>toggleTvOverride('scoreboard'));
    document.getElementById('pauseTv')?.addEventListener('click',()=>toggleTvOverride('pause'));
    document.getElementById('specialsBtn')?.addEventListener('click',showSpecialMenu);
    document.getElementById('wrongGuess')?.addEventListener('click',wrongGuess);
    document.querySelectorAll('[data-award-player]').forEach(b=>b.addEventListener('click',()=>awardIndividual(b.dataset.awardPlayer)));
    document.querySelectorAll('[data-award-team]').forEach(b=>b.addEventListener('click',()=>awardTeam(b.dataset.awardTeam)));
    document.getElementById('offerSteal')?.addEventListener('click',offerSteal);
    document.getElementById('stealMiss')?.addEventListener('click',stealMissed);
    document.getElementById('passQ')?.addEventListener('click',passQuestion);
    document.getElementById('nextQ')?.addEventListener('click',nextQuestion);

    document.querySelectorAll('[data-bonus-value]').forEach(b=>b.addEventListener('click',()=>bonusSetValue(Number(b.dataset.bonusValue))));
    document.getElementById('bonusHint1')?.addEventListener('click',()=>bonusHint(1));
    document.getElementById('bonusHint2')?.addEventListener('click',()=>bonusHint(2));
    document.getElementById('bonusWrong')?.addEventListener('click',bonusWrong);
    document.querySelectorAll('[data-bonus-team]').forEach(b=>b.addEventListener('click',()=>bonusAward(b.dataset.bonusTeam)));
    document.getElementById('bonusPass')?.addEventListener('click',bonusPass);
    document.getElementById('bonusNext')?.addEventListener('click',bonusNext);
    document.getElementById('rapidStart')?.addEventListener('click',rapidStart);
    document.getElementById('rapidCorrect')?.addEventListener('click',rapidCorrect);
    document.getElementById('rapidPass')?.addEventListener('click',rapidPass);
    document.getElementById('rapidSwitch')?.addEventListener('click',rapidSwitchTeam);
    document.getElementById('omegaHint1')?.addEventListener('click',()=>omegaHint(1));
    document.getElementById('omegaHint2')?.addEventListener('click',()=>omegaHint(2));
    document.querySelectorAll('[data-omega-stage]').forEach(b=>b.addEventListener('click',()=>omegaStage(b.dataset.omegaStage)));
    document.querySelectorAll('[data-omega-award]').forEach(b=>b.addEventListener('click',()=>omegaAward(b.dataset.omegaAward)));
    document.getElementById('visualHint1')?.addEventListener('click',async()=>{snapshotForUndo();state.special.hintsUsed=[...(state.special.hintsUsed||[]),1].filter((x,i,a)=>a.indexOf(x)===i);await sync();});
    document.getElementById('visualHint2')?.addEventListener('click',async()=>{snapshotForUndo();state.special.hintsUsed=[...(state.special.hintsUsed||[]),2].filter((x,i,a)=>a.indexOf(x)===i);await sync();});
    document.getElementById('visualWrong')?.addEventListener('click',visualWrongIndividual);
    document.querySelectorAll('[data-special-player]').forEach(b=>b.addEventListener('click',()=>visualAwardIndividual(b.dataset.specialPlayer)));
    document.getElementById('visualPass')?.addEventListener('click',visualPassIndividual);

    document.getElementById('visualWrongTeam')?.addEventListener('click',visualWrongTeam);
    document.querySelectorAll('[data-visual-team]').forEach(b=>b.addEventListener('click',()=>visualAwardTeam(b.dataset.visualTeam)));
    document.getElementById('visualPassTeam')?.addEventListener('click',visualPassTeam);
    document.getElementById('nextVisualSpecial')?.addEventListener('click',nextVisualSpecialQuestion);
    document.getElementById('restartSpecialRound')?.addEventListener('click',()=>startSpecial(state.special.kind));
    document.getElementById('undoBtn')?.addEventListener('click',undo);
    document.getElementById('showScore')?.addEventListener('click',toggleScoreboard);
    document.getElementById('pauseTv')?.addEventListener('click',togglePause);
    document.getElementById('exitSpecial')?.addEventListener('click',exitSpecial);

    document.getElementById('newGame')?.addEventListener('click',()=>{state=initialState();history=[];renderHost();});
    document.getElementById('previewFinal')?.addEventListener('click',openTVPreview);
    document.getElementById('omegaFromFinal')?.addEventListener('click',()=>startSpecial('omega'));
  }

  async function addPlayerFromInput(){
    const input=document.getElementById('playerInput');
    const name=input?.value.trim();
    if(!name||state.players.length>=10)return;
    state.players.push({id:uid(),name,score:0});
    await sync();
  }
  async function addTeamMember(team){
    const input=document.getElementById(team+'Input');
    const name=input?.value.trim();if(!name)return;
    state.teams[team].members.push(name);await sync();
  }

  function watchHostConnection(){
    if(!cloud.enabled || !state.code) return;
    if(connectWatcher) connectWatcher();
    connectWatcher = cloud.subscribeConnection(state.code,(seen)=>{
      if(seen && seen!==state.displayLastSeenMs){
        state.displayLastSeenMs=seen;
        renderHost();
      }
    });
  }

  /* ---------------- TV PREVIEW ---------------- */
  function openTVPreview(){
    tvPreviewOpen=true;
    const o=document.createElement('div');o.id='tvPreviewOverlay';o.className='overlay';
    o.innerHTML=`<div class="tv-preview-shell"><div class="tv-preview-bar"><span>BUILT-IN TV PREVIEW · ${state.code||'NO SESSION'}</span><div><button class="secondary" id="clearTvOverride" ${state.tvOverride?'':'disabled'}>RETURN TO GAME</button> <button class="secondary" id="closeTvPreview">CLOSE</button></div></div><div class="tv-preview-body" id="tvPreviewBody"></div></div>`;
    document.body.appendChild(o);
    document.getElementById('closeTvPreview').onclick=()=>{tvPreviewOpen=false;o.remove();};
    document.getElementById('clearTvOverride').onclick=clearOverride;
    renderTVPreview();
  }
  function renderTVPreview(){
    const box=document.getElementById('tvPreviewBody');if(!box)return;
    box.innerHTML=tvHtml(state,true);
    const returnBtn=document.getElementById('clearTvOverride');
    if(returnBtn) returnBtn.disabled=!state.tvOverride;
  }

  /* ---------------- TV ROUTE ---------------- */
  let tvState=null;
  function renderTVRoute(){
    if(!cloud.enabled){
      app.innerHTML=`<div class="tv-error"><div class="tv-error-card"><img src="assets/compact_logo.png" class="logo" style="margin:0 auto"><h1>TV DISPLAY</h1><p>Firebase is not configured in this build yet.</p><p>Use the Host's <b>TV PREVIEW</b> button for immediate testing, or fill <code>firebase-config.js</code> to enable separate-device TV syncing.</p></div></div>`;
      return;
    }
    if(!REQUESTED_CODE){
      app.innerHTML=`<div class="tv-error"><div class="tv-error-card"><h1>ENTER A GAME CODE</h1><p>Open the TV link generated by the Host.</p></div></div>`;
      return;
    }
    cloud.subscribeGame(REQUESTED_CODE,(gameState)=>{
      tvState=gameState;
      app.innerHTML=tvHtml(tvState,false);
    });
    const beat=()=>cloud.displayHeartbeat(REQUESTED_CODE).catch(console.error);
    beat(); setInterval(beat,10000);
    app.innerHTML=`<div class="tv-takeover"><div class="takeover-card"><img src="assets/compact_logo.png" class="logo" style="margin:0 auto"><div class="takeover-title">JOINING GAME…</div><div class="takeover-note">${REQUESTED_CODE}</div></div></div>`;
  }

  function tvReactionOverlay(s){
    if(!s?.resultOverlay) return '';
    return `<div class="result-overlay">
      <div class="result-card ${esc(s.resultOverlay.kind||'correct')}">
        <div class="big">${esc(s.resultOverlay.big)}</div>
        <div class="sub">${esc(s.resultOverlay.sub)}</div>
      </div>
    </div>`;
  }

  function tvHtml(s,embedded){
    if(!s || !s.phase) return '';

    let content='';
    if(s.tvOverride==='pause') content=pauseTVHtml();
    else if(s.tvOverride==='scoreboard') content=fullScoreTVHtml(s);
    else if(s.phase==='connect') content=connectedTVHtml(s);
    else if(s.phase==='instructions') content=instructionsTVHtml(s);
    else if(s.phase==='question') content=questionTVHtml(s);
    else if(s.phase==='special') content=specialTVHtml(s);
    else if(s.phase==='final') content=finalTVHtml(s);
    else content=connectedTVHtml(s);

    return `<div class="tv-root">${content}${tvReactionOverlay(s)}</div>`;
  }

  
  function headerTV(){
    return `<header class="tv-header tv-game-header">
      <div class="tv-home-nav left static"><span class="icon">⌂</span><span>HOME</span></div>
      <div class="tv-header-center">
        <div class="stripes"><span class="s1"></span><span class="s2"></span><span class="s3"></span></div>
        <div class="logo-wrap"><img src="assets/compact_logo.png" class="logo" alt=""></div>
      </div>
      <div class="tv-header-spacer"></div>
    </header>`;
  }
  function progressHtml(s){
    const total=s.questionOrder.length||MODES[s.mode]?.total||10;
    return `<footer class="tv-progress"><div class="progress-label">PROGRESS</div><div class="progress-dots">${Array.from({length:total},(_,i)=>`<span class="pdot ${i<s.questionIndex?'done':i===s.questionIndex?'current':''}">${i+1}</span>`).join('')}</div></footer>`;
  }
  
  function connectedTVHtml(s){
    return `<div class="tv-home-screen">
      <div class="tv-home-top">
        <div class="tv-home-nav left"><span class="icon">⌂</span><span>HOME</span></div>
        <div class="tv-home-center">
          <div class="tv-home-title">I KNOW THAT! – DISPLAY</div>
          <div class="tv-home-code-line">Game Code: <span>${esc(s.code)}</span></div>
        </div>
        <div class="tv-home-status">✓ CONNECTED</div>
        <div class="tv-home-nav right"><span class="icon">?</span><span>How to Play</span></div>
      </div>

      <div class="tv-home-hero">
        <div class="stripes"><span class="s1"></span><span class="s2"></span><span class="s3"></span></div>
        <img src="assets/compact_logo.png" class="logo" alt="I KNOW THAT!">
      </div>

      <section class="tv-home-steps">
        <div class="tv-step">
          <div class="step-num teal">1</div>
          <div class="step-copy">
            <div class="step-title">OPEN THIS PAGE</div>
            <div class="step-sub">On the TV or big screen everyone can see.</div>
            <div class="step-visual screen"></div>
          </div>
        </div>
        <div class="tv-step">
          <div class="step-num orange">2</div>
          <div class="step-copy">
            <div class="step-title">HOST STARTS A GAME</div>
            <div class="step-sub">On their device and shares the Game Code.</div>
            <div class="step-visual phone"><span>GAME CODE</span><b>${esc(s.code)}</b></div>
          </div>
        </div>
        <div class="tv-step">
          <div class="step-num cream">3</div>
          <div class="step-copy">
            <div class="step-title">YOU’RE IN!</div>
            <div class="step-sub">Answers, scores and fun will show up here.</div>
            <div class="step-visual people">🙌 🙋 🙌</div>
          </div>
        </div>
      </section>

      <div class="tv-home-footer">★ KEEP THIS SCREEN ON THE TV – THE HOST WILL CONTROL THE GAME.</div>
    </div>`;
  }
  function instructionsTVHtml(s){
    const rules = s.mode==='showdown' ? [
      ['NEXT GEN VS OLD SCHOOL.','Work with your team before giving the final answer.'],
      ['THE POINTS GO UP.','Questions are worth 1, then 2, then 3, then 4 points.'],
      ['A MISS CAN BECOME A STEAL.','The other team may get one shot at the points.'],
      ['EXPECT A FEW SURPRISES.','Bonus Vault, Rapid Fire, and maybe Ω Omega.']
    ] : rulesForMode();
    return `<div class="instructions-tv">${headerTV()}<section class="instructions-body"><h1>${esc(MODES[s.mode].label)} · HOW TO PLAY</h1><div class="rule-grid">${rules.map((r,i)=>`<div class="rule"><div class="rule-num">${i+1}</div><div><b>${r[0]}</b><span>${r[1]}</span></div></div>`).join('')}</div><div class="readyline">${s.mode==='showdown'?'GENERATIONS COLLIDE. BRAGGING BEGINS.':'READY? EVERY PLAYER FOR THEMSELVES.'}</div></section></div>`;
  }

  
  function tvScorePanel(s){
    if(s.mode==='showdown'){
      return `<aside class="tv-score-panel showdown">
        <div class="tv-score-title">CURRENT SCORE</div>
        <div class="tv-team-card">
          <div class="tv-team-rank teal">1</div>
          <div class="tv-team-copy"><div class="name">${s.teams.nextgen.name}</div><div class="score">${s.teams.nextgen.score}</div></div>
        </div>
        <div class="tv-team-card old">
          <div class="tv-team-rank orange">2</div>
          <div class="tv-team-copy"><div class="name">${s.teams.oldschool.name}</div><div class="score">${s.teams.oldschool.score}</div></div>
        </div>
      </aside>`;
    }
    const ranked=[...s.players].sort((a,b)=>b.score-a.score || a.name.localeCompare(b.name));
    return `<aside class="tv-score-panel">
      <div class="tv-score-title">CURRENT SCORE</div>
      ${ranked.map((p,i)=>{
        const tone = i%3===0 ? 'teal' : i%3===1 ? 'orange' : 'cream';
        return `<div class="tv-player-row">
          <span class="tv-rank-badge ${tone}">${i+1}</span>
          <span class="tv-player-name">${esc(p.name)}</span>
          <strong>${p.score}</strong>
        </div>`;
      }).join('')}
    </aside>`;
  }

  function questionTVHtml(s){
    const q=s.currentQuestion;
    const pts=s.mode==='showdown'?(q?.points||currentPoints()):1;
    const turn=s.mode==='showdown'?`<div class="turn-banner">${s.stealTeam ? `STEAL CHANCE — ${s.teams[s.stealTeam].name} CAN ANSWER` : `${s.teams[s.activeTeam].name} ANSWERS FIRST`}</div>`:'';
    return `<div class="tv-pad">${headerTV()}<main class="tv-main-grid"><section class="tv-card"><div class="tv-qtop"><div class="tv-qcount">QUESTION ${s.questionIndex+1} OF ${s.questionOrder.length}</div><div class="tv-qcat">${esc(q?.category||'')}</div><div class="tv-points">${pts} POINT${pts===1?'':'S'}</div></div><div class="tv-qbody">${turn}<div class="tv-question">${esc(q?.question||'')}</div>
      ${s.hintsUsed.includes(1)?`<div class="tv-hint"><div class="label">HINT 1</div><div class="copy">${esc(q.hint1)}</div></div>`:''}
      ${s.hintsUsed.includes(2)?`<div class="tv-hint"><div class="label">HINT 2</div><div class="copy">${esc(q.hint2||'')}</div></div>`:''}
      ${s.revealed?`<div class="tv-answer"><div class="label">THE ANSWER IS</div><div class="copy">${esc(q.answer)}</div></div>`:''}
    </div></section>${tvScorePanel(s)}</main>${progressHtml(s)}</div>`;
  }

  function fullScoreTVHtml(s){
    if(s.mode==='showdown'){
      return `<div class="tv-takeover"><div class="stripes"><span class="s1"></span><span class="s2"></span><span class="s3"></span></div><div class="takeover-card"><div class="takeover-title">CURRENT SCORE</div><div class="final-scores"><div class="final-team"><b>NEXT GEN</b><strong>${s.teams.nextgen.score}</strong></div><div class="final-team old"><b>OLD SCHOOL</b><strong>${s.teams.oldschool.score}</strong></div></div></div></div>`;
    }
    const p=[...s.players].sort((a,b)=>b.score-a.score);
    return `<div class="scoreboard-full">${headerTV()}<div><div class="scoreboard-title">CURRENT STANDINGS</div><div class="standings">${p.map((x,i)=>`<div class="standing-row"><span class="standing-rank">${i+1}</span><span>${esc(x.name)}</span><span class="standing-score">${x.score}</span></div>`).join('')}</div></div></div>`;
  }

  function pauseTVHtml(){
    return `<div class="tv-takeover"><div class="stripes"><span class="s1"></span><span class="s2"></span><span class="s3"></span></div><div class="takeover-card"><img src="assets/compact_logo.png" class="logo"><div class="takeover-title">GAME PAUSED</div><div class="takeover-sub">DON'T GO ANYWHERE.</div></div></div>`;
  }

  function rapidTVScorePanel(s,sp){
    return `<aside class="tv-score-panel rapid-tv-score">
      <div class="tv-score-title">TIME & SCORE</div>
      <div class="rapid-tv-timer">${rapidRemaining(sp)}</div>

      <div class="tv-team-card compact ${sp.team==='nextgen'?'active-team':''}">
        <div class="name">NEXT GEN</div>
        <div class="score">${s.teams.nextgen.score}</div>
      </div>

      <div class="tv-team-card old compact ${sp.team==='oldschool'?'active-team':''}">
        <div class="name">OLD SCHOOL</div>
        <div class="score">${s.teams.oldschool.score}</div>
      </div>
    </aside>`;
  }

  function specialTVHtml(s){
    const sp=s.special;if(!sp)return questionTVHtml(s);
    if(sp.type==='bonus'){
      const q=sp.question;
      return `<div class="tv-pad">
        ${headerTV()}
        <main class="tv-main-grid">
          <section class="tv-card">
            <div class="tv-qtop">
              <div class="tv-qcount">SPECIAL</div>
              <div class="tv-qcat">★+ BONUS VAULT</div>
              <div class="tv-points">+${sp.value} POINT${sp.value===1?'':'S'}</div>
            </div>
            <div class="tv-qbody">
              <div class="tv-question">${esc(q.question)}</div>
              ${sp.hintsUsed?.includes(1)?`<div class="tv-hint"><div class="label">HINT 1</div><div class="copy">${esc(q.hint1)}</div></div>`:''}
              ${sp.hintsUsed?.includes(2)?`<div class="tv-hint"><div class="label">HINT 2</div><div class="copy">${esc(q.hint2)}</div></div>`:''}
              ${sp.revealed?`<div class="tv-answer"><div class="label">THE ANSWER IS</div><div class="copy">${esc(q.answer)}</div></div>`:''}
            </div>
          </section>
          ${tvScorePanel(s)}
        </main>
        <footer class="tv-progress">
          <div class="progress-label">BONUS VAULT</div>
          <div class="bonus-footer-note">MAIN SHOWDOWN QUESTION COUNT DOES NOT ADVANCE</div>
        </footer>
      </div>`;
    }

    if(sp.type==='rapid'){
      if(sp.stage==='intro'){
        return `<div class="tv-pad">
          ${headerTV()}
          <main class="tv-main-grid">
            <section class="tv-card">
              <div class="tv-qtop">
                <div class="tv-qcount">SPECIAL</div>
                <div class="tv-qcat">⚡ RAPID FIRE</div>
                <div class="tv-points">1 POINT EACH</div>
              </div>
              <div class="tv-qbody">
                <div class="rapid-tv-intro">60 SECONDS</div>
                <div class="tv-question">${s.teams[sp.team].name} · GET READY!</div>
              </div>
            </section>
            ${rapidTVScorePanel(s,sp)}
          </main>
          <footer class="tv-progress">
            <div class="progress-label">RAPID FIRE</div>
            <div class="bonus-footer-note">NAME THE BRAND · KEEP GOING!</div>
          </footer>
        </div>`;
      }

      if(sp.stage==='finish'){
        return `<div class="tv-pad">
          ${headerTV()}
          <main class="tv-main-grid">
            <section class="tv-card">
              <div class="tv-qtop">
                <div class="tv-qcount">ROUND COMPLETE</div>
                <div class="tv-qcat">⚡ RAPID FIRE</div>
                <div class="tv-points">${sp.correct} POINT${sp.correct===1?'':'S'}</div>
              </div>
              <div class="tv-qbody">
                <div class="rapid-tv-intro">${s.teams[sp.team].name}</div>
                <div class="tv-question">${sp.correct} POINT${sp.correct===1?'':'S'} EARNED</div>
              </div>
            </section>
            ${rapidTVScorePanel(s,sp)}
          </main>
          <footer class="tv-progress">
            <div class="progress-label">RAPID FIRE</div>
            <div class="bonus-footer-note">ROUND COMPLETE</div>
          </footer>
        </div>`;
      }

      const item=sp.items[Math.min(sp.index,sp.items.length-1)];
      return `<div class="tv-pad">
        ${headerTV()}
        <main class="tv-main-grid">
          <section class="tv-card">
            <div class="tv-qtop">
              <div class="tv-qcount">LOGO ${Math.min(sp.index+1,sp.items.length)} OF ${sp.items.length}</div>
              <div class="tv-qcat">⚡ RAPID FIRE · ${s.teams[sp.team].name}</div>
              <div class="tv-points">1 POINT EACH</div>
            </div>
            <div class="tv-qbody">
              <div class="rapid-logo-card">${esc(item?.visual||'?')}</div>
            </div>
          </section>
          ${rapidTVScorePanel(s,sp)}
        </main>
        <footer class="tv-progress">
          <div class="progress-label">RAPID FIRE</div>
          <div class="bonus-footer-note">${sp.correct} POINT${sp.correct===1?'':'S'} · ${sp.passed.length} PASSED · ${Math.max(0,sp.items.length-sp.index)} LEFT</div>
        </footer>
      </div>`;
    }

    if(sp.type==='omega'){
      const q=sp.question;
      return `<div class="tv-pad">
        ${headerTV()}
        <main class="tv-main-grid">
          <section class="tv-card">
            <div class="tv-qtop">
              <div class="tv-qcount">FINAL SPECIAL</div>
              <div class="tv-qcat">Ω OMEGA</div>
              <div class="tv-points">FINAL CHALLENGE</div>
            </div>
            <div class="tv-qbody">
              ${sp.stage==='intro'
                ? `<div class="tv-question">BOTH TEAMS ANSWER PRIVATELY.<br>NO SPEED ADVANTAGE.</div>`
                : `<div class="tv-question">${esc(q.question)}</div>`}

              ${sp.hintsUsed?.includes(1)?`<div class="tv-hint"><div class="label">HINT 1</div><div class="copy">${esc(q.hint1)}</div></div>`:''}
              ${sp.hintsUsed?.includes(2)?`<div class="tv-hint"><div class="label">HINT 2</div><div class="copy">${esc(q.hint2)}</div></div>`:''}
              ${sp.stage==='locked'?`<div class="turn-banner">ANSWERS LOCKED</div>`:''}
              ${sp.revealed||sp.stage==='winner'?`<div class="tv-answer"><div class="label">THE ANSWER IS</div><div class="copy">${esc(q.answer)}</div></div>`:''}
              ${sp.stage==='winner'?`<div class="turn-banner">${esc(s.teams[sp.winner].name)} +1</div>`:''}
            </div>
          </section>
          ${tvScorePanel(s)}
        </main>
        <footer class="tv-progress">
          <div class="progress-label">Ω OMEGA</div>
          <div class="bonus-footer-note">BOTH TEAMS · PRIVATE ANSWERS</div>
        </footer>
      </div>`;
    }

    const q=sp.question;
    if(sp.stage==='complete'){
      return `<div class="tv-takeover">
        <div class="stripes"><span class="s1"></span><span class="s2"></span><span class="s3"></span></div>
        <div class="takeover-card">
          <img src="assets/compact_logo.png" class="logo">
          <div class="takeover-sub">${esc(sp.title)}</div>
          <div class="takeover-title">ROUND COMPLETE</div>
          <div class="takeover-note">BACK TO THE MAIN GAME WHEN THE HOST IS READY.</div>
        </div>
      </div>`;
    }

    const specialNum=(sp.index||0)+1;
    const specialTotal=sp.questions?.length||1;

    return `<div class="tv-pad">
      ${headerTV()}

      <main class="tv-main-grid">
        <section class="tv-card">
          <div class="tv-qtop">
            <div class="tv-qcount">SPECIAL ${specialNum} OF ${specialTotal}</div>
            <div class="tv-qcat">${esc(sp.title||q.category||'SPECIAL ROUND')}</div>
            <div class="tv-points">1 POINT</div>
          </div>

          <div class="tv-qbody">
            <div class="tv-special-visual">${esc(q.visual||sp.icon||'?')}</div>
            <div class="tv-question">${esc(q.question)}</div>

            ${sp.hintsUsed?.includes(1)?`<div class="tv-hint"><div class="label">HINT 1</div><div class="copy">${esc(q.hint1)}</div></div>`:''}
            ${sp.hintsUsed?.includes(2)?`<div class="tv-hint"><div class="label">HINT 2</div><div class="copy">${esc(q.hint2)}</div></div>`:''}
            ${sp.revealed?`<div class="tv-answer"><div class="label">THE ANSWER IS</div><div class="copy">${esc(q.answer)}</div></div>`:''}
          </div>
        </section>

        ${tvScorePanel(s)}
      </main>

      <footer class="tv-progress">
        <div class="progress-label">${esc(sp.title||'SPECIAL')}</div>
        <div class="progress-dots">
          ${Array.from({length:specialTotal},(_,i)=>`<span class="pdot ${i<sp.index?'done':i===sp.index?'current':''}">${i+1}</span>`).join('')}
        </div>
      </footer>
    </div>`;
  }

  function finalTVHtml(s){
    if(s.mode==='showdown'){
      const a=s.teams.nextgen.score,b=s.teams.oldschool.score;
      const winner=a===b?'TIE GAME':a>b?'NEXT GEN WINS!':'OLD SCHOOL WINS!';
      return `<div class="tv-takeover"><div class="stripes"><span class="s1"></span><span class="s2"></span><span class="s3"></span></div><div class="takeover-card"><img src="assets/compact_logo.png" class="logo"><div class="takeover-sub">FINAL SCORE</div><div class="final-scores"><div class="final-team"><b>NEXT GEN</b><strong>${a}</strong></div><div class="final-team old"><b>OLD SCHOOL</b><strong>${b}</strong></div></div><div class="takeover-title" style="margin-top:18px;font-size:55px">${winner}</div><div class="takeover-note">GREAT GAME, FAMILY!</div></div></div>`;
    }
    const p=[...s.players].sort((a,b)=>b.score-a.score);
    const w=p[0]||{name:'WINNER',score:0};
    return `<div class="tv-takeover"><div class="stripes"><span class="s1"></span><span class="s2"></span><span class="s3"></span></div><div class="takeover-card"><img src="assets/compact_logo.png" class="logo"><div class="takeover-sub">AND THE WINNER IS…</div><div class="takeover-title">${esc(w.name)}</div><div class="takeover-sub">${w.score} POINT${w.score===1?'':'S'}</div><div class="takeover-note">${p.slice(1,3).map((x,i)=>`${i+2}. ${esc(x.name)} · ${x.score}`).join(' &nbsp; | &nbsp; ')}</div></div></div>`;
  }

  /* boot */
  if(VIEW==='tv') renderTVRoute();
  else renderHost();

})();
