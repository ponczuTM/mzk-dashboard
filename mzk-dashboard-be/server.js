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
  classNames: (process.env.ISARSOFT_CLASSES || 'PERSON,HEAD')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
  presetShort: process.env.ISARSOFT_PRESET_SHORT || 'LAST_1_HOUR',
  presetMedium: process.env.ISARSOFT_PRESET_MEDIUM || 'LAST_12_HOUR',
  presetLong: process.env.ISARSOFT_PRESET_LONG || 'THIS_YEAR',
  healthPreset: process.env.ISARSOFT_HEALTH_PRESET || 'LAST_1_DAY',
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
  const vals = toArray(arr).map(num).filter((x) => Number.isFinite(x));
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
      fields { name }
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
  checkCayugaConnection
  checkMilestoneConnection
  checkGenetecConnection
  allCayugaCameras { __typename }
  allMilestoneCameras { __typename }
  allGenetecCameras { __typename }
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

    perception_camera_counts_history(time_range: $healthRange) {
      points { timestamp value }
    }
    perception_camera_initializing_counts_history(time_range: $healthRange) {
      points { timestamp value }
    }
    perception_camera_offline_counts_history(time_range: $healthRange) {
      points { timestamp value }
    }
    perception_camera_online_counts_history(time_range: $healthRange) {
      points { timestamp value }
    }
    perception_camera_paused_counts_history(time_range: $healthRange) {
      points { timestamp value }
    }
    perception_camera_pending_counts_history(time_range: $healthRange) {
      points { timestamp value }
    }

    perception_app_counts_history(time_range: $healthRange) {
      points { timestamp value }
    }
    perception_app_initializing_counts_history(time_range: $healthRange) {
      points { timestamp value }
    }
    perception_app_offline_counts_history(time_range: $healthRange) {
      points { timestamp value }
    }
    perception_app_online_counts_history(time_range: $healthRange) {
      points { timestamp value }
    }
    perception_app_paused_counts_history(time_range: $healthRange) {
      points { timestamp value }
    }
    perception_app_pending_counts_history(time_range: $healthRange) {
      points { timestamp value }
    }
  }
}
`;

const QUERY_APPLICATIONS = `
query(
  $personOnly: [ObjectClassInput!]!,
  $headOnly: [ObjectClassInput!]!,
  $allClasses: [ObjectClassInput!]!,
  $presetShort: TimeRangePreset!,
  $presetMedium: TimeRangePreset!,
  $presetLong: TimeRangePreset!
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

        live_person: count_live(object_classes: $personOnly) {
          count_in
          count_out
        }

        live_head: count_live(object_classes: $headOnly) {
          count_in
          count_out
        }

        live_all: count_live(object_classes: $allClasses) {
          count_in
          count_out
        }

        short_person: count_data(
          time_range: { time_range_preset: $presetShort }
          object_classes: $personOnly
        ) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }

        short_head: count_data(
          time_range: { time_range_preset: $presetShort }
          object_classes: $headOnly
        ) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }

        short_all: count_data(
          time_range: { time_range_preset: $presetShort }
          object_classes: $allClasses
        ) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }

        medium_person: count_data(
          time_range: { time_range_preset: $presetMedium }
          object_classes: $personOnly
        ) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }

        medium_head: count_data(
          time_range: { time_range_preset: $presetMedium }
          object_classes: $headOnly
        ) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }

        medium_all: count_data(
          time_range: { time_range_preset: $presetMedium }
          object_classes: $allClasses
        ) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }

        long_person: count_data(
          time_range: { time_range_preset: $presetLong }
          object_classes: $personOnly
        ) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }

        long_head: count_data(
          time_range: { time_range_preset: $presetLong }
          object_classes: $headOnly
        ) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }

        long_all: count_data(
          time_range: { time_range_preset: $presetLong }
          object_classes: $allClasses
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

        live_person: count_live(object_classes: $personOnly) {
          count
        }

        live_head: count_live(object_classes: $headOnly) {
          count
        }

        live_all: count_live(object_classes: $allClasses) {
          count
        }

        short_person: count_data(
          time_range: { time_range_preset: $presetShort }
          object_classes: $personOnly
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }

        short_head: count_data(
          time_range: { time_range_preset: $presetShort }
          object_classes: $headOnly
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }

        short_all: count_data(
          time_range: { time_range_preset: $presetShort }
          object_classes: $allClasses
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }

        medium_person: count_data(
          time_range: { time_range_preset: $presetMedium }
          object_classes: $personOnly
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }

        medium_head: count_data(
          time_range: { time_range_preset: $presetMedium }
          object_classes: $headOnly
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }

        medium_all: count_data(
          time_range: { time_range_preset: $presetMedium }
          object_classes: $allClasses
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }

        long_person: count_data(
          time_range: { time_range_preset: $presetLong }
          object_classes: $personOnly
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }

        long_head: count_data(
          time_range: { time_range_preset: $presetLong }
          object_classes: $headOnly
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }

        long_all: count_data(
          time_range: { time_range_preset: $presetLong }
          object_classes: $allClasses
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
      default_model_settings

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
        created_at
        updated_at

        live_person: count_live(object_classes: $personOnly) {
          count
        }

        live_head: count_live(object_classes: $headOnly) {
          count
        }

        live_all: count_live(object_classes: $allClasses) {
          count
        }

        long_person: count_data(
          time_range: { time_range_preset: $presetLong }
          object_classes: $personOnly
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }

        long_head: count_data(
          time_range: { time_range_preset: $presetLong }
          object_classes: $headOnly
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }

        long_all: count_data(
          time_range: { time_range_preset: $presetLong }
          object_classes: $allClasses
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

      long_data: count_data(time_range: { time_range_preset: $presetLong }) {
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

function featureFlagNamesFromSchema(schemaTypes) {
  const enumType = toArray(schemaTypes).find((x) => x.name === 'FeatureFlags');
  return toArray(enumType?.enumValues).map((x) => x.name).filter(Boolean);
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
  const livePerson = summarizeLineLive(line.live_person);
  const liveHead = summarizeLineLive(line.live_head);
  const liveAll = summarizeLineLive(line.live_all);

  const shortPerson = summarizeLineSeries(line.short_person);
  const shortHead = summarizeLineSeries(line.short_head);
  const shortAll = summarizeLineSeries(line.short_all);

  const mediumPerson = summarizeLineSeries(line.medium_person);
  const mediumHead = summarizeLineSeries(line.medium_head);
  const mediumAll = summarizeLineSeries(line.medium_all);

  const longPerson = summarizeLineSeries(line.long_person);
  const longHead = summarizeLineSeries(line.long_head);
  const longAll = summarizeLineSeries(line.long_all);

  return {
    uuid: line.uuid,
    name: line.name,
    tags: toArray(line.tags),
    coordinates: toArray(line.coordinates),
    created_at: line.created_at || null,
    updated_at: line.updated_at || null,

    classes: {
      PERSON: {
        live: livePerson,
        short: shortPerson,
        medium: mediumPerson,
        this_year: longPerson,
      },
      HEAD: {
        live: liveHead,
        short: shortHead,
        medium: mediumHead,
        this_year: longHead,
      },
      ALL: {
        live: liveAll,
        short: shortAll,
        medium: mediumAll,
        this_year: longAll,
      },
    },

    totals_this_year: {
      person_in: longPerson.total_in,
      person_out: longPerson.total_out,
      head_in: longHead.total_in,
      head_out: longHead.total_out,
      all_in: longAll.total_in,
      all_out: longAll.total_out,
    },

    totals_live: {
      person_in: livePerson.total_in,
      person_out: livePerson.total_out,
      head_in: liveHead.total_in,
      head_out: liveHead.total_out,
      all_in: liveAll.total_in,
      all_out: liveAll.total_out,
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
    classes: {
      PERSON: {
        live: summarizeAreaLive(area.live_person),
        short: summarizeAreaSeries(area.short_person),
        medium: summarizeAreaSeries(area.medium_person),
        this_year: summarizeAreaSeries(area.long_person),
      },
      HEAD: {
        live: summarizeAreaLive(area.live_head),
        short: summarizeAreaSeries(area.short_head),
        medium: summarizeAreaSeries(area.medium_head),
        this_year: summarizeAreaSeries(area.long_head),
      },
      ALL: {
        live: summarizeAreaLive(area.live_all),
        short: summarizeAreaSeries(area.short_all),
        medium: summarizeAreaSeries(area.medium_all),
        this_year: summarizeAreaSeries(area.long_all),
      },
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

      totals_this_year: {
        person_in: sumBy(lines, (x) => x.totals_this_year.person_in),
        person_out: sumBy(lines, (x) => x.totals_this_year.person_out),
        head_in: sumBy(lines, (x) => x.totals_this_year.head_in),
        head_out: sumBy(lines, (x) => x.totals_this_year.head_out),
        all_in: sumBy(lines, (x) => x.totals_this_year.all_in),
        all_out: sumBy(lines, (x) => x.totals_this_year.all_out),
      },

      totals_live: {
        person_in: sumBy(lines, (x) => x.totals_live.person_in),
        person_out: sumBy(lines, (x) => x.totals_live.person_out),
        head_in: sumBy(lines, (x) => x.totals_live.head_in),
        head_out: sumBy(lines, (x) => x.totals_live.head_out),
        all_in: sumBy(lines, (x) => x.totals_live.all_in),
        all_out: sumBy(lines, (x) => x.totals_live.all_out),
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
      default_model_settings: app.default_model_settings,
      camera: app.camera || null,
      model: app.model || null,
      areas: toArray(app.areas).map((area) => ({
        uuid: area.uuid,
        name: area.name,
        tags: toArray(area.tags),
        coordinates: toArray(area.coordinates),
        created_at: area.created_at || null,
        updated_at: area.updated_at || null,
        classes: {
          PERSON: {
            live: summarizeAreaLive(area.live_person),
            this_year: summarizeAreaSeries(area.long_person),
          },
          HEAD: {
            live: summarizeAreaLive(area.live_head),
            this_year: summarizeAreaSeries(area.long_head),
          },
          ALL: {
            live: summarizeAreaLive(area.live_all),
            this_year: summarizeAreaSeries(area.long_all),
          },
        },
      })),
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
      this_year: summarizeAreaSeries(app.long_data),
    };
  }

  return { type: app.__typename || 'Unknown', raw: app };
}

function filterApplications(applications, filters = {}) {
  const type = filters.type ? lower(filters.type) : null;
  const line = filters.line ? lower(filters.line) : null;
  const appName = filters.app ? lower(filters.app) : null;
  const camera = filters.camera ? lower(filters.camera) : null;

  let result = toArray(applications);

  if (type) {
    result = result.filter((a) => lower(a.type) === type);
  }

  if (appName) {
    result = result.filter((a) => lower(a.name).includes(appName));
  }

  if (camera) {
    result = result.filter((a) => lower(a.camera?.name).includes(camera));
  }

  if (line) {
    result = result
      .map((app) => {
        if (app.type !== 'ObjectFlow') return null;
        const matchedLines = toArray(app.lines).filter((l) => lower(l.name).includes(line));
        if (!matchedLines.length) return null;

        return {
          ...app,
          lines: matchedLines,
          totals_this_year: {
            person_in: sumBy(matchedLines, (x) => x.totals_this_year.person_in),
            person_out: sumBy(matchedLines, (x) => x.totals_this_year.person_out),
            head_in: sumBy(matchedLines, (x) => x.totals_this_year.head_in),
            head_out: sumBy(matchedLines, (x) => x.totals_this_year.head_out),
            all_in: sumBy(matchedLines, (x) => x.totals_this_year.all_in),
            all_out: sumBy(matchedLines, (x) => x.totals_this_year.all_out),
          },
          totals_live: {
            person_in: sumBy(matchedLines, (x) => x.totals_live.person_in),
            person_out: sumBy(matchedLines, (x) => x.totals_live.person_out),
            head_in: sumBy(matchedLines, (x) => x.totals_live.head_in),
            head_out: sumBy(matchedLines, (x) => x.totals_live.head_out),
            all_in: sumBy(matchedLines, (x) => x.totals_live.all_in),
            all_out: sumBy(matchedLines, (x) => x.totals_live.all_out),
          },
        };
      })
      .filter(Boolean);
  }

  return result;
}

function buildGlobalTotals(applications) {
  const objectFlow = toArray(applications).filter((a) => a.type === 'ObjectFlow');

  return {
    objectflow_apps: objectFlow.length,
    totals_this_year: {
      person_in: sumBy(objectFlow, (a) => a.totals_this_year.person_in),
      person_out: sumBy(objectFlow, (a) => a.totals_this_year.person_out),
      head_in: sumBy(objectFlow, (a) => a.totals_this_year.head_in),
      head_out: sumBy(objectFlow, (a) => a.totals_this_year.head_out),
      all_in: sumBy(objectFlow, (a) => a.totals_this_year.all_in),
      all_out: sumBy(objectFlow, (a) => a.totals_this_year.all_out),
    },
    totals_live: {
      person_in: sumBy(objectFlow, (a) => a.totals_live.person_in),
      person_out: sumBy(objectFlow, (a) => a.totals_live.person_out),
      head_in: sumBy(objectFlow, (a) => a.totals_live.head_in),
      head_out: sumBy(objectFlow, (a) => a.totals_live.head_out),
      all_in: sumBy(objectFlow, (a) => a.totals_live.all_in),
      all_out: sumBy(objectFlow, (a) => a.totals_live.all_out),
    },
  };
}

async function collectData(filters = {}) {
  const schemaRes = await graphql(QUERY_SCHEMA);
  const schema = schemaRes.data?.__schema || null;
  const featureflags = featureFlagNamesFromSchema(schema?.types);

  const variablesApps = {
    personOnly: [{ name: 'PERSON' }],
    headOnly: [{ name: 'HEAD' }],
    allClasses: CONFIG.classNames.map((name) => ({ name })),
    presetShort: CONFIG.presetShort,
    presetMedium: CONFIG.presetMedium,
    presetLong: CONFIG.presetLong,
  };

  const variablesHealth = {
    healthRange: {
      time_range_preset: CONFIG.healthPreset,
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
  const totals = buildGlobalTotals(applications);

  return {
    ok: true,
    generated_at: nowIso(),
    filters,
    config: {
      baseUrl: CONFIG.baseUrl,
      graphqlPath: CONFIG.graphqlPath,
      verifyTls: CONFIG.verifyTls,
      classes: CONFIG.classNames,
      presets: {
        short: CONFIG.presetShort,
        medium: CONFIG.presetMedium,
        long: CONFIG.presetLong,
        health: CONFIG.healthPreset,
      },
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
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, {
      ok: true,
      service: 'isarsoft-node-server',
      time: nowIso(),
      endpoints: [
        '/health',
        '/summary',
        '/data',
        '/applications',
        '/cameras',
        '/summary?line=walk',
        '/data?line=walk&type=objectflow',
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
        config: data.config,
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
        classes: CONFIG.classNames,
        presets: {
          short: CONFIG.presetShort,
          medium: CONFIG.presetMedium,
          long: CONFIG.presetLong,
          health: CONFIG.healthPreset,
        },
        time: nowIso(),
      },
      null,
      2
    )
  );
});