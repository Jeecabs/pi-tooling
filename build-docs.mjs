// Generates the GitHub Pages site in docs/ from every project's README + docs/*.md.
// Usage: node build-docs.mjs
import { marked } from "marked";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(ROOT, "docs");
const STYLE_VERSION = createHash("sha256")
  .update(fs.readFileSync(path.join(ROOT, "site-style.css")))
  .digest("hex").slice(0, 12);

const PROJECTS = [
  { dir: "gang", cat: "ORCHESTRATION" },
  { dir: "micro-manager", cat: "ORCHESTRATION" },
  { dir: "pi-processes", name: "no-block", cat: "ORCHESTRATION" },
  { dir: "pi-mobile-bridge", cat: "ORCHESTRATION" },
  { dir: "no-forgetti", cat: "MEMORY", site: "https://jeecabs.github.io/no-forgetti/" },
  { dir: "moron-guard", cat: "GUARDRAILS" },
  { dir: "da-browser", cat: "BROWSER & QA" },
  { dir: "pi-filmstrip", cat: "BROWSER & QA" },
  { dir: "aura", cat: "INTERFACE" },
  { dir: "pi-startup-message", cat: "INTERFACE" },
  { dir: "a-pi-that-draws", cat: "INTERFACE" },
  { dir: "pi-html-artifacts", cat: "INTERFACE" },
  { dir: "yapping-to-a-pi", cat: "INTERFACE" },
  { dir: "graph-of-thonking", cat: "WORKFLOW" },
  { dir: "pi-next-step", cat: "WORKFLOW" },
  { dir: "pi-tooltime", cat: "WORKFLOW" },
  { dir: "pilot-manual-enjoyer", cat: "WORKFLOW" },
  { dir: "better-frontend", cat: "WORKFLOW" },
  { dir: "notion-pi", cat: "INTEGRATIONS" },
  { dir: "pi-extensions", cat: "INTEGRATIONS" },
];

// Personal recommendations, shown first on the landing page in this order.
// Rendered only if the project also passed the isPublic check below.
const FEATURED = [
  {
    dir: "gang",
    img: "assets/gang-logo.png",
    alt: "A crew of animal agents coordinating work across terminal screens",
    pitch: "Put agents to work together without losing sight of them.",
    what: "Visible tmux agents, cross-agent messaging, and a mission-control interface for Pi.",
  },
  {
    dir: "micro-manager",
    img: "assets/micro-manager.png",
    alt: "Grumpy mascot marking up terminal output with a pencil while holding a review checklist",
    pitch: "I want a reviewer on every turn, not only the ones I remember to check.",
    what: "Independent models read each finished turn with read-only tools and speak up only with a concrete nit, concern, or blocker.",
  },
  {
    dir: "pi-processes",
    img: "assets/no-block-logo.png",
    alt: "No Block mascot vaulting over a blocked terminal command",
    pitch: "A long test run should not hold the whole session hostage.",
    what: "Replaces Pi's Bash tool for finite jobs. Quick commands return normally. Slow ones yield after 30 seconds, stay supervised, and report back when they exit.",
  },
  {
    dir: "da-browser",
    img: "assets/da-browser.png",
    alt: "Tabby cat reaching for a cursor in a browser window",
    pitch: "An agent that builds frontends should be able to look at them.",
    what: "Browser-control tools powered by agent-browser. Connect Arc or Chromium over remote debugging and let Pi navigate, click, and inspect the page.",
  },
];

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Hard privacy constraint: only document tools whose GitHub repo is PUBLIC.
// Several private repos are job-specific and must never appear on this site.
const isPublic = (repo) => {
  try {
    const slug = repo.replace("https://github.com/", "");
    return (
      execSync(`gh repo view ${slug} --json visibility -q .visibility`, {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim() === "PUBLIC"
    );
  } catch {
    return false;
  }
};

const repoUrl = (dir) => {
  try {
    const cfg = fs.readFileSync(path.join(ROOT, dir, ".git", "config"), "utf8");
    return cfg.match(/url = (.+)/)?.[1].trim().replace(/\.git$/, "") ?? null;
  } catch {
    return null;
  }
};

const description = (dir) => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, dir, "package.json"), "utf8"));
    if (pkg.description) return pkg.description;
  } catch {}
  const md = fs.readFileSync(path.join(ROOT, dir, "README.md"), "utf8");
  return (
    md.split("\n").map((l) => l.trim()).find((l) => l && !/^[#<!\[]/.test(l)) ?? ""
  );
};

function walkDocs(dir) {
  const docsDir = path.join(ROOT, dir, "docs");
  if (!fs.existsSync(docsDir)) return [];
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) found.push(path.relative(path.join(ROOT, dir), p));
    }
  };
  walk(docsDir);
  return found.sort();
}

const stripFrontmatter = (md) => md.replace(/^---\n[\s\S]*?\n---\n/, "");

const titleOf = (md, fallback) =>
  md.match(/^#\s+(.+)$/m)?.[1].replace(/[*_`]/g, "").trim() ?? fallback;

// Rewrites relative links/images in rendered HTML; copies referenced local assets
// into the mirrored output tree so relative paths keep working.
function fixHtml(html, proj, mdRel, repo, site) {
  const mdDirAbs = path.join(ROOT, proj, path.dirname(mdRel));
  const copyAsset = (src) => {
    const abs = path.resolve(mdDirAbs, decodeURIComponent(src));
    const rel = path.relative(path.join(ROOT, proj), abs);
    if (rel.startsWith("..") || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return;
    if (fs.statSync(abs).size > 20 * 1024 * 1024) return;
    const dest = path.join(OUT, proj, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
  };
  html = html.replace(/(src|href)="([^"]+)"/g, (m, attr, url) => {
    if (/^(https?:|mailto:|#|data:)/.test(url)) return m;
    if (url.startsWith("/") && site) {
      return `${attr}="${esc(new URL(url.slice(1), site).href)}"`;
    }
    if (attr === "src") {
      copyAsset(url);
      return m;
    }
    if (/\.md(#.*)?$/.test(url)) {
      const [file, fragment] = url.split("#");
      const rel = path.relative(path.join(ROOT, proj), path.resolve(mdDirAbs, decodeURIComponent(file)));
      if (rel !== "README.md" && !rel.startsWith("docs/")) {
        return `${attr}="${esc(`${repo}/blob/HEAD/${rel}${fragment ? `#${fragment}` : ""}`)}"`;
      }
      if (url.endsWith("README.md")) return `${attr}="${url.replace(/README\.md$/, "index.html")}"`;
      return `${attr}="${url.replace(/\.md(#.*)?$/, ".html$1")}"`;
    }
    copyAsset(url); // non-md relative file (license, image link, etc.)
    return m;
  });
  return html.replace(/<(pre|table)>/g, '<$1 tabindex="0">');
}

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">`;

const shell = ({ title, depth, body, nav }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${FONTS}
<link rel="stylesheet" href="${"../".repeat(depth)}style.css?v=${STYLE_VERSION}">
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<div class="topnav">
  <a class="logo" href="${"../".repeat(depth)}index.html"><span class="pi">&pi;</span> my glorious pi setup</a>
  <nav>${nav}</nav>
</div>
${body}
</body>
</html>
`;

// ---------- build project pages ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
// style.css lives outside the generated tree; restore it after the wipe
fs.copyFileSync(path.join(ROOT, "site-style.css"), path.join(OUT, "style.css"));

const index = [];

for (const p of PROJECTS) {
  const repo = repoUrl(p.dir);
  if (!repo || !isPublic(repo)) {
    console.log(`skipped ${p.dir}: repo not public`);
    continue;
  }
  const desc = description(p.dir).replace(/\s+—\s+/g, ": ");
  const pages = []; // {rel, out, title}
  const mdFiles = ["README.md", ...walkDocs(p.dir)];

  for (const rel of mdFiles) {
    const raw = stripFrontmatter(fs.readFileSync(path.join(ROOT, p.dir, rel), "utf8"));
    if (raw.trim().length < 40) continue;
    const out = rel === "README.md" ? "index.html" : rel.replace(/\.md$/, ".html");
    pages.push({ rel, out, title: rel === "README.md" ? "README" : titleOf(raw, path.basename(rel, ".md")), raw });
  }

  for (const page of pages) {
    const depth = page.out.split("/").length; // docs-root depth: <proj>/ counts once, plus out's subdirs
    const up = "../".repeat(depth - 1); // to project root within docs/
    const sidebar = pages
      .map((s) => {
        const href = up + s.out;
        const cur = s.out === page.out ? ' class="current"' : "";
        return `<a${cur} href="${href}"><span class="marker">${s.out === "index.html" ? "&#9670;" : "&#9671;"}</span>${esc(s.title)}</a>`;
      })
      .join("\n      ");
    const html = fixHtml(marked.parse(page.raw), p.dir, page.rel, repo, p.site);
    const meta = [
      `<span class="cat">${esc(p.cat)}</span>`,
      repo ? `<a class="repo-link" href="${repo}">${esc(repo.replace("https://github.com/", ""))} &nearr;</a>` : "",
      p.site ? `<a class="site-link" href="${p.site}">LIVE DOCS &nearr;</a>` : "",
    ].filter(Boolean).join("\n      ");
    const body = `<div class="frame">
  <div class="doc-layout">
    <aside class="sidebar">
      <div class="side-label">${esc(p.name ?? p.dir).toUpperCase()}</div>
      ${sidebar}
      <div class="side-label">ELSEWHERE</div>
      <a href="${"../".repeat(depth)}index.html"><span class="marker">&larr;</span>ALL TOOLS</a>
      ${repo ? `<a href="${repo}"><span class="marker">&nearr;</span>GITHUB</a>` : ""}
    </aside>
    <article class="prose" id="content">
      <div class="doc-meta">${meta}</div>
      <div class="md">${html}</div>
    </article>
  </div>
</div>`;
    const dest = path.join(OUT, p.dir, page.out);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(
      dest,
      shell({ title: p.name ?? p.dir, depth, body, nav: `<a href="${"../".repeat(depth)}index.html">Index</a>${repo ? `<a href="${repo}">GitHub</a>` : ""}` })
    );
  }

  index.push({ ...p, repo, desc });
}

// ---------- landing page ----------
// Featured picks: only those that survived the public filter above.
const picks = FEATURED.flatMap((f) => {
  const p = index.find((x) => x.dir === f.dir);
  return p ? [{ ...p, ...f }] : [];
});
const pickDirs = new Set(picks.map((p) => p.dir));

const pickHtml = picks
  .map((p) => {
    const name = esc(p.name ?? p.dir);
    const imgSrc = path.join(ROOT, p.dir, p.img);
    let art = "";
    if (fs.existsSync(imgSrc)) {
      // ponytail: README rendering usually copies these already; copy again so the landing page never depends on README markup
      const dest = path.join(OUT, p.dir, p.img);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(imgSrc, dest);
      art = `<figure class="pick-art"><img src="${p.dir}/${p.img}" alt="${esc(p.alt)}" width="640" height="640"></figure>`;
    }
    const install = p.repo?.startsWith("https://github.com/")
      ? `<pre class="install" tabindex="0"><code>pi install git:${esc(p.repo.slice("https://".length))}</code></pre>`
      : "";
    return `<article class="pick">
      ${art}
      <div class="pick-copy">
        <h3 class="pick-name"><a href="${p.dir}/index.html">${name}</a></h3>
        <p class="pitch">${esc(p.pitch)}</p>
        <p class="what">${esc(p.what)}</p>
        ${install}
        <a class="read" href="${p.dir}/index.html">Read the ${name} docs <span aria-hidden="true">&rarr;</span></a>
      </div>
    </article>`;
  })
  .join("\n    ");

const rest = index.filter((p) => !pickDirs.has(p.dir));
const cats = [...new Set(rest.map((p) => p.cat))];
const shelves = cats
  .map((cat) => {
    const items = rest
      .filter((p) => p.cat === cat)
      .map(
        (p) => `<li><a class="row" href="${p.dir}/index.html">
          <span class="name">${esc(p.name ?? p.dir)}</span>
          <span class="desc">${esc(p.desc)}</span>
        </a></li>`
      )
      .join("\n        ");
    return `<section class="shelf">
      <h3 class="shelf-label">${esc(cat)}</h3>
      <ul class="shelf-list">
        ${items}
      </ul>
    </section>`;
  })
  .join("\n    ");

const landingBody = `<main class="frame home" id="content">
  <header class="hero">
    <h1 class="display"><span>My glorious</span> <span>Pi setup</span></h1>
    <p class="lede">Extensions, packages, and skills I built for the
    <a href="https://github.com/earendil-works/pi">Pi coding agent</a>.</p>
  </header>
  ${picks.length ? `<section class="picks" id="picks" aria-labelledby="picks-title">
    <div class="section-intro">
      <h2 id="picks-title">Start with these</h2>
    </div>
    ${pickHtml}
  </section>` : ""}
  ${rest.length ? `<section class="directory" id="tools" aria-labelledby="tools-title">
    <div class="section-intro">
      <h2 id="tools-title">${picks.length ? "Everything else" : "All tools"}</h2>
      <p>The rest of the public toolbox, grouped by what it helps with.</p>
    </div>
    ${shelves}
  </section>` : ""}
  <footer>
    <span>Made by Jeecabs</span>
    <a href="https://github.com/Jeecabs">github.com/Jeecabs</a>
  </footer>
</main>`;

fs.writeFileSync(
  path.join(OUT, "index.html"),
  shell({
    title: "My glorious Pi setup",
    depth: 0,
    body: landingBody,
    nav: `${picks.length ? `<a href="#picks">Picks</a>` : ""}${rest.length ? `<a href="#tools">All tools</a>` : ""}<a href="https://github.com/Jeecabs">GitHub</a>`,
  })
);
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

console.log(`Built ${index.length} projects -> docs/`);
