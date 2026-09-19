import { describe, expect, it } from 'vitest';
import {
  type ProviderBudget,
  GatewayJevProvider,
  providerFromEnv,
  providerFailureReason,
} from '../../packages/jev/src';
import { extractHtml } from '../../packages/extraction/src/html';

const candidates = extractHtml(
  '<p>The couple named their baby daughter Juniper.</p><p>Morgan is a musician.</p>',
  'https://site.test',
).candidates;
const budget = (): ProviderBudget => ({ calls: 0, bytes: 0, inputTokens: 0, outputTokens: 0 });
const choice = { type: 'choice', choice: 'c0', probabilities: { c0: 0.9, c1: 0.05, none: 0.05 } };
const reply = (answers: unknown) =>
  Response.json({
    answers,
    usage: { inputTokens: 40, outputTokens: 2 },
    providerMetadata: { typesafe: { confidence: { selection: 0.9 } } },
  });

describe('Jev through Vercel AI Gateway', () => {
  it('uses the actual SDK evaluation endpoint and separately verifies the selected excerpt', async () => {
    const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
    const transport = (async (url, init) => {
      requests.push({ url: String(url), init: init!, body: JSON.parse(String(init?.body)) });
      return reply(
        requests.length === 1
          ? { selection: choice }
          : {
              supported: {
                type: 'choice',
                choice: 'relevant',
                probabilities: { relevant: 0.94, irrelevant: 0.06 },
              },
            },
      );
    }) as typeof fetch;
    const b = budget();
    const decision = await new GatewayJevProvider('test-gateway-key', undefined, transport).select(
      'What is the baby name?',
      candidates,
      new AbortController().signal,
      b,
    );
    expect(decision).toMatchObject({ mode: 'jev', model: 'typesafe-ai/jev', support: 0.94 });
    expect(decision.candidate).toEqual(candidates[0]);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe('https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
      const headers = new Headers(request.init.headers);
      expect(headers.get('authorization')).toBe('Bearer test-gateway-key');
      expect(headers.get('ai-model-id')).toBe('typesafe-ai/jev');
      expect(request.body.providerOptions).toEqual({});
      expect(request.init.redirect).toBe('error');
    }
    expect(requests[0].body.questions).toMatchObject({ selection: { type: 'choice' } });
    expect(requests[1].body.questions).toMatchObject({ supported: { type: 'choice' } });
    expect(JSON.stringify(requests[1].body)).not.toContain('Morgan');
    expect(b).toMatchObject({ calls: 2, inputTokens: 80, outputTokens: 4 });
    expect(b.bytes).toBe(requests.reduce((n, r) => n + Buffer.byteLength(String(r.init.body)), 0));
  });
  it('honors explicit zero data retention without retrying a policy rejection', async () => {
    let calls = 0;
    const provider = new GatewayJevProvider(
      'test',
      undefined,
      (async (_url, init) => {
        calls++;
        expect(JSON.parse(String(init?.body)).providerOptions).toEqual({
          gateway: { zeroDataRetention: true },
        });
        return Response.json({ error: 'plan does not support policy' }, { status: 403 });
      }) as typeof fetch,
      true,
    );
    await expect(
      provider.select('baby name', candidates, new AbortController().signal, budget()),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it.each([
    { ...choice, choice: 'invented' },
    { ...choice, probabilities: { c0: 0.1, c1: 0.1, none: 0.1 } },
    { ...choice, probabilities: { c0: 1, none: 0 } },
    { ...choice, probabilities: undefined },
  ])('rejects ungrounded or malformed choices', async (selection) => {
    const b = budget();
    await expect(
      new GatewayJevProvider('test', undefined, (async () =>
        reply({ selection })) as typeof fetch).select(
        'baby name',
        candidates,
        new AbortController().signal,
        b,
      ),
    ).rejects.toThrow();
    expect(b.calls).toBe(2);
    expect(b.validationFailures).toHaveLength(2);
  });
  it('rejects invalid support probabilities', async () => {
    let calls = 0;
    const transport = (async () =>
      reply(
        ++calls === 1
          ? { selection: choice }
          : {
              supported: {
                type: 'choice',
                choice: 'relevant',
                probabilities: { relevant: 1.1, irrelevant: -0.1 },
              },
            },
      )) as typeof fetch;
    await expect(
      new GatewayJevProvider('test', undefined, transport).select(
        'baby name',
        candidates,
        new AbortController().signal,
        budget(),
      ),
    ).rejects.toThrow();
  });
  it('does not validate an abstention or treat a route as verified evidence', async () => {
    const b = budget();
    const provider = new GatewayJevProvider('test', undefined, (async () =>
      reply({ selection: choice })) as typeof fetch);
    const route = await provider.select(
      'baby name',
      candidates,
      new AbortController().signal,
      b,
      'route',
    );
    expect(route.support).toBe(0.6);
    expect(b.calls).toBe(1);
    const none = new GatewayJevProvider('test', undefined, (async () =>
      reply({
        selection: {
          type: 'choice',
          choice: 'none',
          probabilities: { c0: 0, c1: 0, none: 1 },
        },
      })) as typeof fetch);
    expect(
      (await none.select('baby name', candidates, new AbortController().signal, b)).candidate,
    ).toBeUndefined();
    expect(b.calls).toBe(2);
  });
  it('counts a transient retry and refuses a third attempt', async () => {
    const b = budget();
    const provider = new GatewayJevProvider('test', undefined, (async () =>
      Response.json(
        { error: 'busy' },
        { status: 503, headers: { 'retry-after': '0' } },
      )) as typeof fetch);
    await expect(
      provider.select('baby name', candidates, new AbortController().signal, b),
    ).rejects.toThrow();
    expect(b.calls).toBe(2);
  });
  it('enforces remaining call budget across retries', async () => {
    const b = { ...budget(), calls: 17 };
    let sent = 0;
    const provider = new GatewayJevProvider('test', undefined, (async () => {
      sent++;
      return Response.json({}, { status: 429, headers: { 'retry-after': '0' } });
    }) as typeof fetch);
    await expect(
      provider.select('baby name', candidates, new AbortController().signal, b),
    ).rejects.toThrow();
    expect(sent).toBe(1);
    expect(b.calls).toBe(18);
  });
  it('does not retry authentication failures or send cancelled searches', async () => {
    let sent = 0;
    const provider = new GatewayJevProvider('test', undefined, (async () => {
      sent++;
      return Response.json({}, { status: 401 });
    }) as typeof fetch);
    await expect(
      provider.select('baby name', candidates, new AbortController().signal, budget()),
    ).rejects.toThrow();
    await expect(
      provider.select('baby name', candidates, AbortSignal.abort(), budget()),
    ).rejects.toThrow();
    expect(sent).toBe(1);
  });
  it('bounds responses before SDK parsing', async () => {
    const provider = new GatewayJevProvider(
      'test',
      undefined,
      (async () => new Response('x'.repeat(200001))) as typeof fetch,
    );
    await expect(
      provider.select('baby name', candidates, new AbortController().signal, budget()),
    ).rejects.toThrow();
  });
});

describe('provider configuration', () => {
  it('defaults to Gateway, supports OIDC, and honors explicit mock mode', () => {
    expect(providerFromEnv({}).mode).toBe('mock');
    expect(providerFromEnv({ TYPESAFE_API_KEY: 'test' }).transport).toBe('typesafe');
    expect(
      providerFromEnv({ TYPESAFE_API_KEY: 'test', VERCEL_AI_GATEWAY_KEY: 'old-key' }).transport,
    ).toBe('typesafe');
    expect(providerFromEnv({ AI_GATEWAY_API_KEY: 'test' }).transport).toBe('gateway');
    expect(providerFromEnv({ VERCEL_AI_GATEWAY_KEY: 'test' }).transport).toBe('gateway');
    expect(providerFromEnv({ VERCEL_OIDC_TOKEN: 'test' }).transport).toBe('gateway');
    expect(providerFromEnv({ AI_GATEWAY_API_KEY: 'test', PROVIDER_MODE: 'mock' }).mode).toBe(
      'mock',
    );
    expect(providerFromEnv({ JEV_TRANSPORT: 'typesafe', TYPESAFE_API_KEY: 'test' }).transport).toBe(
      'typesafe',
    );
  });
  it('fails explicit live mode without the matching credential', () => {
    expect(() =>
      providerFromEnv({
        JEV_TRANSPORT: 'gateway',
        PROVIDER_MODE: 'live',
        TYPESAFE_API_KEY: 'test',
      }),
    ).toThrow('AI_GATEWAY_API_KEY');
    expect(() =>
      providerFromEnv({
        JEV_TRANSPORT: 'typesafe',
        PROVIDER_MODE: 'live',
        AI_GATEWAY_API_KEY: 'test',
      }),
    ).toThrow('TYPESAFE_API_KEY');
    expect(() => new GatewayJevProvider('test', 'some/chat-model')).toThrow(
      'unsupported_gateway_jev_model',
    );
  });
});

it.each([
  [new Error('provider_budget'), 'provider_budget_exhausted'],
  [new DOMException('timed out', 'TimeoutError'), 'provider_timeout'],
  [new Error('invalid_provider_selection'), 'provider_invalid_response'],
  [new Error('provider_http_401'), 'provider_auth_failed'],
  [new Error('provider_payload_budget'), 'provider_payload_limit'],
  [new Error('provider_http_429'), 'provider_rate_limited'],
])('classifies verification failures without exposing error bodies', (error, reason) => {
  expect(providerFailureReason(error)).toBe(reason);
});
it('validates destination relevance with a separate verification call', async () => {
  const requests: { questions: Record<string, unknown> }[] = [];
  const provider = new GatewayJevProvider('test', undefined, (async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    requests.push(body);
    return reply(
      body.questions.selection
        ? { selection: choice }
        : {
            supported: {
              type: 'choice',
              choice: 'relevant',
              probabilities: { relevant: 0.94, irrelevant: 0.06 },
            },
          },
    );
  }) as typeof fetch);
  const decision = await provider.select(
    'Find the baby announcement',
    candidates,
    new AbortController().signal,
    budget(),
    'destination',
  );
  expect(decision.support).toBe(0.94);
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1].questions)).toContain('directly covers');
});

it('passes the original page context to selection and independent verification', async () => {
  const requests: { state: string; questions: Record<string, unknown> }[] = [];
  const provider = new GatewayJevProvider('test', undefined, (async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    requests.push(body);
    return reply(
      body.questions.selection
        ? { selection: choice }
        : {
            supported: {
              type: 'choice',
              choice: 'relevant',
              probabilities: { relevant: 0.7, irrelevant: 0.3 },
            },
          },
    );
  }) as typeof fetch);
  const context = { sourceTitle: 'A person biography', sourceUrl: 'https://site.test/biography' };
  const decision = await provider.select(
    'company partnership',
    candidates,
    new AbortController().signal,
    budget(),
    'destination',
    context,
  );
  expect(decision.verified).toBe(true);
  for (const request of requests) expect(JSON.parse(request.state).original_page).toEqual(context);
});

it('retries a malformed choice once and still independently verifies the recovered selection', async () => {
  let calls = 0;
  const b = budget();
  const provider = new GatewayJevProvider('test', undefined, (async () => {
    calls++;
    return reply(
      calls === 1
        ? { selection: { ...choice, choice: 'invented' } }
        : calls === 2
          ? { selection: choice }
          : {
              supported: {
                type: 'choice',
                choice: 'relevant',
                probabilities: { relevant: 0.9, irrelevant: 0.1 },
              },
            },
    );
  }) as typeof fetch);
  const decision = await provider.select('baby name', candidates, new AbortController().signal, b);
  expect(decision.verified).toBe(true);
  expect(calls).toBe(3);
  expect(b.validationFailures).toEqual(['selection:response_schema']);
});
