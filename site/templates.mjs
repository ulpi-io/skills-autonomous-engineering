import {
  site,
  pipeline,
  contracts,
  failureModes,
  enforcement,
  pluginComparison,
  claudeHooks,
  codexRoadmap,
  universalInstall,
  singleSkillInstall,
} from './content.mjs';

const esc = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const routeDepth = (route) => route ? route.split('/').filter(Boolean).length : 0;
const rootFor = (route) => '../'.repeat(routeDepth(route));
const pathFor = (route, target = '') => `${rootFor(route)}${target ? `${target.replace(/^\/+|\/+$/g, '')}/` : ''}`;
const assetFor = (route, name) => `${rootFor(route)}assets/${name}`;
const canonicalFor = (route = '') => `${site.origin}${site.basePath}${route ? `${route.replace(/^\/+|\/+$/g, '')}/` : ''}`;
const sourceFor = (path) => `${site.repository}/blob/main/${path}`;
const groupLabel = (group) => group.title || group.name || group.label || group.slug;
const skillOutcome = (skill) => skill.outcome || skill.summary || skill.description || '';
const invocationExample = (skill) => {
  if (typeof skill.invocation === 'string') {
    return `${skill.invocation}${skill.argument ? ` ${skill.argument}` : ''}`;
  }
  return skill.invocation?.example || `/${skill.slug}${skill.invocation?.argument ? ` ${skill.invocation.argument}` : ''}`;
};
const pluginFor = (plugins, slug) => Array.isArray(plugins)
  ? plugins.find((plugin) => plugin.slug === slug)
  : plugins?.[slug];

function jsonLd(value) {
  return `<script type="application/ld+json">${JSON.stringify(value).replaceAll('<', '\\u003c')}</script>`;
}

function navigation(route, active) {
  const links = [
    ['how', 'How it works', 'how-it-works'],
    ['skills', 'Skills', 'skills'],
    ['plugins', 'Plugins', 'plugins'],
  ];
  return `
  <header class="site-header">
    <div class="wrap header-inner">
      <a class="brand" href="${pathFor(route)}" aria-label="Autonomous Engineering Skills, home">
        <img src="${rootFor(route)}ulpi-icon.png" alt="" width="26" height="26" class="logo">
        <span>autonomous-engineering</span>
      </a>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav"><span>menu</span></button>
      <nav class="site-nav" id="site-nav" aria-label="Primary">
        ${links.map(([key, label, target]) => `<a href="${pathFor(route, target)}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`).join('')}
        <a class="gh" href="${site.repository}">GitHub ↗</a>
        <button class="themebtn" type="button" id="theme" aria-label="Toggle color theme">◐ auto</button>
      </nav>
    </div>
  </header>`;
}

function footer(route) {
  return `
  <footer class="site-footer">
    <div class="wrap footer-grid">
      <div><span class="lab"><span class="mk">▸</span> autonomous engineering</span><p>Bounded. Fail-closed. Durable. Verified before acting.</p></div>
      <div class="footer-links">
        <a href="${pathFor(route, 'skills')}">18 skills</a>
        <a href="${pathFor(route, 'plugins/claude-code')}">Claude Code plugin</a>
        <a href="${pathFor(route, 'plugins/codex')}">Codex plugin</a>
        <a href="${site.repository}">Source ↗</a>
      </div>
      <span class="footer-meta">© ulpi.io · MIT</span>
    </div>
  </footer>`;
}

export function layout({
  route = '',
  title,
  description,
  active = '',
  body,
  mainAttrs = '',
  type = 'website',
  structuredData,
  canonicalOverride,
}) {
  const fullTitle = title === site.name ? title : `${title} · ${site.name}`;
  const canonical = canonicalOverride || canonicalFor(route);
  return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(fullTitle)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="color-scheme" content="light dark">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:type" content="${esc(type)}">
  <meta property="og:url" content="${canonical}">
  <link rel="canonical" href="${canonical}">
  <link rel="icon" type="image/png" href="${rootFor(route)}ulpi-icon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&amp;family=Hanken+Grotesk:wght@400;500;600&amp;family=IBM+Plex+Mono:wght@400;500;600&amp;display=swap" rel="stylesheet">
  <link rel="stylesheet" href="${assetFor(route, 'site.css')}">
  <script async src="https://www.googletagmanager.com/gtag/js?id=${esc(site.analytics.googleMeasurementId)}"></script>
  <script defer src="${assetFor(route, 'site.js')}" data-ga-id="${esc(site.analytics.googleMeasurementId)}"${site.analytics.clarityProjectId ? ` data-clarity-id="${esc(site.analytics.clarityProjectId)}"` : ''}></script>
  ${structuredData ? jsonLd(structuredData) : ''}
</head>
<body>
  <a href="#main" class="skip">Skip to content</a>
  ${navigation(route, active)}
  <main id="main" ${mainAttrs}>
    ${body}
  </main>
  ${footer(route)}
</body>
</html>
`;
}

function breadcrumb(route, items) {
  return `<nav class="breadcrumbs wrap" aria-label="Breadcrumb">${items.map((item, index) => {
    const last = index === items.length - 1;
    return `${index ? '<span aria-hidden="true">/</span>' : ''}${last ? `<span aria-current="page">${esc(item.label)}</span>` : `<a href="${pathFor(route, item.target)}">${esc(item.label)}</a>`}`;
  }).join('')}</nav>`;
}

function codeRow(command, id, label = 'Copy command') {
  return `<div class="cmdrow"><code id="${esc(id)}">${esc(command)}</code><button class="cp" type="button" data-copy-target="${esc(id)}" aria-label="${esc(label)}">copy</button></div>`;
}

function statusBadge(status, label) {
  return `<span class="status-badge status-${esc(status)}"><span aria-hidden="true"></span>${esc(label)}</span>`;
}

function pipelinePanel() {
  return `<div class="panel loopwrap reveal d3" aria-label="Self-improving lifecycle diagram">
    <div class="looptop lab"><span class="mk">↻</span>&nbsp; the self-improving pipeline</div>
    <svg class="loopsvg" viewBox="0 0 330 512" role="img" aria-label="Eight delivery phases run from auto-spec through auto-ship, followed by auto-learn and auto-map feeding verified lessons into the next run.">
      <defs><marker id="pipeline-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ahfb"/></marker></defs>
      ${pipeline.map((stage, index) => {
        const y = 12 + index * 48;
        return `<g><rect class="box" x="72" y="${y}" width="246" height="42" rx="2"/><text class="num" x="86" y="${y + 18}">${stage.number} ${stage.label.toUpperCase()}</text><text class="cmd" x="86" y="${y + 34}">/${stage.slug}</text><text class="role" x="306" y="${y + 34}" text-anchor="end">${stage.result}</text></g>`;
      }).join('')}
      <g><rect class="loopcard" x="72" y="404" width="246" height="42" rx="2"/><text class="lc" x="86" y="422">↻ /auto-learn</text><text class="lr" x="86" y="438">harvest · verify · route lessons</text></g>
      <g><rect class="loopcard" x="72" y="452" width="246" height="42" rx="2"/><text class="lc" x="86" y="470">↻ /auto-map</text><text class="lr" x="86" y="486">refresh verified project context</text></g>
      <g class="chev">${[54,102,150,198,246,294,342].map((y) => `<path d="M191,${y} l4,4 4,-4"/>`).join('')}</g>
      <g class="chev acc"><path d="M191,390 l4,4 4,-4"/><path d="M191,446 l4,4 4,-4"/></g>
      <path class="fb" d="M72,473 L44,473 Q30,473 30,459 L30,40 Q30,26 44,26 L70,26" marker-end="url(#pipeline-arrow)"/>
      <text class="fbt" transform="rotate(-90 20 250)" x="20" y="250" text-anchor="middle">↻ the next run reads this first</text>
    </svg>
  </div>`;
}

function familyCards(route, groups, skills) {
  return `<div class="family-grid">${groups.map((group) => {
    const members = skills.filter((skill) => skill.group === group.slug);
    return `<a class="family-card reveal" href="${pathFor(route, 'skills')}#${esc(group.slug)}"><span class="family-count">${String(members.length).padStart(2, '0')}</span><h3>${esc(groupLabel(group))}</h3><p>${esc(group.description || group.summary || '')}</p><span class="text-link">Explore ${members.length} skills →</span></a>`;
  }).join('')}</div>`;
}

function pluginCard(route, plugin, kind) {
  const isClaude = kind === 'claude-code';
  const status = plugin?.status === 'current' ? 'available' : plugin?.status || (isClaude ? 'available' : 'preview');
  const label = plugin?.statusLabel || (isClaude ? 'Available now' : 'Preview · in development');
  return `<article class="platform-card panel reveal">
    <div class="platform-card-head"><p class="lab"><span class="mk">${isClaude ? 'C' : 'X'}</span> ${isClaude ? 'Claude Code' : 'Codex'}</p>${statusBadge(status, label)}</div>
    <h3>${isClaude ? 'Plugin-native enforcement.' : 'Provider-native control plane.'}</h3>
    <p>${esc(plugin?.summary || (isClaude ? 'The shipped marketplace plugin bundles all 18 skills, lifecycle hooks, Workflow templates, and tested guards.' : 'A dedicated Codex plugin is being built around isolated adapters, exact exec schemas, durable budgets, and real install verification.'))}</p>
    <ul class="signal-list">${(isClaude ? ['18 canonical skills', 'Lifecycle and skill guards', 'Resume and honest-stop hooks'] : ['Universal skills work today', 'Native plugin stays preview until smoke-tested', 'No fictional install command']).map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
    <a class="text-link" href="${pathFor(route, `plugins/${kind}`)}">View ${isClaude ? 'Claude Code' : 'Codex'} details →</a>
  </article>`;
}

export function renderHome({ groups, skills, plugins }) {
  const route = '';
  const body = `
  <section class="hero hero-first">
    <div class="wrap hgrid">
      <div class="herohead">
        <p class="lab reveal"><span class="mk">▸</span> 18 skills · Claude Code + Codex · skills.sh</p>
        <h1 class="reveal d1">Spec to ship, unattended.<br>Then it <span class="hl">learns.</span></h1>
        <p class="sub reveal d2">Eight autonomous phases behind one approval, bounded by deterministic evidence. Every run returns what it learned to the next one.</p>
        <div class="hero-actions reveal d3"><a class="btn" href="${pathFor(route, 'skills')}">Explore all skills →</a><a class="btn ghost" href="${pathFor(route, 'plugins')}">Choose a plugin</a></div>
      </div>
      ${pipelinePanel()}
    </div>
  </section>
  <section>
    <div class="wrap">
      <div class="section-head reveal"><p class="lab"><span class="mk">▸</span> two native surfaces</p><h2>Same contracts. Different machinery.</h2><p>Use the platform you already trust. The methodology stays bounded and fail-closed; the adapters respect each provider’s actual capabilities.</p></div>
      <div class="platform-grid">${pluginCard(route, pluginFor(plugins, 'claude-code'), 'claude-code')}${pluginCard(route, pluginFor(plugins, 'codex'), 'codex')}</div>
    </div>
  </section>
  <section>
    <div class="wrap">
      <div class="section-head reveal"><p class="lab"><span class="mk">▸</span> the problem</p><h2>Every agent can loop. The failure modes are what kill you.</h2><p>These skills separate autonomy from wishful prompting with caps, checkpoints, independent evidence, and tested guards.</p></div>
      <div class="fails">${failureModes.map((item) => `<article class="fail reveal"><span class="x">✗</span><div><h3>${esc(item.title)}</h3><p>${esc(item.text)}</p></div></article>`).join('')}</div>
    </div>
  </section>
  <section>
    <div class="wrap">
      <div class="section-head reveal"><p class="lab"><span class="mk">▸</span> the collection</p><h2>Eighteen skills. Four layers.</h2><p>Run one phase, compose the primitives, or take the whole lifecycle through a single governed pass.</p></div>
      ${familyCards(route, groups, skills)}
    </div>
  </section>
  <section>
    <div class="wrap">
      <div class="section-head reveal"><p class="lab"><span class="mk">▸</span> deterministic enforcement</p><h2>Prompt contracts bend. Evidence does not.</h2><p>The guards cover specific static shortcuts; the coordinator and skill contracts cover the deeper cases they cannot safely infer from a single tool call.</p></div>
      <div class="scrollx reveal"><table class="matrix"><caption>guard → bounded claim → evidence</caption><thead><tr><th>Guard</th><th>What it blocks</th><th>Verified by</th></tr></thead><tbody>${enforcement.map((row) => `<tr><td><code>${esc(row.name)}</code></td><td>${esc(row.blocks)}</td><td class="mono">${esc(row.evidence)}</td></tr>`).join('')}</tbody></table></div>
      <div class="section-actions"><a class="btn ghost" href="${pathFor(route, 'how-it-works')}">See the full contract →</a></div>
    </div>
  </section>
  <section>
    <div class="wrap install-callout panel reveal"><div><p class="lab"><span class="mk">▸</span> universal skill install</p><h2>Start with all eighteen.</h2><p>Install through skills.sh today, then choose the full Claude Code plugin or follow the Codex plugin’s verified release status.</p></div><div>${codeRow(universalInstall, 'home-install')}<a class="text-link" href="${pathFor(route, 'plugins')}">Compare plugin distributions →</a></div></div>
  </section>`;
  return layout({
    route,
    title: site.name,
    description: site.description,
    body,
    structuredData: { '@context': 'https://schema.org', '@type': 'WebSite', name: site.name, url: canonicalFor(route), description: site.description },
  });
}

export function renderHowItWorks({ skills }) {
  const route = 'how-it-works';
  const body = `
  ${breadcrumb(route, [{ label: 'Home', target: '' }, { label: 'How it works' }])}
  <section class="page-hero">
    <div class="wrap page-hero-grid"><div><p class="lab"><span class="mk">▸</span> system architecture</p><h1>Autonomy with an instrument panel.</h1><p class="lede">The collection treats delivery as a bounded state machine: every phase has evidence, every loop has a stop set, and every long run has a durable way back in.</p></div><div class="hero-index panel"><span class="lab">RUN CONTRACT / 06</span>${contracts.map((item, index) => `<div><b>${String(index + 1).padStart(2, '0')}</b><span>${esc(item.title)}</span></div>`).join('')}</div></div>
  </section>
  <section><div class="wrap"><div class="section-head reveal"><p class="lab"><span class="mk">▸</span> lifecycle</p><h2>Eight phases. One directional pass.</h2><p>Each phase consumes grounded artifacts from the phase before it. Optional phases are explicitly skipped; required red gates block everything downstream.</p></div><div class="phase-strip">${pipeline.map((stage) => `<a class="phase-stage" href="${pathFor(route, `skills/${stage.slug}`)}"><span>${stage.number} · ${esc(stage.label)}</span><code>/${stage.slug}</code><p>${esc(stage.result)}</p></a>`).join('')}</div><p class="loopnote"><b>↻ close the loop</b> auto-learn runs from the checkpoint; auto-map refreshes project context after a real completed run.</p></div></section>
  <section><div class="wrap"><div class="section-head reveal"><p class="lab"><span class="mk">▸</span> autonomy contract</p><h2>Six rules every skill inherits.</h2><p>The implementation differs by platform. These guarantees do not.</p></div><div class="contract">${contracts.map((item) => `<article class="ct reveal"><h3>${esc(item.title)}</h3><p>${esc(item.text)}</p></article>`).join('')}</div></div></section>
  <section><div class="wrap"><div class="section-head reveal"><p class="lab"><span class="mk">▸</span> enforcement boundary</p><h2>Be exact about what is mechanical.</h2><p>Static guards block known dangerous tool shapes. Mutation checks, validators, benchmarks, checkpoints, and adversarial review cover the claims a hook cannot decide safely.</p></div><div class="scrollx"><table class="matrix"><thead><tr><th>Mechanism</th><th>Enforces</th><th>Evidence</th></tr></thead><tbody>${enforcement.map((row) => `<tr><td><code>${esc(row.name)}</code></td><td>${esc(row.blocks)}</td><td class="mono">${esc(row.evidence)}</td></tr>`).join('')}</tbody></table></div></div></section>
  <section><div class="wrap"><div class="section-head reveal"><p class="lab"><span class="mk">▸</span> durable truth</p><h2>Resume from evidence, not memory.</h2></div><div class="detail-grid"><article class="detail-block"><span class="detail-number">01</span><h3>Checkpoint</h3><p>Locked, atomic tooling records unit state and evidence. Observability failures stay visible instead of being promoted into clean state.</p></article><article class="detail-block"><span class="detail-number">02</span><h3>Skip done</h3><p>Resume skips only work that the durable state and repository evidence still support. Stale done records block rather than disappear.</p></article><article class="detail-block"><span class="detail-number">03</span><h3>Learn carefully</h3><p>Candidate lessons must be true, general, and actionable before they are routed into provider-native project context.</p></article><article class="detail-block"><span class="detail-number">04</span><h3>Keep authority narrow</h3><p>Plan approval governs the autonomous stretch. Ambiguity and irreversible actions still stop for a fresh user decision.</p></article></div><div class="section-actions"><a class="btn" href="${pathFor(route, 'skills/autonomous-pipeline')}">Open the pipeline skill →</a><a class="btn ghost" href="${pathFor(route, 'plugins')}">Compare runtimes</a></div></div></section>`;
  return layout({ route, active: 'how', title: 'How it works', description: 'The bounded lifecycle, deterministic enforcement, checkpoints, evidence gates, and authority model behind Autonomous Engineering Skills.', body });
}

function skillCard(route, skill, group) {
  return `<a class="skill-card reveal" data-catalog-skill="${esc(skill.slug)}" href="${pathFor(route, `skills/${skill.slug}`)}"><div class="skill-card-top"><span class="lab">${esc(groupLabel(group))}</span><span class="version">${esc(skill.version)}</span></div><code>${esc(skill.slug)}</code><h3>${esc(skill.title || skill.name)}</h3><p>${esc(skillOutcome(skill))}</p><span class="text-link">Open skill →</span></a>`;
}

export function renderSkillsIndex({ groups, skills }) {
  const route = 'skills';
  const body = `
  ${breadcrumb(route, [{ label: 'Home', target: '' }, { label: 'Skills' }])}
  <section class="page-hero"><div class="wrap page-hero-grid"><div><p class="lab"><span class="mk">▸</span> complete catalog</p><h1>Eighteen skills. No black boxes.</h1><p class="lede">Every page names the workflow, output contract, enforcement boundary, honest failure states, and the skills it composes.</p></div><div class="stat-strip panel"><div class="stat"><b>18</b><span>skills</span></div><div class="stat"><b>04</b><span>layers</span></div><div class="stat"><b>08</b><span>phases</span></div><div class="stat"><b>01</b><span>shared contract</span></div></div></div></section>
  ${groups.map((group) => { const members = skills.filter((skill) => skill.group === group.slug); return `<section id="${esc(group.slug)}"><div class="wrap"><div class="section-head reveal"><p class="lab"><span class="mk">▸</span> ${String(members.length).padStart(2, '0')} skills</p><h2>${esc(groupLabel(group))}</h2><p>${esc(group.description || group.summary || '')}</p></div><div class="skill-grid">${members.map((skill) => skillCard(route, skill, group)).join('')}</div></div></section>`; }).join('')}`;
  return layout({
    route,
    active: 'skills',
    title: 'All 18 skills',
    description: 'Browse every lifecycle phase, primitive, autonomy skill, and context-learning skill in the Autonomous Engineering collection.',
    body,
    structuredData: { '@context': 'https://schema.org', '@type': 'ItemList', name: 'Autonomous Engineering Skills', numberOfItems: skills.length, itemListElement: skills.map((skill, index) => ({ '@type': 'ListItem', position: index + 1, url: canonicalFor(`skills/${skill.slug}`), name: skill.title || skill.name })) },
  });
}

function renderWorkflowRail(skill) {
  return `<ol class="workflow-rail" aria-label="${esc(skill.title || skill.name)} workflow">${(skill.workflow || []).map((step, index) => `<li class="rail-step"><span>${String(index + 1).padStart(2, '0')}</span><p>${esc(typeof step === 'string' ? step : step.title || step.label || '')}</p></li>`).join('')}</ol>`;
}

function listBlock(title, items, className = 'signal-list') {
  return `<div class="detail-block"><h3>${esc(title)}</h3><ul class="${className}">${(items || []).map((item) => `<li>${esc(typeof item === 'string' ? item : item.text || item.label || '')}</li>`).join('')}</ul></div>`;
}

export function renderSkillDetail({ skill, group, groups, skills }) {
  const route = `skills/${skill.slug}`;
  const index = skills.findIndex((item) => item.slug === skill.slug);
  const previous = skills[(index - 1 + skills.length) % skills.length];
  const next = skills[(index + 1) % skills.length];
  const related = (skill.related || []).map((slug) => skills.find((item) => item.slug === slug)).filter(Boolean).slice(0, 4);
  const sourcePath = skill.sourcePath || `${skill.slug}/SKILL.md`;
  const body = `
  ${breadcrumb(route, [{ label: 'Home', target: '' }, { label: 'Skills', target: 'skills' }, { label: skill.title || skill.name }])}
  <section class="page-hero skill-hero"><div class="wrap page-hero-grid"><div><div class="hero-meta"><span class="lab"><span class="mk">▸</span> ${esc(groupLabel(group))}</span><span class="version">${esc(skill.version)}</span></div><h1><code>${esc(skill.slug)}</code></h1><p class="lede">${esc(skillOutcome(skill))}</p><div class="hero-actions"><a class="btn" href="#install">Install this skill →</a><a class="btn ghost" href="${sourceFor(sourcePath)}">Read SKILL.md ↗</a></div></div><div class="skill-instrument panel" data-visual="${esc(skill.visual?.kind || skill.visual || skill.slug)}"><div class="instrument-top"><span>WORKFLOW / ${String((skill.workflow || []).length).padStart(2, '0')}</span><span>${esc(invocationExample(skill))}</span></div>${renderWorkflowRail(skill)}</div></div></section>
  <section><div class="wrap"><div class="section-head reveal"><p class="lab"><span class="mk">▸</span> operating envelope</p><h2>Use it deliberately.</h2><p>The shortest useful definition of where this skill helps—and where it should stay out of the way.</p></div><div class="use-grid">${listBlock('Use when', skill.useWhen, 'check-list')}${listBlock('Do not use when', skill.avoidWhen, 'cross-list')}</div></div></section>
  <section><div class="wrap"><div class="section-head reveal"><p class="lab"><span class="mk">▸</span> output contract</p><h2>What must be true when it stops.</h2></div><div class="output-grid">${listBlock('Produces', skill.outputs)}${listBlock('Guarantees', skill.guarantees, 'guarantee-list')}${listBlock('Honest failure states', skill.failureStates, 'failure-list')}</div></div></section>
  <section><div class="wrap"><div class="section-head reveal"><p class="lab"><span class="mk">▸</span> enforcement</p><h2>Know which claims are executable.</h2><p>Scripts are linked when this skill owns deterministic machinery. The remaining rules are explicit operating contracts and must not be marketed as hooks.</p></div><div class="evidence-grid">${(skill.enforcementArtifacts || skill.enforcement || []).length ? (skill.enforcementArtifacts || skill.enforcement).map((item) => { const path = typeof item === 'string' ? item : item.path || item.label; return `<a class="evidence-card" href="${sourceFor(path)}"><span class="status-dot"></span><code>${esc(path)}</code><span>source ↗</span></a>`; }).join('') : '<div class="evidence-card evidence-procedural"><span class="status-dot"></span><div><b>Procedural contract</b><p>This skill composes platform tools and verification evidence; it does not claim a dedicated guard script.</p></div></div>'}</div></div></section>
  <section id="install"><div class="wrap"><div class="section-head reveal"><p class="lab"><span class="mk">▸</span> install and invoke</p><h2>One skill, three honest surfaces.</h2></div><div class="install-grid"><article class="install-card"><div class="install-card-head"><h3>skills.sh</h3>${statusBadge('available', 'Available')}</div><p>Universal skill installation, including Claude Code and Codex.</p>${codeRow(singleSkillInstall(skill.slug), `install-${skill.slug}`)}</article><article class="install-card"><div class="install-card-head"><h3>Claude Code plugin</h3>${statusBadge('available', 'Available')}</div><p>Install the full plugin, then invoke <code>/${esc(skill.slug)}</code> or let routing select it from context.</p><a class="text-link" href="${pathFor(route, 'plugins/claude-code')}">Claude installation →</a></article><article class="install-card"><div class="install-card-head"><h3>Codex</h3>${statusBadge('preview', 'Native plugin preview')}</div><p>The skills.sh version works today. Invoke the installed skill as <code>$${esc(skill.slug)}</code>. The native plugin is not presented as shipped until its install smoke passes.</p><a class="text-link" href="${pathFor(route, 'plugins/codex')}">Codex status →</a></article></div></div></section>
  ${related.length ? `<section><div class="wrap"><div class="section-head reveal"><p class="lab"><span class="mk">▸</span> composes with</p><h2>Related machinery.</h2></div><div class="related-grid">${related.map((item) => `<a class="related-card" href="${pathFor(route, `skills/${item.slug}`)}"><code>${esc(item.slug)}</code><p>${esc(skillOutcome(item))}</p><span>Open →</span></a>`).join('')}</div></div></section>` : ''}
  <nav class="page-nav wrap" aria-label="Adjacent skills"><a href="${pathFor(route, `skills/${previous.slug}`)}"><span>← previous</span><b>${esc(previous.slug)}</b></a><a href="${pathFor(route, `skills/${next.slug}`)}"><span>next →</span><b>${esc(next.slug)}</b></a></nav>`;
  return layout({
    route,
    active: 'skills',
    title: `${skill.title || skill.name} skill`,
    description: skillOutcome(skill),
    type: 'article',
    mainAttrs: `data-skill="${esc(skill.slug)}"`,
    body,
    structuredData: { '@context': 'https://schema.org', '@type': 'TechArticle', headline: `${skill.title || skill.name} skill`, description: skillOutcome(skill), url: canonicalFor(route), version: skill.version, isPartOf: { '@type': 'WebSite', name: site.name, url: canonicalFor('') } },
  });
}

export function renderPluginsHub({ plugins }) {
  const route = 'plugins';
  const body = `
  ${breadcrumb(route, [{ label: 'Home', target: '' }, { label: 'Plugins' }])}
  <section class="page-hero plugin-hero"><div class="wrap"><p class="lab"><span class="mk">▸</span> platform distributions</p><h1>Choose the machinery.<br>Keep the contract.</h1><p class="lede">Claude Code and Codex do not expose identical tools. The plugins should not pretend they do. Each distribution maps the same 18 skills onto provider-native capabilities and reports the gaps honestly.</p></div></section>
  <section><div class="wrap"><div class="platform-grid">${pluginCard(route, pluginFor(plugins, 'claude-code'), 'claude-code')}${pluginCard(route, pluginFor(plugins, 'codex'), 'codex')}</div></div></section>
  <section><div class="wrap"><div class="section-head reveal"><p class="lab"><span class="mk">▸</span> capability matrix</p><h2>Shared methodology, explicit differences.</h2></div><div class="scrollx"><table class="comparison-table"><thead><tr><th>Surface</th><th>Claude Code</th><th>Codex</th></tr></thead><tbody>${pluginComparison.map((row) => `<tr><th>${esc(row[0])}</th><td>${esc(row[1])}</td><td>${esc(row[2])}</td></tr>`).join('')}</tbody></table></div></div></section>
  <section><div class="wrap install-callout panel"><div><p class="lab"><span class="mk">▸</span> works today</p><h2>Install the contracts anywhere.</h2><p>skills.sh is the common denominator. Plugin pages describe the provider-native layers on top.</p></div><div>${codeRow(universalInstall, 'plugins-universal')}</div></div></section>`;
  return layout({ route, active: 'plugins', title: 'Claude Code and Codex plugins', description: 'Compare the Claude Code plugin, the Codex plugin roadmap, universal skills installation, hooks, context, orchestration, and current availability.', body });
}

export function renderClaudePlugin({ skills }) {
  const route = 'plugins/claude-code';
  const body = `
  ${breadcrumb(route, [{ label: 'Home', target: '' }, { label: 'Plugins', target: 'plugins' }, { label: 'Claude Code' }])}
  <section class="page-hero plugin-hero"><div class="wrap page-hero-grid"><div><div class="hero-meta"><p class="lab"><span class="mk">C</span> Claude Code plugin</p>${statusBadge('available', 'Available now')}</div><h1>All eighteen skills.<br>The guards wired in.</h1><p class="lede">The current marketplace plugin packages the canonical skills, lifecycle hooks, tested guard scripts, and runnable Workflow templates as one Claude-native distribution.</p><div class="hero-actions"><a class="btn" href="#install">Install plugin →</a><a class="btn ghost" href="${site.repository}/tree/main/.claude-plugin">Inspect manifest ↗</a></div></div><div class="stat-strip panel"><div class="stat"><b>18</b><span>skills</span></div><div class="stat"><b>04</b><span>hook stages</span></div><div class="stat"><b>02</b><span>workflow templates</span></div><div class="stat"><b>01</b><span>marketplace install</span></div></div></div></section>
  <section><div class="wrap"><div class="section-head reveal"><p class="lab"><span class="mk">▸</span> lifecycle hooks</p><h2>Defense in depth, scoped to real guarantees.</h2><p>The hooks do not replace validation, review, or budgets. They stop common dangerous tool shapes and keep run lifecycle state visible.</p></div><div class="detail-grid">${claudeHooks.map((row, index) => `<article class="detail-block"><span class="detail-number">${String(index + 1).padStart(2, '0')}</span><h3>${esc(row[0])}</h3><p>${esc(row[1])}</p></article>`).join('')}</div></div></section>
  <section id="install"><div class="wrap"><div class="section-head reveal"><p class="lab"><span class="mk">▸</span> install</p><h2>Add the marketplace, then the plugin.</h2><p>Run these commands inside Claude Code. Review the bundled hooks before trusting them in a project.</p></div>${codeRow('/plugin marketplace add ulpi-io/skills-autonomous-engineering', 'claude-marketplace')}${codeRow('/plugin install autonomous-engineering@ulpi-autonomous-engineering', 'claude-plugin-install')}</div></section>
  <section><div class="wrap"><div class="section-head reveal"><p class="lab"><span class="mk">▸</span> included</p><h2>The complete collection.</h2></div><div class="chip-grid">${skills.map((skill) => `<a href="${pathFor(route, `skills/${skill.slug}`)}">/${esc(skill.slug)}</a>`).join('')}</div></div></section>
  <section><div class="wrap"><div class="callout"><span class="stamp stamp-ok">available</span><div><h2>Claude-first today.</h2><p>The repository’s canonical skills and current hooks are implemented for Claude Code. The Codex plugin page separates what is universally installable now from what remains native-plugin work.</p></div><a class="btn ghost" href="${pathFor(route, 'plugins/codex')}">See Codex status →</a></div></div></section>`;
  return layout({ route, active: 'plugins', title: 'Claude Code plugin', description: 'Install the shipped Autonomous Engineering Claude Code plugin with all 18 skills, lifecycle hooks, tested guards, and Workflow templates.', body });
}

export function renderCodexPlugin({ skills }) {
  const route = 'plugins/codex';
  const body = `
  ${breadcrumb(route, [{ label: 'Home', target: '' }, { label: 'Plugins', target: 'plugins' }, { label: 'Codex' }])}
  <section class="page-hero plugin-hero"><div class="wrap page-hero-grid"><div><div class="hero-meta"><p class="lab"><span class="mk">X</span> Codex plugin</p>${statusBadge('preview', 'Preview · in development')}</div><h1>Codex-native.<br>Not Claude-shaped.</h1><p class="lede">Universal skill installation works today. The full native plugin stays explicitly preview until isolated adapters, deterministic coordination, hooks, packaging, and a real new-session install smoke are implemented and green.</p><div class="hero-actions"><a class="btn" href="#available-now">Use skills today →</a><a class="btn ghost" href="${site.repository}">Follow development ↗</a></div></div><div class="preview-panel panel"><span class="stamp">preview</span><p class="lab">RELEASE GATE</p><strong>native_plugin_ready = false</strong><ul><li>manifest + adapters</li><li>package + catalog</li><li>isolated install</li><li>new-session invocation</li><li>hook trust evidence</li></ul></div></div></section>
  <section id="available-now"><div class="wrap"><div class="section-head reveal"><p class="lab"><span class="mk">▸</span> available now</p><h2>All eighteen contracts through skills.sh.</h2><p>Codex supports the SKILL.md anatomy. Install the collection or one skill today; this is not presented as the native plugin.</p></div>${codeRow(universalInstall, 'codex-universal')}<div class="chip-grid">${skills.map((skill) => `<a href="${pathFor(route, `skills/${skill.slug}`)}">$${esc(skill.slug)}</a>`).join('')}</div></div></section>
  <section><div class="wrap"><div class="section-head reveal"><p class="lab"><span class="mk">▸</span> native-plugin target</p><h2>What has to exist before “installable.”</h2><p>The release claim is evidence-gated. Missing capability becomes preview or gateNotRun, never optimistic copy.</p></div><ol class="roadmap-list">${codexRoadmap.map((item, index) => `<li><span>${String(index + 1).padStart(2, '0')}</span><p>${esc(item)}</p></li>`).join('')}</ol></div></section>
  <section><div class="wrap"><div class="section-head reveal"><p class="lab"><span class="mk">▸</span> platform mapping</p><h2>Same purpose, native mechanisms.</h2></div><div class="comparison-cards"><article><h3>Project context</h3><p>AGENTS.md and Codex-native configuration replace Claude-specific memory and scoped-rule claims.</p></article><article><h3>Execution</h3><p>A deterministic coordinator owns Git, validation, checkpoints, budgets, and convergence around exact codex exec schemas.</p></article><article><h3>Hooks</h3><p>Only supported Codex events are declared. Installed plugin hooks stay untrusted until reviewed or explicitly vetted for automation.</p></article><article><h3>Honest limits</h3><p>Unavailable scheduling, wake-up, or creation capabilities return preview, created:false, or gateNotRun instead of fictional success.</p></article></div></div></section>
  <section><div class="wrap"><div class="callout"><span class="stamp">not installable yet</span><div><h2>No native-plugin command until it is true.</h2><p>This page is intentionally feature-rich without manufacturing an installation path. When the real artifact passes its smoke gate, the status and verified commands can be switched from one catalog entry.</p></div><a class="btn ghost" href="${pathFor(route, 'plugins/claude-code')}">Use the shipped plugin →</a></div></div></section>`;
  return layout({ route, active: 'plugins', title: 'Codex plugin preview', description: 'Follow the native Codex plugin work, use all 18 skills through skills.sh today, and see the evidence required before the plugin is called installable.', body });
}

export function renderNotFound() {
  const route = '';
  const body = `<section class="not-found"><div class="wrap"><div class="not-found-code">404</div><p class="lab"><span class="mk">✗</span> route not found</p><h1>This path did not converge.</h1><p>The page may have moved, but the skill catalog and plugin surfaces are still reachable.</p><div class="hero-actions"><a class="btn" href="./">Return home →</a><a class="btn ghost" href="skills/">Browse skills</a></div></div></section>`;
  return layout({ route, canonicalOverride: `${site.origin}${site.basePath}404.html`, title: 'Page not found', description: 'The requested Autonomous Engineering Skills page could not be found.', body });
}
