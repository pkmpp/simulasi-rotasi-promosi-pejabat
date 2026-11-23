/*!
 * github-sync.js — Modul Sinkronisasi Cloud GitHub & Mode Akses Admin/Viewer
 * Khusus untuk SI-TPK Peta Jabatan & Simulasi Rotasi, Mutasi, dan Promosi
 * Repositori Target Default: pkmpp/simulasi-rotasi-promosi-pejabat
 *
 * Cara pasang:
 * 1. Unggah file ini (github-sync.js) ke repositori GitHub sejajar dengan index.html
 * 2. Tambahkan 1 baris berikut tepat sebelum </body> di file index.html:
 *    <script src="github-sync.js"></script>
 */
(function () {
  'use strict';

  const DEFAULT_CFG = {
    owner: 'pkmpp',
    repo: 'simulasi-rotasi-promosi-pejabat',
    branch: 'main',
    path: 'data-simulasi-tpk.json',
    token: '',
    autoSync: true
  };

  const CFG_STORAGE_KEY = 'si_tpk_gh_cfg_v1';
  let ghCfg = loadConfig();
  let isAdminUnlocked = false;
  let isDirty = false;
  let isSyncing = false;
  let lastSyncedAt = null;
  let lastKnownSha = null;
  let autoSyncTimer = null;

  function loadConfig() {
    try {
      const raw = localStorage.getItem(CFG_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return Object.assign({}, DEFAULT_CFG, parsed);
      }
    } catch (e) {}
    return Object.assign({}, DEFAULT_CFG);
  }

  function saveConfig() {
    try {
      localStorage.setItem(CFG_STORAGE_KEY, JSON.stringify(ghCfg));
    } catch (e) {}
  }

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToUtf8(b64) {
    const clean = String(b64 || '').replace(/\s/g, '');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }

  function notify(msg) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg);
    }
  }

  // ---------------------------------------------------------------------------
  // 1. SERIALISASI & RESTORASI STATE LENGKAP (TERMASUK DATA YANG DIHAPUS/KOSONG)
  // ---------------------------------------------------------------------------
  function collectPrintMeta() {
    const getVal = (id) => {
      const el = document.getElementById(id);
      return el ? el.value : '';
    };
    const sigs = [];
    for (let i = 1; i <= 7; i++) {
      sigs.push({
        role: getVal('sigRole' + i),
        name: getVal('sigName' + i),
        nip: getVal('sigNip' + i)
      });
    }
    return {
      instansi: getVal('printInstansi'),
      nomorBa: getVal('printNomorBa'),
      tanggalBa: getVal('printTanggalBa'),
      tempatBa: getVal('printTempatBa'),
      sigs: sigs
    };
  }

  function applyPrintMeta(meta) {
    if (!meta || typeof meta !== 'object') return;
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el && val !== undefined && val !== null) el.value = val;
    };
    if (meta.instansi) setVal('printInstansi', meta.instansi);
    if (meta.nomorBa) setVal('printNomorBa', meta.nomorBa);
    if (meta.tanggalBa) setVal('printTanggalBa', meta.tanggalBa);
    if (meta.tempatBa) setVal('printTempatBa', meta.tempatBa);
    if (Array.isArray(meta.sigs)) {
      meta.sigs.forEach((s, idx) => {
        if (!s) return;
        const n = idx + 1;
        if (s.role !== undefined) setVal('sigRole' + n, s.role);
        if (s.name !== undefined) setVal('sigName' + n, s.name);
        if (s.nip !== undefined) setVal('sigNip' + n, s.nip);
      });
    }
  }

  function buildFullSyncPayload() {
    const posArr = (typeof POSITIONS !== 'undefined' && Array.isArray(POSITIONS))
      ? POSITIONS.map(p => ({
          nu: p.no_urut,
          eks: p.eks_nama || '',
          a1: p.alt1 || '',
          a2: p.alt2 || '',
          a3: p.alt3 || '',
          pil: p.pilihan || 'Tetap Eksisting'
        }))
      : [];

    const dmEdits = (typeof CUSTOM_DM_EDITS !== 'undefined' && CUSTOM_DM_EDITS)
      ? CUSTOM_DM_EDITS
      : {};

    return {
      version: 4,
      updatedAt: new Date().toISOString(),
      repo: `${ghCfg.owner}/${ghCfg.repo}`,
      positions: posArr,
      dmEdits: dmEdits,
      printMeta: collectPrintMeta()
    };
  }

  function applyFullSyncPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;

    // 1. Terapkan perubahan Data Master
    if (payload.dmEdits && typeof payload.dmEdits === 'object' && typeof EMPLOYEES !== 'undefined') {
      if (typeof CUSTOM_DM_EDITS !== 'undefined') {
        Object.keys(CUSTOM_DM_EDITS).forEach(k => delete CUSTOM_DM_EDITS[k]);
        Object.assign(CUSTOM_DM_EDITS, payload.dmEdits);
      }
      Object.keys(payload.dmEdits).forEach(k => {
        const ed = payload.dmEdits[k];
        if (!ed) return;
        if (EMPLOYEES[k]) {
          Object.assign(EMPLOYEES[k], ed);
          if (ed.nama && ed.nama !== k) {
            EMPLOYEES[ed.nama] = EMPLOYEES[k];
          }
        } else if (ed.nama && !EMPLOYEES[ed.nama]) {
          const newObj = Object.assign({
            id: EMPLOYEE_LIST.length + 1,
            ket: 'PNS',
            dm_jab_asli: ed.jab || '-',
            dm_kat_asli: ed.kat || '-',
            diff_note: ''
          }, ed);
          EMPLOYEES[ed.nama] = newObj;
          EMPLOYEE_LIST.unshift(newObj);
        }
      });
    }

    // 2. Terapkan posisi Kertas Kerja secara penuh (termasuk nilai kosong / hasil penghapusan!)
    if (Array.isArray(payload.positions) && typeof POSITIONS !== 'undefined') {
      const byNu = {};
      payload.positions.forEach(item => {
        if (item && item.nu !== undefined) byNu[item.nu] = item;
      });
      for (let i = 0; i < POSITIONS.length; i++) {
        const p = POSITIONS[i];
        const saved = byNu[p.no_urut];
        if (saved) {
          p.eks_nama = saved.eks !== undefined ? String(saved.eks) : '';
          p.alt1 = saved.a1 !== undefined ? String(saved.a1) : '';
          p.alt2 = saved.a2 !== undefined ? String(saved.a2) : '';
          p.alt3 = saved.a3 !== undefined ? String(saved.a3) : '';
          p.pilihan = saved.pil || 'Tetap Eksisting';
        }
      }
    }

    // 3. Terapkan metadata Berita Acara & 7 Penandatangan TPK
    if (payload.printMeta) {
      applyPrintMeta(payload.printMeta);
    }

    // 4. Sinkronkan juga ke localStorage agar reload offline konsisten
    try {
      if (typeof POSITIONS !== 'undefined') {
        const minimal = POSITIONS.map(p => ({
          a1: p.alt1, a2: p.alt2, a3: p.alt3, pil: p.pilihan, eks: p.eks_nama
        }));
        localStorage.setItem('si_tpk_gorontalo_v3', JSON.stringify(minimal));
      }
      if (typeof CUSTOM_DM_EDITS !== 'undefined') {
        localStorage.setItem('si_tpk_gorontalo_dm_v3', JSON.stringify(CUSTOM_DM_EDITS));
      }
    } catch (e) {}

    if (typeof window.refreshAllViews === 'function') {
      window.refreshAllViews();
    }
    if (typeof window.renderDashTpkMembers === 'function') {
      window.renderDashTpkMembers();
    }
    if (typeof window.renderPrintTpkTab === 'function') {
      window.renderPrintTpkTab();
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // 2. KOMUNIKASI GITHUB REST API (BACA & SIMPAN PERMANEN KE REPOSITORI)
  // ---------------------------------------------------------------------------
  function buildApiUrl() {
    const o = encodeURIComponent(ghCfg.owner.trim());
    const r = encodeURIComponent(ghCfg.repo.trim());
    const p = ghCfg.path.trim().replace(/^\/+/, '');
    return `https://api.github.com/repos/${o}/${r}/contents/${p}`;
  }

  function buildRawUrl() {
    const o = encodeURIComponent(ghCfg.owner.trim());
    const r = encodeURIComponent(ghCfg.repo.trim());
    const b = encodeURIComponent(ghCfg.branch.trim() || 'main');
    const p = ghCfg.path.trim().replace(/^\/+/, '');
    return `https://raw.githubusercontent.com/${o}/${r}/${b}/${p}?t=${Date.now()}`;
  }

  async function pullFromGitHub(silent = false) {
    if (!ghCfg.owner || !ghCfg.repo) return false;
    setSyncBadge('loading', '⏳ Memuat dari GitHub...');

    const headers = { 'Accept': 'application/vnd.github+json' };
    if (ghCfg.token) {
      headers['Authorization'] = `Bearer ${ghCfg.token.trim()}`;
    }

    try {
      const apiUrl = `${buildApiUrl()}?ref=${encodeURIComponent(ghCfg.branch || 'main')}&t=${Date.now()}`;
      const res = await fetch(apiUrl, { method: 'GET', headers: headers, cache: 'no-store' });

      if (res.ok) {
        const data = await res.json();
        lastKnownSha = data.sha || null;
        if (data.content) {
          const jsonText = base64ToUtf8(data.content);
          const payload = JSON.parse(jsonText);
          applyFullSyncPayload(payload);
          lastSyncedAt = payload.updatedAt || new Date().toISOString();
          isDirty = false;
          setSyncBadge('synced', `☁️ Tersinkron GitHub`);
          if (!silent) notify('✅ Data terbaru berhasil dimuat dari GitHub');
          return true;
        }
      } else if (res.status === 404) {
        lastKnownSha = null;
        setSyncBadge('empty', '☁️ Belum Ada File Data di GitHub');
        if (!silent) notify('ℹ️ Belum ada file data-simulasi-tpk.json di GitHub. Simpan sekali sebagai Admin untuk membuatnya.');
        return false;
      } else {
        // Fallback ke raw.githubusercontent.com (tanpa batas rate-limit API publik)
        const rawRes = await fetch(buildRawUrl(), { cache: 'no-store' });
        if (rawRes.ok) {
          const payload = await rawRes.json();
          applyFullSyncPayload(payload);
          lastSyncedAt = payload.updatedAt || new Date().toISOString();
          isDirty = false;
          setSyncBadge('synced', '☁️ Tersinkron GitHub');
          if (!silent) notify('✅ Data terbaru berhasil dimuat dari GitHub');
          return true;
        }
      }
    } catch (err) {
      // Coba fallback raw URL
      try {
        const rawRes = await fetch(buildRawUrl(), { cache: 'no-store' });
        if (rawRes.ok) {
          const payload = await rawRes.json();
          applyFullSyncPayload(payload);
          lastSyncedAt = payload.updatedAt || new Date().toISOString();
          isDirty = false;
          setSyncBadge('synced', '☁️ Tersinkron GitHub');
          if (!silent) notify('✅ Data terbaru berhasil dimuat dari GitHub');
          return true;
        }
      } catch (e2) {}
    }

    setSyncBadge('offline', '⚠️ Mode Lokal (Belum Tersinkron)');
    return false;
  }

  async function verifyAdminTokenAndRepo(tokenInput, ownerInput, repoInput) {
    const token = (tokenInput || '').trim();
    const owner = (ownerInput || '').trim();
    const repo = (repoInput || '').trim();
    if (!token || !owner || !repo) {
      return { ok: false, message: 'Owner, Nama Repositori, dan GitHub Token wajib diisi.' };
    }
    try {
      const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${token}`
        },
        cache: 'no-store'
      });
      if (res.status === 401) {
        return { ok: false, message: 'Token GitHub tidak valid atau sudah kedaluwarsa (HTTP 401).' };
      }
      if (res.status === 404) {
        return { ok: false, message: `Repositori ${owner}/${repo} tidak ditemukan atau token tidak memiliki akses ke repo ini.` };
      }
      if (!res.ok) {
        return { ok: false, message: `Gagal memverifikasi repositori (HTTP ${res.status}).` };
      }
      const info = await res.json();
      if (info.permissions && info.permissions.push === false) {
        return { ok: false, message: 'Token hanya memiliki izin baca (Read-only). Aktifkan izin "Contents: Read and write".' };
      }
      return { ok: true, message: `Terverifikasi ke repositori ${owner}/${repo}.` };
    } catch (err) {
      return { ok: false, message: 'Tidak dapat menghubungi server GitHub. Periksa koneksi internet Anda.' };
    }
  }

  async function pushToGitHub(silent = false) {
    if (!isAdminUnlocked || !ghCfg.token) {
      openGitHubModal('Masuk sebagai Admin dengan GitHub Token terlebih dahulu untuk menyimpan ke GitHub.');
      return false;
    }
    if (isSyncing) return false;
    isSyncing = true;
    setSyncBadge('loading', '⏳ Menyimpan ke GitHub...');

    const headers = {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${ghCfg.token.trim()}`,
      'Content-Type': 'application/json'
    };

    try {
      // 1. Ambil SHA terbaru agar tidak terjadi konflik jika sebelumnya diedit dari browser lain
      const checkUrl = `${buildApiUrl()}?ref=${encodeURIComponent(ghCfg.branch || 'main')}&t=${Date.now()}`;
      const checkRes = await fetch(checkUrl, { method: 'GET', headers: headers, cache: 'no-store' });
      let currentSha = null;
      if (checkRes.ok) {
        const meta = await checkRes.json();
        currentSha = meta.sha || null;
      } else if (checkRes.status === 401 || checkRes.status === 403) {
        isSyncing = false;
        setSyncBadge('error', '❌ Token Ditolak GitHub');
        openGitHubModal('Token ditolak oleh GitHub (HTTP ' + checkRes.status + '). Pastikan izin Contents: Read and write aktif.');
        return false;
      }

      // 2. Siapkan payload JSON & Base64 UTF-8
      const payload = buildFullSyncPayload();
      const jsonStr = JSON.stringify(payload);
      const b64Content = utf8ToBase64(jsonStr);
      const nowLabel = new Date().toLocaleString('id-ID');

      const bodyObj = {
        message: `Update data simulasi TPK (${nowLabel})`,
        content: b64Content,
        branch: ghCfg.branch || 'main'
      };
      if (currentSha) {
        bodyObj.sha = currentSha;
      }

      // 3. Commit (PUT) ke GitHub
      const putRes = await fetch(buildApiUrl(), {
        method: 'PUT',
        headers: headers,
        body: JSON.stringify(bodyObj)
      });

      if (putRes.ok) {
        const putData = await putRes.json();
        lastKnownSha = (putData.content && putData.content.sha) ? putData.content.sha : currentSha;
        lastSyncedAt = payload.updatedAt;
        isDirty = false;
        isSyncing = false;
        setSyncBadge('synced', '☁️ Tersimpan di GitHub');
        if (!silent) notify('✅ Semua perubahan berhasil disimpan permanen ke GitHub!');
        return true;
      } else {
        let errDetail = `HTTP ${putRes.status}`;
        try {
          const errJson = await putRes.json();
          if (errJson && errJson.message) errDetail += ': ' + errJson.message;
        } catch (e) {}
        isSyncing = false;
        setSyncBadge('error', '❌ Gagal Simpan GitHub');
        if (!silent) notify(`❌ Gagal menyimpan ke GitHub (${errDetail})`);
        return false;
      }
    } catch (err) {
      isSyncing = false;
      setSyncBadge('error', '❌ Gagal Koneksi GitHub');
      if (!silent) notify('❌ Gagal menghubungi GitHub. Periksa koneksi internet.');
      return false;
    }
  }

  function scheduleAutoSync() {
    isDirty = true;
    setSyncBadge('dirty', '🟡 Belum Disimpan ke GitHub');
    if (isAdminUnlocked && ghCfg.token && ghCfg.autoSync) {
      if (autoSyncTimer) clearTimeout(autoSyncTimer);
      autoSyncTimer = setTimeout(() => {
        pushToGitHub(true);
      }, 1800);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. MODE AKSES: VIEWER-ONLY (PUBLIK) VS EDITOR (ADMIN TERVERIFIKASI)
  // ---------------------------------------------------------------------------
  function applyAccessModeUI() {
    const body = document.body;
    const btnAuth = document.getElementById('btnGhAuthModal');
    const btnSave = document.getElementById('btnGhSaveNow');

    if (isAdminUnlocked) {
      body.classList.remove('tpk-viewer-mode');
      if (btnAuth) {
        btnAuth.className = 'px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold transition flex items-center gap-1.5 shadow-sm border border-emerald-400/40';
        btnAuth.innerHTML = '<span>🔓 Mode Admin (GitHub)</span>';
      }
      if (btnSave) {
        btnSave.classList.remove('hidden');
      }
    } else {
      body.classList.add('tpk-viewer-mode');
      if (btnAuth) {
        btnAuth.className = 'px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition flex items-center gap-1.5 shadow-sm border border-indigo-400/40';
        btnAuth.innerHTML = '<span>🔒 Login Admin &amp; Sinkron GitHub</span>';
      }
      if (btnSave) {
        btnSave.classList.add('hidden');
      }
    }
  }

  function setSyncBadge(state, label) {
    const badge = document.getElementById('ghSyncStatusBadge');
    if (!badge) return;
    let cls = 'px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 border ';
    if (state === 'synced') cls += 'bg-emerald-950/90 border-emerald-500/60 text-emerald-300';
    else if (state === 'dirty') cls += 'bg-amber-950/90 border-amber-500 text-amber-200';
    else if (state === 'loading') cls += 'bg-blue-950/90 border-blue-500 text-blue-200';
    else if (state === 'error') cls += 'bg-rose-950/90 border-rose-500 text-rose-200';
    else cls += 'bg-slate-800 border-slate-600 text-slate-300';
    badge.className = cls;
    badge.textContent = label;
  }

  // ---------------------------------------------------------------------------
  // 4. INJEKSI CSS, TOMBOL HEADER & MODAL PENGATURAN SINKRON GITHUB
  // ---------------------------------------------------------------------------
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      body.tpk-viewer-mode .btn-open-picker,
      body.tpk-viewer-mode .btn-clear-alt,
      body.tpk-viewer-mode .btn-select-alt,
      body.tpk-viewer-mode .pil-dropdown,
      body.tpk-viewer-mode .btn-edit-master,
      body.tpk-viewer-mode .btn-plot-direct,
      body.tpk-viewer-mode #btnAddMasterEmp,
      body.tpk-viewer-mode #btnEmptyAllAlt,
      body.tpk-viewer-mode #btnFillRecAlt,
      body.tpk-viewer-mode #btnResetSim,
      body.tpk-viewer-mode #btnSyncTpkMembers {
        opacity: 0.45;
        cursor: not-allowed !important;
      }
    `;
    document.head.appendChild(style);
  }

  function injectHeaderControls() {
    const quickPrintBtn = document.getElementById('btnQuickPrintTpk');
    if (!quickPrintBtn || !quickPrintBtn.parentElement) return;
    const actionBar = quickPrintBtn.parentElement;

    const statusBadge = document.createElement('button');
    statusBadge.id = 'ghSyncStatusBadge';
    statusBadge.type = 'button';
    statusBadge.title = 'Klik untuk memuat ulang data terbaru dari GitHub';
    statusBadge.className = 'px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-slate-300 text-xs font-semibold flex items-center gap-1.5';
    statusBadge.textContent = '☁️ Memeriksa GitHub...';
    statusBadge.addEventListener('click', () => pullFromGitHub(false));

    const saveBtn = document.createElement('button');
    saveBtn.id = 'btnGhSaveNow';
    saveBtn.type = 'button';
    saveBtn.className = 'hidden px-3 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-extrabold transition flex items-center gap-1.5 shadow-sm';
    saveBtn.innerHTML = '<span>☁️ Simpan ke GitHub</span>';
    saveBtn.addEventListener('click', () => pushToGitHub(false));

    const authBtn = document.createElement('button');
    authBtn.id = 'btnGhAuthModal';
    authBtn.type = 'button';
    authBtn.className = 'px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition flex items-center gap-1.5 shadow-sm';
    authBtn.innerHTML = '<span>🔒 Login Admin &amp; Sinkron GitHub</span>';
    authBtn.addEventListener('click', () => openGitHubModal(''));

    actionBar.insertBefore(authBtn, actionBar.firstChild);
    actionBar.insertBefore(saveBtn, actionBar.firstChild);
    actionBar.insertBefore(statusBadge, actionBar.firstChild);
  }

  function injectModal() {
    const wrapper = document.createElement('div');
    wrapper.id = 'modalGhSync';
    wrapper.className = 'fixed inset-0 bg-slate-900/70 backdrop-blur-xs z-50 hidden items-center justify-center p-4 no-print';
    wrapper.innerHTML = `
      <div class="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-xl w-full overflow-hidden flex flex-col max-h-[92vh]">
        <div class="bg-slate-900 text-white px-5 py-4 flex items-center justify-between">
          <div>
            <h3 class="text-sm font-bold">☁️ Sinkronisasi Cloud GitHub &amp; Login Admin TPK</h3>
            <p class="text-xs text-slate-300 mt-0.5">Simpan perubahan &amp; penghapusan data secara permanen ke repositori GitHub agar tampil sama di semua browser</p>
          </div>
          <button id="btnCloseGhModal" type="button" class="text-slate-400 hover:text-white text-sm font-bold px-2 py-1 rounded">✕</button>
        </div>

        <div class="p-5 space-y-4 text-xs overflow-y-auto custom-scroll">
          <div id="ghModalAlert" class="hidden p-3 rounded-xl border text-xs font-semibold"></div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block font-bold text-slate-700 mb-1">Username / Organisasi GitHub</label>
              <input id="ghInputOwner" type="text" class="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono text-xs" />
            </div>
            <div>
              <label class="block font-bold text-slate-700 mb-1">Nama Repositori</label>
              <input id="ghInputRepo" type="text" class="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono text-xs" />
            </div>
            <div>
              <label class="block font-bold text-slate-700 mb-1">Branch</label>
              <input id="ghInputBranch" type="text" class="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono text-xs" />
            </div>
            <div>
              <label class="block font-bold text-slate-700 mb-1">Nama File Data JSON di GitHub</label>
              <input id="ghInputPath" type="text" class="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono text-xs" />
            </div>
          </div>

          <div>
            <label class="block font-bold text-slate-700 mb-1">GitHub Personal Access Token (Khusus Admin)</label>
            <input id="ghInputToken" type="password" placeholder="Tempelkan token github_pat_... atau ghp_..." class="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <p class="text-[11px] text-slate-500 mt-1">Token hanya disimpan di browser perangkat Admin ini (tidak pernah tertulis di kode publik). Pengunjung umum tanpa token tetap bisa melihat data terbaru dalam Mode Lihat Saja.</p>
          </div>

          <label class="flex items-center gap-2 cursor-pointer font-semibold text-slate-700 bg-slate-50 p-2.5 rounded-lg border border-slate-200">
            <input id="ghInputAutoSync" type="checkbox" class="rounded border-slate-300 text-blue-600" />
            <span>Auto-Simpan otomatis ke GitHub setiap kali Admin mengubah atau menghapus data</span>
          </label>

          <details class="p-3 rounded-xl bg-blue-50/70 border border-blue-200 text-[11px] text-blue-950">
            <summary class="cursor-pointer font-bold">📖 Cara Membuat GitHub Token (Hanya 1 Kali)</summary>
            <ol class="list-decimal pl-4 mt-2 space-y-1">
              <li>Buka GitHub → klik foto profil kanan atas → <b>Settings</b> → <b>Developer settings</b> (paling bawah kiri).</li>
              <li>Pilih <b>Personal access tokens</b> → <b>Fine-grained tokens</b> → <b>Generate new token</b>.</li>
              <li>Pada <b>Repository access</b>, pilih <i>Only select repositories</i> → pilih <b>simulasi-rotasi-promosi-pejabat</b>.</li>
              <li>Pada <b>Repository permissions</b> → cari <b>Contents</b> → ubah menjadi <b>Read and write</b>.</li>
              <li>Klik <b>Generate token</b>, salin kodenya, lalu tempelkan pada kolom Token di atas.</li>
            </ol>
          </details>

          <div class="pt-2 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <button id="btnGhPullNow" type="button" class="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 font-semibold">
                🔄 Muat Ulang dari GitHub
              </button>
              <button id="btnGhDownloadJson" type="button" class="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 font-semibold">
                💾 Unduh Backup JSON
              </button>
            </div>
            <button id="btnGhLogout" type="button" class="hidden px-3 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-bold">
              🔒 Kunci / Keluar Admin
            </button>
          </div>
        </div>

        <div class="bg-slate-50 px-5 py-3.5 border-t border-slate-200 flex items-center justify-end gap-2">
          <button id="btnCancelGhModal" type="button" class="px-3.5 py-1.5 rounded-lg border border-slate-300 text-slate-700 text-xs font-semibold hover:bg-slate-100">Tutup</button>
          <button id="btnVerifyAndLoginGh" type="button" class="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold shadow-xs">
            ✅ Verifikasi Token &amp; Aktifkan Mode Admin
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(wrapper);

    document.getElementById('btnCloseGhModal').addEventListener('click', closeGitHubModal);
    document.getElementById('btnCancelGhModal').addEventListener('click', closeGitHubModal);
    document.getElementById('btnGhPullNow').addEventListener('click', async () => {
      await pullFromGitHub(false);
    });
    document.getElementById('btnGhDownloadJson').addEventListener('click', () => {
      const payload = buildFullSyncPayload();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = ghCfg.path || 'data-simulasi-tpk.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify('💾 File backup data-simulasi-tpk.json berhasil diunduh');
    });

    document.getElementById('btnGhLogout').addEventListener('click', () => {
      ghCfg.token = '';
      isAdminUnlocked = false;
      saveConfig();
      applyAccessModeUI();
      closeGitHubModal();
      notify('🔒 Mode Admin dikunci kembali (Mode Lihat Saja aktif)');
    });

    document.getElementById('btnVerifyAndLoginGh').addEventListener('click', async () => {
      const owner = document.getElementById('ghInputOwner').value.trim();
      const repo = document.getElementById('ghInputRepo').value.trim();
      const branch = document.getElementById('ghInputBranch').value.trim() || 'main';
      const path = document.getElementById('ghInputPath').value.trim() || 'data-simulasi-tpk.json';
      const token = document.getElementById('ghInputToken').value.trim();
      const autoSync = document.getElementById('ghInputAutoSync').checked;

      setModalAlert('info', '⏳ Memverifikasi akses token ke repositori GitHub...');
      const check = await verifyAdminTokenAndRepo(token, owner, repo);
      if (!check.ok) {
        setModalAlert('error', '❌ ' + check.message);
        return;
      }

      ghCfg = { owner, repo, branch, path, token, autoSync };
      saveConfig();
      isAdminUnlocked = true;
      applyAccessModeUI();
      setModalAlert('success', '✅ ' + check.message + ' Mode Admin & Sinkron GitHub aktif!');

      // Tarik data terbaru dari GitHub jika ada, atau simpan jika masih kosong
      const pulled = await pullFromGitHub(true);
      if (!pulled && isDirty) {
        await pushToGitHub(true);
      }
      setTimeout(closeGitHubModal, 900);
      notify('🔓 Login Admin berhasil! Perubahan kini tersimpan ke GitHub.');
    });
  }

  function setModalAlert(type, msg) {
    const el = document.getElementById('ghModalAlert');
    if (!el) return;
    if (!msg) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    if (type === 'error') {
      el.className = 'p-3 rounded-xl border bg-rose-50 border-rose-300 text-rose-800 text-xs font-semibold';
    } else if (type === 'success') {
      el.className = 'p-3 rounded-xl border bg-emerald-50 border-emerald-300 text-emerald-800 text-xs font-semibold';
    } else {
      el.className = 'p-3 rounded-xl border bg-blue-50 border-blue-300 text-blue-800 text-xs font-semibold';
    }
    el.textContent = msg;
  }

  function openGitHubModal(alertMessage) {
    document.getElementById('ghInputOwner').value = ghCfg.owner || DEFAULT_CFG.owner;
    document.getElementById('ghInputRepo').value = ghCfg.repo || DEFAULT_CFG.repo;
    document.getElementById('ghInputBranch').value = ghCfg.branch || DEFAULT_CFG.branch;
    document.getElementById('ghInputPath').value = ghCfg.path || DEFAULT_CFG.path;
    document.getElementById('ghInputToken').value = ghCfg.token || '';
    document.getElementById('ghInputAutoSync').checked = ghCfg.autoSync !== false;

    const logoutBtn = document.getElementById('btnGhLogout');
    if (logoutBtn) logoutBtn.classList.toggle('hidden', !isAdminUnlocked);

    if (alertMessage) {
      setModalAlert('error', alertMessage);
    } else if (isAdminUnlocked) {
      setModalAlert('success', `✅ Terhubung sebagai Admin ke ${ghCfg.owner}/${ghCfg.repo} (${ghCfg.path}).`);
    } else {
      setModalAlert('', '');
    }

    const modal = document.getElementById('modalGhSync');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  function closeGitHubModal() {
    const modal = document.getElementById('modalGhSync');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  // ---------------------------------------------------------------------------
  // 5. HOOK PENGAMANAN MODE VIEWER & DETEKSI PERUBAHAN OTOMATIS
  // ---------------------------------------------------------------------------
  function installViewerGuard() {
    const blockedSelector = [
      '.btn-open-picker', '.btn-clear-alt', '.btn-select-alt',
      '.btn-edit-master', '.btn-plot-direct', '.btn-choose-cand',
      '#btnAddMasterEmp', '#btnEmptyAllAlt', '#btnFillRecAlt',
      '#btnResetSim', '#btnSyncTpkMembers', '#btnSaveEditMaster',
      '#btnConfirmPlotDirect', '#btnConfirmReset'
    ].join(',');

    document.addEventListener('click', function (e) {
      if (isAdminUnlocked) return;
      const target = e.target.closest(blockedSelector);
      if (target) {
        e.preventDefault();
        e.stopImmediatePropagation();
        notify('🔒 Mode Lihat Saja — Klik "Login Admin & Sinkron GitHub" di kanan atas untuk mengedit data.');
      }
    }, true);

    document.addEventListener('change', function (e) {
      if (isAdminUnlocked) return;
      if (e.target && e.target.classList && e.target.classList.contains('pil-dropdown')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (typeof window.refreshAllViews === 'function') window.refreshAllViews();
        notify('🔒 Mode Lihat Saja — Login sebagai Admin untuk mengubah Keputusan TPK.');
      }
    }, true);
  }

  function hookSaveState() {
    if (typeof window.saveState === 'function' && !window.saveState._ghWrapped) {
      const origSaveState = window.saveState;
      const wrapped = function () {
        const res = origSaveState.apply(this, arguments);
        scheduleAutoSync();
        return res;
      };
      wrapped._ghWrapped = true;
      window.saveState = wrapped;
    }

    // Juga deteksi perubahan pada input Berita Acara & 7 Penandatangan TPK
    const printIds = [
      'printInstansi', 'printNomorBa', 'printTanggalBa', 'printTempatBa',
      'sigRole1', 'sigName1', 'sigNip1', 'sigRole2', 'sigName2', 'sigNip2',
      'sigRole3', 'sigName3', 'sigNip3', 'sigRole4', 'sigName4', 'sigNip4',
      'sigRole5', 'sigName5', 'sigNip5', 'sigRole6', 'sigName6', 'sigNip6',
      'sigRole7', 'sigName7', 'sigNip7'
    ];
    printIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', () => {
          if (isAdminUnlocked) scheduleAutoSync();
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 6. INISIALISASI SAAT HALAMAN SELESAI DIMUAT
  // ---------------------------------------------------------------------------
  async function initGitHubSyncModule() {
    injectStyles();
    injectHeaderControls();
    injectModal();
    installViewerGuard();
    hookSaveState();

    // Cek apakah admin sudah pernah menyimpan token valid di browser ini
    if (ghCfg.token) {
      const check = await verifyAdminTokenAndRepo(ghCfg.token, ghCfg.owner, ghCfg.repo);
      isAdminUnlocked = check.ok;
    } else {
      isAdminUnlocked = false;
    }

    applyAccessModeUI();
    // Selalu muat data terbaru dari GitHub saat halaman dibuka di browser mana pun
    await pullFromGitHub(true);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => setTimeout(initGitHubSyncModule, 150));
  } else {
    setTimeout(initGitHubSyncModule, 150);
  }
})();