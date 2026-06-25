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
  historyPresetShort: process.env.ISARSOFT_PRESET_SHORT || 'LAST_1_HOUR',
  historyPresetMedium: process.env.ISARSOFT_PRESET_MEDIUM || 'LAST_12_HOUR',
  historyPresetLong: process.env.ISARSOFT_PRESET_LONG || 'THIS_YEAR',
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

function sumBy(arr, fn) {
  return toArray(arr).reduce((acc, item) => acc + (Number(fn(item)) || 0), 0);
}

function avg(arr) {
  const values = arr.filter((x) => Number.isFinite(x));
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
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

const QUERY_CAMERAS = `
query {
  allCameras {
    uuid
    name
  }
}
`;

const QUERY_APPS = `
query(
  $personAndHead: [ObjectClassInput!]!,
  $personOnly: [ObjectClassInput!]!,
  $headOnly: [ObjectClassInput!]!,
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

      alarms {
        uuid
        name
      }

      output_stream {
        __typename
      }

      tracks_live {
        __typename
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

        live_all: count_live(object_classes: $personAndHead) {
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
          object_classes: $personAndHead
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
          object_classes: $personAndHead
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
          object_classes: $personAndHead
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

        live_all: count_live(object_classes: $personAndHead) {
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
          object_classes: $personAndHead
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
          object_classes: $personAndHead
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
          object_classes: $personAndHead
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

      alarms {
        uuid
        name
      }

      output_stream {
        __typename
      }

      detections_live {
        __typename
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

        live_all: count_live(object_classes: $personAndHead) {
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
          object_classes: $personAndHead
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
          object_classes: $personAndHead
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
          object_classes: $personAndHead
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

      alarms {
        uuid
        name
      }

      output_stream {
        __typename
      }

      short_data: count_data(time_range: { time_range_preset: $presetShort }) {
        time_bucket
        number_of_samples
        count_min
        count_avg
        count_max
      }

      medium_data: count_data(time_range: { time_range_preset: $presetMedium }) {
        time_bucket
        number_of_samples
        count_min
        count_avg
        count_max
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

const QUERY_SCHEMA = `
query {
  __schema {
    queryType { name fields { name } }
    mutationType { name fields { name } }
    subscriptionType { name }
    types {
      name
      kind
      fields { name }
      inputFields { name }
      enumValues { name }
    }
  }
}
`;

function summarizeLineBuckets(rows) {
  const list = toArray(rows);
  return {
    buckets: list.length,
    samples: sumBy(list, (x) => x?.number_of_samples),
    total_in: sumBy(list, (x) => x?.count_in),
    total_out: sumBy(list, (x) => x?.count_out),
    first_bucket: list[0]?.time_bucket || null,
    last_bucket: list[list.length - 1]?.time_bucket || null,
    raw: list,
  };
}

function summarizeAreaBuckets(rows) {
  const list = toArray(rows);
  const mins = list.map((x) => Number(x?.count_min)).filter(Number.isFinite);
  const avgs = list.map((x) => Number(x?.count_avg)).filter(Number.isFinite);
  const maxs = list.map((x) => Number(x?.count_max)).filter(Number.isFinite);

  return {
    buckets: list.length,
    samples: sumBy(list, (x) => x?.number_of_samples),
    min_of_mins: mins.length ? Math.min(...mins) : null,
    avg_of_avgs: avg(avgs),
    max_of_maxs: maxs.length ? Math.max(...maxs) : null,
    first_bucket: list[0]?.time_bucket || null,
    last_bucket: list[list.length - 1]?.time_bucket || null,
    raw: list,
  };
}

function summarizeLineLive(rows) {
  const list = toArray(rows);
  return {
    total_in: sumBy(list, (x) => x?.count_in),
    total_out: sumBy(list, (x) => x?.count_out),
    raw: list,
  };
}

function summarizeAreaLive(rows) {
  const list = toArray(rows);
  return {
    count: sumBy(list, (x) => x?.count),
    raw: list,
  };
}

function mapLine(line) {
  const personLive = summarizeLineLive(line.live_person);
  const headLive = summarizeLineLive(line.live_head);
  const allLive = summarizeLineLive(line.live_all);

  return {
    uuid: line.uuid,
    name: line.name,
    tags: toArray(line.tags),
    coordinates: toArray(line.coordinates),
    created_at: line.created_at || null,
    updated_at: line.updated_at || null,

    classes: {
      PERSON: {
        live: personLive,
        short: summarizeLineBuckets(line.short_person),
        medium: summarizeLineBuckets(line.medium_person),
        long: summarizeLineBuckets(line.long_person),
      },
      HEAD: {
        live: headLive,
        short: summarizeLineBuckets(line.short_head),
        medium: summarizeLineBuckets(line.medium_head),
        long: summarizeLineBuckets(line.long_head),
      },
      ALL: {
        live: allLive,
        short: summarizeLineBuckets(line.short_all),
        medium: summarizeLineBuckets(line.medium_all),
        long: summarizeLineBuckets(line.long_all),
      },
    },

    always_report: {
      people_in_out_live: {
        person_in: personLive.total_in,
        person_out: personLive.total_out,
        head_in: headLive.total_in,
        head_out: headLive.total_out,
        all_in: allLive.total_in,
        all_out: allLive.total_out,
      },
      people_in_out_short: {
        person_in: sumBy(line.short_person, (x) => x?.count_in),
        person_out: sumBy(line.short_person, (x) => x?.count_out),
        head_in: sumBy(line.short_head, (x) => x?.count_in),
        head_out: sumBy(line.short_head, (x) => x?.count_out),
        all_in: sumBy(line.short_all, (x) => x?.count_in),
        all_out: sumBy(line.short_all, (x) => x?.count_out),
      },
      people_in_out_medium: {
        person_in: sumBy(line.medium_person, (x) => x?.count_in),
        person_out: sumBy(line.medium_person, (x) => x?.count_out),
        head_in: sumBy(line.medium_head, (x) => x?.count_in),
        head_out: sumBy(line.medium_head, (x) => x?.count_out),
        all_in: sumBy(line.medium_all, (x) => x?.count_in),
        all_out: sumBy(line.medium_all, (x) => x?.count_out),
      },
      people_in_out_long: {
        person_in: sumBy(line.long_person, (x) => x?.count_in),
        person_out: sumBy(line.long_person, (x) => x?.count_out),
        head_in: sumBy(line.long_head, (x) => x?.count_in),
        head_out: sumBy(line.long_head, (x) => x?.count_out),
        all_in: sumBy(line.long_all, (x) => x?.count_in),
        all_out: sumBy(line.long_all, (x) => x?.count_out),
      },
    },
  };
}

function mapArea(area) {
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
        short: summarizeAreaBuckets(area.short_person),
        medium: summarizeAreaBuckets(area.medium_person),
        long: summarizeAreaBuckets(area.long_person),
      },
      HEAD: {
        live: summarizeAreaLive(area.live_head),
        short: summarizeAreaBuckets(area.short_head),
        medium: summarizeAreaBuckets(area.medium_head),
        long: summarizeAreaBuckets(area.long_head),
      },
      ALL: {
        live: summarizeAreaLive(area.live_all),
        short: summarizeAreaBuckets(area.short_all),
        medium: summarizeAreaBuckets(area.medium_all),
        long: summarizeAreaBuckets(area.long_all),
      },
    },
  };
}

function mapApplication(app) {
  if (app.__typename === 'ObjectFlow') {
    const lines = toArray(app.lines).map(mapLine);
    const areas = toArray(app.areas).map(mapArea);

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
      alarms: toArray(app.alarms),
      output_stream: app.output_stream || null,
      tracks_live: toArray(app.tracks_live),
      lines,
      areas,

      always_report: {
        person_live_in: sumBy(lines, (x) => x.always_report.people_in_out_live.person_in),
        person_live_out: sumBy(lines, (x) => x.always_report.people_in_out_live.person_out),
        head_live_in: sumBy(lines, (x) => x.always_report.people_in_out_live.head_in),
        head_live_out: sumBy(lines, (x) => x.always_report.people_in_out_live.head_out),
        all_live_in: sumBy(lines, (x) => x.always_report.people_in_out_live.all_in),
        all_live_out: sumBy(lines, (x) => x.always_report.people_in_out_live.all_out),

        person_short_in: sumBy(lines, (x) => x.always_report.people_in_out_short.person_in),
        person_short_out: sumBy(lines, (x) => x.always_report.people_in_out_short.person_out),
        head_short_in: sumBy(lines, (x) => x.always_report.people_in_out_short.head_in),
        head_short_out: sumBy(lines, (x) => x.always_report.people_in_out_short.head_out),
        all_short_in: sumBy(lines, (x) => x.always_report.people_in_out_short.all_in),
        all_short_out: sumBy(lines, (x) => x.always_report.people_in_out_short.all_out),

        person_medium_in: sumBy(lines, (x) => x.always_report.people_in_out_medium.person_in),
        person_medium_out: sumBy(lines, (x) => x.always_report.people_in_out_medium.person_out),
        head_medium_in: sumBy(lines, (x) => x.always_report.people_in_out_medium.head_in),
        head_medium_out: sumBy(lines, (x) => x.always_report.people_in_out_medium.head_out),
        all_medium_in: sumBy(lines, (x) => x.always_report.people_in_out_medium.all_in),
        all_medium_out: sumBy(lines, (x) => x.always_report.people_in_out_medium.all_out),

        person_long_in: sumBy(lines, (x) => x.always_report.people_in_out_long.person_in),
        person_long_out: sumBy(lines, (x) => x.always_report.people_in_out_long.person_out),
        head_long_in: sumBy(lines, (x) => x.always_report.people_in_out_long.head_in),
        head_long_out: sumBy(lines, (x) => x.always_report.people_in_out_long.head_out),
        all_long_in: sumBy(lines, (x) => x.always_report.people_in_out_long.all_in),
        all_long_out: sumBy(lines, (x) => x.always_report.people_in_out_long.all_out),
      },
    };
  }

  if (app.__typename === 'ObjectCount') {
    const areas = toArray(app.areas).map(mapArea);

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
      alarms: toArray(app.alarms),
      output_stream: app.output_stream || null,
      detections_live: toArray(app.detections_live),
      areas,
      always_report: {
        person_live_count: sumBy(areas, (x) => x.classes.PERSON.live.count),
        head_live_count: sumBy(areas, (x) => x.classes.HEAD.live.count),
        all_live_count: sumBy(areas, (x) => x.classes.ALL.live.count),
        note: 'ObjectCount exposes area occupancy/count, not directional IN/OUT.',
      },
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
      alarms: toArray(app.alarms),
      output_stream: app.output_stream || null,
      short: summarizeAreaBuckets(app.short_data),
      medium: summarizeAreaBuckets(app.medium_data),
      long: summarizeAreaBuckets(app.long_data),
      always_report: {
        current_count: app.current_count ?? null,
        note: 'CrowdCount exposes occupancy/current_count, not directional IN/OUT.',
      },
    };
  }

  return { type: app.__typename || 'Unknown', raw: app };
}

function featureFlagNamesFromSchema(schemaTypes) {
  const enumType = toArray(schemaTypes).find((x) => x.name === 'FeatureFlags');
  return toArray(enumType?.enumValues).map((x) => x.name).filter(Boolean);
}

async function collectData() {
  const schemaRes = await graphql(QUERY_SCHEMA);
  const schema = schemaRes.data?.__schema || null;

  const featureFlagsList = featureFlagNamesFromSchema(schema?.types);

  const variablesApps = {
    personAndHead: CONFIG.classNames.map((name) => ({ name })),
    personOnly: [{ name: 'PERSON' }],
    headOnly: [{ name: 'HEAD' }],
    presetShort: CONFIG.historyPresetShort,
    presetMedium: CONFIG.historyPresetMedium,
    presetLong: CONFIG.historyPresetLong,
  };

  const variablesHealth = {
    healthRange: {
      time_range_preset: CONFIG.healthPreset,
    },
  };

  const variablesFlags = {
    featureflags: featureFlagsList,
  };

  const [camerasRes, appsRes, healthRes, flagsRes, miscRes] = await Promise.all([
    graphql(QUERY_CAMERAS),
    graphql(QUERY_APPS, variablesApps),
    graphql(QUERY_SYSTEM_HEALTH, variablesHealth),
    graphql(QUERY_FEATURE_FLAGS, variablesFlags),
    graphql(QUERY_MISC),
  ]);

  const cameras = toArray(camerasRes.data?.allCameras);
  const applications = toArray(appsRes.data?.allApplications).map(mapApplication);

  const objectFlowApps = applications.filter((x) => x.type === 'ObjectFlow');
  const objectCountApps = applications.filter((x) => x.type === 'ObjectCount');
  const crowdApps = applications.filter((x) => x.type === 'CrowdCount');

  const summary = {
    generated_at: nowIso(),
    totals: {
      cameras: cameras.length,
      applications: applications.length,
      objectflow: objectFlowApps.length,
      objectcount: objectCountApps.length,
      crowdcount: crowdApps.length,
    },
    in_out: {
      person_live_in: sumBy(objectFlowApps, (x) => x.always_report.person_live_in),
      person_live_out: sumBy(objectFlowApps, (x) => x.always_report.person_live_out),
      head_live_in: sumBy(objectFlowApps, (x) => x.always_report.head_live_in),
      head_live_out: sumBy(objectFlowApps, (x) => x.always_report.head_live_out),
      all_live_in: sumBy(objectFlowApps, (x) => x.always_report.all_live_in),
      all_live_out: sumBy(objectFlowApps, (x) => x.always_report.all_live_out),

      person_short_in: sumBy(objectFlowApps, (x) => x.always_report.person_short_in),
      person_short_out: sumBy(objectFlowApps, (x) => x.always_report.person_short_out),
      head_short_in: sumBy(objectFlowApps, (x) => x.always_report.head_short_in),
      head_short_out: sumBy(objectFlowApps, (x) => x.always_report.head_short_out),
      all_short_in: sumBy(objectFlowApps, (x) => x.always_report.all_short_in),
      all_short_out: sumBy(objectFlowApps, (x) => x.always_report.all_short_out),

      person_medium_in: sumBy(objectFlowApps, (x) => x.always_report.person_medium_in),
      person_medium_out: sumBy(objectFlowApps, (x) => x.always_report.person_medium_out),
      head_medium_in: sumBy(objectFlowApps, (x) => x.always_report.head_medium_in),
      head_medium_out: sumBy(objectFlowApps, (x) => x.always_report.head_medium_out),
      all_medium_in: sumBy(objectFlowApps, (x) => x.always_report.all_medium_in),
      all_medium_out: sumBy(objectFlowApps, (x) => x.always_report.all_medium_out),

      person_long_in: sumBy(objectFlowApps, (x) => x.always_report.person_long_in),
      person_long_out: sumBy(objectFlowApps, (x) => x.always_report.person_long_out),
      head_long_in: sumBy(objectFlowApps, (x) => x.always_report.head_long_in),
      head_long_out: sumBy(objectFlowApps, (x) => x.always_report.head_long_out),
      all_long_in: sumBy(objectFlowApps, (x) => x.always_report.all_long_in),
      all_long_out: sumBy(objectFlowApps, (x) => x.always_report.all_long_out),
    },
    occupancy: {
      objectcount_person_live: sumBy(objectCountApps, (x) => x.always_report.person_live_count || 0),
      objectcount_head_live: sumBy(objectCountApps, (x) => x.always_report.head_live_count || 0),
      objectcount_all_live: sumBy(objectCountApps, (x) => x.always_report.all_live_count || 0),
      crowdcount_current: sumBy(crowdApps, (x) => x.current_count || 0),
    },
  };

  return {
    ok: true,
    generated_at: nowIso(),
    config: {
      baseUrl: CONFIG.baseUrl,
      graphqlPath: CONFIG.graphqlPath,
      verifyTls: CONFIG.verifyTls,
      classes: CONFIG.classNames,
      presets: {
        short: CONFIG.historyPresetShort,
        medium: CONFIG.historyPresetMedium,
        long: CONFIG.historyPresetLong,
        health: CONFIG.healthPreset,
      },
    },
    summary,
    schema,
    inventory: {
      cameras,
      applications,
    },
    operations: {
      system_health: healthRes.data?.getSystemHealth || null,
      feature_flags_requested: featureFlagsList,
      feature_flags_result: flagsRes.data?.getFeatureFlags || null,
      misc: miscRes.data || null,
    },
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, {
      ok: true,
      service: 'isarsoft-node-server',
      time: nowIso(),
      endpoints: ['/health', '/summary', '/data', '/applications', '/cameras'],
    });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, time: nowIso() });
  }

  if (req.method === 'GET' && url.pathname === '/summary') {
    try {
      const data = await collectData();
      return sendJson(res, 200, {
        ok: true,
        generated_at: data.generated_at,
        config: data.config,
        summary: data.summary,
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
      const data = await collectData();
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
      const data = await collectData();
      return sendJson(res, 200, {
        ok: true,
        generated_at: data.generated_at,
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
      const data = await collectData();
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
          short: CONFIG.historyPresetShort,
          medium: CONFIG.historyPresetMedium,
          long: CONFIG.historyPresetLong,
          health: CONFIG.healthPreset,
        },
        time: nowIso(),
      },
      null,
      2
    )
  );
});