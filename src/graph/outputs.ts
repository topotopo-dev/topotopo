// What a published output says about itself beside its node and label (GraphSpec.outputs): its kind, which publishing
// detects from the cooked output (io/kinds.ts publishedKind) and an author may pin ("kind": "mesh") to have it checked,
// its tags, free words that search finds it by, and its description. Engine.validate checks them wherever a graph is
// read; publishing (src/gallery/packages.ts) blocks on them as well.

/**
 * The kinds of a published output: a mesh, packed instances, points, curves, a terrain (heightfields), textures (images
 * alone), a volume, or a scene that holds several of these (a street with its lamp posts as instances).
 */
export const KINDS = ['mesh', 'instances', 'points', 'curves', 'terrain', 'textures', 'volume', 'scene'] as const;
export type Kind = (typeof KINDS)[number];
export const isKind = (k: unknown): k is Kind => typeof k === 'string' && (KINDS as readonly string[]).includes(k);

/** A tag: lower-case letters, digits and "-", starting with a letter or digit, at most 64 characters. */
export const TAG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** At most this many tags per output. */
export const MAX_TAGS = 16;

export const KIND_HINT = `the kinds: ${KINDS.join(', ')}; without "kind" publishing records the kind the output cooks to`;
export const TAG_HINT = `a tag is lower-case letters, digits and -, starting with a letter or digit, at most 64 characters ("conifer", "low-poly"); an output has at most ${MAX_TAGS} tags, each once`;

/** What is wrong with a named output's kind, tags and description, each with the rule as its hint (none: nothing). */
export function outputFieldIssues(out: { kind?: unknown; tags?: unknown; description?: unknown }): { message: string; hint: string }[] {
  const issues: { message: string; hint: string }[] = [];
  if (out.kind !== undefined && !isKind(out.kind)) issues.push({ message: `"kind" ${JSON.stringify(out.kind)} is not a kind`, hint: KIND_HINT });
  const tags = out.tags;
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) issues.push({ message: `"tags" must be a list of words, such as ["conifer", "low-poly"], got ${JSON.stringify(tags)?.slice(0, 80)}`, hint: TAG_HINT });
    else {
      for (const t of tags) if (!TAG_RE.test(t)) issues.push({ message: `tag ${JSON.stringify(t)} is malformed`, hint: TAG_HINT });
      if (tags.length > MAX_TAGS) issues.push({ message: `${tags.length} tags, more than ${MAX_TAGS}`, hint: TAG_HINT });
      const twice = [...new Set(tags.filter((t, i) => tags.indexOf(t) !== i))];
      if (twice.length) issues.push({ message: `tag${twice.length > 1 ? 's' : ''} ${twice.map((t) => `"${t}"`).join(', ')} given twice`, hint: TAG_HINT });
    }
  }
  if (out.description !== undefined && typeof out.description !== 'string')
    issues.push({ message: `"description" must be a string, got ${JSON.stringify(out.description)?.slice(0, 80)}`, hint: 'what the output is, in a sentence or two; without one, the description of its graph is recorded' });
  return issues;
}
