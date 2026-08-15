type Observation = {
  title: string | null;
  tvdbId: string;
  mediaType: 'movie' | 'tv';
  rawOverviewFieldPresent: boolean;
  rawOverviewPresent: boolean;
  rawOverviewLength: number;
  normalizedOverviewPresent: boolean;
  normalizedOverviewLength: number;
  normalizedOverviewPreview: string | null;
};

const { observeMovieDetailPayloads, observeTvdbOverview, summarizeOverviewCoverage } = jest.requireActual<{
  observeTvdbOverview(
    config: {
      baseUrl: string;
      apiKey: string;
      pin: string;
      imageBaseUrl: string;
    },
    mediaType: 'movie' | 'tv',
    row: Record<string, unknown>
  ): Observation | null;
  summarizeOverviewCoverage(
    observations: Observation[],
    mediaType: 'movie' | 'tv'
  ): {
    inspected: number;
    rawOverviewPresentCount: number;
    normalizedOverviewPresentCount: number;
    coveragePercent: number;
  };
  observeMovieDetailPayloads(
    config: {
      baseUrl: string;
      apiKey: string;
      pin: string;
      imageBaseUrl: string;
    },
    listing: Observation,
    detailEndpointsTried: string[],
    basePayload: unknown,
    extendedPayload: unknown,
    failure: 'authentication' | 'network_or_rate_limit' | 'provider' | null
  ): {
    detailEndpointUsed: string | null;
    rawOverviewPath: string | null;
    detailRawOverviewPresent: boolean;
    detailRawOverviewLength: number;
    normalizedDetailOverviewPresent: boolean;
    normalizedDetailOverviewLength: number;
    normalizedDetailOverviewPreview: string | null;
    failure: string | null;
  };
}>('../../supabase/functions/_shared/media/providers/tvdb');

const config = {
  baseUrl: 'https://tvdb.example.test/v4',
  apiKey: '',
  pin: '',
  imageBaseUrl: 'https://artworks.example.test',
};

describe('TVDB overview diagnostic observations', () => {
  test('reports usable provider text and the canonical overview that preserves it', () => {
    const overview = ` ${'A production overview. '.repeat(8)} `;

    const observation = observeTvdbOverview(config, 'movie', {
      id: 101,
      name: 'A Film',
      overview,
    });

    expect(observation).toMatchObject({
      title: 'A Film',
      tvdbId: '101',
      mediaType: 'movie',
      rawOverviewFieldPresent: true,
      rawOverviewPresent: true,
      rawOverviewLength: overview.trim().length,
      normalizedOverviewPresent: true,
      normalizedOverviewLength: overview.trim().length,
    });
    expect(observation?.normalizedOverviewPreview).toBe(overview.trim().slice(0, 100));
  });

  test.each([
    ['an omitted field', { id: 202, name: 'No Field' }, false],
    ['a blank field', { id: 203, name: 'Blank Field', overview: '   ' }, true],
  ])('distinguishes %s from usable provider overview text', (_label, row, fieldPresent) => {
    expect(observeTvdbOverview(config, 'tv', row)).toMatchObject({
      rawOverviewFieldPresent: fieldPresent,
      rawOverviewPresent: false,
      rawOverviewLength: 0,
      normalizedOverviewPresent: false,
      normalizedOverviewLength: 0,
      normalizedOverviewPreview: null,
    });
  });

  test('reports normalized overview coverage independently for each canonical media type', () => {
    const observations = [
      observeTvdbOverview(config, 'movie', { id: 301, overview: 'Movie overview' }),
      observeTvdbOverview(config, 'movie', { id: 302 }),
      observeTvdbOverview(config, 'tv', { id: 401, overview: 'TV overview one' }),
      observeTvdbOverview(config, 'tv', { id: 402, overview: 'TV overview two' }),
    ].filter((item): item is Observation => item !== null);

    expect(summarizeOverviewCoverage(observations, 'movie')).toEqual({
      inspected: 2,
      rawOverviewPresentCount: 1,
      normalizedOverviewPresentCount: 1,
      coveragePercent: 50,
    });
    expect(summarizeOverviewCoverage(observations, 'tv')).toEqual({
      inspected: 2,
      rawOverviewPresentCount: 2,
      normalizedOverviewPresentCount: 2,
      coveragePercent: 100,
    });
  });

  test('finds an English extended-detail translation and preserves it through TVDB normalization', () => {
    const listing = observeTvdbOverview(config, 'movie', { id: 501, name: 'Detail Film' });
    expect(listing).not.toBeNull();

    const result = observeMovieDetailPayloads(
      config,
      listing!,
      ['/movies/{id}', '/movies/{id}/extended?meta=translations&short=true'],
      { data: { id: 501, name: 'Detail Film' } },
      {
        data: {
          id: 501,
          name: 'Detail Film',
          translations: {
            overviewTranslations: [
              { language: 'spa', overview: 'Resumen.' },
              { language: 'eng', overview: '  Detail overview preserved.  ' },
            ],
          },
        },
      },
      null
    );

    expect(result).toMatchObject({
      detailEndpointUsed: '/movies/{id}/extended?meta=translations&short=true',
      rawOverviewPath: 'data.translations.overviewTranslations[1].overview',
      detailRawOverviewPresent: true,
      detailRawOverviewLength: 'Detail overview preserved.'.length,
      normalizedDetailOverviewPresent: true,
      normalizedDetailOverviewLength: 'Detail overview preserved.'.length,
      normalizedDetailOverviewPreview: 'Detail overview preserved.',
      failure: null,
    });
  });

  test('keeps listing and detail overview absence distinct from normalization loss', () => {
    const listing = observeTvdbOverview(config, 'movie', { id: 502, name: 'Sparse Film' });
    expect(listing).not.toBeNull();

    expect(
      observeMovieDetailPayloads(
        config,
        listing!,
        ['/movies/{id}', '/movies/{id}/extended?meta=translations&short=true'],
        { data: { id: 502, name: 'Sparse Film' } },
        { data: { id: 502, name: 'Sparse Film', translations: { overviewTranslations: [] } } },
        null
      )
    ).toMatchObject({
      detailEndpointUsed: null,
      rawOverviewPath: null,
      detailRawOverviewPresent: false,
      normalizedDetailOverviewPresent: false,
      failure: null,
    });
  });

  test('falls back to the first usable translation when English is unavailable', () => {
    const listing = observeTvdbOverview(config, 'movie', { id: 503, name: 'Fallback Film' });
    expect(listing).not.toBeNull();

    expect(
      observeMovieDetailPayloads(
        config,
        listing!,
        ['/movies/{id}/extended?meta=translations&short=true'],
        null,
        {
          data: {
            id: 503,
            name: 'Fallback Film',
            translations: {
              overviewTranslations: [
                { language: 'eng', overview: '   ' },
                { language: 'deu', overview: '' },
                { language: 'ita', overview: 'Panoramica disponibile.' },
              ],
            },
          },
        },
        null
      )
    ).toMatchObject({
      rawOverviewPath: 'data.translations.overviewTranslations[2].overview',
      detailRawOverviewPresent: true,
      normalizedDetailOverviewPresent: true,
      normalizedDetailOverviewPreview: 'Panoramica disponibile.',
    });
  });
});
