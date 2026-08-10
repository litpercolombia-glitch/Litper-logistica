export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const TOKEN = process.env.SEVENTEEN_TRACK_TOKEN;
  if (!TOKEN) {
    return res.status(200).json({
      guides: [],
      configError: 'Agrega SEVENTEEN_TRACK_TOKEN en Vercel → Settings → Environment Variables → tu token de 17track.net'
    });
  }

  const { guides } = req.body;
  if (!Array.isArray(guides) || guides.length === 0) {
    return res.status(400).json({ error: 'Se requiere array de guías' });
  }

  const batch = guides.slice(0, 40);
  const trackList = batch.map(g => ({ number: String(g.number).trim(), auto_detection: true }));

  // 1. Register (idempotent)
  try {
    await fetch('https://api.17track.net/track/v2.2/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', '17token': TOKEN },
      body: JSON.stringify(trackList)
    });
  } catch (_) {}

  // 2. Get tracking info
  let data;
  try {
    const r = await fetch('https://api.17track.net/track/v2.2/gettrackinfo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', '17token': TOKEN },
      body: JSON.stringify(trackList)
    });
    data = await r.json();
  } catch (e) {
    return res.status(500).json({ error: 'Error consultando 17track: ' + e.message });
  }

  const accepted = data?.data?.accepted || [];
  const rejected = data?.data?.rejected || [];
  const results = [];

  for (const item of accepted) {
    const num = item.number;
    const trackInfo = item.track_info || {};
    const status = trackInfo?.latest_status?.status || 'NotFound';
    const lastEvent = trackInfo?.latest_event || {};
    const description = lastEvent?.description || '';
    const location = lastEvent?.location || '';
    const city = location.split(',')[0]?.trim() || '';
    const carrierName = item.track?.carrier_name || detectCarrier(num);

    let days = null;
    const tm = trackInfo?.time_metrics;
    if (tm?.days_of_transit != null) {
      days = tm.days_of_transit;
    } else if (lastEvent?.time_iso) {
      const evDate = new Date(lastEvent.time_iso);
      if (!isNaN(evDate)) days = Math.floor((Date.now() - evDate) / 86400000);
    }

    const guide = batch.find(g => String(g.number).trim() === num) || {};
    const phone = guide.phone || '';
    const carrierUrl = getCarrierUrl(num, carrierName);
    const { litperStatus, semaforo, priority, action } = getLitperStatus(status, days);
    const template = getWhatsAppTemplate(litperStatus, carrierName);
    const ticketText = getTicketText(litperStatus, num, carrierName, city, days);

    results.push({ number: num, phone, carrier: carrierName, carrierUrl, status, litperStatus, semaforo, priority, action, city, days, description, template, ticketText });
  }

  for (const item of rejected) {
    const guide = batch.find(g => String(g.number).trim() === item.number) || {};
    const num = item.number;
    const carrierName = detectCarrier(num);
    results.push({
      number: num, phone: guide.phone || '',
      carrier: carrierName, carrierUrl: getCarrierUrl(num, carrierName),
      status: 'NotFound', litperStatus: 'NO ENCONTRADA', semaforo: 'gray',
      priority: 99, action: null, city: '', days: null,
      description: 'Guia no encontrada en 17track', template: '', ticketText: ''
    });
  }

  results.sort((a, b) => a.priority - b.priority);
  return res.status(200).json({ guides: results });
}

function detectCarrier(num) {
  const n = String(num).trim();
  if (/^(014|0014|114|0114)/i.test(n)) return 'Interrapidisimo';
  if (/^363/i.test(n)) return 'Coordinadora';
  if (/^(615|616)/i.test(n)) return 'TCC';
  return 'Auto';
}

function getCarrierUrl(num, carrierName) {
  const c = carrierName || detectCarrier(num);
  if (c === 'Interrapidisimo' || /^(014|114)/i.test(num))
    return 'https://siguetuenvio.interrapidisimo.com/';
  if (c === 'Coordinadora' || /^363/i.test(num))
    return 'https://www.coordinadora.com/portafolio-de-servicios/servicios-en-linea/rastreo-de-envios/?guia=' + num;
  if (c === 'TCC' || /^(615|616)/i.test(num))
    return 'https://www.tcc.com.co/home';
  if (c === 'Envia') return 'https://www.envia.co/';
  return 'https://t.17track.net/es#nums=' + num;
}

function getLitperStatus(status, days) {
  if (status === 'Delivered') return { litperStatus: 'ENTREGADO', semaforo: 'green', priority: 50, action: null };
  if (status === 'InTransit') {
    if (!days || days <= 2) return { litperStatus: 'EN REPARTO', semaforo: 'green', priority: 20, action: 'notify_reparto' };
    if (days <= 5) return { litperStatus: 'EN TRANSITO', semaforo: 'yellow', priority: 30, action: 'notify_transito' };
    return { litperStatus: 'DEMORADO', semaforo: 'red', priority: 5, action: 'notify_demorado' };
  }

  if (status === 'PickUp') {
    if (!days || days < 3) return { litperStatus: 'RECLAMO EN OFICINA', semaforo: 'yellow', priority: 15, action: 'notify_oficina' };
    return { litperStatus: 'RECLAMO URGENTE +3d', semaforo: 'red', priority: 3, action: 'notify_oficina_urgente' };
  }
  if (status === 'Returned') return { litperStatus: 'DEVOLUCION', semaforo: 'red', priority: 1, action: 'notify_devolucion' };
  if (status === 'Undelivered') return { litperStatus: 'NO FUE POSIBLE ENTREGAR', semaforo: 'red', priority: 2, action: 'notify_reenvio' };
  if (status === 'Alert') return { litperStatus: 'NOVEDAD', semaforo: 'red', priority: 4, action: 'notify_novedad' };
  if (status === 'Expired') return { litperStatus: 'GUIA VENCIDA', semaforo: 'red', priority: 6, action: 'notify_vencida' };
  if (status === 'InfoReceived') return { litperStatus: 'REGISTRADA', semaforo: 'gray', priority: 60, action: null };
  return { litperStatus: 'NO ENCONTRADA', semaforo: 'gray', priority: 99, action: null };
}

function getWhatsAppTemplate(litperStatus, carrier) {
  const c = carrier || 'la transportadora';
  const t = {
    'EN REPARTO': 'Hola! Tu pedido Litper esta en camino y el mensajero lo entregara hoy. Por favor manten tu celular disponible y asegurate de estar en casa.',
    'EN TRANSITO': 'Hola! Tu pedido Litper esta en camino con ' + c + '. Te avisamos en cuanto tenga novedades de entrega.',
    'DEMORADO': 'Hola! Tu pedido Litper esta tardando un poco mas de lo esperado con ' + c + '. Estamos haciendo seguimiento activo. Gracias por tu paciencia!',
    'RECLAMO EN OFICINA': 'Hola! Tu pedido Litper esta disponible para recoger en la oficina de ' + c + '. Te recomendamos recogerlo pronto para evitar devolucion. Necesitas la direccion de la oficina?',
    'RECLAMO URGENTE +3d': 'Hola! Tu pedido Litper lleva varios dias esperando en la oficina de ' + c + '. Si no lo recogen pronto sera devuelto. Podemos ayudarte a coordinar algo?',
    'NO FUE POSIBLE ENTREGAR': 'Hola! Intentamos entregarte tu pedido Litper pero no fue posible. Queremos coordinar una nueva entrega. Cuando estas disponible para recibirlo?',
    'DEVOLUCION': 'Hola! Tu pedido Litper esta siendo devuelto. Queremos solucionarlo para ti, podemos coordinar un reenvio?',
    'NOVEDAD': 'Hola! Tu pedido Litper presenta una novedad con ' + c + '. Nuestro equipo la esta gestionando. Puedes confirmarnos si estas disponible para recibirlo?',
    'GUIA VENCIDA': 'Hola! La guia de tu pedido Litper ha vencido. Necesitamos coordinar contigo para el reenvio. Cuando podemos intentar de nuevo?',
  };
  return t[litperStatus] || '';
}

function getTicketText(litperStatus, guideNum, carrier, city, days) {
  const urgent = ['DEVOLUCION', 'NO FUE POSIBLE ENTREGAR', 'RECLAMO URGENTE +3d', 'NOVEDAD', 'GUIA VENCIDA'];
  if (!urgent.includes(litperStatus)) return '';
  return carrier + ' | Guia: ' + guideNum + ' | Estado: ' + litperStatus + ' | Ciudad: ' + (city || 'N/A') + ' | Dias: ' + (days != null ? days : 'N/A') + ' | Accion requerida';
}
