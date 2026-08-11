// pages/api/track.js
// Direct carrier APIs — no 17track dependency
// Guide prefix routing:
//   014.../114... → Interrapidísimo  (batches ≤5, must be 12 digits)
//   363...        → Coordinadora     (bulk, up to 1000)
//   615/616...    → TCC              (one at a time)
//   034...        → Envia            (batch)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { guides } = req.body;
  if (!Array.isArray(guides) || guides.length === 0) {
    return res.status(400).json({ error: 'Se requiere array de guías' });
  }

  const MAX_TOTAL = 500;
  const normalized = guides.slice(0, MAX_TOTAL).map(g => ({
    number: String(g.number || g).trim(),
    phone: String(g.phone || '').trim(),
  }));

  // Group by carrier key
  const groups = { interrapidisimo: [], coordinadora: [], tcc: [], envia: [], unknown: [] };
  for (const g of normalized) {
    groups[detectCarrierKey(g.number)].push(g);
  }

  // Query all carriers concurrently
  const [interRes, coordRes, tccRes, enviaRes] = await Promise.allSettled([
    trackInterrapidisimo(groups.interrapidisimo),
    trackCoordinadora(groups.coordinadora),
    trackTCC(groups.tcc),
    trackEnvia(groups.envia),
  ]);

  const results = [
    ...getSettled(interRes, groups.interrapidisimo, 'Interrapidísimo'),
    ...getSettled(coordRes, groups.coordinadora, 'Coordinadora'),
    ...getSettled(tccRes, groups.tcc, 'TCC'),
    ...getSettled(enviaRes, groups.envia, 'Envia'),
    ...groups.unknown.map(g =>
      buildResult(g, 'Desconocida', '', '', '', null,
        'TRANSPORTADORA NO RECONOCIDA', 'gray', 100, null)
    ),
  ];

  results.sort((a, b) => a.priority - b.priority);
  return res.status(200).json({ guides: results });
}

function getSettled(result, originals, carrierName) {
  if (result.status === 'fulfilled') return result.value;
  console.error(`[${carrierName}] settlement error:`, result.reason?.message);
  return originals.map(g =>
    buildResult(g, carrierName, getCarrierUrl(g.number, carrierName),
      '', '', null, 'ERROR CONSULTA', 'gray', 98, null)
  );
}


// ─── Interrapidísimo ──────────────────────────────────────────────────────────

async function trackInterrapidisimo(guides) {
  if (!guides.length) return [];
  const CARRIER = 'Interrapidísimo';
  const BASE = 'https://gateway.interrapidisimo.com/ConsultaGuiasSTE/api/v1/ResultadoConsulta/';
  const BATCH = 5;

  function norm12(n) {
    const digits = n.replace(/\D/g, '');
    return digits.length >= 12 ? digits.slice(-12) : digits.padStart(12, '0');
  }

  const results = [];

  for (let i = 0; i < guides.length; i += BATCH) {
    const batch = guides.slice(i, i + BATCH);
    const nums = batch.map(g => norm12(g.number));
    const valid = nums.filter(n => /^\d{12}$/.test(n));

    if (!valid.length) {
      batch.forEach(g =>
        results.push(buildResult(g, CARRIER, getCarrierUrl(g.number, CARRIER),
          '', '', null, 'NO ENCONTRADA', 'gray', 99, null))
      );
      continue;
    }

    try {
      const url = `${BASE}ConsultarGuias?NumerosGuias=${encodeURIComponent(valid.join(','))}&tokenRecaptcha=`;
      const r = await fetch(url, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          Origin: 'https://siguetuenvio.interrapidisimo.com',
          Referer: 'https://siguetuenvio.interrapidisimo.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      let raw = null;
      try { raw = await r.json(); } catch (_) {}
      console.log('[Inter]', r.status, JSON.stringify(raw)?.slice(0, 500));

      const guiasMap = parseInterRaw(raw);

      batch.forEach((g, idx) => {
        const num12 = nums[idx];
        const d = guiasMap[num12];
        if (!d) {
          results.push(buildResult(g, CARRIER, getCarrierUrl(g.number, CARRIER),
            '', '', null, 'NO ENCONTRADA', 'gray', 99, null));
          return;
        }
        const days = daysSince(d.fecha);
        const { litperStatus, semaforo, priority, action } = mapEstado(d.estado, days);
        results.push(buildResult(g, CARRIER, getCarrierUrl(g.number, CARRIER),
          d.estado, d.ciudad, days, litperStatus, semaforo, priority, action));
      });
    } catch (err) {
      console.error('[Inter] batch error:', err.message);
      batch.forEach(g =>
        results.push(buildResult(g, CARRIER, getCarrierUrl(g.number, CARRIER),
          '', '', null, 'ERROR CONSULTA', 'gray', 98, null))
      );
    }
  }

  return results;
}

function parseInterRaw(raw) {
  const map = {};
  if (!raw) return map;

  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (Array.isArray(raw.guias)) arr = raw.guias;
  else if (Array.isArray(raw.resultado?.guias)) arr = raw.resultado.guias;
  else if (Array.isArray(raw.data)) arr = raw.data;
  else if (raw.numero || raw.NumeroGuia || raw.number) arr = [raw];

  for (const g of arr) {
    const num = String(g.numero || g.NumeroGuia || g.number || g.guia || '').trim();
    if (!num) continue;
    const key = num.replace(/\D/g, '').slice(-12).padStart(12, '0');
    const rawEstado = g.estado || g.Estado || g.ultimoEstado || g.estadoActual || g.descripcion || '';
    const estado = typeof rawEstado === 'object'
      ? (rawEstado.descripcion || rawEstado.name || '')
      : rawEstado;
    const ciudad = g.ciudad || g.Ciudad || g.municipio || g.destino || g.ciudadDestino || '';
    const eventos = g.eventos || g.Eventos || g.historial || g.history || [];
    const lastEvt = Array.isArray(eventos) && eventos.length ? eventos[0] : null;
    const fecha = g.fechaUltimoEvento || lastEvt?.fecha || lastEvt?.date || g.fecha || '';
    map[key] = { estado, ciudad, fecha };
  }
  return map;
}


// ─── Coordinadora ─────────────────────────────────────────────────────────────

async function trackCoordinadora(guides) {
  if (!guides.length) return [];
  const CARRIER = 'Coordinadora';

  try {
    const r = await fetch('https://apiv2.coordinadora.com/suite/cm-suite-middleware/guias', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-obv': 'pdzg4r5u089zltz',
        Referer: 'https://rastreov2.coordinadora.com/',
        Origin: 'https://rastreov2.coordinadora.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({ guias: guides.map(g => g.number) }),
    });

    let raw = null;
    try { raw = await r.json(); } catch (_) {}
    console.log('[Coordinadora]', r.status, JSON.stringify(raw)?.slice(0, 500));

    const guiasMap = parseCoordRaw(raw);

    return guides.map(g => {
      const d = guiasMap[g.number];
      if (!d) {
        return buildResult(g, CARRIER, getCarrierUrl(g.number, CARRIER),
          '', '', null, 'NO ENCONTRADA', 'gray', 99, null);
      }
      const days = daysSince(d.fecha);
      const { litperStatus, semaforo, priority, action } = mapEstado(d.estado, days);
      return buildResult(g, CARRIER, getCarrierUrl(g.number, CARRIER),
        d.estado, d.ciudad, days, litperStatus, semaforo, priority, action);
    });
  } catch (err) {
    console.error('[Coordinadora] error:', err.message);
    return guides.map(g =>
      buildResult(g, CARRIER, getCarrierUrl(g.number, CARRIER),
        '', '', null, 'ERROR CONSULTA', 'gray', 98, null)
    );
  }
}

function parseCoordRaw(raw) {
  const map = {};
  if (!raw) return map;

  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (Array.isArray(raw.guias)) arr = raw.guias;
  else if (Array.isArray(raw.data)) arr = raw.data;
  else if (Array.isArray(raw.resultado)) arr = raw.resultado;
  else if (Array.isArray(raw.results)) arr = raw.results;

  for (const g of arr) {
    const num = String(g.numero || g.guia || g.trackingNumber || g.number || '').trim();
    if (!num) continue;
    const rawEstado = g.estado || g.estadoActual || g.ultimoEstado || g.status || g.descripcionEstado || '';
    const estado = typeof rawEstado === 'object'
      ? (rawEstado.descripcion || rawEstado.name || '')
      : rawEstado;
    const ciudad = g.municipio || g.ciudad || g.ciudadDestino || g.destino || '';
    const fecha = g.fechaUltimoEvento || g.fechaEstado || g.fecha || g.date || '';
    map[num] = { estado, ciudad, fecha };
  }
  return map;
}


// ─── TCC ──────────────────────────────────────────────────────────────────────

async function trackTCC(guides) {
  if (!guides.length) return [];
  const CARRIER = 'TCC';

  return Promise.all(guides.map(async g => {
    try {
      const r = await fetch('https://tccrestify-dot-tcc-cloud.appspot.com/tracking/wid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          remesas: { remesa: { numero: g.number, esrelacion: '' } },
          captcha: '',
          recaptchaVersion: 'v3',
        }),
      });

      let raw = null;
      try { raw = await r.json(); } catch (_) {}
      console.log('[TCC]', r.status, JSON.stringify(raw)?.slice(0, 400));

      if (!raw) {
        return buildResult(g, CARRIER, getCarrierUrl(g.number, CARRIER),
          '', '', null, 'NO ENCONTRADA', 'gray', 99, null);
      }

      const remesa = raw.remesas?.remesa || raw.remesa || raw;
      const rawEstado = remesa?.estado?.descripcion
        || remesa?.descripcionEstado
        || remesa?.estadoActual?.descripcion
        || remesa?.estado
        || remesa?.ultimoEstado
        || remesa?.status
        || '';
      const estado = typeof rawEstado === 'object'
        ? (rawEstado.descripcion || rawEstado.name || '')
        : rawEstado;
      const ciudad = remesa?.ciudadDestino || remesa?.ciudad
        || remesa?.municipioDestino || remesa?.destino || '';
      const historial = remesa?.historial || remesa?.eventos || remesa?.history || [];
      const fecha = remesa?.fechaUltimoEvento || remesa?.fechaEstado
        || (Array.isArray(historial) && historial[0]?.fecha)
        || remesa?.fecha || '';

      if (!estado) {
        return buildResult(g, CARRIER, getCarrierUrl(g.number, CARRIER),
          '', '', null, 'NO ENCONTRADA', 'gray', 99, null);
      }

      const days = daysSince(fecha);
      const { litperStatus, semaforo, priority, action } = mapEstado(estado, days);
      return buildResult(g, CARRIER, getCarrierUrl(g.number, CARRIER),
        estado, ciudad, days, litperStatus, semaforo, priority, action);
    } catch (err) {
      console.error('[TCC] error:', err.message);
      return buildResult(g, CARRIER, getCarrierUrl(g.number, CARRIER),
        '', '', null, 'ERROR CONSULTA', 'gray', 98, null);
    }
  }));
}


// ─── Envia ────────────────────────────────────────────────────────────────────

async function trackEnvia(guides) {
  if (!guides.length) return [];
  const CARRIER = 'Envia';

  try {
    const r = await fetch('https://queries.envia.com/shipments/generaltrack?is_landing=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: 'https://envia.com',
        Referer: 'https://envia.com/',
      },
      body: JSON.stringify({ trackingNumbers: guides.map(g => g.number) }),
    });

    let raw = null;
    try { raw = await r.json(); } catch (_) {}
    console.log('[Envia]', r.status, JSON.stringify(raw)?.slice(0, 500));

    return guides.map(g => {
      if (!raw) {
        return buildResult(g, CARRIER, getCarrierUrl(g.number, CARRIER),
          '', '', null, 'NO ENCONTRADA', 'gray', 99, null);
      }

      const arr = Array.isArray(raw)
        ? raw
        : (raw.shipments || raw.data || raw.result || raw.tracking || []);

      const item = arr.find(s =>
        s.trackingNumber === g.number || s.numero === g.number
        || s.guia === g.number || s.number === g.number
        || s.tracking_number === g.number
      );

      if (!item) {
        return buildResult(g, CARRIER, getCarrierUrl(g.number, CARRIER),
          '', '', null, 'NO ENCONTRADA', 'gray', 99, null);
      }

      const rawEstado = item.status || item.estado || item.lastStatus || item.ultimoEstado || '';
      const estado = typeof rawEstado === 'object'
        ? (rawEstado.description || rawEstado.descripcion || rawEstado.name || '')
        : rawEstado;
      const ciudad = item.city || item.ciudad || item.destCity
        || item.destinationCity || item.destino || '';
      const fecha = item.lastUpdate || item.fechaUltimoEvento
        || item.updatedAt || item.updated_at || item.date || '';
      const description = item.lastEvent || item.ultimoEvento
        || item.lastEventDescription || estado;

      const days = daysSince(fecha);
      const { litperStatus, semaforo, priority, action } = mapEstado(estado, days);
      return buildResult(g, CARRIER, getCarrierUrl(g.number, CARRIER),
        description, ciudad, days, litperStatus, semaforo, priority, action);
    });
  } catch (err) {
    console.error('[Envia] error:', err.message);
    return guides.map(g =>
      buildResult(g, CARRIER, getCarrierUrl(g.number, CARRIER),
        '', '', null, 'ERROR CONSULTA', 'gray', 98, null)
    );
  }
}


// ─── Universal status mapper ──────────────────────────────────────────────────

function mapEstado(estado, days) {
  // Strip accents + uppercase for robust regex across all carriers
  const e = String(estado || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

  if (/ENTREGAD|DELIVERED/.test(e)) return statusData('Delivered', days);
  if (/EN\s*(RUTA|REPARTO|DOMICILIO)|OUT.*DELIVERY|PARA.*ENTREGA|ULTIMO.*PASO/.test(e))
    return statusData('InTransitClose', days);
  if (/DEVOLU|RETORNO|RETORNAD|RETURN/.test(e)) return statusData('Returned', days);
  if (/NO.*POSIBLE|INTENTO.*FALLIDO|FAIL.*DELIVER|NOVEDAD.*ENTREGA/.test(e))
    return statusData('Undelivered', days);
  if (/OFICINA|PENDIENTE.*RECOG|RECOG.*CLIENTE|PICKUP/.test(e))
    return statusData('PickUp', days);
  if (/NOVEDAD|ALERTA|INCIDENCIA(?!.*ENTREGA)|ALERT/.test(e))
    return statusData('Alert', days);
  if (/VENCID|EXPIRED|CADUCD/.test(e)) return statusData('Expired', days);
  if (/TRANSITO|BODEGA|CLASIF|CAMINO|IN.*TRANSIT|PROCESAND|RECOLECT|RECIBID/.test(e))
    return statusData('InTransit', days);

  // Catch-all: treat unknown statuses as in transit (non-zero status = something is happening)
  return statusData('InTransit', days);
}

function statusData(key, days) {
  switch (key) {
    case 'Delivered':
      return { litperStatus: 'ENTREGADO', semaforo: 'green', priority: 50, action: null };
    case 'InTransitClose':
      return { litperStatus: 'EN REPARTO', semaforo: 'green', priority: 20, action: 'notify_reparto' };
    case 'InTransit':
      return (!days || days <= 5)
        ? { litperStatus: 'EN TRÁNSITO', semaforo: 'yellow', priority: 30, action: 'notify_transito' }
        : { litperStatus: 'DEMORADO', semaforo: 'red', priority: 5, action: 'notify_demorado' };
    case 'PickUp':
      return (!days || days < 3)
        ? { litperStatus: 'RECLAMO EN OFICINA', semaforo: 'yellow', priority: 15, action: 'notify_oficina' }
        : { litperStatus: 'RECLAMO URGENTE (+3d)', semaforo: 'red', priority: 3, action: 'notify_oficina_urgente' };
    case 'Returned':
      return { litperStatus: 'DEVOLUCIÓN', semaforo: 'red', priority: 1, action: 'notify_devolucion' };
    case 'Undelivered':
      return { litperStatus: 'NO FUE POSIBLE ENTREGAR', semaforo: 'red', priority: 2, action: 'notify_reenvio' };
    case 'Alert':
      return { litperStatus: 'NOVEDAD', semaforo: 'red', priority: 4, action: 'notify_novedad' };
    case 'Expired':
      return { litperStatus: 'GUÍA VENCIDA', semaforo: 'red', priority: 6, action: 'notify_vencida' };
    default:
      return { litperStatus: 'NO ENCONTRADA', semaforo: 'gray', priority: 99, action: null };
  }
}


// ─── Shared utilities ─────────────────────────────────────────────────────────

function detectCarrierKey(num) {
  if (/^(014|0014|114|0114)/.test(num)) return 'interrapidisimo';
  if (/^363/.test(num)) return 'coordinadora';
  if (/^(615|616)/.test(num)) return 'tcc';
  if (/^034/.test(num)) return 'envia';
  return 'unknown';
}

function getCarrierUrl(num, carrier) {
  if (carrier === 'Interrapidísimo') return 'https://siguetuenvio.interrapidisimo.com/';
  if (carrier === 'Coordinadora')
    return `https://www.coordinadora.com/portafolio-de-servicios/servicios-en-linea/rastreo-de-envios/?guia=${num}`;
  if (carrier === 'TCC') return 'https://www.tcc.com.co/home';
  if (carrier === 'Envia') return 'https://www.envia.co/';
  return '';
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  } catch { return null; }
}

function buildResult(guide, carrier, carrierUrl, description, city, days, ls, semaforo, priority, action) {
  return {
    number: guide.number,
    phone: guide.phone || '',
    carrier,
    carrierUrl,
    status: description || '',
    litperStatus: ls,
    semaforo,
    priority,
    action,
    city: city || '',
    days,
    description: description || '',
    template: getWhatsAppTemplate(ls, carrier),
    ticketText: getTicketText(ls, guide.number, carrier, city, days),
  };
}

function getWhatsAppTemplate(ls, carrier) {
  const c = carrier || 'la transportadora';
  const t = {
    'EN REPARTO': `Hola! 👋 Tu pedido *Litper* está en camino y lo entregarán hoy. Por favor mantén tu celular disponible y asegúrate de estar en casa 😊`,
    'EN TRÁNSITO': `Hola! 😊 Tu pedido *Litper* va en camino con *${c}*. Te avisamos cuando tenga novedades de entrega 📦`,
    'DEMORADO': `Hola! 😊 Tu pedido *Litper* está tardando más de lo esperado con *${c}*. Hacemos seguimiento activo. ¡Gracias por tu paciencia! 🙏`,
    'RECLAMO EN OFICINA': `Hola! 👋 Tu pedido *Litper* está disponible en la oficina de *${c}*. Te recomendamos recogerlo pronto. ¿Necesitas la dirección? 😊`,
    'RECLAMO URGENTE (+3d)': `Hola! 😊 Tu pedido *Litper* lleva varios días en la oficina de *${c}*. Si no lo recogen pronto será devuelto. ¿Podemos ayudarte? 📦`,
    'NO FUE POSIBLE ENTREGAR': `Hola! 😊 Intentamos entregarte tu pedido *Litper* pero no fue posible. ¿Cuándo estás disponible? Coordinamos nueva entrega 📦`,
    'DEVOLUCIÓN': `Hola! 😊 Tu pedido *Litper* está siendo devuelto. Queremos solucionarlo — ¿coordinamos un reenvío? 🙌`,
    'NOVEDAD': `Hola! 😊 Tu pedido *Litper* presenta una novedad con *${c}*. Lo estamos gestionando. ¿Confirmas disponibilidad? 📦`,
    'GUÍA VENCIDA': `Hola! 😊 La guía de tu pedido *Litper* ha vencido. Necesitamos coordinar un reenvío. ¿Cuándo podemos intentar? 📦`,
  };
  return t[ls] || '';
}

function getTicketText(ls, num, carrier, city, days) {
  const urgent = ['DEVOLUCIÓN', 'NO FUE POSIBLE ENTREGAR', 'RECLAMO URGENTE (+3d)', 'NOVEDAD', 'GUÍA VENCIDA'];
  if (!urgent.includes(ls)) return '';
  return `Seguimiento ${carrier} | Guía: ${num} | Estado: ${ls} | Ciudad: ${city || 'N/A'} | Días: ${days ?? 'N/A'} | Acción requerida: gestión prioritaria`;
}
