# RedAlt Industrial Media Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone HTML prototype that applies the approved Industrial Command Center + media-forward RedAlt UI direction.

**Architecture:** Create one self-contained HTML file at the project root so the visual system can be reviewed without touching the React app. The page uses static sample Reddit-like content, internal CSS, responsive layout, and no build-step dependencies.

**Tech Stack:** Plain HTML5 and CSS; optional browser-only inline JavaScript for selection/toggle interactions if needed.

---

## File Structure

- Create: `prototype-industrial-media.html` — standalone high-fidelity prototype page with top command header, left command rail, media-forward feed, responsive mobile layout, and no right rail.
- Do not modify: `src/App.tsx`, `src/index.css`, or React components in this prototype step.

---

### Task 1: Create the standalone prototype HTML

**Files:**
- Create: `prototype-industrial-media.html`

- [ ] **Step 1: Create `prototype-industrial-media.html` with the approved layout**

Use a single HTML file with this structure:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>RedAlt Industrial Media Prototype</title>
  <style>
    /* Internal CSS implements near-black steel background, orange signal accents, cyan media glow, compact command chips, left rail, and responsive feed. */
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="#">RedAlt</a>
      <form class="command-search">
        <span>r/</span>
        <input type="search" value="popular" aria-label="Search subreddit or posts" />
      </form>
      <nav class="top-actions" aria-label="Primary actions">
        <a href="#">Saved</a>
        <a href="#">History</a>
        <button type="button">Settings</button>
      </nav>
    </header>

    <div class="workspace">
      <aside class="left-rail" aria-label="Feed controls">
        <section class="panel">
          <p class="panel-kicker">Communities</p>
          <a href="#">r/popular</a>
          <a href="#">r/technology</a>
          <a href="#">r/videos</a>
          <a href="#">r/design</a>
        </section>
        <section class="panel">
          <p class="panel-kicker">Modes</p>
          <button type="button">Hot</button>
          <button type="button">New</button>
          <button type="button">Media</button>
        </section>
      </aside>

      <main class="feed" aria-label="RedAlt feed">
        <section class="hero-card">
          <p class="signal-label">Live feed / Industrial media mode</p>
          <h1>Browse Reddit like a command center built for media.</h1>
          <p>Compact controls, sharp orange metadata, large previews, and no right rail.</p>
        </section>

        <article class="post-card feature-card">
          <div class="post-media media-grid"></div>
          <div class="post-body">
            <p class="meta-strip">r/technology · u/signalpilot · 18.4k points · 921 comments</p>
            <h2>The new interface prioritizes fast scanning without hiding visual posts.</h2>
            <p>Every card keeps metadata visible, actions compact, and the media large enough to matter.</p>
            <footer class="post-actions">
              <a href="#">Comments</a>
              <button type="button">Share</button>
              <button type="button">Save</button>
              <a href="#">Open source</a>
            </footer>
          </div>
        </article>

        <article class="post-card">
          <div class="post-media media-orange"></div>
          <div class="post-body">
            <p class="meta-strip">r/videos · u/framehunter · 9.8k points · 402 comments</p>
            <h2>Media-forward browsing still works in a dense Reddit-style feed.</h2>
            <footer class="post-actions">
              <a href="#">Comments</a>
              <button type="button">Share</button>
              <button type="button">Save</button>
            </footer>
          </div>
        </article>

        <article class="post-card text-card">
          <div class="post-body">
            <p class="meta-strip">r/AskReddit · u/threadoperator · 42.1k points · 6.3k comments</p>
            <h2>What small interface change made an app instantly better for you?</h2>
            <p>Text posts use the same industrial rhythm without forcing empty media space.</p>
            <footer class="post-actions">
              <a href="#">Comments</a>
              <button type="button">Share</button>
              <button type="button">Save</button>
            </footer>
          </div>
        </article>
      </main>
    </div>
  </div>
</body>
</html>
```

Expected: The file exists at the project root and opens directly in a browser.

- [ ] **Step 2: Fill in the internal CSS**

Use CSS variables and implement these core styles:

```css
:root {
  --bg: #070809;
  --steel: #101318;
  --steel-2: #171b22;
  --line: #2a3039;
  --text: #f3f0e8;
  --muted: #9ba3ae;
  --orange: #ff6a00;
  --orange-2: #ff9a3d;
  --cyan: #36e7ff;
  --shadow: rgba(0, 0, 0, 0.55);
}

* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  color: var(--text);
  background:
    radial-gradient(circle at 78% 8%, rgba(255,106,0,.18), transparent 26%),
    radial-gradient(circle at 18% 18%, rgba(54,231,255,.10), transparent 22%),
    repeating-linear-gradient(90deg, transparent 0 31px, rgba(255,255,255,.025) 32px),
    var(--bg);
  font-family: "Segoe UI", system-ui, sans-serif;
}

.shell { width: min(1440px, 100%); margin: 0 auto; padding: 18px; }
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: grid;
  grid-template-columns: auto minmax(220px, 1fr) auto;
  gap: 14px;
  align-items: center;
  padding: 14px;
  background: rgba(10, 12, 15, .92);
  border: 1px solid var(--line);
  box-shadow: 0 20px 60px var(--shadow);
  backdrop-filter: blur(18px);
}
.brand { color: var(--orange); font-size: 34px; font-weight: 950; letter-spacing: -.08em; text-decoration: none; }
.command-search, .top-actions, .post-actions { display: flex; gap: 10px; align-items: center; }
.command-search { background: var(--steel); border: 1px solid var(--line); padding: 8px 12px; color: var(--orange); }
.command-search input { flex: 1; min-width: 0; background: transparent; border: 0; color: var(--text); font: inherit; outline: 0; }
a, button { color: var(--text); }
button, .top-actions a, .post-actions a, .post-actions button, .left-rail a, .left-rail button {
  border: 1px solid var(--line);
  background: linear-gradient(180deg, var(--steel-2), var(--steel));
  padding: 9px 12px;
  text-decoration: none;
  font-weight: 800;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: .08em;
}
button:hover, a:hover { border-color: var(--orange); box-shadow: 0 0 22px rgba(255,106,0,.18); }
.workspace { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 18px; margin-top: 18px; }
.left-rail { display: grid; align-content: start; gap: 14px; }
.panel { background: rgba(16,19,24,.86); border: 1px solid var(--line); padding: 14px; box-shadow: 0 14px 40px var(--shadow); }
.panel-kicker, .signal-label, .meta-strip { color: var(--orange); font-family: Consolas, "Courier New", monospace; text-transform: uppercase; letter-spacing: .12em; font-size: 12px; }
.panel a, .panel button { display: block; width: 100%; margin-top: 8px; text-align: left; }
.feed { display: grid; gap: 18px; }
.hero-card, .post-card { background: rgba(16,19,24,.9); border: 1px solid var(--line); box-shadow: 0 20px 70px var(--shadow); }
.hero-card { padding: clamp(26px, 5vw, 64px); }
.hero-card h1 { max-width: 900px; margin: 0; font-size: clamp(42px, 8vw, 108px); line-height: .86; letter-spacing: -.09em; }
.hero-card p:last-child { color: var(--muted); max-width: 680px; font-size: 18px; }
.post-card { overflow: hidden; display: grid; grid-template-columns: minmax(300px, .95fr) 1fr; }
.post-card.text-card { display: block; }
.post-media { min-height: 330px; border-right: 1px solid var(--line); }
.media-grid { background: linear-gradient(135deg, rgba(54,231,255,.24), transparent 32%), repeating-linear-gradient(45deg, #171b22 0 18px, #0e1116 19px 36px); }
.media-orange { background: radial-gradient(circle at 35% 35%, rgba(255,154,61,.92), transparent 22%), linear-gradient(135deg, #251006, #0d0f12); }
.post-body { padding: 22px; }
.post-body h2 { margin: 12px 0; font-size: clamp(25px, 4vw, 52px); line-height: .96; letter-spacing: -.055em; }
.post-body p:not(.meta-strip) { color: var(--muted); }
.post-actions { flex-wrap: wrap; margin-top: 20px; }

@media (max-width: 900px) {
  .topbar { grid-template-columns: 1fr; }
  .workspace { grid-template-columns: 1fr; }
  .left-rail { grid-template-columns: 1fr 1fr; }
  .post-card { grid-template-columns: 1fr; }
  .post-media { border-right: 0; border-bottom: 1px solid var(--line); }
}

@media (max-width: 560px) {
  .shell { padding: 10px; }
  .left-rail { grid-template-columns: 1fr; }
  .top-actions { flex-wrap: wrap; }
}
```

Expected: The page visually matches the approved industrial/media direction and has no right rail.

- [ ] **Step 3: Open the HTML file locally and inspect the golden path**

Run:

```powershell
Start-Process "C:\Users\Yoova\onedrive\dokumen\coding\redalt\prototype-industrial-media.html"
```

Expected: Browser opens the standalone prototype.

- [ ] **Step 4: Verify responsive layout**

Manually resize the browser to desktop, tablet, and phone widths.

Expected:
- Desktop shows top bar, left rail, and main feed.
- Tablet/phone collapses to a single-column workspace.
- No right rail appears at any width.
- Feed cards keep large media previews where media exists.

- [ ] **Step 5: Run project build to ensure no app regression**

Run:

```powershell
npm run build
```

Expected: TypeScript and Vite build pass. The standalone HTML file should not affect the app build.

- [ ] **Step 6: Review git diff**

Run:

```powershell
git diff -- prototype-industrial-media.html docs/superpowers/specs/2026-05-28-redalt-ui-revamp-design.md docs/superpowers/plans/2026-05-28-redalt-industrial-media-prototype.md
```

Expected: Diff contains only the prototype HTML and superpowers spec/plan documents.
