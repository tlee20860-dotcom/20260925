/* ============================================================================
 * auth.js — 認證模組 + 帳號管理 + 入口門禁（v8.3）
 * v8.3：移除訪客 + 帳號 Tab 顯示 + 登出回入口 + 嚴格登入門禁
 * ========================================================================== */
(function(){
'use strict';

window.SLG = window.SLG || {};

const {
  state, emit, EVT,
  uid, esc, logSystem,
  ROLE, ROLE_LABELS, ROLE_CLASS, ROLE_ORDER,
  saveState, updateModeBar,
} = window.SLG;

const getDb = () => window.SLG.getDb();

/* ============================================================
   Auth 模組
   ============================================================ */
const Auth = (() => {
  let authReady = false;
  let authUid = '';

  function getAnonAuthUid(){ return authUid; }

  async function initFirebaseAuth(){
    if(!window.SLG.getApp || !window.SLG.getApp()) return false;
    try{
      const auth = firebase.auth();
      if(auth.currentUser){
        authUid = auth.currentUser.uid;
        authReady = true;
        logSystem('🔐 匿名 Auth 已就緒（' + authUid.slice(0,8) + '...）');
        return true;
      }
      const cred = await auth.signInAnonymously();
      authUid = cred.user.uid;
      authReady = true;
      logSystem('🔐 匿名 Auth 建立成功（' + authUid.slice(0,8) + '...）');
      return true;
    }catch(e){
      console.warn('匿名 Auth 失敗', e);
      emit(EVT.DEBUG, {msg:'❌ 匿名登入失敗：' + e.message + '（請確認 Console 已開啟 Anonymous 登入）', err:true});
      return false;
    }
  }

  function accountRef(uid){
    return getDb().ref(`accounts/${uid}`);
  }

  async function findAccountByUsername(username){
    try{
      const snap = await getDb().ref('accounts').once('value');
      const all = snap.val() || {};
      for(const uid in all){
        const a = all[uid];
        if(a && a.username === username) return { uid, data: a };
      }
      return null;
    }catch(e){
      console.error('[Auth] 讀取 accounts 失敗', e.code, e.message);
      if(e.code === 'PERMISSION_DENIED' || /permission/i.test(e.message || '')){
        throw new Error('⚠️ 資料庫規則拒絕讀取，請檢查 RTDB Rules 是否已「發布」');
      }
      throw new Error('讀取帳號失敗：' + (e.message || e.code));
    }
  }

  async function login(username, password){
    if(!username || !password){ throw new Error('請輸入帳號與密碼'); }
    if(!getDb()){ throw new Error('Firebase 尚未就緒，請稍後再試'); }

    const found = await findAccountByUsername(username);
    if(!found){ throw new Error('帳號不存在'); }
    if(found.data.password !== password){ throw new Error('密碼錯誤'); }
    if(found.data.status === 'suspended'){ throw new Error('此帳號已停用，請聯繫管理員'); }
    if(found.data.status === 'pending'){ throw new Error('此帳號尚未啟用'); }

    try{
      await accountRef(found.uid).update({ lastLoginAt: Date.now() });
    }catch(e){ /* 忽略 */ }

    setSession(found.uid, found.data);
    localStorage.setItem(window.SLG.ACCOUNT_UID_KEY, found.uid);
    logSystem(`✅ ${found.data.displayName} 登入成功`);

    /* ★ v8.2：登入後載入個人雲端沙盤 */
    try{
      await window.SLG.loadMySandbox();
    }catch(e){
      console.warn('載入雲端沙盤失敗', e);
    }

    return found.data;
  }

  async function register(username, displayName, password, password2){
    if(!username || !displayName || !password){ throw new Error('請填寫所有欄位'); }
    if(username.length < 3){ throw new Error('帳號至少 3 字元'); }
    if(!/^[a-zA-Z0-9_]+$/.test(username)){ throw new Error('帳號只能使用英文、數字、底線'); }
    if(displayName.length > 12){ throw new Error('顯示名稱最多 12 字'); }
    if(password.length < 4){ throw new Error('密碼至少 4 字元'); }
    if(password !== password2){ throw new Error('兩次密碼不一致'); }
    if(!getDb()){ throw new Error('Firebase 尚未就緒'); }

    const existing = await findAccountByUsername(username);
    if(existing){ throw new Error('帳號已被使用'); }

    const newUid = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    const entity = {
      username,
      password,
      displayName,
      role: ROLE.MEMBER,
      status: 'active',
      createdAt: Date.now(),
      createdBy: state.auth.accountUid || 'self',
      lastLoginAt: Date.now(),
      note: '',
      extraPerms: {
        canEditData: false,
        canImportExcel: false,
        canRunSim: false,
        canKick: false,
        canEditSettings: false,
      },
    };

    await accountRef(newUid).set(entity);
    setSession(newUid, entity);
    localStorage.setItem(window.SLG.ACCOUNT_UID_KEY, newUid);
    logSystem(`✅ 註冊成功，${displayName}（${ROLE_LABELS[ROLE.MEMBER]}）`);

    /* ★ v8.2：註冊後建立空白個人沙盤 */
    try{
      await window.SLG.saveMySandbox();
    }catch(e){
      console.warn('建立初始沙盤失敗', e);
    }

    return entity;
  }

  async function restoreSession(){
    const uid = localStorage.getItem(window.SLG.ACCOUNT_UID_KEY);
    if(!uid) return false;
    if(!getDb()){ return false; }
    try{
      const snap = await accountRef(uid).once('value');
      const data = snap.val();
      if(!data){
        localStorage.removeItem(window.SLG.ACCOUNT_UID_KEY);
        return false;
      }
      if(data.status === 'suspended'){
        localStorage.removeItem(window.SLG.ACCOUNT_UID_KEY);
        logSystem('⚠️ 您的帳號已被停用，請聯繫管理員');
        return false;
      }
      setSession(uid, data);
      logSystem(`🔄 已恢復登入：${data.displayName}`);

      /* ★ v8.2：載入個人雲端沙盤 */
      try{
        await window.SLG.loadMySandbox();
      }catch(e){
        console.warn('載入雲端沙盤失敗', e);
      }

      return true;
    }catch(e){
      console.warn('恢復登入失敗', e);
      return false;
    }
  }

  function setSession(uid, data){
    state.auth.signedIn = true;
    state.auth.accountUid = uid;
    state.auth.username = data.username || '';
    state.auth.displayName = data.displayName || '';
    state.auth.role = data.role || ROLE.MEMBER;
    state.auth.status = data.status || 'active';
    state.auth.extraPerms = Object.assign({
      canEditData: false,
      canImportExcel: false,
      canRunSim: false,
      canKick: false,
      canEditSettings: false,
    }, data.extraPerms || {});
    if(!state.commanderName) state.commanderName = state.auth.displayName;
    emit(EVT.AUTH, state.auth);
  }

  async function logout(){
    /* ★ v8.2：登出前先儲存個人沙盤（等儲存完成再清狀態） */
    if(state.auth.signedIn && window.SLG.saveMySandbox){
      try{
        await window.SLG.saveMySandbox();
        logSystem('💾 登出前已儲存個人沙盤');
      }catch(e){
        console.warn('登出前儲存失敗', e);
      }
    }

    /* ★ v8.3：若在房間內，先中斷連線 */
    if(window.SLG.isConnected && window.SLG.isConnected()){
      try{
        window.SLG.disconnectFirebase();
      }catch(e){ console.warn('中斷連線失敗', e); }
    }

    state.auth = {
      signedIn: false,
      accountUid: '',
      username: '',
      displayName: '',
      role: ROLE.GUEST,
      status: 'active',
      extraPerms: {
        canEditData: false,
        canImportExcel: false,
        canRunSim: false,
        canKick: false,
        canEditSettings: false,
      },
    };
    localStorage.removeItem(window.SLG.ACCOUNT_UID_KEY);
    emit(EVT.AUTH, state.auth);
    logSystem('🚪 已登出');

    /* ★ v8.3：登出後回到入口遮罩 */
    if(window.SLG.EntryGate){
      window.SLG.EntryGate.showForm();
    }
  }

  async function updateDisplayName(newName){
    if(!state.auth.signedIn) throw new Error('請先登入');
    if(!newName || newName.length > 12) throw new Error('顯示名稱 1-12 字');
    await accountRef(state.auth.accountUid).update({ displayName: newName });
    state.auth.displayName = newName;
    if(state.commanderName === state.auth.displayName || !state.commanderName){
      state.commanderName = newName;
    }
    emit(EVT.AUTH, state.auth);

    /* ★ v8.2：同步更新雲端沙盤的 displayName */
    try{
      await getDb().ref(`userSandboxes/${state.auth.accountUid}`).update({ displayName: newName });
    }catch(e){ /* 忽略 */ }

    logSystem('✏️ 顯示名稱已更新');
  }

  async function updatePassword(oldPwd, newPwd){
    if(!state.auth.signedIn) throw new Error('請先登入');
    if(!oldPwd || !newPwd) throw new Error('請輸入舊密碼與新密碼');
    if(newPwd.length < 4) throw new Error('新密碼至少 4 字元');
    const snap = await accountRef(state.auth.accountUid).once('value');
    const data = snap.val();
    if(!data || data.password !== oldPwd) throw new Error('舊密碼錯誤');
    await accountRef(state.auth.accountUid).update({ password: newPwd });
    logSystem('🔑 密碼已更新');
  }

  function isSuperAdmin(){ return state.auth.role === ROLE.SUPERADMIN; }
  function isAdmin(){ return state.auth.role === ROLE.ADMIN || isSuperAdmin(); }
  function isOfficer(){ return state.auth.role === ROLE.OFFICER || isAdmin(); }
  function isSignedIn(){ return state.auth.signedIn; }

  function canEditData(){
    if(isAdmin()) return true;
    if(state.auth.role === ROLE.OFFICER && state.auth.extraPerms.canEditData) return true;
    return false;
  }
  function canImportExcel(){
    if(isAdmin()) return true;
    if(state.auth.role === ROLE.OFFICER && state.auth.extraPerms.canImportExcel) return true;
    return false;
  }
  function canRunSim(){
    return isSignedIn();
  }
  function canEditSettings(){
    return isAdmin();
  }
  function canCreateRoom(){
    return isOfficer();
  }
  function canKick(){
    return isOfficer();
  }

  return {
    initFirebaseAuth, getAnonAuthUid,
    login, register, restoreSession, logout,
    updateDisplayName, updatePassword,
    isSuperAdmin, isAdmin, isOfficer, isSignedIn,
    canEditData, canImportExcel, canRunSim, canEditSettings, canCreateRoom, canKick,
  };
})();

/* ============================================================
   Accounts 模組（帳號管理）
   ============================================================ */
const Accounts = (() => {
  let allAccounts = {};

  async function loadAll(){
    if(!getDb()) throw new Error('Firebase 未就緒');
    const snap = await getDb().ref('accounts').once('value');
    allAccounts = snap.val() || {};
    return allAccounts;
  }

  function getFiltered(){
    const keyword = (document.getElementById('accountsSearch')?.value || '').trim().toLowerCase();
    const roleFilter = document.getElementById('accountsFilterRole')?.value || 'all';
    const statusFilter = document.getElementById('accountsFilterStatus')?.value || 'all';

    return Object.entries(allAccounts)
      .map(([uid, data]) => ({ uid, ...data }))
      .filter(a => {
        if(roleFilter !== 'all' && a.role !== roleFilter) return false;
        if(statusFilter !== 'all' && a.status !== statusFilter) return false;
        if(keyword){
          const hay = ((a.username||'') + ' ' + (a.displayName||'')).toLowerCase();
          if(!hay.includes(keyword)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const oa = ROLE_ORDER[a.role] ?? 9;
        const ob = ROLE_ORDER[b.role] ?? 9;
        if(oa !== ob) return oa - ob;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
  }

  function renderTable(){
    const tbody = document.getElementById('accountsTableBody');
    if(!tbody) return;
    const isSuper = Auth.isSuperAdmin();

    document.querySelectorAll('.superadmin-only-col').forEach(el => {
      el.style.display = isSuper ? '' : 'none';
    });

    const list = getFiltered();
    const meta = document.getElementById('accountsMeta');
    const total = Object.keys(allAccounts).length;
    if(meta) meta.textContent = `共 ${list.length} / ${total} 個帳號`;

    const hint = document.getElementById('accountsHint');
    if(hint){
      if(isSuper){
        hint.innerHTML = '👑 您擁有最高權限：可查看密碼、修改角色、刪除帳號。';
      } else if(Auth.isAdmin()){
        hint.innerHTML = '🛡️ 您為管理員：可停用帳號、修改 extraPerms，無法查閱密碼。';
      }
    }

    if(list.length === 0){
      tbody.innerHTML = `<tr><td colspan="${isSuper ? 8 : 7}" class="accounts-empty">無資料</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(a => {
      const roleChip = `<span class="auth-role-chip ${ROLE_CLASS[a.role] || 'role-guest'}" style="font-size:9px;padding:1px 6px;">${ROLE_LABELS[a.role] || a.role}</span>`;
      const statusChip = a.status === 'active'
        ? '<span class="chip" style="color:var(--neon-green);border-color:rgba(34,255,136,.3);">✅ 啟用</span>'
        : a.status === 'suspended'
          ? '<span class="chip" style="color:var(--neon-red);border-color:rgba(255,68,102,.3);">⏸️ 停用</span>'
          : `<span class="chip">${esc(a.status || '?')}</span>`;

      const isSelf = a.uid === state.auth.accountUid;
      const canEdit = isSuper || (!isSelf && Auth.isAdmin() && a.role !== 'superadmin');

      const fmtDate = ts => {
        if(!ts) return '—';
        try{
          const d = new Date(ts);
          return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        }catch(e){ return '—'; }
      };

      const pwdCell = isSuper
        ? `<td class="pwd-cell"><span class="pwd-mask" data-uid="${a.uid}">●●●●●●</span> <button class="btn btn-ghost btn-sm" data-action="toggle-pwd" data-uid="${a.uid}" data-real="${esc(a.password||'')}" style="padding:0 4px;font-size:10px;">👁</button></td>`
        : '';

      return `<tr data-uid="${a.uid}" class="${isSelf ? 'row-self' : ''}">
        <td class="acc-username"><span class="acc-username-text">${esc(a.username||'')}</span>${isSelf ? ' <span class="chip" style="font-size:9px;color:var(--neon-yellow);">你</span>' : ''}</td>
        <td>${esc(a.displayName||'—')}</td>
        <td>${roleChip}</td>
        ${pwdCell}
        <td>${statusChip}</td>
        <td class="acc-date">${fmtDate(a.createdAt)}</td>
        <td class="acc-date">${fmtDate(a.lastLoginAt)}</td>
        <td class="acc-actions">
          <button class="btn btn-primary btn-sm" data-action="edit-account" data-uid="${a.uid}" ${canEdit?'':'disabled'}>✏️</button>
          ${isSuper && !isSelf ? `<button class="btn btn-danger btn-sm" data-action="del-account" data-uid="${a.uid}">🗑️</button>` : ''}
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-action="toggle-pwd"]').forEach(btn => {
      btn.addEventListener('click', function(){
        const mask = tbody.querySelector(`.pwd-mask[data-uid="${this.dataset.uid}"]`);
        if(!mask) return;
        if(mask.textContent === '●●●●●●'){
          mask.textContent = this.dataset.real || '（空）';
          mask.classList.add('pwd-shown');
          this.textContent = '🙈';
        } else {
          mask.textContent = '●●●●●●';
          mask.classList.remove('pwd-shown');
          this.textContent = '👁';
        }
      });
    });

    tbody.querySelectorAll('[data-action="edit-account"]').forEach(btn => {
      btn.addEventListener('click', function(){
        openEditModal(this.dataset.uid);
      });
    });

    tbody.querySelectorAll('[data-action="del-account"]').forEach(btn => {
      btn.addEventListener('click', function(){
        const uid = this.dataset.uid;
        const a = allAccounts[uid];
        if(!a) return;
        const doDelete = async () => {
          try{
            await getDb().ref(`accounts/${uid}`).remove();
            delete allAccounts[uid];
            renderTable();
            logSystem(`🗑️ 已刪除帳號：${a.username}`);
          }catch(e){ alert('刪除失敗：' + e.message); }
        };
        if(typeof window.SLG.showConfirm === 'function'){
          window.SLG.showConfirm('刪除帳號',
            `確定要刪除帳號「${a.username}」嗎？\n\n⚠️ 此操作無法復原，該帳號的所有資料將永久移除。`,
            doDelete);
        } else if(confirm(`確定要刪除帳號「${a.username}」嗎？`)){
          doDelete();
        }
      });
    });
  }

  let editingUid = null;

  function openEditModal(uid){
    const a = allAccounts[uid];
    if(!a) return;
    editingUid = uid;
    const isSuper = Auth.isSuperAdmin();
    const isSelf = uid === state.auth.accountUid;

    document.getElementById('accountEditTitle').textContent = `✏️ 編輯帳號：${a.username}`;
    document.getElementById('ae_username').value = a.username || '';
    document.getElementById('ae_displayName').value = a.displayName || '';
    document.getElementById('ae_role').value = a.role || 'member';
    document.getElementById('ae_status').value = a.status || 'active';
    document.getElementById('ae_note').value = a.note || '';
    document.getElementById('ae_newPassword').value = '';

    const p = a.extraPerms || {};
    document.getElementById('ae_perm_canEditData').checked = !!p.canEditData;
    document.getElementById('ae_perm_canImportExcel').checked = !!p.canImportExcel;
    document.getElementById('ae_perm_canRunSim').checked = !!p.canRunSim;
    document.getElementById('ae_perm_canKick').checked = !!p.canKick;
    document.getElementById('ae_perm_canEditSettings').checked = !!p.canEditSettings;

    const canChangeAll = isSuper;
    document.getElementById('ae_displayName').disabled = !canChangeAll;
    document.getElementById('ae_role').disabled = !canChangeAll;
    document.getElementById('ae_newPassword').disabled = !canChangeAll;
    document.getElementById('ae_note').disabled = !canChangeAll;
    document.getElementById('ae_status').disabled = !(isSuper || Auth.isAdmin());

    document.querySelectorAll('.ae-perm-item input').forEach(el => {
      el.disabled = !(isSuper || Auth.isAdmin());
    });

    const hintEl = document.getElementById('accountEditHint');
    if(hintEl){
      if(isSuper){
        hintEl.textContent = isSelf ? '⚠️ 您正在編輯自己的帳號，請謹慎操作（避免自我降級）。' : '';
      } else if(Auth.isAdmin()){
        hintEl.textContent = '🛡️ 管理員：可修改狀態與 extraPerms，無法修改角色、顯示名、密碼。';
      }
    }

    document.getElementById('accountEditModal').classList.add('show');
  }

  function closeEditModal(){
    editingUid = null;
    document.getElementById('accountEditModal').classList.remove('show');
  }

  async function saveEdit(){
    if(!editingUid) return;
    const a = allAccounts[editingUid];
    if(!a) return;
    const isSuper = Auth.isSuperAdmin();
    const isSelf = editingUid === state.auth.accountUid;

    const updates = {};
    updates.status = document.getElementById('ae_status').value;
    updates.extraPerms = {
      canEditData: document.getElementById('ae_perm_canEditData').checked,
      canImportExcel: document.getElementById('ae_perm_canImportExcel').checked,
      canRunSim: document.getElementById('ae_perm_canRunSim').checked,
      canKick: document.getElementById('ae_perm_canKick').checked,
      canEditSettings: document.getElementById('ae_perm_canEditSettings').checked,
    };

    if(isSuper){
      const newName = document.getElementById('ae_displayName').value.trim();
      const newRole = document.getElementById('ae_role').value;
      const newPwd = document.getElementById('ae_newPassword').value;
      const newNote = document.getElementById('ae_note').value.trim();

      if(!newName){ alert('顯示名稱不能為空'); return; }
      if(newName.length > 12){ alert('顯示名稱最多 12 字'); return; }
      updates.displayName = newName;
      updates.role = newRole;
      updates.note = newNote;
      if(newPwd){
        if(newPwd.length < 4){ alert('新密碼至少 4 字元'); return; }
        updates.password = newPwd;
      }

      if(isSelf && newRole !== 'superadmin'){
        if(!confirm('⚠️ 您正在將自己從「超管」降級，將失去最高權限！\n\n確定要繼續嗎？')) return;
      }
    }

    try{
      await getDb().ref(`accounts/${editingUid}`).update(updates);
      logSystem(`✏️ 已更新帳號：${a.username}`);
      closeEditModal();
      await refresh();

      if(isSelf){
        const snap = await getDb().ref(`accounts/${editingUid}`).once('value');
        const data = snap.val();
        if(data){
          state.auth.displayName = data.displayName || state.auth.displayName;
          state.auth.role = data.role || state.auth.role;
          state.auth.status = data.status || state.auth.status;
          state.auth.extraPerms = Object.assign(state.auth.extraPerms, data.extraPerms || {});
          emit(EVT.AUTH, state.auth);

          /* ★ v8.2：同步更新雲端沙盤 */
          try{
            await getDb().ref(`userSandboxes/${editingUid}`).update({ displayName: state.auth.displayName });
          }catch(e){}
        }
      }
      alert('✅ 已儲存');
    }catch(e){
      alert('❌ 儲存失敗：' + e.message);
    }
  }

  async function refresh(){
    try{
      await loadAll();
      renderTable();
      return true;
    }catch(e){
      alert('讀取帳號失敗：' + e.message);
      return false;
    }
  }

  function exportCSV(){
    const list = getFiltered();
    if(list.length === 0){ alert('沒有資料可匯出'); return; }
    const isSuper = Auth.isSuperAdmin();
    const headers = ['帳號', '顯示名稱', '角色', '狀態', '建立時間', '最後登入', '備註'];
    if(isSuper) headers.splice(3, 0, '密碼');

    const rows = list.map(a => {
      const r = [
        a.username || '',
        a.displayName || '',
        a.role || '',
        a.status || '',
        a.createdAt ? new Date(a.createdAt).toISOString() : '',
        a.lastLoginAt ? new Date(a.lastLoginAt).toISOString() : '',
        a.note || '',
      ];
      if(isSuper) r.splice(3, 0, a.password || '');
      return r;
    });

    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v==null?'':v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `帳號清單_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    logSystem('📤 已匯出帳號清單 CSV');
    if(isSuper) alert('⚠️ 匯出檔案包含所有密碼，請妥善保管！');
  }

  function init(){
    const btnRefresh = document.getElementById('btnAccountsRefresh');
    if(btnRefresh) btnRefresh.addEventListener('click', refresh);

    const btnExport = document.getElementById('btnAccountsExportCSV');
    if(btnExport) btnExport.addEventListener('click', exportCSV);

    ['accountsSearch','accountsFilterRole','accountsFilterStatus'].forEach(id => {
      const el = document.getElementById(id);
      if(el){
        el.addEventListener('input', renderTable);
        el.addEventListener('change', renderTable);
      }
    });

    const cancel = document.getElementById('ae_cancel');
    if(cancel) cancel.addEventListener('click', closeEditModal);

    const save = document.getElementById('ae_save');
    if(save) save.addEventListener('click', saveEdit);
  }

  return { init, refresh, renderTable, openEditModal, closeEditModal };
})();

/* ============================================================
   EntryGate 模組（v8.2：無訪客）
   ============================================================ */
const EntryGate = (() => {

  function show(){
    const el = document.getElementById('entryGate');
    if(el){
      el.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
    }
    const loading = document.getElementById('entryLoading');
    const main = document.getElementById('entryMain');
    if(loading) loading.style.display = '';
    if(main) main.style.display = 'none';
  }

  function showForm(){
    const loading = document.getElementById('entryLoading');
    const main = document.getElementById('entryMain');
    if(loading) loading.style.display = 'none';
    if(main) main.style.display = '';
    ['entryLoginError','entryRegError'].forEach(id => {
      const el = document.getElementById(id);
      if(el) el.textContent = '';
    });
    ['entryLoginUsername','entryLoginPassword',
     'entryRegUsername','entryRegDisplayName',
     'entryRegPassword','entryRegPassword2'].forEach(id => {
      const el = document.getElementById(id);
      if(el) el.value = '';
    });
    switchView('login');
  }

  function hide(){
    const el = document.getElementById('entryGate');
    if(el) el.classList.add('hidden');
    document.body.style.overflow = '';
  }

  function switchView(view){
    document.querySelectorAll('.entry-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.entryView === view);
    });
    const loginView = document.getElementById('entryLoginView');
    const regView = document.getElementById('entryRegisterView');
    if(loginView) loginView.style.display = view === 'login' ? '' : 'none';
    if(regView) regView.style.display = view === 'register' ? '' : 'none';
  }

  async function doLogin(){
    const u = document.getElementById('entryLoginUsername').value.trim();
    const p = document.getElementById('entryLoginPassword').value;
    const errEl = document.getElementById('entryLoginError');
    const btn = document.getElementById('entryBtnLogin');

    errEl.textContent = '';
    if(!u || !p){ errEl.textContent = '請輸入帳號與密碼'; return; }

    btn.disabled = true;
    btn.textContent = '登入中...';
    try{
      await Auth.login(u, p);
      hide();
      if(typeof window.SLG.renderAuthUI === 'function') window.SLG.renderAuthUI();
      if(typeof window.SLG.applyPermissions === 'function') window.SLG.applyPermissions();
      updateModeBar();
      if(typeof window.SLG.renderAll === 'function') window.SLG.renderAll();
    }catch(e){
      errEl.textContent = e.message || '登入失敗';
    }finally{
      btn.disabled = false;
      btn.textContent = '登入';
    }
  }

  async function doRegister(){
    const u = document.getElementById('entryRegUsername').value.trim();
    const n = document.getElementById('entryRegDisplayName').value.trim();
    const p = document.getElementById('entryRegPassword').value;
    const p2 = document.getElementById('entryRegPassword2').value;
    const errEl = document.getElementById('entryRegError');
    const btn = document.getElementById('entryBtnRegister');

    errEl.textContent = '';

    btn.disabled = true;
    btn.textContent = '註冊中...';
    try{
      await Auth.register(u, n, p, p2);
      hide();
      if(typeof window.SLG.renderAuthUI === 'function') window.SLG.renderAuthUI();
      if(typeof window.SLG.applyPermissions === 'function') window.SLG.applyPermissions();
      updateModeBar();
      if(typeof window.SLG.renderAll === 'function') window.SLG.renderAll();
      alert('✅ 註冊成功！已自動登入。');
    }catch(e){
      errEl.textContent = e.message || '註冊失敗';
    }finally{
      btn.disabled = false;
      btn.textContent = '註冊';
    }
  }

  function init(){
    document.querySelectorAll('.entry-tab').forEach(tab => {
      tab.addEventListener('click', function(){
        switchView(this.dataset.entryView);
      });
    });

    const btnLogin = document.getElementById('entryBtnLogin');
    if(btnLogin) btnLogin.addEventListener('click', doLogin);

    ['entryLoginUsername','entryLoginPassword'].forEach(id => {
      const el = document.getElementById(id);
      if(el) el.addEventListener('keydown', e => {
        if(e.key === 'Enter') doLogin();
      });
    });

    const btnReg = document.getElementById('entryBtnRegister');
    if(btnReg) btnReg.addEventListener('click', doRegister);

    ['entryRegUsername','entryRegDisplayName','entryRegPassword','entryRegPassword2'].forEach(id => {
      const el = document.getElementById(id);
      if(el) el.addEventListener('keydown', e => {
        if(e.key === 'Enter') doRegister();
      });
    });
  }

  return { init, show, hide, showForm, switchView };
})();

/* ============================================================
   ★ v8.3：帳號 Tab UI（renderAuthUI / bindAuthUI）
   ============================================================ */
function renderAuthUI(){
  const a = state.auth;
  const guestPanel = document.getElementById('authGuestPanel');
  const userPanel  = document.getElementById('authUserPanel');

  if(!a.signedIn){
    if(guestPanel) guestPanel.style.display = '';
    if(userPanel)  userPanel.style.display = 'none';
    return;
  }

  if(guestPanel) guestPanel.style.display = 'none';
  if(userPanel)  userPanel.style.display = '';

  /* 頭像（用顯示名首字） */
  const avatarEl = document.getElementById('authAvatar');
  if(avatarEl){
    const ch = (a.displayName || a.username || '👤').trim().charAt(0) || '👤';
    avatarEl.textContent = ch;
  }

  /* 名稱 / 帳號 */
  const nameEl = document.getElementById('authDisplayName');
  if(nameEl) nameEl.textContent = a.displayName || '—';

  const userEl = document.getElementById('authUsername');
  if(userEl) userEl.textContent = '@' + (a.username || '—');

  /* 角色 chip */
  const roleEl = document.getElementById('authRoleChip');
  if(roleEl){
    roleEl.textContent = ROLE_LABELS[a.role] || a.role;
    roleEl.className = 'auth-role-chip ' + (ROLE_CLASS[a.role] || 'role-guest');
  }

  /* 帳號資訊 */
  const metaEl = document.getElementById('authMeta');
  if(metaEl){
    const rows = [
      ['帳號', a.username || '—'],
      ['顯示名稱', a.displayName || '—'],
      ['角色', ROLE_LABELS[a.role] || a.role],
      ['狀態', a.status === 'active' ? '✅ 啟用' : (a.status === 'suspended' ? '⏸️ 停用' : a.status || '—')],
    ];
    metaEl.innerHTML = rows.map(([k, v]) =>
      `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`
    ).join('');
  }

  /* 顯示名稱輸入框預填 */
  const editNameEl = document.getElementById('editDisplayName');
  if(editNameEl) editNameEl.value = a.displayName || '';

  /* 管理權限提示卡 */
  const adminHint = document.getElementById('authAdminHint');
  const adminHintText = document.getElementById('authAdminHintText');
  if(adminHint){
    if(Auth.isAdmin()){
      adminHint.style.display = '';
      if(adminHintText){
        adminHintText.textContent = Auth.isSuperAdmin()
          ? '👑 您擁有最高權限，可管理所有帳號、查閱密碼、修改角色。'
          : '🛡️ 您為管理員，可停用帳號、修改額外權限。';
      }
    } else {
      adminHint.style.display = 'none';
    }
  }
}

function bindAuthUI(){
  /* ── 更新顯示名稱 ── */
  const btnName = document.getElementById('btnUpdateDisplayName');
  if(btnName && !btnName.dataset.bound){
    btnName.dataset.bound = '1';
    btnName.addEventListener('click', async () => {
      const el = document.getElementById('editDisplayName');
      const newName = (el?.value || '').trim();
      if(!newName){ alert('請輸入顯示名稱'); return; }
      btnName.disabled = true;
      try{
        await Auth.updateDisplayName(newName);
        alert('✅ 顯示名稱已更新');
        renderAuthUI();
      }catch(e){
        alert('❌ 更新失敗：' + e.message);
      }finally{
        btnName.disabled = false;
      }
    });
  }

  /* ── 更新密碼 ── */
  const btnPwd = document.getElementById('btnUpdatePassword');
  if(btnPwd && !btnPwd.dataset.bound){
    btnPwd.dataset.bound = '1';
    btnPwd.addEventListener('click', async () => {
      const oldEl = document.getElementById('editOldPassword');
      const newEl = document.getElementById('editNewPassword');
      const oldPwd = oldEl?.value || '';
      const newPwd = newEl?.value || '';
      if(!oldPwd || !newPwd){ alert('請輸入目前密碼與新密碼'); return; }
      btnPwd.disabled = true;
      try{
        await Auth.updatePassword(oldPwd, newPwd);
        alert('✅ 密碼已更新');
        if(oldEl) oldEl.value = '';
        if(newEl) newEl.value = '';
      }catch(e){
        alert('❌ 更新失敗：' + e.message);
      }finally{
        btnPwd.disabled = false;
      }
    });
  }

  /* ── 前往帳號管理 ── */
  const btnGoto = document.getElementById('btnGotoAccounts');
  if(btnGoto && !btnGoto.dataset.bound){
    btnGoto.dataset.bound = '1';
    btnGoto.addEventListener('click', () => {
      const btn = document.querySelector('.top-nav button[data-tab="tab-accounts"]');
      if(btn) btn.click();
    });
  }

  renderAuthUI();
}

/* ============================================================
   暴露
   ============================================================ */
Object.assign(window.SLG, {
  Auth,
  Accounts,
  EntryGate,
  renderAuthUI,
  bindAuthUI,
});

})();