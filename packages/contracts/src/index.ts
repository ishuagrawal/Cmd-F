import { z } from 'zod';
export const PROTOCOL = 1 as const;
export const CandidateSchema = z.object({
  id: z.string().max(80),
  snapshotId: z.string().max(80),
  kind: z.enum(['passage', 'link', 'control', 'group']),
  label: z.string().max(600),
  text: z.string().max(10000).optional(),
  textRole: z.enum(['heading', 'body']).optional(),
  safeUrl: z.string().url().max(2048).optional(),
  headingPath: z.array(z.string().max(300)).max(8),
  context: z.string().max(1000),
  visibility: z.enum(['visible', 'offscreen', 'hidden', 'unknown']),
  actionPolicy: z.enum(['read_candidate', 'highlight_only', 'needs_review']),
  parentControlId: z.string().max(80).optional(),
  provenance: z.enum(['live_dom', 'html', 'sitemap', 'rendered_dom']),
  headingId: z.string().max(300).optional(),
  disabled: z.boolean().optional(),
  expanded: z.boolean().optional(),
  sectionId: z.string().max(80).optional(),
  contentHash: z.string().max(80),
  truncated: z.boolean().optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;
export const SnapshotSchema = z
  .object({
    id: z.string().max(80),
    documentId: z.string().max(80),
    version: z.number().int().nonnegative(),
    url: z.string().url().max(2048).optional(),
    origin: z.string().url().max(300),
    title: z.string().max(300),
    observedAt: z.string().datetime(),
    candidates: z.array(CandidateSchema).max(600),
    limitations: z.array(z.string().max(100)).max(30),
    sectionIds: z.array(z.string().max(80)).max(400),
    private: z.boolean().default(true),
    discovery: z
      .object({
        candidates: z.number().int().nonnegative(),
        links: z.number().int().nonnegative(),
        complete: z.boolean(),
      })
      .optional(),
  })
  .superRefine((s, ctx) => {
    const ids = new Set<string>();
    for (const c of s.candidates) {
      if (c.snapshotId !== s.id || ids.has(c.id))
        ctx.addIssue({ code: 'custom', message: 'Invalid candidate identity' });
      ids.add(c.id);
    }
  });
export type PageSnapshot = z.infer<typeof SnapshotSchema>;
export const SearchRequestSchema = z
  .object({
    protocol: z.literal(PROTOCOL),
    question: z.string().trim().min(2).max(500),
    scope: z.enum(['page', 'site']),
    snapshot: SnapshotSchema,
    consent: z.literal(true),
    publicSearchConsent: z.boolean(),
    refresh: z.boolean().default(false),
  })
  .refine((x) => x.scope === 'page' || x.publicSearchConsent, 'Site search needs consent');
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export const ExcerptSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .refine((x) => x.end > x.start, 'Invalid excerpt range');
export const ResultSchema = z.object({
  id: z.string(),
  kind: z.enum(['passage', 'page', 'control', 'listing']),
  title: z.string(),
  url: z.string().optional(),
  origin: z.string(),
  quote: z.string(),
  excerpt: ExcerptSchema.optional(),
  headingPath: z.array(z.string()),
  observedAt: z.string(),
  evidence: z.enum(['direct', 'partial', 'candidate_only', 'none']),
  candidate: CandidateSchema,
  snapshotId: z.string(),
  documentId: z.string(),
  local: z.boolean(),
  provider: z.enum(['mock', 'jev', 'lexical_fallback']),
  model: z.string().optional(),
});
export type EvidenceResult = z.infer<typeof ResultSchema>;
export const CoverageSchema = z.object({
  candidatesObserved: z.number().optional(),
  candidatesAssessed: z.number().optional(),
  linksObserved: z.number().optional(),
  pagesChecked: z.number(),
  fetchAttempts: z.number().optional(),
  urlsDiscovered: z.number(),
  blocked: z.number(),
  cacheHits: z.number(),
  providerCalls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  elapsedMs: z.number(),
  scope: z.enum(['current_page', 'bounded_site_search', 'frontier_exhausted_within_scope']),
  limitations: z.array(z.string()),
  stopReason: z.string(),
  checkedPages: z
    .array(
      z.object({
        url: z.string().optional(),
        title: z.string(),
        outcome: z.enum([
          'checking',
          'verified',
          'no_evidence',
          'matched_links',
          'verification_failed',
          'fetch_failed',
          'blocked',
          'unsupported',
        ]),
      }),
    )
    .optional(),
  validationFailures: z.array(z.string()).optional(),
});
export const StateSchema = z.object({
  id: z.string(),
  lifecycle: z.enum(['running', 'waiting_for_user', 'completed', 'cancelled', 'failed']),
  evidence: z.enum(['direct', 'partial', 'candidate_only', 'none']),
  provider: z.enum(['mock', 'jev', 'lexical_fallback']),
  results: z.array(ResultSchema).max(3),
  coverage: CoverageSchema,
  message: z.string(),
  requestedSections: z.array(z.string()),
  revealSteps: z.number(),
});
export type SearchState = z.infer<typeof StateSchema>;
export const EventSchema = z.object({
  protocol: z.literal(PROTOCOL),
  id: z.number().int(),
  searchId: z.string(),
  type: z.enum([
    'started',
    'snapshot_checked',
    'page_discovered',
    'page_checked',
    'candidate_found',
    'result_updated',
    'needs_local_content',
    'needs_user',
    'limit_reached',
    'completed',
    'cancelled',
    'error',
  ]),
  state: StateSchema,
});
export type SearchEvent = z.infer<typeof EventSchema>;
export const LocalMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('INSPECT'), question: z.string().max(500).optional() }),
  z.object({
    type: z.literal('READ_SECTION'),
    snapshotId: z.string(),
    sectionIds: z.array(z.string()).max(4),
  }),
  z.object({
    type: z.literal('SHOW'),
    snapshotId: z.string(),
    candidateId: z.string(),
    excerpt: ExcerptSchema.optional(),
    documentId: z.string(),
  }),
  z.object({ type: z.literal('CLEAR') }),
  z.object({ type: z.literal('STOP') }),
]);
export type LocalMessage = z.infer<typeof LocalMessageSchema>;
export function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
