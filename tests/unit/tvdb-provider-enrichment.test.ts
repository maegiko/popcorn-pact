type MediaRecord = {
  mediaType: 'movie' | 'tv';
  title: string | null;
  overview: string | null;
  externalIds: Record<string, string>;
};

type TvdbProvider = {
  discover(request: {
    mediaTypes: readonly ('movie' | 'tv')[];
    services: null;
    limit: number;
  }): Promise<MediaRecord[]>;
};

const { createTvdbProvider } = jest.requireActual<{
  createTvdbProvider(config: {
    baseUrl: string;
    apiKey: string;
    pin: string;
    imageBaseUrl: string;
  }): TvdbProvider;
}>('../../supabase/functions/_shared/media/providers/tvdb');

const originalFetch = globalThis.fetch;
let nextBaseUrl = 1;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('TVDB production movie overview enrichment contract', () => {
  test('enriches only movies missing overview while preserving movies and TV that already have one', async () => {
    const calls: string[] = [];
    const provider = providerWithRoutes(calls, {
      '/movies?page=0': {
        data: [
          { id: 101, name: 'Needs Detail' },
          { id: 102, name: 'Already Complete', overview: 'Listing movie overview.' },
        ],
      },
      '/series?page=0': {
        data: [{ id: 201, name: 'Series Complete', overview: 'Listing series overview.' }],
      },
      '/movies/101/extended?meta=translations&short=true': {
        data: {
          id: 101,
          name: 'Needs Detail',
          translations: {
            overviewTranslations: [
              { language: 'spa', overview: 'Resumen de pelicula.' },
              { language: 'eng', overview: 'Enriched movie overview.' },
            ],
          },
        },
      },
    });

    const records = await provider.discover({
      mediaTypes: ['movie', 'tv'],
      services: null,
      limit: 3,
    });

    expect(records.map(({ mediaType, title, overview, externalIds }) => ({
      mediaType,
      title,
      overview,
      externalIds,
    }))).toEqual([
      {
        mediaType: 'movie',
        title: 'Needs Detail',
        overview: 'Enriched movie overview.',
        externalIds: { tvdb: '101' },
      },
      {
        mediaType: 'movie',
        title: 'Already Complete',
        overview: 'Listing movie overview.',
        externalIds: { tvdb: '102' },
      },
      {
        mediaType: 'tv',
        title: 'Series Complete',
        overview: 'Listing series overview.',
        externalIds: { tvdb: '201' },
      },
    ]);
    expect(calls).toContain('/movies/101/extended?meta=translations&short=true');
    expect(calls).not.toContain('/movies/102/extended?meta=translations&short=true');
    expect(calls.some((path) => path.startsWith('/series/201'))).toBe(false);
  });

  test('keeps detail failures and empty translations non-fatal without fabricating overview text', async () => {
    const calls: string[] = [];
    const provider = providerWithRoutes(
      calls,
      {
        '/movies?page=0': {
          data: [
            { id: 301, name: 'Detail Fails' },
            { id: 302, name: 'Detail Empty' },
          ],
        },
        '/movies/302/extended?meta=translations&short=true': {
          data: {
            id: 302,
            name: 'Detail Empty',
            translations: {
              overviewTranslations: [
                { language: 'eng', overview: '   ' },
                { language: 'fra', overview: '' },
              ],
            },
          },
        },
      },
      new Set(['/movies/301/extended?meta=translations&short=true'])
    );

    await expect(
      provider.discover({ mediaTypes: ['movie'], services: null, limit: 2 })
    ).resolves.toEqual([
      expect.objectContaining({ title: 'Detail Fails', overview: null }),
      expect.objectContaining({ title: 'Detail Empty', overview: null }),
    ]);
    expect(calls).toEqual(expect.arrayContaining([
      '/movies/301/extended?meta=translations&short=true',
      '/movies/302/extended?meta=translations&short=true',
    ]));
  });

  test('bounds detail requests to movie records admitted by the adapter limit', async () => {
    const calls: string[] = [];
    const provider = providerWithRoutes(calls, {
      '/movies?page=0': {
        data: [
          { id: 401, name: 'Selected One' },
          { id: 402, name: 'Selected Two' },
          { id: 403, name: 'Outside Limit' },
        ],
      },
      '/movies/401/extended?meta=translations&short=true': detailWithOverview(
        401,
        'Selected One'
      ),
      '/movies/402/extended?meta=translations&short=true': detailWithOverview(
        402,
        'Selected Two'
      ),
    });

    const records = await provider.discover({
      mediaTypes: ['movie'],
      services: null,
      limit: 2,
    });

    expect(records.map((record) => record.externalIds.tvdb)).toEqual(['401', '402']);
    expect(calls).toContain('/movies/401/extended?meta=translations&short=true');
    expect(calls).toContain('/movies/402/extended?meta=translations&short=true');
    expect(calls).not.toContain('/movies/403/extended?meta=translations&short=true');
  });
});

function providerWithRoutes(
  calls: string[],
  routes: Record<string, unknown>,
  failures = new Set<string>()
): TvdbProvider {
  const baseUrl = `https://tvdb-${nextBaseUrl++}.example.test/v4`;

  globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = `${url.pathname.replace('/v4', '')}${url.search}`;
    calls.push(path);

    if (path === '/login') return response({ data: { token: 'test-token' } });
    if (failures.has(path)) return response({ error: 'detail unavailable' }, 503);
    if (path in routes) return response(routes[path]);
    return response({ error: `unexpected request ${path}` }, 404);
  }) as typeof fetch;

  return createTvdbProvider({
    baseUrl,
    apiKey: 'test-key',
    pin: '',
    imageBaseUrl: 'https://artworks.example.test',
  });
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function detailWithOverview(id: number, name: string) {
  return {
    data: {
      id,
      name,
      translations: {
        overviewTranslations: [{ language: 'eng', overview: `${name} overview.` }],
      },
    },
  };
}
