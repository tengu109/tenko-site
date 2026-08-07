
/* =========================================================
   FIREBASE 初期化
   設定値は firebase-config.js に分離してあります。
========================================================= */
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);
const FS_COLLECTION = 'tenko'; // Firestore内のコレクション名（ドキュメントID＝旧window.storageのキー名）

/* =========================================================
   STATE & STORAGE
========================================================= */
let members = [];        // {id,name,furigana,grade,gradeValue,joinDate(YYYY-MM)}
let guardians = [];      // {id,name,memberId}
let events = [];         // {id,date,endTime,title,type,location,status,dutyTarget,dutyGuardianIds:[]}
let locations = [];      // {id,name} predefined location list managed by admin
let attendance = {};
let dutyAttendance = {}; // open duty-availability poll, ALL guardians can answer
let dutyBadges = [];     // {code,label} extensible badge master list (未/兼 etc.)
let archivedFiscalYears = []; // [2024, 2025, ...] years locked to read-only
let adminPasscode = '0000';
let isAdmin = false;
let pendingTab = null;

let uiState = {
  inputType: '練習', inputSelectedEvent: null, inputExpandedMember: null, inputExpandedGuardian: null,
  overviewType: '練習', overviewSelectedEvent: null, overviewExpandedMember: null,
  dutyType: '練習', dutyFY: null,
  adminSubTab: 'events', adminEditingEvent: null, adminEditingMember: null, adminEditingGuardian: null,
  fyManageYear: null,
};
let newEventDraft = { dutyTarget: 1, type: '練習' };

function uid(prefix){ return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function dutyLabel(type){ return type==='練習' ? '見守り当番' : '付添保護者'; }
function withSan(name){ return name ? name + 'さん' : ''; }
function guardianBadgesFor(ev, guardianId){ return (ev.dutyBadges && ev.dutyBadges[guardianId]) || []; }
function badgeTagsHtml(codes){ return codes.map(c=>`<span class="badge-tag">${escapeHtml(c)}</span>`).join(''); }
function guardianNameWithBadgesHtml(ev, g){ return escapeHtml(withSan(g.name)) + badgeTagsHtml(guardianBadgesFor(ev, g.id)); }
function isNotPast(dateStr){
  const d = new Date(dateStr); if(isNaN(d)) return true;
  const today = new Date();
  d.setHours(0,0,0,0); today.setHours(0,0,0,0);
  return d >= today;
}

/* =========================================================
   DATA ACCESS LAYER (Firebase Cloud Firestore)
   すべての永続化はこの DataStore だけを通す。
   呼び出し側（save系の各関数）はFirestoreの存在を
   一切意識しない（get/setのシグネチャは旧window.storage版と同じ）。
   さらに listen() でリアルタイム同期（onSnapshot）を行い、
   他の端末での変更が即座にこの端末にも反映される。
========================================================= */
const DataStore = {
  async get(key, fallback){
    try{
      const snap = await getDoc(doc(db, FS_COLLECTION, key));
      return snap.exists() ? snap.data().value : fallback;
    }catch(e){ console.error('DataStore.get error', key, e); return fallback; }
  },
  async set(key, value){
    try{ await setDoc(doc(db, FS_COLLECTION, key), { value, updatedAt: Date.now() }); return true; }
    catch(e){ console.error('DataStore.set error', key, e); showToast('保存に失敗しました（通信をご確認ください）'); return null; }
  },
  // ドキュメント1件をリアルタイム購読する。onChangeにはドキュメントが
  // 存在しない場合 undefined が渡される（初回シード処理の判定に使用）。
  listen(key, onChange){
    return onSnapshot(doc(db, FS_COLLECTION, key), (snap)=>{
      onChange(snap.exists() ? snap.data().value : undefined);
    }, (err)=>{ console.error('onSnapshot error', key, err); showToast('同期エラーが発生しました'); });
  }
};

function initRealtimeSync(){
  DataStore.listen('members', v=>{ members = v || []; renderAll(); });
  DataStore.listen('guardians', v=>{
    guardians = v || [];
    guardians.forEach(g=>{ if(!g.memberIds){ g.memberIds = g.memberId ? [g.memberId] : []; } delete g.memberId; });
    renderAll();
  });
  DataStore.listen('events', v=>{
    events = v || [];
    events.forEach(ev=>{ if(!ev.status) ev.status='募集中'; if(!ev.dutyGuardianIds) ev.dutyGuardianIds=[]; if(!ev.dutyBadges) ev.dutyBadges={}; });
    renderAll();
  });
  DataStore.listen('locations', async v=>{
    if(v === undefined){
      locations = [
        '高円寺学園・大アリーナ',
        'コミュニティふらっとすぎはち・第2多目的室',
        '座高円寺・阿波おどりホール',
        'セシオン杉並・体育室(B1)',
        'コミュニティふらっと馬橋・多目的室',
        '高円寺障害者交流館・集会室1.2'
      ].map(name=>({ id: uid('loc'), name }));
      await saveLocations();
    }else{
      locations = v;
    }
    renderAll();
  });
  DataStore.listen('attendance', v=>{ attendance = v || {}; renderAll(); });
  DataStore.listen('duty_attendance', v=>{ dutyAttendance = v || {}; renderAll(); });
  DataStore.listen('admin_passcode', v=>{ adminPasscode = v || '0000'; });
  DataStore.listen('duty_badges', async v=>{
    if(v === undefined || v.length===0){
      dutyBadges = [
        { code:'未', label:'未就学児保護者' },
        { code:'兼', label:'踊り・鳴り物兼任' },
        { code:'新', label:'新規入連' }
      ];
      await saveDutyBadges();
    }else{
      dutyBadges = v;
    }
    renderAll();
  });
  DataStore.listen('archived_fiscal_years', v=>{ archivedFiscalYears = v || []; renderAll(); });
}
async function saveMembers(){ await DataStore.set('members', members); }
async function saveGuardians(){ await DataStore.set('guardians', guardians); }
async function saveEvents(){ await DataStore.set('events', events); }
async function saveLocations(){ await DataStore.set('locations', locations); }
async function saveAttendance(){ await DataStore.set('attendance', attendance); }
async function saveDutyAttendance(){ await DataStore.set('duty_attendance', dutyAttendance); }
async function savePasscode(){ await DataStore.set('admin_passcode', adminPasscode); }
async function saveDutyBadges(){ await DataStore.set('duty_badges', dutyBadges); }
async function saveArchivedFiscalYears(){ await DataStore.set('archived_fiscal_years', archivedFiscalYears); }
function showToast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),1600); }

/* =========================================================
   HELPERS
========================================================= */
function displayName(mem){ return (mem.gradeValue<=0?'<span class="honor">◉</span>':'') + escapeHtml(mem.name); }
function plainDisplayName(mem){ return (mem.gradeValue<=0?'◉':'') + mem.name; }
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtDateShort(dt){
  const d = new Date(dt); if(isNaN(d)) return dt;
  const wd = ['日','月','火','水','木','金','土'][d.getDay()];
  return `${d.getMonth()+1}/${d.getDate()}(${wd})`;
}
function fmtTime(dt){ const d = new Date(dt); if(isNaN(d)) return ''; return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function fmtEventWhen(ev){ return `${fmtDateShort(ev.date)} ${fmtTime(ev.date)}${ev.endTime?('〜'+ev.endTime):''}`; }
function sortedMembers(){
  return [...members].sort((a,b)=>{
    if((b.gradeValue||0) !== (a.gradeValue||0)) return (b.gradeValue||0)-(a.gradeValue||0);
    const da = a.joinDate ? new Date(a.joinDate+'-01') : new Date(0);
    const db = b.joinDate ? new Date(b.joinDate+'-01') : new Date(0);
    return da - db;
  });
}
function guardianMemberIds(g){ return g.memberIds || (g.memberId ? [g.memberId] : []); }
function guardianChildLabel(g){
  const names = guardianMemberIds(g).map(id=>{ const mem = members.find(m=>m.id===id); return mem ? mem.name : null; }).filter(Boolean);
  return names.length ? names.join('・')+'の保護者' : '';
}
function sortedGuardians(){
  const order = sortedMembers().map(m=>m.id);
  const minOrder = g => Math.min(...guardianMemberIds(g).map(id=>{ const i = order.indexOf(id); return i<0 ? 9999 : i; }), 9999);
  return [...guardians].sort((a,b)=> minOrder(a) - minOrder(b));
}
function eventsOfTypeStatus(type, status, includePast){
  return events.filter(e=> (!type || e.type===type) && (!status || e.status===status) && (includePast || isNotPast(e.date)))
               .sort((a,b)=> new Date(a.date) - new Date(b.date));
}
function statusOf(eventId, memberId){ return (attendance[eventId] && attendance[eventId][memberId]) ? attendance[eventId][memberId] : null; }
function dutyStatusOf(eventId, guardianId){ return (dutyAttendance[eventId] && dutyAttendance[eventId][guardianId]) ? dutyAttendance[eventId][guardianId] : null; }
function fiscalYearOf(dateStr){ const d = new Date(dateStr); const m = d.getMonth()+1; const y = d.getFullYear(); return (m>=4) ? y : y-1; }
function currentFiscalYear(){ return fiscalYearOf(new Date().toISOString()); }
function isPastOrArchivedFY(fy){ return archivedFiscalYears.includes(fy) || fy < currentFiscalYear(); }
function shiftYearInDateTimeLocal(dateStr, yearsDelta){
  const parts = String(dateStr).split('-');
  if(parts.length<3) return dateStr;
  parts[0] = String(parseInt(parts[0],10)+yearsDelta).padStart(4,'0');
  return parts.join('-');
}
function monthIndexInFY(dateStr){ const d = new Date(dateStr); const m = d.getMonth()+1; return (m>=4) ? m-4 : m+8; }
const FY_MONTH_ORDER = [4,5,6,7,8,9,10,11,12,1,2,3];
function locationFieldHtml(idSuffix, currentValue){
  const match = currentValue ? locations.find(l=>l.name===currentValue) : null;
  const isOtherActive = !!currentValue && !match;
  const options = locations.map(l=>`<option value="${l.id}" ${match&&match.id===l.id?'selected':''}>${escapeHtml(l.name)}</option>`).join('');
  return `<select id="loc_${idSuffix}" onchange="onLocationChange('${idSuffix}')">
      <option value="">選択してください</option>
      ${options}
      <option value="__other__" ${isOtherActive?'selected':''}>その他（自由入力）</option>
    </select>
    <input id="locOther_${idSuffix}" class="note-input" style="margin-top:6px;${isOtherActive?'':'display:none;'}" placeholder="例：座・高円寺　阿波踊りホール" value="${isOtherActive?escapeHtml(currentValue):''}">`;
}
window.onLocationChange = function(idSuffix){
  const sel = document.getElementById('loc_'+idSuffix);
  const other = document.getElementById('locOther_'+idSuffix);
  other.style.display = (sel.value==='__other__') ? 'block' : 'none';
}
function getLocationValue(idSuffix){
  const sel = document.getElementById('loc_'+idSuffix);
  if(!sel) return '';
  if(sel.value==='__other__') return (document.getElementById('locOther_'+idSuffix).value||'').trim();
  if(sel.value===''){ return ''; }
  const loc = locations.find(l=>l.id===sel.value);
  return loc ? loc.name : '';
}

/* =========================================================
   TAB SWITCHING + ADMIN GATE
========================================================= */
document.querySelectorAll('.tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    const name = tab.dataset.tab;
    if(name==='admin' && !isAdmin){ pendingTab = name; openPcModal(); return; }
    activateTab(name);
  });
});
function activateTab(name){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${name}"]`).classList.add('active');
  document.getElementById('screen-'+name).classList.add('active');
  if(name==='overview') renderOverview();
  if(name==='admin') renderAdmin();
}
function openPcModal(){ document.getElementById('pcInput').value=''; document.getElementById('pcModal').classList.add('show'); }
window.closePcModal = function(){ document.getElementById('pcModal').classList.remove('show'); pendingTab=null; }
window.submitPasscode = function(){
  const val = document.getElementById('pcInput').value;
  if(val === adminPasscode){
    isAdmin = true; updateModePill();
    document.querySelectorAll('.tab.locked').forEach(t=>t.classList.remove('locked'));
    document.getElementById('pcModal').classList.remove('show');
    showToast('管理者モードに切り替えました');
    if(pendingTab) activateTab(pendingTab);
    pendingTab = null;
    renderAll();
  }else{ showToast('パスコードが違います'); }
}
function updateModePill(){
  const pill = document.getElementById('modePill');
  if(isAdmin){ pill.textContent='管理者モード（タップで終了）'; pill.className='mode-pill admin'; }
  else{ pill.textContent='使用者モード'; pill.className='mode-pill user'; }
}
window.onModePillClick = function(){
  if(isAdmin){
    isAdmin = false; updateModePill();
    document.querySelectorAll('.tab[data-tab="admin"]').forEach(t=>t.classList.add('locked'));
    const activeAdmin = document.querySelector('.tab.active[data-tab="admin"]');
    if(activeAdmin) activateTab('input');
    showToast('使用者モードに戻りました');
    renderInput();
  }else{ pendingTab = null; openPcModal(); }
}
function renderAll(){ renderInput(); renderOverview(); renderAdmin(); }

/* =========================================================
   予定 (募集中の練習・本番)
========================================================= */
function renderInput(){
  const el = document.getElementById('screen-input');
  let html = `<div class="segment">
    <div class="seg-btn ${uiState.inputType==='練習'?'active':''}" onclick="setInputType('練習')">練習</div>
    <div class="seg-btn ${uiState.inputType==='本番'?'active':''}" onclick="setInputType('本番')">本番</div>
  </div>`;
  const typeEvents = eventsOfTypeStatus(uiState.inputType, '募集中', false);
  if(typeEvents.length===0){
    html += `<div class="empty"><div class="big">📅</div>募集中の${uiState.inputType}予定はありません。<br>（過去の予定は翌日以降ここから消えます）</div>`;
    el.innerHTML = html; return;
  }
  if(!uiState.inputSelectedEvent || !typeEvents.find(e=>e.id===uiState.inputSelectedEvent)){
    typeEvents.forEach(ev=>{
      const respondedCount = attendance[ev.id] ? Object.keys(attendance[ev.id]).length : 0;
      html += `
      <div class="card" style="cursor:pointer" onclick="selectInputEvent('${ev.id}')">
        <span class="event-date">${fmtEventWhen(ev)}</span><span class="event-type ${ev.type}">${ev.type}</span><span class="status-tag ${ev.status}">${ev.status}</span>
        <h3>${escapeHtml(ev.title)}</h3>
        <div class="muted">📍 ${escapeHtml(ev.location||'未設定')}</div>
        <div class="muted">回答済み ${respondedCount} / ${members.length}人</div>
      </div>`;
    });
    el.innerHTML = html; return;
  }
  const ev = events.find(e=>e.id===uiState.inputSelectedEvent);
  const decidedGuardians = (ev.dutyGuardianIds||[]).map(id=>guardians.find(g=>g.id===id)).filter(Boolean);
  html += `
    <div class="btn btn-ghost btn-sm" onclick="backToEventList()" style="margin-bottom:12px;">← イベント一覧</div>
    <div class="card">
      <span class="event-date">${fmtEventWhen(ev)}</span><span class="event-type ${ev.type}">${ev.type}</span><span class="status-tag ${ev.status}">${ev.status}</span>
      <h3>${escapeHtml(ev.title)}</h3>
      <div class="muted">📍 ${escapeHtml(ev.location||'未設定')}</div>
      <div class="muted">🎽 ${dutyLabel(ev.type)}：${decidedGuardians.length ? decidedGuardians.map(g=>guardianNameWithBadgesHtml(ev,g)).join('、') : '未定'}（${decidedGuardians.length}/${ev.dutyTarget||0}人決定）</div>
    </div>
    <div class="section-title">名前を選んで出欠を入力</div>`;
  sortedMembers().forEach(mem=>{
    const st = statusOf(ev.id, mem.id);
    const pillClass = st ? 'pill-'+st.status : 'pill-未';
    const pillText = st ? st.status : '未回答';
    const expanded = uiState.inputExpandedMember===mem.id;
    html += `
    <div class="roster-row">
      <div class="roster-top" onclick="toggleMemberExpand('${mem.id}')">
        <div><span class="member-name">${displayName(mem)}</span><span class="furigana">${escapeHtml(mem.furigana||'')}</span></div>
        <div class="status-pill ${pillClass}">${pillText}</div>
      </div>
      ${expanded ? renderStatusButtons(ev, mem.id, st) : ''}
    </div>`;
  });

  const allGuardians = sortedGuardians();
  if(allGuardians.length){
    html += `<div class="section-title">${dutyLabel(ev.type)}の出欠依頼（保護者の皆さんへ）</div>
    <div class="muted" style="margin-bottom:8px;">対応できる方は ◯（対応可）✕（不可）△（保留）でお知らせください。担当者は管理者が確認のうえ決定します。</div>`;
    allGuardians.forEach(g=>{
      const dst = dutyStatusOf(ev.id, g.id);
      const pillClass = dst ? 'pill-'+dst.status : 'pill-未';
      const pillText = dst ? dst.status : '未回答';
      const expanded = uiState.inputExpandedGuardian===g.id;
      const decided = (ev.dutyGuardianIds||[]).includes(g.id);
      html += `
      <div class="roster-row" style="${decided?'border-color:var(--teal);':''}">
        <div class="roster-top" onclick="toggleGuardianExpand('${g.id}')">
          <div><span class="member-name">${escapeHtml(withSan(g.name))}${decided?' ✅担当':''}</span><span class="furigana">${escapeHtml(guardianChildLabel(g))}</span></div>
          <div class="status-pill ${pillClass}">${pillText}</div>
        </div>
        ${expanded ? renderDutyStatusButtons(ev.id, g.id, dst) : ''}
      </div>`;
    });

    if(isAdmin){
      html += `<div class="admin-only-block">
        <div class="section-title" style="margin-top:0;">🔑 お当番を決定する（管理者のみ）</div>
        <div class="muted" style="margin-bottom:8px;">上の回答を確認して、担当をタップで確定してください（${decidedGuardians.length}/${ev.dutyTarget||0}人）</div>
        <div class="chip-list">
          ${allGuardians.map(g=>{
            const dst = dutyStatusOf(ev.id, g.id);
            const sel = (ev.dutyGuardianIds||[]).includes(g.id);
            const mark = dst ? dst.status : '未';
            return `<div class="chip ${sel?'sel':''}" onclick="toggleFinalDuty('${ev.id}','${g.id}')">${escapeHtml(withSan(g.name))}（${mark}）</div>`;
          }).join('')}
        </div>
        ${decidedGuardians.length ? `
        <div class="section-title" style="margin-top:14px;">🏷️ バッジを設定する（担当が決まった方のみ）</div>
        ${decidedGuardians.map(g=>{
          const codes = guardianBadgesFor(ev, g.id);
          return `<div style="margin-bottom:6px;"><span class="member-name">${escapeHtml(withSan(g.name))}</span><br>
            ${dutyBadges.map(b=>`<span class="badge-toggle ${codes.includes(b.code)?'on':''}" onclick="toggleDutyBadge('${ev.id}','${g.id}','${b.code}')">${escapeHtml(b.code)} ${escapeHtml(b.label)}</span>`).join('')}
          </div>`;
        }).join('')}` : ''}
      </div>`;
    }
  }
  el.innerHTML = html;
}
window.setInputType = function(t){ uiState.inputType=t; uiState.inputSelectedEvent=null; uiState.inputExpandedMember=null; uiState.inputExpandedGuardian=null; renderInput(); }
function renderStatusButtons(ev, memberId, st, source){
  source = source || 'input';
  const cur = st ? st.status : null;
  const note = st ? (st.note||'') : '';
  const gnote = st ? (st.guardianNote||'') : '';
  const symbols = ['◯','✕','遅','早','△'];
  let btns = symbols.map(s=>`<button class="status-btn ${cur===s?'sel-'+s:''}" onclick="event.stopPropagation();setStatus('${ev.id}','${memberId}','${s}','${source}')">${s}</button>`).join('');
  let out = `<div class="status-buttons">${btns}</div>
    <div class="note-label">メモ（連絡事項など）</div>
    <input class="note-input" placeholder="例：18:30到着予定" value="${escapeHtml(note)}" onclick="event.stopPropagation()" oninput="setNote('${ev.id}','${memberId}',this.value)">`;
  if(ev.type==='本番'){
    out += `<div class="note-label">保護者欄（兼任・未就学児の付き添いなど）</div>
    <input class="note-input" placeholder="例：出演と兼任／未就学児の付き添いあり" value="${escapeHtml(gnote)}" onclick="event.stopPropagation()" oninput="setGuardianNote('${ev.id}','${memberId}',this.value)">`;
  }
  return out;
}
function renderDutyStatusButtons(eventId, guardianId, dst){
  const cur = dst ? dst.status : null;
  const note = dst ? (dst.note||'') : '';
  const symbols = ['◯','✕','△'];
  let btns = symbols.map(s=>`<button class="status-btn ${cur===s?'sel-'+s:''}" onclick="event.stopPropagation();setDutyStatus('${eventId}','${guardianId}','${s}')">${s}</button>`).join('');
  return `<div class="status-buttons">${btns}</div>
    <div class="note-label">メモ（連絡事項など）</div>
    <input class="note-input" placeholder="例：18時から遅れて合流します" value="${escapeHtml(note)}" onclick="event.stopPropagation()" oninput="setDutyNote('${eventId}','${guardianId}',this.value)">`;
}
window.selectInputEvent = function(id){ uiState.inputSelectedEvent = id; uiState.inputExpandedMember=null; uiState.inputExpandedGuardian=null; renderInput(); }
window.backToEventList = function(){ uiState.inputSelectedEvent = null; renderInput(); }
window.toggleMemberExpand = function(memberId){ uiState.inputExpandedMember = (uiState.inputExpandedMember===memberId)?null:memberId; uiState.inputExpandedGuardian=null; renderInput(); }
window.toggleGuardianExpand = function(guardianId){ uiState.inputExpandedGuardian = (uiState.inputExpandedGuardian===guardianId)?null:guardianId; uiState.inputExpandedMember=null; renderInput(); }
window.setStatus = async function(eventId, memberId, status, source){
  if(!attendance[eventId]) attendance[eventId] = {};
  const prev = attendance[eventId][memberId] || {};
  attendance[eventId][memberId] = { status, note: prev.note||'', guardianNote: prev.guardianNote||'' };
  await saveAttendance();
  if(source==='overview') renderOverview(); else renderInput();
  showToast('出欠を更新しました');
}
window.setNote = async function(eventId, memberId, note){
  if(!attendance[eventId]) attendance[eventId] = {};
  if(!attendance[eventId][memberId]) attendance[eventId][memberId] = {status:null, note:'', guardianNote:''};
  attendance[eventId][memberId].note = note;
  await saveAttendance();
}
window.setGuardianNote = async function(eventId, memberId, note){
  if(!attendance[eventId]) attendance[eventId] = {};
  if(!attendance[eventId][memberId]) attendance[eventId][memberId] = {status:null, note:'', guardianNote:''};
  attendance[eventId][memberId].guardianNote = note;
  await saveAttendance();
}
window.setDutyStatus = async function(eventId, guardianId, status){
  if(!dutyAttendance[eventId]) dutyAttendance[eventId] = {};
  const prev = dutyAttendance[eventId][guardianId] || {};
  dutyAttendance[eventId][guardianId] = { status, note: prev.note||'' };
  await saveDutyAttendance(); renderInput(); showToast('お当番の出欠を更新しました');
}
window.setDutyNote = async function(eventId, guardianId, note){
  if(!dutyAttendance[eventId]) dutyAttendance[eventId] = {};
  if(!dutyAttendance[eventId][guardianId]) dutyAttendance[eventId][guardianId] = {status:null, note:''};
  dutyAttendance[eventId][guardianId].note = note;
  await saveDutyAttendance();
}
window.toggleFinalDuty = async function(eventId, guardianId){
  const ev = events.find(e=>e.id===eventId);
  if(!ev.dutyGuardianIds) ev.dutyGuardianIds = [];
  const idx = ev.dutyGuardianIds.indexOf(guardianId);
  if(idx>=0) ev.dutyGuardianIds.splice(idx,1); else ev.dutyGuardianIds.push(guardianId);
  await saveEvents(); renderInput();
  showToast('お当番の担当を更新しました');
}
window.toggleDutyBadge = async function(eventId, guardianId, code){
  const ev = events.find(e=>e.id===eventId);
  if(!ev.dutyBadges) ev.dutyBadges = {};
  if(!ev.dutyBadges[guardianId]) ev.dutyBadges[guardianId] = [];
  const idx = ev.dutyBadges[guardianId].indexOf(code);
  if(idx>=0) ev.dutyBadges[guardianId].splice(idx,1); else ev.dutyBadges[guardianId].push(code);
  await saveEvents(); renderInput();
}

/* =========================================================
   出欠調整 (決定した予定の結果を閲覧／お当番出欠依頼欄は自動で非表示)
========================================================= */
function renderOverview(){
  const el = document.getElementById('screen-overview');
  let html = `<div class="segment">
    <div class="seg-btn ${uiState.overviewType==='練習'?'active':''}" onclick="setOverviewType('練習')">練習</div>
    <div class="seg-btn ${uiState.overviewType==='本番'?'active':''}" onclick="setOverviewType('本番')">本番</div>
  </div>`;
  const typeEvents = eventsOfTypeStatus(uiState.overviewType, '決定', false);
  if(typeEvents.length===0){
    html += `<div class="empty"><div class="big">📊</div>決定した${uiState.overviewType}予定はまだありません。<br>募集中のものは「出欠募集中」からご確認ください。</div>`;
    el.innerHTML = html; return;
  }
  if(!uiState.overviewSelectedEvent || !typeEvents.find(e=>e.id===uiState.overviewSelectedEvent)){
    uiState.overviewSelectedEvent = typeEvents[0].id;
  }
  const evOptions = typeEvents.map(ev=>`<option value="${ev.id}" ${ev.id===uiState.overviewSelectedEvent?'selected':''}>${fmtEventWhen(ev)} ${escapeHtml(ev.title)}</option>`).join('');
  const ev = events.find(e=>e.id===uiState.overviewSelectedEvent);
  const decidedGuardians = (ev.dutyGuardianIds||[]).map(id=>guardians.find(g=>g.id===id)).filter(Boolean);

  const attending = [], absent = [], hold = [], noResponse = [];
  sortedMembers().forEach(mem=>{
    const st = statusOf(ev.id, mem.id);
    if(!st || !st.status){ noResponse.push(mem); return; }
    if(st.status==='◯' || st.status==='遅' || st.status==='早'){ attending.push(mem); }
    else if(st.status==='✕'){ absent.push(mem); }
    else if(st.status==='△'){ hold.push(mem); }
  });

  html += `<div class="select-hint"><span class="arrow">▼</span>ここをタップして他の予定に切り替え</div>`;
  html += `<select class="event-select" onchange="uiState.overviewSelectedEvent=this.value; renderOverview()">${evOptions}</select>`;
  html += `<div class="card">
    <span class="event-date">${fmtEventWhen(ev)}</span><span class="event-type ${ev.type}">${ev.type}</span>
    <h3>${escapeHtml(ev.title)}</h3>
    <div class="muted">📍 ${escapeHtml(ev.location||'未設定')}</div>
    <div class="muted">🎽 ${dutyLabel(ev.type)}：${decidedGuardians.length ? decidedGuardians.map(g=>guardianNameWithBadgesHtml(ev,g)).join('、') : '未定'}</div>
  </div>`;
  html += `
    <div class="scoreboard">
      <div class="score-label">出席予定 / 全体</div>
      <div class="score-num">${attending.length}<span> / ${members.length}</span></div>
    </div>`;
  const overviewRow = (mem, numberPrefix)=>{
    const st = statusOf(ev.id, mem.id);
    const pillClass = st ? 'pill-'+st.status : 'pill-未';
    const pillText = st ? st.status : '未回答';
    const expanded = uiState.overviewExpandedMember===mem.id;
    const noteBits = [];
    if(st && st.note) noteBits.push(escapeHtml(st.note));
    if(st && st.guardianNote) noteBits.push('保護者欄：'+escapeHtml(st.guardianNote));
    return `<div class="roster-row">
      <div class="roster-top" onclick="toggleOverviewExpand('${mem.id}')">
        <div><span class="member-name">${numberPrefix||''}${displayName(mem)}</span>${noteBits.length?`<div class="muted">${noteBits.join(' ／ ')}</div>`:''}</div>
        <div class="status-pill ${pillClass}">${pillText}</div>
      </div>
      ${expanded ? renderStatusButtons(ev, mem.id, st, 'overview') : ''}
    </div>`;
  };
  html += `<div class="group-title">出席者（${attending.length}名）</div>`;
  html += attending.length ? attending.map((m,i)=>overviewRow(m, `${i+1}. `)).join('') : `<div class="namelist muted">該当者なし</div>`;
  html += `<div class="group-title">欠席者（${absent.length}名）</div>`;
  html += absent.length ? absent.map(m=>overviewRow(m)).join('') : `<div class="namelist muted">該当者なし</div>`;
  html += `<div class="group-title">保留（${hold.length}名）</div>`;
  html += hold.length ? hold.map(m=>overviewRow(m)).join('') : `<div class="namelist muted">該当者なし</div>`;
  html += `<div class="group-title">未回答者（${noResponse.length}名）</div>`;
  html += noResponse.length ? noResponse.map(m=>overviewRow(m)).join('') : `<div class="namelist warn muted">全員回答済みです</div>`;
  html += `<div class="muted" style="margin-top:10px;">※名前をタップすると出欠・メモを修正できます</div>`;
  el.innerHTML = html;
}
window.setOverviewType = function(t){ uiState.overviewType=t; uiState.overviewSelectedEvent=null; renderOverview(); }
window.toggleOverviewExpand = function(memberId){ uiState.overviewExpandedMember = (uiState.overviewExpandedMember===memberId)?null:memberId; renderOverview(); }

/* =========================================================
   管理者
========================================================= */
function renderAdmin(){
  const el = document.getElementById('screen-admin');
  let html = `<div class="card" style="background:var(--lemon-pale);border-style:dashed;">
      <div style="font-size:12.5px;">現在 <b>管理者モード</b> です。</div>
    </div>
    <div class="segment sub">
      <div class="seg-btn ${uiState.adminSubTab==='events'?'active':''}" onclick="setAdminSubTab('events')">イベント</div>
      <div class="seg-btn ${uiState.adminSubTab==='duty'?'active':''}" onclick="setAdminSubTab('duty')">当番集計</div>
      <div class="seg-btn ${uiState.adminSubTab==='fy'?'active':''}" onclick="setAdminSubTab('fy')">年度管理</div>
      <div class="seg-btn ${uiState.adminSubTab==='members'?'active':''}" onclick="setAdminSubTab('members')">名簿</div>
      <div class="seg-btn ${uiState.adminSubTab==='settings'?'active':''}" onclick="setAdminSubTab('settings')">設定</div>
    </div>`;
  if(uiState.adminSubTab==='events') html += adminEventsHtml();
  if(uiState.adminSubTab==='duty') html += dutyDashboardHtml();
  if(uiState.adminSubTab==='fy') html += adminFiscalYearHtml();
  if(uiState.adminSubTab==='members') html += adminMembersHtml() + adminGuardiansHtml();
  if(uiState.adminSubTab==='settings') html += adminSettingsHtml();
  el.innerHTML = html;
}
window.setAdminSubTab = function(t){ uiState.adminSubTab=t; renderAdmin(); }
function adminSettingsHtml(){
  let html = adminLocationsHtml();
  html += adminDutyBadgesHtml();
  html += `<div class="section-title">管理者パスコード変更</div>
    <div class="card">
      <div class="field"><label>新しいパスコード</label><input id="newPasscode" placeholder="半角数字など"></div>
      <button class="btn btn-ghost btn-block" onclick="changePasscode()">パスコードを更新</button>
    </div>`;
  return html;
}

function adminMembersHtml(){
  let html = `<div class="section-title">名簿管理（学年→入連日順で自動並び替え）</div>
    <div class="card">
      <div class="field"><label>名前</label><input id="mName" placeholder="例：天狗花子"></div>
      <div class="field"><label>ふりがな</label><input id="mFuri" placeholder="例：てんぐはなこ"></div>
      <div class="field"><label>学年（表示用）</label><input id="mGrade" placeholder="例：年長、1年、5年"></div>
      <div class="field"><label>学年数値（0以下で ◉ が付きます。年長=0、未就学=-1 など）</label><input id="mGradeVal" type="number" placeholder="例：5"></div>
      <div class="field"><label>入連日（年月のみ。同学年内の並び順に使用）</label><input id="mJoinDate" type="month"></div>
      <button class="btn btn-primary btn-block" onclick="addMember()">＋ メンバーを追加</button>
    </div>`;
  if(members.length){
    html += `<div class="card">`;
    sortedMembers().forEach(m=>{
      const isEditing = uiState.adminEditingMember===m.id;
      html += `<div class="list-item" onclick="toggleEditMember('${m.id}')" style="flex-direction:column;align-items:stretch;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div><span class="member-name">${displayName(m)}</span><br><span class="muted">${escapeHtml(m.grade||'')}${m.joinDate?(' ・入連 '+escapeHtml(m.joinDate)):''}</span></div>
          <button onclick="event.stopPropagation();deleteMember('${m.id}')" style="color:var(--coral);background:none;border:none;cursor:pointer;font-size:16px;">✕</button>
        </div>
        ${isEditing ? renderMemberEditPanel(m) : ''}
      </div>`;
    });
    html += `</div>`;
  }
  return html;
}
function renderMemberEditPanel(m){
  return `<div class="edit-panel" onclick="event.stopPropagation()">
    <div class="field"><label>名前</label><input id="editMName_${m.id}" value="${escapeHtml(m.name)}"></div>
    <div class="field"><label>ふりがな</label><input id="editMFuri_${m.id}" value="${escapeHtml(m.furigana||'')}"></div>
    <div class="field"><label>学年（表示用）</label><input id="editMGrade_${m.id}" value="${escapeHtml(m.grade||'')}"></div>
    <div class="field"><label>学年数値</label><input id="editMGradeVal_${m.id}" type="number" value="${m.gradeValue}"></div>
    <div class="field"><label>入連日（年月）</label><input id="editMJoinDate_${m.id}" type="month" value="${m.joinDate||''}"></div>
    <button class="btn btn-primary btn-block" onclick="saveMemberEdit('${m.id}')">保存する</button>
  </div>`;
}
window.toggleEditMember = function(id){ uiState.adminEditingMember = (uiState.adminEditingMember===id)?null:id; renderAdmin(); }
window.saveMemberEdit = async function(id){
  const m = members.find(x=>x.id===id);
  m.name = document.getElementById('editMName_'+id).value.trim();
  m.furigana = document.getElementById('editMFuri_'+id).value.trim();
  m.grade = document.getElementById('editMGrade_'+id).value.trim();
  const gv = parseFloat(document.getElementById('editMGradeVal_'+id).value);
  m.gradeValue = isNaN(gv) ? 0 : gv;
  m.joinDate = document.getElementById('editMJoinDate_'+id).value;
  await saveMembers();
  uiState.adminEditingMember = null;
  renderAdmin(); renderInput(); renderOverview();
  showToast('メンバー情報を更新しました');
}

let newGuardianDraft = { memberIds: [] };
function adminGuardiansHtml(){
  let html = `<div class="section-title">保護者名簿管理（表示名の末尾に自動で「さん」がつきます）</div>
    <div class="card">
      <div class="field"><label>保護者名</label><input id="gName" placeholder="例：竹本花"></div>
      <div class="field"><label>お子さん（兄弟姉妹がいる場合は複数選択できます）</label>
        <div class="chip-list" id="newGuardianChips">${sortedMembers().map(m=>`<div class="chip ${newGuardianDraft.memberIds.includes(m.id)?'sel':''}" onclick="toggleNewGuardianChip('${m.id}', this)">${plainDisplayName(m)}</div>`).join('') || '<span class="muted">先にメンバーを登録してください</span>'}</div>
      </div>
      <button class="btn btn-primary btn-block" onclick="addGuardian()">＋ 保護者を追加</button>
    </div>`;
  if(guardians.length){
    html += `<div class="card">`;
    sortedGuardians().forEach(g=>{
      const isEditing = uiState.adminEditingGuardian===g.id;
      html += `<div class="list-item" onclick="toggleEditGuardian('${g.id}')" style="flex-direction:column;align-items:stretch;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div><b>${escapeHtml(withSan(g.name))}</b><br><span class="muted">${escapeHtml(guardianChildLabel(g))}</span></div>
          <button onclick="event.stopPropagation();deleteGuardian('${g.id}')" style="color:var(--coral);background:none;border:none;cursor:pointer;font-size:16px;">✕</button>
        </div>
        ${isEditing ? renderGuardianEditPanel(g) : ''}
      </div>`;
    });
    html += `</div>`;
  }
  return html;
}
function renderGuardianEditPanel(g){
  const ids = guardianMemberIds(g);
  return `<div class="edit-panel" onclick="event.stopPropagation()">
    <div class="field"><label>保護者名</label><input id="editGName_${g.id}" value="${escapeHtml(g.name)}"></div>
    <div class="field"><label>お子さん（複数選択可）</label>
      <div class="chip-list" id="editGuardianChips_${g.id}">${sortedMembers().map(m=>`<div class="chip ${ids.includes(m.id)?'sel':''}" data-id="${m.id}" onclick="toggleEditGuardianChip(this)">${plainDisplayName(m)}</div>`).join('')}</div>
    </div>
    <button class="btn btn-primary btn-block" onclick="saveGuardianEdit('${g.id}')">保存する</button>
  </div>`;
}
window.toggleNewGuardianChip = function(memberId, chipEl){
  const idx = newGuardianDraft.memberIds.indexOf(memberId);
  if(idx>=0) newGuardianDraft.memberIds.splice(idx,1); else newGuardianDraft.memberIds.push(memberId);
  chipEl.classList.toggle('sel');
}
window.toggleEditGuardianChip = function(chipEl){ chipEl.classList.toggle('sel'); }
window.toggleEditGuardian = function(id){ uiState.adminEditingGuardian = (uiState.adminEditingGuardian===id)?null:id; renderAdmin(); }
window.saveGuardianEdit = async function(id){
  const g = guardians.find(x=>x.id===id);
  g.name = document.getElementById('editGName_'+id).value.trim();
  g.memberIds = Array.from(document.querySelectorAll(`#editGuardianChips_${id} .chip.sel`)).map(c=>c.dataset.id);
  await saveGuardians();
  uiState.adminEditingGuardian = null;
  renderAdmin(); renderInput(); renderOverview();
  showToast('保護者情報を更新しました');
}
function adminDutyBadgesHtml(){
  let html = `<div class="section-title">当番バッジ管理（未就学児保護者・兼任などの識別タグ。追加可能）</div>
    <div class="card">
      <div class="field"><label>バッジ記号（1〜2文字）</label><input id="newBadgeCode" placeholder="例：新" maxlength="2"></div>
      <div class="field"><label>バッジの意味</label><input id="newBadgeLabel" placeholder="例：新規入連の保護者"></div>
      <button class="btn btn-primary btn-block" onclick="addDutyBadge()">＋ バッジを追加</button>
    </div>`;
  if(dutyBadges.length){
    html += `<div class="card">`;
    dutyBadges.forEach(b=>{
      html += `<div class="list-item" style="cursor:default;">
        <div><span class="badge-tag">${escapeHtml(b.code)}</span> ${escapeHtml(b.label)}</div>
        <button onclick="deleteDutyBadge('${b.code}')" style="color:var(--coral);background:none;border:none;cursor:pointer;font-size:16px;">✕</button>
      </div>`;
    });
    html += `</div>`;
  }
  return html;
}
window.addDutyBadge = async function(){
  const code = document.getElementById('newBadgeCode').value.trim();
  const label = document.getElementById('newBadgeLabel').value.trim();
  if(!code || !label){ showToast('記号と意味を入力してください'); return; }
  if(dutyBadges.some(b=>b.code===code)){ showToast('その記号はすでに使われています'); return; }
  dutyBadges.push({ code, label });
  await saveDutyBadges();
  renderAdmin(); renderInput();
  showToast('バッジを追加しました');
}
window.deleteDutyBadge = async function(code){
  dutyBadges = dutyBadges.filter(b=>b.code!==code);
  events.forEach(ev=>{ if(ev.dutyBadges){ Object.keys(ev.dutyBadges).forEach(gid=>{ ev.dutyBadges[gid] = ev.dutyBadges[gid].filter(c=>c!==code); }); } });
  await saveDutyBadges(); await saveEvents();
  renderAdmin(); renderInput();
  showToast('削除しました');
}
function adminLocationsHtml(){
  let html = `<div class="section-title">場所リスト管理（あらかじめ登録しておくとプルダウンで選べます）</div>
    <div class="card">
      <div class="field"><label>場所を追加</label><input id="newLocationName" placeholder="例：座・高円寺　阿波踊りホール"></div>
      <button class="btn btn-primary btn-block" onclick="addLocation()">＋ 場所を追加</button>
    </div>`;
  if(locations.length){
    html += `<div class="card">`;
    locations.forEach(l=>{
      html += `<div class="list-item" style="cursor:default;">
        <div>📍 ${escapeHtml(l.name)}</div>
        <button onclick="deleteLocation('${l.id}')" style="color:var(--coral);background:none;border:none;cursor:pointer;font-size:16px;">✕</button>
      </div>`;
    });
    html += `</div>`;
  }
  return html;
}
window.addLocation = async function(){
  const name = document.getElementById('newLocationName').value.trim();
  if(!name){ showToast('場所名を入力してください'); return; }
  if(locations.some(l=>l.name===name)){ showToast('すでに登録されています'); return; }
  locations.push({ id: uid('loc'), name });
  await saveLocations();
  renderAdmin();
  showToast('場所を追加しました');
}
window.deleteLocation = async function(id){
  locations = locations.filter(l=>l.id!==id);
  await saveLocations();
  renderAdmin();
  showToast('削除しました');
}
function adminEventsHtml(){
  let html = `<div class="section-title">イベント作成（お当番の担当決定は「出欠募集中」ページで行います）</div>
    <div class="card">
      <div class="field"><label>日付・開始時間</label><input id="eDate" type="datetime-local"></div>
      <div class="field"><label>終了時間</label><input id="eEndTime" type="time"></div>
      <div class="field"><label>タイトル</label><input id="eTitle" placeholder="例：全体練習"></div>
      <div class="field"><label>場所</label>${locationFieldHtml('new','')}</div>
      <div class="field"><label>種別</label><select id="eType" onchange="setNewEventType(this.value)">
        <option value="練習" ${newEventDraft.type!=='本番'?'selected':''}>練習</option>
        <option value="本番" ${newEventDraft.type==='本番'?'selected':''}>本番</option>
      </select></div>
      <div class="field"><label>${dutyLabel(newEventDraft.type)}の必要人数</label>
        <div class="counter-row">
          <button class="counter-btn" onclick="changeNewDutyTarget(-1)">－</button>
          <div class="counter-val">${newEventDraft.dutyTarget}</div>
          <button class="counter-btn" onclick="changeNewDutyTarget(1)">＋</button>
        </div>
      </div>
      <button class="btn btn-primary btn-block" onclick="addEvent()">＋ イベントを追加（募集中で作成）</button>
    </div>`;
  html += `<div class="section-title">イベント一覧（日付が近い順）</div>`;
  if(events.length){
    html += `<div class="card">`;
    [...events].sort((a,b)=> new Date(a.date)-new Date(b.date)).forEach(ev=>{
      const isEditing = uiState.adminEditingEvent===ev.id;
      const assigned = (ev.dutyGuardianIds||[]).map(id=>guardians.find(g=>g.id===id)).filter(Boolean);
      const past = !isNotPast(ev.date);
      const fyLocked = isPastOrArchivedFY(fiscalYearOf(ev.date));
      if(fyLocked){
        html += `<div class="list-item" style="flex-direction:column;align-items:stretch;opacity:.55;cursor:default;">
          <div><span class="event-date">${fmtEventWhen(ev)}</span><span class="event-type ${ev.type}">${ev.type}</span><span class="status-tag ${ev.status}">${ev.status}</span><br><b>${escapeHtml(ev.title)}</b><br><span class="muted">📍${escapeHtml(ev.location||'未設定')} ／ 🔒 閲覧専用（年度確定済み）</span></div>
        </div>`;
        return;
      }
      html += `<div class="list-item" onclick="toggleEditEvent('${ev.id}')" style="flex-direction:column;align-items:stretch;${past?'opacity:.55;':''}">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div><span class="event-date">${fmtEventWhen(ev)}</span><span class="event-type ${ev.type}">${ev.type}</span><span class="status-tag ${ev.status}">${ev.status}</span><br><b>${escapeHtml(ev.title)}</b><br><span class="muted">📍${escapeHtml(ev.location||'未設定')} ／ ${dutyLabel(ev.type)} ${assigned.length}/${ev.dutyTarget||0}人${past?'（表示期間終了）':''}</span></div>
          <button onclick="event.stopPropagation();deleteEvent('${ev.id}')" style="color:var(--coral);background:none;border:none;cursor:pointer;font-size:16px;">✕</button>
        </div>
        ${isEditing ? renderEventEditPanel(ev) : ''}
      </div>`;
    });
    html += `</div>`;
  }
  return html;
}
function renderEventEditPanel(ev){
  return `<div class="edit-panel" onclick="event.stopPropagation()">
    <div class="field"><label>日付・開始時間</label><input id="editDate_${ev.id}" type="datetime-local" value="${ev.date}"></div>
    <div class="field"><label>終了時間</label><input id="editEndTime_${ev.id}" type="time" value="${ev.endTime||''}"></div>
    <div class="field"><label>タイトル</label><input id="editTitle_${ev.id}" value="${escapeHtml(ev.title)}" placeholder="例：全体練習"></div>
    <div class="field"><label>場所</label>${locationFieldHtml(ev.id, ev.location||'')}</div>
    <div class="field"><label>状態</label>
      <button class="btn ${ev.status==='募集中'?'btn-primary':'btn-ghost'} btn-sm" onclick="setEventStatus('${ev.id}','募集中')">募集中</button>
      <button class="btn ${ev.status==='決定'?'btn-primary':'btn-ghost'} btn-sm" onclick="setEventStatus('${ev.id}','決定')">決定</button>
    </div>
    <div class="field"><label>${dutyLabel(ev.type)}の必要人数</label>
      <div class="counter-row">
        <button class="counter-btn" onclick="changeEditDutyTarget('${ev.id}',-1)">－</button>
        <div class="counter-val" id="editDutyVal_${ev.id}">${ev.dutyTarget||0}</div>
        <button class="counter-btn" onclick="changeEditDutyTarget('${ev.id}',1)">＋</button>
      </div>
      <div class="muted">担当者の決定は「出欠募集中」ページ（管理者モード）で行えます。</div>
    </div>
    <button class="btn btn-primary btn-block" onclick="saveEventEdit('${ev.id}')">保存する</button>
  </div>`;
}
window.setEventStatus = function(eventId, status){ const ev = events.find(e=>e.id===eventId); ev._draftStatus = status; renderAdmin(); }
window.toggleEditEvent = function(id){ uiState.adminEditingEvent = (uiState.adminEditingEvent===id)?null:id; renderAdmin(); }
window.changeEditDutyTarget = function(eventId, delta){
  const ev = events.find(e=>e.id===eventId);
  ev._draftTarget = (ev._draftTarget===undefined ? (ev.dutyTarget||0) : ev._draftTarget) + delta;
  if(ev._draftTarget < 0) ev._draftTarget = 0;
  document.getElementById('editDutyVal_'+eventId).textContent = ev._draftTarget;
}
window.saveEventEdit = async function(eventId){
  const ev = events.find(e=>e.id===eventId);
  ev.date = document.getElementById('editDate_'+eventId).value;
  ev.endTime = document.getElementById('editEndTime_'+eventId).value;
  ev.title = document.getElementById('editTitle_'+eventId).value.trim();
  ev.location = getLocationValue(eventId);
  ev.dutyTarget = ev._draftTarget!==undefined ? ev._draftTarget : (ev.dutyTarget||0);
  ev.status = ev._draftStatus || ev.status || '募集中';
  delete ev._draftTarget; delete ev._draftStatus;
  await saveEvents();
  uiState.adminEditingEvent = null;
  renderAdmin(); renderInput(); renderOverview();
  showToast('イベントを更新しました');
}
window.changeNewDutyTarget = function(delta){ newEventDraft.dutyTarget = Math.max(0, newEventDraft.dutyTarget + delta); renderAdmin(); }
window.setNewEventType = function(t){
  newEventDraft.type = t;
  // 練習は通常1人、本番は複数人（10人以上）を想定した初期値。+/-で自由に調整可能。
  newEventDraft.dutyTarget = (t==='本番') ? 10 : 1;
  renderAdmin();
}
window.addMember = async function(){
  const name = document.getElementById('mName').value.trim();
  const furi = document.getElementById('mFuri').value.trim();
  const grade = document.getElementById('mGrade').value.trim();
  const gv = parseFloat(document.getElementById('mGradeVal').value);
  const joinDate = document.getElementById('mJoinDate').value;
  if(!name){ showToast('名前を入力してください'); return; }
  members.push({ id: uid('mem'), name, furigana: furi, grade, gradeValue: isNaN(gv)?0:gv, joinDate });
  await saveMembers();
  renderAdmin(); renderInput(); renderOverview();
  showToast('メンバーを追加しました');
}
window.deleteMember = async function(id){
  members = members.filter(m=>m.id!==id);
  guardians.forEach(g=>{ g.memberIds = guardianMemberIds(g).filter(mid=>mid!==id); });
  guardians = guardians.filter(g=>guardianMemberIds(g).length>0);
  await saveMembers(); await saveGuardians();
  renderAdmin(); renderInput(); renderOverview();
  showToast('削除しました');
}
window.addGuardian = async function(){
  const name = document.getElementById('gName').value.trim();
  const memberIds = [...newGuardianDraft.memberIds];
  if(!name || memberIds.length===0){ showToast('保護者名とお子さんを選択してください'); return; }
  guardians.push({ id: uid('gd'), name, memberIds });
  await saveGuardians();
  newGuardianDraft = { memberIds: [] };
  renderAdmin(); renderInput(); renderOverview();
  showToast('保護者を追加しました');
}
window.deleteGuardian = async function(id){
  guardians = guardians.filter(g=>g.id!==id);
  events.forEach(ev=>{
    if(ev.dutyGuardianIds) ev.dutyGuardianIds = ev.dutyGuardianIds.filter(gid=>gid!==id);
    if(ev.dutyBadges) delete ev.dutyBadges[id];
  });
  await saveGuardians(); await saveEvents();
  renderAdmin(); renderInput(); renderOverview();
  showToast('削除しました');
}
window.addEvent = async function(){
  const date = document.getElementById('eDate').value;
  const endTime = document.getElementById('eEndTime').value;
  const title = document.getElementById('eTitle').value.trim();
  const location = getLocationValue('new');
  const type = document.getElementById('eType').value;
  if(!date || !title){ showToast('日時とタイトルを入力してください'); return; }
  events.push({ id: uid('evt'), date, endTime, title, location, type, status:'募集中', dutyTarget: newEventDraft.dutyTarget, dutyGuardianIds: [], dutyBadges: {} });
  await saveEvents();
  newEventDraft = { dutyTarget: 1, type: '練習' };
  renderAdmin(); renderInput(); renderOverview();
  showToast('イベントを追加しました');
}
window.deleteEvent = async function(id){
  events = events.filter(e=>e.id!==id);
  delete attendance[id]; delete dutyAttendance[id];
  await saveEvents(); await saveAttendance(); await saveDutyAttendance();
  renderAdmin(); renderInput(); renderOverview();
  showToast('削除しました');
}
window.changePasscode = async function(){
  const val = document.getElementById('newPasscode').value.trim();
  if(!val){ showToast('新しいパスコードを入力してください'); return; }
  adminPasscode = val; await savePasscode();
  document.getElementById('newPasscode').value='';
  showToast('パスコードを更新しました');
}

/* =========================================================
   年度管理（アーカイブ／エクスポート／年度コピー）
   過去年度・アーカイブ済み年度は isPastOrArchivedFY() で
   イベント編集画面から自動的に閲覧専用になります。
========================================================= */
function adminFiscalYearHtml(){
  const years = [...new Set([...availableFiscalYears(), currentFiscalYear()])].sort((a,b)=>b-a);
  if(uiState.fyManageYear===null || !years.includes(uiState.fyManageYear)) uiState.fyManageYear = years[0];
  const fy = uiState.fyManageYear;
  const archived = archivedFiscalYears.includes(fy);
  const isPast = fy < currentFiscalYear();
  const fyOptions = years.map(y=>`<option value="${y}" ${y===fy?'selected':''}>${y}年度（${y}/4〜${y+1}/3）</option>`).join('');
  return `<div class="section-title">年度管理</div>
    <div class="card">
      <div class="field"><label>対象年度</label><select class="fy-select" style="width:100%;" onchange="uiState.fyManageYear=parseInt(this.value); renderAdmin()">${fyOptions}</select></div>
      <div class="muted" style="margin-bottom:12px;">${archived?'🔒 アーカイブ済み（この年度のイベントは編集できません）':(isPast?'過去の年度です':'進行中の年度です')}</div>
      ${archived
        ? `<button class="btn btn-ghost btn-block" onclick="unarchiveFiscalYear(${fy})">アーカイブを解除する</button>`
        : `<button class="btn btn-primary btn-block" onclick="archiveFiscalYear(${fy})">この年度をアーカイブする（閲覧専用にする）</button>`}
      <div style="height:10px;"></div>
      <button class="btn btn-ghost btn-block" onclick="exportFYCsv(${fy})">📄 CSVをダウンロード</button>
      <div style="height:8px;"></div>
      <button class="btn btn-ghost btn-block" onclick="exportFYExcel(${fy})">📊 Excel（.xlsx）をダウンロード</button>
      <div style="height:10px;"></div>
      <button class="btn btn-lemon btn-block" onclick="copyFiscalYearForward(${fy})">🔁 この年度の予定を翌年度にコピー</button>
      <div class="muted" style="margin-top:6px;">タイトル・場所・種別・必要人数を引き継ぎ、日付を1年ずらして「募集中」の新しい予定として作成します（出欠・お当番の決定内容は引き継ぎません）。</div>
    </div>`;
}
window.archiveFiscalYear = async function(fy){
  const snapshot = { events: events.filter(ev=>fiscalYearOf(ev.date)===fy), attendance: {}, dutyAttendance: {} };
  snapshot.events.forEach(ev=>{
    if(attendance[ev.id]) snapshot.attendance[ev.id] = attendance[ev.id];
    if(dutyAttendance[ev.id]) snapshot.dutyAttendance[ev.id] = dutyAttendance[ev.id];
  });
  await DataStore.set('archive_fy_'+fy, snapshot);
  if(!archivedFiscalYears.includes(fy)) archivedFiscalYears.push(fy);
  await saveArchivedFiscalYears();
  renderAdmin();
  showToast(fy+'年度をアーカイブしました（閲覧専用になります）');
}
window.unarchiveFiscalYear = async function(fy){
  archivedFiscalYears = archivedFiscalYears.filter(y=>y!==fy);
  await saveArchivedFiscalYears();
  renderAdmin();
  showToast(fy+'年度のアーカイブを解除しました');
}
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function buildFYExportRows(fy){
  const rows = [['日付','種別','タイトル','場所','名前','出欠','メモ']];
  events.filter(ev=>fiscalYearOf(ev.date)===fy).sort((a,b)=>new Date(a.date)-new Date(b.date)).forEach(ev=>{
    sortedMembers().forEach(m=>{
      const st = statusOf(ev.id, m.id);
      rows.push([fmtEventWhen(ev), ev.type, ev.title, ev.location||'', plainDisplayName(m), st?st.status:'未回答', st?(st.note||''):'']);
    });
  });
  return rows;
}
window.exportFYCsv = function(fy){
  const rows = buildFYExportRows(fy);
  const csv = rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');
  downloadBlob(new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'}), `TENKO_${fy}年度.csv`);
}
window.exportFYExcel = function(fy){
  if(typeof XLSX === 'undefined'){ showToast('Excel出力の準備中です。少し待ってから再度お試しください'); return; }
  const ws = XLSX.utils.aoa_to_sheet(buildFYExportRows(fy));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, fy+'年度');
  XLSX.writeFile(wb, `TENKO_${fy}年度.xlsx`);
}
window.copyFiscalYearForward = async function(fy){
  const shifted = events.filter(ev=>fiscalYearOf(ev.date)===fy).map(ev=>({
    id: uid('evt'), date: shiftYearInDateTimeLocal(ev.date,1), endTime: ev.endTime,
    title: ev.title, location: ev.location, type: ev.type, status:'募集中',
    dutyTarget: ev.dutyTarget, dutyGuardianIds: [], dutyBadges: {}
  }));
  if(shifted.length===0){ showToast('コピー対象のイベントがありません'); return; }
  events = events.concat(shifted);
  await saveEvents();
  renderAdmin(); renderInput(); renderOverview();
  showToast(`${shifted.length}件のイベントを翌年度にコピーしました`);
}

/* =========================================================
   当番集計（練習/本番で分けて、月別＋4月始まり年度計）
========================================================= */
function availableFiscalYears(){ const years = new Set(); events.forEach(ev=> years.add(fiscalYearOf(ev.date))); return [...years].sort((a,b)=>b-a); }
function dutyDashboardHtml(){
  if(members.length===0) return `<div class="empty"><div class="big">🎽</div>メンバーを登録すると<br>お当番集計が表示されます。</div>`;
  let html = `<div class="segment">
    <div class="seg-btn ${uiState.dutyType==='練習'?'active':''}" onclick="setDutyType('練習')">練習（見守り当番）</div>
    <div class="seg-btn ${uiState.dutyType==='本番'?'active':''}" onclick="setDutyType('本番')">本番（付添保護者）</div>
  </div>`;
  const years = availableFiscalYears();
  if(years.length===0) return html + `<div class="empty"><div class="big">📭</div>イベントがまだ登録されていません。</div>`;
  if(uiState.dutyFY===null || !years.includes(uiState.dutyFY)) uiState.dutyFY = years[0];
  const fyOptions = years.map(y=>`<option value="${y}" ${y===uiState.dutyFY?'selected':''}>${y}年度（${y}/4〜${y+1}/3）</option>`).join('');
  html += `<div class="fy-row">
    <div class="section-title" style="margin:0;">${dutyLabel(uiState.dutyType)}（担当決定分のみ集計）</div>
    <select class="fy-select" onchange="uiState.dutyFY=parseInt(this.value); renderAdmin()">${fyOptions}</select>
  </div>`;
  const roster = sortedMembers();
  const matrix = {}; roster.forEach(m=> matrix[m.id] = new Array(12).fill(0));
  events.filter(ev=> ev.type===uiState.dutyType && fiscalYearOf(ev.date)===uiState.dutyFY).forEach(ev=>{
    const idx = monthIndexInFY(ev.date);
    (ev.dutyGuardianIds||[]).forEach(gid=>{ const g = guardians.find(x=>x.id===gid); if(g){ guardianMemberIds(g).forEach(mid=>{ if(matrix[mid]) matrix[mid][idx]++; }); } });
  });
  const totals = roster.map(m=> matrix[m.id].reduce((a,b)=>a+b,0));
  const minTotal = Math.min(...totals);
  html += `<div class="duty-scroll"><table class="duty2">
    <thead><tr><th class="name-col">名前</th>${FY_MONTH_ORDER.map(m=>`<th>${m}月</th>`).join('')}<th>年度計</th></tr></thead><tbody>`;
  roster.forEach((m,i)=>{
    html += `<tr><td class="name-col">${displayName(m)}</td>`;
    matrix[m.id].forEach(c=>{ html += `<td>${c||''}</td>`; });
    html += `<td class="total-col ${totals[i]===minTotal?'duty-low':''}">${totals[i]}</td></tr>`;
  });
  html += `</tbody></table></div>`;
  html += `<div class="muted">※「出欠募集中」ページで担当を決定するとここに反映されます。赤字は当該年度で回数が最も少ないご家庭です。</div>`;
  return html;
}
window.setDutyType = function(t){ uiState.dutyType=t; renderAdmin(); }

/* =========================================================
   INIT
========================================================= */
initRealtimeSync();

// PWA: サービスワーカーを登録（対応ブラウザのみ）
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('./sw.js').catch(err=>console.error('SW registration failed', err));
  });
}
