// Litper Guides — Tracking API via EnvioClick unified batch endpoint
// All 4 Colombian carriers through a single backend (no IP-block issues from Vercel)
//
// Carrier detection by guide prefix:
//   014.../0014.../114.../0114... → Interrapidísimo  (idCarrier: 46)
//   363...                        → Coordinadora      (idCarrier: 14)
//   615.../616...                 → TCC               (idCarrier: 44)
//   034...                        → Envia             (idCarrier: 28)
//
// EnvioClick batch endpoint:
//   POST https://landing.envioclickpro.com/carriers/tracking-batch
//   Headers: authorization: ce156067-9edc-4cf2-80d1-5b5497d6e625
//   Body: { idCarrier, trackingCodes: [...], showEvent: true, countryCode: "CO" }
//   Response: { data: { events: { CODE: [{eventDateTime, eventDescription, eventPlace}] },
//                        without_events: {} } }

const ENVIOCLICK_TOKEN = 'ce156067-9edc-4cf2-80d1-5b5497d6e625';
const ENVIOCLICK_URL   = 'https://landing.envioclickpro.com/carriers/tracking-batch';

const CARRIER_CONFIG = {
  interrapidisimo: { id: 46, name: 'Interrapidísimo' },
  coordinadora:    { id: 14, name: 'Coordinadora'    },
  tcc:             { id: 44, name: 'TCC'             },
  envia:           { id: 28, name: 'Envía'           },
};

// ─── Carrier detection ───────────────────────────────────────────────────────
function detectCarrier(num) {
  const n = num.replace(/\s/g, '');
  if (/^(014|0014|114|0114)/.test(n)) return 'interrapidisimo';
  if (/^363/.test(n))                 return 'coordinadora';
  if (/^(615|616)/.test(n))           return 'tcc';
  if (/^034/.test(n))                 return 'envia';
  return 'unknown';
}

// ─── EnvioClick batch query ───────────────────────────────────────────────────
async function queryEnvioClick(carrierKey, trackingCodes) {
  const cfg = CARRIER_CONFIG[carrierKey];
  const res = await fetch(ENVIOCLICK_URL, {
    method: 'POST',
    headers: {
      'authorization': ENVIOCLICK_TOKEN,
      'content-type':  'application/json',
      'referer':        'https://www.envioclick.com/',
    },
    body: JSON.stringify({
      idCarrier:     cfg.id,
      trackingCodes: trackingCodes,
      showEvent:     true,
      countryCode:   'CO',
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`EnvioClick HTTP ${res.status} for ${cfg.name}`);
  }
  return res.json();
}

// ─── Status normalizer ────────────────────────────────────────────────────────
// Maps Spanish event descriptions to semáforo status
function normalizeStatus(description) {
  if (!description) return { status: 'UNKNOWN', color: 'gray', priority: 50 };

  const d = description.toLowerCase().trim();

  // DELIVERED — verde
  if (
    d.includes('entregad') ||
    d.includes('entrega exitosa') ||
    d.includes('envío entregado') ||
    d === 'delivered'
  ) {
    return { status: 'ENTREGADO', color: 'green', priority: 1 };
  }

  // EXCEPTION / NOVELTY — rojo
  if (
    d.includes('no se entrega') ||
    d.includes('no entregad') ||
    d.includes('devuelt') ||
    d.includes('devolver') ||
    d.includes('cancelad') ||
    d.includes('perdid') ||
    d.includes('rechazad') ||
    d.includes('no encontrad') ||
    d.includes('dirección incorrecta') ||
    d.includes('cliente no encontrad') ||
    d.includes('ausente') ||
    d.includes('novedad')
  ) {
    return { status: 'NOVEDAD', color: 'red', priority: 10 };
  }

  // IN TRANSIT — amarillo
  if (
    d.includes('reparto') ||
    d.includes('en transporte') ||
    d.includes('en terminal') ||
    d.includes('en bodega') ||
    d.includes('recogid') ||
    d.includes('en proceso') ||
    d.includes('en recolección') ||
    d.includes('en ruta') ||
    d.includes('en camino') ||
    d.includes('en distribución') ||
    d.includes('recibid') ||
    d.includes('clasificad') ||
    d.includes('en destino') ||
    d.includes('en planta') ||
    d.includes('en centro') ||
    d.includes('admitid') ||
    d.includes('ingresad')
  ) {
    return { status: 'EN RUTA', color: 'yellow', priority: 20 };
  }

  // Fallback — in transit with unknown specific step
  return { status: d.toUpperCase().substring(0, 40), color: 'yellow', priority: 25 };
}

// ─── Build result object ──────────────────────────────────────────────────────
function buildResult(number, carrierName, events, withoutEvents) {
  // events: array sorted newest-first from EnvioClick, or null if in without_events
  if (!events || events.length === 0) {
    const isWithout = withoutEvents;
    return {
      number,
      carrier:      carrierName,
      status:       isWithout ? 'SIN EVENTOS' : 'ERROR',
      color:        'gray',
      priority:     90,
      lastEvent:    null,
      lastPlace:    '',
      lastDate:     '',
      eventHistory: [],
    };
  }

  const latest = events[0];
  const norm   = normalizeStatus(latest.eventDescription);

  return {
    number,
    carrier:      carrierName,
    status:       norm.status,
    color:        norm.color,
    priority:     norm.priority,
    lastEvent:    latest.eventDescription,
    lastPlace:    latest.eventPlace || '',
    lastDate:     latest.eventDateTime || '',
    eventHistory: events.map(e => ({
      date:        e.eventDateTime,
      description: e.eventDescription,
      place:       e.eventPlace || '',
    })),
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { guides } = req.body;
  if (!Array.isArray(guides) || guides.length === 0) {
    return res.status(400).json({ error: 'Se requiere array de guías' });
  }

  // Normalize and cap at 500
  const normalized = guides
    .slice(0, 500)
    .map(g => String(g.number || g).trim())
    .filter(n => n.length > 0);

  // Group by carrier
  const groups = {
    interrapidisimo: [],
    coordinadora:    [],
    tcc:             [],
    envia:           [],
    unknown:         [],
  };
  for (const num of normalized) {
    groups[detectCarrier(num)].push(num);
  }

  // Query each carrier concurrently (skip empties)
  const carrierKeys = ['interrapidisimo', 'coordinadora', 'tcc', 'envia'];
  const promises = carrierKeys.map(key =>
    groups[key].length > 0
      ? queryEnvioClick(key, groups[key])
          .then(data => ({ key, data, error: null }))
          .catch(err  => ({ key, data: null, error: err.message }))
      : Promise.resolve({ key, data: null, error: null, skipped: true })
  );

  const settled = await Promise.all(promises);

  // Build results array
  const results = [];

  for (const { key, data, error, skipped } of settled) {
    const cfg        = CARRIER_CONFIG[key];
    const guideNums  = groups[key];
    if (skipped || guideNums.length === 0) continue;

    if (error || !data) {
      // Entire carrier failed
      for (const num of guideNums) {
        results.push({
          number:       num,
          carrier:      cfg.name,
          status:       'ERROR API',
          color:        'gray',
          priority:     95,
          lastEvent:    error || 'Error consultando transportadora',
          lastPlace:    '',
          lastDate:     '',
          eventHistory: [],
        });
      }
      continue;
    }

    const events        = data?.data?.events        || {};
    const withoutEvents = data?.data?.without_events || {};

    for (const num of guideNums) {
      const evList    = events[num]        || null;
      const isWithout = num in withoutEvents;
      results.push(buildResult(num, cfg.name, evList, isWithout));
    }
  }

  // Unknown carrier guides
  for (const num of groups.unknown) {
    results.push({
      number:       num,
      carrier:      'Desconocida',
      status:       'TRANSPORTADORA NO RECONOCIDA',
      color:        'gray',
      priority:     100,
      lastEvent:    null,
      lastPlace:    '',
      lastDate:     '',
      eventHistory: [],
    });
  }

  // Sort: exceptions first, then in-transit, then delivered, then gray
  results.sort((a, b) => a.priority - b.priority);

  return res.status(200).json({ guides: results });
}
