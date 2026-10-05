// The site's page script: renders Markdown with the app's own renderer, builds a docs TOC, and
// reads GitHub (public API, no key) for the changelog and the feedback list. Cached 10 minutes in
// localStorage, because the unauthenticated limit is 60 requests an hour per visitor.
const BASE = document.body.dataset.base ?? '/';
const REPO = document.body.dataset.repo;
const API = `https://api.github.com/repos/${REPO}`;
const { renderMarkdown } = await import(`${BASE}demo/app/markdown.js`);

function render(md, into) {
  into.replaceChildren(renderMarkdown(md));
  into.toggleAttribute('data-rendered', true);
  // The renderer opens every link in a new tab, which is right for a model's answer and wrong for
  // the docs: a link into this site stays here.
  for (const a of into.querySelectorAll('a[href]')) if (a.origin === location.origin) { a.removeAttribute('target'); a.removeAttribute('rel'); }
  const slug = (s) => s.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
  for (const h of into.querySelectorAll('h2, h3')) h.id ||= slug(h.textContent);
}

// Docs: the Markdown is in the page; render it, then the TOC from its headings.
for (const block of document.querySelectorAll('[data-md]')) {
  render(block.textContent, block);
  const toc = block.closest('.docs')?.querySelector('.toc');
  if (toc) for (const h of block.querySelectorAll('h2, h3')) { const a = document.createElement('a'); a.href = `#${h.id}`; a.textContent = h.textContent; a.dataset.depth = h.tagName[1]; toc.append(a); }
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

async function github(url, ttl = 600_000) {
  try { const hit = JSON.parse(localStorage.getItem(`gh:${url}`)); if (hit && Date.now() - hit.at < ttl) return hit.data; } catch {}
  const r = await fetch(url, { headers: { accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const data = await r.json();
  try { localStorage.setItem(`gh:${url}`, JSON.stringify({ at: Date.now(), data })); } catch {}
  return data;
}
const el = (tag, attrs = {}, children = []) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) if (k === 'text') n.textContent = v; else if (v != null) n.setAttribute(k, v); n.append(...children.filter(Boolean)); return n; };
const when = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// Changelog: the notes are in the page; GitHub adds each release's link and the download.
const releases = document.getElementById('releases');
if (releases) github(`${API}/releases?per_page=20`).then((list) => {
  for (const r of list) {
    const slot = releases.querySelector(`.release[data-tag="${CSS.escape(r.tag_name)}"] .release-link`);
    if (slot) slot.replaceChildren(el('a', { href: r.html_url, rel: 'noopener', text: r.assets?.length ? 'Download' : 'Release' }));
  }
}).catch(() => {});

// Feedback: issues with the label, newest first, each with the pull requests that mention it.
const feedback = document.getElementById('feedback');
if (feedback) {
  try {
    const issues = (await github(`${API}/issues?labels=feedback&state=all&per_page=30&sort=created&direction=desc`)).filter((i) => !i.pull_request);
    if (!issues.length) {
      feedback.replaceChildren(el('p', { class: 'quiet', text: 'Nothing yet. The first note goes here.' }));
    } else {
      feedback.replaceChildren(...issues.map((i) => {
        const where = i.body?.match(/### Where[^\n]*\n+([^\n]+)/)?.[1]?.trim() ?? '';
        const pinned = /^demo:([^@\s]+)@/.exec(where)?.[1];
        const prs = el('div', { class: 'prs' });
        const node = el('article', { class: 'issue', 'data-state': i.state }, [
          el('span', { class: 'issue-state', title: i.state }),
          el('div', {}, [
            el('a', { class: 'issue-title', href: i.html_url, rel: 'noopener', text: i.title }),
            el('p', { class: 'issue-meta' }, [el('span', { text: `#${i.number}` }), el('span', { text: when(i.created_at) }), pinned ? el('a', { href: `${BASE}demo/`, text: `pinned on ${pinned} in the demo` }) : null, i.comments ? el('span', { text: `${i.comments} repl${i.comments === 1 ? 'y' : 'ies'}` }) : null, el('span', { text: i.state === 'open' ? 'open' : 'closed' })]),
            prs,
          ]),
        ]);
        // The PRs that answered it: cross-references in the issue's own timeline, for the first
        // dozen, to stay inside the hourly limit.
        if (issues.indexOf(i) < 12) github(`${API}/issues/${i.number}/timeline?per_page=100`).then((events) => {
          const seen = new Set();
          for (const e of events) {
            const src = e.event === 'cross-referenced' ? e.source?.issue : null;
            if (!src?.pull_request || seen.has(src.number)) continue;
            seen.add(src.number);
            const state = src.pull_request.merged_at ? 'merged' : src.state;
            prs.append(el('a', { class: 'pr', 'data-state': state, href: src.html_url, rel: 'noopener', text: `PR #${src.number} · ${state}` }));
          }
        }).catch(() => {});
        return node;
      }));
    }
  } catch {
    feedback.replaceChildren(el('p', { class: 'quiet' }, [document.createTextNode('GitHub could not be read just now. The notes live at '), el('a', { href: `https://github.com/${REPO}/issues?q=label%3Afeedback`, text: 'github.com' }), document.createTextNode('.')]));
  }
}

// ── The landing's two hands-on pieces ─────────────────────────────────────────────────────────
// The ledger wire: a left row, under the pointer or focus, is joined by one line to the model
// entry, which then names the fields the model gets from it. Tap toggles on touch screens.
const ledger = document.querySelector('.ledger');
if (ledger) {
  const wire = ledger.querySelector('.wire');
  const reads = ledger.querySelector('.row-reads');
  const target = ledger.querySelector('.row-primary');
  let on = null;
  const draw = (row) => {
    if (!row || !target || !wire) return;
    const box = ledger.getBoundingClientRect(), dot = row.querySelector('.row-reach')?.getBoundingClientRect(), to = target.getBoundingClientRect();
    if (!dot) return;
    const x1 = dot.right - box.left, y1 = dot.top + dot.height / 2 - box.top, x2 = to.left - box.left - 22, y2 = to.top + to.height / 2 - box.top;
    const mid = x1 + (x2 - x1) / 2;
    wire.setAttribute('d', `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`);
  };
  const set = (row) => {
    if (on === row) return;
    on?.removeAttribute('data-on');
    on = row;
    if (!row) { ledger.removeAttribute('data-wired'); if (reads) reads.textContent = reads.dataset.rest; return; }
    row.setAttribute('data-on', '');
    if (row.dataset.fields !== undefined) {
      ledger.setAttribute('data-wired', '');
      draw(row);
      if (reads) reads.replaceChildren(document.createTextNode('From '), Object.assign(document.createElement('b'), { textContent: row.dataset.name }), document.createTextNode(`: ${row.dataset.fields}, cleaned.`));
    } else {
      ledger.removeAttribute('data-wired');
      if (reads) reads.replaceChildren(Object.assign(document.createElement('b'), { textContent: row.dataset.name }), document.createTextNode(' is not part of what is sent. Gnomon reads it only when you ask about it.'));
    }
  };
  const rows = ledger.querySelectorAll('.col-stays .row');
  for (const row of rows) {
    row.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') set(row); });
    row.addEventListener('focus', () => set(row));
    row.addEventListener('click', () => set(on === row ? null : row));
  }
  ledger.querySelector('.col-stays').addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && document.activeElement?.closest('.col-stays .row') === null) set(null); });
  ledger.addEventListener('focusout', (e) => { if (!ledger.contains(e.relatedTarget)) set(null); });
  addEventListener('resize', () => draw(on), { passive: true });
  addEventListener('scroll', () => { if (on && ledger.hasAttribute('data-wired')) draw(on); }, { passive: true });
}

// The pipeline: a stage under the hand explains itself below the row.
const stages = document.querySelector('.stages');
if (stages) {
  const why = document.querySelector('.stage-why'), rest = why?.textContent ?? '';
  let on = null, timer = 0;
  const tell = (stage) => {
    on?.removeAttribute('data-on'); on = stage; stage?.setAttribute('data-on', '');
    if (!why) return;
    why.setAttribute('data-swap', '');
    clearTimeout(timer);
    timer = setTimeout(() => { why.textContent = stage?.dataset.why ?? rest; why.removeAttribute('data-swap'); }, 160);
  };
  for (const stage of stages.querySelectorAll('.stage')) {
    stage.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') tell(stage); });
    stage.addEventListener('focus', () => tell(stage));
    stage.addEventListener('click', () => tell(on === stage ? null : stage));
  }
  stages.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && !stages.contains(document.activeElement)) tell(null); });
  stages.addEventListener('focusout', (e) => { if (!stages.contains(e.relatedTarget)) tell(null); });
}

// Commands copy themselves. The button says so for a moment, then goes back to waiting.
for (const pre of document.querySelectorAll('.cmd')) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'cmd-copy'; b.textContent = 'Copy';
  b.onclick = async () => { try { await navigator.clipboard.writeText(pre.querySelector('code')?.textContent ?? pre.textContent); b.textContent = 'Copied'; b.setAttribute('data-done', ''); setTimeout(() => { b.textContent = 'Copy'; b.removeAttribute('data-done'); }, 1400); } catch { b.textContent = 'Select it'; } };
  pre.append(b);
}

// Docs: the table of contents follows the heading in view.
const toc = document.querySelector('.toc');
if (toc && toc.children.length) {
  const links = new Map([...toc.querySelectorAll('a')].map((a) => [a.hash.slice(1), a]));
  let current = null;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { current?.removeAttribute('aria-current'); current = links.get(e.target.id); current?.setAttribute('aria-current', 'true'); }
  }, { rootMargin: '0px 0px -70% 0px' });
  for (const id of links.keys()) { const h = document.getElementById(id); if (h) io.observe(h); }
}
