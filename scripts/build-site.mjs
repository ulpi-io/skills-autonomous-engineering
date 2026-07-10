#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { groups, skills, plugins, groupBySlug } from '../site/catalog.mjs';
import { site } from '../site/content.mjs';
import {
  renderClaudePlugin,
  renderCodexPlugin,
  renderHome,
  renderHowItWorks,
  renderNotFound,
  renderPluginsHub,
  renderSkillDetail,
  renderSkillsIndex,
} from '../site/templates.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const CHECK = process.argv.includes('--check');

function fail(message) {
  console.error(`site build failed: ${message}`);
  process.exitCode = 1;
}

function rootSkillSlugs() {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

function validateCatalog() {
  const repositorySlugs = rootSkillSlugs();
  const catalogSlugs = skills.map((skill) => skill.slug).sort();

  if (repositorySlugs.length !== 18) {
    throw new Error(`expected 18 root skill directories, found ${repositorySlugs.length}`);
  }
  if (JSON.stringify(repositorySlugs) !== JSON.stringify(catalogSlugs)) {
    throw new Error(`catalog does not match root skills\nrepo: ${repositorySlugs.join(', ')}\nsite: ${catalogSlugs.join(', ')}`);
  }

  for (const skill of skills) {
    if (!groupBySlug.has(skill.group)) throw new Error(`${skill.slug} uses missing group ${skill.group}`);
    if (!existsSync(join(ROOT, skill.sourcePath))) throw new Error(`${skill.slug} source is missing: ${skill.sourcePath}`);
    for (const artifact of skill.enforcementArtifacts || []) {
      if (!existsSync(join(ROOT, artifact.path))) throw new Error(`${skill.slug} artifact is missing: ${artifact.path}`);
    }
  }

  const groupedSlugs = groups.flatMap((group) => group.skillSlugs).sort();
  if (JSON.stringify(groupedSlugs) !== JSON.stringify(catalogSlugs)) {
    throw new Error('group membership does not cover the skill catalog exactly once');
  }
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function canonical(route = '') {
  return `${site.origin}${site.basePath}${route ? `${route}/` : ''}`;
}

function buildOutputs() {
  const outputs = new Map();
  const page = (path, html) => {
    const normalized = html.replace(/[ \t]+$/gm, '');
    outputs.set(path, normalized.endsWith('\n') ? normalized : `${normalized}\n`);
  };

  page('index.html', renderHome({ groups, skills, plugins }));
  page('how-it-works/index.html', renderHowItWorks({ skills }));
  page('skills/index.html', renderSkillsIndex({ groups, skills }));

  for (const skill of skills) {
    page(`skills/${skill.slug}/index.html`, renderSkillDetail({
      skill,
      group: groupBySlug.get(skill.group),
      groups,
      skills,
    }));
  }

  page('plugins/index.html', renderPluginsHub({ plugins }));
  page('plugins/claude-code/index.html', renderClaudePlugin({ skills }));
  page('plugins/codex/index.html', renderCodexPlugin({ skills }));
  page('404.html', renderNotFound());

  const routes = [
    '',
    'how-it-works',
    'skills',
    ...skills.map((skill) => `skills/${skill.slug}`),
    'plugins',
    'plugins/claude-code',
    'plugins/codex',
  ];
  outputs.set('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${routes.map((route) => `  <url><loc>${xmlEscape(canonical(route))}</loc></url>`).join('\n')}\n</urlset>\n`);
  outputs.set('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${canonical('sitemap.xml').replace(/\/$/, '')}\n`);
  outputs.set('.nojekyll', '');

  return outputs;
}

function checkOutputs(outputs) {
  let clean = true;
  for (const [path, expected] of outputs) {
    const absolute = join(DOCS, path);
    if (!existsSync(absolute)) {
      fail(`missing generated file docs/${path}`);
      clean = false;
      continue;
    }
    const actual = readFileSync(absolute, 'utf8');
    if (actual !== expected) {
      fail(`stale generated file docs/${path}; run node scripts/build-site.mjs`);
      clean = false;
    }
  }
  if (clean) console.log(`site output is current (${outputs.size} generated files)`);
}

function writeOutputs(outputs) {
  for (const [path, content] of outputs) {
    const absolute = join(DOCS, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  console.log(`generated ${outputs.size} files under ${relative(ROOT, DOCS)}/`);
}

try {
  validateCatalog();
  const outputs = buildOutputs();
  if (CHECK) checkOutputs(outputs);
  else writeOutputs(outputs);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
