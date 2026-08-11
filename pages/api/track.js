// Litper Guides — Tracking API
// Carrier detection by guide prefix:
//   014.../0014.../114.../0114... → Interrapidísimo  (API propia)
//   363...                        → Coordinadora      (EnvioClick idCarrier: 14)
//   615.../616...                 → TCC               (EnvioClick idCarrier: 44)
//   034...                        → Envia             (EnvioClick idCarrier: 28)

const ENVIOCLICK_TOKEN = process.env.ENVIOCLICK_TOKEN || 'ce156067-9edc-4cf2-80d1-5b5497d6e625';
const ENVIOCLICK_URL   = 'https://landing.envioclickpro.com/carriers/tracking-batch';
const INTER_API_URL    = 'https://www.interrapidisimo.com/api/search_guia';

const CARRIER_CONFIG = {
  interrapidisimo: {
    name: 'Interrapidísimo',
    url:  n => `https://www.interrapidisimo.com/`,
  },
  coordinadora: {
    id:  14,
    name: 'Coordinadora',
    url:  n => `https://www.coordinadora.com/portafolio-de-servicios/servicios-en-linea/rastrear-guias/?guia=${n}`,
  },
  tcc: {
    id:  44,
    name: 'TCC',
    url:  n => `https://www.tcc.com.co/rastreo?numero=${n}`,
  },
  envia: {
    id:  28,
    name: 'Envía',
    url:  n => `https://www.envia.co/rastreo?numero=${n}`,
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

// ─── Interrapidísimo direct API ───────────────────────────────────────────────
// POST https://www.interrapidisimo.com/api/search_guia
// Body: { "NumerosGuias": "014XXX,014YYY" }
async function queryInterrapidisimo(trackingCodes) {
  const body = { NumerosGuias: trackingCodes.join(',') };
  const res = await fetch(INTER_API_URL, {
    method:  'POST',
    headers: {
      'content-type': 'application/json',
      'accept':       'application/json',
      'user-agent':   'Mozilla/5.0 (compatible; LitperBot/1.0)',
      'origin':       'https://www.interrapidisimo.com',
      'referer':      'https://www.interrapidisimo.com/',
    },
    body:   JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  // 404 or error body → guide not found (not a transport error)
  if (res.status === 404) {
    const j = await res.json().catch(() => ({}));
    return { notFound: true, message: j.error || 'Guía no encontrada' };
  }
  if (!res.ok) {
    throw new Error(`Interrapidísimo HTTP ${res.status}`);
  }

  const data = await res.json();
  return { notFound: false, data };
}

// Parse Inter's success response into a normalized events array.
// The exact format is unknown for confirmed deliveries; we handle defensively.
// Known patterns from Next.js carrier APIs:
//   - Array of objects with { estado, fecha, ciudad, descripcion }
//   - Single object with a "guias" or "eventos" key
function parseInterEvents(data, guideNum) {
  if (!data) return null;

  // If it's an array directly
  if (Array.isArray(data)) {
    return data.map(e => ({
      eventDescription: e.estado || e.descripcion || e.description || e.eventDescription || String(e),
      eventPlace:       e.ciudad  || e.city        || e.place       || '',
      eventDateTime:    e.fecha   || e.date        || e.dateTime    || e.eventDateTime  || '',
    }));
  }

  // If it's an object keyed by guide number
  if (data[guideNum] && Array.isArray(data[guideNum])) {
    return parseInterEvents(data[guideNum], guideNum);
  }

  // If it has a guias / eventos / events array
  const arr = data.guias || data.eventos || data.events || data.tracking || data.resultado;
  if (Array.isArray(arr)) {
    return parseInterEvents(arr, guideNum);
  }

  // Single object — treat as a single event
  if (typeof data === 'object' && Object.keys(data).length > 0) {
    return [{
      eventDescription: data.estado || data.descripcion || data.description || 'Guía localizada',
      eventPlace:       data.ciudad  || data.city        || '',
      eventDateTime:    data.fecha   || data.date        || '',
    }];
  }

  return null;
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
  if (!res.ok) throw new Error(`EnvioClick HTTP ${res.status} para ${cfg.name}`);
  return res.json();
}

// ─── Status normalizer ────────────────────────────────────────────────────────
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

  return { litperStatus: d.toUpperCase().substring(0, 40), semaforo: 'yellow', priority: 25 };
}

// ─── Days since last event ────────────────────────────────────────────────────
function computeDays(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr.replace(' ', 'T'));
    if (isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  } catch {
    return null;
  }
}

// ─── Build result object ──────────────────────────────────────────────────────
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

// ─── Process Interrapidísimo guides ──────────────────────────────────────────
async function processInter(guideNums, phoneMap) {
  const results = [];
  try {
    const resp = await queryInterrapidisimo(guideNums);

    if (resp.notFound) {
      // API returned 404 for the entire batch (all guides unknown)
      for (const num of guideNums) {
        results.push({
          number:       num,
          phone:        phoneMap[num] || '',
          carrier:      CARRIER_CONFIG.interrapidisimo.name,
          carrierUrl:   CARRIER_CONFIG.interrapidisimo.url(num),
          litperStatus: 'NO ENCONTRADA',
          semaforo:     'gray',
          priority:     80,
          description:  resp.message,
          city:         '',
          days:         null,
          template:     null,
          ticketText:   null,
        });
      }
      return results;
    }

    // Try to parse per-guide results from the response
    for (const num of guideNums) {
      // Inter may return a per-guide keyed object or a flat array
      let eventsRaw = null;

      if (resp.data) {
        if (resp.data[num]) {
          eventsRaw = parseInterEvents(resp.data[num], num);
        } else if (Array.isArray(resp.data)) {
          // Filter events for this guide (if data is a flat array)
          const filtered = resp.data.filter(e =>
            (e.guia || e.guide || e.numero || '') === num
          );
          eventsRaw = filtered.length > 0
            ? parseInterEvents(filtered, num)
            : parseInterEvents(resp.data, num); // use all if can't filter
        } else {
          eventsRaw = parseInterEvents(resp.data, num);
        }
      }

      results.push(buildResult(num, phoneMap[num] || '', 'interrapidisimo', eventsRaw, false));
    }
  } catch (err) {
    // Transport/network error — mark all guides as error
    for (const num of guideNums) {
      results.push({
        number:       num,
        phone:        phoneMap[num] || '',
        carrier:      CARRIER_CONFIG.interrapidisimo.name,
        carrierUrl:   CARRIER_CONFIG.interrapidisimo.url(num),
        litperStatus: 'ERROR API',
        semaforo:     'gray',
        priority:     95,
        description:  err.message || 'Error consultando Interrapidísimo',
        city:         '',
        days:         null,
        template:     null,
        ticketText:   null,
      });
    }
  }
  return results;
}

// ─── Process EnvioClick carriers ─────────────────────────────────────────────
async function processEnvioClick(carrierKey, guideNums, phoneMap) {
  const results = [];
  const cfg = CARRIER_CONFIG[carrierKey];

  try {
    const data = await queryEnvioClick(carrierKey, guideNums);
    const events        = data?.data?.events        || {};
    const withoutEvents = data?.data?.without_events || {};

    for (const num of guideNums) {
      const evList    = events[num] || null;
      const isWithout = num in withoutEvents;
      results.push(buildResult(num, phoneMap[num] || '', carrierKey, evList, isWithout));
    }
  } catch (err) {
    for (const num of guideNums) {
      results.push({
        number:       num,
        phone:        phoneMap[num] || '',
        carrier:      cfg.name,
        carrierUrl:   cfg.url(num),
        litperStatus: 'ERROR API',
        semaforo:     'gray',
        priority:     95,
        description:  err.message || `Error consultando ${cfg.name}`,
        city:         '',
        days:         null,
        template:     null,
        ticketText:   null,
      });
    }
  }
  return results;
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
  const phoneMap  = {};
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

  // Query all carriers concurrently
  const promises = [];

  if (groups.interrapidisimo.length > 0) {
    promises.push(processInter(groups.interrapidisimo, phoneMap));
  }
  for (const key of ['coordinadora', 'tcc', 'envia']) {
    if (groups[key].length > 0) {
      promises.push(processEnvioClick(key, groups[key], phoneMap));
    }
  }

  const settled = await Promise.all(promises);
  const results = settled.flat();

  // Unknown carrier
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
