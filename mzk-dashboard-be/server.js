'use strict';

const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');

const CONFIG = {
  port: Number(process.env.PORT || 3000),
  baseUrl: process.env.ISARSOFT_BASE_URL || 'https://localhost:8443',
  graphqlPath: process.env.ISARSOFT_GRAPHQL_PATH || '/isarsoft/api/graphql',
  tokenPath:
    process.env.ISARSOFT_TOKEN_PATH ||
    '/isarsoft/auth/realms/perception/protocol/openid-connect/token',
  clientId: process.env.ISARSOFT_CLIENT_ID || 'perception',
  username: process.env.ISARSOFT_USERNAME || 'perception',
  password: process.env.ISARSOFT_PASSWORD || 'perception',
  verifyTls: process.env.ISARSOFT_VERIFY_TLS === 'true',
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 30000),
  defaultPreset: process.env.ISARSOFT_PRESET || 'THISYEAR',
  defaultClasses: (process.env.ISARSOFT_CLASSES || 'PERSON,HEAD')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean),
  healthPreset: process.env.ISARSOFT_HEALTH_PRESET || 'LAST1DAY',
};

const httpsAgent = new https.Agent({
  rejectUnauthorized: CONFIG.verifyTls,
});

let tokenCache = { token: null, expiresAt: 0 };

function nowIso() {
  return new Date().toISOString();
}

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

function lower(v) {
  return String(v || '').toLowerCase();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sumBy(arr, fn) {
  return toArray(arr).reduce((acc, item) => acc + num(fn(item)), 0);
}

function avg(arr) {
  const vals = toArray(arr).map(num).filter(Number.isFinite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function requestRaw(urlString, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: options.method || 'GET',
        headers: options.headers || {},
        agent: url.protocol === 'https:' ? httpsAgent : undefined,
        timeout: CONFIG.requestTimeoutMs,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage,
            text: raw,
            json: () => safeJson(raw),
          });
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error(`Timeout after ${CONFIG.requestTimeoutMs}ms`)));
    req.on('error', reject);

    if (body) req.write(body);
    req.end();
  });
}

async function getToken(force = false) {
  if (!force && tokenCache.token && Date.now() < tokenCache.expiresAt - 15000) {
    return tokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: CONFIG.clientId,
    username: CONFIG.username,
    password: CONFIG.password,
  }).toString();

  const res = await requestRaw(
    `${CONFIG.baseUrl}${CONFIG.tokenPath}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    body
  );

  const json = res.json();
  if (!res.ok || !json?.access_token) {
    throw new Error(`Token request failed: ${res.status} ${res.statusText} ${res.text}`);
  }

  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 300) * 1000,
  };

  return tokenCache.token;
}

async function graphql(query, variables = null, retry = true) {
  const token = await getToken(false);
  const payload = JSON.stringify({ query, variables });

  const res = await requestRaw(
    `${CONFIG.baseUrl}${CONFIG.graphqlPath}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    },
    payload
  );

  const json = res.json();

  if (res.status === 401 && retry) {
    await getToken(true);
    return graphql(query, variables, false);
  }

  if (!res.ok) {
    throw new Error(`GraphQL HTTP error: ${res.status} ${res.statusText} ${res.text}`);
  }

  if (!json) {
    throw new Error(`GraphQL returned invalid JSON: ${res.text}`);
  }

  if (json.errors) {
    return { data: json.data || null, errors: json.errors };
  }

  return { data: json.data || null, errors: null };
}

const QUERY_SCHEMA = `
query {
  __schema {
    types {
      name
      kind
      enumValues { name }
    }
  }
}
`;

const QUERY_CAMERAS = `
query {
  allCameras {
    uuid
    name
  }
}
`;

const QUERY_OBJECTFLOW_APPS = `
query {
  allApplications {
    __typename
    ... on ObjectFlow {
      uuid
      name
      tags
      created_at
      updated_at
      status
      last_online
      camera { uuid name }
      model { uuid name }
      lines {
        uuid
        name
        tags
        coordinates
        created_at
        updated_at
      }
      areas {
        uuid
        name
        tags
        coordinates
        created_at
        updated_at
      }
    }
  }
}
`;

const QUERY_LINE_COUNTS = `
query($app: ID!, $range: TimeRangeInput!, $classes: [ObjectClassInput!]) {
  getApplication(application: { uuid: $app }) {
    __typename
    ... on ObjectFlow {
      uuid
      name
      lines {
        uuid
        name
        count_data(time_range: $range, object_classes: $classes) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }
        count_live(object_classes: $classes) {
          count_in
          count_out
        }
      }
    }
  }
}
`;

const QUERY_SYSTEM_HEALTH = `
query($healthRange: TimeRangeInput!) {
  getSystemHealth {
    perception_camera_count
    perception_camera_online_count
    perception_camera_offline_count
    perception_app_count
    perception_app_online_count
    perception_app_offline_count
    perception_camera_counts_history(time_range: $healthRange) { points { timestamp value } }
    perception_app_counts_history(time_range: $healthRange) { points { timestamp value } }
  }
}
`;

const QUERY_FEATURE_FLAGS = `
query($featureflags: [FeatureFlags!]!) {
  getFeatureFlags(featureflags: $featureflags)
}
`;

function getEnumValues(schema, typeName) {
  const type = toArray(schema?.types).find((x) => x.name === typeName);
  return toArray(type?.enumValues).map((x) => x.name).filter(Boolean);
}

function normalizePreset(input, allowed) {
  const fallback = CONFIG.defaultPreset;
  if (!input) return allowed.includes(fallback) ? fallback : allowed[0];

  const raw = String(input).trim().toUpperCase();
  if (allowed.includes(raw)) return raw;

  const collapsed = raw.replace(/[_\s-]/g, '');
  const found = allowed.find((x) => x.replace(/[_\s-]/g, '') === collapsed);
  return found || (allowed.includes(fallback) ? fallback : allowed[0]);
}

function parseClasses(input) {
  const raw = (input || CONFIG.defaultClasses.join(','))
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);

  return raw.length ? raw : CONFIG.defaultClasses;
}

function classesToInputs(classes) {
  return toArray(classes).map((name) => ({ name }));
}

function featureFlagNamesFromSchema(schema) {
  return getEnumValues(schema, 'FeatureFlags');
}

function summarizeLineBuckets(rows) {
  const raw = toArray(rows);
  return {
    buckets: raw.length,
    first_bucket: raw[0]?.time_bucket || null,
    last_bucket: raw[raw.length - 1]?.time_bucket || null,
    samples: sumBy(raw, (x) => x?.number_of_samples),
    total_in: sumBy(raw, (x) => x?.count_in),
    total_out: sumBy(raw, (x) => x?.count_out),
    raw,
  };
}

function summarizeLineLive(rows) {
  const raw = toArray(rows);
  return {
    total_in: sumBy(raw, (x) => x?.count_in),
    total_out: sumBy(raw, (x) => x?.count_out),
    raw,
  };
}

function filterObjectFlowApps(apps, filters) {
  let result = toArray(apps);

  if (filters.app) {
    result = result.filter((a) => lower(a.name).includes(lower(filters.app)));
  }

  if (filters.camera) {
    result = result.filter((a) => lower(a.camera?.name).includes(lower(filters.camera)));
  }

  return result;
}

function filterLines(lines, filters) {
  let result = toArray(lines);

  if (filters.line) {
    result = result.filter((l) => lower(l.name).includes(lower(filters.line)));
  }

  return result;
}

async function fetchObjectFlowAppsWithCounts(filters, preset, classes) {
  const appsRes = await graphql(QUERY_OBJECTFLOW_APPS);
  const rawApps = toArray(appsRes.data?.allApplications).filter((x) => x.__typename === 'ObjectFlow');
  const filteredApps = filterObjectFlowApps(rawApps, filters);

  const range = { time_range_preset: preset };
  const classInputs = classesToInputs(classes);

  const detailedApps = [];

  for (const app of filteredApps) {
    const countsRes = await graphql(QUERY_LINE_COUNTS, {
      app: app.uuid,
      range,
      classes: classInputs,
    });

    const countedApp = countsRes.data?.getApplication;
    const countedLines = filterLines(toArray(countedApp?.lines), filters);

    const lines = countedLines.map((line) => {
      const data = summarizeLineBuckets(line.count_data);
      const live = summarizeLineLive(line.count_live);
      return {
        uuid: line.uuid,
        name: line.name,
        totals: {
          in: data.total_in,
          out: data.total_out,
        },
        live,
        data,
      };
    });

    detailedApps.push({
      type: 'ObjectFlow',
      uuid: app.uuid,
      name: app.name,
      tags: toArray(app.tags),
      created_at: app.created_at || null,
      updated_at: app.updated_at || null,
      status: app.status || null,
      last_online: app.last_online || null,
      camera: app.camera || null,
      model: app.model || null,
      lines,
      totals: {
        in: sumBy(lines, (x) => x.totals.in),
        out: sumBy(lines, (x) => x.totals.out),
      },
      debug: {
        requested_classes: classes,
        requested_preset: preset,
        line_count: lines.length,
        graphql_errors: countsRes.errors,
      },
    });
  }

  return {
    apps: detailedApps,
    query_errors: appsRes.errors,
  };
}

function buildTotalsFromApps(apps) {
  return {
    objectflow_apps: toArray(apps).length,
    selected_in: sumBy(apps, (a) => a.totals.in),
    selected_out: sumBy(apps, (a) => a.totals.out),
  };
}

async function collectData(filters = {}) {
  const schemaRes = await graphql(QUERY_SCHEMA);
  const schema = schemaRes.data?.__schema || null;

  const allowedPresets = getEnumValues(schema, 'TimeRangePreset');
  const preset = normalizePreset(filters.preset, allowedPresets);
  const classes = parseClasses(filters.class);
  const featureflags = featureFlagNamesFromSchema(schema);

  const [camerasRes, flowRes, healthRes, flagsRes] = await Promise.all([
    graphql(QUERY_CAMERAS),
    fetchObjectFlowAppsWithCounts(filters, preset, classes),
    graphql(QUERY_SYSTEM_HEALTH, {
      healthRange: {
        time_range_preset: normalizePreset(CONFIG.healthPreset, allowedPresets),
      },
    }),
    graphql(QUERY_FEATURE_FLAGS, { featureflags }),
  ]);

  const cameras = toArray(camerasRes.data?.allCameras);
  const applications = flowRes.apps;
  const totals = buildTotalsFromApps(applications);

  return {
    ok: true,
    generated_at: nowIso(),
    filters: {
      app: filters.app || '',
      camera: filters.camera || '',
      line: filters.line || '',
      class: classes.join(','),
      preset,
    },
    available_presets: allowedPresets,
    config: {
      baseUrl: CONFIG.baseUrl,
      graphqlPath: CONFIG.graphqlPath,
      verifyTls: CONFIG.verifyTls,
      defaultPreset: CONFIG.defaultPreset,
      defaultClasses: CONFIG.defaultClasses,
    },
    totals,
    inventory: {
      cameras,
      applications,
      application_count: applications.length,
    },
    operations: {
      system_health: healthRes.data?.getSystemHealth || null,
      feature_flags_requested: featureflags,
      feature_flags_result: flagsRes.data?.getFeatureFlags || null,
    },
    schema,
    errors: {
      schema: schemaRes.errors,
      cameras: camerasRes.errors,
      applications: flowRes.query_errors,
      system_health: healthRes.errors,
      feature_flags: flagsRes.errors,
    },
  };
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function pickFilters(url) {
  return {
    app: url.searchParams.get('app') || '',
    camera: url.searchParams.get('camera') || '',
    line: url.searchParams.get('line') || '',
    class: url.searchParams.get('class') || '',
    preset: url.searchParams.get('preset') || '',
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, {
      ok: true,
      service: 'isarsoft-node-server',
      time: nowIso(),
      examples: [
        '/summary?preset=THISYEAR',
        '/summary?preset=THISYEAR&class=HEAD',
        '/summary?preset=THISYEAR&class=HEAD&line=walk',
        '/summary?preset=LAST1DAY&class=PERSON,HEAD',
        '/debug/lines?preset=THISYEAR&class=HEAD',
        '/debug/lines?preset=THISYEAR&class=HEAD&line=walk',
      ],
    });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, time: nowIso() });
  }

  if (req.method === 'GET' && url.pathname === '/summary') {
    try {
      const filters = pickFilters(url);
      const data = await collectData(filters);
      return sendJson(res, 200, {
        ok: true,
        generated_at: data.generated_at,
        filters: data.filters,
        available_presets: data.available_presets,
        totals: data.totals,
      });
    } catch (err) {
      return sendJson(res, 500, {
        ok: false,
        error: err.message,
        time: nowIso(),
      });
    }
  }

  if (req.method === 'GET' && url.pathname === '/data') {
    try {
      const filters = pickFilters(url);
      const data = await collectData(filters);
      return sendJson(res, 200, data);
    } catch (err) {
      return sendJson(res, 500, {
        ok: false,
        error: err.message,
        time: nowIso(),
      });
    }
  }

  if (req.method === 'GET' && url.pathname === '/debug/lines') {
    try {
      const filters = pickFilters(url);
      const data = await collectData(filters);
      const flattened = toArray(data.inventory.applications).flatMap((app) =>
        toArray(app.lines).map((line) => ({
          application_uuid: app.uuid,
          application_name: app.name,
          camera_name: app.camera?.name || null,
          line_uuid: line.uuid,
          line_name: line.name,
          total_in: line.totals.in,
          total_out: line.totals.out,
          live_in: line.live.total_in,
          live_out: line.live.total_out,
          buckets: line.data.buckets,
          first_bucket: line.data.first_bucket,
          last_bucket: line.data.last_bucket,
        }))
      );

      flattened.sort((a, b) => b.total_out - a.total_out || b.total_in - a.total_in);

      return sendJson(res, 200, {
        ok: true,
        generated_at: data.generated_at,
        filters: data.filters,
        totals: data.totals,
        lines: flattened,
      });
    } catch (err) {
      return sendJson(res, 500, {
        ok: false,
        error: err.message,
        time: nowIso(),
      });
    }
  }

  if (req.method === 'GET' && url.pathname === '/cameras') {
    try {
      const data = await collectData({});
      return sendJson(res, 200, {
        ok: true,
        generated_at: data.generated_at,
        cameras: data.inventory.cameras,
      });
    } catch (err) {
      return sendJson(res, 500, {
        ok: false,
        error: err.message,
        time: nowIso(),
      });
    }
  }

  return sendJson(res, 404, {
    ok: false,
    error: 'Not found',
    path: url.pathname,
  });
});

server.listen(CONFIG.port, () => {
  console.log(
    JSON.stringify(
      {
        ok: true,
        message: 'Server started',
        port: CONFIG.port,
        baseUrl: CONFIG.baseUrl,
        graphqlPath: CONFIG.graphqlPath,
        defaultPreset: CONFIG.defaultPreset,
        defaultClasses: CONFIG.defaultClasses,
        time: nowIso(),
      },
      null,
      2
    )
  );
});