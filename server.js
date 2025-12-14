
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>One Line Pimp Simulator</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>

  <style>
    :root{
      --bg:#0a0a14; --panel1:#12122a; --panel2:#19194a; --ink:#eef0ff; --muted:#9aa3c7;
      --accent:#7c7cff; --ok:#3ee089; --bad:#ff6e86; --border:#2a2a5a; --chip:#1c1c3b; --pill:#23235a;
    }
    *{box-sizing:border-box}
    html,body{height:100%}
    body{
      margin:0;color:var(--ink);
      background:
        radial-gradient(900px 600px at 20% -10%,rgba(124,124,255,.12),transparent),
        radial-gradient(900px 600px at 120% 10%,rgba(142,225,255,.08),transparent),
        var(--bg);
      font:16px/1.6 system-ui, Segoe UI, Roboto, sans-serif;
      letter-spacing:.2px;
    }

    header{
      position:sticky;top:0;z-index:20;
      background:linear-gradient(180deg, rgba(18,18,40,.92), rgba(18,18,40,.75));
      backdrop-filter:blur(10px);
      border-bottom:1px solid var(--border);
    }
    .nav{max-width:1200px;margin:0 auto;padding:10px 14px;display:flex;align-items:center;gap:12px}
    .spacer{flex:1}
    .bubble{width:10px;height:10px;border-radius:50%;background:#6a6a9c;border:1px solid #4a4a86}
    .bubble.ok{background:var(--ok);box-shadow:0 0 0 2px rgba(62,224,137,.15)}
    .chip{padding:6px 10px;border-radius:12px;background:var(--chip);border:1px solid var(--border);display:flex;align-items:center;gap:8px;color:var(--muted)}
    .chip strong{color:var(--ink)}

    /* ---------- SHELL GRID ---------- */
    .shell{
      max-width:1200px;margin:18px auto;padding:0 14px;
      display:grid;grid-template-columns:300px 1fr;gap:16px;
      transition:grid-template-columns .2s ease;
    }
    .shell.no-sidebar{grid-template-columns:1fr;} /* when sidebar collapses */

    .sidebar{position:sticky;top:64px;align-self:start;transition:opacity .2s ease, transform .2s ease}
    .sidebar.hidden{display:none;} /* remove from layout so main can center */

    .card{
      background:linear-gradient(180deg,var(--panel1),var(--panel2));
      border:1px solid var(--border);border-radius:18px;padding:18px;
      box-shadow:0 12px 40px rgba(0,0,0,.35);
    }

    /* ---------- MAIN / STAGE ---------- */
    #stage{transition:max-width .2s ease, margin .2s ease, transform .2s ease;}
    #stage.wide{max-width:960px;margin:0 auto;}       /* center & widen during QA/Summary */
    #stage.compact{max-width:720px;margin:0 auto;}    /* setup screens */
    @media (max-width:960px){ #stage.wide,#stage.compact{max-width:100%} }

    /* controls */
    label{font-size:13px;color:var(--muted);display:block;margin-bottom:6px}
    input,select{
      width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--border);
      background:#0f0f27;color:var(--ink);outline:none
    }
    input:focus,select:focus{box-shadow:0 0 0 2px rgba(124,124,255,.25)}
    .btn{
      background:linear-gradient(180deg,#252559,#1d1d49);border:1px solid var(--border);
      color:var(--ink);padding:10px 14px;border-radius:12px;cursor:pointer;
      box-shadow:0 8px 20px rgba(0,0,0,.25), inset 0 0 0 1px rgba(255,255,255,.02);
      transition:transform .04s ease, background .2s ease;
    }
    .btn:hover{background:linear-gradient(180deg,#2b2b66,#232356)}
    .btn:active{transform:translateY(1px)}
    .btn:disabled{opacity:.6;cursor:not-allowed}
    .btn.accent{background:linear-gradient(180deg,#6a6aff,#5858ff);border-color:#5a5aff}
    .btn.ok{background:linear-gradient(180deg,#25b56a,#1ea45f);border-color:#1b8a52}
    .btn.warn{background:linear-gradient(180deg,#f45d7b,#e44d6c);border-color:#d24662}
    .btn.ghost{background:transparent}

    /* leaderboard */
    .leaderboard table{width:100%;border-collapse:separate;border-spacing:0 8px}
    .leaderboard th{font-weight:600;color:#cfd6ff;text-align:left;font-size:14px;padding:6px 10px}
    .leaderboard td{background:#111134;border:1px solid var(--border);padding:10px;border-left:none;border-right:none}
    .leaderboard .rank{width:44px;text-align:center;background:#16164a;border-radius:12px;border:1px solid var(--border)}
    .muted{color:var(--muted)}
    .pill{display:inline-flex;align-items:center;gap:8px;padding:4px 10px;border-radius:999px;border:1px solid var(--border);color:#bfc6ff;background:var(--pill)}

    /* QA specifics */
    .qnum{font-weight:900;font-size:28px;margin-top:6px}
    #question{font-size:22px;line-height:1.65;margin-top:6px;max-width:70ch}
    .result{margin-top:12px;padding:12px;border-radius:12px;border:1px solid var(--border)}
    .result.ok{background:rgba(62,224,137,.10);border-color:rgba(62,224,137,.45)}
    .result.bad{background:rgba(255,110,134,.08);border-color:rgba(255,110,134,.40)}
    .delta{font-weight:800}
    .delta.pos{color:var(--ok)}
    .delta.neg{color:var(--bad)}
    .hidden{display:none}

    /* subtle entry animations */
    .step{opacity:0;transform:translateY(8px)}
    .step.show{opacity:1;transform:none;transition:opacity .25s, transform .25s}
    .pop{animation:pop .22s ease both}
    @keyframes pop{from{opacity:0;transform:scale(.985)} to{opacity:1;transform:scale(1)}}
  </style>
</head>
<body>
<header>
  <div class="nav">
    <div class="chip">
      <span class="muted">AI</span>
      <select id="aiSelect" style="background:#0f0f27;border:1px solid var(--border);color:var(--ink);border-radius:10px;padding:6px 8px">
        <option value="pimp">One Line Pimp Simulator</option>
      </select>
      <span id="conn" class="bubble" title="connection"></span>
    </div>
    <div class="spacer"></div>
    <div class="chip" id="scoreChip" style="display:none;"><span class="muted">Score</span> <strong id="scoreVal">0</strong></div>
    <div class="chip" id="userChip" style="display:none;"><span class="muted">User</span> <strong id="userVal">—</strong></div>
  </div>
</header>

<div id="shell" class="shell">
  <!-- Sidebar collapses completely during QA/Summary -->
  <aside id="sidebar" class="sidebar">
    <div class="card leaderboard">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <h3 style="margin:0">Global Leaderboard</h3><span class="pill">Top 10</span>
      </div>
      <div id="lbEmpty" class="muted">Fetching leaderboard…</div>
      <table id="lbTable" class="hidden">
        <thead><tr><th>#</th><th>User</th><th>Pts</th><th>Ans</th></tr></thead>
        <tbody id="lbBody"></tbody>
      </table>
    </div>
  </aside>

  <!-- Main stage changes width depending on step -->
  <main id="stage" class="card step show compact">
    <!-- CONNECT -->
    <section id="step-connect">
      <h2 style="margin:0 0 6px">Welcome</h2>
      <p id="connectMsg" class="muted">We’ll check the server connection automatically.</p>
      <div style="margin-top:12px"><button class="btn accent" id="goUserType" disabled>Continue</button></div>
    </section>

    <!-- USER TYPE -->
    <section id="step-user-type" class="hidden">
      <h2 style="margin:0 0 8px">Who are you?</h2>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn accent" id="btnNewUser">I’m new</button>
        <button class="btn" id="btnExistingUser">I’ve been here</button>
      </div>
    </section>

    <!-- NEW USER -->
    <section id="step-new" class="hidden">
      <h2 style="margin:0 0 8px">Create new user</h2>
      <label>Username (case sensitive)</label>
      <input id="newUsername" placeholder="e.g., Gurnoor"/>
      <div style="margin-top:12px;display:flex;gap:10px">
        <button class="btn accent" id="createUser">Create</button>
        <button class="btn ghost" data-back="user-type">Back</button>
      </div>
      <div id="newUserMsg" class="muted" style="margin-top:8px;"></div>
    </section>

    <!-- EXISTING USER -->
    <section id="step-existing" class="hidden">
      <h2 style="margin:0 0 8px">Sign in</h2>
      <label>Username (case sensitive)</label>
      <input id="existingUsername" placeholder="Your exact username"/>
      <div style="margin-top:12px;display:flex;gap:10px">
        <button class="btn accent" id="useExisting">Continue</button>
        <button class="btn ghost" data-back="user-type">Back</button>
      </div>
      <div id="existingMsg" class="muted" style="margin-top:8px;"></div>
    </section>

    <!-- DASHBOARD -->
    <section id="step-dashboard" class="hidden">
      <h2 style="margin:0 0 6px">Session setup</h2>
      <div class="muted" id="exclInfo" style="margin-bottom:10px;"></div>
      <label>Topic</label>
      <input id="topic" value="random" placeholder="random or e.g., cardiology"/>
      <div style="height:8px"></div>
      <label>Starting difficulty</label>
      <select id="difficulty">
        <option>MSI1</option><option>MSI2</option><option selected>MSI3</option><option>MSI4</option>
        <option>R1</option><option>R2</option><option>R3</option><option>R4</option><option>R5</option><option>Attending</option>
      </select>
      <div style="margin-top:12px;display:flex;gap:10px">
        <button class="btn accent" id="startSession">Launch session</button>
        <button class="btn" id="goHistory">See previous questions</button>
      </div>
      <div class="muted" id="settingsMsg" style="margin-top:8px;"></div>
    </section>

    <!-- HISTORY -->
    <section id="step-history" class="hidden">
      <h2 style="margin:0 0 8px">Previously asked questions</h2>
      <div id="historyList" style="min-height:140px"></div>
      <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn" id="reloadHistory">Reload</button>
        <button class="btn ghost" data-back="dashboard">Back</button>
      </div>
      <div id="historyMsg" class="muted" style="margin-top:8px;"></div>
    </section>

    <!-- QA -->
    <section id="step-qa" class="hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="muted">Question</span>
          <span id="pillDiff" class="pill">—</span>
        </div>
        <div class="chip"><span class="muted">Score</span> <strong id="scoreVal2">0</strong></div>
      </div>
      <div id="qHeader" class="qnum">#—</div>
      <div id="question"></div>

      <div style="margin-top:14px">
        <label>Your answer</label>
        <input id="answer" placeholder="One word or short sentence…"/>
      </div>

      <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn ok" id="submitAnswer">Submit</button>
        <button class="btn warn" id="btnSaveAndFeedback">Save & Get Feedback</button>
      </div>

      <div id="resultBox" class="result hidden"></div>

      <div style="margin-top:10px;display:flex;gap:10px;align-items:center;justify-content:space-between;">
        <button id="btnProceed" class="btn accent hidden">Next question</button>
        <button class="btn ghost" data-back="dashboard">End session</button>
      </div>
    </section>

    <!-- SUMMARY -->
    <section id="step-summary" class="hidden">
      <h2 style="margin:0 0 6px">Session Summary</h2>
      <div id="sumStats" class="muted"></div>
      <div id="sumFeedback" style="margin-top:10px"></div>
      <div id="sumRating" style="font-size:28px;font-weight:900;margin-top:6px"></div>
      <div style="margin-top:14px;display:flex;gap:10px">
        <button class="btn accent" data-back="dashboard">OK</button>
      </div>
    </section>
  </main>
</div>

<script>
  const DEFAULT_REMOTE = "https://file-iy1w.onrender.com";
  const SERVERS = { pimp: (new URLSearchParams(location.search).get('api') || DEFAULT_REMOTE) };
  const state = { base:"", connected:false, username:"", sessionId:"", qNumber:null, difficulty:"", awaitingProceed:false, score:0, currentStep:"connect" };

  const $ = id => document.getElementById(id);
  const errMsg = e => e?.detail || e?.error || 'Unexpected error';
  function setConn(ok){ state.connected = ok; $('conn').classList.toggle('ok', ok); }
  function setUser(u){ state.username=u; $('userVal').textContent=u; $('userChip').style.display='flex'; }
  function updateScore(v){ state.score=+v||0; $('scoreVal').textContent=state.score; $('scoreVal2').textContent=state.score; $('scoreChip').style.display='flex'; }
  async function api(path, opts = {}) {
    const base = String(state.base || '');
    const url = base.replace(/\/+$/,'') + '/' + String(path || '').replace(/^\/+/, '');
    const method = String(opts.method || 'GET').toUpperCase();
    const headers = { ...(opts.headers || {}) };

    // Avoid unnecessary CORS preflights: only set JSON content-type when we actually send a body
    const hasBody = opts.body !== undefined && opts.body !== null;
    const hasCT = headers['Content-Type'] || headers['content-type'];
    if (hasBody && !hasCT) headers['Content-Type'] = 'application/json';

    const r = await fetch(url, { ...opts, method, headers });
    const t = await r.text();
    let d;
    try { d = t ? JSON.parse(t) : {}; } catch { d = { raw: t }; }
    if (!r.ok) throw d;
    return d;
  }

  const steps=["connect","user-type","new","existing","dashboard","history","qa","summary"];
  function showStep(name){
    state.currentStep=name;
    steps.forEach(k=>{ const s=$('step-'+k); if(!s) return; s.classList.add('hidden'); s.classList.remove('show'); });
    const target=$('step-'+name);
    if(target){ target.classList.remove('hidden'); requestAnimationFrame(()=>target.classList.add('show')); }

    // layout tweaks
    const hideSidebar = (name==="qa" || name==="summary");
    $('sidebar').classList.toggle('hidden', hideSidebar);
    $('shell').classList.toggle('no-sidebar', hideSidebar);
    $('stage').classList.toggle('wide', hideSidebar);
    $('stage').classList.toggle('compact', !hideSidebar);

    // richer question typography only in QA
    if(name==="qa"){ $('question').style.fontSize='22px'; $('question').style.maxWidth='70ch'; }
  }

  async function connectAndBoot(){
    state.base = SERVERS[$('aiSelect').value];
    setConn(false); $('goUserType').disabled = true; $('connectMsg').textContent='Checking connection…';
    fetchLeaderboard();
    try{ const r=await api('/health'); setConn(!!r.ok); $('connectMsg').textContent=r.ok?'Connection established.':'Server responded but not healthy.'; $('goUserType').disabled=!r.ok; }
    catch(e){ setConn(false); $('connectMsg').textContent='Connection failed: '+errMsg(e); }
  }

  async function fetchLeaderboard(){
    try{
      const r = await api('/api/leaderboard?limit=10');
      const rows = Array.isArray(r) ? r : (r.leaderboard || []);
      if(!rows.length){ $('lbEmpty').textContent='No scores yet.'; return; }
      $('lbEmpty').classList.add('hidden'); $('lbTable').classList.remove('hidden');
      const body=$('lbBody'); body.innerHTML='';
      rows.forEach((row,i)=>{
        const uname = row.username ?? row.member ?? (Array.isArray(row)?row[0]:undefined) ?? '—';
        const pts = Number(row.score ?? (Array.isArray(row)?row[1]:undefined) ?? 0);
        const tr=document.createElement('tr');
        tr.innerHTML=`<td class="rank">${row.rank ?? (i+1)}</td><td>${uname}</td><td><strong>${pts.toLocaleString()}</strong></td><td id="lb-answered-${i}"><span class="muted">…</span></td>`;
        body.appendChild(tr);
        if(uname && uname!=='—'){
          api('/api/score?username='+encodeURIComponent(uname))
            .then(s=>$('lb-answered-'+i).innerHTML=`<strong>${Number(s.answered||0)}</strong>`)
            .catch(()=>$('lb-answered-'+i).innerHTML=`<span class="muted">n/a</span>`);
        }
      });
    }catch(e){ $('lbEmpty').textContent='Failed to load leaderboard: '+errMsg(e); }
  }

  async function prepDashboard(){
    try{ const r=await api('/api/exclusions/count?username='+encodeURIComponent(state.username)); $('exclInfo').textContent=`You have ${r.count} question(s) in your exclusion list.`; }
    catch(e){ $('exclInfo').textContent='Could not fetch exclusions: '+errMsg(e); }
    try{ const s=await api('/api/score?username='+encodeURIComponent(state.username)); updateScore(s.score||0); } catch{}
  }

  async function loadHistory(){
    $('historyMsg').textContent='Loading…';
    try{
      const r=await api('/api/history?username='+encodeURIComponent(state.username));
      const items=r.items||[]; const box=$('historyList');
      if(!items.length) box.innerHTML='<span class="muted">No history yet.</span>';
      else{
        const ul=document.createElement('ul'); ul.style.margin='0'; ul.style.paddingLeft='18px';
        items.forEach(it=>{ const li=document.createElement('li'); const d=it.difficulty?` <span class="pill">${it.difficulty}</span>`:''; li.innerHTML=`<div>${(it.q||it.question||'—')}${d}</div>`; ul.appendChild(li); });
        box.innerHTML=''; box.appendChild(ul);
      }
      $('historyMsg').textContent='';
    }catch(e){ $('historyMsg').textContent='Failed to load history: '+errMsg(e); }
  }

  async function startSession(){
    const topic = $('topic').value.trim() || 'random';
    const startingDifficulty = $('difficulty').value;
    try{
      const r=await api('/api/sessions',{method:'POST', body:JSON.stringify({ username:state.username, topic, startingDifficulty })});
      state.sessionId=r.sessionId; state.difficulty=r.difficulty; $('pillDiff').textContent=state.difficulty;
      showStep('qa'); await nextQuestion();
    }catch(e){ $('settingsMsg').textContent='Failed to start session: '+errMsg(e); }
  }

  async function nextQuestion(){
    try{
      const r=await api('/api/next',{method:'POST', body:JSON.stringify({ sessionId:state.sessionId })});
      state.qNumber=r.q_number; state.difficulty=r.difficulty;
      $('qHeader').textContent=`#${state.qNumber}`; $('pillDiff').textContent=r.difficulty;
      $('question').textContent=r.question; $('answer').value='';
      $('resultBox').classList.add('hidden'); $('btnProceed').classList.add('hidden'); state.awaitingProceed=false;
      $('answer').focus();
      $('question').classList.remove('pop'); void $('question').offsetWidth; $('question').classList.add('pop');
      $('qHeader').classList.remove('pop'); void $('qHeader').offsetWidth; $('qHeader').classList.add('pop');
    }catch(e){
      const box=$('resultBox'); box.className='result bad'; box.textContent='Failed to get next question: '+errMsg(e); box.classList.remove('hidden');
    }
  }

  function renderResult(correct, explanation, pointsDelta, nextDifficulty){
    const box=$('resultBox'); const pos=(+pointsDelta||0)>=0;
    const deltaHtml=`<div class="delta ${pos?'pos':'neg'}">${pos?'+':''}${pointsDelta||0} pts</div>`;
    if(correct){ box.className='result ok'; box.innerHTML=`<div><strong>Correct.</strong></div>${deltaHtml}`; }
    else{ box.className='result bad'; box.innerHTML=`<div><strong>Incorrect.</strong> ${explanation?('<span class="muted">'+explanation+'</span>'):''}</div>${deltaHtml}`; }
    if(nextDifficulty) $('pillDiff').textContent=nextDifficulty;
    box.classList.remove('hidden'); box.classList.remove('pop'); void box.offsetWidth; box.classList.add('pop');
  }

  async function submitAnswer(){
    if(state.awaitingProceed) return;
    const answer=$('answer').value.trim();
    if(!answer){ $('answer').focus(); return; }
    try{
      const r=await api('/api/answer',{method:'POST', body:JSON.stringify({ sessionId:state.sessionId, answer })});
      renderResult(r.correct, r.explanation, r.points_delta, r.nextDifficulty);
      if(typeof r.score!=='undefined') updateScore(r.score);
      $('btnProceed').classList.remove('hidden'); state.awaitingProceed=true;
    }catch(e){
      const box=$('resultBox'); box.className='result bad'; box.textContent='Grading failed: '+errMsg(e); box.classList.remove('hidden');
    }
  }

  async function concludeWithFeedback(){
    if(!state.sessionId) return;
    try{
      const r=await api('/api/conclude',{method:'POST', body:JSON.stringify({ sessionId:state.sessionId })});
      $('sumStats').innerHTML=`New exclusion count: <strong>${r.new_count}</strong> · Next number: <strong>${r.next_number}</strong>` + (typeof r.session_points!=='undefined'?` · Session points: <strong>${r.session_points}</strong>`:'');
      $('sumFeedback').textContent=r.feedback||''; $('sumRating').textContent=r.rating||'';
      showStep('summary');
    }catch(e){ alert('Failed to save & get feedback: '+errMsg(e)); }
  }

  // events
  $('aiSelect').addEventListener('change', connectAndBoot);
  window.addEventListener('load', ()=>{ connectAndBoot(); showStep('connect'); });
  $('goUserType').addEventListener('click', ()=>showStep('user-type'));
  $('btnNewUser').addEventListener('click', ()=>showStep('new'));
  $('btnExistingUser').addEventListener('click', ()=>showStep('existing'));
  document.querySelectorAll('[data-back]').forEach(b=>b.addEventListener('click',e=>showStep(e.currentTarget.getAttribute('data-back'))));
  $('createUser').addEventListener('click', async ()=>{
    const u=$('newUsername').value.trim(); if(!u){ $('newUserMsg').textContent='Please enter a username.'; return; }
    try{ await api('/api/users',{method:'POST', body:JSON.stringify({ username:u })}); setUser(u); $('newUserMsg').textContent=`User "${u}" created.`; await prepDashboard(); showStep('dashboard'); }
    catch(e){ $('newUserMsg').textContent=errMsg(e); }
  });
  $('useExisting').addEventListener('click', async ()=>{
    const u=$('existingUsername').value.trim(); if(!u){ $('existingMsg').textContent='Please enter your username.'; return; }
    try{ await api('/api/exclusions/count?username='+encodeURIComponent(u)); setUser(u); $('existingMsg').textContent=`Welcome back, ${u}.`; await prepDashboard(); showStep('dashboard'); }
    catch(e){ $('existingMsg').textContent=errMsg(e); }
  });
  $('startSession').addEventListener('click', startSession);
  $('goHistory').addEventListener('click', async ()=>{ await loadHistory(); showStep('history'); });
  $('reloadHistory').addEventListener('click', loadHistory);
  $('submitAnswer').addEventListener('click', submitAnswer);
  $('btnProceed').addEventListener('click', nextQuestion);
  $('btnSaveAndFeedback').addEventListener('click', concludeWithFeedback);
</script>
</body>
</html>
