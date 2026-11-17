const STORAGE_KEY = 'planner_state_v1';
const STATUS_CYCLE = ['ok','sick','vacation'];
const STATUS_LABEL = {ok:'ОК', sick:'больничный', vacation:'отпуск'};

function defaultState(){
  const musicians = Array.from({length:8}, (_,i)=>({
    id: 'm'+(i+1),
    name: 'Музыкант '+(i+1),
    isConcertmaster: i < 3
  }));
  return {
    musicians,
    programs: [],
    statuses: {},          
    accumulated: {},       
    locked: [],            
    period: { start: todayISO(), end: addDaysISO(todayISO(), 14) }
  };
}

let state = loadState();

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return defaultState();
    const s = JSON.parse(raw);
    s.musicians ||= defaultState().musicians;
    s.programs ||= [];
    s.statuses ||= {};
    s.accumulated ||= {};
    s.locked ||= [];
    s.period ||= defaultState().period;
    return s;
  }catch(e){ console.warn('load error', e); return defaultState(); }
}
function saveState(){ try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e){} }

function todayISO(){ return new Date().toISOString().slice(0,10); }
function addDaysISO(iso, n){
  const d = new Date(iso+'T00:00:00');
  d.setDate(d.getDate()+n);
  return d.toISOString().slice(0,10);
}
function uid(prefix='id'){ return prefix + Math.random().toString(36).slice(2,9); }

function eventDayKey(dateISO, startHHMM){
  const [h] = startHHMM.split(':').map(Number);
  if(h < 3) return addDaysISO(dateISO, -1);
  return dateISO;
}

function toMin(hhmm){
  const [h,m] = hhmm.split(':').map(Number);
  return h*60 + m;
}

function eventAbsInterval(ev){
  const dayBase = toMin('03:00'); 
  const shifted = eventDayKey(ev.date, ev.start) !== ev.date;
  const startMin = toMin(ev.start) - dayBase + (shifted ? 24*60 : 0);
  const endMin = toMin(ev.end) - dayBase + (shifted ? 24*60 : 0);
  const end = endMin <= startMin ? endMin + 24*60 : endMin;
  return {dayKey: eventDayKey(ev.date, ev.start), start:startMin, end};
}

function mergedWorkMinutes(intervals){
  if(!intervals.length) return 0;
  const expanded = intervals.map(iv=>({s:iv.start-60, e:iv.end+60}))
    .sort((a,b)=>a.s-b.s);
  let total = 0;
  let curS = expanded[0].s, curE = expanded[0].e;
  for(let i=1;i<expanded.length;i++){
    const iv = expanded[i];
    if(iv.s <= curE){
      if(iv.e > curE) curE = iv.e;
    } else {
      total += curE - curS;
      curS = iv.s; curE = iv.e;
    }
  }
  total += curE - curS;
  return total;
}

function computeScores(state){
  const musicians = state.musicians;
  const allEvents = [];
  for(const prog of state.programs){
    for(const ev of prog.events){
      allEvents.push({prog, ev, members: prog.members || []});
    }
  }

  const eventsByDay = {};
  for(const item of allEvents){
    const {dayKey, start, end} = eventAbsInterval(item.ev);
    item.dayKey = dayKey; item.abs = {start, end};
    (eventsByDay[dayKey] ||= []).push(item);
  }

  const {start:pStart, end:pEnd} = state.period;
  const days = [];
  const dayKeys = Object.keys(eventsByDay).filter(k=> k>=pStart && k<=pEnd).sort();

  for(const dayKey of dayKeys){
    const dayEvents = eventsByDay[dayKey];
    const workMin = {};
    for(const m of musicians) workMin[m.id] = 0;

    for(const m of musicians){
      const status = getStatus(state, m.id, dayKey);
      if(status !== 'ok') continue;
      const intervals = [];
      for(const item of dayEvents){
        if(!item.members.includes(m.id)) continue;
        intervals.push(item.abs);
      }
      workMin[m.id] = mergedWorkMinutes(intervals);
    }

    const okList = musicians.filter(m=> getStatus(state,m.id,dayKey)==='ok');
    const sumMin = okList.reduce((s,m)=> s + workMin[m.id], 0);
    const avgMin = okList.length ? sumMin / okList.length : 0;

    const scores = {};
    for(const m of musicians){
      const status = getStatus(state, m.id, dayKey);
      if(status !== 'ok'){ scores[m.id] = 0; continue; }
      scores[m.id] = (workMin[m.id] - avgMin) / 60;
    }

    const byMusician = {};
    for(const m of musicians) byMusician[m.id] = workMin[m.id]/60;

    days.push({ dayKey, byMusician, avgHours: avgMin/60, scores });
  }

  const planTotals = {};
  for(const m of musicians) planTotals[m.id] = 0;
  for(const d of days){
    for(const m of musicians) planTotals[m.id] += d.scores[m.id];
  }
  const grandTotals = {};
  for(const m of musicians){
    grandTotals[m.id] = (state.accumulated[m.id] || 0) + planTotals[m.id];
  }

  return {days, planTotals, grandTotals, eventsByDay};
}

function getStatus(state, musicianId, dayKey){
  return state.statuses?.[musicianId]?.[dayKey] || 'ok';
}

function renderAll(){
  renderPeriodInfo();
  renderPlanTable();
  renderPrograms();
  renderSettings();
}

function renderPeriodInfo(){
  const {start,end} = state.period;
  const el = document.getElementById('periodInfo');
  const {days, grandTotals} = computeScores(state);
  const sumSq = Object.values(grandTotals).reduce((s,v)=>s+v*v,0);
  el.innerHTML = `Период: <b>${start}</b> — <b>${end}</b> · дней с событиями: <b>${days.length}</b> · Σ(итог²): <b>${sumSq.toFixed(3)}</b>`;
}

function renderPlanTable(){
  const table = document.getElementById('planTable');
  const {grandTotals, planTotals} = computeScores(state);
  const musicians = state.musicians;
  const {start:pStart, end:pEnd} = state.period;

  const rows = [];
  for(const prog of state.programs){
    for(const ev of prog.events){
      const {dayKey, start, end} = eventAbsInterval(ev);
      if(dayKey < pStart || dayKey > pEnd) continue;
      rows.push({ dayKey, absStart:start, absEnd:end, prog, ev, members: prog.members || [] });
    }
  }
  rows.sort((a,b)=>{
    if(a.dayKey !== b.dayKey) return a.dayKey < b.dayKey ? -1 : 1;
    return a.absStart - b.absStart;
  });

  if(!rows.length){
    table.innerHTML = '<tr><td class="empty">Нет событий в периоде. Добавьте программу.</td></tr>';
    return;
  }

  const conflictSet = new Set();
  for(let i=0;i<rows.length;i++){
    for(let j=i+1;j<rows.length;j++){
      const a = rows[i], b = rows[j];
      if(a.dayKey !== b.dayKey) continue;
      if(a.absEnd <= b.absStart || b.absEnd <= a.absStart) continue;
      for(const m of musicians){
        if(getStatus(state,m.id,a.dayKey)!=='ok' || getStatus(state,m.id,b.dayKey)!=='ok') continue;
        if(a.members.includes(m.id) && b.members.includes(m.id)){
          conflictSet.add(i+':'+m.id);
          conflictSet.add(j+':'+m.id);
        }
      }
    }
  }

  let html = '<thead><tr><th>Событие</th>';
  for(const m of musicians){
    html += `<th>${escapeHtml(m.name)}${m.isConcertmaster?'<span class="cm"></span>':''}</th>`;
  }
  html += '<th>Итог</th></tr></thead><tbody>';

  for(let i=0;i<rows.length;i++){
    const r = rows[i];
    const typeLabel = r.ev.type === 'concert' ? 'Концерт' : 'Репетиция';
    const title = `${r.dayKey} ${r.ev.start}–${r.ev.end} · ${escapeHtml(r.prog.name)} · ${typeLabel}`;
    html += `<tr><td title="${title}">${title}</td>`;
    for(const m of musicians){
      const st = getStatus(state, m.id, r.dayKey);
      const member = r.members.includes(m.id);
      const conflict = conflictSet.has(i+':'+m.id);
      let cell;
      if(st !== 'ok'){
        cell = `<span class="muted" title="${STATUS_LABEL[st]}">—</span>`;
      } else if(member){
        cell = `<span class="plus">+</span>`;
      } else {
        cell = `<span class="circ">○</span>`;
      }
      html += `<td class="${conflict?'conflict':''}">${cell}</td>`;
    }
    html += `<td></td></tr>`;
  }

  html += '<tr><td><b>План (Σ дней)</b></td>';
  for(const m of musicians){
    const v = planTotals[m.id];
    html += `<td class="${clsNum(v)}">${fmtNum(v)}</td>`;
  }
  html += '<td></td></tr>';

  html += '<tr><td><b>Итог (накопл. + план)</b></td>';
  for(const m of musicians){
    const v = grandTotals[m.id];
    html += `<td class="${clsNum(v)}"><b>${fmtNum(v)}</b></td>`;
  }
  const sumSq = Object.values(grandTotals).reduce((s,v)=>s+v*v,0);
  html += `<td>${sumSq.toFixed(2)}</td></tr>`;

  html += '</tbody>';
  table.innerHTML = html;
}

function clsNum(v){ return v>0.0001?'pos':(v<-0.0001?'neg':''); }
function fmtNum(v){ return (v>=0?'+':'') + v.toFixed(2); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function renderPrograms(){
  const wrap = document.getElementById('programsList');
  if(!state.programs.length){
    wrap.innerHTML = '<div class="empty">Программ пока нет.</div>';
    return;
  }
  let html = '';
  for(const prog of state.programs){
    html += `<div class="prog" data-pid="${prog.id}">
      <div class="head">
        <strong>${escapeHtml(prog.name || 'Без названия')}</strong>
        <span class="muted">N = ${prog.sizeN || 0} · участников: ${(prog.members||[]).length}</span>
      </div>
      <div class="row" style="margin-bottom:6px">
        <button class="small ghost" data-act="edit">Изменить</button>
        <button class="small danger" data-act="del">Удалить</button>
        <button class="small ghost" data-act="addevent">+ Событие</button>
      </div>
      <div class="muted">Состав:</div>
      <div class="members">
        ${state.musicians.map(m=>{
          const on = (prog.members||[]).includes(m.id);
          return `<label><input type="checkbox" data-act="member" data-mid="${m.id}" ${on?'checked':''} ${locked(prog.id,m.id)?'disabled':''}>${escapeHtml(m.name)}${m.isConcertmaster?'<span class="cm"></span>':''}${locked(prog.id,m.id)?' 🔒':''}</label>`;
        }).join('')}
      </div>
      <ul class="events">
        ${(prog.events||[]).map(ev=>`
          <li>
            <span>${ev.date} ${ev.start}–${ev.end} · ${ev.type==='concert'?'Концерт':'Репетиция'}</span>
            <span>
              <button class="small ghost" data-act="editevent" data-eid="${ev.id}">✎</button>
              <button class="small danger" data-act="delevent" data-eid="${ev.id}">✕</button>
            </span>
          </li>`).join('') || '<li class="muted">Нет событий</li>'}
      </ul>
    </div>`;
  }
  wrap.innerHTML = html;
}

function locked(pid, mid){ return state.locked.some(l=>l.programId===pid && l.musicianId===mid); }

function renderSettings(){
  document.getElementById('periodStart').value = state.period.start;
  document.getElementById('periodEnd').value = state.period.end;

  const ml = document.getElementById('musiciansList');
  ml.innerHTML = state.musicians.map(m=>`
    <div class="row" style="margin-bottom:6px">
      <input type="text" data-mid="${m.id}" data-act="mname" value="${escapeHtml(m.name)}" style="flex:1">
      <label><input type="checkbox" data-mid="${m.id}" data-act="mcm" ${m.isConcertmaster?'checked':''}>Концертмейстер</label>
    </div>
  `).join('');

  const al = document.getElementById('accumList');
  al.innerHTML = state.musicians.map(m=>`
    <div class="row" style="margin-bottom:6px">
      <span style="flex:1">${escapeHtml(m.name)}</span>
      <input type="number" step="0.01" style="width:100px" data-mid="${m.id}" data-act="accum"
        value="${(state.accumulated[m.id]||0).toFixed(2)}">
    </div>
  `).join('');

  renderStatusesEditor();
}

function renderStatusesEditor(){
  const wrap = document.getElementById('statusesEditor');
  const {start,end} = state.period;
  const days = [];
  let d = start;
  while(d <= end){ days.push(d); d = addDaysISO(d, 1); }
  if(!days.length){ wrap.innerHTML = '<div class="empty">Задайте период.</div>'; return; }

  let html = '<div style="overflow:auto"><table><thead><tr><th>Музыкант</th>';
  for(const day of days) html += `<th>${day.slice(5)}</th>`;
  html += '</tr></thead><tbody>';
  for(const m of state.musicians){
    html += `<tr><td>${escapeHtml(m.name)}</td>`;
    for(const day of days){
      const st = getStatus(state, m.id, day);
      const cls = st==='ok'?'':(st==='sick'?'conflict':'');
      const label = st==='ok'?'○':(st==='sick'?'Б':'О');
      const title = STATUS_LABEL[st];
      html += `<td class="${cls}"><button class="small ghost" data-act="status" data-mid="${m.id}" data-day="${day}" title="${title}">${label}</button></td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  wrap.innerHTML = html;
}

document.getElementById('nav').addEventListener('click', e=>{
  const btn = e.target.closest('button[data-tab]');
  if(!btn) return;
  document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('active', b===btn));
  document.querySelectorAll('.tab').forEach(s=>s.classList.toggle('active', s.id==='tab-'+btn.dataset.tab));
});

document.getElementById('addProgramBtn').addEventListener('click', ()=>{
  const name = prompt('Название программы:', 'Программа '+(state.programs.length+1));
  if(name===null) return;
  const nStr = prompt('Сколько человек должно работать (N)?', '3');
  if(nStr===null) return;
  const n = Math.max(1, parseInt(nStr,10)||1);
  state.programs.push({ id: uid('p'), name: name.trim()||'Без названия', sizeN:n, members:[], events:[] });
  saveState(); renderAll();
});

document.getElementById('programsList').addEventListener('click', e=>{
  const btn = e.target.closest('button[data-act]');
  if(!btn) return;
  const progEl = e.target.closest('.prog');
  const pid = progEl?.dataset.pid;
  const prog = state.programs.find(p=>p.id===pid);
  if(!prog && btn.dataset.act!=='add') return;

  const act = btn.dataset.act;
  if(act==='del'){
    if(!confirm('Удалить программу?')) return;
    state.programs = state.programs.filter(p=>p.id!==pid);
    state.locked = state.locked.filter(l=>l.programId!==pid);
    saveState(); renderAll(); return;
  }
  if(act==='edit'){
    const name = prompt('Название программы:', prog.name);
    if(name===null) return;
    const nStr = prompt('N (число людей):', prog.sizeN);
    if(nStr===null) return;
    prog.name = name.trim()||'Без названия';
    prog.sizeN = Math.max(1, parseInt(nStr,10)||1);
    saveState(); renderAll(); return;
  }
  if(act==='addevent'){ addEventDialog(prog); return; }
  if(act==='editevent'){
    const ev = prog.events.find(x=>x.id===btn.dataset.eid);
    if(ev) editEventDialog(prog, ev);
    return;
  }
  if(act==='delevent'){
    prog.events = prog.events.filter(x=>x.id!==btn.dataset.eid);
    saveState(); renderAll(); return;
  }
});

document.getElementById('programsList').addEventListener('change', e=>{
  const inp = e.target.closest('input[data-act="member"]');
  if(!inp) return;
  const progEl = e.target.closest('.prog');
  const prog = state.programs.find(p=>p.id===progEl.dataset.pid);
  if(!prog) return;
  const mid = inp.dataset.mid;
  if(inp.checked){
    if(!prog.members.includes(mid)) prog.members.push(mid);
  } else {
    prog.members = prog.members.filter(x=>x!==mid);
  }
  saveState(); renderAll();
});

function addEventDialog(prog){
  const date = prompt('Дата (YYYY-MM-DD):', state.period.start);
  if(date===null) return;
  const start = prompt('Начало (HH:MM):', '19:00');
  if(start===null) return;
  const end = prompt('Конец (HH:MM):', '21:00');
  if(end===null) return;
  const type = confirm('Это концерт? (ОК = концерт, Отмена = репетиция)') ? 'concert' : 'rehearsal';
  prog.events.push({ id: uid('e'), date, start, end, type });
  saveState(); renderAll();
}
function editEventDialog(prog, ev){
  const date = prompt('Дата:', ev.date); if(date===null) return;
  const start = prompt('Начало:', ev.start); if(start===null) return;
  const end = prompt('Конец:', ev.end); if(end===null) return;
  const type = confirm('Концерт? (ОК = концерт, Отмена = репетиция)') ? 'concert' : 'rehearsal';
  ev.date=date; ev.start=start; ev.end=end; ev.type=type;
  saveState(); renderAll();
}

document.getElementById('periodStart').addEventListener('change', e=>{
  state.period.start = e.target.value; saveState(); renderAll();
});
document.getElementById('periodEnd').addEventListener('change', e=>{
  state.period.end = e.target.value; saveState(); renderAll();
});

document.getElementById('musiciansList').addEventListener('input', e=>{
  const el = e.target.closest('[data-act="mname"]');
  if(!el) return;
  const m = state.musicians.find(x=>x.id===el.dataset.mid);
  if(m){ m.name = el.value; saveState(); }
});
document.getElementById('musiciansList').addEventListener('change', e=>{
  const el = e.target.closest('[data-act="mcm"]');
  if(!el) return;
  const m = state.musicians.find(x=>x.id===el.dataset.mid);
  if(m){ m.isConcertmaster = el.checked; saveState(); renderAll(); }
});

document.getElementById('accumList').addEventListener('input', e=>{
  const el = e.target.closest('[data-act="accum"]');
  if(!el) return;
  state.accumulated[el.dataset.mid] = parseFloat(el.value)||0;
  saveState(); renderPeriodInfo(); renderPlanTable();
});

document.getElementById('statusesEditor').addEventListener('click', e=>{
  const btn = e.target.closest('button[data-act="status"]');
  if(!btn) return;
  const mid = btn.dataset.mid, day = btn.dataset.day;
  const cur = getStatus(state, mid, day);
  const idx = STATUS_CYCLE.indexOf(cur);
  const next = STATUS_CYCLE[(idx+1)%STATUS_CYCLE.length];
  state.statuses[mid] ||= {};
  state.statuses[mid][day] = next;
  saveState(); renderAll();
});

document.getElementById('resetBtn').addEventListener('click', ()=>{
  if(!confirm('Сбросить все данные?')) return;
  localStorage.removeItem(STORAGE_KEY);
  state = defaultState();
  saveState(); renderAll();
});

renderAll();