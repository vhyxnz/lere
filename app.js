const $ = (selector) => document.querySelector(selector);
const audio = $('#audio');
const state = { tracks: [], currentId: null, filter: 'all', shuffle: false, repeat: false, playing: false, view: localStorage.getItem('pulsedeck-view') || 'list' };
const icons = { play: '<path d="m9 6 9 6-9 6z"/>', pause: '<path d="M8 6h3v12H8zM14 6h3v12h-3z"/>' };
let coverTargetId = null;
const DB_NAME = 'pulsedeck-library';
const DB_VERSION = 1;

function openLibraryDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore('tracks', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeTrack(track) {
  const db = await openLibraryDb();
  const record = { id: track.id, title: track.title, artist: track.artist, album: track.album, file: track.file, coverBlob: track.coverBlob || null, saved: track.saved, addedAt: track.addedAt };
  await new Promise((resolve, reject) => {
    const request = db.transaction('tracks', 'readwrite').objectStore('tracks').put(record);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
  db.close();
}

async function deleteStoredTrack(id) {
  const db = await openLibraryDb();
  await new Promise((resolve, reject) => {
    const request = db.transaction('tracks', 'readwrite').objectStore('tracks').delete(id);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
  db.close();
}

async function clearStoredTracks() {
  const db = await openLibraryDb();
  await new Promise((resolve, reject) => {
    const request = db.transaction('tracks', 'readwrite').objectStore('tracks').clear();
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
  db.close();
}

async function restoreLibrary() {
  try {
    const db = await openLibraryDb();
    const records = await new Promise((resolve, reject) => {
      const request = db.transaction('tracks').objectStore('tracks').getAll();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    db.close();
    state.tracks = records.sort((a, b) => a.addedAt - b.addedAt).map(record => ({ ...record, url: URL.createObjectURL(record.file), cover: record.coverBlob ? URL.createObjectURL(record.coverBlob) : '' }));
  } catch (_) { toast('Saved library could not be restored.'); }
  render();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const [header, encoded] = dataUrl.split(',');
  const mime = header.match(/data:([^;]+)/)?.[1] || 'application/octet-stream';
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

async function exportLibraryData() {
  try {
    $('#exportDataBtn').disabled = true;
    const tracks = await Promise.all(state.tracks.map(async (track) => ({
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      saved: track.saved,
      addedAt: track.addedAt,
      audio: { name: track.file.name, type: track.file.type, lastModified: track.file.lastModified, data: await blobToDataUrl(track.file) },
      cover: track.coverBlob ? { type: track.coverBlob.type, data: await blobToDataUrl(track.coverBlob) } : null
    })));
    const backup = {
      app: 'Lere', version: 1, exportedAt: new Date().toISOString(), tracks,
      settings: { theme: document.body.classList.contains('light') ? 'light' : 'dark', volume: $('#volumeBar').value, view: state.view }
    };
    const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `lere-backup-${new Date().toISOString().slice(0, 10)}.lere`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast(`${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'} exported`);
    $('#dataDialog').close();
  } catch (_) { toast('Could not export the library.'); }
  finally { $('#exportDataBtn').disabled = false; }
}

async function importLibraryData(file) {
  try {
    const backup = JSON.parse(await file.text());
    if (backup.app !== 'Lere' || backup.version !== 1 || !Array.isArray(backup.tracks)) throw new Error('Invalid backup');
    $('#importDataBtn').disabled = true;
    for (const item of backup.tracks) {
      if (!item.audio?.data || !item.audio?.name) continue;
      const audioBlob = dataUrlToBlob(item.audio.data);
      const audioFile = new File([audioBlob], item.audio.name, { type: item.audio.type || audioBlob.type, lastModified: item.audio.lastModified || Date.now() });
      const coverBlob = item.cover?.data ? dataUrlToBlob(item.cover.data) : null;
      const track = {
        id: item.id || crypto.randomUUID(), title: item.title || item.audio.name.replace(/\.[^.]+$/, ''), artist: item.artist || 'Uploaded audio',
        album: item.album || '', saved: Boolean(item.saved), addedAt: item.addedAt || Date.now(), file: audioFile, coverBlob,
        url: URL.createObjectURL(audioFile), cover: coverBlob ? URL.createObjectURL(coverBlob) : ''
      };
      const existingIndex = state.tracks.findIndex(existing => existing.id === track.id);
      if (existingIndex >= 0) {
        URL.revokeObjectURL(state.tracks[existingIndex].url);
        if (state.tracks[existingIndex].cover) URL.revokeObjectURL(state.tracks[existingIndex].cover);
        state.tracks[existingIndex] = track;
      } else state.tracks.push(track);
      await storeTrack(track);
    }
    if (backup.settings) {
      if (backup.settings.theme === 'light') document.body.classList.add('light'); else document.body.classList.remove('light');
      if (backup.settings.volume != null) { $('#volumeBar').value = backup.settings.volume; audio.volume = Number(backup.settings.volume); localStorage.setItem('pulsedeck-volume', backup.settings.volume); }
      if (backup.settings.view === 'grid' || backup.settings.view === 'list') { state.view = backup.settings.view; localStorage.setItem('pulsedeck-view', state.view); }
      localStorage.setItem('pulsedeck-theme', backup.settings.theme === 'light' ? 'light' : 'dark');
    }
    state.tracks.sort((a, b) => a.addedAt - b.addedAt);
    render();
    $('#dataDialog').close();
    toast(`${backup.tracks.length} ${backup.tracks.length === 1 ? 'track' : 'tracks'} imported`);
  } catch (_) { toast('This is not a valid Lere backup.'); }
  finally { $('#importDataBtn').disabled = false; $('#importInput').value = ''; }
}

const formatTime = (seconds) => {
  if (!Number.isFinite(seconds)) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};

const escapeHtml = (value) => {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
};

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2200);
}

function setPlaying(playing) {
  state.playing = playing;
  $('#playIcon').innerHTML = playing ? icons.pause : icons.play;
  $('#playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

function decodeText(bytes, encoding = 0) {
  const codec = encoding === 1 || encoding === 2 ? 'utf-16' : 'utf-8';
  try { return new TextDecoder(codec).decode(bytes).replace(/^\uFEFF|\0/g, '').trim(); }
  catch (_) { return new TextDecoder().decode(bytes).replace(/\0/g, '').trim(); }
}

async function readEmbeddedMetadata(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (String.fromCharCode(...bytes.slice(0, 3)) !== 'ID3') return {};
  const version = bytes[3];
  const tagSize = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const view = new DataView(buffer);
  const result = {};
  let offset = 10;
  while (offset + 10 <= Math.min(bytes.length, tagSize + 10)) {
    const id = String.fromCharCode(...bytes.slice(offset, offset + 4));
    if (!/^\w{4}$/.test(id)) break;
    const size = version === 4
      ? ((bytes[offset + 4] & 0x7f) << 21) | ((bytes[offset + 5] & 0x7f) << 14) | ((bytes[offset + 6] & 0x7f) << 7) | (bytes[offset + 7] & 0x7f)
      : view.getUint32(offset + 4);
    if (!size || offset + 10 + size > bytes.length) break;
    const data = bytes.slice(offset + 10, offset + 10 + size);
    if (id === 'TIT2') result.title = decodeText(data.slice(1), data[0]);
    if (id === 'TPE1') result.artist = decodeText(data.slice(1), data[0]);
    if (id === 'TALB') result.album = decodeText(data.slice(1), data[0]);
    if (id === 'APIC') {
      const encoding = data[0];
      let cursor = 1;
      while (cursor < data.length && data[cursor] !== 0) cursor++;
      const mime = decodeText(data.slice(1, cursor)) || 'image/jpeg';
      cursor += 2;
      const separator = encoding === 1 || encoding === 2 ? 2 : 1;
      while (cursor + separator <= data.length) {
        if (data[cursor] === 0 && (separator === 1 || data[cursor + 1] === 0)) { cursor += separator; break; }
        cursor += separator;
      }
      if (cursor < data.length) {
        result.coverBlob = new Blob([data.slice(cursor)], { type: mime });
        result.cover = URL.createObjectURL(result.coverBlob);
      }
    }
    offset += 10 + size;
  }
  return result;
}

function currentTrack() { return state.tracks.find(track => track.id === state.currentId); }

function updateNowPlaying(track) {
  $('#nowTitle').textContent = track?.title || 'Nothing playing';
  $('#nowSource').textContent = track ? track.artist : 'Upload a track to begin';
  $('#expandedTitle').textContent = track?.title || 'Nothing playing';
  $('#expandedArtist').textContent = track?.artist || 'Upload a track to begin';
  const artwork = $('#artwork');
  const expandedArtwork = $('#expandedArtwork');
  artwork.style.backgroundImage = track?.cover ? `url("${track.cover}")` : '';
  artwork.classList.toggle('has-cover', Boolean(track?.cover));
  expandedArtwork.style.backgroundImage = track?.cover ? `url("${track.cover}")` : '';
  expandedArtwork.classList.toggle('has-cover', Boolean(track?.cover));
  if ('mediaSession' in navigator && track) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album || 'Lere Library',
      artwork: track.cover ? [{ src: track.cover, sizes: '512x512' }] : []
    });
  }
}

function recommendationScore(candidate, current) {
  if (!current) return candidate.addedAt;
  const tokens = (name) => new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2));
  const currentTokens = tokens(current.title);
  const overlap = [...tokens(candidate.title)].filter(word => currentTokens.has(word)).length;
  const sameFormat = candidate.file.type === current.file.type ? 2 : 0;
  const sizeSimilarity = 1 - Math.min(Math.abs(candidate.file.size - current.file.size) / Math.max(candidate.file.size, current.file.size), 1);
  return overlap * 5 + sameFormat + sizeSimilarity;
}

function getRecommendations() {
  const current = currentTrack();
  return state.tracks
    .filter(track => track.id !== state.currentId)
    .map(track => ({ track, score: recommendationScore(track, current) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(item => item.track);
}

function renderRecommendations() {
  const grid = $('#recommendationGrid');
  const picks = getRecommendations();
  if (state.tracks.length < 2 || !picks.length) {
    grid.innerHTML = '<div class="recommendation-empty">Upload at least two songs to get recommendations from your collection.</div>';
    return;
  }
  const colors = ['red', 'coral', 'blue', 'amber'];
  grid.innerHTML = picks.map((track, index) => `
    <button class="recommendation-card ${colors[index]} ${track.cover ? 'has-cover' : ''}" ${track.cover ? `style="background-image:linear-gradient(0deg,#090a0ee8,#090a0e22),url('${track.cover}')"` : ''} data-recommend="${track.id}" aria-label="Play recommended track ${escapeHtml(track.title)}">
      <span>${escapeHtml(track.title)}</span>
      <small>${currentTrack() ? 'Similar to what you are playing' : 'From your uploaded collection'}</small>
      <svg viewBox="0 0 24 24"><path d="m9 6 9 6-9 6z"/></svg>
    </button>`).join('');
}

function renderPlayerQueue() {
  const queue = $('#playerQueue');
  if (!state.tracks.length) { queue.innerHTML = '<div class="queue-empty">Upload music to build your queue.</div>'; return; }
  queue.innerHTML = state.tracks.map((track, index) => `
    <button class="queue-item ${track.id === state.currentId ? 'active' : ''}" data-queue-id="${track.id}">
      <span class="queue-cover" ${track.cover ? `style="background-image:url('${track.cover}')"` : ''}>${track.cover ? '' : '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>'}</span>
      <span class="queue-copy"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.artist)}</span></span>
      <span class="queue-status">${track.id === state.currentId ? 'Playing' : String(index + 1).padStart(2, '0')}</span>
    </button>`).join('');
}

function render() {
  const visible = state.tracks.filter(track => state.filter === 'all' || (state.filter === 'playlist' ? track.saved : true));
  $('#trackList').classList.toggle('grid-view', state.view === 'grid');
  $('#listViewBtn').classList.toggle('active', state.view === 'list');
  $('#gridViewBtn').classList.toggle('active', state.view === 'grid');
  $('#library-title').textContent = state.filter === 'playlist' ? 'My playlist' : state.filter === 'local' ? 'On this device' : 'Your queue';
  $('#trackCount').textContent = `${visible.length} ${visible.length === 1 ? 'track' : 'tracks'}`;
  $('#emptyState').hidden = visible.length > 0;
  $('#trackList').innerHTML = visible.map((track, index) => `
    <article class="track ${track.id === state.currentId ? 'active' : ''}" role="listitem" data-id="${track.id}" tabindex="0" aria-label="Play ${escapeHtml(track.title)}">
      <span class="track-number ${track.cover ? 'has-cover' : ''}" ${track.cover ? `style="background-image:url('${track.cover}')"` : ''}>${track.id === state.currentId && state.playing ? '<svg viewBox="0 0 24 24"><path d="M6 9v6M12 6v12M18 9v6"/></svg>' : track.cover ? '' : String(index + 1).padStart(2, '0')}</span>
      <div class="track-info"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.artist)}</span></div>
      <div class="track-actions">
        <button class="track-action menu-trigger" data-menu="${track.id}" aria-label="Actions for ${escapeHtml(track.title)}" aria-expanded="${Boolean(track.menuOpen)}"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button>
        <div class="track-menu ${track.menuOpen ? 'open' : ''}">
          <button data-cover="${track.id}"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 17 5-5 4 4 2-2 5 4"/></svg>${track.cover ? 'Change cover' : 'Add cover'}</button>
          <button data-save="${track.id}"><svg viewBox="0 0 24 24"><path d="M5 4h14v17l-7-4-7 4z"/></svg>${track.saved ? 'Remove from playlist' : 'Add to playlist'}</button>
          <button data-download="${track.id}"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 5-5m-5 5-5-5"/></svg>Download</button>
          <button class="danger" data-remove="${track.id}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>Remove</button>
        </div>
      </div>
    </article>`).join('');
  renderRecommendations();
  renderPlayerQueue();
}

function playTrack(id) {
  const track = state.tracks.find(item => item.id === id);
  if (!track) return;
  audio.pause();
  state.currentId = id;
  audio.src = track.url;
  audio.volume = Number($('#volumeBar').value);
  updateNowPlaying(track);
  audio.play().then(() => setPlaying(true)).catch(() => toast('Could not play this audio file.'));
  render();
}

function togglePlay() {
  const track = currentTrack();
  if (!track) { if (state.tracks[0]) playTrack(state.tracks[0].id); return; }
  if (audio.paused) audio.play(); else audio.pause();
}

function move(direction) {
  if (!state.tracks.length) return;
  const currentIndex = state.tracks.findIndex(track => track.id === state.currentId);
  const nextIndex = state.shuffle ? Math.floor(Math.random() * state.tracks.length) : (currentIndex + direction + state.tracks.length) % state.tracks.length;
  playTrack(state.tracks[nextIndex].id);
}

$('#fileInput').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  const tracks = await Promise.all(files.map(async (file, index) => {
    let metadata = {};
    try { metadata = await readEmbeddedMetadata(file); } catch (_) {}
    return {
      id: crypto.randomUUID(),
      title: metadata.title || file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim(),
      artist: metadata.artist || 'Uploaded audio',
      album: metadata.album || '',
      cover: metadata.cover || '',
      coverBlob: metadata.coverBlob || null,
      url: URL.createObjectURL(file),
      file,
      saved: false,
      addedAt: Date.now() + index
    };
  }));
  state.tracks.push(...tracks);
  await Promise.all(tracks.map(storeTrack));
  render();
  if (files.length) toast(`${files.length} ${files.length === 1 ? 'track' : 'tracks'} added`);
  event.target.value = '';
});

$('#recommendationGrid').addEventListener('click', (event) => {
  const card = event.target.closest('[data-recommend]');
  if (card) playTrack(card.dataset.recommend);
});

$('#playerQueue').addEventListener('click', (event) => {
  const item = event.target.closest('[data-queue-id]');
  if (item) playTrack(item.dataset.queueId);
});

function setDrawer(open) {
  $('.player').classList.toggle('expanded', open);
  $('#playerDrawer').setAttribute('aria-hidden', String(!open));
}

$('.player').addEventListener('click', (event) => {
  if (event.target.closest('button,input,label,.player-drawer')) return;
  setDrawer(!$('.player').classList.contains('expanded'));
});
$('#closeDrawerBtn').addEventListener('click', () => setDrawer(false));

$('#trackList').addEventListener('click', (event) => {
  const menu = event.target.closest('[data-menu]');
  if (menu) {
    event.stopPropagation();
    const target = state.tracks.find(item => item.id === menu.dataset.menu);
    const nextState = !target?.menuOpen;
    state.tracks.forEach(track => { track.menuOpen = false; });
    if (target) target.menuOpen = nextState;
    render();
    return;
  }
  const cover = event.target.closest('[data-cover]');
  if (cover) {
    event.stopPropagation();
    coverTargetId = cover.dataset.cover;
    const track = state.tracks.find(item => item.id === coverTargetId);
    if (track) track.menuOpen = false;
    $('#coverInput').click();
    return;
  }
  const save = event.target.closest('[data-save]');
  if (save) {
    event.stopPropagation();
    const track = state.tracks.find(item => item.id === save.dataset.save);
    if (track) { track.saved = !track.saved; track.menuOpen = false; storeTrack(track); render(); toast(track.saved ? 'Added to My playlist' : 'Removed from My playlist'); }
    return;
  }
  const download = event.target.closest('[data-download]');
  if (download) {
    event.stopPropagation();
    const track = state.tracks.find(item => item.id === download.dataset.download);
    if (!track) return;
    track.menuOpen = false;
    const link = document.createElement('a');
    link.href = track.url;
    link.download = track.file.name;
    link.click();
    toast('Download started');
    return;
  }
  const remove = event.target.closest('[data-remove]');
  if (remove) {
    event.stopPropagation();
    const id = remove.dataset.remove;
    const track = state.tracks.find(item => item.id === id);
    if (track) { URL.revokeObjectURL(track.url); if (track.cover) URL.revokeObjectURL(track.cover); }
    state.tracks = state.tracks.filter(item => item.id !== id);
    deleteStoredTrack(id);
    if (state.currentId === id) { audio.pause(); audio.removeAttribute('src'); state.currentId = null; setPlaying(false); updateNowPlaying(null); }
    render();
    return;
  }
  const row = event.target.closest('[data-id]');
  if (row) playTrack(row.dataset.id);
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.track-actions') && state.tracks.some(track => track.menuOpen)) {
    state.tracks.forEach(track => { track.menuOpen = false; });
    render();
  }
});

$('#coverInput').addEventListener('change', (event) => {
  const file = event.target.files[0];
  const track = state.tracks.find(item => item.id === coverTargetId);
  if (file && track) {
    if (track.cover) URL.revokeObjectURL(track.cover);
    track.coverBlob = file;
    track.cover = URL.createObjectURL(file);
    storeTrack(track);
    render();
    if (track.id === state.currentId) updateNowPlaying(track);
    toast('Cover updated');
  }
  event.target.value = '';
  coverTargetId = null;
});

$('#trackList').addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-id]')) { event.preventDefault(); playTrack(event.target.dataset.id); } });
document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => { document.querySelector('.nav-item.active').classList.remove('active'); button.classList.add('active'); state.filter = button.dataset.filter; render(); }));
$('#playBtn').addEventListener('click', togglePlay);
$('#listViewBtn').addEventListener('click', () => { state.view = 'list'; localStorage.setItem('pulsedeck-view', 'list'); render(); });
$('#gridViewBtn').addEventListener('click', () => { state.view = 'grid'; localStorage.setItem('pulsedeck-view', 'grid'); render(); });
$('#prevBtn').addEventListener('click', () => move(-1));
$('#nextBtn').addEventListener('click', () => move(1));
$('#shuffleBtn').addEventListener('click', event => { state.shuffle = !state.shuffle; event.currentTarget.classList.toggle('active', state.shuffle); toast(`Shuffle ${state.shuffle ? 'on' : 'off'}`); });
$('#repeatBtn').addEventListener('click', event => { state.repeat = !state.repeat; event.currentTarget.classList.toggle('active', state.repeat); toast(`Repeat ${state.repeat ? 'on' : 'off'}`); });
$('#clearBtn').addEventListener('click', () => { state.tracks.forEach(track => { URL.revokeObjectURL(track.url); if (track.cover) URL.revokeObjectURL(track.cover); }); state.tracks = []; clearStoredTracks(); state.currentId = null; audio.pause(); audio.removeAttribute('src'); setPlaying(false); updateNowPlaying(null); if ('mediaSession' in navigator) navigator.mediaSession.metadata = null; render(); toast('Library cleared'); });
$('#volumeBar').addEventListener('input', event => { audio.volume = Number(event.target.value); localStorage.setItem('pulsedeck-volume', event.target.value); });
$('#seekBar').addEventListener('input', event => { if (audio.duration) audio.currentTime = audio.duration * (Number(event.target.value) / 100); });
$('#dataBtn').addEventListener('click', () => $('#dataDialog').showModal());
$('#closeDataBtn').addEventListener('click', () => $('#dataDialog').close());
$('#exportDataBtn').addEventListener('click', exportLibraryData);
$('#importDataBtn').addEventListener('click', () => $('#importInput').click());
$('#importInput').addEventListener('change', event => { const file = event.target.files[0]; if (file) importLibraryData(file); });
$('#dataDialog').addEventListener('click', event => { if (event.target === $('#dataDialog')) $('#dataDialog').close(); });
$('#themeBtn').addEventListener('click', () => { document.body.classList.toggle('light'); localStorage.setItem('pulsedeck-theme', document.body.classList.contains('light') ? 'light' : 'dark'); });
audio.addEventListener('play', () => { setPlaying(true); render(); });
audio.addEventListener('pause', () => setPlaying(false));
audio.addEventListener('ended', () => state.repeat ? playTrack(state.currentId) : move(1));
audio.addEventListener('timeupdate', () => {
  $('#currentTime').textContent = formatTime(audio.currentTime);
  $('#duration').textContent = formatTime(audio.duration);
  $('#seekBar').value = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  if ('mediaSession' in navigator && audio.duration && Number.isFinite(audio.duration)) {
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) }); } catch (_) {}
  }
});
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => move(-1));
  navigator.mediaSession.setActionHandler('nexttrack', () => move(1));
  navigator.mediaSession.setActionHandler('seekto', details => { if (details.seekTime != null) audio.currentTime = details.seekTime; });
}
document.addEventListener('keydown', event => { if (event.code === 'Space' && !['INPUT','BUTTON'].includes(document.activeElement.tagName)) { event.preventDefault(); togglePlay(); } });
const savedVolume = localStorage.getItem('pulsedeck-volume');
if (savedVolume !== null) $('#volumeBar').value = savedVolume;
if (localStorage.getItem('pulsedeck-theme') === 'light') document.body.classList.add('light');
restoreLibrary();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
