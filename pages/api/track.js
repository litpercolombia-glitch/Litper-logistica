// Litper Guides — Tracking API via EnvioClick unified batch endpoint
// Carrier detection by guide prefix:
//   014.../0014.../114.../0114... → Interrapidísimo  (idCarrier: 46)
//   363...                        → Coordinadora      (idCarrier: 14)
//   615.../616...                 → TCC               (idCarrier: 44)
//   034...                        → Envia             (idCarrier: 28)

const ENVIOCLICK_TOKEN = process.env.ENVIOCLICK_TOKEN || 'ce156067-9edc-4cf2-80d1-5b5497d6e625';
const ENVIOCLICK_URL   = 'https://landing.envioclickpro.com/carriers/tracking-batch';

const CARRIER_CONFIG = {
  interrapidisimo: {
    id: 46,
    name: 'Interrapidísimo',
    url: n => `https://www.interrapidisimo.com/seguimiento/?guia=${n}`,
  },
  coordinadora: {
    id: 14,
    name: 'Coordinadora',
    url: n => `https://www.coordinadora.com/portafolio-de-servicios/servicios-en-linea/rastrear-guias/?guia=${n}`,
  },
  tcc: {
    id: 44,
    name: 'TCC',
    url: n => `https://www.tcc.com.co/rastreo?numero=${n}`,
  },
  envia: {
    id: 28,
    name: 'Envía',
    url: n => `https://www.envia.co/rastreo?numero=${n}`,
  },
};

// ─── Carrier detection ────────────────────────────────────────────────────────
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
      'referer':       'https://www.envioclick.com/',
    },
    body: JSON.stringify({
      idCarrier:     cfg.id,
      trackingCodes: trackingCodes,
      showEvent:     true,
      countryCode:   'CO',
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`EnvioClick HTTP ${res.status} for ${cfg.name}`);
  return res.json();
}

// ─── Status normalizer ────────────────────────────────────────────────────────
// Returns { litperStatus, semaforo, priority } — field names the frontend uses
function normalizeStatus(description) {
  if (!description) return { litperStatus: 'DESCONOCIDO', semaforo: 'gray', priority: 50 };

  const d = description.toLowerCase().trim();

  // DELIVERED — verde
  if (
    d.includes('entregad') ||
    d.includes('entrega exitosa') ||
    d.includes('envío entregado') ||
    d === 'delivered'
  ) {
    return { litperStatus: 'ENTREGADO', semaforo: 'green', priority: 1 };
  }

  // EXCEPTION / NOVEDAD — rojo
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
    return { litperStatus: 'NOVEDAD', semaforo: 'red', priority: 10 };
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
    return { litperStatus: 'EN RUTA', semaforo: 'yellow', priority: 20 };
  }

  // Fallback
  return { litperStatus: d.toUpperCase().substring(0, 40), semaforo: 'yellow', priority: 25 };
}

// ─── Days since last event ────────────────────────────────────────────────────
function computeDays(dateStr) {
  if (!dateStr) return null;
  try {
    // EnvioClick sends "YYYY-MM-DD HH:MM:SS" or ISO
    const d = new Date(dateStr.replace(' ', 'T'));
    if (isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  } catch {
    return null;
  }
}

// ─── Build result object ──────────────────────────────────────────────────────
// Field names match exactly what index.js expects
function buildResult(number, phone, carrierKey, events, isWithout) {
  const cfg = CARRIER_CONFIG[carrierKey];

  if (!events || events.length === 0) {
    return {
      number,
      phone:        phone || '',
      carrier:      cfg.name,
      carrierUrl:   cfg.url(number),
      litperStatus: isWithout ? 'SIN EVENTOS' : 'ERROR',
      semaforo:     'gray',
      priority:     90,
      description:  isWithout ? 'Sin eventos registrados' : 'Error al consultar',
      city:         '',
      days:         null,
      template:     null,
      ticketText:   null,
    };
  }

  const latest = events[0];
  const norm   = normalizeStatus(latest.eventDescription);

  return {
    number,
    phone:        phone || '',
    carrier:      cfg.name,
    carrierUrl:   cfg.url(number),
    litperStatus: norm.litperStatus,
    semaforo:     norm.semaforo,
    priority:     norm.priority,
    description:  latest.eventDescription || '',
    city:         latest.eventPlace || '',
    days:         computeDays(latest.eventDateTime),
    template:     null,
    ticketText:   null,
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

  // Preserve phone per guide number
  const phoneMap = {};
  const normalized = [];
  for (const g of guides.slice(0, 500)) {
    const num = String(g.number || g).trim();
    if (!num) continue;
    normalized.push(num);
    if (g.phone) phoneMap[num] = g.phone;
  }

  if (normalized.length === 0) {
    return res.status(400).json({ error: 'No se encontraron guías válidas' });
  }

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

  const results = [];

  for (const { key, data, error, skipped } of settled) {
    const guideNums = groups[key];
    if (skipped || guideNums.length === 0) continue;

    const cfg = CARRIER_CONFIG[key];

    if (error || !data) {
      // Entire carrier query failed
      for (const num of guideNums) {
        results.push({
          number:       num,
          phone:        phoneMap[num] || '',
          carrier:      cfg.name,
          carrierUrl:   cfg.url(num),
          litperStatus: 'ERROR API',
          semaforo:     'gray',
          priority:     95,
          description:  error || 'Error consultando transportadora',
          city:         '',
          days:         null,
          template:     null,
          ticketText:   null,
        });
      }
      continue;
    }

    const events        = data?.data?.events        || {};
    const withoutEvents = data?.data?.without_events || {};

    for (const num of guideNums) {
      const evList    = events[num] || null;
      const isWithout = num in withoutEvents;
      results.push(buildResult(num, phoneMap[num] || '', key, evList, isWithout));
    }
  }

  // Unknown carrier guides
  for (const num of groups.unknown) {
    results.push({
      number:       num,
      phone:        phoneMap[num] || '',
      carrier:      'Desconocida',
      carrierUrl:   '#',
      litperStatus: 'TRANSPORTADORA NO RECONOCIDA',
      semaforo:     'gray',
      priority:     100,
      description:  'Prefijo de guía no reconocido (usar 014/363/615/034)',
      city:         '',
      days:         null,
      template:     null,
      ticketText:   null,
    });
  }

  // Sort: novedades first, en ruta, entregado, gray last
  results.sort((a, b) => a.priority - b.priority);

  return res.status(200).json({ guides: results });
}
