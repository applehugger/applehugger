/*
  applehugger.com editor.

  - Signs in with GitHub (through the Cloudflare sign-in helper) and keeps the token only for this browser tab.
  - Reads data/drums.json and data/cars.json straight from GitHub, so it always edits the latest version.
  - Photos are resized and re-encoded in the browser, which also strips location (EXIF/GPS) data.
  - "Publish changes" makes one commit with all edits; GitHub Pages then updates the live site.

  Test mode: admin/?dev=1 runs against the local copy with no sign-in, and Publish only lists what it would change.
*/
(() => {
  'use strict';

  const CFG = window.EDITOR_CONFIG;
  const params = new URLSearchParams(location.search);
  const DEV = params.get('dev') === '1';
  const BRANCH = params.get('branch') || CFG.branch;
  const API = 'https://api.github.com';
  const SITE = new URL('../', location.href);
  const KINDS = {
    drums: { one: 'drum', title: 'Drums', page: 'drum.html' },
    cars: { one: 'car', title: 'Cars', page: 'car.html' },
  };
  const SIZES = { full: [2000, 0.82], thumb: [800, 0.78] };

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const slug = (s) =>
    String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
  const rand = () => Math.random().toString(36).slice(2, 7);
  const moveItem = (arr, from, to) => { const [x] = arr.splice(from, 1); arr.splice(to, 0, x); };

  // ---------- State ----------
  let token = null;
  let kind = 'drums';
  let selectedId = null;
  const data = {};               // kind -> { specFields, items }
  const loadedSha = {};          // kind -> blob sha of data/<kind>.json when loaded
  const changedKinds = new Set();
  const newFiles = new Map();    // repo path -> Blob waiting to upload
  const removed = new Set();     // repo paths to delete on publish
  const previews = new Map();    // repo path -> object URL for photos not yet published

  const isDirty = () => changedKinds.size > 0 || newFiles.size > 0 || removed.size > 0;
  const markChanged = () => { changedKinds.add(kind); updatePublishButton(); };

  function setStatus(msg, type = '') {
    const el = $('#status');
    el.textContent = msg;
    el.className = 'status-bar' + (type ? ' ' + type : '');
  }

  function updatePublishButton() {
    const b = $('#publish');
    const n = changedKinds.size + newFiles.size + removed.size;
    b.textContent = isDirty() ? `Publish changes` : 'No changes yet';
    b.dataset.dirty = String(isDirty());
    b.title = isDirty() ? `${n} pending change${n === 1 ? '' : 's'}` : '';
  }

  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- Storage (sessionStorage can be blocked) ----------
  const store = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) {} },
    del: (k) => { try { sessionStorage.removeItem(k); } catch (e) {} },
  };

  // ---------- GitHub API ----------
  async function gh(path, { method = 'GET', body, raw = false } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (res.status === 401) {
      signOut('Your sign-in expired. Sign in again to keep editing.');
      throw new Error('Signed out');
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message; } catch (e) {}
      throw new Error(`GitHub said ${res.status}${detail ? ': ' + detail : ''}`);
    }
    return raw ? res.text() : res.status === 204 ? null : res.json();
  }

  const repo = (p) => `/repos/${CFG.owner}/${CFG.repo}${p}`;
  const decodeB64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
  const blobToB64 = (blob) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });

  // ---------- Sign-in ----------
  function readTokenFromHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('token')) store.set('ah_token', h.get('token'));
    if (h.get('error')) setStatus(`Sign-in failed: ${h.get('error')}`, 'err');
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  }

  function signIn() {
    if (!CFG.authUrl) {
      $('#signin-note').textContent = "Sign-in isn't set up yet. The Cloudflare sign-in helper still needs to be connected.";
      return;
    }
    const returnTo = location.origin + location.pathname + location.search;
    location.href = `${CFG.authUrl.replace(/\/$/, '')}/login?return_to=${encodeURIComponent(returnTo)}`;
  }

  function signOut(msg) {
    token = null;
    store.del('ah_token');
    $('#app').hidden = true;
    $('#publish').hidden = true;
    $('#signout').hidden = true;
    $('#who').textContent = '';
    $('#signin').hidden = false;
    setStatus(msg || 'Signed out.');
  }

  // ---------- Loading ----------
  async function loadAll() {
    for (const k of Object.keys(KINDS)) {
      if (DEV) {
        const res = await fetch(new URL(`data/${k}.json`, SITE), { cache: 'no-store' });
        data[k] = await res.json();
      } else {
        const file = await gh(repo(`/contents/data/${k}.json?ref=${encodeURIComponent(BRANCH)}`));
        data[k] = JSON.parse(decodeB64(file.content));
        loadedSha[k] = file.sha;
      }
    }
  }

  async function start() {
    readTokenFromHash();
    $('#signin-btn').addEventListener('click', signIn);
    $('#signout').addEventListener('click', () => {
      if (isDirty() && !confirm('You have unpublished changes. Sign out and lose them?')) return;
      changedKinds.clear(); newFiles.clear(); removed.clear();
      signOut();
    });
    $('#publish').addEventListener('click', publish);
    document.querySelectorAll('.tabs [data-kind]').forEach((b) => b.addEventListener('click', () => switchKind(b.dataset.kind)));
    $('#add').addEventListener('click', addItem);
    setupItemList();
    setupBlur();

    if (DEV) {
      $('#banner').hidden = false;
      $('#banner').textContent = 'Test mode: editing the local copy. Publish will only list what it would change.';
    } else if (BRANCH !== 'main') {
      $('#banner').hidden = false;
      $('#banner').textContent = `Test mode: publishing to the "${BRANCH}" branch, which does not change the live site.`;
    }

    token = DEV ? 'dev' : store.get('ah_token');
    if (!token) { $('#signin').hidden = false; return; }

    try {
      setStatus('Loading…');
      if (!DEV) {
        const me = await gh('/user');
        if (me.login.toLowerCase() !== CFG.allowedLogin.toLowerCase()) {
          signOut(`The GitHub account "${me.login}" can't edit this site.`);
          return;
        }
        $('#who').textContent = `Signed in as ${me.login}`;
      } else {
        $('#who').textContent = 'Test mode';
      }
      await loadAll();
      $('#signin').hidden = true;
      $('#app').hidden = false;
      $('#publish').hidden = false;
      $('#signout').hidden = DEV;
      switchKind(params.get('kind') in KINDS ? params.get('kind') : 'drums');
      updatePublishButton();
      setStatus('');
    } catch (e) {
      if (e.message !== 'Signed out') setStatus(`Couldn't load the site data. ${e.message}`, 'err');
    }
  }

  // ---------- Card list ----------
  const items = () => data[kind].items;
  const current = () => items().find((it) => it.id === selectedId);
  const imgSrc = (path) => (path ? previews.get(path) || new URL(path, SITE).href : '');

  function switchKind(k) {
    kind = k;
    selectedId = null;
    document.querySelectorAll('.tabs [data-kind]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.kind === k)));
    $('#add').textContent = `+ Add ${KINDS[k].one}`;
    renderList();
    renderEditor();
  }

  function renderList() {
    $('#items').innerHTML = items()
      .map(
        (it, i) =>
          `<li class="item${it.id === selectedId ? ' active' : ''}" draggable="true" data-i="${i}">` +
          `<span class="grip" aria-hidden="true">⋮⋮</span>` +
          (it.cover ? `<img src="${esc(imgSrc(it.cover))}" alt="">` : '<span class="noimg"></span>') +
          `<button type="button" class="item-name" data-select="${i}">${esc(it.name || 'Untitled')}</button>` +
          `<span class="moves">` +
          `<button type="button" data-up="${i}" aria-label="Move ${esc(it.name)} up"${i === 0 ? ' disabled' : ''}>↑</button>` +
          `<button type="button" data-down="${i}" aria-label="Move ${esc(it.name)} down"${i === items().length - 1 ? ' disabled' : ''}>↓</button>` +
          `</span></li>`
      )
      .join('');
  }

  function setupItemList() {
    const list = $('#items');
    list.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.select !== undefined) {
        selectedId = items()[+b.dataset.select].id;
        renderList();
        renderEditor();
      } else if (b.dataset.up !== undefined) {
        reorderItems(+b.dataset.up, +b.dataset.up - 1);
      } else if (b.dataset.down !== undefined) {
        reorderItems(+b.dataset.down, +b.dataset.down + 1);
      }
    });
    makeSortable(list, reorderItems);
  }

  function reorderItems(from, to) {
    if (to < 0 || to >= items().length || from === to) return;
    moveItem(items(), from, to);
    markChanged();
    renderList();
  }

  // Drag and drop for any list whose children carry data-i
  function makeSortable(container, onMove) {
    let from = null;
    const clear = () => container.querySelectorAll('.dragging, .drop-before, .drop-after').forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after'));
    container.addEventListener('dragstart', (e) => {
      const el = e.target.closest('[data-i]');
      if (!el) return;
      from = +el.dataset.i;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(from));
      el.classList.add('dragging');
    });
    container.addEventListener('dragover', (e) => {
      if (from === null) return;
      e.preventDefault();
      const el = e.target.closest('[data-i]');
      container.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
      if (!el || +el.dataset.i === from) return;
      const r = el.getBoundingClientRect();
      const across = getComputedStyle(container).display.includes('grid') && container.classList.contains('photo-grid');
      const after = across ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
      el.classList.add(after ? 'drop-after' : 'drop-before');
    });
    container.addEventListener('drop', (e) => {
      e.preventDefault();
      const el = e.target.closest('[data-i]');
      if (from === null || !el) { clear(); from = null; return; }
      let to = +el.dataset.i + (el.classList.contains('drop-after') ? 1 : 0);
      if (to > from) to -= 1;
      const f = from;
      from = null;
      clear();
      onMove(f, to);
    });
    container.addEventListener('dragend', () => { from = null; clear(); });
  }

  // ---------- Editing one card ----------
  function renderEditor() {
    const ed = $('#editor');
    const it = current();
    const K = KINDS[kind];
    if (!it) {
      ed.innerHTML = `<div class="empty-editor"><p>Select a ${K.one} on the left to edit it, or add a new one.</p></div>`;
      return;
    }
    const fields = data[kind].specFields || [];
    const photos = it.photos || [];
    ed.innerHTML =
      `<div class="ed-head"><h2 id="ed-title">${esc(it.name || 'New ' + K.one)}</h2>` +
      `<a href="${esc(new URL(`${K.page}?id=${encodeURIComponent(it.id)}`, SITE).href)}" target="_blank" rel="noopener">View on site ↗</a></div>` +
      `<label class="field"><span>Name</span><input id="f-name" type="text" value="${esc(it.name)}"></label>` +
      `<p class="field-note">Web address: <code>${K.page}?id=${esc(it.id)}</code> (stays the same even if you rename it)</p>` +
      (fields.length
        ? `<fieldset class="spec-grid"><legend>Specs</legend>` +
          fields.map((f) => `<label class="field"><span>${esc(f)}</span><input type="text" data-spec="${esc(f)}" value="${esc((it.specs || {})[f] || '')}"></label>`).join('') +
          `</fieldset><p class="field-note">Leave a spec empty to hide it on the site. For drums with no inlay, type "None".</p>`
        : '') +
      `<label class="field"><span>About this ${K.one}</span><textarea id="f-story">${esc((it.story || []).join('\n\n'))}</textarea></label>` +
      `<p class="field-note">Each line becomes its own paragraph. To add a link, type &lt;a href="https://…"&gt;link text&lt;/a&gt;.</p>` +
      `<div class="photos-head"><h3>Photos (${photos.length})</h3>` +
      `<label class="button small">+ Add photos<input id="f-files" type="file" accept="image/*" multiple hidden></label></div>` +
      `<p class="field-note">Drag to reorder. ★ makes the cover. ◐ blurs part of a photo (like a license plate). Photos are resized and their location data removed before upload.</p>` +
      `<ol id="photos" class="photo-grid">` +
      photos
        .map((p, i) => {
          const isCover = it.cover === p.src;
          return (
            `<li class="ph${isCover ? ' is-cover' : ''}" draggable="true" data-i="${i}">` +
            `<img src="${esc(imgSrc(p.src))}" alt="Photo ${i + 1}">` +
            (newFiles.has(p.src) ? '<span class="ph-new">New</span>' : '') +
            `<span class="ph-tools">` +
            `<button type="button" data-left="${i}" aria-label="Move photo ${i + 1} earlier" title="Move earlier">‹</button>` +
            `<button type="button" data-right="${i}" aria-label="Move photo ${i + 1} later" title="Move later">›</button>` +
            `<button type="button" data-cover="${i}" aria-label="Make photo ${i + 1} the cover" title="Make cover">★</button>` +
            `<button type="button" data-blur="${i}" aria-label="Blur part of photo ${i + 1}" title="Blur part of photo">◐</button>` +
            `<button type="button" data-remove="${i}" aria-label="Remove photo ${i + 1}" title="Remove">✕</button>` +
            `</span>${isCover ? '<span class="ph-tag">Cover</span>' : ''}</li>`
          );
        })
        .join('') +
      `</ol>` +
      `<div class="danger-zone"><button type="button" id="delete-item" class="btn-danger">Delete this ${K.one}</button></div>`;

    $('#f-name').addEventListener('input', (e) => {
      it.name = e.target.value;
      $('#ed-title').textContent = it.name || 'New ' + K.one;
      markChanged();
      const btn = $(`#items [data-select="${items().indexOf(it)}"]`);
      if (btn) btn.textContent = it.name || 'Untitled';
    });
    ed.querySelectorAll('[data-spec]').forEach((inp) =>
      inp.addEventListener('input', () => {
        it.specs = it.specs || {};
        const v = inp.value.trim();
        if (v) it.specs[inp.dataset.spec] = v;
        else delete it.specs[inp.dataset.spec];
        // keep spec keys in the standard order
        const ordered = {};
        fields.forEach((f) => { if (it.specs[f]) ordered[f] = it.specs[f]; });
        it.specs = ordered;
        markChanged();
      })
    );
    $('#f-story').addEventListener('input', (e) => {
      it.story = e.target.value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      markChanged();
    });
    $('#f-files').addEventListener('change', (e) => addPhotos(it, [...e.target.files]));
    $('#delete-item').addEventListener('click', () => deleteItem(it));

    const grid = $('#photos');
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.left !== undefined) reorderPhotos(it, +b.dataset.left, +b.dataset.left - 1);
      if (b.dataset.right !== undefined) reorderPhotos(it, +b.dataset.right, +b.dataset.right + 1);
      if (b.dataset.cover !== undefined) { it.cover = it.photos[+b.dataset.cover].src; markChanged(); renderEditor(); renderList(); }
      if (b.dataset.blur !== undefined) openBlur(it, +b.dataset.blur);
      if (b.dataset.remove !== undefined) removePhoto(it, +b.dataset.remove);
    });
    makeSortable(grid, (from, to) => reorderPhotos(it, from, to));
  }

  function reorderPhotos(it, from, to) {
    if (to < 0 || to >= it.photos.length || from === to) return;
    moveItem(it.photos, from, to);
    markChanged();
    renderEditor();
  }

  function forgetFiles(paths) {
    for (const p of paths) {
      if (newFiles.has(p)) {
        newFiles.delete(p);
        if (previews.has(p)) { URL.revokeObjectURL(previews.get(p)); previews.delete(p); }
      } else {
        removed.add(p);
      }
    }
  }

  async function removePhoto(it, i) {
    const ok = await ask({ title: 'Remove this photo?', text: 'It will be deleted from the site when you publish.', ok: 'Remove' });
    if (!ok) return;
    const [p] = it.photos.splice(i, 1);
    forgetFiles([p.src, p.full]);
    if (it.cover === p.src) it.cover = it.photos[0] ? it.photos[0].src : '';
    markChanged();
    renderEditor();
    renderList();
  }

  async function addItem() {
    const K = KINDS[kind];
    const name = await ask({ title: `Add a ${K.one}`, label: 'Name', input: '', ok: 'Add' });
    if (!name || !name.trim()) return;
    let id = slug(name);
    const taken = new Set(items().map((x) => x.id));
    for (let n = 2; taken.has(id); n++) id = `${slug(name)}-${n}`;
    const it = { id, name: name.trim() };
    if ((data[kind].specFields || []).length) it.specs = {};
    Object.assign(it, { story: [], cover: '', photos: [] });
    items().unshift(it);
    selectedId = id;
    markChanged();
    renderList();
    renderEditor();
    setStatus(`Added "${it.name}" at the top. Drag it to change its position.`);
  }

  async function deleteItem(it) {
    const K = KINDS[kind];
    const ok = await ask({
      title: `Delete "${it.name}"?`,
      text: `This removes the ${K.one}${it.photos.length ? ` and its ${it.photos.length} photo${it.photos.length === 1 ? '' : 's'}` : ''} from the site when you publish.`,
      ok: 'Delete',
    });
    if (!ok) return;
    forgetFiles(it.photos.flatMap((p) => [p.src, p.full]));
    items().splice(items().indexOf(it), 1);
    selectedId = null;
    markChanged();
    renderList();
    renderEditor();
  }

  // ---------- Photos ----------
  async function decode(blob) {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (e) {
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  function toCanvas(src, maxEdge) {
    const w = src.width || src.naturalWidth;
    const h = src.height || src.naturalHeight;
    const s = Math.min(1, maxEdge / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  const canvasToJpeg = (c, q) => new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode photo'))), 'image/jpeg', q));

  // Turn a source image (or canvas) into new full + thumb files for this card
  async function storePhoto(it, source, baseName) {
    const name = `${slug(baseName).slice(0, 40)}-${rand()}.jpg`;
    const dir = `assets/photos/${kind}/${it.id}`;
    const p = { src: `${dir}/thumb/${name}`, full: `${dir}/full/${name}` };
    const full = await canvasToJpeg(toCanvas(source, SIZES.full[0]), SIZES.full[1]);
    const thumb = await canvasToJpeg(toCanvas(source, SIZES.thumb[0]), SIZES.thumb[1]);
    newFiles.set(p.full, full);
    newFiles.set(p.src, thumb);
    previews.set(p.full, URL.createObjectURL(full));
    previews.set(p.src, URL.createObjectURL(thumb));
    return p;
  }

  async function addPhotos(it, files) {
    if (!files.length) return;
    const failed = [];
    for (let i = 0; i < files.length; i++) {
      setStatus(`Preparing photo ${i + 1} of ${files.length}…`);
      try {
        const img = await decode(files[i]);
        const p = await storePhoto(it, img, files[i].name.replace(/\.[^.]+$/, ''));
        it.photos.push(p);
        if (!it.cover) it.cover = p.src;
      } catch (e) {
        failed.push(files[i].name);
      }
    }
    markChanged();
    renderEditor();
    renderList();
    setStatus(
      failed.length
        ? `Added ${files.length - failed.length} photo(s). Couldn't read: ${failed.join(', ')}. Try saving those as JPEG first.`
        : `Added ${files.length} photo${files.length === 1 ? '' : 's'}. They'll upload when you publish.`,
      failed.length ? 'err' : 'ok'
    );
  }

  // ---------- Blur tool ----------
  let blurState = null; // { it, i, img, boxes: [[x0,y0,x1,y1] as fractions], drawing }

  function setupBlur() {
    const dlg = $('#blur-dialog');
    const cv = $('#blur-canvas');
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
    };
    cv.addEventListener('pointerdown', (e) => {
      if (!blurState) return;
      cv.setPointerCapture(e.pointerId);
      const [x, y] = pos(e);
      blurState.drawing = [x, y, x, y];
      drawBlurPreview();
    });
    cv.addEventListener('pointermove', (e) => {
      if (!blurState || !blurState.drawing) return;
      const [x, y] = pos(e);
      blurState.drawing[2] = x;
      blurState.drawing[3] = y;
      drawBlurPreview();
    });
    cv.addEventListener('pointerup', () => {
      if (!blurState || !blurState.drawing) return;
      const [a, b, c, d] = blurState.drawing;
      const box = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
      if (box[2] - box[0] > 0.01 && box[3] - box[1] > 0.01) blurState.boxes.push(box);
      blurState.drawing = null;
      drawBlurPreview();
    });
    $('#blur-undo').addEventListener('click', () => { if (blurState) { blurState.boxes.pop(); drawBlurPreview(); } });
    $('#blur-cancel').addEventListener('click', () => { blurState = null; dlg.close(); });
    $('#blur-apply').addEventListener('click', applyBlur);
  }

  async function openBlur(it, i) {
    const p = it.photos[i];
    setStatus('Opening photo…');
    try {
      const src = previews.get(p.full) || new URL(p.full, SITE).href;
      const blob = await (await fetch(src, { cache: 'no-store' })).blob();
      const img = await decode(blob);
      blurState = { it, i, img, boxes: [], drawing: null };
      const cv = $('#blur-canvas');
      const preview = toCanvas(img, 1400);
      cv.width = preview.width;
      cv.height = preview.height;
      blurState.preview = preview;
      drawBlurPreview();
      $('#blur-dialog').showModal();
      setStatus('');
    } catch (e) {
      setStatus(`Couldn't open that photo. ${e.message}`, 'err');
    }
  }

  function pixelate(ctx, x, y, w, h) {
    x = Math.round(x); y = Math.round(y); w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    const block = Math.max(8, Math.round(Math.min(w, h) / 3));
    const t = document.createElement('canvas');
    t.width = Math.max(1, Math.round(w / block));
    t.height = Math.max(1, Math.round(h / block));
    const tg = t.getContext('2d');
    tg.imageSmoothingEnabled = true;
    tg.drawImage(ctx.canvas, x, y, w, h, 0, 0, t.width, t.height);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(t, 0, 0, t.width, t.height, x, y, w, h);
    ctx.restore();
  }

  function blurBoxes(canvas, boxes) {
    const g = canvas.getContext('2d');
    for (const [a, b, c, d] of boxes) {
      const pad = 0.15;
      const w = (c - a) * canvas.width, h = (d - b) * canvas.height;
      pixelate(g, a * canvas.width - w * pad, b * canvas.height - h * pad, w * (1 + 2 * pad), h * (1 + 2 * pad));
    }
  }

  function drawBlurPreview() {
    const cv = $('#blur-canvas');
    const g = cv.getContext('2d');
    g.drawImage(blurState.preview, 0, 0);
    blurBoxes(cv, blurState.boxes);
    const boxes = blurState.drawing ? [...blurState.boxes, blurState.drawing] : blurState.boxes;
    g.lineWidth = 2;
    g.strokeStyle = '#3cc4b6';
    g.setLineDash([6, 4]);
    for (const [a, b, c, d] of boxes) g.strokeRect(a * cv.width, b * cv.height, (c - a) * cv.width, (d - b) * cv.height);
    g.setLineDash([]);
  }

  async function applyBlur() {
    const s = blurState;
    if (!s || !s.boxes.length) { $('#blur-dialog').close(); blurState = null; return; }
    setStatus('Blurring…');
    try {
      const full = toCanvas(s.img, SIZES.full[0]);
      blurBoxes(full, s.boxes);
      const old = s.it.photos[s.i];
      const base = old.src.split('/').pop().replace(/\.jpg$/, '').replace(/-[a-z0-9]{5}$/, '') + '-blurred';
      const p = await storePhoto(s.it, full, base);
      s.it.photos[s.i] = p;
      if (s.it.cover === old.src) s.it.cover = p.src;
      forgetFiles([old.src, old.full]);
      markChanged();
      $('#blur-dialog').close();
      blurState = null;
      renderEditor();
      renderList();
      setStatus('Blur applied. The original photo will be replaced when you publish.', 'ok');
    } catch (e) {
      setStatus(`Couldn't blur that photo. ${e.message}`, 'err');
    }
  }

  // ---------- Small dialog helper ----------
  function ask({ title, text = '', label = '', input = null, list = null, ok = 'OK', cancel = 'Cancel' }) {
    const dlg = $('#ask-dialog');
    $('#ask-title').textContent = title;
    $('#ask-text').textContent = text;
    $('#ask-text').hidden = !text;
    $('#ask-field').hidden = input === null;
    $('#ask-label').textContent = label;
    $('#ask-input').value = input ?? '';
    $('#ask-list').hidden = !list;
    $('#ask-list').textContent = list || '';
    $('#ask-ok').textContent = ok;
    $('#ask-cancel').textContent = cancel;
    $('#ask-cancel').hidden = !cancel;
    return new Promise((resolve) => {
      const done = (val) => { cleanup(); dlg.close(); resolve(val); };
      const onOk = () => done(input === null ? true : $('#ask-input').value);
      const onCancel = () => done(input === null ? false : null);
      const onKey = (e) => { if (e.key === 'Enter' && input !== null) { e.preventDefault(); onOk(); } };
      const onClose = () => { cleanup(); resolve(input === null ? false : null); };
      const cleanup = () => {
        $('#ask-ok').removeEventListener('click', onOk);
        $('#ask-cancel').removeEventListener('click', onCancel);
        $('#ask-input').removeEventListener('keydown', onKey);
        dlg.removeEventListener('cancel', onClose);
      };
      $('#ask-ok').addEventListener('click', onOk);
      $('#ask-cancel').addEventListener('click', onCancel);
      $('#ask-input').addEventListener('keydown', onKey);
      dlg.addEventListener('cancel', onClose);
      dlg.showModal();
      if (input !== null) $('#ask-input').focus();
    });
  }

  // ---------- Publish ----------
  function summary() {
    const lines = [];
    for (const k of changedKinds) lines.push(`Update data/${k}.json (${data[k].items.length} cards)`);
    for (const p of newFiles.keys()) lines.push(`Add ${p}`);
    for (const p of removed) lines.push(`Delete ${p}`);
    return lines.join('\n');
  }

  async function publish() {
    if (!isDirty()) { setStatus('Nothing to publish yet.'); return; }
    for (const k of changedKinds) {
      const unnamed = data[k].items.find((it) => !String(it.name || '').trim());
      if (unnamed) { setStatus(`Every ${KINDS[k].one} needs a name before publishing.`, 'err'); return; }
    }
    const photosUp = [...newFiles.keys()].filter((p) => p.includes('/full/')).length;
    const photosDown = [...removed].filter((p) => p.includes('/full/')).length;
    const text =
      [
        changedKinds.size ? `Update ${[...changedKinds].map((k) => KINDS[k].title).join(' and ')}` : '',
        photosUp ? `upload ${photosUp} photo${photosUp === 1 ? '' : 's'}` : '',
        photosDown ? `delete ${photosDown} photo${photosDown === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join(', ') + '.';

    if (DEV) {
      await ask({ title: 'Test mode: nothing was published', text: `A real publish would: ${text}`, list: summary(), ok: 'Close', cancel: '' });
      return;
    }

    const go = await ask({
      title: BRANCH === 'main' ? 'Publish to applehugger.com?' : `Publish to the "${BRANCH}" test branch?`,
      text: `${text} ${BRANCH === 'main' ? 'The live site updates about a minute later.' : ''}`,
      ok: 'Publish',
    });
    if (!go) return;

    const btn = $('#publish');
    btn.disabled = true;
    try {
      setStatus('Checking for changes made elsewhere…');
      for (const k of changedKinds) {
        const now = await gh(repo(`/contents/data/${k}.json?ref=${encodeURIComponent(BRANCH)}`));
        if (now.sha !== loadedSha[k]) {
          throw new Error(`The ${KINDS[k].title} data changed somewhere else since you opened the editor. Copy anything you typed, reload the page, and try again.`);
        }
      }
      const ref = await gh(repo(`/git/ref/heads/${encodeURIComponent(BRANCH)}`));
      const head = ref.object.sha;
      const commit = await gh(repo(`/git/commits/${head}`));

      const tree = [];
      let n = 0;
      for (const [path, blob] of newFiles) {
        setStatus(`Uploading photo files ${++n} of ${newFiles.size}…`);
        const b = await gh(repo('/git/blobs'), { method: 'POST', body: { content: await blobToB64(blob), encoding: 'base64' } });
        tree.push({ path, mode: '100644', type: 'blob', sha: b.sha });
      }
      for (const path of removed) tree.push({ path, mode: '100644', type: 'blob', sha: null });
      for (const k of changedKinds) {
        tree.push({ path: `data/${k}.json`, mode: '100644', type: 'blob', content: JSON.stringify(data[k], null, 2) + '\n' });
      }

      setStatus('Saving…');
      const newTree = await gh(repo('/git/trees'), { method: 'POST', body: { base_tree: commit.tree.sha, tree } });
      const message = `Editor: ${text.replace(/\.$/, '')}`;
      const c = await gh(repo('/git/commits'), { method: 'POST', body: { message, tree: newTree.sha, parents: [head] } });
      await gh(repo(`/git/refs/heads/${encodeURIComponent(BRANCH)}`), { method: 'PATCH', body: { sha: c.sha } });

      for (const k of changedKinds) {
        loadedSha[k] = (await gh(repo(`/contents/data/${k}.json?ref=${encodeURIComponent(BRANCH)}`))).sha;
      }
      changedKinds.clear();
      newFiles.clear();
      removed.clear();
      updatePublishButton();
      setStatus(
        BRANCH === 'main'
          ? 'Published! The live site updates in about a minute.'
          : `Published to the "${BRANCH}" branch. The live site is unchanged.`,
        'ok'
      );
    } catch (e) {
      if (e.message !== 'Signed out') setStatus(`Publish failed: ${e.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  start();
})();
