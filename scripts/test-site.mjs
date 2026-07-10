#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const BUILD_SCRIPT = join(ROOT, 'scripts', 'build-site.mjs');
const SITE_ORIGIN = 'https://ulpi-io.github.io';
const SITE_PATH = '/skills-autonomous-engineering/';
const SITE_BASE = `${SITE_ORIGIN}${SITE_PATH}`;

const CORE_ROUTES = [
  '',
  'how-it-works',
  'skills',
  'plugins',
  'plugins/claude-code',
  'plugins/codex',
];

function rootSkillSlugs() {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

function routeFile(route) {
  return route === '' ? join(DOCS, 'index.html') : join(DOCS, route, 'index.html');
}

function substantiveRoutes() {
  return [...CORE_ROUTES, ...rootSkillSlugs().map((slug) => `skills/${slug}`)];
}

function walkFiles(directory, predicate = () => true) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolute, predicate));
    else if (entry.isFile() && predicate(absolute)) files.push(absolute);
  }
  return files.sort();
}

function decodeHtml(value) {
  return value
    .replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&(?:amp|#38);/gi, '&')
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(/&(?:lt|#60);/gi, '<')
    .replace(/&(?:gt|#62);/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

function attributes(tag) {
  const result = {};
  const pattern = /([^\s=<>`]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = pattern.exec(tag)) !== null) {
    result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((match) => ({
    raw: match[0],
    attrs: attributes(match[0]),
  }));
}

function visibleText(html) {
  return decodeHtml(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--([\s\S]*?)-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

function htmlMetadata(html, file) {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  assert.ok(titleMatch, `${relative(ROOT, file)} is missing <title>`);

  const description = tags(html, 'meta').find(
    ({ attrs }) => attrs.name?.toLowerCase() === 'description',
  )?.attrs.content;
  assert.ok(description?.trim(), `${relative(ROOT, file)} is missing a meta description`);

  const canonical = tags(html, 'link').find(({ attrs }) =>
    (attrs.rel ?? '').toLowerCase().split(/\s+/).includes('canonical'),
  )?.attrs.href;
  assert.ok(canonical, `${relative(ROOT, file)} is missing a canonical link`);

  return {
    title: visibleText(titleMatch[1]),
    description: decodeHtml(description).replace(/\s+/g, ' ').trim(),
    canonical,
  };
}

function isExternalReference(value) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value);
}

function resolvedLocalTarget(sourceFile, rawReference) {
  const reference = decodeHtml(rawReference).trim();
  if (!reference || reference.startsWith('#') || isExternalReference(reference)) return null;

  const withoutFragment = reference.split('#', 1)[0].split('?', 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    assert.fail(`${relative(ROOT, sourceFile)} contains a malformed URL: ${reference}`);
  }

  let target;
  if (decoded.startsWith(SITE_PATH)) {
    target = resolve(DOCS, decoded.slice(SITE_PATH.length));
  } else if (decoded.startsWith('/')) {
    assert.fail(
      `${relative(ROOT, sourceFile)} uses root-absolute ${reference}; GitHub Pages requires ${SITE_PATH}`,
    );
  } else {
    target = resolve(dirname(sourceFile), decoded || '.');
  }

  const docsPrefix = `${DOCS}${sep}`;
  assert.ok(
    target === DOCS || target.startsWith(docsPrefix),
    `${relative(ROOT, sourceFile)} reference escapes docs/: ${reference}`,
  );

  if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html');
  return target;
}

function localReferences(html) {
  const references = [];
  for (const name of ['a', 'link']) {
    for (const tag of tags(html, name)) {
      if (tag.attrs.href !== undefined) references.push({ tag: name, value: tag.attrs.href, attrs: tag.attrs });
    }
  }
  for (const name of ['img', 'script', 'source', 'iframe']) {
    for (const tag of tags(html, name)) {
      if (tag.attrs.src !== undefined) references.push({ tag: name, value: tag.attrs.src, attrs: tag.attrs });
    }
  }
  return references;
}

function linksResolvingTo(html, sourceFile, expectedFile) {
  return tags(html, 'a').filter(({ attrs }) => {
    if (attrs.href === undefined) return false;
    return resolvedLocalTarget(sourceFile, attrs.href) === expectedFile;
  });
}

test('generated route set covers the site and exactly 18 repository skills', () => {
  assert.ok(existsSync(DOCS), 'docs/ output directory is missing');

  const skillSlugs = rootSkillSlugs();
  assert.equal(skillSlugs.length, 18, `expected 18 root SKILL.md directories, found ${skillSlugs.length}`);

  for (const route of substantiveRoutes()) {
    assert.ok(existsSync(routeFile(route)), `missing generated route /${route}`);
  }

  const generatedSkillSlugs = walkFiles(
    join(DOCS, 'skills'),
    (file) => file.endsWith(`${sep}index.html`) && file !== routeFile('skills'),
  )
    .map((file) => relative(join(DOCS, 'skills'), dirname(file)).split(sep).join('/'))
    .sort();

  assert.deepEqual(
    generatedSkillSlugs,
    skillSlugs,
    'generated skill routes must exactly match the root SKILL.md directories',
  );
});

test('skills catalog contains each repository skill exactly once', () => {
  const catalogFile = routeFile('skills');
  const html = readFileSync(catalogFile, 'utf8');
  const catalogMarkers = [...html.matchAll(/\bdata-catalog-skill\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)]
    .map((match) => decodeHtml(match[1] ?? match[2]));
  const expected = rootSkillSlugs();

  assert.equal(catalogMarkers.length, 18, 'skills catalog must contain exactly 18 skill entries');
  assert.deepEqual([...catalogMarkers].sort(), expected, 'catalog has a missing, duplicate, or extra skill entry');

  for (const slug of expected) {
    assert.equal(
      catalogMarkers.filter((value) => value === slug).length,
      1,
      `catalog must mark ${slug} exactly once`,
    );
    assert.equal(
      linksResolvingTo(html, catalogFile, routeFile(`skills/${slug}`)).length,
      1,
      `catalog must link to skills/${slug}/ exactly once`,
    );

    const detailHtml = readFileSync(routeFile(`skills/${slug}`), 'utf8');
    const detailMarkers = [...detailHtml.matchAll(/\bdata-skill\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)]
      .map((match) => decodeHtml(match[1] ?? match[2]));
    assert.deepEqual(detailMarkers, [slug], `skills/${slug}/ must identify itself exactly once`);
  }
});

test('all local href and src references resolve inside docs', () => {
  const htmlFiles = walkFiles(DOCS, (file) => extname(file).toLowerCase() === '.html');
  assert.ok(htmlFiles.length > 0, 'no generated HTML files found');

  for (const file of htmlFiles) {
    const html = readFileSync(file, 'utf8');
    for (const reference of localReferences(html)) {
      const target = resolvedLocalTarget(file, reference.value);
      if (target === null) continue;
      assert.ok(
        existsSync(target),
        `${relative(ROOT, file)} has broken ${reference.tag} target ${reference.value} -> ${relative(ROOT, target)}`,
      );
      assert.ok(statSync(target).isFile(), `${relative(ROOT, target)} is not a file`);
    }
  }
});

test('every substantive route loads the shared assets from its own depth', () => {
  const expectedCss = join(DOCS, 'assets', 'site.css');
  const expectedJs = join(DOCS, 'assets', 'site.js');
  assert.ok(existsSync(expectedCss), 'docs/assets/site.css is missing');
  assert.ok(existsSync(expectedJs), 'docs/assets/site.js is missing');

  for (const route of substantiveRoutes()) {
    const file = routeFile(route);
    const html = readFileSync(file, 'utf8');
    const stylesheets = tags(html, 'link').filter(({ attrs }) =>
      (attrs.rel ?? '').toLowerCase().split(/\s+/).includes('stylesheet')
      && resolvedLocalTarget(file, attrs.href) !== null,
    );
    const scripts = tags(html, 'script').filter(({ attrs }) =>
      attrs.src !== undefined && resolvedLocalTarget(file, attrs.src) !== null,
    );

    assert.ok(
      stylesheets.some(({ attrs }) => resolvedLocalTarget(file, attrs.href) === expectedCss),
      `/${route} does not resolve the shared site.css`,
    );
    assert.ok(
      scripts.some(({ attrs }) => resolvedLocalTarget(file, attrs.src) === expectedJs),
      `/${route} does not resolve the shared site.js`,
    );
  }
});

test('analytics preserve full GitHub Pages paths and stay configuration-driven', () => {
  const expectedJs = join(DOCS, 'assets', 'site.js');
  const gaId = 'G-2JN5Y3QCSS';
  const googleLoader = `https://www.googletagmanager.com/gtag/js?id=${gaId}`;

  for (const route of substantiveRoutes()) {
    const file = routeFile(route);
    const html = readFileSync(file, 'utf8');
    const scripts = tags(html, 'script');
    assert.equal(
      scripts.filter(({ attrs }) => attrs.src === googleLoader).length,
      1,
      `/${route} must include the ${gaId} Google tag loader exactly once`,
    );
    assert.equal(
      scripts.filter(({ attrs }) =>
        attrs.src !== undefined
        && resolvedLocalTarget(file, attrs.src) === expectedJs
        && attrs['data-ga-id'] === gaId,
      ).length,
      1,
      `/${route} must configure the shared site.js tag with data-ga-id="${gaId}"`,
    );
  }

  const runtime = readFileSync(expectedJs, 'utf8');
  assert.match(runtime, /getAttribute\(\s*['"]data-ga-id['"]\s*\)/, 'site.js must read data-ga-id');
  assert.match(runtime, /gtag\(\s*['"]config['"]\s*,/, 'site.js must initialize Google Analytics');
  assert.match(
    runtime,
    /page_location\s*:\s*window\.location\.href/,
    'Google Analytics must report the full page_location',
  );
  assert.match(
    runtime,
    /page_path\s*:\s*window\.location\.pathname\s*\+\s*window\.location\.search/,
    'Google Analytics must report the GitHub Pages route and query as page_path',
  );

  assert.match(runtime, /data-clarity-id/, 'site.js must expose a data-clarity-id configuration hook');
  assert.match(runtime, /if\s*\(\s*clarityId\b/, 'Clarity must load only when a project ID is configured');
  assert.match(runtime, /window\.clarity\s*=/, 'site.js must initialize the Clarity event queue');
  assert.match(runtime, /(?:https:)?\/\/www\.clarity\.ms\/tag\//, 'site.js must load the official Clarity tag');
});

test('all HTML pages have unique metadata and project-safe canonical URLs', () => {
  const htmlFiles = walkFiles(DOCS, (file) => extname(file).toLowerCase() === '.html');
  const seen = {
    title: new Map(),
    description: new Map(),
    canonical: new Map(),
  };

  for (const file of htmlFiles) {
    const metadata = htmlMetadata(readFileSync(file, 'utf8'), file);
    for (const key of Object.keys(seen)) {
      const previous = seen[key].get(metadata[key]);
      assert.equal(
        previous,
        undefined,
        `${relative(ROOT, file)} duplicates ${key} from ${previous}: ${metadata[key]}`,
      );
      seen[key].set(metadata[key], relative(ROOT, file));
    }
    assert.ok(
      metadata.canonical.startsWith(SITE_BASE),
      `${relative(ROOT, file)} canonical must start with ${SITE_BASE}`,
    );

    if (file.endsWith(`${sep}index.html`)) {
      const route = relative(DOCS, dirname(file)).split(sep).filter(Boolean).join('/');
      const expectedCanonical = route ? `${SITE_BASE}${route}/` : SITE_BASE;
      assert.equal(
        metadata.canonical,
        expectedCanonical,
        `${relative(ROOT, file)} canonical does not match its physical route`,
      );
    }
  }
});

test('global navigation and the home/plugin hubs expose both platforms', () => {
  const skillsFile = routeFile('skills');
  const pluginsFile = routeFile('plugins');

  for (const route of substantiveRoutes()) {
    const file = routeFile(route);
    const html = readFileSync(file, 'utf8');
    const navMatch = html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i);
    assert.ok(navMatch, `/${route} is missing global navigation`);
    assert.ok(
      linksResolvingTo(navMatch[1], file, skillsFile).length > 0,
      `/${route} navigation is missing Skills`,
    );
    assert.ok(
      linksResolvingTo(navMatch[1], file, pluginsFile).length > 0,
      `/${route} navigation is missing Plugins`,
    );
  }

  const claudeFile = routeFile('plugins/claude-code');
  const codexFile = routeFile('plugins/codex');
  for (const route of ['', 'plugins']) {
    const file = routeFile(route);
    const html = readFileSync(file, 'utf8');
    assert.ok(linksResolvingTo(html, file, claudeFile).length > 0, `/${route} must link to Claude Code`);
    assert.ok(linksResolvingTo(html, file, codexFile).length > 0, `/${route} must link to Codex`);
  }
});

test('the full-pipeline command is prominent on the homepage and every install flow', () => {
  const claudeRun = '/autonomous-pipeline "<feature>"';
  const codexRun = '$autonomous-engineering:autonomous-pipeline "<feature>"';
  const runnerPlatforms = (html) => [...html.matchAll(
    /\bdata-runner-platform\s*=\s*(?:"([^"]+)"|'([^']+)')/gi,
  )].map((match) => decodeHtml(match[1] ?? match[2]));

  const homeHtml = readFileSync(routeFile(''), 'utf8');
  const homeHero = homeHtml.match(/<section\b[^>]*class="[^"]*\bhero-first\b[^"]*"[^>]*>([\s\S]*?)<\/section>/i);
  assert.ok(homeHero, 'homepage is missing its primary hero');
  assert.deepEqual(
    runnerPlatforms(homeHero[1]).sort(),
    ['claude', 'codex'],
    'homepage hero must expose both full-pipeline runner commands',
  );
  assert.match(visibleText(homeHero[1]), new RegExp(claudeRun.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(visibleText(homeHero[1]), new RegExp(codexRun.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(
    visibleText(homeHero[1]),
    /One invocation\. One plan approval\. One bounded pass\./,
    'homepage runner must preserve the approval gate and bounded one-pass contract',
  );

  const hubHtml = readFileSync(routeFile('plugins'), 'utf8');
  assert.deepEqual(
    runnerPlatforms(hubHtml).sort(),
    ['claude', 'codex'],
    'plugin hub must show what to invoke after installation on both platforms',
  );

  const claudeHtml = readFileSync(routeFile('plugins/claude-code'), 'utf8');
  const claudeText = visibleText(claudeHtml);
  assert.deepEqual(runnerPlatforms(claudeHtml), ['claude']);
  assert.ok(
    claudeText.indexOf('/plugin install autonomous-engineering@ulpi-autonomous-engineering')
      < claudeText.indexOf(claudeRun),
    'Claude installation must lead from plugin install to the full-pipeline invocation',
  );

  const codexHtml = readFileSync(routeFile('plugins/codex'), 'utf8');
  const codexText = visibleText(codexHtml);
  assert.deepEqual(runnerPlatforms(codexHtml), ['codex']);
  assert.ok(
    codexText.indexOf('codex plugin add autonomous-engineering@autonomous-engineering')
      < codexText.indexOf(codexRun),
    'Codex plugin installation must lead to the plugin-qualified full-pipeline invocation',
  );

  const pipelineHtml = readFileSync(routeFile('skills/autonomous-pipeline'), 'utf8');
  assert.deepEqual(
    runnerPlatforms(pipelineHtml).sort(),
    ['claude', 'codex'],
    'the autonomous-pipeline skill page must expose both invocation forms in its install section',
  );
});

test('plugin pages make truthful, platform-specific availability claims', () => {
  const claudeHtml = readFileSync(routeFile('plugins/claude-code'), 'utf8');
  const claudeText = visibleText(claudeHtml);
  assert.match(
    claudeText,
    /\/plugin marketplace add ulpi-io\/skills-autonomous-engineering/,
    'Claude page is missing the current marketplace-add command',
  );
  assert.match(
    claudeText,
    /\/plugin install autonomous-engineering@ulpi-autonomous-engineering/,
    'Claude page is missing the current plugin-install command',
  );

  const codexHtml = readFileSync(routeFile('plugins/codex'), 'utf8');
  const codexText = visibleText(codexHtml);
  assert.match(codexText, /Available from source · v0\.1\.0/, 'Codex plugin must be visibly marked available');
  assert.match(codexText, /catalog_count = 18/, 'Codex artifact panel must report the sealed adapter count');

  const installFlow = [
    'node scripts/package-codex-plugin.mjs --out /tmp/ulpi-codex-market',
    'codex plugin marketplace add /tmp/ulpi-codex-market',
    'codex plugin marketplace list',
    'codex plugin add autonomous-engineering@autonomous-engineering',
    'codex plugin list',
    '$autonomous-engineering:autonomous-pipeline "<feature>"',
  ];
  let previousPosition = -1;
  for (const command of installFlow) {
    const position = codexText.indexOf(command);
    assert.ok(position > previousPosition, `Codex install flow is missing or misordered: ${command}`);
    previousPosition = position;
  }

  assert.match(codexText, /new Codex session/i, 'Codex page must explain new-session discovery');
  assert.match(
    codexText,
    /Repository-level hook wiring is not bundled/i,
    'Codex page must disclose the source artifact hook boundary',
  );
  assert.doesNotMatch(
    codexText,
    /(?:plugin|artifact) ships[^.]*Codex lifecycle hooks/i,
    'Codex page must not claim the current artifact ships hooks',
  );
  assert.doesNotMatch(
    codexText,
    /\b(?:preview|in development|not installable yet)\b/i,
    'Codex page must not retain preview-era availability copy',
  );

  for (const route of substantiveRoutes()) {
    const text = visibleText(readFileSync(routeFile(route), 'utf8'));
    assert.doesNotMatch(
      text,
      /Native plugin preview|native plugin remains explicitly preview|native plugin is not presented as shipped/i,
      `/${route} retains stale Codex preview copy`,
    );
  }
});

test('sitemap contains every substantive route exactly once', () => {
  const sitemapFile = join(DOCS, 'sitemap.xml');
  assert.ok(existsSync(sitemapFile), 'docs/sitemap.xml is missing');
  const xml = readFileSync(sitemapFile, 'utf8');
  const locations = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
    .map((match) => decodeHtml(match[1]));
  const expected = substantiveRoutes().map((route) => route ? `${SITE_BASE}${route}/` : SITE_BASE).sort();

  assert.equal(new Set(locations).size, locations.length, 'sitemap contains duplicate routes');
  assert.deepEqual([...locations].sort(), expected, 'sitemap must contain exactly the substantive routes');
});

test('pages contain no inline style or executable inline script blocks', () => {
  const htmlFiles = walkFiles(DOCS, (file) => extname(file).toLowerCase() === '.html');
  for (const file of htmlFiles) {
    const html = readFileSync(file, 'utf8');
    assert.doesNotMatch(html, /<style\b/i, `${relative(ROOT, file)} contains an inline <style> block`);

    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attrs = attributes(match[1]);
      if (attrs.src !== undefined) continue;
      assert.equal(
        attrs.type?.toLowerCase(),
        'application/ld+json',
        `${relative(ROOT, file)} contains a non-JSON-LD inline script`,
      );
      assert.doesNotThrow(
        () => JSON.parse(decodeHtml(match[2]).trim()),
        `${relative(ROOT, file)} contains invalid JSON-LD`,
      );
    }
  }
});

test('generated output is reproducible', { skip: !existsSync(BUILD_SCRIPT) }, () => {
  const result = spawnSync(process.execPath, [BUILD_SCRIPT, '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `node scripts/build-site.mjs --check failed\n${result.stdout}${result.stderr}`,
  );
});
