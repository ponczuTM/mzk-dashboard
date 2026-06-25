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
  defaultClasses: (process.env.ISARSOFT_CLASSES || 'PERSON,HEAD')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
  defaultPreset: process.env.ISARSOFT_PRESET || 'THISYEAR',
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

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

const QUERY_FEATURE_FLAGS = `
query($featureflags: [FeatureFlags!]!) {
  getFeatureFlags(featureflags: $featureflags)
}
`;

const QUERY_SYSTEM_HEALTH = `
query($healthRange: TimeRangeInput!) {
  getSystemHealth {
    perception_camera_count
    perception_camera_initializing_count
    perception_camera_offline_count
    perception_camera_online_count
    perception_camera_paused_count
    perception_camera_pending_count
    perception_app_count
    perception_app_initializing_count
    perception_app_offline_count
    perception_app_online_count
    perception_app_paused_count
    perception_app_pending_count

    perception_camera_counts_history(time_range: $healthRange) { points { timestamp value } }
    perception_camera_online_counts_history(time_range: $healthRange) { points { timestamp value } }
    perception_camera_offline_counts_history(time_range: $healthRange) { points { timestamp value } }
    perception_app_counts_history(time_range: $healthRange) { points { timestamp value } }
    perception_app_online_counts_history(time_range: $healthRange) { points { timestamp value } }
    perception_app_offline_counts_history(time_range: $healthRange) { points { timestamp value } }
  }
}
`;

const QUERY_MISC = `
query {
  getMachineFingerprint
  getLicense { __typename }
  getLicenseStatus { __typename }
  allExports { __typename }
  getDeviceSettings { __typename }
  getMQTTSettings { __typename }
  getKafkaSettings { __typename }
  getKinesisSettings { __typename }
  getCayugaSettings { __typename }
  getGenetecSettings { __typename }
  getMilestoneSettings { __typename }
  getObjectFlowSettings { __typename }
}
`;

const QUERY_APPLICATIONS = `
query(
  $selectedClasses: [ObjectClassInput!]!,
  $personOnly: [ObjectClassInput!]!,
  $headOnly: [ObjectClassInput!]!,
  $timeRange: TimeRangeInput!
) {
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
      default_model_settings

      camera {
        uuid
        name
      }

      model {
        uuid
        name
      }

      lines {
        uuid
        name
        tags
        coordinates
        created_at
        updated_at

        live_selected: count_live(object_classes: $selectedClasses) {
          count_in
          count_out
        }

        live_person: count_live(object_classes: $personOnly) {
          count_in
          count_out
        }

        live_head: count_live(object_classes: $headOnly) {
          count_in
          count_out
        }

        selected_data: count_data(
          time_range: $timeRange
          object_classes: $selectedClasses
        ) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }

        person_data: count_data(
          time_range: $timeRange
          object_classes: $personOnly
        ) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }

        head_data: count_data(
          time_range: $timeRange
          object_classes: $headOnly
        ) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }
      }

      areas {
        uuid
        name
        tags
        coordinates
        created_at
        updated_at

        live_selected: count_live(object_classes: $selectedClasses) {
          count
        }

        selected_data: count_data(
          time_range: $timeRange
          object_classes: $selectedClasses
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }
      }
    }

    ... on ObjectCount {
      uuid
      name
      tags
      created_at
      updated_at
      status
      last_online

      camera {
        uuid
        name
      }

      model {
        uuid
        name
      }

      areas {
        uuid
        name
        tags
        coordinates

        live_selected: count_live(object_classes: $selectedClasses) {
          count
        }

        selected_data: count_data(
          time_range: $timeRange
          object_classes: $selectedClasses
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }
      }
    }

    ... on CrowdCount {
      uuid
      name
      tags
      created_at
      updated_at
      status
      last_online
      current_count
      box_u1
      box_v1
      box_u2
      box_v2

      camera {
        uuid
        name
      }

      model {
        uuid
        name
      }

      selected_data: count_data(time_range: $timeRange) {
        time_bucket
        number_of_samples
        count_min
        count_avg
        count_max
      }
    }
  }
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
  const list = (input || CONFIG.defaultClasses.join(','))
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);

  return list.length ? list : CONFIG.defaultClasses;
}

function featureFlagNamesFromSchema(schema) {
  return getEnumValues(schema, 'FeatureFlags');
}

function summarizeLineSeries(rows) {
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

function summarizeAreaSeries(rows) {
  const raw = toArray(rows);
  return {
    buckets: raw.length,
    first_bucket: raw[0]?.time_bucket || null,
    last_bucket: raw[raw.length - 1]?.time_bucket || null,
    samples: sumBy(raw, (x) => x?.number_of_samples),
    min_of_mins: raw.length ? Math.min(...raw.map((x) => num(x?.count_min))) : null,
    avg_of_avgs: raw.length ? avg(raw.map((x) => num(x?.count_avg))) : null,
    max_of_maxs: raw.length ? Math.max(...raw.map((x) => num(x?.count_max))) : null,
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

function summarizeAreaLive(rows) {
  const raw = toArray(rows);
  return {
    count: sumBy(raw, (x) => x?.count),
    raw,
  };
}

function mapObjectFlowLine(line) {
  const selected = summarizeLineSeries(line.selected_data);
  const person = summarizeLineSeries(line.person_data);
  const head = summarizeLineSeries(line.head_data);

  return {
    uuid: line.uuid,
    name: line.name,
    tags: toArray(line.tags),
    coordinates: toArray(line.coordinates),
    created_at: line.created_at || null,
    updated_at: line.updated_at || null,
    selected: {
      live: summarizeLineLive(line.live_selected),
      data: selected,
    },
    person: {
      live: summarizeLineLive(line.live_person),
      data: person,
    },
    head: {
      live: summarizeLineLive(line.live_head),
      data: head,
    },
    totals: {
      selected_in: selected.total_in,
      selected_out: selected.total_out,
      person_in: person.total_in,
      person_out: person.total_out,
      head_in: head.total_in,
      head_out: head.total_out,
    },
  };
}

function mapObjectFlowArea(area) {
  return {
    uuid: area.uuid,
    name: area.name,
    tags: toArray(area.tags),
    coordinates: toArray(area.coordinates),
    created_at: area.created_at || null,
    updated_at: area.updated_at || null,
    selected: {
      live: summarizeAreaLive(area.live_selected),
      data: summarizeAreaSeries(area.selected_data),
    },
  };
}

function mapApplication(app) {
  if (app.__typename === 'ObjectFlow') {
    const lines = toArray(app.lines).map(mapObjectFlowLine);
    const areas = toArray(app.areas).map(mapObjectFlowArea);

    return {
      type: 'ObjectFlow',
      uuid: app.uuid,
      name: app.name,
      tags: toArray(app.tags),
      created_at: app.created_at || null,
      updated_at: app.updated_at || null,
      status: app.status || null,
      last_online: app.last_online || null,
      default_model_settings: app.default_model_settings,
      camera: app.camera || null,
      model: app.model || null,
      lines,
      areas,
      totals: {
        selected_in: sumBy(lines, (x) => x.totals.selected_in),
        selected_out: sumBy(lines, (x) => x.totals.selected_out),
        person_in: sumBy(lines, (x) => x.totals.person_in),
        person_out: sumBy(lines, (x) => x.totals.person_out),
        head_in: sumBy(lines, (x) => x.totals.head_in),
        head_out: sumBy(lines, (x) => x.totals.head_out),
      },
    };
  }

  if (app.__typename === 'ObjectCount') {
    return {
      type: 'ObjectCount',
      uuid: app.uuid,
      name: app.name,
      tags: toArray(app.tags),
      created_at: app.created_at || null,
      updated_at: app.updated_at || null,
      status: app.status || null,
      last_online: app.last_online || null,
      camera: app.camera || null,
      model: app.model || null,
      areas: toArray(app.areas).map(mapObjectFlowArea),
    };
  }

  if (app.__typename === 'CrowdCount') {
    return {
      type: 'CrowdCount',
      uuid: app.uuid,
      name: app.name,
      tags: toArray(app.tags),
      created_at: app.created_at || null,
      updated_at: app.updated_at || null,
      status: app.status || null,
      last_online: app.last_online || null,
      current_count: app.current_count ?? null,
      box: {
        box_u1: app.box_u1,
        box_v1: app.box_v1,
        box_u2: app.box_u2,
        box_v2: app.box_v2,
      },
      camera: app.camera || null,
      model: app.model || null,
      selected: summarizeAreaSeries(app.selected_data),
    };
  }

  return { type: app.__typename || 'Unknown', raw: app };
}

function filterApplications(applications, filters = {}) {
  let result = toArray(applications);

  if (filters.type) {
    result = result.filter((a) => lower(a.type) === lower(filters.type));
  }

  if (filters.app) {
    result = result.filter((a) => lower(a.name).includes(lower(filters.app)));
  }

  if (filters.camera) {
    result = result.filter((a) => lower(a.camera?.name).includes(lower(filters.camera)));
  }

  if (filters.line) {
    result = result
      .map((app) => {
        if (app.type !== 'ObjectFlow') return null;
        const matchedLines = toArray(app.lines).filter((l) =>
          lower(l.name).includes(lower(filters.line))
        );
        if (!matchedLines.length) return null;

        return {
          ...app,
          lines: matchedLines,
          totals: {
            selected_in: sumBy(matchedLines, (x) => x.totals.selected_in),
            selected_out: sumBy(matchedLines, (x) => x.totals.selected_out),
            person_in: sumBy(matchedLines, (x) => x.totals.person_in),
            person_out: sumBy(matchedLines, (x) => x.totals.person_out),
            head_in: sumBy(matchedLines, (x) => x.totals.head_in),
            head_out: sumBy(matchedLines, (x) => x.totals.head_out),
          },
        };
      })
      .filter(Boolean);
  }

  return result;
}

function buildTotals(applications) {
  const flowApps = toArray(applications).filter((a) => a.type === 'ObjectFlow');
  return {
    objectflow_apps: flowApps.length,
    selected_in: sumBy(flowApps, (a) => a.totals.selected_in),
    selected_out: sumBy(flowApps, (a) => a.totals.selected_out),
    person_in: sumBy(flowApps, (a) => a.totals.person_in),
    person_out: sumBy(flowApps, (a) => a.totals.person_out),
    head_in: sumBy(flowApps, (a) => a.totals.head_in),
    head_out: sumBy(flowApps, (a) => a.totals.head_out),
  };
}

async function collectData(filters = {}) {
  const schemaRes = await graphql(QUERY_SCHEMA);
  const schema = schemaRes.data?.__schema || null;

  const allowedPresets = getEnumValues(schema, 'TimeRangePreset');
  const preset = normalizePreset(filters.preset, allowedPresets);
  const classes = parseClasses(filters.class);
  const selectedClasses = classes.map((name) => ({ name }));

  const featureflags = featureFlagNamesFromSchema(schema);

  const variablesApps = {
    selectedClasses,
    personOnly: [{ name: 'PERSON' }],
    headOnly: [{ name: 'HEAD' }],
    timeRange: {
      time_range_preset: preset,
    },
  };

  const variablesHealth = {
    healthRange: {
      time_range_preset: normalizePreset(CONFIG.healthPreset, allowedPresets),
    },
  };

  const [camerasRes, appsRes, healthRes, flagsRes, miscRes] = await Promise.all([
    graphql(QUERY_CAMERAS),
    graphql(QUERY_APPLICATIONS, variablesApps),
    graphql(QUERY_SYSTEM_HEALTH, variablesHealth),
    graphql(QUERY_FEATURE_FLAGS, { featureflags }),
    graphql(QUERY_MISC),
  ]);

  const cameras = toArray(camerasRes.data?.allCameras);
  const applicationsRaw = toArray(appsRes.data?.allApplications).map(mapApplication);
  const applications = filterApplications(applicationsRaw, filters);
  const totals = buildTotals(applications);

  return {
    ok: true,
    generated_at: nowIso(),
    filters: {
      type: filters.type || '',
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
      defaultClasses: CONFIG.defaultClasses,
      defaultPreset: CONFIG.defaultPreset,
      healthPreset: CONFIG.healthPreset,
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
      misc: miscRes.data || null,
    },
    schema,
    errors: {
      schema: schemaRes.errors,
      cameras: camerasRes.errors,
      applications: appsRes.errors,
      system_health: healthRes.errors,
      feature_flags: flagsRes.errors,
      misc: miscRes.errors,
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
    type: url.searchParams.get('type') || '',
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
        '/summary?preset=LAST1DAY',
        '/summary?preset=LAST1MONTH',
        '/summary?preset=THISYEAR',
        '/summary?preset=THISYEARSOFAR&class=HEAD&line=walk',
        '/data?type=objectflow&class=HEAD&line=walk&preset=THISYEAR',
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

  if (req.method === 'GET' && url.pathname === '/applications') {
    try {
      const filters = pickFilters(url);
      const data = await collectData(filters);
      return sendJson(res, 200, {
        ok: true,
        generated_at: data.generated_at,
        filters: data.filters,
        totals: data.totals,
        applications: data.inventory.applications,
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