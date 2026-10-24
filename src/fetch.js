// Turns a saved link into clean, speakable text: DEV posts through DEV's API, anything else through Readability.
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

const UA = 'SlothReads/1.0 (+https://github.com/sbis04/sloth-reads)';
const WPM = 230;

export const minutesFor = (words) => Math.max(1, Math.round(words / WPM));
const countWords = (t) => (t.match(/\S+/g) ?? []).length;

// Markdown written for eyes, rewritten for ears: no code, no image syntax, no liquid tags.
export function speakable(md) {
  return md
    .replace(/```[\s\S]*?```/g, '\n(A code sample is skipped here.)\n')
    .replace(/\{%[\s\S]*?%\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|\*|_)(\S[^*_]*?\S?)\1/g, '$2')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const isDev = (u) => /^https?:\/\/(www\.)?dev\.to\/[^/]+\/[^/?#]+/.test(u);

export async function fetchArticle(url) {
  if (isDev(url)) {
    const [, user, slug] = new URL(url).pathname.split('/');
    const res = await fetch(`https://dev.to/api/articles/${user}/${slug}`, { headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`DEV ${res.status}`);
    const a = await res.json();
    const text = speakable(a.body_markdown ?? '');
    return {
      source: 'dev', dev_id: a.id, url: a.url ?? url, title: a.title, author: a.user?.name ?? '', site: 'DEV',
      cover: a.cover_image ?? a.social_image ?? null, text, words: countWords(text),
      read_minutes: a.reading_time_minutes || minutesFor(countWords(text)),
    };
  }
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const html = await res.text();
  const { document } = parseHTML(html);
  const meta = (p) => document.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.getAttribute('content') ?? null;
  const article = new Readability(document).parse();
  if (!article?.textContent || countWords(article.textContent) < 80) throw new Error('No readable article on that page');
  const text = article.textContent.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return {
    source: 'link', dev_id: null, url: res.url || url, title: article.title || meta('og:title') || url,
    author: article.byline ?? '', site: meta('og:site_name') ?? new URL(res.url || url).hostname.replace(/^www\./, ''),
    cover: meta('og:image'), text, words: countWords(text), read_minutes: minutesFor(countWords(text)),
  };
}

// The DEV reading list of whoever owns DEV_API_KEY.
export async function devReadingList(key) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`https://dev.to/api/readinglist?per_page=100&page=${page}`, { headers: { 'api-key': key, 'user-agent': UA } });
    if (!res.ok) throw new Error(`DEV reading list ${res.status}`);
    const rows = await res.json();
    out.push(...rows.map((r) => r.article?.url).filter(Boolean));
    if (rows.length < 100) break;
  }
  return out;
}
