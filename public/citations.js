import MarkdownIt from './vendor/markdown-it.mjs';

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

const KB_CITATION_RE = /<kb\b[^>]*?\/?>/gi;
const CITATION_SLOT_RE = /\uE000(\d+)\uE001/g;

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

const renderLinkOpen =
  markdown.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderLinkOpen(tokens, index, options, env, self);
};

function parseCitation(marker) {
  const attrs = {};
  const attributeRe = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = attributeRe.exec(marker))) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  const doc = (attrs.doc || '').trim();
  const chunkId = (attrs.chunk_id || '').trim();
  return {
    doc,
    kbId: (attrs.kb_id || '').trim(),
    chunkId,
    label: doc || '知识库引用',
    title: chunkId ? `${doc || '知识库引用'} · ${chunkId}` : doc || '知识库引用',
  };
}

function citationHtml(marker, uiUrl, knowledgeMap) {
  const citation = parseCitation(marker);
  const resolved = knowledgeMap?.[citation.chunkId];
  if ((!citation.kbId && !resolved) || !uiUrl) {
    return `<span class="kb-citation" title="${esc(citation.title)}">${esc(citation.label)}</span>`;
  }
  const kbId = resolved?.knowledgeBaseId || citation.kbId;
  const query = resolved?.knowledgeId ? `?knowledge_id=${encodeURIComponent(resolved.knowledgeId)}` : '';
  const href = `${uiUrl.replace(/\/+$/, '')}/platform/knowledge-bases/${encodeURIComponent(kbId)}${query}`;
  const kind = resolved?.knowledgeId ? '文章' : '知识库';
  return `<a class="kb-citation" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(citation.title)}"><span>${esc(citation.label)}</span><span class="kb-citation-kind">${kind}</span></a>`;
}

export function extractCitationChunkIds(body) {
  const ids = [];
  for (const match of String(body ?? '').matchAll(KB_CITATION_RE)) {
    const { chunkId } = parseCitation(match[0]);
    if (chunkId) ids.push(chunkId);
  }
  return [...new Set(ids)];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightMentions(html, names) {
  const unique = [...new Set((names ?? []).filter((name) => typeof name === 'string' && name.trim()))]
    .sort((a, b) => b.length - a.length);
  if (unique.length === 0) return html;
  const pattern = new RegExp(
    `@(${unique.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`,
    'giu',
  );
  return html
    .split(/(<[^>]*>)/)
    .map((segment) =>
      segment.startsWith('<') ? segment : segment.replace(pattern, '<span class="mention-ref">@$1</span>'),
    )
    .join('');
}

const REF_SLOT_RE = /\uE002(\d+)\uE003/g;
const REF_RE =
  /#\[([^\]\n]{1,120})\]|(?<![\p{L}\p{N}_-])#?([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z][A-Za-z0-9]*)*-\d+)(?![\p{L}\p{N}_-])|(?<![\p{L}\p{N}_#-])#([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z][A-Za-z0-9]*)*)(?![\p{L}\p{N}_-])/gu;

function projectHref(key) {
  return `/ui/projects/${encodeURIComponent(key)}/board`;
}

function taskHref(key, ref) {
  return `/ui/projects/${encodeURIComponent(key)}/board/tasks/${encodeURIComponent(ref)}`;
}

function referenceContext(options = {}) {
  const projects = options.projects ?? [];
  const groups = options.groups ?? [];
  return {
    currentKey: options.projectKey ?? '',
    projectByKey: new Map(
      projects.map((project) => [String(project.key ?? '').toUpperCase(), project]),
    ),
    groupByName: new Map(
      groups.map((group) => [String(group.name ?? '').trim().toLowerCase(), group]),
    ),
  };
}

function referenceHtml(match, context) {
  const [raw, groupName, taskRef, projectRef] = match;
  if (groupName !== undefined) {
    const group = context.groupByName.get(groupName.trim().toLowerCase());
    if (!group || !context.currentKey) return '';
    return `<a class="ref-link group-ref" href="${projectHref(context.currentKey)}" data-link data-group-focus="${esc(group.id)}">${esc(raw)}</a>`;
  }
  if (taskRef) {
    const projectKey = taskRef.slice(0, taskRef.lastIndexOf('-')).toUpperCase();
    const project = context.projectByKey.get(projectKey);
    if (!project) return '';
    return `<a class="ref-link task-ref" href="${taskHref(project.key, taskRef)}" data-link title="查看任务 ${esc(taskRef)}">${esc(raw)}</a>`;
  }
  if (projectRef) {
    const project = context.projectByKey.get(projectRef.toUpperCase());
    if (!project) return '';
    return `<a class="ref-link project-ref" href="${projectHref(project.key)}" data-link title="${esc(project.name ?? project.key)}">${esc(raw)}</a>`;
  }
  return '';
}

function collectSlots(text, { uiUrl = '', knowledgeMap = {}, referenceOptions = null } = {}) {
  const spans = [];
  for (const match of text.matchAll(KB_CITATION_RE)) {
    spans.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      kind: 'citation',
      match,
    });
  }
  const context = referenceOptions ? referenceContext(referenceOptions) : null;
  if (context) {
    for (const match of text.matchAll(REF_RE)) {
      spans.push({
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        kind: 'reference',
        match,
      });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);

  const citations = [];
  const references = [];
  let prepared = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    prepared += text.slice(cursor, span.start);
    if (span.kind === 'citation') {
      prepared += `\uE000${citations.length}\uE001`;
      citations.push(citationHtml(span.match[0], uiUrl, knowledgeMap));
    } else {
      const html = referenceHtml(span.match, context);
      if (html) {
        prepared += `\uE002${references.length}\uE003`;
        references.push(html);
      } else {
        prepared += span.match[0];
      }
    }
    cursor = span.end;
  }
  prepared += text.slice(cursor);
  return { prepared, citations, references };
}

function substituteSlots(html, citations, references) {
  return html
    .replace(CITATION_SLOT_RE, (_slot, index) => citations[Number(index)] ?? '')
    .replace(REF_SLOT_RE, (_slot, index) => references[Number(index)] ?? '');
}

export function renderRichText(body, options = {}) {
  const text = String(body ?? '');
  if (!text.trim()) return '';
  const {
    uiUrl = '',
    knowledgeMap = {},
    mentionNames = [],
    projectKey = '',
    projects = [],
    groups = [],
  } = options;
  const useReferences = Boolean(projectKey || projects.length || groups.length);
  const { prepared, citations, references } = collectSlots(text, {
    uiUrl,
    knowledgeMap,
    referenceOptions: useReferences ? { projectKey, projects, groups } : null,
  });
  const html = markdown.render(prepared).trim();
  return highlightMentions(substituteSlots(html, citations, references), mentionNames);
}
