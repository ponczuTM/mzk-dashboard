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
  defaultPersonClassName: process.env.ISARSOFT_PERSON_CLASS || 'PERSON',
  defaultTimePresets: (
    process.env.ISARSOFT_TIME_PRESETS || 'LAST_1_HOUR,LAST_12_HOUR,LAST_1_DAY'
  )
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 30000),
};

const insecureHttpsAgent = new https.Agent({
  rejectUnauthorized: CONFIG.verifyTls,
});

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function sumBy(arr, mapper) {
  return toArray(arr).reduce((acc, item) => acc + (Number(mapper(item)) || 0), 0);
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key)) out[key] = obj[key];
  }
  return out;
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
        agent: url.protocol === 'https:' ? insecureHttpsAgent : undefined,
        timeout: CONFIG.requestTimeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            text: data,
            json: () => safeJsonParse(data),
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Request timeout after ${CONFIG.requestTimeoutMs}ms`));
    });

    req.on('error', reject);

    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken(forceRefresh = false) {
  if (!forceRefresh && cachedToken && Date.now() < cachedTokenExpiresAt - 15000) {
    return cachedToken;
  }

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: CONFIG.clientId,
    username: CONFIG.username,
    password: CONFIG.password,
  }).toString();

  const tokenUrl = `${CONFIG.baseUrl}${CONFIG.tokenPath}`;
  const res = await requestRaw(
    tokenUrl,
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
    throw new Error(
      `Token request failed: ${res.status} ${res.statusText} ${res.text || ''}`.trim()
    );
  }

  cachedToken = json.access_token;
  cachedTokenExpiresAt = Date.now() + (Number(json.expires_in) || 300) * 1000;
  return cachedToken;
}

async function graphqlRequest(query, variables = null, forceRefreshToken = false) {
  const token = await getAccessToken(forceRefreshToken);
  const body = JSON.stringify({ query, variables });

  const graphqlUrl = `${CONFIG.baseUrl}${CONFIG.graphqlPath}`;
  const res = await requestRaw(
    graphqlUrl,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    body
  );

  const json = res.json();
  if (res.status === 401 && !forceRefreshToken) {
    return graphqlRequest(query, variables, true);
  }

  if (!res.ok) {
    throw new Error(
      `GraphQL HTTP error: ${res.status} ${res.statusText} ${res.text || ''}`.trim()
    );
  }

  if (!json) {
    throw new Error(`GraphQL returned non-JSON response: ${res.text || ''}`.trim());
  }

  return json;
}

async function graphqlData(query, variables = null) {
  const result = await graphqlRequest(query, variables);
  if (result.errors) {
    return { data: result.data || null, errors: result.errors };
  }
  return { data: result.data || null, errors: null };
}

const Q_SCHEMA_ROOT = `
query {
  __schema {
    queryType { name fields { name } }
    mutationType { name fields { name } }
    subscriptionType { name }
  }
}
`;

const Q_SCHEMA_TYPES = `
query {
  __schema {
    types {
      name
      kind
      fields { name }
      enumValues { name }
      inputFields { name }
    }
  }
}
`;

const Q_CAMERAS = `
query {
  allCameras {
    uuid
    name
  }
}
`;

const Q_APPLICATIONS_FULL = `
query($personClasses: [ObjectClassInput!]!, $preset1: TimeRangePreset!, $preset2: TimeRangePreset!, $preset3: TimeRangePreset!) {
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

      output_stream {
        __typename
      }

      tracks_live {
        __typename
      }

      alarms {
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

        count_live(object_classes: $personClasses) {
          count_in
          count_out
        }

        last1h: count_data(
          time_range: { time_range_preset: $preset1 }
          object_classes: $personClasses
        ) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }

        last12h: count_data(
          time_range: { time_range_preset: $preset2 }
          object_classes: $personClasses
        ) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }

        last1d: count_data(
          time_range: { time_range_preset: $preset3 }
          object_classes: $personClasses
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

        count_live(object_classes: $personClasses) {
          count
        }

        last1h: count_data(
          time_range: { time_range_preset: $preset1 }
          object_classes: $personClasses
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }

        last12h: count_data(
          time_range: { time_range_preset: $preset2 }
          object_classes: $personClasses
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }

        last1d: count_data(
          time_range: { time_range_preset: $preset3 }
          object_classes: $personClasses
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

      output_stream {
        __typename
      }

      detections_live {
        __typename
      }

      alarms {
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

        count_live(object_classes: $personClasses) {
          count
        }

        last1h: count_data(
          time_range: { time_range_preset: $preset1 }
          object_classes: $personClasses
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }

        last12h: count_data(
          time_range: { time_range_preset: $preset2 }
          object_classes: $personClasses
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }

        last1d: count_data(
          time_range: { time_range_preset: $preset3 }
          object_classes: $personClasses
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

      output_stream {
        __typename
      }

      alarms {
        uuid
        name
      }

      last1h: count_data(time_range: { time_range_preset: $preset1 }) {
        time_bucket
        number_of_samples
        count_min
        count_avg
        count_max
      }

      last12h: count_data(time_range: { time_range_preset: $preset2 }) {
        time_bucket
        number_of_samples
        count_min
        count_avg
        count_max
      }

      last1d: count_data(time_range: { time_range_preset: $preset3 }) {
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

const Q_SYSTEM_HEALTH = `
query {
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

    perception_camera_counts_history {
      points { timestamp value }
    }
    perception_camera_initializing_counts_history {
      points { timestamp value }
    }
    perception_camera_offline_counts_history {
      points { timestamp value }
    }
    perception_camera_online_counts_history {
      points { timestamp value }
    }
    perception_camera_paused_counts_history {
      points { timestamp value }
    }
    perception_camera_pending_counts_history {
      points { timestamp value }
    }

    perception_app_counts_history {
      points { timestamp value }
    }
    perception_app_initializing_counts_history {
      points { timestamp value }
    }
    perception_app_offline_counts_history {
      points { timestamp value }
    }
    perception_app_online_counts_history {
      points { timestamp value }
    }
    perception_app_paused_counts_history {
      points { timestamp value }
    }
    perception_app_pending_counts_history {
      points { timestamp value }
    }
  }
}
`;

const Q_FEATURE_FLAGS = `
query {
  getFeatureFlags
}
`;

const Q_LICENSE = `
query {
  getLicense {
    __typename
  }
  getLicenseStatus {
    __typename
  }
}
`;

const Q_MACHINE_FINGERPRINT = `
query {
  getMachineFingerprint
}
`;

const Q_EXPORTS = `
query {
  allExports {
    __typename
  }
}
`;

const Q_SETTINGS = `
query {
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

const Q_VMS = `
query {
  checkCayugaConnection
  checkMilestoneConnection
  checkGenetecConnection
  allCayugaCameras { __typename }
  allMilestoneCameras { __typename }
  allGenetecCameras { __typename }
}
`;

function summarizeLineSeries(series) {
  const rows = toArray(series);
  return {
    buckets: rows.length,
    total_in: sumBy(rows, (x) => x?.count_in),
    total_out: sumBy(rows, (x) => x?.count_out),
    samples: sumBy(rows, (x) => x?.number_of_samples),
    first_bucket: rows[0]?.time_bucket || null,
    last_bucket: rows[rows.length - 1]?.time_bucket || null,
    raw: rows,
  };
}

function summarizeAreaSeries(series) {
  const rows = toArray(series);
  const avgValues = rows
    .map((x) => (x?.count_avg == null ? null : Number(x.count_avg)))
    .filter((x) => Number.isFinite(x));

  return {
    buckets: rows.length,
    min_of_mins: rows.length ? Math.min(...rows.map((x) => Number(x?.count_min ?? Infinity))) : null,
    max_of_maxs: rows.length ? Math.max(...rows.map((x) => Number(x?.count_max ?? -Infinity))) : null,
    avg_of_avgs: avgValues.length
      ? avgValues.reduce((a, b) => a + b, 0) / avgValues.length
      : null,
    samples: sumBy(rows, (x) => x?.number_of_samples),
    first_bucket: rows[0]?.time_bucket || null,
    last_bucket: rows[rows.length - 1]?.time_bucket || null,
    raw: rows,
  };
}

function summarizeObjectFlowApp(app) {
  const lines = toArray(app.lines).map((line) => {
    const live = toArray(line.count_live);
    const liveIn = sumBy(live, (x) => x?.count_in);
    const liveOut = sumBy(live, (x) => x?.count_out);

    return {
      uuid: line.uuid,
      name: line.name,
      tags: toArray(line.tags),
      coordinates: toArray(line.coordinates),
      created_at: line.created_at || null,
      updated_at: line.updated_at || null,

      people_live: {
        entered: liveIn,
        exited: liveOut,
        raw: live,
      },

      people_last_1_hour: summarizeLineSeries(line.last1h),
      people_last_12_hours: summarizeLineSeries(line.last12h),
      people_last_1_day: summarizeLineSeries(line.last1d),
    };
  });

  const areas = toArray(app.areas).map((area) => {
    const live = toArray(area.count_live);
    const liveCount = sumBy(live, (x) => x?.count);

    return {
      uuid: area.uuid,
      name: area.name,
      tags: toArray(area.tags),
      coordinates: toArray(area.coordinates),
      created_at: area.created_at || null,
      updated_at: area.updated_at || null,

      people_live: {
        count: liveCount,
        raw: live,
      },

      people_last_1_hour: summarizeAreaSeries(area.last1h),
      people_last_12_hours: summarizeAreaSeries(area.last12h),
      people_last_1_day: summarizeAreaSeries(area.last1d),
    };
  });

  const totals = {
    lines_live_entered: sumBy(lines, (x) => x.people_live.entered),
    lines_live_exited: sumBy(lines, (x) => x.people_live.exited),
    lines_last_1_hour_entered: sumBy(lines, (x) => x.people_last_1_hour.total_in),
    lines_last_1_hour_exited: sumBy(lines, (x) => x.people_last_1_hour.total_out),
    lines_last_12_hours_entered: sumBy(lines, (x) => x.people_last_12_hours.total_in),
    lines_last_12_hours_exited: sumBy(lines, (x) => x.people_last_12_hours.total_out),
    lines_last_1_day_entered: sumBy(lines, (x) => x.people_last_1_day.total_in),
    lines_last_1_day_exited: sumBy(lines, (x) => x.people_last_1_day.total_out),
    areas_live_people: sumBy(areas, (x) => x.people_live.count),
  };

  return {
    type: 'ObjectFlow',
    uuid: app.uuid,
    name: app.name,
    tags: toArray(app.tags),
    status: app.status || null,
    last_online: app.last_online || null,
    created_at: app.created_at || null,
    updated_at: app.updated_at || null,
    default_model_settings: app.default_model_settings,
    camera: app.camera || null,
    model: app.model || null,
    output_stream: app.output_stream || null,
    tracks_live: toArray(app.tracks_live),
    alarms: toArray(app.alarms),
    totals,
    lines,
    areas,
    always_report_people_entered_exited: {
      live_entered: totals.lines_live_entered,
      live_exited: totals.lines_live_exited,
      last_1_hour_entered: totals.lines_last_1_hour_entered,
      last_1_hour_exited: totals.lines_last_1_hour_exited,
      last_12_hours_entered: totals.lines_last_12_hours_entered,
      last_12_hours_exited: totals.lines_last_12_hours_exited,
      last_1_day_entered: totals.lines_last_1_day_entered,
      last_1_day_exited: totals.lines_last_1_day_exited,
    },
  };
}

function summarizeObjectCountApp(app) {
  const areas = toArray(app.areas).map((area) => {
    const live = toArray(area.count_live);
    const liveCount = sumBy(live, (x) => x?.count);

    return {
      uuid: area.uuid,
      name: area.name,
      tags: toArray(area.tags),
      coordinates: toArray(area.coordinates),
      created_at: area.created_at || null,
      updated_at: area.updated_at || null,

      people_live: {
        count: liveCount,
        raw: live,
      },

      people_last_1_hour: summarizeAreaSeries(area.last1h),
      people_last_12_hours: summarizeAreaSeries(area.last12h),
      people_last_1_day: summarizeAreaSeries(area.last1d),
    };
  });

  const totals = {
    areas_live_people: sumBy(areas, (x) => x.people_live.count),
  };

  return {
    type: 'ObjectCount',
    uuid: app.uuid,
    name: app.name,
    tags: toArray(app.tags),
    status: app.status || null,
    last_online: app.last_online || null,
    created_at: app.created_at || null,
    updated_at: app.updated_at || null,
    default_model_settings: app.default_model_settings,
    camera: app.camera || null,
    model: app.model || null,
    output_stream: app.output_stream || null,
    detections_live: toArray(app.detections_live),
    alarms: toArray(app.alarms),
    totals,
    areas,
    always_report_people_entered_exited: {
      live_entered: 0,
      live_exited: 0,
      last_1_hour_entered: 0,
      last_1_hour_exited: 0,
      last_12_hours_entered: 0,
      last_12_hours_exited: 0,
      last_1_day_entered: 0,
      last_1_day_exited: 0,
      note: 'ObjectCount does not expose line-based in/out in the discovered schema.',
    },
  };
}

function summarizeCrowdCountApp(app) {
  return {
    type: 'CrowdCount',
    uuid: app.uuid,
    name: app.name,
    tags: toArray(app.tags),
    status: app.status || null,
    last_online: app.last_online || null,
    created_at: app.created_at || null,
    updated_at: app.updated_at || null,
    current_count: app.current_count ?? null,
    box: pick(app, ['box_u1', 'box_v1', 'box_u2', 'box_v2']),
    camera: app.camera || null,
    model: app.model || null,
    output_stream: app.output_stream || null,
    alarms: toArray(app.alarms),
    people_last_1_hour: summarizeAreaSeries(app.last1h),
    people_last_12_hours: summarizeAreaSeries(app.last12h),
    people_last_1_day: summarizeAreaSeries(app.last1d),
    always_report_people_entered_exited: {
      live_entered: 0,
      live_exited: 0,
      last_1_hour_entered: 0,
      last_1_hour_exited: 0,
      last_12_hours_entered: 0,
      last_12_hours_exited: 0,
      last_1_day_entered: 0,
      last_1_day_exited: 0,
      note: 'CrowdCount exposes occupancy/current_count, not directional in/out in the discovered schema.',
    },
  };
}

function buildTopLevelSummary(apps, cameras) {
  const objectFlowApps = apps.filter((x) => x.type === 'ObjectFlow');
  const objectCountApps = apps.filter((x) => x.type === 'ObjectCount');
  const crowdCountApps = apps.filter((x) => x.type === 'CrowdCount');

  return {
    generated_at: nowIso(),
    counts: {
      cameras: toArray(cameras).length,
      applications_total: apps.length,
      objectflow_applications: objectFlowApps.length,
      objectcount_applications: objectCountApps.length,
      crowdcount_applications: crowdCountApps.length,
    },
    people: {
      live_entered_total: sumBy(objectFlowApps, (x) => x.always_report_people_entered_exited.live_entered),
      live_exited_total: sumBy(objectFlowApps, (x) => x.always_report_people_entered_exited.live_exited),
      last_1_hour_entered_total: sumBy(objectFlowApps, (x) => x.always_report_people_entered_exited.last_1_hour_entered),
      last_1_hour_exited_total: sumBy(objectFlowApps, (x) => x.always_report_people_entered_exited.last_1_hour_exited),
      last_12_hours_entered_total: sumBy(objectFlowApps, (x) => x.always_report_people_entered_exited.last_12_hours_entered),
      last_12_hours_exited_total: sumBy(objectFlowApps, (x) => x.always_report_people_entered_exited.last_12_hours_exited),
      last_1_day_entered_total: sumBy(objectFlowApps, (x) => x.always_report_people_entered_exited.last_1_day_entered),
      last_1_day_exited_total: sumBy(objectFlowApps, (x) => x.always_report_people_entered_exited.last_1_day_exited),
      live_people_in_objectcount_areas: sumBy(objectCountApps, (x) => x.totals.areas_live_people),
      live_people_in_objectflow_areas: sumBy(objectFlowApps, (x) => x.totals.areas_live_people),
      live_people_in_crowdcount: sumBy(crowdCountApps, (x) => x.current_count),
    },
  };
}

async function collectAllData() {
  const variables = {
    personClasses: [{ name: CONFIG.defaultPersonClassName }],
    preset1: CONFIG.defaultTimePresets[0] || 'LAST_1_HOUR',
    preset2: CONFIG.defaultTimePresets[1] || 'LAST_12_HOUR',
    preset3: CONFIG.defaultTimePresets[2] || 'LAST_1_DAY',
  };

  const [
    schemaRootRes,
    schemaTypesRes,
    camerasRes,
    appsRes,
    healthRes,
    flagsRes,
    licenseRes,
    fingerprintRes,
    exportsRes,
    settingsRes,
    vmsRes,
  ] = await Promise.all([
    graphqlData(Q_SCHEMA_ROOT),
    graphqlData(Q_SCHEMA_TYPES),
    graphqlData(Q_CAMERAS),
    graphqlData(Q_APPLICATIONS_FULL, variables),
    graphqlData(Q_SYSTEM_HEALTH),
    graphqlData(Q_FEATURE_FLAGS),
    graphqlData(Q_LICENSE),
    graphqlData(Q_MACHINE_FINGERPRINT),
    graphqlData(Q_EXPORTS),
    graphqlData(Q_SETTINGS),
    graphqlData(Q_VMS),
  ]);

  const rawApps = toArray(appsRes.data?.allApplications);
  const applications = rawApps.map((app) => {
    if (app.__typename === 'ObjectFlow') return summarizeObjectFlowApp(app);
    if (app.__typename === 'ObjectCount') return summarizeObjectCountApp(app);
    if (app.__typename === 'CrowdCount') return summarizeCrowdCountApp(app);
    return {
      type: app.__typename || 'Unknown',
      raw: app,
      always_report_people_entered_exited: {
        live_entered: 0,
        live_exited: 0,
        last_1_hour_entered: 0,
        last_1_hour_exited: 0,
        last_12_hours_entered: 0,
        last_12_hours_exited: 0,
        last_1_day_entered: 0,
        last_1_day_exited: 0,
      },
    };
  });

  const cameras = toArray(camerasRes.data?.allCameras);
  const summary = buildTopLevelSummary(applications, cameras);

  return {
    ok: true,
    generated_at: nowIso(),
    config: {
      baseUrl: CONFIG.baseUrl,
      graphqlPath: CONFIG.graphqlPath,
      personClass: CONFIG.defaultPersonClassName,
      timePresets: variables,
      verifyTls: CONFIG.verifyTls,
    },
    summary,
    schema: {
      root: schemaRootRes.data?.__schema || null,
      types: schemaTypesRes.data?.__schema?.types || [],
    },
    inventory: {
      cameras,
      applications,
    },
    operations: {
      system_health: healthRes.data?.getSystemHealth || null,
      feature_flags: flagsRes.data?.getFeatureFlags || null,
      license: {
        getLicense: licenseRes.data?.getLicense || null,
        getLicenseStatus: licenseRes.data?.getLicenseStatus || null,
      },
      machine_fingerprint: fingerprintRes.data?.getMachineFingerprint || null,
      exports: exportsRes.data?.allExports || null,
      settings: settingsRes.data || null,
      vms: vmsRes.data || null,
    },
    people_always_reported: {
      entered_exited_totals: summary.people,
      note:
        'Directional entered/exited is always computed from ObjectFlow lines where available; ObjectCount/CrowdCount do not expose directional in/out in the discovered schema.',
    },
    errors: {
      schemaRoot: schemaRootRes.errors,
      schemaTypes: schemaTypesRes.errors,
      cameras: camerasRes.errors,
      applications: appsRes.errors,
      systemHealth: healthRes.errors,
      featureFlags: flagsRes.errors,
      license: licenseRes.errors,
      machineFingerprint: fingerprintRes.errors,
      exports: exportsRes.errors,
      settings: settingsRes.errors,
      vms: vmsRes.errors,
    },
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, {
      service: 'isarsoft-dashboard-proxy',
      generated_at: nowIso(),
      endpoints: {
        health: '/health',
        data: '/data',
        summary: '/summary',
        applications: '/applications',
        cameras: '/cameras',
      },
    });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, time: nowIso() });
  }

  if (req.method === 'GET' && url.pathname === '/data') {
    try {
      const data = await collectAllData();
      return sendJson(res, 200, data);
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        error: error.message,
        time: nowIso(),
      });
    }
  }

  if (req.method === 'GET' && url.pathname === '/summary') {
    try {
      const data = await collectAllData();
      return sendJson(res, 200, {
        ok: true,
        generated_at: data.generated_at,
        summary: data.summary,
        people_always_reported: data.people_always_reported,
      });
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        error: error.message,
        time: nowIso(),
      });
    }
  }

  if (req.method === 'GET' && url.pathname === '/applications') {
    try {
      const data = await collectAllData();
      return sendJson(res, 200, {
        ok: true,
        generated_at: data.generated_at,
        applications: data.inventory.applications,
      });
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        error: error.message,
        time: nowIso(),
      });
    }
  }

  if (req.method === 'GET' && url.pathname === '/cameras') {
    try {
      const data = await collectAllData();
      return sendJson(res, 200, {
        ok: true,
        generated_at: data.generated_at,
        cameras: data.inventory.cameras,
      });
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        error: error.message,
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
        time: nowIso(),
      },
      null,
      2
    )
  );
});