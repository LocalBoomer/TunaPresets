// main.js — poll Tuna (localhost:1608) and render the overlay.
//
// URL params:
//   ?theme=name            whitelisted stylesheet in css/
//   ?animation=name         see animations.js (default: scale)
//   ?preview=1 | ?demo=1   render placeholder data, no polling
//   ?cover=0               hide cover art
//   ?album=1               show album line (if Tuna provides it)
//   ?progress=1            show progress bar (if Tuna provides progress/duration)
//   ?stay=1                keep last song visible when stopped (default: hide)
//   ?hidepaused=1          also hide when status === paused
//
// Tuna payload shapes differ by source/version. We normalize:
//   { title, artists[]|artist, album, cover_path|cover_url|cover,
//     status: playing|paused|stopped|unknown, progress, duration }

const coverImage = document.getElementById('coverImage');
const titleEl = document.getElementById('title');
const artistsEl = document.getElementById('artists');
const albumEl = document.getElementById('album');
const coverBackground = document.querySelector('.cover-background');
const progressWrap = document.getElementById('progress');
const progressFill = document.getElementById('progressFill');

const POLL_INTERVAL_MS = 1000;
const MAX_MISSES_BEFORE_HIDE = 3;

const THEME_WHITELIST = new Set([
  'default', 'compact', 'simple',
  'neon', 'pill', 'vinyl', 'lowerthird', 'mono',
]);

const themeParam = (urlParams.get('theme') || '').toLowerCase();
const theme = THEME_WHITELIST.has(themeParam) ? themeParam : '';
const animation = (urlParams.get('animation') || 'scale').toLowerCase();
const showCover = urlParams.get('cover') !== '0';
const showAlbum = urlParams.get('album') === '1';
const showProgress = urlParams.get('progress') === '1';
const stayOnStop = urlParams.get('stay') === '1';
const hideOnPause = urlParams.get('hidepaused') === '1';
const isPreview = urlParams.get('preview') === '1' || urlParams.get('demo') === '1';

// The builder preview uses the original visual scale so it remains compact
// inside the builder while the standalone overlay uses the native 2x scale.
if (isPreview) {
  document.documentElement.style.setProperty('--np-scale', '1');
}

if (theme) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.type = 'text/css';
  link.href = `css/${theme}.css`;
  document.head.appendChild(link);
}

let currentData = null;
let misses = 0;
let progressRaf = 0;

const PLACEHOLDER_COVER =
  'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="16" fill="#1b1b22"/><text x="64" y="74" font-size="52" text-anchor="middle" fill="#555">♪</text></svg>`
  );

// ---------- helpers ----------

const normalize = (data) => {
  if (!data || typeof data !== 'object') return null;
  const artists = Array.isArray(data.artists)
    ? data.artists.filter(Boolean)
    : (data.artist ? [String(data.artist)] : []);
  return {
    title: String(data.title || '').trim(),
    artists,
    album: String(data.album || '').trim(),
    cover: [data.cover_path, data.cover_url, data.cover]
      .find(v => v && v !== 'n/a') || '',
    status: String(data.status || 'unknown').toLowerCase(),
    progress: Number(data.progress),
    duration: Number(data.duration),
    timeLeft: Number(data.time_left),
  };
};

const isValid = (d) =>
  !!d && !!d.title && d.artists.length > 0 && d.cover && d.cover !== 'n/a' && d.status !== 'unknown';

const isSameSong = (a, b) =>
  !!a && !!b &&
  a.title === b.title &&
  a.cover === b.cover &&
  a.status === b.status &&
  a.album === b.album &&
  JSON.stringify(a.artists) === JSON.stringify(b.artists);

const shouldHide = (d) => {
  if (!d) return !stayOnStop;
  if (d.status === 'stopped') return !stayOnStop;
  if (d.status === 'paused' && hideOnPause) return true;
  return false;
};

// Marquee: scroll any overflowing line (title / artist) via CSS vars.
const applyScrolling = (el, container) => {
  if (!el || !container) return;
  el.classList.remove('scrolling-text');
  el.style.removeProperty('--scroll-distance');
  el.style.removeProperty('--scroll-offset');
  el.style.animationDuration = '';
  // Wait a frame so scrollWidth is measured after layout.
  requestAnimationFrame(() => {
    if (!el || !container) return;
    const overflow = el.scrollWidth - container.clientWidth;
    if (overflow > 1) {
      const offset = Math.max(12, container.clientWidth * 0.08);
      const distance = overflow + offset;
      const duration = Math.max(4, distance / 35);
      el.style.setProperty('--scroll-distance', `${distance}px`);
      el.style.setProperty('--scroll-offset', `${offset}px`);
      el.style.animationDuration = `${duration}s`;
      el.classList.add('scrolling-text');
    }
  });
};

const setVisible = (visible) => {
  const el = document.querySelector('.now-playing');
  if (!el) return;
  el.classList.toggle('is-visible', visible);
};

const render = (data) => {
  if (!data) return;
  currentData = data;

  titleEl.textContent = data.title;
  artistsEl.textContent = data.artists.join(', ');
  albumEl.textContent = data.album;
  albumEl.style.display = showAlbum && data.album ? '' : 'none';

  if (showCover && data.cover) {
    coverImage.src = data.cover;
    coverImage.style.display = '';
    coverBackground.style.backgroundImage = `url("${data.cover}")`;
  } else {
    coverImage.style.display = 'none';
    coverBackground.style.backgroundImage = '';
  }

  progressWrap.style.display = showProgress ? '' : 'none';

  const visible = !shouldHide(data);
  setVisible(visible);

  applyScrolling(titleEl, titleEl.parentElement);
  applyScrolling(artistsEl, artistsEl.parentElement);
  applyScrolling(albumEl, albumEl.parentElement);
};

const renderPlaceholder = () => {
  render({
    title: 'Demo Track',
    artists: ['Tuna Presets'],
    album: 'Preview',
    cover: PLACEHOLDER_COVER,
    status: 'playing',
    progress: 42,
    duration: 240,
    timeLeft: 138,
  });
};

const poll = async () => {
  if (isPreview) return;
  try {
    const response = await fetch('http://localhost:1608/', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = normalize(await response.json());
    if (isValid(data)) {
      misses = 0;
      render(data);
    } else {
      misses++;
      if (misses >= MAX_MISSES_BEFORE_HIDE) setVisible(false);
    }
  } catch (error) {
    misses++;
    if (misses >= MAX_MISSES_BEFORE_HIDE) setVisible(false);
  }
};

if (isPreview) {
  renderPlaceholder();
} else {
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
}
