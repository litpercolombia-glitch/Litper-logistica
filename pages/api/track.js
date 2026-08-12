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
//
// EnvioClick response shape:
//   { data: { events: { "GUIDE_NUM": [{eventDateTime, eventDescription, eventPlace},...] } } }

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

function detectCarrier(num) {
  const n = num.replace(/\s/g, '');
  if (/^(014|0014|114|0114)/.test(n)) return 'interrapidisimo';
  if (/^363/.test(n))                 return 'coordinadora';
  if (/^(615|616)/.test(n))           return 'tcc';
  if (/^034/.test(n))                 return 'envia';
  if (/^240/.test(n))                 return 'servientrega';
  return 'unknown';
}

async function queryServientrega(guideNum) {
  const regRes = await fetch(SVTE_REGISTER, {
    method: 'GET',
    headers: {
      'tracknumber': guideNum,
      'tracktype':   '0',
      'captcha':     'false',
      'user-agent':  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0',
      'referer':     `${SVTE_BASE}/wps/portal/rastreo-envio/detalle?id=${guideNum}&tipo=0`,
      'accept':      'application/xml, text/xml, */*',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!regRes.ok) throw new Error(`Servientrega RegistroRastreo HTTP ${regRes.status}`);
  const setCookie = regRes.headers.get('set-cookie') || '';
  const cookieMatch = setCookie.match(/JSESSIONID=([^;,\s]+)/i);
  if (!cookieMatch) throw new Error('Servientrega: no JSESSIONID en respuesta');
  const jsessionId = cookieMatch[1];
  const readRes = await fetch(SVTE_READ, {
    method: 'GET',
    headers: {
      'cookie':     `JSESSIONID=${jsessionId}`,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0',
      'referer':    `${SVTE_BASE}/wps/portal/rastreo-envio/detalle?id=${guideNum}&tipo=0`,
      'accept':     'application/xml, text/xml, */*',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!readRes.ok) throw new Error(`Servientrega LecturaRastreo HTTP ${readRes.status}`);
  return readRes.text();
}

function parseServientregaXml(xml) {
  if (!xml || typeof xml !== 'string') return null;
  if (!/<evento[\s>]/i.test(xml)) return null;
  const events = [];
  const eventoRegex = /<evento[^>]*>([\s\S]*?)<\/evento>/gi;
  let match;
  while ((match = eventoRegex.exec(xml)) !== null) {
    const block = match[1];
    const getTag = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };
    const fecha  = getTag('fecha')  || getTag('date')  || getTag('fechaEvento');
    const hora   = getTag('hora')   || getTag('hour')  || getTag('horaEvento') || getTag('time');
    const estado = getTag('estado') || getTag('descripcion') || getTag('description') || getTag('evento') || getTag('nombre');
    const ciudad = getTag('ciudad') || getTag('city')  || getTag('oficina') || getTag('sede') || getTag('sucursal');
    if (!estado) continue;
    events.push({
      eventDescription: estado,
      eventPlace:       ciudad,
      eventDateTime:    fecha ? `${fecha}${hora ? ' ' + hora : ''}` : '',
    });
  }
  return events.length > 0 ? events : null;
}

async function queryEnvioClick(carrierId, trackingCodes) {
  const res = await fetch(ENVIOCLICK_URL, {
    method: 'POST',
    headers: {
      'authorization': ENVIOCLICK_TOKEN,
      'content-type':  'application/json',
      'referer':       'https://www.envioclick.com/',
    },
    body: JSON.stringify({ idCarrier: carrierId, trackingCodes, showEvent: true, countryCode: 'CO' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`EnvioClick HTTP ${res.status}`);
  return res.json();
}

function normalizeStatus(description) {
  if (!description) return { litperStatus: 'DESCONOCIDO', semaforo: 'gray', priority: 50 };
  const d = description.toLowerCase().trim();

  if (d.includes('entregad') || d.includes('entrega exitosa') ||
      d.includes('envio entregado') || d.includes('envio entregado') || d === 'delivered') {
    return { litperStatus: 'ENTREGADO', semaforo: 'green', priority: 1 };
  }
  if (d.includes('no se entrega') || d.includes('no entregad') || d.includes('devuelt') ||
      d.includes('devolver') || d.includes('cancelad') || d.includes('perdid') ||
      d.includes('rechazad') || d.includes('no encontrad') || d.includes('direccion incorrecta') ||
      d.includes('cliente no encontrad') || d.includes('ausente') || d.includes('novedad')) {
    return { litperStatus: 'NOVEDAD', semaforo: 'red', priority: 10 };
  }
  if (d.includes('reparto') || d.includes('en transporte') || d.includes('en terminal') ||
      d.includes('en bodega') || d.includes('recogid') || d.includes('en proceso') ||
      d.includes('en recoleccion') || d.includes('en ruta') || d.includes('salida a ruta') ||
      d.includes('en camino') || d.includes('en distribucion') || d.includes('recibid') ||
      d.includes('clasificad') || d.includes('en destino') || d.includes('en planta') ||
      d.includes('en centro') || d.includes('admitid') || d.includes('ingresad') ||
      d.includes('programado') || d.includes('captura') || d.includes('recoleccion')) {
    return { litperStatus: 'EN RUTA', semaforo: 'yellow', priority: 20 };
  }
  return { litperStatus: d.toUpperCase().substring(0, 40), semaforo: 'yellow', priority: 25 };
}

function computeDays(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr.replace(' ', 'T'));
    if (isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  } catch { return null; }
}

function buildResult(guideNum, carrierKey, events, phone) {
  const cfg    = CARRIER_CONFIG[carrierKey] || {};
  const latest = events && events.length > 0 ? events[0] : null;
  const desc   = latest ? (latest.eventDescription || '') : '';
  const { litperStatus, semaforo, priority } = normalizeStatus(desc);
  const days   = computeDays(latest ? latest.eventDateTime : null);

  return {
    guideNumber:     guideNum,
    carrier:         cfg.name || carrierKey,
    trackingUrl:     cfg.url ? cfg.url(guideNum) : null,
    phone:           phone || null,
    litperStatus,
    semaforo,
    priority,
    lastEvent:       latest || null,
    allEvents:       events || [],
    daysSinceUpdate: days,
  };
}

async function processServientrega(guides, phoneMap) {
  return Promise.all(guides.map(async (num) => {
    try {
      const xml    = await queryServientrega(num);
      const events = parseServientregaXml(xml);
      return buildResult(num, 'servientrega', events, phoneMap[num]);
    } catch (err) {
      console.error(`Servientrega error ${num}:`, err.message);
      return buildResult(num, 'servientrega', null, phoneMap[num]);
    }
  }));
}

// EnvioClick response: { data: { events: { "GUIDE_NUM": [{eventDateTime, eventDescription, eventPlace},...] } } }
async function processEnvioClick(carrierKey, guides, phoneMap) {
  const { id: carrierId } = CARRIER_CONFIG[carrierKey];
  try {
    const data       = await queryEnvioClick(carrierId, guides);
    const eventsDict = (data.data && data.data.events) ? data.data.events : {};
    return guides.map(num => {
      const eventsList = eventsDict[num] || [];
      const events = eventsList
        .map(e => ({
          eventDescription: e.eventDescription || '',
          eventPlace:       e.eventPlace       || '',
          eventDateTime:    e.eventDateTime    || '',
        }))
        .filter(e => e.eventDescription);
      return buildResult(num, carrierKey, events.length > 0 ? events : null, phoneMap[num]);
    });
  } catch (err) {
    console.error(`EnvioClick error (${carrierKey}):`, err.message);
    return guides.map(num => buildResult(num, carrierKey, null, phoneMap[num]));
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let rawGuides, rawPhones;
  if (req.method === 'POST') {
    rawGuides = req.body?.guides;
    rawPhones = req.body?.phones;
  } else {
    rawGuides = req.query?.guides;
    rawPhones = req.query?.phones;
  }

  if (!rawGuides) return res.status(400).json({ error: 'Missing guides parameter' });

  const guides = (Array.isArray(rawGuides) ? rawGuides : rawGuides.split(','))
    .map(g => g.trim()).filter(Boolean);
  const phones = rawPhones
    ? (Array.isArray(rawPhones) ? rawPhones : rawPhones.split(','))
    : [];

  const phoneMap = {};
  guides.forEach((g, i) => { phoneMap[g] = phones[i] || null; });

  if (guides.length === 0)  return res.status(400).json({ error: 'No valid guide numbers provided' });
  if (guides.length > 100)  return res.status(400).json({ error: 'Maximum 100 guides per request' });

  const groups = { interrapidisimo: [], coordinadora: [], tcc: [], envia: [], servientrega: [], unknown: [] };
  for (const g of guides) groups[detectCarrier(g)].push(g);

  const promises = [];
  for (const key of ['interrapidisimo', 'coordinadora', 'tcc', 'envia']) {
    if (groups[key].length > 0) promises.push(processEnvioClick(key, groups[key], phoneMap));
  }
  if (groups.servientrega.length > 0) promises.push(processServientrega(groups.servientrega, phoneMap));

  const unknownResults = groups.unknown.map(num => ({
    guideNumber: num, carrier: 'Desconocida', trackingUrl: null, phone: phoneMap[num] || null,
    litperStatus: 'TRANSPORTADORA NO IDENTIFICADA', semaforo: 'gray', priority: 99,
    lastEvent: null, allEvents: [], daysSinceUpdate: null,
  }));

  try {
    const resultArrays = await Promise.all(promises);
    const all = [...resultArrays.flat(), ...unknownResults];
    all.sort((a, b) => (a.priority || 99) - (b.priority || 99));
    return res.status(200).json({ guides: all, total: all.length });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
