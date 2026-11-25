/* applehugger.com shared script: icons, dock, and Drums/Cars pages. */

(() => {
  // ---------- Icons ----------
  const ICONS = {
    home:
      '<path d="M32 21C26 15 12 15 11 29C10 43 20 57 26 57C29 57 30 55.5 32 55.5C34 55.5 35 57 38 57C44 57 54 43 53 29C52 15 38 15 32 21Z"/>' +
      '<path d="M32 21C32 15 33.5 11 36 8"/><path d="M35 14C37 8 42 5.5 47 6.5C46 12 41 15 35 14Z"/>',
    drums:
      '<ellipse cx="32" cy="32" rx="18" ry="5"/><path d="M14 32V46A18 5 0 0 0 50 46V32"/>' +
      '<path d="M20 37V45M32 38V47M44 37V45"/><path d="M18 9L33 26M46 9L31 26"/>',
    cars:
      '<circle cx="32" cy="32" r="22"/><circle cx="32" cy="33" r="5"/><path d="M10.5 30L27 32M53.5 30L37 32M32 38V54"/>',
    contact:
      '<path d="M14 14H50A6 6 0 0 1 56 20V38A6 6 0 0 1 50 44H27L17 52V44H14A6 6 0 0 1 8 38V20A6 6 0 0 1 14 14Z"/>' +
      '<circle cx="22" cy="29" r="2" fill="currentColor" stroke="none"/>' +
      '<circle cx="32" cy="29" r="2" fill="currentColor" stroke="none"/>' +
      '<circle cx="42" cy="29" r="2" fill="currentColor" stroke="none"/>',
  };

  const icon = (name, cls = '') =>
    `<svg class="icon ${cls}" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  // Fill any <span data-icon="name"></span> placeholders
  document.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
  });

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Escape a paragraph, then turn <a href="https://...">text</a> back into a real link (https only)
  const rich = (s) =>
    esc(s).replace(
      /&lt;a href=&quot;(https:\/\/[^\s"<>]+?)&quot;&gt;(.+?)&lt;\/a&gt;/g,
      '<a href="$1" target="_blank" rel="noopener">$2</a>'
    );

  // ---------- Dock ----------
  const PAGES = [
    { key: 'home', label: 'Home', href: 'index.html' },
    { key: 'drums', label: 'Drums', href: 'drums.html' },
    { key: 'cars', label: 'Cars', href: 'cars.html' },
    { key: 'contact', label: 'Contact', href: 'contact.html' },
  ];

  const current = document.body.dataset.section;
  const dock = document.createElement('nav');
  dock.className = 'dock glass';
  dock.setAttribute('aria-label', 'Site');
  dock.innerHTML = PAGES.map(
    (p) =>
      `<a class="dock-item" href="${p.href}" aria-label="${p.label}"${p.key === current ? ' aria-current="page"' : ''}>` +
      `<span class="dock-tile">${icon(p.key)}</span><span class="dock-label glass">${p.label}</span></a>`
  ).join('');
  document.body.prepend(dock);

  // Magnify on hover (mouse and wide screens only)
  const items = [...dock.querySelectorAll('.dock-item')];
  const canMagnify = window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 761px)');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const BASE = 52, MAX = 84, SPREAD = 70;
  let centers = null;

  const reset = () => {
    items.forEach((it) => it.style.removeProperty('--s'));
    centers = null;
  };

  dock.addEventListener('mousemove', (e) => {
    if (!canMagnify.matches || reduceMotion.matches) return;
    if (!centers) {
      // Measure resting positions once, so sizes don't feed back into the math
      centers = items.map((it) => {
        const r = it.getBoundingClientRect();
        return r.top + r.height / 2;
      });
    }
    items.forEach((it, i) => {
      const d = e.clientY - centers[i];
      const t = Math.exp(-(d * d) / (2 * SPREAD * SPREAD));
      it.style.setProperty('--s', `${Math.round(BASE + (MAX - BASE) * t)}px`);
    });
  });
  dock.addEventListener('mouseleave', reset);
  window.addEventListener('resize', reset);

  // ---------- Drums / Cars ----------
  // Data lives in data/drums.json and data/cars.json: { specFields: [...], items: [...] }.
  // 'no-cache' makes the browser check for edits from the /admin editor on every visit.
  const loadCollection = async (kind) => {
    try {
      const res = await fetch(`data/${kind}.json`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (e) {
      return { specFields: [], items: [] };
    }
  };
  const LABELS = {
    drums: { title: 'Drums', item: 'drum', empty: 'Drums are on the way' },
    cars: { title: 'Cars', item: 'car', empty: 'Cars are on the way' },
  };

  const cover = (kind, item) =>
    item.cover
      ? `<img class="cover" src="${esc(item.cover)}" alt="" loading="lazy">`
      : `<div class="cover cover-empty">${icon(kind)}<span>Photos coming soon</span></div>`;

  // List page
  const list = document.querySelector('[data-collection-list]');
  if (list) renderList(list);

  async function renderList(list) {
    const kind = list.dataset.collectionList;
    const { items = [] } = await loadCollection(kind);
    if (!items.length) {
      list.outerHTML =
        `<div class="empty glass">${icon(kind)}<h2>${LABELS[kind].empty}</h2>` +
        `<p>Check back soon.</p></div>`;
    } else {
      list.innerHTML = items
        .map(
          (it) =>
            `<a class="card glass" href="${LABELS[kind].item}.html?id=${encodeURIComponent(it.id)}">` +
            `${cover(kind, it)}<div class="card-body"><h2>${esc(it.name)}</h2>` +
            `${it.subtitle ? `<p>${esc(it.subtitle)}</p>` : ''}</div></a>`
        )
        .join('');
    }
  }

  // Detail page
  const detail = document.querySelector('[data-collection-detail]');
  if (detail) renderDetail(detail);

  async function renderDetail(detail) {
    const kind = detail.dataset.collectionDetail;
    const id = new URLSearchParams(location.search).get('id');
    const { specFields = [], items = [] } = await loadCollection(kind);
    const item = items.find((it) => it.id === id);
    const back = `<a class="back" href="${kind}.html">‹ ${LABELS[kind].title}</a>`;

    if (!item) {
      detail.innerHTML =
        back + `<div class="empty glass">${icon(kind)}<h2>Not found</h2>` +
        `<p>That ${LABELS[kind].item} isn't here. Try the full list.</p></div>`;
    } else {
      document.title = `${item.name} · applehugger`;
      // Specs: either { label: value } in the standard order, or a list of [label, value] pairs
      const raw = item.specs || {};
      const specs = Array.isArray(raw)
        ? raw
        : (specFields.length ? specFields : Object.keys(raw)).filter((k) => raw[k]).map((k) => [k, raw[k]]);
      const photos = item.photos || [];
      const story = item.story ? [].concat(item.story) : [];

      detail.innerHTML =
        back +
        `<h1 class="detail-title">${esc(item.name)}</h1>` +
        (item.subtitle ? `<p class="detail-sub">${esc(item.subtitle)}</p>` : '') +
        // One panel: specs grid on top, description (collapsed) underneath
        `<section class="detail-panel glass" aria-label="Details">` +
        (specs.length
          ? `<dl class="specs">${specs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`
          : '') +
        (story.length
          ? `<div class="story${story.length > 1 ? ' collapsed' : ''}" id="story">` +
            `<h2 class="field-label">About this ${LABELS[kind].item}</h2>${story.map((p) => `<p>${rich(p)}</p>`).join('')}` +
            (story.length > 1 ? '<button class="read-more" type="button" aria-expanded="false" aria-controls="story">Read more</button>' : '') +
            '</div>'
          : '') +
        (!specs.length && !story.length ? '<p class="muted-note">Details coming soon.</p>' : '') +
        `</section>` +
        `<h2 class="group-title">Photos</h2>` +
        (photos.length
          ? `<div class="gallery">${photos
              .map(
                (p, i) =>
                  `<button type="button" data-index="${i}" aria-label="Open photo ${i + 1} of ${photos.length}">` +
                  `<img src="${esc(p.src)}" alt="${esc(p.alt || `${item.name}, photo ${i + 1}`)}" loading="lazy"></button>`
              )
              .join('')}</div>`
          : `<div class="empty glass">${icon(kind)}<h2>Photos coming soon</h2></div>`);

      const more = detail.querySelector('.read-more');
      if (more) {
        more.addEventListener('click', () => {
          const box = more.closest('.story');
          const collapsed = box.classList.toggle('collapsed');
          more.setAttribute('aria-expanded', String(!collapsed));
          more.textContent = collapsed ? 'Read more' : 'Show less';
        });
      }

      if (photos.length) setupLightbox(photos, detail.querySelector('.gallery'));
    }
  }

  function setupLightbox(photos, gallery) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-modal', 'true');
    lb.setAttribute('aria-label', 'Photo viewer');
    lb.innerHTML =
      '<img alt="">' +
      '<button class="lb-btn lb-close glass" type="button" aria-label="Close">✕</button>' +
      '<button class="lb-btn lb-prev glass" type="button" aria-label="Previous photo">‹</button>' +
      '<button class="lb-btn lb-next glass" type="button" aria-label="Next photo">›</button>' +
      '<div class="lb-count"></div>';
    document.body.appendChild(lb);

    const img = lb.querySelector('img');
    const count = lb.querySelector('.lb-count');
    let index = 0;
    let opener = null;

    const show = (i) => {
      index = (i + photos.length) % photos.length;
      img.src = photos[index].full || photos[index].src;
      img.alt = photos[index].alt || '';
      count.textContent = `${index + 1} of ${photos.length}`;
    };
    const open = (i, from) => {
      opener = from;
      show(i);
      lb.classList.add('open');
      lb.querySelector('.lb-close').focus();
    };
    const close = () => {
      lb.classList.remove('open');
      if (opener) opener.focus();
    };

    gallery.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-index]');
      if (b) open(+b.dataset.index, b);
    });
    lb.querySelector('.lb-close').onclick = close;
    lb.querySelector('.lb-prev').onclick = () => show(index - 1);
    lb.querySelector('.lb-next').onclick = () => show(index + 1);
    lb.addEventListener('click', (e) => { if (e.target === lb) close(); });
    document.addEventListener('keydown', (e) => {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') show(index - 1);
      if (e.key === 'ArrowRight') show(index + 1);
    });
  }

  // Footer year
  document.querySelectorAll('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });
})();
