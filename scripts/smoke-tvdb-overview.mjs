#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

import { createClient } from '@supabase/supabase-js';

const PUBLIC_ENV_NAMES = [
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_KEY',
];

async function main() {
  if (process.argv.length > 2) {
    fail(6, 'unexpected adapter/runtime error', 'This smoke command accepts no arguments.');
  }

  const publicEnv = loadPublicEnv();
  const supabaseUrl = publicEnv.EXPO_PUBLIC_SUPABASE_URL;
  const publishableKey = publicEnv.EXPO_PUBLIC_SUPABASE_KEY;
  const credentials = await promptForCredentials();

  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const signedIn = await supabase.auth.signInWithPassword(credentials);
  if (signedIn.error || !signedIn.data.session || !signedIn.data.user) {
    fail(
      1,
      'hosted Supabase invocation/auth failure',
      signedIn.error?.message ?? 'Supabase returned no authenticated session.'
    );
  }

  const group = await supabase
    .from('group_access')
    .select('group_id, created_by, state')
    .eq('created_by', signedIn.data.user.id)
    .eq('state', 'active')
    .limit(1)
    .maybeSingle();

  if (group.error) {
    fail(1, 'hosted Supabase invocation/auth failure', group.error.message);
  }
  if (!group.data) {
    fail(
      1,
      'hosted Supabase invocation/auth failure',
      'The signed-in user must own an active Popcorn Pact group.'
    );
  }

  let response;
  try {
    response = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/functions/v1/generate-pool`, {
      method: 'POST',
      headers: {
        apikey: publishableKey,
        authorization: `Bearer ${signedIn.data.session.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        groupId: group.data.group_id,
        diagnostic: 'tvdb-overview',
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    fail(
      1,
      'hosted Supabase invocation/auth failure',
      cause instanceof Error ? cause.message : String(cause)
    );
  }

  let result;
  try {
    result = await response.json();
  } catch {
    fail(
      1,
      'hosted Supabase invocation/auth failure',
      `Hosted function returned HTTP ${response.status} with a non-JSON body.`
    );
  }

  if (!result || typeof result.status !== 'string') {
    fail(6, 'unexpected adapter/runtime error', 'Hosted function returned an invalid response.');
  }

  switch (result.status) {
    case 'tvdb_overview_ok':
      printSuccess(result.diagnostic);
      return;
    case 'tvdb_authentication_failure':
    case 'tvdb_provider_failure':
      if (result.diagnostic) printDiagnostic(result.diagnostic);
      fail(2, 'TVDB authentication/provider failure', result.status);
      break;
    case 'tvdb_network_or_rate_limit_failure':
      if (result.diagnostic) printDiagnostic(result.diagnostic);
      fail(3, 'network/rate-limit failure', result.status);
      break;
    case 'tvdb_no_overview':
      printDiagnostic(result.diagnostic);
      fail(4, 'sampled TVDB records contained no overview', result.status);
      break;
    case 'tvdb_normalization_failure':
      printDiagnostic(result.diagnostic);
      fail(5, 'raw TVDB overview existed but normalization lost it', result.status);
      break;
    case 'unauthenticated':
    case 'not_a_member':
    case 'group_in_grace':
    case 'diagnostic_forbidden':
      fail(1, 'hosted Supabase invocation/auth failure', result.status);
      break;
    default:
      fail(
        response.ok ? 6 : 1,
        response.ok
          ? 'unexpected adapter/runtime error'
          : 'hosted Supabase invocation/auth failure',
        `${result.status} (HTTP ${response.status})`
      );
  }
}

function loadPublicEnv() {
  let fileValues = {};
  try {
    fileValues = parseEnvFile(readFileSync(new URL('../.env.local', import.meta.url), 'utf8'));
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw cause;
  }

  return Object.fromEntries(
    PUBLIC_ENV_NAMES.map((name) => {
      const value = process.env[name]?.trim() || fileValues[name]?.trim();
      if (!value) {
        fail(
          1,
          'hosted Supabase invocation/auth failure',
          `${name} is missing from the normal public app configuration.`
        );
      }
      return [name, value];
    })
  );
}

function parseEnvFile(contents) {
  const values = {};

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || !PUBLIC_ENV_NAMES.includes(match[1])) continue;

    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }

  return values;
}

async function promptForCredentials() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(
      1,
      'hosted Supabase invocation/auth failure',
      'Run this command in an interactive terminal to sign in with a normal app account.'
    );
  }

  const output = new MutedOutput();
  const prompt = createInterface({ input: process.stdin, output, terminal: true });

  try {
    const email = (await prompt.question('Popcorn Pact email: ')).trim();
    process.stdout.write('Popcorn Pact password: ');
    output.muted = true;
    const password = await prompt.question('');
    output.muted = false;
    process.stdout.write('\n');

    if (!email || !password) {
      fail(1, 'hosted Supabase invocation/auth failure', 'Email and password are required.');
    }
    return { email, password };
  } finally {
    output.muted = false;
    prompt.close();
  }
}

class MutedOutput extends Writable {
  muted = false;

  _write(chunk, encoding, callback) {
    if (!this.muted) process.stdout.write(chunk, encoding);
    callback();
  }
}

function printSuccess(diagnostic) {
  console.log('PASS: hosted TVDB returned usable overview text and normalization preserved it.');
  printDiagnostic(diagnostic);
}

function printDiagnostic(diagnostic) {
  if (!diagnostic || !Array.isArray(diagnostic.samples)) {
    fail(6, 'unexpected adapter/runtime error', 'Hosted function omitted diagnostic observations.');
  }

  console.log(
    `Path: ${diagnostic.source.loginEndpoint} -> ${diagnostic.source.collectionEndpoints.join(', ')}`
  );
  console.log(`Detail lookup performed: ${diagnostic.source.detailLookupPerformed ? 'yes' : 'no'}`);
  console.log(
    `Production pool detail lookup performed: ${diagnostic.source.productionDetailLookupPerformed ? 'yes' : 'no'}`
  );
  console.log(`Detail endpoints: ${diagnostic.source.detailEndpoints.join(', ')}`);
  console.log(`Raw field mapped to MediaRecord.overview: ${diagnostic.source.rawOverviewField}`);
  console.log(`Records inspected: ${diagnostic.recordsInspected}`);
  console.log(`Raw overviews present: ${diagnostic.rawOverviewPresentCount}`);
  console.log(`Normalized overviews present: ${diagnostic.normalizedOverviewPresentCount}`);
  console.log(`Overviews dropped by normalization: ${diagnostic.normalizationDroppedCount}`);
  printCoverage('Movies', 'Movie', diagnostic.coverageByMediaType?.movie);
  printCoverage('TV', 'TV', diagnostic.coverageByMediaType?.tv);
  printMovieDetails(diagnostic.movieDetails);

  console.table(
    diagnostic.samples.map((sample) => ({
      title: sample.title,
      tvdbId: sample.tvdbId,
      mediaType: sample.mediaType,
      rawFieldPresent: sample.rawOverviewFieldPresent,
      rawPresent: sample.rawOverviewPresent,
      rawLength: sample.rawOverviewLength,
      normalizedPresent: sample.normalizedOverviewPresent,
      normalizedLength: sample.normalizedOverviewLength,
      preview: sample.normalizedOverviewPreview?.replace(/\s+/g, ' ') ?? null,
    }))
  );
}

function printMovieDetails(details) {
  if (!details || !Array.isArray(details.samples)) {
    fail(6, 'unexpected adapter/runtime error', 'Hosted function omitted movie detail results.');
  }

  console.log(`Movies detail-sampled: ${details.sampled}`);
  console.log(`Detail responses with raw overview: ${details.rawOverviewPresentCount}`);
  console.log(`Normalized detail overviews: ${details.normalizedOverviewPresentCount}`);
  console.log(`Detail overviews dropped by normalization: ${details.normalizationDroppedCount}`);
  console.log(`Detail request failures: ${details.requestFailureCount}`);
  console.log(
    `Detail coverage: ${details.rawOverviewPresentCount}/${details.sampled} (${Number(details.coveragePercent).toFixed(1)}%)`
  );

  console.table(
    details.samples.map((sample) => ({
      title: sample.title,
      tvdbId: sample.tvdbId,
      listingOverview: sample.listingOverviewPresent,
      endpointsTried: sample.detailEndpointsTried.join(' -> '),
      detailSuccess: sample.detailRequestSuccess,
      endpointUsed: sample.detailEndpointUsed,
      rawPath: sample.rawOverviewPath,
      detailRawOverview: sample.detailRawOverviewPresent,
      detailRawLength: sample.detailRawOverviewLength,
      normalizedOverview: sample.normalizedDetailOverviewPresent,
      normalizedLength: sample.normalizedDetailOverviewLength,
      preview: sample.normalizedDetailOverviewPreview?.replace(/\s+/g, ' ') ?? null,
      failure: sample.failure,
    }))
  );

  if (details.requestFailureCount > 0) {
    console.log('Conclusion: one or more movie detail requests failed; no data conclusion is safe.');
  } else if (details.normalizationDroppedCount > 0) {
    console.log('Conclusion: TVDB movie detail supplied overview text that normalization dropped.');
  } else if (details.rawOverviewPresentCount > 0) {
    console.log(
      'Conclusion: TVDB /movies listings omit overview, but movie detail responses supply it and our normalization preserves it.'
    );
  } else {
    console.log(
      'Conclusion: TVDB movie listing and detail responses both omit overview for the sampled movies.'
    );
  }
}

function printCoverage(countLabel, coverageLabel, coverage) {
  if (!coverage) {
    fail(6, 'unexpected adapter/runtime error', `Hosted function omitted ${countLabel} coverage.`);
  }

  console.log(`${countLabel} inspected: ${coverage.inspected}`);
  console.log(`${countLabel} with raw overview: ${coverage.rawOverviewPresentCount}`);
  console.log(`${countLabel} with normalized overview: ${coverage.normalizedOverviewPresentCount}`);
  console.log(`${coverageLabel} coverage: ${Number(coverage.coveragePercent).toFixed(1)}%`);
}

function fail(classification, label, detail) {
  throw new Error(`FAIL [${classification}] ${label}: ${detail}`);
}

main().catch((cause) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(message);
  process.exitCode = 1;
});
