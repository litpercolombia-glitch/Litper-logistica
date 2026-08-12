// Litper Guides — Tracking API
// Carrier detection by guide prefix:
//   014.../0014.../114.../0114... → Interrapidísimo  (API propia)
//   363...                        → Coordinadora      (EnvioClick idCarrier: 14)
//   615.../616...                 → TCC               (EnvioClick idCarrier: 44)
//   034...                        → Envía             (EnvioClick idCarrier: 28)
//   240...                        → Servientrega      (portal SeguridadRastreoWeb)

const ENVIOCLICK_TOKEN = process.env.ENVIOCLICK_TOKEN || 'ce156067-9edc-4cf2-80d1-5b5497d6e625';
const ENVIOCLICK_URL   = 'https://landing.envioclickpro.com/carriers/tracking-batch';
const INTER_API_URL    = 'https://www.interrapidisimo.com/api/search_guia';
const SVTE_BASE        = 'https://www.servientrega.com';
const SVTE_REGISTER    = `${SVTE_BASE}/SeguridadRastreoWeb/RegistroRastreo`;
const SVTE_READ        = `${SVTE_BASE}/SeguridadRastreoWeb/LecturaRastreo`;

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

// ─── Interrapidísimo direct API ───────────────────────────────────────────────
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

function parseInterEvents(data, guideNum) {
  if (!data) return null;

  if (Array.isArray(data)) {
    return data.map(e => ({
      eventDescription: e.estado || e.descripcion || e.description || e.eventDescription || String(e),
      eventPlace:       e.ciudad  || e.city        || e.place       || '',
      eventDateTime:    e.fecha   || e.date        || e.dateTime    || e.eventDateTime  || '',
    }));
  }

  if (data[guideNum] && Array.isArray(data[guideNum])) {
    return parseInterEvents(data[guideNum], guideNum);
  }

  const arr = data.guias || data.eventos || data.events || data.tracking || data.resultado;
  if (Array.isArray(arr)) {
    return parseInterEvents(arr, guideNum);
  }

  if (typeof data === 'object' && Object.keys(data).length > 0) {
    return [{
      eventDescription: data.estado || data.descripcion || data.description || 'Guía localizada',
      eventPlace:       data.ciudad  || data.city        || '',
      eventDateTime:    data.fecha   || data.date        || '',
    }];
  }

  return null;
}

// ─── Servientrega two-step cookie API ────────────────────────────────────────
// Step 1: GET RegistroRastreo with tracknumber/tracktype headers → get JSESSIONID
// Step 2: GET LecturaRastreo with that cookie → returns XML tracking data
async function queryServientrega(guideNum) {
  // Step 1: register guide in server session
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

  if (!regRes.ok) {
    throw new Error(`Servientrega RegistroRastreo HTTP ${regRes.status}`);
  }

  // Extract JSESSIONID from Set-Cookie header
  const setCookie = regRes.headers.get('set-cookie') || '';
  const cookieMatch = setCookie.match(/JSESSIONID=([^;,\s]+)/i);
  if (!cookieMatch) {
    throw new Error('Servientrega: no JSESSIONID en respuesta');
  }
  const jsessionId = cookieMatch[1];

  // Step 2: read tracking XML
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

  if (!readRes.ok) {
    throw new Error(`Servientrega LecturaRastreo HTTP ${readRes.status}`);
  }

  return readRes.text();
}

// Parse Servientrega XML into normalized events array
// Active guide XML expected to contain <evento> elements with fecha, hora, estado, ciudad etc.
// Expired/not-found guide returns only: <trackType>0</trackType><trackNumber>...</trackNumber><captcha>false</captcha>
function parseServientregaXml(xml) {
  if (!xml || typeof xml !== 'string') return null;

  // Detect "not found" — XML has no <evento> or <eventos> tags
  if (!/<evento[\s>]/i.test(xml)) {
    return null; // no events
  }

  const events = [];
  const eventoRegex = /<evento[^>]*>([\s\S]*?)<\/evento>/gi;
  let match;

  while ((match = eventoRegex.exec(xml)) !== null) {
    const block = match[1];

    // Helper: extract text content of a tag (case-insensitive, handles attributes)
    const getTag = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };

    const fecha  = getTag('fecha') || getTag('date') || getTag('fechaEvento');
    const hora   = getTag('hora')  || getTag('hour') || getTag('horaEvento') || getTag('time');
    const estado = getTag('estado') || getTag('descripcion') || getTag('description') || getTag('evento') || getTag('nombre');
    const ciudad = getTag('ciudad') || getTag('city')        || getTag('oficina')     || getTag('sede')   || getTag('sucursal');

    if (!estado) continue; // skip empty events

    events.push({
      eventDescription: estado,
      eventPlace:       ciudad,
      eventDateTime:    fecha ? `${fecha}${hora ? ' ' + hora : ''}` : '',
    });
  }

  return events.length > 0 ? events : null;
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

    for (const num of guideNums) {
      let eventsRaw = null;

      if (resp.data) {
        if (resp.data[num]) {
          eventsRaw = parseInterEvents(resp.data[num], num);
        } else if (Array.isArray(resp.data)) {
          const filtered = resp.data.filter(e =>
            (e.guia || e.guide || e.numero || '') === num
          );
          eventsRaw = filtered.length > 0
            ? parseInterEvents(filtered, num)
            : parseInterEvents(resp.data, num);
        } else {
          eventsRaw = parseInterEvents(resp.data, num);
        }
      }

      results.push(buildResult(num, phoneMap[num] || '', 'interrapidisimo', eventsRaw, false));
    }
  } catch (err) {
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

// ─── Process Servientrega guides ──────────────────────────────────────────────
// Each guide requires its own session (separate cookie per lookup), so we
// run them concurrently with individual requests.
async function processServientrega(guideNums, phoneMap) {
  const promises = guideNums.map(async (num) => {
    try {
      const xml = await queryServientrega(num);
      const events = parseServientregaXml(xml);

      if (!events) {
        // Minimal XML returned → guide expired or not found
        return {
          number:       num,
          phone:        phoneMap[num] || '',
          carrier:      CARRIER_CONFIG.servientrega.name,
          carrierUrl:   CARRIER_CONFIG.servientrega.url(num),
          litperStatus: 'NO ENCONTRADA',
          semaforo:     'gray',
          priority:     80,
          description:  'Guía no encontrada o sin eventos',
          city:         '',
          days:         null,
          template:     null,
          ticketText:   null,
        };
      }

      return buildResult(num, phoneMap[num] || '', 'servientrega', events, false);
    } catch (err) {
      return {
        number:       num,
        phone:        phoneMap[num] || '',
        carrier:      CARRIER_CONFIG.servientrega.name,
        carrierUrl:   CARRIER_CONFIG.servientrega.url(num),
        litperStatus: 'ERROR API',
        semaforo:     'gray',
        priority:     95,
        description:  err.message || 'Error consultando Servientrega',
        city:         '',
        days:         null,
        template:     null,
        ticketText:   null,
      };
    }
  });

  return Promise.all(promises);
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
  const phoneMap   = {};
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
    servientrega:    [],
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
  if (groups.servientrega.length > 0) {
    promises.push(processServientrega(groups.servientrega, phoneMap));
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
      description:  'Prefijo no reconocido. Soportados: 014/363/615/034/240',
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
