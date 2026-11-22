/* Precision Dashboard — phone app
 * Live view of the Precision 7730 and every pipeline on it, an hour-by-hour
 * record of each day, and a board for upcoming projects.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ helpers
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('pd.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('pd.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const DEMO = new URLSearchParams(location.search).has('demo');
  const MACHINE_ID = 'precision';
  const OFFLINE_AFTER_MS = 75_000;
  const STATUSES = ['live', 'building', 'planning', 'idea', 'paused'];
  const STATUS_LABEL = { idea: 'Idea', planning: 'Planning', building: 'Building', live: 'Live', paused: 'Paused' };

  const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDay = (d) => new Date(d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const isSameDay = (a, b) => { a = new Date(a); b = new Date(b); return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); };
  const startOfDay = (offset = 0) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d; };
  function dur(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  }
  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - Date.parse(ts)) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m ago`;
    return `${fmtDay(ts)}, ${fmtTime(ts)}`;
  }
  const whenText = (ts) => isSameDay(ts, Date.now()) ? fmtTime(ts) : `${fmtDay(ts)} ${fmtTime(ts)}`;

  // ------------------------------------------------------------------ state
  const state = {
    view: 'live', filter: 'all', dayOffset: 0, selHour: null,
    projects: [], pstate: {}, machine: null,
    feed: [],          // newest first
    todayEvents: [],   // oldest first, always "today"
    dayEvents: [],     // oldest first, the day shown on the Hourly tab
    daySamples: [],
    live: false, lastSync: null, user: null, ready: false,
  };
  const opts = { vibrate: LS.get('vibrate', true), notify: LS.get('notify', false), theme: LS.get('theme', 'auto'), ntfy: LS.get('ntfy', '') };

  const projBySlug = (slug) => state.projects.find((p) => p.slug === slug);
  const slotOf = (slug) => { const p = projBySlug(slug); return p && p.color_slot >= 1 && p.color_slot <= 8 ? p.color_slot : 0; };
  const colorOf = (slug) => `var(--s${slotOf(slug)})`;
  const nameOf = (slug) => slug === 'system' ? 'Precision' : (projBySlug(slug)?.name || slug);
  const machineOnline = () => !!state.machine && Date.now() - Date.parse(state.machine.updated_at) < OFFLINE_AFTER_MS;

  // ------------------------------------------------------------------ data sources
  let sb = null, channel = null;

  const realApi = {
    async loadCore() {
      const [p, ps, m, f] = await Promise.all([
        sb.from('projects').select('*').order('sort_order').order('created_at'),
        sb.from('project_state').select('*'),
        sb.from('machine_status').select('*').eq('id', MACHINE_ID).maybeSingle(),
        sb.from('events').select('*').order('ts', { ascending: false }).limit(60),
      ]);
      for (const r of [p, ps, m, f]) if (r.error) throw r.error;
      return { projects: p.data, pstate: ps.data, machine: m.data, feed: f.data };
    },
    async loadDay(start, end) {
      const [e, s] = await Promise.all([
        sb.from('events').select('*').gte('ts', start.toISOString()).lt('ts', end.toISOString()).order('ts').limit(3000),
        sb.from('machine_samples').select('*').eq('machine', MACHINE_ID).gte('ts', start.toISOString()).lt('ts', end.toISOString()).order('ts').limit(2000),
      ]);
      if (e.error) throw e.error;
      if (s.error) throw s.error;
      return { events: e.data, samples: s.data };
    },
    async saveProject(row, isNew) {
      const q = isNew ? sb.from('projects').insert(row) : sb.from('projects').update(row).eq('slug', row.slug);
      const { error } = await q;
      if (error) throw error;
    },
    async deleteProject(slug) {
      const { error } = await sb.from('projects').delete().eq('slug', slug);
      if (error) throw error;
    },
    subscribe() {
      if (channel) sb.removeChannel(channel);
      channel = sb.channel('precision-dashboard')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events' }, (p) => onEvent(p.new))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'machine_status' }, (p) => { if (p.new?.id === MACHINE_ID) { state.machine = p.new; schedule(); } })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'machine_samples' }, (p) => {
          if (p.new?.machine !== MACHINE_ID) return;
          state.todaySamples = (state.todaySamples || []).concat(p.new);
          if (state.dayOffset === 0) state.daySamples = state.todaySamples;
          schedule();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'project_state' }, (p) => { if (p.new?.slug) { state.pstate[p.new.slug] = p.new; schedule(); } })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, (p) => {
          if (p.eventType === 'DELETE') state.projects = state.projects.filter((x) => x.slug !== p.old.slug);
          else { const i = state.projects.findIndex((x) => x.slug === p.new.slug); if (i >= 0) state.projects[i] = p.new; else state.projects.push(p.new); sortProjects(); }
          schedule();
        })
        .subscribe((status) => { state.live = status === 'SUBSCRIBED'; if (state.live) state.lastSync = new Date(); renderConn(); });
    },
  };

  const api = DEMO ? makeDemoApi() : realApi;

  function sortProjects() { state.projects.sort((a, b) => (a.sort_order - b.sort_order) || String(a.created_at).localeCompare(String(b.created_at))); }

  async function loadAll() {
    const btn = $('#refresh-btn'); btn.classList.add('spin');
    try {
      const core = await api.loadCore();
      state.projects = core.projects || []; sortProjects();
      state.pstate = Object.fromEntries((core.pstate || []).map((r) => [r.slug, r]));
      state.machine = core.machine;
      state.feed = core.feed || [];
      const today = await api.loadDay(startOfDay(0), startOfDay(1));
      state.todayEvents = today.events;
      await loadSelectedDay(today);
      state.lastSync = new Date(); state.ready = true;
    } catch (e) {
      console.error(e);
      toast(e.message?.includes('JWT') ? 'Signed out — please sign in again' : `Could not load: ${e.message || e}`, true);
    } finally {
      btn.classList.remove('spin');
      renderAll();
    }
  }

  async function loadSelectedDay(todayData) {
    if (state.dayOffset === 0) {
      const d = todayData || await api.loadDay(startOfDay(0), startOfDay(1));
      state.todayEvents = d.events; state.dayEvents = d.events; state.daySamples = d.samples; state.todaySamples = d.samples;
    } else {
      const d = await api.loadDay(startOfDay(state.dayOffset), startOfDay(state.dayOffset + 1));
      state.dayEvents = d.events; state.daySamples = d.samples;
    }
  }

  // new event arrives in real time
  function onEvent(ev) {
    if (state.feed.some((e) => e.id === ev.id)) return;
    state.feed.unshift(ev); state.feed = state.feed.slice(0, 200);
    if (isSameDay(ev.ts, Date.now())) {
      state.todayEvents.push(ev);
      if (state.dayOffset === 0) state.dayEvents = state.todayEvents;
    }
    state.fresh = ev.id; state.lastSync = new Date();
    if (ev.level === 'error') {
      toast(`${nameOf(ev.project)}: ${ev.title}`, true);
      if (opts.vibrate && navigator.vibrate) try { navigator.vibrate([120, 60, 120]); } catch { /* ignore */ }
    }
    if (opts.notify && (ev.level === 'error' || ev.kind === 'run_finished')) notifyPhone(ev);
    schedule();
  }

  async function notifyPhone(ev) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const reg = await navigator.serviceWorker?.getRegistration();
      const title = `${nameOf(ev.project)}`;
      const body = ev.title;
      if (reg) reg.showNotification(title, { body, tag: `ev-${ev.id}`, icon: 'icon-192.png', badge: 'icon-192.png' });
    } catch { /* notifications are optional */ }
  }

  // ------------------------------------------------------------------ rendering
  let raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderAll(); }); }

  function renderAll() {
    renderConn();
    if (!state.ready && !DEMO) return;
    if (state.view === 'live') renderLive();
    if (state.view === 'today') renderToday();
    if (state.view === 'projects') renderBoard();
  }

  function renderConn() {
    const el = $('#conn-line');
    if (DEMO) { el.textContent = 'Demo data'; $('#live-dot').classList.add('on'); return; }
    if (!sb) { el.textContent = 'Not set up — open Settings'; return; }
    if (!state.user) { el.textContent = 'Signed out'; return; }
    el.textContent = state.live ? `Live · updated ${state.lastSync ? fmtTime(state.lastSync) : ''}` : 'Reconnecting…';
    $('#live-dot').classList.toggle('on', state.live);
  }

  // ---------- LIVE
  const tracked = () => state.projects.filter((p) => p.tracked);
  const isTracked = (slug) => slug === 'system' || !!projBySlug(slug)?.tracked;

  function countsFor(slug, events) {
    const c = { runs: 0, errors: 0, files: 0, steps: 0 };
    for (const e of events) {
      if (e.project !== slug) continue;
      if (e.kind === 'run_finished') c.runs += 1;
      else if (['video', 'image', 'audio', 'file', 'short', 'long_video', 'reel_rendered'].includes(e.kind)) c.files += Number(e.data?.count) || 1;
      if (e.level === 'error') c.errors += 1;
    }
    return c;
  }

  function renderLive() {
    const m = state.machine, on = machineOnline();
    const card = $('#machine-card');
    card.classList.toggle('stale', !on);
    if (!m) {
      card.innerHTML = `<div class="m-top"><div><div class="m-name">Precision 7730</div><div class="m-sub">Waiting for the first report from the reporter…</div></div><span class="pill off"><span class="dot"></span>No data yet</span></div>`;
    } else {
      const ramPct = m.ram_total_gb ? (m.ram_used_gb / m.ram_total_gb) * 100 : 0;
      const disks = (m.disks || []).slice().sort((a, b) => a.free_gb - b.free_gb);
      const low = disks[0];
      const lowUsed = low ? 100 - (low.free_gb / low.total_gb) * 100 : 0;
      const hot = m.gpu_temp >= 87 ? 'crit' : m.gpu_temp >= 80 ? 'warn' : '';
      const sub = on ? `On for ${dur(Date.now() - Date.parse(m.online_since))} · updated ${ago(m.updated_at)}` : `Last seen ${ago(m.updated_at)} — last known values below`;
      const pill = on ? `<span class="pill on"><span class="dot"></span>Online</span>` : `<span class="pill off"><span class="dot"></span>Off since ${esc(whenText(m.updated_at))}</span>`;
      const notes = [];
      if (on && m.queue_backlog > 0) notes.push(`${m.queue_backlog} update${m.queue_backlog > 1 ? 's' : ''} waiting to upload`);
      if (on && m.net_ok === false) notes.push('Internet trouble on the Precision — updates are being saved and will arrive later');
      card.innerHTML = `
        <div class="m-top"><div><div class="m-name">${esc(m.name || 'Precision 7730')}</div><div class="m-sub">${esc(sub)}</div></div>${pill}</div>
        <div class="tiles">
          ${tile('CPU', fmtNum(m.cpu, 0), '%', m.cpu)}
          ${tile('GPU', fmtNum(m.gpu_util, 0), '%', m.gpu_util, m.gpu_temp != null ? `${fmtNum(m.gpu_temp, 0)} °C${m.gpu_name ? ' · ' + m.gpu_name : ''}` : 'no GPU reading', hot)}
          ${tile('RAM', fmtNum(m.ram_used_gb, 1), ` / ${fmtNum(m.ram_total_gb, 0)} GB`, ramPct)}
          ${low ? tile('Disk free', fmtNum(low.free_gb, 0), ' GB', lowUsed, `${low.mount}${disks.length > 1 ? ` (lowest of ${disks.length})` : ''}`, low.free_gb < 15 ? 'crit' : low.free_gb < 50 ? 'warn' : '') : tile('Disk', '—', '', 0)}
        </div>
        ${notes.map((n) => `<div class="notice">${esc(n)}</div>`).join('')}`;
    }

    renderMinuteStrip();

    // tracked projects (upcoming ones stay on the Projects board only)
    const pipes = tracked();
    $('#pipeline-list').innerHTML = pipes.length ? pipes.map((p) => projectLiveCard(p, on)).join('')
      : `<div class="card empty">No tracked projects yet. They appear when the reporter on the Precision starts.</div>`;

    renderFeedChips();
    const f = state.feedFilter || 'all';
    const list = state.feed.filter((e) => isTracked(e.project) && (f === 'all' || (f === 'errors' ? e.level === 'error' || e.level === 'warn' : e.project === f)));
    $('#feed').innerHTML = list.length ? list.slice(0, 60).map(feedItem).join('') : `<li class="empty" style="display:block">No events yet.</li>`;
    state.fresh = null;
  }

  function projectLiveCard(p, on) {
    const ps = state.pstate[p.slug] || {};
    const c = countsFor(p.slug, state.todayEvents);
    const running = ps.running && on;
    let st = `<span class="state">Idle</span>`;
    if (running) st = `<span class="state running">● Running</span>`;
    else if (ps.running && !on) st = `<span class="state warn">Stopped (PC off)</span>`;
    else if (c.errors && ps.last_level === 'error') st = `<span class="state error">! Error</span>`;
    const now = running ? `<div class="now-row"><span class="spinner"></span><div><b>${esc(ps.current_step || 'working')}</b>
        <div class="muted small">${ps.step_started_at ? `step ${dur(Date.now() - Date.parse(ps.step_started_at))}` : ''}${ps.run_started_at ? ` · run ${dur(Date.now() - Date.parse(ps.run_started_at))}` : ''}${ps.cpu != null ? ` · CPU ${fmtNum(ps.cpu, 0)}%` : ''}${ps.mem_gb ? ` · ${fmtNum(ps.mem_gb, 1)} GB` : ''}</div></div></div>` : '';
    const s = ps.summary || {};
    const kpis = (s.kpis || []).map((k) => {
      const pct = k.target ? Math.min(100, (k.value / k.target) * 100) : null;
      const done = k.target && k.value >= k.target;
      return `<div class="kpi ${k.level === 'warn' && k.value ? 'warn' : ''}"><div class="t-label">${esc(k.label)}</div>
        <div class="kpi-v">${esc(k.value)}${k.target ? `<small> / ${esc(k.target)}</small>` : ''}${done ? ' <span class="ok">✓</span>' : ''}</div>
        ${pct != null ? `<div class="meter ${done ? 'done' : ''}"><i style="width:${pct}%"></i></div>` : ''}</div>`;
    }).join('');
    const lines = (s.lines || []).map((l) => `<li class="${esc(l.level || '')}">${l.level === 'warn' || l.level === 'error' ? '! ' : ''}${esc(l.text)}</li>`).join('');
    const chips = [
      `<span class="count"><b>${c.runs}</b> run${c.runs === 1 ? '' : 's'} today</span>`,
      c.files && `<span class="count"><b>${c.files}</b> file${c.files > 1 ? 's' : ''} made</span>`,
      c.errors && `<span class="count err"><b>${c.errors}</b> error${c.errors > 1 ? 's' : ''}</span>`,
    ].filter(Boolean).join('');
    return `<div class="pipe" style="--c:${colorOf(p.slug)}" data-proj="${esc(p.slug)}">
      <div class="pipe-head"><span class="pipe-name">${esc(p.name)}</span>${st}</div>
      ${now}
      ${kpis ? `<div class="kpis">${kpis}</div>` : ''}
      ${lines ? `<ul class="plines">${lines}</ul>` : ''}
      <div class="pipe-last">${ps.last_title ? `Last: ${esc(ps.last_title)} · <span class="muted">${esc(ago(ps.last_event_at))}</span>` : '<span class="muted">No activity recorded yet</span>'}</div>
      <div class="counts">${chips}${ps.summary_at ? `<span class="count muted">numbers ${esc(ago(ps.summary_at))}</span>` : ''}</div></div>`;
  }

  function renderFeedChips() {
    const f = state.feedFilter || 'all';
    const opts2 = [['all', 'All'], ...tracked().map((p) => [p.slug, p.name.split(/\s+/).slice(0, 2).join(' ')]), ['errors', 'Problems']];
    $('#feed-chips').innerHTML = opts2.map(([k, l]) => `<button class="chip ${f === k ? 'active' : ''}" data-feed="${esc(k)}">${k !== 'all' && k !== 'errors' ? `<i class="swatch" style="--c:${colorOf(k)}"></i> ` : ''}${esc(l)}</button>`).join('');
  }

  // last 60 minutes, minute by minute
  function renderMinuteStrip() {
    const el = $('#minute-chart');
    if (!el) return;
    const W = 340, H = 92, L = 26, R = 6, T = 6, B = 26;
    const pw = W - L - R, ph = H - T - B;
    const end = Date.now(), start = end - 60 * 60e3;
    const x = (t) => L + ((t - start) / 36e5) * pw;
    const y = (v) => T + ph - (Math.max(0, Math.min(100, v)) / 100) * ph;
    const S = (state.todaySamples || []).filter((s) => Date.parse(s.ts) >= start - 60e3);
    let lines = '';
    for (const [key, c] of [['cpu', 'var(--s1)'], ['gpu_util', 'var(--s2)']]) {
      let d = '', prev = null;
      for (const s of S) {
        if (s[key] == null) { prev = null; continue; }
        const t = Date.parse(s.ts);
        d += `${!prev || t - prev > 3 * 60e3 ? 'M' : 'L'}${Math.max(L, x(t)).toFixed(1)},${y(s[key]).toFixed(1)}`;
        prev = t;
      }
      if (d) lines += `<path d="${d}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    // event ticks per minute, coloured by project
    const ev = state.todayEvents.filter((e) => Date.parse(e.ts) >= start && e.project !== 'system' && e.kind !== 'step' && isTracked(e.project));
    let ticks = '';
    for (const e of ev) {
      const xx = x(Date.parse(e.ts));
      ticks += `<rect x="${(xx - 1.5).toFixed(1)}" y="${T + ph + 4}" width="3" height="8" rx="1.5" fill="${e.level === 'error' ? 'var(--critical)' : colorOf(e.project)}"><title>${esc(fmtTime(e.ts) + ' ' + nameOf(e.project) + ': ' + e.title)}</title></rect>`;
    }
    let g = '';
    for (const v of [0, 100]) g += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 5}" y="${y(v) + 3}" text-anchor="end">${v}%</text>`;
    let ax = '';
    for (const mAgo of [60, 45, 30, 15, 0]) ax += `<text x="${x(end - mAgo * 60e3)}" y="${H - 3}" text-anchor="middle">${mAgo ? `-${mAgo}m` : 'now'}</text>`;
    const last = S.at(-1);
    el.innerHTML = S.length || ev.length
      ? `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="CPU and GPU over the last hour, with events"><g class="axis">${g}${ax}</g>${lines}${ticks}</svg>`
      : `<div class="empty" style="padding:12px">No data in the last hour.</div>`;
    $('#minute-note').textContent = last ? `sample ${ago(last.ts)}` : '';
  }

  function tile(label, value, unit, pct, note = '', cls = '') {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const auto = cls || (p >= 90 ? 'crit' : p >= 75 ? 'warn' : '');
    return `<div class="tile"><div class="t-label">${esc(label)}</div><div class="t-value">${esc(value)}<small>${esc(unit)}</small></div>${note ? `<div class="t-note">${esc(note)}</div>` : ''}<div class="meter ${auto}"><i style="width:${p}%"></i></div></div>`;
  }
  const fmtNum = (v, d) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d));

  const ICON = { run_started: '▶', run_finished: '■', video: '▶', short: '▶', long_video: '▶', machine_online: '⏻', step: '›', digest: 'Σ' };
  function feedItem(e) {
    const icon = e.level === 'error' ? '!' : e.level === 'warn' ? '!' : e.level === 'success' ? '✓' : (ICON[e.kind] || '•');
    const files = e.data?.files?.length > 1 ? e.data.files.join('\n') + (e.data.count > e.data.files.length ? `\n… and ${e.data.count - e.data.files.length} more` : '') : '';
    const detail = e.detail || files;
    return `<li class="${state.fresh === e.id ? 'new' : ''} ${e.kind === 'step' ? 'step' : ''}" data-ev="${e.id}">
      <span class="f-time">${esc(isSameDay(e.ts, Date.now()) ? fmtTime(e.ts) : fmtDay(e.ts))}</span>
      <span class="f-icon ${esc(e.level)}">${icon}</span>
      <div><div class="f-title">${esc(e.title)}</div><div class="f-proj"><span class="swatch" style="--c:${colorOf(e.project)}"></span>${esc(nameOf(e.project))}${e.data?.mb ? ` · ${esc(e.data.mb)} MB` : ''}</div></div>
      ${detail ? `<div class="f-detail" hidden>${esc(detail)}</div>` : ''}</li>`;
  }

  // ---------- HOURLY
  function renderToday() {
    const start = startOfDay(state.dayOffset);
    $('#day-label').textContent = state.dayOffset === 0 ? 'Today' : state.dayOffset === -1 ? 'Yesterday' : fmtDay(start);
    $('#day-next').disabled = state.dayOffset >= 0;
    const ev = state.dayEvents.filter((e) => e.project !== 'system' && e.kind !== 'step' && isTracked(e.project));
    let videos = 0, runs = 0, errors = 0;
    for (const e of ev) { if (['video', 'short', 'long_video', 'reel_rendered'].includes(e.kind)) videos += Number(e.data?.count) || 1; if (e.kind === 'run_finished') runs++; if (e.level === 'error') errors++; }
    const onHours = new Set(state.daySamples.map((s) => new Date(s.ts).getHours())).size;
    $('#day-tiles').innerHTML = [
      ['Events', ev.length], ['Videos made', videos], ['Runs', runs], ['Errors', errors],
    ].map(([l, v]) => `<div class="tile"><div class="t-label">${l}</div><div class="t-value" ${l === 'Errors' && v ? 'style="color:var(--critical-text)"' : ''}>${v}</div></div>`).join('');
    $('#load-note').textContent = onHours ? `PC on ~${onHours} h` : 'no samples';
    renderHourChart(ev);
    renderLoadChart();
    renderHourList(ev);
  }

  function hourBuckets(ev) {
    const b = Array.from({ length: 24 }, () => ({}));
    for (const e of ev) {
      const h = new Date(e.ts).getHours();
      const key = slotOf(e.project) ? e.project : '__other';
      b[h][key] = (b[h][key] || 0) + 1;
    }
    return b;
  }

  function seriesOrder(ev) {
    const present = new Set(ev.map((e) => (slotOf(e.project) ? e.project : '__other')));
    const list = state.projects.filter((p) => present.has(p.slug) && slotOf(p.slug)).map((p) => p.slug);
    if (present.has('__other')) list.push('__other');
    return list;
  }

  function renderHourChart(ev) {
    const W = 340, H = 170, L = 26, R = 6, T = 8, B = 34;
    const buckets = hourBuckets(ev);
    const order = seriesOrder(ev);
    const totals = buckets.map((b) => Object.values(b).reduce((a, n) => a + n, 0));
    const max = Math.max(4, ...totals);
    const step = niceStep(max / 3);
    const top = Math.ceil(max / step) * step;
    const pw = W - L - R, ph = H - T - B;
    const cw = pw / 24, bw = Math.max(4, cw - 3);
    const y = (v) => T + ph - (v / top) * ph;
    let g = '';
    for (let v = 0; v <= top; v += step) g += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 5}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
    let bars = '';
    if (state.selHour != null) bars += `<rect class="sel-col" x="${L + state.selHour * cw}" y="${T}" width="${cw}" height="${ph}" rx="3"/>`;
    buckets.forEach((b, h) => {
      let acc = 0;
      const segs = order.filter((k) => b[k]);
      segs.forEach((k, i) => {
        const v = b[k];
        const y0 = y(acc), y1 = y(acc + v);
        const x = L + h * cw + (cw - bw) / 2;
        const hgt = Math.max(1, y0 - y1 - (i > 0 ? 2 : 0));
        const color = k === '__other' ? 'var(--s0)' : colorOf(k);
        const isTop = i === segs.length - 1;
        bars += isTop ? roundTop(x, y1, bw, hgt, Math.min(4, bw / 2, hgt), color) : `<rect x="${x}" y="${y1}" width="${bw}" height="${hgt}" fill="${color}"/>`;
        acc += v;
      });
    });
    // "PC on" strip from machine samples
    const onH = new Set(state.daySamples.map((s) => new Date(s.ts).getHours()));
    let strip = '';
    for (let h = 0; h < 24; h++) if (onH.has(h)) strip += `<rect class="onstrip" x="${L + h * cw + 0.5}" y="${T + ph + 4}" width="${cw - 1}" height="4" rx="1"/>`;
    let ax = '';
    for (let h = 0; h < 24; h += 3) ax += `<text x="${L + h * cw + cw / 2}" y="${H - 6}" text-anchor="middle">${h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p'}</text>`;
    let hits = '';
    for (let h = 0; h < 24; h++) hits += `<rect class="hit" data-hour="${h}" x="${L + h * cw}" y="${T}" width="${cw}" height="${ph + 12}"/>`;
    $('#hour-chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Events per hour by project"><g class="axis">${g}${ax}</g>${bars}<line class="baseline" x1="${L}" x2="${W - R}" y1="${T + ph}" y2="${T + ph}"/>${strip}${hits}</svg>`;
    $('#hour-legend').innerHTML = order.length ? order.map((k) => `<span><i class="swatch" style="--c:${k === '__other' ? 'var(--s0)' : colorOf(k)}"></i>${esc(k === '__other' ? 'Other' : nameOf(k))}</span>`).join('') + (onH.size ? '<span class="muted"><i class="line-key" style="--c:var(--good);height:4px;opacity:.55"></i>PC on</span>' : '') : '<span class="muted">No pipeline activity on this day.</span>';
    $$('#hour-chart .hit').forEach((r) => {
      const h = Number(r.dataset.hour);
      const show = (evt) => {
        const b = buckets[h];
        const rows = order.filter((k) => b[k]).map((k) => `<div class="tt-row"><i class="swatch" style="--c:${k === '__other' ? 'var(--s0)' : colorOf(k)}"></i>${esc(k === '__other' ? 'Other' : nameOf(k))}<b>${b[k]}</b></div>`).join('');
        tooltip(evt, `<b>${hourLabel(h)}</b><div class="muted">${totals[h]} event${totals[h] === 1 ? '' : 's'}${onH.has(h) ? '' : ' · PC off'}</div>${rows}`);
      };
      r.addEventListener('pointerenter', show);
      r.addEventListener('pointermove', show);
      r.addEventListener('pointerleave', hideTooltip);
      r.addEventListener('click', (evt) => { state.selHour = state.selHour === h ? null : h; show(evt); renderToday(); const g = $(`#hour-${h}`); if (g) { g.open = true; g.scrollIntoView({ behavior: 'smooth', block: 'center' }); } setTimeout(hideTooltip, 1800); });
    });
  }

  function roundTop(x, y, w, h, r, fill) {
    return `<path fill="${fill}" d="M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z"/>`;
  }
  function niceStep(raw) { const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1))); const n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
  const shortHour = (h) => { const p = (x) => (x % 24 === 0 ? 12 : x % 24 > 12 ? x % 24 - 12 : x % 24); const ap = (x) => (x % 24 < 12 ? 'am' : 'pm'); return ap(h) === ap(h + 1) ? `${p(h)}–${p(h + 1)} ${ap(h)}` : `${p(h)} ${ap(h)}–${p(h + 1)} ${ap(h + 1)}`; };
  const hourLabel = (h) => { const f = (x) => (x % 24 === 0 ? '12 am' : x % 24 < 12 ? `${x % 24} am` : x % 24 === 12 ? '12 pm' : `${x % 24 - 12} pm`); return `${f(h)} – ${f(h + 1)}`; };

  function renderLoadChart() {
    const W = 340, H = 140, L = 26, R = 6, T = 8, B = 22;
    const pw = W - L - R, ph = H - T - B;
    const day0 = startOfDay(state.dayOffset).getTime();
    const x = (ts) => L + ((Date.parse(ts) - day0) / 864e5) * pw;
    const y = (v) => T + ph - (Math.max(0, Math.min(100, v)) / 100) * ph;
    const S = state.daySamples;
    const series = [
      { key: 'cpu', label: 'CPU', c: 'var(--s1)' },
      { key: 'gpu_util', label: 'GPU', c: 'var(--s2)' },
    ];
    let g = '';
    for (const v of [0, 50, 100]) g += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 5}" y="${y(v) + 3}" text-anchor="end">${v}%</text>`;
    let ax = '';
    for (let h = 0; h <= 24; h += 6) ax += `<text x="${L + (h / 24) * pw}" y="${H - 6}" text-anchor="middle">${h === 0 || h === 24 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p'}</text>`;
    let lines = '';
    for (const s of series) {
      let d = '', prev = null;
      for (const p of S) {
        if (p[s.key] == null) { prev = null; continue; }
        const gap = prev && Date.parse(p.ts) - Date.parse(prev.ts) > 15 * 60e3;
        d += `${!prev || gap ? 'M' : 'L'}${x(p.ts).toFixed(1)},${y(p[s.key]).toFixed(1)}`;
        prev = p;
      }
      if (d) lines += `<path d="${d}" fill="none" stroke="${s.c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    const temps = S.map((s) => s.gpu_temp).filter((v) => v != null);
    $('#load-chart').innerHTML = S.length
      ? `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="CPU and GPU load through the day"><g class="axis">${g}${ax}</g>${lines}<line class="baseline" x1="${L}" x2="${W - R}" y1="${T + ph}" y2="${T + ph}"/><line id="xhair" class="gridline" y1="${T}" y2="${T + ph}" x1="-10" x2="-10" style="stroke:var(--text-muted);display:none"/><rect class="hit" id="load-hit" x="${L}" y="${T}" width="${pw}" height="${ph}"/></svg>`
      : `<div class="empty">No load samples for this day (the PC was off or the reporter was not running).</div>`;
    $('#load-legend').innerHTML = S.length ? series.map((s) => `<span><i class="line-key" style="--c:${s.c}"></i>${s.label} %</span>`).join('') + (temps.length ? `<span class="muted">Peak GPU temp ${Math.max(...temps).toFixed(0)} °C</span>` : '') : '';
    const hit = $('#load-hit');
    if (hit) {
      const svg = hit.ownerSVGElement;
      const move = (evt) => {
        const rect = svg.getBoundingClientRect();
        const vx = ((evt.clientX - rect.left) / rect.width) * W;
        const t = day0 + ((vx - L) / pw) * 864e5;
        let best = null, bd = Infinity;
        for (const p of S) { const dd = Math.abs(Date.parse(p.ts) - t); if (dd < bd) { bd = dd; best = p; } }
        if (!best || bd > 20 * 60e3) { hideTooltip(); return; }
        const xx = x(best.ts);
        const xh = $('#xhair'); xh.setAttribute('x1', xx); xh.setAttribute('x2', xx); xh.style.display = '';
        tooltip(evt, `<b>${fmtTime(best.ts)}</b>${series.map((s) => `<div class="tt-row"><i class="line-key" style="--c:${s.c}"></i>${s.label}<b>${fmtNum(best[s.key], 0)}%</b></div>`).join('')}${best.gpu_temp != null ? `<div class="tt-row">GPU temp<b>${fmtNum(best.gpu_temp, 0)} °C</b></div>` : ''}${best.ram_pct != null ? `<div class="tt-row">RAM<b>${fmtNum(best.ram_pct, 0)}%</b></div>` : ''}`);
      };
      hit.addEventListener('pointermove', move);
      hit.addEventListener('pointerdown', move);
      hit.addEventListener('pointerleave', () => { hideTooltip(); const xh = $('#xhair'); if (xh) xh.style.display = 'none'; });
    }
  }

  function renderHourList(ev) {
    const byHour = new Map();
    for (const e of ev) { const h = new Date(e.ts).getHours(); if (!byHour.has(h)) byHour.set(h, []); byHour.get(h).push(e); }
    const hours = [...byHour.keys()].sort((a, b) => b - a);
    $('#hours-title').hidden = !hours.length;
    $('#hour-list').innerHTML = hours.length ? hours.map((h) => {
      const list = byHour.get(h);
      const per = {};
      for (const e of list) per[e.project] = (per[e.project] || 0) + 1;
      const sum = Object.entries(per).map(([slug, n]) => `<span><i class="swatch" style="--c:${colorOf(slug)}"></i>${esc(nameOf(slug))} ${n}</span>`).join('');
      const errs = list.filter((e) => e.level === 'error').length;
      return `<details class="hour-group ${state.selHour === h ? 'sel' : ''}" id="hour-${h}" ${state.selHour === h ? 'open' : ''}>
        <summary><span class="h-time">${shortHour(h)}</span><span class="h-sum">${sum}</span><span class="h-count">${list.length}${errs ? ` · <b style="color:var(--critical-text)">${errs} err</b>` : ''}</span></summary>
        <ul class="feed">${list.slice().reverse().map(feedItem).join('')}</ul></details>`;
    }).join('') : `<div class="card empty">Nothing happened on this day${state.dayOffset === 0 ? ' yet' : ''}.</div>`;
  }

  // ---------- PROJECTS BOARD
  // Active  = tracked live on the Precision (shown on Live & Hourly)
  // Upcoming = everything else: planned here, never shown on Live until switched on
  function renderBoard() {
    const upcoming = state.projects.filter((p) => !p.tracked);
    const counts = Object.fromEntries(STATUSES.map((s) => [s, upcoming.filter((p) => p.status === s).length]));
    $('#status-chips').innerHTML = [['all', 'All', state.projects.length], ['active', 'Active', tracked().length], ...STATUSES.filter((s) => counts[s]).map((s) => [s, STATUS_LABEL[s], counts[s]])]
      .map(([k, l, n]) => `<button class="chip ${state.filter === k ? 'active' : ''}" data-filter="${k}">${l}<span class="n">${n}</span></button>`).join('');
    let html = '';
    if (state.filter === 'all' || state.filter === 'active') {
      const act = tracked();
      html += `<div class="board-group">Active <span class="muted">· on the dashboard</span></div>` + (act.length ? act.map(projCard).join('') : `<div class="card empty">Nothing tracked yet.</div>`);
    }
    if (state.filter !== 'active') {
      const groups = state.filter === 'all' ? STATUSES : [state.filter];
      const up = groups.map((s) => {
        const list = upcoming.filter((p) => p.status === s);
        return list.length ? `<div class="col-title">${STATUS_LABEL[s]} <span class="muted">${list.length}</span></div>` + list.map(projCard).join('') : '';
      }).join('');
      html += `<div class="board-group">Upcoming <span class="muted">· not shown on Live until you switch tracking on</span></div>` + (up || `<div class="card empty">No upcoming projects yet. Tap “+ New project” to plan one.</div>`);
    }
    $('#board').innerHTML = html;
  }

  function projCard(p) {
    const ps = state.pstate[p.slug];
    const due = p.target_date ? `<span class="badge">Target ${esc(fmtDay(p.target_date + 'T00:00'))}</span>` : '';
    return `<div class="proj" data-edit="${esc(p.slug)}" style="--c:${colorOf(p.slug)}">
      <div class="proj-head"><i class="swatch" style="--c:${colorOf(p.slug)}"></i><span class="proj-name">${esc(p.name)}</span><span class="badge">${p.tracked ? 'Tracked live' : STATUS_LABEL[p.status] || 'Idea'}</span>${due}</div>
      ${p.description ? `<div class="proj-desc">${esc(p.description)}</div>` : ''}
      ${p.next_step ? `<div class="proj-next">Next: <b>${esc(p.next_step)}</b></div>` : ''}
      <div class="prog"><div class="meter"><i style="width:${p.progress || 0}%"></i></div><span>${p.progress || 0}%</span></div>
      ${p.tracked && ps?.last_event_at ? `<div class="proj-next muted">Last activity ${esc(ago(ps.last_event_at))}</div>` : ''}
      ${!p.tracked && p.folder ? `<div class="proj-next muted">Folder ready: ${esc(p.folder)}</div>` : ''}
    </div>`;
  }

  // ---------- sheets
  function openSheet(html) {
    $('#sheet-body').innerHTML = html;
    $('#sheet').hidden = false; $('#sheet-backdrop').hidden = false;
  }
  function closeSheet() { $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; }

  function openProjectDetail(slug) {
    const p = projBySlug(slug); if (!p) return;
    const ps = state.pstate[slug] || {};
    const ev = state.todayEvents.filter((e) => e.project === slug);
    const c = countsFor(slug, state.todayEvents);
    openSheet(`<h3><i class="swatch" style="--c:${colorOf(slug)}"></i> ${esc(p.name)}</h3>
      <div class="muted small">${esc(p.description || '')}</div>
      <div style="margin-top:10px">
        <div class="kv"><span>State</span><span>${ps.running && machineOnline() ? 'Running since ' + fmtTime(ps.run_started_at) : 'Idle'}</span></div>
        ${(ps.summary?.kpis || []).map((k) => `<div class="kv"><span>${esc(k.label)}</span><span>${esc(k.value)}${k.target ? ' / ' + esc(k.target) : ''}</span></div>`).join('')}
        <div class="kv"><span>Last run ended</span><span>${ps.last_run_ended ? esc(whenText(ps.last_run_ended)) : '—'}</span></div>
        <div class="kv"><span>Today</span><span>${c.runs} runs · ${c.files} files made · ${c.errors} errors</span></div>
        ${ps.current_step && ps.running ? `<div class="kv"><span>Now</span><span>${esc(ps.current_step)}</span></div>` : ''}
        ${p.folder ? `<div class="kv"><span>Folder</span><span style="text-align:right;word-break:break-all;max-width:65%">${esc(p.folder)}</span></div>` : ''}
      </div>
      <h3 style="margin-top:16px;font-size:15px">Today’s activity</h3>
      <ul class="feed">${ev.length ? ev.slice().reverse().map(feedItem).join('') : '<li class="empty" style="display:block">Nothing today yet.</li>'}</ul>
      <div class="btn-row"><button class="btn" data-close>Close</button><button class="btn" data-edit="${esc(slug)}">Edit project</button></div>`);
  }

  function openEditor(slug) {
    const p = slug ? projBySlug(slug) : null;
    const v = p || { name: '', status: 'idea', progress: 0, next_step: '', target_date: '', description: '', kind: 'manual', folder: '', tracked: false };
    openSheet(`<h3>${p ? 'Edit project' : 'New project'}</h3>
      <form id="proj-form">
        <label>Name<input type="text" name="name" required maxlength="80" value="${esc(v.name)}" placeholder="e.g. Urdu poetry reels"></label>
        <label>Stage</label>
        <div class="seg" id="stage-seg">${['idea', 'planning', 'building', 'live', 'paused'].map((s) => `<button type="button" data-stage="${s}" class="${v.status === s ? 'active' : ''}">${STATUS_LABEL[s]}</button>`).join('')}</div>
        <label>Progress: <b id="prog-val">${v.progress || 0}%</b><input type="range" name="progress" min="0" max="100" step="5" value="${v.progress || 0}"></label>
        <label>Next step<input type="text" name="next_step" maxlength="160" value="${esc(v.next_step || '')}" placeholder="What has to happen next?"></label>
        <label>Target date<input type="date" name="target_date" value="${esc(v.target_date || '')}"></label>
        <label>Notes<textarea name="description" maxlength="600" placeholder="What is it, which platform, which machine…">${esc(v.description || '')}</textarea></label>
        <label>Folder on the Precision<input type="text" name="folder" maxlength="300" value="${esc(v.folder || '')}" placeholder="C:\\Users\\hamza\\Desktop\\my new project" ${p?.adapter && p.adapter !== 'generic' ? 'readonly' : ''}></label>
        <label class="toggle-row"><input type="checkbox" name="tracked" ${v.tracked ? 'checked' : ''} ${p?.adapter && p.adapter !== 'generic' ? 'disabled' : ''}>
          <span>Track live on the Precision<br><span class="muted small">Off = upcoming: kept on this board only. On = shows on Live &amp; Hourly; the reporter starts watching the folder within a minute.</span></span></label>
        ${p?.adapter && p.adapter !== 'generic' ? '<p class="muted small">This project is set up in config.json on the Precision (with its own numbers), so its folder and tracking are managed there.</p>' : ''}
        <div class="btn-row"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" style="margin-top:14px">Save</button></div>
        ${p && !p.tracked ? '<button class="btn danger" type="button" id="del-proj">Delete project</button>' : ''}
      </form>`);
    let stage = v.status;
    $('#stage-seg').addEventListener('click', (e) => { const b = e.target.closest('[data-stage]'); if (!b) return; stage = b.dataset.stage; $$('#stage-seg button').forEach((x) => x.classList.toggle('active', x === b)); });
    const range = $('#proj-form [name=progress]');
    range.addEventListener('input', () => { $('#prog-val').textContent = range.value + '%'; });
    $('#proj-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const row = {
        name: String(f.get('name')).trim(), status: stage, progress: Number(f.get('progress')),
        next_step: String(f.get('next_step')).trim() || null, target_date: f.get('target_date') || null,
        description: String(f.get('description')).trim() || null,
      };
      if (!row.name) return;
      if (!(p?.adapter && p.adapter !== 'generic')) {
        row.folder = String(f.get('folder') || '').trim() || null;
        row.tracked = !!f.get('tracked');
        if (row.tracked && !row.folder) { toast('Add the folder on the Precision before switching tracking on', true); return; }
        row.kind = row.tracked ? 'pipeline' : 'manual';
      }
      try {
        if (p) { row.slug = p.slug; await api.saveProject(row, false); Object.assign(p, row); }
        else {
          row.slug = uniqueSlug(row.name); row.kind = 'manual'; row.color_slot = freeSlot();
          row.sort_order = 1000 + state.projects.length;
          await api.saveProject(row, true);
          if (!projBySlug(row.slug)) state.projects.push({ ...row, created_at: new Date().toISOString() });
        }
        closeSheet(); toast(p ? 'Saved' : 'Project added'); renderAll();
      } catch (err) { toast(`Could not save: ${err.message || err}`, true); }
    });
    const del = $('#del-proj');
    if (del) {
      let armed = false;
      del.addEventListener('click', async () => {
        if (!armed) { armed = true; del.textContent = 'Tap again to delete for good'; setTimeout(() => { armed = false; del.textContent = 'Delete project'; }, 4000); return; }
        try { await api.deleteProject(p.slug); state.projects = state.projects.filter((x) => x.slug !== p.slug); closeSheet(); toast('Deleted'); renderAll(); }
        catch (err) { toast(`Could not delete: ${err.message || err}`, true); }
      });
    }
  }

  function uniqueSlug(name) {
    const base = name.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 40) || 'project';
    let s = base, i = 2;
    while (projBySlug(s)) s = `${base}-${i++}`;
    return s;
  }
  function freeSlot() {
    const used = new Set(state.projects.map((p) => p.color_slot));
    for (let i = 1; i <= 8; i++) if (!used.has(i)) return i;
    return 0;
  }

  // ---------- small UI bits
  let toastT = 0;
  function toast(msg, isErr = false) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (isErr ? ' error' : ''); t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, isErr ? 5000 : 2200);
  }
  function tooltip(evt, html) {
    const t = $('#tooltip'); t.innerHTML = html; t.hidden = false;
    const w = t.offsetWidth, h = t.offsetHeight;
    let x = evt.clientX + 12, y = evt.clientY - h - 12;
    if (x + w > innerWidth - 8) x = evt.clientX - w - 12;
    if (y < 8) y = evt.clientY + 16;
    t.style.left = Math.max(8, x) + 'px'; t.style.top = y + 'px';
  }
  function hideTooltip() { $('#tooltip').hidden = true; }

  function go(view) {
    if (!['live', 'today', 'projects', 'settings', 'login'].includes(view)) view = 'live';
    state.view = view;
    $$('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
    $$('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.go === view));
    $('#tabbar').hidden = view === 'login';
    if (view !== 'login' && location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
    if (view === 'settings') renderSettings();
    hideTooltip(); closeSheet();
    renderAll();
    window.scrollTo({ top: 0 });
  }

  // ---------- settings / theme
  function applyTheme() {
    const root = document.documentElement;
    root.removeAttribute('data-theme'); root.classList.remove('light-auto');
    if (opts.theme === 'light' || opts.theme === 'dark') root.setAttribute('data-theme', opts.theme);
    else if (matchMedia('(prefers-color-scheme: light)').matches) root.classList.add('light-auto');
    const meta = document.querySelector('meta[name=theme-color]');
    meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim() || '#111110');
    $$('#theme-seg button').forEach((b) => b.classList.toggle('active', b.dataset.theme === opts.theme));
  }

  function renderSettings() {
    const cfg = LS.get('cfg', {});
    $('#cfg-url').value = cfg.url || 'https://aiggbllehqxitpsmqqru.supabase.co';
    $('#cfg-key').value = cfg.key || '';
    $('#ntfy-topic').value = opts.ntfy;
    $('#opt-vibrate').checked = opts.vibrate;
    $('#opt-notify').checked = opts.notify;
    renderNtfyLink();
    $('#account-box').innerHTML = DEMO ? 'Demo mode — nothing is saved.' : state.user
      ? `Signed in as <b>${esc(state.user.email)}</b> <button class="btn" id="signout" style="margin:0 0 0 8px;padding:6px 12px">Sign out</button>`
      : (sb ? 'Not signed in.' : 'Not connected yet.');
    applyTheme();
  }
  function renderNtfyLink() {
    const t = opts.ntfy.trim();
    $('#ntfy-link').innerHTML = t ? `Subscribe: <a href="https://ntfy.sh/${encodeURIComponent(t)}" target="_blank" rel="noopener">ntfy.sh/${esc(t)}</a> (opens the ntfy app if installed)` : '';
  }

  // ------------------------------------------------------------------ boot / auth
  async function connect() {
    if (DEMO) { $('#demo-banner').hidden = false; state.user = { email: 'demo' }; await loadAll(); state.live = true; renderConn(); return go(location.hash.slice(1) || 'live'); }
    const cfg = LS.get('cfg', {});
    if (!cfg.url || !cfg.key) { sb = null; renderConn(); return go('settings'); }
    try {
      sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true } });
    } catch (e) { sb = null; toast('That URL or key does not look right', true); return go('settings'); }
    const { data } = await sb.auth.getSession();
    state.user = data.session?.user || null;
    sb.auth.onAuthStateChange((_ev, session) => { state.user = session?.user || null; renderConn(); });
    if (!state.user) { renderConn(); return go('login'); }
    await afterLogin();
  }

  async function afterLogin() {
    go(['live', 'today', 'projects', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'live');
    await loadAll();
    api.subscribe();
  }

  function bind() {
    $('#tabbar').addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go); });
    $('#refresh-btn').addEventListener('click', () => { if (state.user) { loadAll(); if (!DEMO) api.subscribe(); } });
    $('#day-prev').addEventListener('click', async () => { state.dayOffset--; state.selHour = null; await loadSelectedDay(); renderToday(); });
    $('#day-next').addEventListener('click', async () => { if (state.dayOffset >= 0) return; state.dayOffset++; state.selHour = null; await loadSelectedDay(); renderToday(); });
    $('#feed-chips').addEventListener('click', (e) => { const c = e.target.closest('[data-feed]'); if (c) { state.feedFilter = c.dataset.feed; renderLive(); } });
    $('#status-chips').addEventListener('click', (e) => { const c = e.target.closest('[data-filter]'); if (c) { state.filter = c.dataset.filter; renderBoard(); } });
    $('#add-project').addEventListener('click', () => openEditor(null));
    document.addEventListener('click', (e) => {
      const ed = e.target.closest('[data-edit]'); if (ed) { openEditor(ed.dataset.edit); return; }
      const pr = e.target.closest('[data-proj]'); if (pr) { openProjectDetail(pr.dataset.proj); return; }
      if (e.target.closest('[data-close]')) { closeSheet(); return; }
      const li = e.target.closest('li[data-ev]'); if (li) { const d = $('.f-detail', li); if (d) d.hidden = !d.hidden; }
      if (e.target.id === 'signout') { sb.auth.signOut().then(() => { state.user = null; state.ready = false; if (channel) sb.removeChannel(channel); go('login'); }); }
      if (!e.target.closest('.chart')) hideTooltip();
    });
    $('#sheet-backdrop').addEventListener('click', closeSheet);
    addEventListener('scroll', hideTooltip, { passive: true });
    $('#cfg-save').addEventListener('click', async () => {
      const url = $('#cfg-url').value.trim().replace(/\/+$/, ''); const key = $('#cfg-key').value.trim();
      if (!/^https:\/\/.+/.test(url) || key.length < 20) { toast('Enter the project URL (https://…) and the publishable key', true); return; }
      if (key.startsWith('sb_secret_')) { toast('That is the SECRET key — use the publishable (anon) key here', true); return; }
      LS.set('cfg', { url, key }); toast('Saved'); await connect();
    });
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault(); $('#login-msg').textContent = '';
      const { data, error } = await sb.auth.signInWithPassword({ email: $('#login-email').value.trim(), password: $('#login-pass').value });
      if (error) { $('#login-msg').textContent = error.message; return; }
      state.user = data.user; $('#login-pass').value = ''; await afterLogin();
    });
    $('#ntfy-topic').addEventListener('input', (e) => { opts.ntfy = e.target.value.trim(); LS.set('ntfy', opts.ntfy); renderNtfyLink(); });
    $('#opt-vibrate').addEventListener('change', (e) => { opts.vibrate = e.target.checked; LS.set('vibrate', opts.vibrate); });
    $('#opt-notify').addEventListener('change', async (e) => {
      opts.notify = e.target.checked;
      if (opts.notify && 'Notification' in window && Notification.permission === 'default') {
        try { const r = await Notification.requestPermission(); if (r !== 'granted') { opts.notify = false; e.target.checked = false; toast('Notifications were not allowed', true); } } catch { /* ignore */ }
      }
      LS.set('notify', opts.notify);
    });
    $('#theme-seg').addEventListener('click', (e) => { const b = e.target.closest('[data-theme]'); if (!b) return; opts.theme = b.dataset.theme; LS.set('theme', opts.theme); applyTheme(); renderAll(); });
    matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme);
    addEventListener('hashchange', () => { const v = location.hash.slice(1); if (v && v !== state.view && state.user) go(v); });

    // phones suspend background tabs: catch up the moment the app is opened again
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.user && !DEMO) { loadAll(); if (!state.live) api.subscribe(); } });
    addEventListener('online', () => { if (state.user && !DEMO) { loadAll(); api.subscribe(); } });
    // keep "x min ago", online/offline and running timers fresh
    setInterval(() => { if (DEMO && state.machine) state.machine.updated_at = new Date().toISOString(); if (state.view === 'live') renderLive(); renderConn(); }, 5000);
    // safety net in case a realtime message is missed
    setInterval(() => { if (state.user && !DEMO && !document.hidden) loadAll(); }, 120000);
    // midnight rollover
    let lastDay = new Date().getDate();
    setInterval(() => { const d = new Date().getDate(); if (d !== lastDay) { lastDay = d; if (state.user) loadAll(); } }, 60000);
  }

  if ('serviceWorker' in navigator && !DEMO && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  applyTheme();
  bind();
  connect();

  // ------------------------------------------------------------------ demo data (preview only, clearly labelled)
  function makeDemoApi() {
    const now = Date.now();
    const at = (h, m) => { const d = startOfDay(0); d.setHours(h, m, 0, 0); return d.toISOString(); };
    const projects = [
      { slug: 'leonida-daily', name: 'Leonida Reels & Videos', status: 'live', kind: 'pipeline', tracked: true, adapter: 'leonida', color_slot: 1, description: 'GTA 6 streamer highlights: 3 Shorts a day + 2 long videos a week', progress: 70, folder: 'C:\\Users\\hamza\\Desktop\\yt shorts pprojrct' },
      { slug: 'zehn-nama', name: 'Zehn Nama Weekly Posts', status: 'live', kind: 'pipeline', tracked: true, adapter: 'zehn_nama', color_slot: 2, description: 'Friday writing run: 7 posts + 7 reels', progress: 85, folder: 'C:\\Users\\hamza\\Desktop\\fb new pages ideas with automation' },
      { slug: 'urdu-poetry-reels', name: 'Urdu Poetry Reels', status: 'idea', kind: 'manual', tracked: false, color_slot: 3, description: 'Example of an upcoming project', progress: 0, next_step: 'Collect 30 couplets' },
    ].map((p, i) => ({ ...p, sort_order: i + 1, created_at: new Date().toISOString() }));
    const ev = []; let id = 1;
    const add = (ts, project, kind, level, title, data = {}) => { if (Date.parse(ts) <= now) ev.push({ id: id++, ts, project, kind, level, title, data }); };
    add(at(7, 2), 'system', 'machine_online', 'success', 'Precision 7730 is online');
    add(at(7, 5), 'leonida-daily', 'run_started', 'info', 'Run started: scan_streams.py');
    add(at(7, 6), 'leonida-daily', 'step', 'info', 'Step: download_vods.py');
    add(at(7, 31), 'leonida-daily', 'file', 'info', 'Working video saved: stream_0412.mp4');
    add(at(7, 40), 'leonida-daily', 'step', 'info', 'Step: transcribe.py');
    add(at(8, 3), 'leonida-daily', 'short', 'success', 'New Short ready: short_0701.mp4 (0:48, 1080×1920)');
    add(at(8, 20), 'leonida-daily', 'run_finished', 'success', 'Run finished after 75 min — made 1 Short, 1 file');
    add(at(10, 52), 'leonida-daily', 'error', 'error', 'Error in run.log: RuntimeError: CUDA out of memory');
    add(at(12, 15), 'leonida-daily', 'run_started', 'info', 'Run started: scan_streams.py');
    add(at(12, 58), 'leonida-daily', 'short', 'success', 'New Short ready: short_0702.mp4 (0:55, 1080×1920)');
    add(at(13, 2), 'leonida-daily', 'run_finished', 'success', 'Run finished after 47 min — made 1 Short');
    add(at(13, 30), 'zehn-nama', 'published', 'info', 'Moved to posted: 2026-11-23_week47');
    add(at(16, 10), 'leonida-daily', 'run_started', 'info', 'Run started: scan_streams.py');
    add(at(16, 12), 'leonida-daily', 'step', 'info', 'Step: transcribe.py');
    const samples = [];
    for (let t = Date.parse(at(7, 0)); t <= now; t += 60e3) {
      const h = new Date(t).getHours() + new Date(t).getMinutes() / 60;
      const busy = (h > 7 && h < 8.4) || (h > 12.2 && h < 13.1) || h > 16.1;
      samples.push({ ts: new Date(t).toISOString(), cpu: (busy ? 55 : 12) + Math.sin(t / 7e5) * 8, gpu_util: busy ? 72 + Math.sin(t / 3e5) * 15 : 4, gpu_temp: busy ? 74 : 47, ram_pct: busy ? 61 : 38 });
    }
    const running = Date.parse(at(16, 10)) <= now;
    const summaries = {
      'leonida-daily': { kpis: [{ label: 'Shorts today', value: 2, target: 3 }, { label: 'Long videos this week', value: 1, target: 2 }, { label: 'Shorts this week', value: 9, target: 21 }],
        lines: [{ text: 'Latest short: short_0702.mp4 · 12:58 pm' }, { text: '1 long video to go this week — due by tonight (week ends Sunday).', level: 'warn' }] },
      'zehn-nama': { kpis: [{ label: 'Posts ready', value: 6, target: null }, { label: 'Reels ready', value: 7, target: null }, { label: 'On hold', value: 1, target: null, level: 'warn' }],
        lines: [{ text: 'Latest batch 2026-11-30_week48: 7 posts, 7 reels · written Fri 9:41 pm' }, { text: 'Next photo post: #9 (Urdu) · Gratitude journaling — publisher slot today 8:30 pm' }, { text: 'Next reel: #8 (English) — publisher slot Mon 1:30 pm' }, { text: 'Next weekly writing run: Fri 27 Nov, 8:37 pm' }] },
    };
    const pstate = projects.map((p) => {
      const last = ev.filter((e) => e.project === p.slug && e.kind !== 'step').at(-1);
      const run = p.slug === 'leonida-daily' && running;
      return { slug: p.slug, running: run, run_started_at: at(16, 10), current_step: run ? 'transcribe.py → ffmpeg' : null, step_started_at: at(16, 12), cpu: run ? 46 : null, mem_gb: run ? 5.8 : null,
        last_event_at: last?.ts, last_title: last?.title, last_level: last?.level, summary: summaries[p.slug] || {}, summary_at: new Date(now - 40e3).toISOString() };
    });
    const machine = { id: 'precision', name: 'Precision 7730', updated_at: new Date().toISOString(), online_since: at(7, 2), cpu: 58, ram_used_gb: 19.6, ram_total_gb: 32, gpu_name: 'Quadro P3200', gpu_util: 81, gpu_temp: 76, gpu_mem_used_mb: 4100, gpu_mem_total_mb: 6144, disks: [{ mount: 'C:\\', free_gb: 112, total_gb: 476 }, { mount: 'D:\\', free_gb: 640, total_gb: 931 }], queue_backlog: 0, net_ok: true };
    return {
      async loadCore() { machine.updated_at = new Date().toISOString(); return { projects: structuredClone(projects), pstate, machine, feed: ev.slice().reverse() }; },
      async loadDay(start) { return isSameDay(start, Date.now()) ? { events: ev.slice(), samples } : { events: [], samples: [] }; },
      async saveProject() {}, async deleteProject() {}, subscribe() {},
    };
  }
})();
