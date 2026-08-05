// Generates the GitHub Pages site in docs/ from every project's README + docs/*.md.
// Usage: node build-docs.mjs
import { marked } from "marked";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(ROOT, "docs");

const PROJECTS = [
  { dir: "gang", cat: "ORCHESTRATION" },
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
  { dir: "pi-next-step", cat: "WORKFLOW" },
  { dir: "pi-tooltime", cat: "WORKFLOW" },
  { dir: "pilot-manual-enjoyer", cat: "WORKFLOW" },
  { dir: "better-frontend", cat: "WORKFLOW" },
  { dir: "notion-pi", cat: "INTEGRATIONS" },
  { dir: "pi-extensions", cat: "INTEGRATIONS" },
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
function fixHtml(html, proj, mdRel) {
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
    if (attr === "src") {
      copyAsset(url);
      return m;
    }
    if (/\.md(#.*)?$/.test(url)) {
      if (url.endsWith("README.md")) return `${attr}="${url.replace(/README\.md$/, "index.html")}"`;
      return `${attr}="${url.replace(/\.md(#.*)?$/, ".html$1")}"`;
    }
    copyAsset(url); // non-md relative file (license, image link, etc.)
    return m;
  });
  return html;
}

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Sans:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">`;

const shell = ({ title, depth, body, nav }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${FONTS}
<link rel="stylesheet" href="${"../".repeat(depth)}style.css">
</head>
<body>
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
    const depth = page.out.split("/").length + 1; // relative to OUT root
    const up = "../".repeat(depth - 1); // to project root within docs/
    const sidebar = pages
      .map((s) => {
        const href = up + s.out;
        const cur = s.out === page.out ? ' class="current"' : "";
        return `<a${cur} href="${href}"><span class="marker">${s.out === "index.html" ? "&#9670;" : "&#9671;"}</span>${esc(s.title)}</a>`;
      })
      .join("\n      ");
    const html = fixHtml(marked.parse(page.raw), p.dir, page.rel);
    const meta = [
      `<span class="cat">${esc(p.cat)}</span>`,
      repo ? `<a class="repo-link" href="${repo}">${esc(repo.replace("https://github.com/", ""))} &nearr;</a>` : "",
      p.site ? `<a class="site-link" href="${p.site}">LIVE DOCS &nearr;</a>` : "",
    ].filter(Boolean).join("\n      ");
    const body = `<div class="frame">
  <div class="doc-layout">
    <aside class="sidebar">
      <div class="side-label">${esc(p.dir).toUpperCase()}</div>
      ${sidebar}
      <div class="side-label">ELSEWHERE</div>
      <a href="${"../".repeat(depth)}index.html"><span class="marker">&larr;</span>ALL TOOLS</a>
      ${repo ? `<a href="${repo}"><span class="marker">&nearr;</span>GITHUB</a>` : ""}
    </aside>
    <article class="prose">
      <div class="doc-meta">${meta}</div>
      <div class="md">${html}</div>
    </article>
  </div>
</div>`;
    const dest = path.join(OUT, p.dir, page.out);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(
      dest,
      shell({ title: p.dir, depth, body, nav: `<a href="${"../".repeat(depth)}index.html">Index</a>${repo ? `<a href="${repo}">GitHub</a>` : ""}` })
    );
  }

  index.push({ ...p, repo, desc });
}

// ---------- landing page ----------
const rows = index
  .map(
    (p) => `<a class="row" data-cat="${esc(p.cat)}" href="${p.dir}/index.html">
    <span class="name">${esc(p.dir)}</span>
    <span class="desc">${esc(p.desc)}</span>
    <span class="cat">${esc(p.cat)}</span>
    <span class="go">&rarr;</span>
  </a>`
  )
  .join("\n  ");

const landingBody = `<main class="frame">
  <header class="hero">
    <h1 class="display">My glorious <em>Pi</em> setup</h1>
    <p class="lede">Extensions, packages, and skills for the
    <a href="https://github.com/badlogic/pi-mono">Pi coding agent</a>. Every tool's
    documentation is rendered here from its own repository.</p>
  </header>
  <div class="index">
  ${rows}
  </div>
  <footer>
    <span><a href="https://github.com/Jeecabs">github.com/Jeecabs</a></span>
  </footer>
</main>`;

fs.writeFileSync(
  path.join(OUT, "index.html"),
  shell({ title: "My glorious Pi setup", depth: 0, body: landingBody, nav: `<a href="#">Index</a><a href="https://github.com/Jeecabs">GitHub</a>` })
);
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

console.log(`Built ${index.length} projects -> docs/`);
