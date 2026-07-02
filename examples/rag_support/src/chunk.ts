export interface RawChunk {
  source: string;
  text: string;
}

interface Section {
  heading: string;
  body: string;
}

/** Split a markdown doc on `##` headings into sections. */
function splitByHeading(markdown: string): Section[] {
  const sections: Section[] = [];
  let heading = "";
  let body: string[] = [];
  const flush = (): void => {
    const text = body.join("\n").trim();
    if (text) sections.push({ heading, body: text });
    body = [];
  };
  for (const line of markdown.split("\n")) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = (m[1] ?? "").trim();
    } else if (!/^#\s+/.test(line)) {
      // skip the top-level H1 title line; keep everything else
      body.push(line);
    }
  }
  flush();
  return sections;
}

/** Pack paragraphs into chunks no larger than maxChars (never splitting a
 * paragraph), so each chunk is a coherent, citable passage. */
function packParagraphs(body: string, maxChars: number): string[] {
  const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let current = "";
  for (const p of paras) {
    if (current && current.length + p.length + 2 > maxChars) {
      out.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Chunk a markdown doc into focused passages keyed by their section heading.
 * The heading is prepended to each chunk so retrieval and citations carry topic
 * context (e.g. "Refunds\nRefunds are processed within 5 business days…").
 */
export function chunkMarkdown(fileName: string, markdown: string, maxChars = 800): RawChunk[] {
  const chunks: RawChunk[] = [];
  for (const { heading, body } of splitByHeading(markdown)) {
    const source = heading ? `${fileName}#${heading}` : fileName;
    for (const piece of packParagraphs(body, maxChars)) {
      const text = (heading ? `${heading}\n${piece}` : piece).trim();
      if (text) chunks.push({ source, text });
    }
  }
  return chunks;
}
