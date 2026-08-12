// Litper Guides — Tracking API
// Carrier detection by guide prefix:
//   014.../0014.../114.../0114... → Interrapidísimo  (EnvioClick idCarrier: 28)
//   363...                        → Coordinadora      (EnvioClick idCarrier: 14)
//   615.../616...                 → TCC               (EnvioClick idCarrier: 44)
//   034...                        → Envía             (EnvioClick idCarrier: 28)
//   240...                        → Servientrega      (portal SeguridadRastreoWeb)
//
// NOTE: Inter and Envía share the same EnvioClick carrier id (28). EnvioClick
// retains data 30+ days vs Inter's own API which purges in <7 days.

const ENVIOCLICK_TOKEN = process.env.ENVIOCLICK_TOKEN || 'ce156067-9edc-4cf2-80d1-5b5497d6e625';
const ENVIOCLICK_URL   = 'https://landing.envioclickpro.com/carriers/tracking-batch';
const SVTE_BASE        = 'https://www.servientrega.com';
const SVTE_REGISTER    = `${SVTE_BASE}/SeguridadRastreoWeb/RegistroRastreo`;
const SVTE_READ        = `${SVTE_BASE}/SeguridadRastreoWeb/LecturaRastreo`;

const CARRIER_CONFIG = {
  interrapidisimo: {
    id:   28,
    name: 'Interrapidísimo',
    url:  n => `https://www.interrapidisimo.com/rastreo?guia=${n}`,
  },
  coordinadora: {
    id:   14,
    name: 'Coordinadora',
    url:  n => `https://www.coordinadora.com/portafolio-de-servicios/servicios-en-linea/rastrear-guias/?guia=${n}`,
  },
  tcc: {
    id:   44,
    name: 'TCC',
    url:  n => `https://www.tcc.com.co/rastreo?numero=${n}`,
  },
  envia: {
    id:   28,
    name: 'Envía',
    url:  n => `https://www.envia.co/rastreo?numero=${n}`,
  },
  servientrega: {
    name: 'Servientrega',
    url:  n => `${SVTE_BASE}/wps/portal/rastreo-envio/detalle?id=${n}&tipo=0`,
  },
};

// ─── Carrier detection ────────────────────────────────────────────────────────
function detectCarrier(num) {
  const n = num.replace(/\s/g, '');
  if (/^(014|0014|114|0114)/.test(n)) return 'interrapidisimo';
  if (/^363/.test(n))                 return 'coordinadora';
  if (/^(615|616)/.test(n))           return 'tcc';
  if (/^034/.test(n))                 return 'envia';
  if (/^240/.test(n))                 return 'servientrega';
  return 'unknown';
}

// ─── Servientrega two-step cookie API ────────────────────────────────────────
async function queryServientrega(guideNum) {
  const regRes = await fetch(SVTE_REGISTER, {
    method: 'GET',
    headers: {
      'tracknumber': guideNum,
      'tracktype':   '0',
      'captcha':     'false',
      'user-agent':  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'referer':     `${SVTE_BASE}/wps/portal/rastreo-envio/detalle?id=${guideNum}&tipo=0`,
      'accept':      'application/xml, text/xml, */*',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!regRes.ok) throw new Error(`Servientrega RegistroRastreo HTTP ${regRes.status}`);

  const setCookie   = regRes.headers.get('set-cookie') || '';
  const cookieMatch = setCookie.match(/JSESSIONID=([^;,\s]+)/i);
  if (!cookieMatch) throw new Error('Servientrega: no JSESSIONID en respuesta');
  const jsessionId = cookieMatch[1];

  const readRes = await fetch(SVTE_READ, {
    method: 'GET',
    headers: {
      'cookie':     `JSESSIONID=${jsessionId}`,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'referer':    `${SVTE_BASE}/wps/portal/rastreo-envio/detalle?id=${guideNum}&tipo=0`,
      'accept':     'application/xml, text/xml, */*',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!readRes.ok) throw new Error(`Servientrega LecturaRastreo HTTP ${readRes.status}`);
  return readRes.text();
}

// Parse Servientrega XML — returns null if guide not found / no events
function parseServientregaXml(xml) {
  if (!xml || typeof xml !== 'string') return null;
  if (!/<evento[\s>]/i.test(xml)) return null;

  const events = [];
  const eventoRegex = /<evento[^>]*>([\s\S]*?)<\/evento>/gi;
  let match;

  while ((match = eventoRegex.exec(xml)) !== null) {
    const block  = match[1];
    const getTag = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };
    const fecha  = getTag('fecha')  || getTag('date')        || getTag('fechaEvento');
    const hora   = getTag('hora')   || getTag('hour')        || getTag('horaEvento') || getTag('time');
    const estado = getTag('estado') || getTag('descripcion') || getTag('description') || getTag('evento') || getTag('nombre');
    const ciudad = getTag('ciudad') || getTag('city')        || getTag('oficina')     || getTag('sede')   || getTag('sucursal');
    if (!estado) continue;
    events.push({
      eventDescription: estado,
      eventPlace:       ciudad,
      eventDateTime:    fecha ? `${fecha}${hora ? ' ' + hora : ''}` : '',
    });
  }
  return events.length > 0 ? events : null;
}

// ─── EnvioClick batch query ───────────────────────────────────────────────────
async function queryEnvioClick(carrierId, trackingCodes) {
  const res = await fetch(ENVIOCLICK_URL, {
    method: 'POST',
    headers: {
      'authorization': ENVIOCLICK_TOKEN,
      'content-type':  'application/json',
      'referer':       'https://www.envioclick.com/',
    },
    body: JSON.stringify({
      idCarrier:     carrierId,
      trackingCodes: trackingCodes,
      showEvent:     true,
      countryCode:   'CO',
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`EnvioClick HTTP ${res.status}`);
  return res.json();
}

// ─── Status normalizer ────────────────────────────────────────────────────────
function normalizeStatus(description) {
  if (!description) return { litperStatus: 'DESCONOCIDO', semaforo: 'gray', priority: 50 };
  const d = description.toLowerCase().trim();

  if (d.includes('entregad') || d.includes('entrega exitosa') ||
      d.includes('envio entregado') || d.includes('envío entregado') || d === 'delivered') {
    return { litperStatus: 'ENTREGADO', semaforo: 'green', priority: 1 };
  }
  if (d.includes('no se entrega') || d.includes('no entregad') || d.includes('devuelt') ||
      d.includes('devolver') || d.includes('cancelad') || d.includes('perdid') ||
      d.includes('rechazad') || d.includes('no encontrad') || d.includes('dirección incorrecta') ||
      d.includes('cliente no encontrad') || d.includes('ausente') || d.includes('novedad')) {
    return { litperStatus: 'NOVEDAD', semaforo: 'red', priority: 10 };
  }
  if (d.includes('reparto') || d.includes('en transporte') || d.includes('en terminal') ||
      d.includes('en bodega') || d.includes('recogid') || d.includes('en proceso') ||
      d.includes('en recolección') || d.includes('en ruta') || d.includes('salida a ruta') ||
      d.includes('en camino') || d.includes('en distribución') || d.includes('recibid') ||
      d.includes('clasificad') || d.includes('en destino') || d.includes('en planta') ||
      d.includes('en centro') || d.includes('admitid') || d.includes('ingresad') ||
      d.includes('programado') || d.includes('captura') || d.includes('recolección')) {
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
  } catch { return null; }
}

// ─── Build result object ──────────────────────────────────────────────────────
function buildResult(guideNum, carrierKey, events, phone) {
  const cfg = CARRIER_CONFIG[carrierKey] || {};
  const latest = events && events.length > 0 ? events[0] : null;
  const desc = latest ? (latest.eventDescription || '') : '';
  const { litperStatus, semaforo, priority } = normalizeStatus(desc);
  const days = computeDays(latest ? latest.eventDateTime : null);

  return {
    guideNumber:      guideNum,
    carrier:          cfg.name || carrierKey,
    trackingUrl:      cfg.url ? cfg.url(guideNum) : null,
    phone:            phone || null,
    litperStatus,
    semaforo,
    priority,
    lastEvent:        latest || null,
    allEvents:        events || [],
    daysSinceUpdate:  days,
  };
}

// ─── Process Servientrega guides ──────────────────────────────────────────────
async function processServientrega(guides, phoneMap) {
  return Promise.all(guides.map(async (num) => {
    try {
      const xml    = await queryServientrega(num);
      const events = parseServientregaXml(xml);
      if (!events) {
        return buildResult(num, 'servientrega', null, phoneMap[num]);
      }
      return buildResult(num, 'servientrega', events, phoneMap[num]);
    } catch (err) {
      console.error(`Servientrega error ${num}:`, err.message);
      return buildResult(num, 'servientrega', null, phoneMap[num]);
    }
  }));
}

// ─── Process EnvioClick carriers (Coordinadora, TCC, Envía, Inter) ───────────
async function processEnvioClick(carrierKey, guides, phoneMap) {
  const { id: carrierId } = CARRIER_CONFIG[carrierKey];
  const trackingCodes = guides;
  try {
    const data = await queryEnvioClick(carrierId, trackingCodes);
    // EnvioClick returns an array of tracking results
    const resultsMap = {};
    const items = Array.isArray(data) ? data : (data.data || data.results || []);
    for (const item of items) {
      const code = item.trackingCode || item.guia || item.tracking_code || item.numero;
      if (!code) continue;
      const eventsList = item.events || item.eventos || item.event || [];
      const events = eventsList.map(e => ({
        eventDescription: e.description || e.descripcion || e.estado || e.status || e.evento || '',
        eventPlace:       e.city || e.ciudad || e.office || e.oficina || '',
        eventDateTime:    e.date || e.fecha || e.dateTime || e.timestamp || '',
      })).filter(e => e.eventDescription);
      // Sort newest-first if we have dates
      resultsMap[code] = events;
    }
    return guides.map(num => {
      const events = resultsMap[num] || null;
      return buildResult(num, carrierKey, events, phoneMap[num]);
    });
  } catch (err) {
    console.error(`EnvioClick error (${carrierKey}):`, err.message);
    return guides.map(num => buildResult(num, carrierKey, null, phoneMap[num]));
  }
}

// ─── Main API handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Accept both GET ?guides=... and POST { guides: [...] }
  let rawGuides, rawPhones;
  if (req.method === 'POST') {
    rawGuides = req.body?.guides;
    rawPhones = req.body?.phones;
  } else {
    rawGuides = req.query?.guides;
    rawPhones = req.query?.phones;
  }

  if (!rawGuides) {
    return res.status(400).json({ error: 'Missing guides parameter' });
  }

  const guides = (Array.isArray(rawGuides) ? rawGuides : rawGuides.split(','))
    .map(g => g.trim())
    .filter(Boolean);

  const phones = rawPhones
    ? (Array.isArray(rawPhones) ? rawPhones : rawPhones.split(','))
    : [];

  // Build guide→phone map
  const phoneMap = {};
  guides.forEach((g, i) => { phoneMap[g] = phones[i] || null; });

  if (guides.length === 0) {
    return res.status(400).json({ error: 'No valid guide numbers provided' });
  }
  if (guides.length > 100) {
    return res.status(400).json({ error: 'Maximum 100 guides per request' });
  }

  // Group guides by carrier
  const groups = { interrapidisimo: [], coordinadora: [], tcc: [], envia: [], servientrega: [], unknown: [] };
  for (const g of guides) {
    const carrier = detectCarrier(g);
    groups[carrier].push(g);
  }

  const promises = [];

  // EnvioClick carriers — all go through the same batch endpoint (including Inter)
  for (const key of ['interrapidisimo', 'coordinadora', 'tcc', 'envia']) {
    if (groups[key].length > 0) {
      promises.push(processEnvioClick(key, groups[key], phoneMap));
    }
  }

  // Servientrega — its own portal
  if (groups.servientrega.length > 0) {
    promises.push(processServientrega(groups.servientrega, phoneMap));
  }

  // Unknown guides
  const unknownResults = groups.unknown.map(num => ({
    guideNumber:  num,
    carrier:      'Desconocida',
    trackingUrl:  null,
    phone:        phoneMap[num] || null,
    litperStatus: 'TRANSPORTADORA NO IDENTIFICADA',
    semaforo:     'gray',
    priority:     99,
    lastEvent:    null,
    allEvents:    [],
    daysSinceUpdate: null,
  }));

  try {
    const resultArrays = await Promise.all(promises);
    const all = [...resultArrays.flat(), ...unknownResults];
    // Sort by priority (green=1 → red=10 → yellow=20 → gray=50 → unknown=99)
    all.sort((a, b) => (a.priority || 99) - (b.priority || 99));
    return res.status(200).json({ guides: all, total: all.length });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
