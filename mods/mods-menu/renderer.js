'use strict';

// Qobuz Mods — in-app menu (core renderer mod, always injected).

(() => {
  if (window.__qobuzModsMenuInstalled) return;
  const api = window.__qobuzModsRenderer;
  if (!api) {
    // eslint-disable-next-line no-console
    console.error('[qobuz-mods] menu: renderer bridge missing');
    return;
  }
  window.__qobuzModsMenuInstalled = true;

  const PREFIX = 'qobuz-mods';
  const state = {
    open: false,
    tab: 'mods',
    data: null,
    lastPlayed: null,
    pollTimer: null,
    busy: false,
    status: '',
    statusIsError: false,
  };

  const css = `
    #${PREFIX}-fab {
      position: fixed;
      right: 20px;
      bottom: 96px;
      z-index: 2147483000;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      margin: 0;
      padding: 8px 13px;
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 999px;
      background: rgba(18,18,18,.92);
      color: #f1f1f1;
      font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: .01em;
      box-shadow: 0 6px 22px rgba(0,0,0,.38);
      cursor: pointer;
      -webkit-app-region: no-drag;
      backdrop-filter: blur(12px);
    }
    #${PREFIX}-fab:hover { background: rgba(34,34,34,.96); }
    #${PREFIX}-fab .dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: #f5a623; display: none;
    }
    #${PREFIX}-fab.has-pending .dot { display: inline-block; }

    #${PREFIX}-panel {
      position: fixed;
      right: 20px;
      bottom: 140px;
      z-index: 2147483001;
      width: min(430px, calc(100vw - 40px));
      max-height: min(70vh, 660px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,.13);
      border-radius: 14px;
      background: rgba(20,20,20,.98);
      color: #ececec;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 18px 60px rgba(0,0,0,.55);
      -webkit-app-region: no-drag;
      backdrop-filter: blur(18px);
    }
    #${PREFIX}-panel[hidden] { display: none; }

    .${PREFIX}-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 16px 10px;
    }
    .${PREFIX}-title { display: flex; align-items: baseline; gap: 8px; }
    .${PREFIX}-title strong { font-size: 15px; letter-spacing: .01em; }
    .${PREFIX}-title span { color: #8b8b8b; font-size: 11px; }

    .${PREFIX}-close {
      width: 26px; height: 26px; border: 0; border-radius: 7px;
      background: transparent; color: #9a9a9a; font-size: 18px; line-height: 1;
      cursor: pointer;
    }
    .${PREFIX}-close:hover { background: rgba(255,255,255,.08); color: #fff; }

    .${PREFIX}-tabs {
      display: flex; gap: 4px; padding: 0 12px 10px;
      border-bottom: 1px solid rgba(255,255,255,.08);
    }
    .${PREFIX}-tab {
      border: 0; border-radius: 7px; padding: 6px 10px;
      background: transparent; color: #9a9a9a;
      font: 600 12px/1.2 inherit; cursor: pointer;
    }
    .${PREFIX}-tab:hover { color: #ddd; background: rgba(255,255,255,.05); }
    .${PREFIX}-tab.active { color: #fff; background: rgba(47,124,246,.18); }

    .${PREFIX}-banner {
      margin: 10px 14px 0; padding: 8px 10px;
      border: 1px solid rgba(245,166,35,.35);
      border-radius: 8px;
      background: rgba(245,166,35,.10);
      color: #f5c46b; font-size: 12px;
    }
    .${PREFIX}-banner[hidden] { display: none; }

    .${PREFIX}-body {
      flex: 1; min-height: 0; overflow-y: auto;
      padding: 10px 14px 6px;
    }
    .${PREFIX}-body::-webkit-scrollbar { width: 9px; }
    .${PREFIX}-body::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,.16); border-radius: 10px;
      border: 2px solid rgba(20,20,20,.98);
    }

    .${PREFIX}-mod {
      display: flex; gap: 10px; align-items: flex-start;
      padding: 10px 8px; border-radius: 9px;
      cursor: pointer;
    }
    .${PREFIX}-mod:hover { background: rgba(255,255,255,.045); }
    .${PREFIX}-mod input[type="checkbox"] {
      width: 16px; height: 16px; margin: 2px 0 0;
      accent-color: #2f7cf6; cursor: pointer; flex: 0 0 auto;
    }
    .${PREFIX}-mod input[type="checkbox"]:disabled { cursor: default; opacity: .55; }
    .${PREFIX}-mod-main { min-width: 0; flex: 1; }
    .${PREFIX}-mod-head {
      display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap;
    }
    .${PREFIX}-mod-name { font-weight: 650; color: #f5f5f5; }
    .${PREFIX}-mod-version { color: #7f7f7f; font-size: 11px; }
    .${PREFIX}-badge {
      padding: 1px 6px; border-radius: 999px;
      background: rgba(255,255,255,.08); color: #a9a9a9;
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
    }
    .${PREFIX}-mod-desc {
      color: #9c9c9c; font-size: 12px; margin-top: 2px;
    }
    .${PREFIX}-mod-error {
      margin-top: 5px; color: #ff8b8b; font-size: 11px;
      white-space: pre-wrap; word-break: break-word;
    }

    .${PREFIX}-empty {
      padding: 28px 10px; text-align: center; color: #8a8a8a; font-size: 12px;
    }
    .${PREFIX}-album {
      display: flex; align-items: center; gap: 10px;
      padding: 8px; border-radius: 9px;
    }
    .${PREFIX}-album:hover { background: rgba(255,255,255,.045); }
    .${PREFIX}-cover {
      width: 42px; height: 42px; flex: 0 0 auto;
      border-radius: 6px; object-fit: cover; background: #2a2a2a;
    }
    .${PREFIX}-album-main { min-width: 0; flex: 1; }
    .${PREFIX}-album-title {
      color: #f0f0f0; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .${PREFIX}-album-sub {
      color: #909090; font-size: 11px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .${PREFIX}-album-meta {
      flex: 0 0 auto; text-align: right; color: #828282; font-size: 11px;
    }
    .${PREFIX}-open {
      margin-top: 3px; border: 0; padding: 0;
      background: transparent; color: #5b9bff;
      font: 600 11px/1.2 inherit; cursor: pointer;
    }
    .${PREFIX}-open:hover { text-decoration: underline; }

    .${PREFIX}-footer {
      display: flex; gap: 8px; padding: 10px 14px 13px;
      border-top: 1px solid rgba(255,255,255,.08);
    }
    .${PREFIX}-button {
      flex: 1; border: 1px solid rgba(255,255,255,.13); border-radius: 8px;
      padding: 7px 9px; background: rgba(255,255,255,.05); color: #ddd;
      font: 600 11px/1.2 inherit; cursor: pointer;
    }
    .${PREFIX}-button:hover { background: rgba(255,255,255,.09); color: #fff; }
    .${PREFIX}-button.primary {
      background: #2f7cf6; border-color: #2f7cf6; color: #fff;
    }
    .${PREFIX}-button.primary:hover { background: #3d88fb; }

    .${PREFIX}-status {
      padding: 0 16px 10px; min-height: 0;
      color: #8f8f8f; font-size: 11px;
    }
    .${PREFIX}-status.error { color: #ff8b8b; }
    .${PREFIX}-status:empty { display: none; }
  `;

  function injectStyle() {
    if (document.getElementById(`${PREFIX}-style`)) return;
    const style = document.createElement('style');
    style.id = `${PREFIX}-style`;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setStatus(message, isError = false) {
    state.status = message || '';
    state.statusIsError = Boolean(isError);
    if (!ui.status) return;
    ui.status.textContent = state.status;
    ui.status.classList.toggle('error', state.statusIsError);
  }

  function relativeTime(timestamp) {
    const delta = Date.now() - Number(timestamp || 0);
    if (!Number.isFinite(delta) || delta < 0) return '';
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (delta < minute) return 'just now';
    if (delta < hour) return `${Math.floor(delta / minute)}m ago`;
    if (delta < day) return `${Math.floor(delta / hour)}h ago`;
    if (delta < 7 * day) return `${Math.floor(delta / day)}d ago`;
    try {
      return new Date(timestamp).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: new Date(timestamp).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
      });
    } catch {
      return '';
    }
  }

  function plural(count, singular, pluralForm) {
    return `${count} ${count === 1 ? singular : pluralForm}`;
  }

  const ui = {
    fab: null,
    panel: null,
    body: null,
    modsPane: null,
    lastPane: null,
    banner: null,
    status: null,
    version: null,
    tabs: [],
    restartButton: null,
  };

  function createUi() {
    injectStyle();

    const fab = make('button', '', 'Mods');
    fab.id = `${PREFIX}-fab`;
    fab.type = 'button';
    fab.title = 'Qobuz Mods';
    fab.setAttribute('aria-label', 'Open Qobuz mods');
    const dot = make('span', 'dot');
    fab.prepend(dot);
    fab.addEventListener('click', () => setOpen(!state.open));
    ui.fab = fab;

    const panel = make('div', '');
    panel.id = `${PREFIX}-panel`;
    panel.hidden = true;

    const header = make('div', `${PREFIX}-header`);
    const title = make('div', `${PREFIX}-title`);
    title.appendChild(make('strong', '', 'Qobuz Mods'));
    const version = make('span', '', '');
    ui.version = version;
    title.appendChild(version);
    const close = make('button', `${PREFIX}-close`, '×');
    close.type = 'button';
    close.title = 'Close';
    close.addEventListener('click', () => setOpen(false));
    header.appendChild(title);
    header.appendChild(close);

    const tabs = make('div', `${PREFIX}-tabs`);
    for (const [id, label] of [['mods', 'Mods'], ['last-played', 'Last played']]) {
      const tab = make('button', `${PREFIX}-tab`, label);
      tab.type = 'button';
      tab.dataset.tab = id;
      tab.addEventListener('click', () => setTab(id));
      tabs.appendChild(tab);
      ui.tabs.push(tab);
    }

    const banner = make('div', `${PREFIX}-banner`, 'Restart Qobuz to apply mod changes.');
    banner.hidden = true;
    ui.banner = banner;

    const body = make('div', `${PREFIX}-body`);
    const modsPane = make('div', '');
    const lastPane = make('div', '');
    lastPane.hidden = true;
    body.appendChild(modsPane);
    body.appendChild(lastPane);
    ui.body = body;
    ui.modsPane = modsPane;
    ui.lastPane = lastPane;

    const status = make('div', `${PREFIX}-status`, '');
    ui.status = status;

    const footer = make('div', `${PREFIX}-footer`);
    const openFolder = make('button', `${PREFIX}-button`, 'Mods folder');
    openFolder.type = 'button';
    openFolder.addEventListener('click', async () => {
      try {
        await api.invoke('open-mods-folder');
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    });

    const showLog = make('button', `${PREFIX}-button`, 'Log');
    showLog.type = 'button';
    showLog.addEventListener('click', async () => {
      try {
        await api.invoke('show-log');
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    });

    const restart = make('button', `${PREFIX}-button primary`, 'Restart Qobuz');
    restart.type = 'button';
    restart.addEventListener('click', async () => {
      if (!window.confirm('Restart Qobuz now?')) return;
      try {
        await api.invoke('restart');
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    });
    ui.restartButton = restart;

    footer.appendChild(openFolder);
    footer.appendChild(showLog);
    footer.appendChild(restart);

    panel.appendChild(header);
    panel.appendChild(tabs);
    panel.appendChild(banner);
    panel.appendChild(body);
    panel.appendChild(status);
    panel.appendChild(footer);
    ui.panel = panel;

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.open) setOpen(false);
    });

    setTab('mods');
    refreshMods();
  }

  function setOpen(open) {
    state.open = Boolean(open);
    ui.panel.hidden = !state.open;
    if (state.open) {
      refreshMods();
      if (state.tab === 'last-played') refreshLastPlayed();
      startPolling();
    } else {
      stopPolling();
    }
  }

  function setTab(tab) {
    state.tab = tab;
    for (const node of ui.tabs) {
      node.classList.toggle('active', node.dataset.tab === tab);
    }
    ui.modsPane.hidden = tab !== 'mods';
    ui.lastPane.hidden = tab !== 'last-played';
    if (tab === 'last-played') refreshLastPlayed();
    else refreshMods();
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(() => {
      if (!state.open) return;
      if (state.tab === 'last-played') refreshLastPlayed();
    }, 4000);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  async function refreshMods() {
    try {
      const result = await api.invoke('list');
      state.data = result;
      renderMods();
    } catch (error) {
      setStatus(`Could not load mods: ${error.message || error}`, true);
    }
  }

  function renderMods() {
    const data = state.data;
    if (!data) return;
    if (ui.version) ui.version.textContent = `v${data.version || ''}`;
    ui.banner.hidden = !data.restartRequired;
    ui.fab.classList.toggle('has-pending', Boolean(data.restartRequired));

    const pane = ui.modsPane;
    pane.textContent = '';

    const mods = Array.isArray(data.mods) ? data.mods : [];
    if (mods.length === 0) {
      pane.appendChild(make('div', `${PREFIX}-empty`, 'No mods installed yet.'));
      return;
    }

    for (const mod of mods) {
      const row = make('label', `${PREFIX}-mod`);

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(mod.enabled);
      checkbox.disabled = Boolean(mod.core || !mod.platformOk || state.busy);
      checkbox.addEventListener('change', async () => {
        const desired = checkbox.checked;
        state.busy = true;
        setStatus('');
        try {
          const result = await api.invoke('set-enabled', mod.id, desired);
          state.busy = false;
          state.data = { ...(state.data || {}), ...result };
          renderMods();
          setStatus(`Restart Qobuz to ${desired ? 'enable' : 'disable'} ${mod.name}.`);
        } catch (error) {
          checkbox.checked = !desired;
          setStatus(error.message || String(error), true);
        } finally {
          state.busy = false;
        }
      });

      const main = make('div', `${PREFIX}-mod-main`);
      const head = make('div', `${PREFIX}-mod-head`);
      head.appendChild(make('span', `${PREFIX}-mod-name`, mod.name || mod.id));
      head.appendChild(make('span', `${PREFIX}-mod-version`, `v${mod.version || '0.0.0'}`));
      if (mod.core) head.appendChild(make('span', `${PREFIX}-badge`, 'core'));
      if (!mod.platformOk) head.appendChild(make('span', `${PREFIX}-badge`, 'unsupported'));
      if (mod.enabled && !mod.active && !mod.core && mod.platformOk && !mod.error) {
        head.appendChild(make('span', `${PREFIX}-badge`, 'restart'));
      }

      main.appendChild(head);
      if (mod.description) {
        main.appendChild(make('div', `${PREFIX}-mod-desc`, mod.description));
      }
      if (mod.error) {
        main.appendChild(make('div', `${PREFIX}-mod-error`, mod.error));
      }

      row.appendChild(checkbox);
      row.appendChild(main);
      pane.appendChild(row);
    }
  }

  async function refreshLastPlayed() {
    try {
      const result = await api.invoke('mod-invoke', 'last-played', 'list');
      state.lastPlayed = result;
      renderLastPlayed();
    } catch (error) {
      state.lastPlayed = { error: error.message || String(error) };
      renderLastPlayed();
    }
  }

  function renderLastPlayed() {
    const pane = ui.lastPane;
    pane.textContent = '';

    const result = state.lastPlayed;
    if (!result) {
      pane.appendChild(make('div', `${PREFIX}-empty`, 'Loading…'));
      return;
    }
    if (result.error) {
      pane.appendChild(
        make(
          'div',
          `${PREFIX}-empty`,
          `Last played is unavailable: ${result.error}`,
        ),
      );
      return;
    }

    const albums = Array.isArray(result.albums) ? result.albums : [];
    if (albums.length === 0) {
      pane.appendChild(
        make(
          'div',
          `${PREFIX}-empty`,
          'No albums recorded yet. Play an album in Qobuz and it will appear here.',
        ),
      );
      return;
    }

    for (const album of albums) {
      const row = make('div', `${PREFIX}-album`);

      if (album.artworkUrl) {
        const cover = document.createElement('img');
        cover.className = `${PREFIX}-cover`;
        cover.loading = 'lazy';
        cover.alt = '';
        cover.src = album.artworkUrl;
        cover.addEventListener('error', () => {
          cover.style.visibility = 'hidden';
        });
        row.appendChild(cover);
      } else {
        row.appendChild(make('div', `${PREFIX}-cover`));
      }

      const main = make('div', `${PREFIX}-album-main`);
      main.appendChild(
        make('div', `${PREFIX}-album-title`, album.albumTitle || album.albumId || 'Unknown album'),
      );
      const sub = [album.artist, plural(Number(album.playCount) || 0, 'play', 'plays')]
        .filter(Boolean)
        .join(' · ');
      main.appendChild(make('div', `${PREFIX}-album-sub`, sub));
      if (album.albumId) {
        const open = make('button', `${PREFIX}-open`, 'Open in Qobuz web player ↗');
        open.type = 'button';
        open.addEventListener('click', async (event) => {
          event.stopPropagation();
          try {
            await api.invoke(
              'open-external',
              `https://play.qobuz.com/album/${encodeURIComponent(album.albumId)}`,
            );
          } catch (error) {
            setStatus(error.message || String(error), true);
          }
        });
        main.appendChild(open);
      }

      const meta = make('div', `${PREFIX}-album-meta`, relativeTime(album.lastPlayedAt));
      row.appendChild(main);
      row.appendChild(meta);
      pane.appendChild(row);
    }
  }

  function mount() {
    if (document.getElementById(`${PREFIX}-fab`)) return;
    createUi();
  }

  // The bundle may still be mounting React when did-finish-load fires.
  if (document.body) {
    mount();
  } else {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (document.body) {
        clearInterval(timer);
        mount();
      } else if (tries > 40) {
        clearInterval(timer);
        // eslint-disable-next-line no-console
        console.error('[qobuz-mods] menu: document.body never appeared');
      }
    }, 250);
  }

  try {
    console.log('[qobuz-mods] menu installed');
  } catch {
    // Ignore.
  }
})();
