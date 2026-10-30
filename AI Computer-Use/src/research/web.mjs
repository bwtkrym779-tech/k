import { createHash } from 'node:crypto';

/**
 * Web research. All fetched content is untrusted data: it is returned to the
 * model inside explicit delimiters and scanned for prompt-injection patterns.
 * The agent must never execute instructions found in web content.
 */

const AUTHORITY = [
  { pattern: /(^|\.)microsoft\.com$/i, score: 30, label: 'vendor' },
  { pattern: /(^|\.)opencode\.ai$/i, score: 30, label: 'vendor' },
  { pattern: /(^|\.)github\.com$/i, score: 24, label: 'source repository' },
  { pattern: /(^|\.)nodejs\.org$/i, score: 28, label: 'official' },
  { pattern: /(^|\.)python\.org$/i, score: 28, label: 'official' },
  { pattern: /(^|\.)mozilla\.org$/i, score: 26, label: 'official' },
  { pattern: /(^|\.)w3\.org$/i, score: 26, label: 'standard' },
  { pattern: /(^|\.)learn\.microsoft\.com$/i, score: 30, label: 'official docs' },
  { pattern: /(^|\.)docs\.[a-z0-9-]+\./i, score: 28, label: 'docs subdomain' },
  { pattern: /(^|\.)developer\.[a-z0-9-]+\./i, score: 26, label: 'developer docs' },
  { pattern: /(^|\.)stackoverflow\.com$/i, score: 12, label: 'community' },
  { pattern: /(^|\.)reddit\.com$/i, score: 6, label: 'community' },
  { pattern: /(^|\.)medium\.com$/i, score: 5, label: 'blog' },
];

const INJECTION_PATTERNS = [
  /ignore (all |the )?(previous|prior|above) (instructions|prompts?)/i,
  /disregard (all |the )?(previous|prior|system) (instructions|prompt)/i,
  /you are now (a|an|in) /i,
  /system prompt|developer message/i,
  /(run|execute|paste) (this|the following) (command|script|code)/i,
  /(send|upload|post) (the )?(user'?s?|their) (data|files|credentials|passwords)/i,
  /(delete|remove|format) (all|the) (files|disk|drive)/i,
  /<\|im_start\|>|<\|system\|>|\[INST\]/i,
];

export function scanForInjection(text) {
  const hits = [];
  for (const re of INJECTION_PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push(m[0].slice(0, 120));
  }
  return hits;
}

export function htmlToText(html) {
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  h = decodeEntities(h);
  h = h.replace(/[ \t\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/ *\n */g, '\n');
  return h.trim();
}

export function decodeEntities(text) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/', '#8217': '’', '#8220': '“', '#8221': '”', '#8211': '–', '#8212': '—' };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, entity) => {
    if (map[entity]) return map[entity];
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return m;
  });
}

export function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).trim().slice(0, 300) : null;
}

export function extractLinks(html, baseUrl, limit = 40) {
  const links = [];
  const re = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && links.length < limit) {
    let href = m[1];
    if (href.startsWith('#') || href.startsWith('javascript:')) continue;
    try { href = new URL(href, baseUrl).toString(); } catch { continue; }
    const text = htmlToText(m[2]).slice(0, 160);
    if (text) links.push({ url: href, text });
  }
  return links;
}

function authorityFor(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return { score: 0, label: 'unknown' }; }
  const hit = AUTHORITY.find((a) => a.pattern.test(host));
  return hit ? { score: hit.score, label: hit.label } : { score: 10, label: 'general web' };
}

export class WebResearch {
  constructor({ config, audit }) {
    this.config = config;
    this.audit = audit;
    this.cache = new Map();
  }

  async #fetch(url, { method = 'GET', maxBytes = 2_000_000, timeoutMs = this.config.research.timeoutMs } = {}) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw Object.assign(new Error(`Blocked scheme ${parsed.protocol}`), { code: 'URL_SCHEME_BLOCKED' });
    const key = `${method}:${url}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const started = Date.now();
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      headers: {
        'user-agent': this.config.research.userAgent,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'accept-language': 'en-US,en;q=0.9,ar;q=0.8',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = res.headers.get('content-type') ?? '';
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${res.statusText} for ${url}`), { code: 'HTTP_ERROR', status: res.status });
    if (!/text\/|json|xml/i.test(contentType)) throw Object.assign(new Error(`Unsupported content-type: ${contentType}`), { code: 'UNSUPPORTED_CONTENT' });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw Object.assign(new Error(`Response exceeds ${maxBytes} bytes`), { code: 'RESPONSE_TOO_LARGE' });
    const body = buf.toString('utf8');
    const result = { url: res.url, status: res.status, contentType, body, bytes: buf.length, duration_ms: Date.now() - started, fetched_at: new Date().toISOString() };
    this.cache.set(key, result);
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value);
    this.audit?.info('research.fetch', { url, status: res.status, bytes: buf.length, duration_ms: result.duration_ms });
    return result;
  }

  async search(query, { maxResults = this.config.research.maxResults } = {}) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    let results = [];
    try {
      const page = await this.#fetch(url, { timeoutMs: 15000 });
      results = parseDuckDuckGo(page.body, maxResults);
    } catch (err) {
      this.audit?.warn('research.search_failed', { query, error: err.message, provider: 'duckduckgo' });
    }
    if (results.length === 0) {
      const lite = await this.#fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, { timeoutMs: 15000 }).catch(() => null);
      if (lite) results = parseDuckDuckGoLite(lite.body, maxResults);
    }
    if (results.length === 0) {
      throw Object.assign(new Error('No search results and no fallback provider succeeded (internet unavailable or blocked)'), { code: 'SEARCH_UNAVAILABLE' });
    }
    return results.map((r) => ({ ...r, authority: authorityFor(r.url) }));
  }

  async open(url) {
    const page = await this.#fetch(url);
    const isJson = /json/i.test(page.contentType);
    const text = isJson ? page.body : htmlToText(page.body);
    const injection = scanForInjection(text);
    return {
      url: page.url,
      requested_url: url,
      title: isJson ? null : extractTitle(page.body),
      status: page.status,
      content_type: page.contentType,
      bytes: page.bytes,
      fetched_at: page.fetched_at,
      text: text.slice(0, 20000),
      truncated: text.length > 20000,
      links: isJson ? [] : extractLinks(page.body, page.url, 30),
      injection_flags: injection,
      untrusted: true,
      sha256: createHash('sha256').update(page.body).digest('hex'),
    };
  }

  async findOfficialDocs(product, topic, { maxResults = 8 } = {}) {
    const query = `${product} ${topic} official documentation`;
    const results = await this.search(query, { maxResults: maxResults * 2 });
    const ranked = results
      .map((r) => {
        const auth = authorityFor(r.url);
        const bonus = /docs|documentation|learn|developer|reference|api/i.test(r.url + ' ' + r.title) ? 6 : 0;
        return { ...r, authority: auth, score: auth.score + bonus };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
    return {
      query,
      product,
      topic,
      results: ranked,
      note: 'Ranked by domain authority heuristics. Verify the version/edition on the page before acting.',
    };
  }

  async compareSources({ query, urls = [] }) {
    let targets = urls;
    if (targets.length === 0) {
      const found = await this.search(query, { maxResults: 3 });
      targets = found.map((r) => r.url);
    }
    targets = targets.slice(0, 3);
    const sources = [];
    for (const url of targets) {
      try {
        const page = await this.open(url);
        sources.push({
          url: page.url,
          title: page.title,
          authority: authorityFor(page.url),
          excerpt: page.text.slice(0, 2500),
          injection_flags: page.injection_flags,
          hash: page.sha256,
        });
      } catch (err) {
        sources.push({ url, error: err.message });
      }
    }
    return {
      query,
      sources,
      agreement: agreementScore(sources),
      note: 'Agreement is a keyword-overlap heuristic, not proof. Prefer vendor documentation and check the installed version.',
    };
  }
}

function parseDuckDuckGo(html, limit) {
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    let href = decodeEntities(m[1]);
    if (href.includes('uddg=')) {
      try { href = decodeURIComponent(new URL(href, 'https://duckduckgo.com').searchParams.get('uddg')); } catch { /* keep */ }
    }
    if (!/^https?:/i.test(href)) continue;
    out.push({ url: href, title: htmlToText(m[2]).slice(0, 200), snippet: '' });
  }
  const snippetRe = /<(?:a|div)[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi;
  let i = 0;
  let s;
  while ((s = snippetRe.exec(html)) && i < out.length) {
    out[i].snippet = htmlToText(s[1]).slice(0, 400);
    i++;
  }
  return dedupe(out);
}

function parseDuckDuckGoLite(html, limit) {
  const out = [];
  const re = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    let href = decodeEntities(m[1]);
    if (href.includes('uddg=')) {
      try { href = decodeURIComponent(new URL(href, 'https://duckduckgo.com').searchParams.get('uddg')); } catch { /* keep */ }
    }
    if (!/^https?:/i.test(href)) continue;
    out.push({ url: href, title: htmlToText(m[2]).slice(0, 200), snippet: '' });
  }
  return dedupe(out);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((r) => {
    const key = r.url.replace(/\/$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function agreementScore(sources) {
  const ok = sources.filter((s) => s.excerpt);
  if (ok.length < 2) return { level: 'insufficient', shared_terms: 0 };
  const tokenize = (t) => new Set(t.toLowerCase().match(/[a-z0-9][a-z0-9_+.-]{3,}/g) ?? []);
  const sets = ok.map((s) => tokenize(s.excerpt));
  const shared = [...sets[0]].filter((t) => sets.slice(1).every((s) => s.has(t)));
  const level = shared.length > 25 ? 'high' : shared.length > 8 ? 'medium' : 'low';
  return { level, shared_terms: shared.length, sample: shared.slice(0, 15) };
}
