const $ = (selector) => document.querySelector(selector);
const audio = $('#audio');
const state = { tracks: [], playlists: [], queue: [], currentId: null, playbackContext: { type: 'library', id: null }, filter: 'all', selectedPlaylistId: null, shuffle: false, repeat: false, playing: false, view: localStorage.getItem('pulsedeck-view') || 'list' };
const icons = { play: '<path d="m9 6 9 6-9 6z"/>', pause: '<path d="M8 6h3v12H8zM14 6h3v12h-3z"/>' };
let coverTargetId = null;
let editTargetId = null;
let playlistEditId = null;
let playlistPickerTrackId = null;
let lyricsTargetId = null;
let suppressPlayerClickUntil = 0;
let playbackStartedAt = 0;
let lastStablePlaybackTime = 0;
let playbackRecoveryCount = 0;
const DB_NAME = 'pulsedeck-library';
const DB_VERSION = 1;

function saveCollections() {
  localStorage.setItem('lere-playlists', JSON.stringify(state.playlists));
  localStorage.setItem('lere-queue', JSON.stringify(state.queue));
}

function restoreCollections() {
  try { state.playlists = JSON.parse(localStorage.getItem('lere-playlists') || '[]'); } catch (_) { state.playlists = []; }
  try { state.queue = JSON.parse(localStorage.getItem('lere-queue') || '[]'); } catch (_) { state.queue = []; }
  if (!Array.isArray(state.playlists)) state.playlists = [];
  if (!Array.isArray(state.queue)) state.queue = [];
}

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
  const record = { id: track.id, title: track.title, artist: track.artist, album: track.album, lyrics: track.lyrics || '', file: track.file, coverBlob: track.coverBlob || null, saved: track.saved, addedAt: track.addedAt, playCount: Number(track.playCount) || 0, lastPlayedAt: Number(track.lastPlayedAt) || 0 };
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
    state.tracks = records.sort((a, b) => a.addedAt - b.addedAt).map(record => ({ ...record, playCount: Number(record.playCount) || 0, lastPlayedAt: Number(record.lastPlayedAt) || 0, url: createAudioUrl(record.file), cover: record.coverBlob ? URL.createObjectURL(record.coverBlob) : '' }));
    const validIds = new Set(state.tracks.map(track => track.id));
    state.playlists.forEach(playlist => { playlist.trackIds = (playlist.trackIds || []).filter(id => validIds.has(id)); });
    state.queue = state.queue.filter(id => validIds.has(id));
    if (!state.playlists.length) {
      const legacy = state.tracks.filter(track => track.saved).map(track => track.id);
      if (legacy.length) state.playlists.push({ id: crypto.randomUUID(), name: 'My playlist', trackIds: legacy });
    }
    saveCollections();
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

function audioMimeType(file) {
  if (file?.type?.startsWith('audio/')) return file.type;
  const extension = file?.name?.split('.').pop()?.toLowerCase();
  return ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm' })[extension] || file?.type || 'audio/mpeg';
}

function createAudioUrl(file) {
  return URL.createObjectURL(file.type === audioMimeType(file) ? file : new Blob([file], { type: audioMimeType(file) }));
}

async function exportLibraryData() {
  try {
    $('#exportDataBtn').disabled = true;
    const tracks = await Promise.all(state.tracks.map(async (track) => ({
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      lyrics: track.lyrics || '',
      saved: track.saved,
      addedAt: track.addedAt,
      playCount: Number(track.playCount) || 0,
      lastPlayedAt: Number(track.lastPlayedAt) || 0,
      audio: { name: track.file.name, type: track.file.type, lastModified: track.file.lastModified, data: await blobToDataUrl(track.file) },
      cover: track.coverBlob ? { type: track.coverBlob.type, data: await blobToDataUrl(track.coverBlob) } : null
    })));
    const backup = {
      app: 'Lere', version: 1, exportedAt: new Date().toISOString(), tracks,
      playlists: state.playlists, queue: state.queue,
      settings: { theme: document.body.classList.contains('light') ? 'light' : 'dark', volume: $('#volumeBar').value, view: state.view }
    };
    const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `lere-backup-${new Date().toISOString().slice(0, 10)}.lere.json`;
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
    $('#importDataBtn').setAttribute('aria-disabled', 'true');
    for (const item of backup.tracks) {
      if (!item.audio?.data || !item.audio?.name) continue;
      const audioBlob = dataUrlToBlob(item.audio.data);
      const audioFile = new File([audioBlob], item.audio.name, { type: item.audio.type || audioBlob.type, lastModified: item.audio.lastModified || Date.now() });
      const coverBlob = item.cover?.data ? dataUrlToBlob(item.cover.data) : null;
      const track = {
        id: item.id || crypto.randomUUID(), title: item.title || item.audio.name.replace(/\.[^.]+$/, ''), artist: item.artist || 'Uploaded audio',
        album: item.album || '', lyrics: item.lyrics || '', saved: Boolean(item.saved), addedAt: item.addedAt || Date.now(), playCount: Number(item.playCount) || 0, lastPlayedAt: Number(item.lastPlayedAt) || 0, file: audioFile, coverBlob,
        url: createAudioUrl(audioFile), cover: coverBlob ? URL.createObjectURL(coverBlob) : ''
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
    if (Array.isArray(backup.playlists)) state.playlists = backup.playlists.map(playlist => ({ id: playlist.id || crypto.randomUUID(), name: playlist.name || 'Playlist', trackIds: Array.isArray(playlist.trackIds) ? playlist.trackIds : [] }));
    if (Array.isArray(backup.queue)) state.queue = backup.queue;
    saveCollections();
    render();
    $('#dataDialog').close();
    toast(`${backup.tracks.length} ${backup.tracks.length === 1 ? 'track' : 'tracks'} imported`);
  } catch (_) { toast('This is not a valid Lere backup.'); }
  finally { $('#importDataBtn').removeAttribute('aria-disabled'); $('#importInput').value = ''; }
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

function loadArtworkImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Artwork could not be decoded')); };
    image.src = url;
  });
}

async function mediaArtwork(track) {
  const fallbackArtwork = new URL('./icon-512.png', window.location.href).href;
  if (!track?.coverBlob) return { src: fallbackArtwork, sizes: '512x512', type: 'image/png' };
  if (!track.mediaArtworkDataUrl) {
    const image = await loadArtworkImage(track.coverBlob);
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    const scale = Math.max(512 / image.naturalWidth, 512 / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.fillStyle = '#0b0d12';
    context.fillRect(0, 0, 512, 512);
    context.drawImage(image, (512 - width) / 2, (512 - height) / 2, width, height);
    track.mediaArtworkDataUrl = canvas.toDataURL('image/jpeg', 0.9);
  }
  return { src: track.mediaArtworkDataUrl, sizes: '512x512', type: 'image/jpeg' };
}

async function syncMediaSession(track, playbackState = audio.paused ? 'paused' : 'playing') {
  if (!('mediaSession' in navigator) || !track || typeof MediaMetadata === 'undefined') return;
  const publish = (artwork) => {
    const metadata = { title: track.title, artist: track.artist, album: track.album || 'Lere Library' };
    if (artwork?.length) metadata.artwork = artwork;
    try { navigator.mediaSession.metadata = new MediaMetadata(metadata); }
    catch (_) { try { navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: track.album || 'Lere Library' }); } catch (_) {} }
  };
  publish();
  try { navigator.mediaSession.playbackState = playbackState; } catch (_) {}
  try {
    const artwork = await mediaArtwork(track);
    if (currentTrack()?.id === track.id) publish([artwork]);
  } catch (_) { publish([{ src: new URL('./icon-512.png', window.location.href).href, sizes: '512x512', type: 'image/png' }]); }
  try { navigator.mediaSession.playbackState = playbackState; } catch (_) {}
}

function syncMediaPosition() {
  if (!('mediaSession' in navigator) || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.max(0, Math.min(audio.currentTime, audio.duration))
    });
  } catch (_) {}
}

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
  if (track) {
    audio.title = `${track.title} — ${track.artist}`;
    syncMediaSession(track);
  } else {
    audio.removeAttribute('title');
    if ('mediaSession' in navigator) { try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } catch (_) {} }
  }
  renderLyrics(track);
}

function parseLyrics(text = '') {
  const synced = [];
  const plain = [];
  text.split(/\r?\n/).forEach(line => {
    const matches = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const words = line.replace(/\[[^\]]+\]/g, '').trim();
    if (matches.length && words) matches.forEach(match => synced.push({ time: Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] || 0}`), text: words }));
    else if (line.trim()) plain.push(line.trim());
  });
  return synced.length ? { synced: true, lines: synced.sort((a, b) => a.time - b.time) } : { synced: false, lines: plain.map(text => ({ text })) };
}

function renderLyrics(track = currentTrack()) {
  const content = $('#lyricsContent');
  const addButton = $('#addLyricsFromPlayerBtn');
  if (!track?.lyrics) { content.innerHTML = '<div class="lyrics-empty">No lyrics saved for this song.<br>Add plain text or synchronized LRC lyrics.</div>'; addButton.hidden = !track; return; }
  const parsed = parseLyrics(track.lyrics);
  content.dataset.synced = String(parsed.synced);
  content.innerHTML = parsed.lines.map((line, index) => line.time != null
    ? `<button class="lyric-line" data-lyric-index="${index}" data-time="${line.time}" aria-label="Play from ${formatTime(line.time)}: ${escapeHtml(line.text)}">${escapeHtml(line.text)}</button>`
    : `<p class="lyric-line" data-lyric-index="${index}">${escapeHtml(line.text)}</p>`).join('');
  addButton.hidden = false;
  addButton.textContent = 'Edit lyrics';
}

function updateSyncedLyrics() {
  if ($('#lyricsPanel').hidden || $('#lyricsContent').dataset.synced !== 'true') return;
  const lines = [...$('#lyricsContent').querySelectorAll('[data-time]')];
  let active = -1;
  lines.forEach((line, index) => { if (Number(line.dataset.time) <= audio.currentTime) active = index; });
  lines.forEach((line, index) => line.classList.toggle('active', index === active));
  if (active >= 0 && lines[active] !== updateSyncedLyrics.last) { updateSyncedLyrics.last = lines[active]; lines[active].scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

function recommendationScore(candidate, current) {
  if (!current) return candidate.addedAt;
  const tokens = (name) => new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2));
  const currentTokens = tokens(`${current.title} ${current.artist} ${current.album || ''}`);
  const overlap = [...tokens(`${candidate.title} ${candidate.artist} ${candidate.album || ''}`)].filter(word => currentTokens.has(word)).length;
  const sameFormat = candidate.file.type === current.file.type ? 2 : 0;
  const sizeSimilarity = 1 - Math.min(Math.abs(candidate.file.size - current.file.size) / Math.max(candidate.file.size, current.file.size), 1);
  return overlap * 5 + sameFormat + sizeSimilarity;
}

function getRecommendations() {
  const current = currentTrack();
  const picks = [];
  const used = new Set();
  const add = (track, reason) => {
    if (!track || used.has(track.id) || picks.length >= 4) return;
    used.add(track.id);
    picks.push({ track, reason });
  };

  [...state.tracks]
    .filter(track => Number(track.playCount) > 0)
    .sort((a, b) => (Number(b.playCount) - Number(a.playCount)) || (Number(b.lastPlayedAt) - Number(a.lastPlayedAt)))
    .slice(0, 2)
    .forEach(track => add(track, `Most played · ${track.playCount} ${track.playCount === 1 ? 'play' : 'plays'}`));

  const recent = [...state.tracks]
    .filter(track => Number(track.lastPlayedAt) > 0)
    .sort((a, b) => Number(b.lastPlayedAt) - Number(a.lastPlayedAt));
  add(recent.find(track => !used.has(track.id)), 'Recently played');

  [...state.tracks]
    .filter(track => track.id !== current?.id)
    .map(track => ({ track, score: recommendationScore(track, current) }))
    .sort((a, b) => b.score - a.score)
    .forEach(({ track }) => add(track, current ? `More like ${current.title}` : 'From your collection'));

  [...state.tracks]
    .sort((a, b) => Number(b.addedAt) - Number(a.addedAt))
    .forEach(track => add(track, 'Recently added'));

  return picks;
}

function renderRecommendations() {
  const grid = $('#recommendationGrid');
  const picks = getRecommendations();
  if (!picks.length) {
    grid.innerHTML = '<div class="recommendation-empty">Upload music to get recommendations from your collection.</div>';
    return;
  }
  const colors = ['red', 'coral', 'blue', 'amber'];
  grid.innerHTML = picks.map(({ track, reason }, index) => `
    <button class="recommendation-card ${colors[index]} ${track.cover ? 'has-cover' : ''}" ${track.cover ? `style="background-image:linear-gradient(0deg,#090a0ee8,#090a0e22),url('${track.cover}')"` : ''} data-recommend="${track.id}" aria-label="Play recommended track ${escapeHtml(track.title)}">
      <span>${escapeHtml(track.title)}</span>
      <small>${escapeHtml(reason)}</small>
      <svg viewBox="0 0 24 24"><path d="m9 6 9 6-9 6z"/></svg>
    </button>`).join('');
}

function renderPlayerQueue() {
  const queue = $('#playerQueue');
  const queuedTracks = state.queue.map(id => state.tracks.find(track => track.id === id)).filter(Boolean);
  if (!queuedTracks.length) { queue.innerHTML = '<div class="queue-empty">Your queue is empty. Add songs from their ••• menu.</div>'; return; }
  queue.innerHTML = queuedTracks.map((track, index) => `
    <div class="queue-item ${track.id === state.currentId ? 'active' : ''}" data-queue-id="${track.id}" draggable="true">
      <span class="queue-handle" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/></svg></span>
      <span class="queue-cover" ${track.cover ? `style="background-image:url('${track.cover}')"` : ''}>${track.cover ? '' : '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>'}</span>
      <button class="queue-copy" data-play-queue="${track.id}"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.artist)}</span></button>
      <span class="queue-controls"><button data-queue-up="${track.id}" aria-label="Move ${escapeHtml(track.title)} up"><svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg></button><button data-queue-down="${track.id}" aria-label="Move ${escapeHtml(track.title)} down"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button><button data-queue-remove="${track.id}" aria-label="Remove ${escapeHtml(track.title)} from queue"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></span>
    </div>`).join('');
}

function renderPlaylistNav() {
  $('#playlistNav').innerHTML = `${state.playlists.map(playlist => `<button data-open-playlist="${playlist.id}" class="${state.selectedPlaylistId === playlist.id ? 'active' : ''}">${escapeHtml(playlist.name)}</button>`).join('')}<button class="new-playlist" data-new-playlist>+ New playlist</button>`;
}

function activePlaylist() { return state.playlists.find(playlist => playlist.id === state.selectedPlaylistId); }

function render() {
  const playlist = activePlaylist();
  const visible = state.filter === 'playlist' && playlist
    ? playlist.trackIds.map(id => state.tracks.find(track => track.id === id)).filter(Boolean)
    : state.tracks;
  $('#trackList').classList.toggle('grid-view', state.view === 'grid');
  $('#listViewBtn').classList.toggle('active', state.view === 'list');
  $('#gridViewBtn').classList.toggle('active', state.view === 'grid');
  $('#library-title').textContent = state.filter === 'playlist' && playlist ? playlist.name : state.filter === 'local' ? 'On this device' : 'Your library';
  $('#editPlaylistBtn').hidden = !(state.filter === 'playlist' && playlist);
  $('#addPlaylistSongsBtn').hidden = !(state.filter === 'playlist' && playlist);
  $('#trackCount').textContent = `${visible.length} ${visible.length === 1 ? 'track' : 'tracks'}`;
  $('#emptyState').hidden = visible.length > 0;
  $('#trackList').innerHTML = visible.map((track, index) => `
    <article class="track ${playlist ? 'playlist-track' : ''} ${track.id === state.currentId ? 'active' : ''}" role="listitem" data-id="${track.id}" ${playlist ? 'draggable="true"' : ''} tabindex="0" aria-label="Play ${escapeHtml(track.title)}">
      <span class="track-number ${track.cover ? 'has-cover' : ''}" ${track.cover ? `style="background-image:url('${track.cover}')"` : ''}>${track.id === state.currentId && state.playing ? '<svg viewBox="0 0 24 24"><path d="M6 9v6M12 6v12M18 9v6"/></svg>' : track.cover ? '' : String(index + 1).padStart(2, '0')}</span>
      <div class="track-info"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.artist)}</span></div>
      <div class="track-actions">
        <button class="track-action menu-trigger" data-menu="${track.id}" aria-label="Actions for ${escapeHtml(track.title)}" aria-expanded="${Boolean(track.menuOpen)}"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button>
        <div class="track-menu ${track.menuOpen ? 'open' : ''}">
          <button data-edit="${track.id}"><svg viewBox="0 0 24 24"><path d="M4 20h4l11-11-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>Edit details</button>
          <button data-lyrics="${track.id}"><svg viewBox="0 0 24 24"><path d="M5 5h14M5 10h14M5 15h9M5 20h6"/></svg>${track.lyrics ? 'Edit lyrics' : 'Add lyrics'}</button>
          <button data-cover="${track.id}"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 17 5-5 4 4 2-2 5 4"/></svg>${track.cover ? 'Change cover' : 'Add cover'}</button>
          <button data-add-playlist="${track.id}"><svg viewBox="0 0 24 24"><path d="M5 4h14v17l-7-4-7 4z"/></svg>Add to playlist</button>
          <button data-add-queue="${track.id}"><svg viewBox="0 0 24 24"><path d="M4 6h11M4 11h11M4 16h7M19 13v7m-3-3h6"/></svg>Add to queue</button>
          ${playlist ? `<button data-remove-playlist="${track.id}"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>Remove from this playlist</button>` : ''}
          <button data-download="${track.id}"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 5-5m-5 5-5-5"/></svg>Download</button>
          <button class="danger" data-remove="${track.id}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>Remove</button>
        </div>
      </div>${playlist ? `<div class="reorder-controls"><button data-playlist-up="${track.id}" aria-label="Move up"><svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg></button><button data-playlist-down="${track.id}" aria-label="Move down"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button></div>` : ''}
    </article>`).join('');
  renderPlaylistNav();
  renderRecommendations();
  renderPlayerQueue();
}

function playTrack(id, context = null) {
  const track = state.tracks.find(item => item.id === id);
  if (!track) return;
  if (context && context.type !== 'queue') {
    const sourceOrder = context.type === 'playlist'
      ? state.playlists.find(playlist => playlist.id === context.id)?.trackIds || []
      : state.tracks.map(item => item.id);
    const validOrder = sourceOrder.filter(trackId => state.tracks.some(item => item.id === trackId));
    const startIndex = validOrder.indexOf(id);
    state.queue = startIndex >= 0 ? [...validOrder.slice(startIndex), ...validOrder.slice(0, startIndex)] : [id, ...validOrder];
    state.playbackContext = { type: 'queue', id: null };
    saveCollections();
  } else if (context) state.playbackContext = context;
  audio.pause();
  state.currentId = id;
  playbackStartedAt = Date.now();
  lastStablePlaybackTime = 0;
  playbackRecoveryCount = 0;
  if (track.url) URL.revokeObjectURL(track.url);
  track.url = createAudioUrl(track.file);
  audio.src = track.url;
  audio.load();
  audio.volume = Number($('#volumeBar').value);
  updateNowPlaying(track);
  audio.play().then(() => {
    setPlaying(true);
    track.playCount = (Number(track.playCount) || 0) + 1;
    track.lastPlayedAt = Date.now();
    storeTrack(track).catch(() => {});
    renderRecommendations();
  }).catch(() => toast('Could not play this audio file.'));
  render();
}

function togglePlay() {
  const track = currentTrack();
  if (!track) { if (state.tracks[0]) playTrack(state.tracks[0].id, { type: 'library', id: null }); return; }
  if (audio.paused) audio.play(); else audio.pause();
}

function move(direction) {
  let order;
  if (state.playbackContext.type === 'playlist') {
    order = state.playlists.find(playlist => playlist.id === state.playbackContext.id)?.trackIds || [];
  } else if (state.playbackContext.type === 'queue') {
    order = state.queue;
  } else order = state.tracks.map(track => track.id);
  order = order.filter(id => state.tracks.some(track => track.id === id));
  if (!order.length) return;
  const currentIndex = order.indexOf(state.currentId);
  if (currentIndex < 0) { playTrack(order[direction > 0 ? 0 : order.length - 1]); return; }
  const nextIndex = state.shuffle ? Math.floor(Math.random() * order.length) : (currentIndex + direction + order.length) % order.length;
  playTrack(order[nextIndex]);
}

function moveItem(list, id, direction) {
  const index = list.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= list.length) return false;
  [list[index], list[target]] = [list[target], list[index]];
  return true;
}

function isAudioFile(file) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  return file.type.startsWith('audio/') || ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'webm'].includes(extension);
}

function previousTrack() {
  if (!currentTrack()) return;
  if (audio.currentTime > 2) {
    audio.currentTime = 0;
    if (audio.paused) audio.play().catch(() => {});
    return;
  }
  move(-1);
}

$('#fileInput').addEventListener('change', async (event) => {
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  const selectedFiles = [...event.target.files];
  const files = selectedFiles.filter(isAudioFile);
  if (!files.length && selectedFiles.length) { toast('Choose an audio file from the Files app.'); event.target.value = ''; return; }
  const tracks = await Promise.all(files.map(async (file, index) => {
    let metadata = {};
    try { metadata = await readEmbeddedMetadata(file); } catch (_) {}
    return {
      id: crypto.randomUUID(),
      title: metadata.title || file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim(),
      artist: metadata.artist || 'Uploaded audio',
      album: metadata.album || '',
      lyrics: '',
      cover: metadata.cover || '',
      coverBlob: metadata.coverBlob || null,
      url: createAudioUrl(file),
      file,
      saved: false,
      addedAt: Date.now() + index,
      playCount: 0,
      lastPlayedAt: 0
    };
  }));
  state.tracks.push(...tracks);
  await Promise.all(tracks.map(storeTrack));
  render();
  if (files.length) toast(`${files.length} ${files.length === 1 ? 'track' : 'tracks'} added${files.length < selectedFiles.length ? '; non-audio files skipped' : ''}`);
  event.target.value = '';
});

$('#recommendationGrid').addEventListener('click', (event) => {
  const card = event.target.closest('[data-recommend]');
  if (card) playTrack(card.dataset.recommend, { type: 'library', id: null });
});

$('#playerQueue').addEventListener('click', (event) => {
  const play = event.target.closest('[data-play-queue]');
  if (play) { playTrack(play.dataset.playQueue, { type: 'queue', id: null }); return; }
  const up = event.target.closest('[data-queue-up]');
  const down = event.target.closest('[data-queue-down]');
  const remove = event.target.closest('[data-queue-remove]');
  if (up && moveItem(state.queue, up.dataset.queueUp, -1)) { saveCollections(); renderPlayerQueue(); }
  if (down && moveItem(state.queue, down.dataset.queueDown, 1)) { saveCollections(); renderPlayerQueue(); }
  if (remove) { state.queue = state.queue.filter(id => id !== remove.dataset.queueRemove); saveCollections(); renderPlayerQueue(); toast('Removed from queue'); }
});

function enableReordering(container, getList) {
  let draggedId = null;
  container.addEventListener('dragstart', event => { const item = event.target.closest('[draggable=true]'); if (!item) return; draggedId = item.dataset.id || item.dataset.queueId; item.classList.add('dragging'); });
  container.addEventListener('dragover', event => { const item = event.target.closest('[draggable=true]'); if (!item) return; event.preventDefault(); item.classList.add('drag-over'); });
  container.addEventListener('dragleave', event => event.target.closest('[draggable=true]')?.classList.remove('drag-over'));
  container.addEventListener('drop', event => { const item = event.target.closest('[draggable=true]'); if (!item || !draggedId) return; event.preventDefault(); const targetId = item.dataset.id || item.dataset.queueId; const list = getList(); const from = list.indexOf(draggedId); const to = list.indexOf(targetId); if (from >= 0 && to >= 0 && from !== to) { list.splice(to, 0, list.splice(from, 1)[0]); saveCollections(); render(); } });
  container.addEventListener('dragend', () => { draggedId = null; container.querySelectorAll('.dragging,.drag-over').forEach(item => item.classList.remove('dragging', 'drag-over')); });
}
enableReordering($('#playerQueue'), () => state.queue);
enableReordering($('#trackList'), () => activePlaylist()?.trackIds || []);

function setDrawer(open) {
  $('.player').classList.toggle('expanded', open);
  if (!open) $('.player').classList.remove('lyrics-mode');
  document.body.classList.toggle('drawer-open', open);
  $('#playerDrawer').setAttribute('aria-hidden', String(!open));
}

$('.player').addEventListener('click', (event) => {
  if (Date.now() < suppressPlayerClickUntil) return;
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
  const edit = event.target.closest('[data-edit]');
  if (edit) {
    event.stopPropagation();
    const track = state.tracks.find(item => item.id === edit.dataset.edit);
    if (track) {
      editTargetId = track.id;
      track.menuOpen = false;
      $('#editTitle').value = track.title;
      $('#editArtist').value = track.artist;
      $('#editDialog').showModal();
      requestAnimationFrame(() => $('#editTitle').focus());
    }
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
  const lyrics = event.target.closest('[data-lyrics]');
  if (lyrics) { event.stopPropagation(); openLyricsDialog(lyrics.dataset.lyrics); return; }
  const addPlaylist = event.target.closest('[data-add-playlist]');
  if (addPlaylist) {
    event.stopPropagation();
    playlistPickerTrackId = addPlaylist.dataset.addPlaylist;
    state.tracks.forEach(track => { track.menuOpen = false; });
    $('#playlistPicker').innerHTML = state.playlists.length ? state.playlists.map(playlist => `<button data-pick-playlist="${playlist.id}">${escapeHtml(playlist.name)} <small>${playlist.trackIds.length} tracks</small></button>`).join('') : '<div class="playlist-picker-empty">Create a playlist first.</div><button data-create-from-picker>+ New playlist</button>';
    $('#playlistPickerDialog').showModal();
    render();
    return;
  }
  const addQueue = event.target.closest('[data-add-queue]');
  if (addQueue) {
    event.stopPropagation();
    const id = addQueue.dataset.addQueue;
    if (state.currentId && !state.queue.includes(state.currentId)) state.queue.unshift(state.currentId);
    if (!state.queue.includes(id)) state.queue.push(id);
    if (state.currentId) state.playbackContext = { type: 'queue', id: null };
    saveCollections();
    state.tracks.forEach(track => { track.menuOpen = false; });
    render();
    toast('Added to queue');
    return;
  }
  const removePlaylist = event.target.closest('[data-remove-playlist]');
  if (removePlaylist) { event.stopPropagation(); const playlist = activePlaylist(); if (playlist) playlist.trackIds = playlist.trackIds.filter(id => id !== removePlaylist.dataset.removePlaylist); saveCollections(); render(); toast('Removed from playlist'); return; }
  const playlistUp = event.target.closest('[data-playlist-up]');
  const playlistDown = event.target.closest('[data-playlist-down]');
  if (playlistUp || playlistDown) { event.stopPropagation(); const playlist = activePlaylist(); const id = playlistUp?.dataset.playlistUp || playlistDown.dataset.playlistDown; if (playlist && moveItem(playlist.trackIds, id, playlistUp ? -1 : 1)) { saveCollections(); render(); } return; }
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
    state.playlists.forEach(playlist => { playlist.trackIds = playlist.trackIds.filter(trackId => trackId !== id); });
    state.queue = state.queue.filter(trackId => trackId !== id);
    saveCollections();
    deleteStoredTrack(id);
    if (state.currentId === id) { audio.pause(); audio.removeAttribute('src'); state.currentId = null; setPlaying(false); updateNowPlaying(null); }
    render();
    return;
  }
  const row = event.target.closest('[data-id]');
  if (row) playTrack(row.dataset.id, state.filter === 'playlist' && activePlaylist() ? { type: 'playlist', id: state.selectedPlaylistId } : { type: 'library', id: null });
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
    track.mediaArtworkDataUrl = '';
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

$('#trackList').addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-id]')) { event.preventDefault(); playTrack(event.target.dataset.id, state.filter === 'playlist' && activePlaylist() ? { type: 'playlist', id: state.selectedPlaylistId } : { type: 'library', id: null }); } });
document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => {
  document.querySelector('.nav-item.active')?.classList.remove('active');
  button.classList.add('active');
  if (button.dataset.filter === 'playlists') {
    if (!state.playlists.length) { openPlaylistDialog(); return; }
    state.selectedPlaylistId = state.selectedPlaylistId || state.playlists[0].id;
    state.filter = 'playlist';
  } else state.filter = button.dataset.filter;
  render();
}));
$('#playlistNav').addEventListener('click', event => {
  const open = event.target.closest('[data-open-playlist]');
  if (open) { state.selectedPlaylistId = open.dataset.openPlaylist; state.filter = 'playlist'; document.querySelector('.nav-item.active')?.classList.remove('active'); $('#playlistsNav').classList.add('active'); render(); }
  if (event.target.closest('[data-new-playlist]')) openPlaylistDialog();
});

function openPlaylistDialog(id = null) {
  playlistEditId = id;
  const playlist = state.playlists.find(item => item.id === id);
  $('#playlistDialogTitle').textContent = playlist ? 'Edit playlist' : 'New playlist';
  $('#playlistName').value = playlist?.name || '';
  $('#deletePlaylistBtn').hidden = !playlist;
  $('#playlistDialog').showModal();
  requestAnimationFrame(() => $('#playlistName').focus());
}
function closePlaylistDialog() { $('#playlistDialog').close(); playlistEditId = null; }
$('#editPlaylistBtn').addEventListener('click', () => openPlaylistDialog(state.selectedPlaylistId));
function renderPlaylistSongsPicker() {
  const playlist = activePlaylist();
  const picker = $('#playlistSongsPicker');
  if (!playlist || !state.tracks.length) {
    picker.innerHTML = '<div class="playlist-picker-empty">Upload songs first, then add them here.</div>';
    return;
  }
  picker.innerHTML = state.tracks.map(track => {
    const added = playlist.trackIds.includes(track.id);
    return `<button data-toggle-playlist-song="${track.id}" class="${added ? 'added' : ''}" aria-pressed="${added}">
      <span class="picker-cover" ${track.cover ? `style="background-image:url('${track.cover}')"` : ''}>${track.cover ? '' : '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>'}</span>
      <span class="picker-song-copy"><strong>${escapeHtml(track.title)}</strong><small>${escapeHtml(track.artist)}</small></span>
      <span class="picker-check"><svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg></span>
    </button>`;
  }).join('');
}
$('#addPlaylistSongsBtn').addEventListener('click', () => { renderPlaylistSongsPicker(); $('#playlistSongsDialog').showModal(); });
$('#closePlaylistSongsBtn').addEventListener('click', () => $('#playlistSongsDialog').close());
$('#playlistSongsPicker').addEventListener('click', event => {
  const button = event.target.closest('[data-toggle-playlist-song]');
  const playlist = activePlaylist();
  if (!button || !playlist) return;
  const id = button.dataset.togglePlaylistSong;
  if (playlist.trackIds.includes(id)) playlist.trackIds = playlist.trackIds.filter(trackId => trackId !== id);
  else playlist.trackIds.push(id);
  saveCollections();
  renderPlaylistSongsPicker();
  render();
});
$('#closePlaylistBtn').addEventListener('click', closePlaylistDialog);
$('#cancelPlaylistBtn').addEventListener('click', closePlaylistDialog);
$('#playlistForm').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('#playlistName').value.trim();
  if (!name) return;
  if (playlistEditId) state.playlists.find(item => item.id === playlistEditId).name = name;
  else { const playlist = { id: crypto.randomUUID(), name, trackIds: [] }; state.playlists.push(playlist); state.selectedPlaylistId = playlist.id; state.filter = 'playlist'; $('#playlistsNav').classList.add('active'); }
  saveCollections(); closePlaylistDialog(); render(); toast('Playlist saved');
});
$('#deletePlaylistBtn').addEventListener('click', () => {
  if (!playlistEditId) return;
  if (state.playbackContext.type === 'playlist' && state.playbackContext.id === playlistEditId) state.playbackContext = { type: 'library', id: null };
  state.playlists = state.playlists.filter(item => item.id !== playlistEditId);
  state.selectedPlaylistId = state.playlists[0]?.id || null;
  state.filter = state.selectedPlaylistId ? 'playlist' : 'all';
  saveCollections(); closePlaylistDialog(); render(); toast('Playlist deleted');
});
$('#closePlaylistPickerBtn').addEventListener('click', () => $('#playlistPickerDialog').close());
$('#playlistPicker').addEventListener('click', event => {
  const pick = event.target.closest('[data-pick-playlist]');
  if (pick) { const playlist = state.playlists.find(item => item.id === pick.dataset.pickPlaylist); if (playlist && !playlist.trackIds.includes(playlistPickerTrackId)) playlist.trackIds.push(playlistPickerTrackId); saveCollections(); $('#playlistPickerDialog').close(); render(); toast('Added to playlist'); }
  if (event.target.closest('[data-create-from-picker]')) { $('#playlistPickerDialog').close(); openPlaylistDialog(); }
});
function setDrawerPanel(panel) {
  const lyricsOpen = panel === 'lyrics';
  $('.player').classList.toggle('lyrics-mode', lyricsOpen);
  $('#playerQueue').hidden = lyricsOpen;
  $('#lyricsPanel').hidden = !lyricsOpen;
  $('#queueTabBtn').classList.toggle('active', !lyricsOpen);
  $('#lyricsTabBtn').classList.toggle('active', lyricsOpen);
  $('#queueTabBtn').setAttribute('aria-selected', String(!lyricsOpen));
  $('#lyricsTabBtn').setAttribute('aria-selected', String(lyricsOpen));
  $('#drawerPanelTitle').textContent = lyricsOpen ? 'Lyrics' : 'Queue';
  if (lyricsOpen) { renderLyrics(); updateSyncedLyrics(); }
}
$('#queueTabBtn').addEventListener('click', () => setDrawerPanel('queue'));
$('#lyricsTabBtn').addEventListener('click', () => setDrawerPanel('lyrics'));
$('#lyricsContent').addEventListener('click', event => {
  const line = event.target.closest('[data-time]');
  if (!line || !currentTrack()) return;
  audio.currentTime = Number(line.dataset.time);
  audio.play().catch(() => {});
  updateSyncedLyrics.last = null;
  updateSyncedLyrics();
});

let playerTouchStart = null;
$('.player').addEventListener('touchstart', event => {
  if (event.touches.length !== 1) { playerTouchStart = null; return; }
  const touch = event.touches[0];
  playerTouchStart = { x: touch.clientX, y: touch.clientY, target: event.target, time: Date.now() };
}, { passive: true });
$('.player').addEventListener('touchend', event => {
  if (!playerTouchStart || !event.changedTouches[0]) return;
  const touch = event.changedTouches[0];
  const deltaX = touch.clientX - playerTouchStart.x;
  const deltaY = touch.clientY - playerTouchStart.y;
  const player = $('.player');
  const startedInLyrics = playerTouchStart.target.closest?.('.lyrics-panel');
  const lyricsAtTop = $('#lyricsPanel').scrollTop <= 2;
  playerTouchStart = null;
  if (Math.abs(deltaY) < 75 || Math.abs(deltaY) <= Math.abs(deltaX) * 1.35) return;
  if (deltaY < 0 && !player.classList.contains('expanded')) { suppressPlayerClickUntil = Date.now() + 500; setDrawer(true); }
  if (deltaY > 0 && player.classList.contains('expanded') && (!startedInLyrics || lyricsAtTop)) { suppressPlayerClickUntil = Date.now() + 500; setDrawer(false); }
}, { passive: true });
$('.player').addEventListener('touchcancel', () => { playerTouchStart = null; }, { passive: true });
function openLyricsDialog(id) {
  const track = state.tracks.find(item => item.id === id);
  if (!track) return;
  lyricsTargetId = id;
  track.menuOpen = false;
  $('#lyricsText').value = track.lyrics || '';
  $('#lyricsDialog').showModal();
  requestAnimationFrame(() => $('#lyricsText').focus());
}
function closeLyricsDialog() { $('#lyricsDialog').close(); lyricsTargetId = null; }
$('#addLyricsFromPlayerBtn').addEventListener('click', () => { if (state.currentId) openLyricsDialog(state.currentId); });
$('#closeLyricsBtn').addEventListener('click', closeLyricsDialog);
$('#cancelLyricsBtn').addEventListener('click', closeLyricsDialog);
$('#lyricsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const track = state.tracks.find(item => item.id === lyricsTargetId);
  if (!track) return;
  track.lyrics = $('#lyricsText').value.trim();
  await storeTrack(track); closeLyricsDialog(); render(); renderLyrics(track); toast('Lyrics saved');
});
$('#clearLyricsBtn').addEventListener('click', async () => {
  const track = state.tracks.find(item => item.id === lyricsTargetId);
  if (!track) return;
  track.lyrics = ''; await storeTrack(track); closeLyricsDialog(); render(); renderLyrics(track); toast('Lyrics cleared');
});
$('#playBtn').addEventListener('click', togglePlay);
$('#listViewBtn').addEventListener('click', () => { state.view = 'list'; localStorage.setItem('pulsedeck-view', 'list'); render(); });
$('#gridViewBtn').addEventListener('click', () => { state.view = 'grid'; localStorage.setItem('pulsedeck-view', 'grid'); render(); });
$('#prevBtn').addEventListener('click', previousTrack);
$('#nextBtn').addEventListener('click', () => move(1));
$('#shuffleBtn').addEventListener('click', event => { state.shuffle = !state.shuffle; event.currentTarget.classList.toggle('active', state.shuffle); toast(`Shuffle ${state.shuffle ? 'on' : 'off'}`); });
$('#repeatBtn').addEventListener('click', event => { state.repeat = !state.repeat; event.currentTarget.classList.toggle('active', state.repeat); toast(`Repeat ${state.repeat ? 'on' : 'off'}`); });
$('#clearBtn').addEventListener('click', () => { state.queue = []; saveCollections(); renderPlayerQueue(); toast('Queue cleared'); });
$('#volumeBar').addEventListener('input', event => { audio.volume = Number(event.target.value); localStorage.setItem('pulsedeck-volume', event.target.value); });
$('#seekBar').addEventListener('input', event => { if (audio.duration) audio.currentTime = audio.duration * (Number(event.target.value) / 100); });
$('#dataBtn').addEventListener('click', () => $('#dataDialog').showModal());
$('#closeDataBtn').addEventListener('click', () => $('#dataDialog').close());
$('#exportDataBtn').addEventListener('click', exportLibraryData);
$('#importDataBtn').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('#importInput').click(); } });
$('#importInput').addEventListener('change', event => { const file = event.target.files[0]; if (file) importLibraryData(file); });
$('#dataDialog').addEventListener('click', event => { if (event.target === $('#dataDialog')) $('#dataDialog').close(); });
function closeEditDialog() { $('#editDialog').close(); editTargetId = null; }
$('#closeEditBtn').addEventListener('click', closeEditDialog);
$('#cancelEditBtn').addEventListener('click', closeEditDialog);
$('#editDialog').addEventListener('click', event => { if (event.target === $('#editDialog')) closeEditDialog(); });
$('#editForm').addEventListener('submit', async event => {
  event.preventDefault();
  const track = state.tracks.find(item => item.id === editTargetId);
  const title = $('#editTitle').value.trim();
  const artist = $('#editArtist').value.trim();
  if (!track || !title || !artist) return;
  track.title = title;
  track.artist = artist;
  await storeTrack(track);
  render();
  if (track.id === state.currentId) updateNowPlaying(track);
  closeEditDialog();
  toast('Song details updated');
});
$('#themeBtn').addEventListener('click', () => { document.body.classList.toggle('light'); localStorage.setItem('pulsedeck-theme', document.body.classList.contains('light') ? 'light' : 'dark'); });
audio.addEventListener('play', () => { setPlaying(true); syncMediaSession(currentTrack(), 'playing'); render(); });
audio.addEventListener('playing', () => { syncMediaSession(currentTrack(), 'playing'); syncMediaPosition(); });
audio.addEventListener('pause', () => { setPlaying(false); syncMediaSession(currentTrack(), 'paused'); });
audio.addEventListener('loadedmetadata', () => { syncMediaSession(currentTrack(), audio.paused ? 'paused' : 'playing'); syncMediaPosition(); });
audio.addEventListener('ended', () => {
  const duration = audio.duration;
  const endedNearFinish = Number.isFinite(duration) && duration > 0 && audio.currentTime >= duration - 1.25;
  const playedLongEnough = Date.now() - playbackStartedAt >= Math.min(8000, Math.max(0, (duration - 1) * 1000));
  const track = currentTrack();
  const minimumPlausibleDuration = track?.file?.size ? Math.max(8, (track.file.size * 8) / 3000000) : 8;
  const suspiciouslyShort = Number.isFinite(duration) && duration < minimumPlausibleDuration;
  if (!endedNearFinish || !playedLongEnough || suspiciouslyShort) {
    const resumeAt = Math.max(0, Math.min(lastStablePlaybackTime, Number.isFinite(duration) ? duration - 0.25 : lastStablePlaybackTime));
    if (!track || playbackRecoveryCount >= 2) {
      toast('Playback was interrupted. Tap play to retry this song.');
      return;
    }
    playbackRecoveryCount += 1;
    if (track.url) URL.revokeObjectURL(track.url);
    track.url = createAudioUrl(track.file);
    audio.src = track.url;
    audio.load();
    audio.addEventListener('loadedmetadata', () => {
      const safeDuration = Number.isFinite(audio.duration) ? audio.duration : resumeAt + 1;
      audio.currentTime = Math.max(0, Math.min(resumeAt, safeDuration - 0.25));
      audio.play().catch(() => toast('Playback was interrupted. Tap play to continue.'));
    }, { once: true });
    return;
  }
  state.repeat ? playTrack(state.currentId) : move(1);
});
audio.addEventListener('timeupdate', () => {
  if (!audio.ended && Number.isFinite(audio.currentTime)) lastStablePlaybackTime = audio.currentTime;
  $('#currentTime').textContent = formatTime(audio.currentTime);
  $('#duration').textContent = formatTime(audio.duration);
  $('#seekBar').value = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  syncMediaPosition();
  updateSyncedLyrics();
});
if ('mediaSession' in navigator) {
  const setHandler = (action, handler) => { try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) {} };
  setHandler('play', () => audio.play());
  setHandler('pause', () => audio.pause());
  setHandler('stop', () => { audio.pause(); audio.currentTime = 0; try { navigator.mediaSession.playbackState = 'none'; } catch (_) {} });
  setHandler('previoustrack', previousTrack);
  setHandler('nexttrack', () => move(1));
  setHandler('seekbackward', details => {
    if (document.hidden) previousTrack();
    else audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 10));
  });
  setHandler('seekforward', details => {
    if (document.hidden) move(1);
    else if (Number.isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, audio.currentTime + (details.seekOffset || 10));
  });
  setHandler('seekto', details => { if (details.seekTime != null) audio.currentTime = details.seekTime; });
}
document.addEventListener('visibilitychange', () => {
  const track = currentTrack();
  if (track) { syncMediaSession(track, audio.paused ? 'paused' : 'playing'); syncMediaPosition(); }
});
document.addEventListener('keydown', event => { if (event.code === 'Space' && !['INPUT','BUTTON'].includes(document.activeElement.tagName)) { event.preventDefault(); togglePlay(); } });
const savedVolume = localStorage.getItem('pulsedeck-volume');
if (savedVolume !== null) $('#volumeBar').value = savedVolume;
if (localStorage.getItem('pulsedeck-theme') === 'light') document.body.classList.add('light');
restoreCollections();
restoreLibrary();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
      if (navigator.onLine) registration.update().catch(() => {});
    } catch (_) {}
  });
}
