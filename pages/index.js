import { useState, useCallback, useMemo } from 'react';

const ORANGE = '#E8480A';
const DARK = '#1a1a1a';
const LIGHT_BG = '#f8f8f8';

const SEMAFORO_COLORS = {
  green: { bg: '#dcfce7', border: '#16a34a', text: '#15803d', dot: '#22c55e' },
  yellow: { bg: '#fef9c3', border: '#ca8a04', text: '#854d0e', dot: '#eab308' },
  red: { bg: '#fee2e2', border: '#dc2626', text: '#991b1b', dot: '#ef4444' },
  gray: { bg: '#f3f4f6', border: '#9ca3af', text: '#4b5563', dot: '#d1d5db' },
};

const STATUS_ICONS = {
  'ENTREGADO': '✅', 'EN REPARTO': '🚚', 'EN TRÁNSITO': '📦', 'DEMORADO': '⏰',
  'RECLAMO EN OFICINA': '🏢', 'RECLAMO URGENTE (+3d)': '🚨',
  'NO FUE POSIBLE ENTREGAR': '❌', 'DEVOLUCIÓN': '↩️',
  'NOVEDAD': '⚠️', 'GUÍA VENCIDA': '🗓️', 'REGISTRADA': '📋', 'NO ENCONTRADA': '❓',
};

const HEADER_WORDS = /^(guia|guía|n[°ú]|numero|número|tracking|envio|envío|pedido|order|#)$/i;

function isHeaderRow(val) {
  return HEADER_WORDS.test(val.trim()) || !/\d/.test(val);
}

function parseInput(raw) {
  if (!raw || !raw.trim()) return [];
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const guides = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t').map(p => p.trim().replace(/^["']|["']$/g, ''));
    const col1 = parts[0];
    if (!col1 || isHeaderRow(col1)) continue;
    const number = col1.replace(/[\s\-.]/g, '');
    if (!number || number.length < 4) continue;
    const phone = (parts[1] || '').replace(/\D/g, '').slice(-10);
    guides.push({ number, phone });
  }
  return guides;
}

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else { fallbackCopy(text); }
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  document.execCommand('copy'); document.body.removeChild(ta);
}

function downloadCSV(guides) {
  const headers = ['Guia','Telefono','Transportadora','Estado Litper','Semaforo','Ciudad','Dias','Ultimo evento'];
  const rows = guides.map(g => [
    g.number, g.phone, g.carrier, g.litperStatus, g.semaforo,
    g.city || '', g.days ?? '', (g.description || '').replace(/,/g, ';')
  ]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `litper-guias-${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

function WhatsAppButton({ guide }) {
  const [copied, setCopied] = useState(false);
  if (!guide.template) return null;
  const phone = guide.phone ? guide.phone.replace(/\D/g, '') : '';
  const waUrl = phone ? `https://wa.me/57${phone}?text=${encodeURIComponent(guide.template)}` : null;
  const handleCopy = () => { copyToClipboard(guide.template); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  return (
    <span style={{ display:'inline-flex', gap:4 }}>
      {waUrl && (
        <a href={waUrl} target="_blank" rel="noopener noreferrer"
          style={{ display:'inline-flex',alignItems:'center',gap:3,padding:'3px 8px',background:'#25D366',color:'#fff',borderRadius:6,fontSize:11,fontWeight:600,textDecoration:'none' }}>
          💬 WA
        </a>
      )}
      <button onClick={handleCopy}
        style={{ display:'inline-flex',alignItems:'center',gap:3,padding:'3px 8px',background:copied?'#16a34a':'#e5e7eb',color:copied?'#fff':'#374151',borderRadius:6,fontSize:11,fontWeight:600,border:'none',cursor:'pointer' }}>
        {copied ? '✓ Copiado' : '📋 Plantilla'}
      </button>
    </span>
  );
}

function TicketButton({ guide }) {
  const [copied, setCopied] = useState(false);
  if (!guide.ticketText) return null;
  return (
    <button onClick={() => { copyToClipboard(guide.ticketText); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      style={{ display:'inline-flex',alignItems:'center',gap:3,padding:'3px 8px',background:copied?'#16a34a':'#fef3c7',color:copied?'#fff':'#92400e',borderRadius:6,fontSize:11,fontWeight:600,border:`1px solid ${copied?'#16a34a':'#fcd34d'}`,cursor:'pointer' }}>
      {copied ? '✓' : '🎫'} {copied ? 'Copiado' : 'Ticket'}
    </button>
  );
}

export default function Home() {
  const [inputText, setInputText] = useState('');
  const [guides, setGuides] = useState([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [configError, setConfigError] = useState('');
  const [filter, setFilter] = useState('all');
  const [lastCheck, setLastCheck] = useState(null);

  const parsedCount = useMemo(() => parseInput(inputText).length, [inputText]);

  const handleTrack = useCallback(async () => {
    const parsed = parseInput(inputText);
    if (!parsed.length) return;
    if (parsed.length > 200) { setError(`Máximo 200 guías por consulta. Tienes ${parsed.length}.`); return; }
    setError(''); setLoading(true);
    setProgress(`Consultando ${parsed.length} guía${parsed.length !== 1 ? 's' : ''}...`);
    try {
      const r = await fetch('/api/track', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ guides: parsed }) });
      const data = await r.json();
      if (data.configError) { setConfigError(data.configError); setGuides([]); }
      else { setConfigError(''); setGuides(data.guides || []); setLastCheck(new Date()); }
    } catch (e) { setError('Error de conexión: ' + e.message); }
    setLoading(false); setProgress('');
  }, [inputText]);

  const handleKeyDown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleTrack(); };
  const total = guides.length;
  const entregados = guides.filter(g => g.semaforo === 'green').length;
  const alertas = guides.filter(g => g.semaforo === 'yellow').length;
  const criticos = guides.filter(g => g.semaforo === 'red').length;
  const filtered = filter === 'all' ? guides : guides.filter(g => g.semaforo === filter);

  return (
    <div style={{ fontFamily:'system-ui,-apple-system,sans-serif', background:LIGHT_BG, minHeight:'100vh' }}>
      <div style={{ background:ORANGE, color:'#fff', padding:'12px 20px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ fontSize:22, fontWeight:800 }}>📦 Litper Guides</span>
          <span style={{ fontSize:12, background:'rgba(255,255,255,0.2)', padding:'2px 8px', borderRadius:20 }}>Seguimiento masivo</span>
        </div>
        {lastCheck && <span style={{ fontSize:11, opacity:0.85 }}>Última consulta: {lastCheck.toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit'})}</span>}
      </div>

      <div style={{ maxWidth:1200, margin:'0 auto', padding:16 }}>
        {configError && (
          <div style={{ background:'#fef2f2', border:'1px solid #fca5a5', borderRadius:10, padding:16, marginBottom:16 }}>
            <div style={{ fontWeight:700, color:'#b91c1c', marginBottom:6 }}>⚙️ Token 17track no configurado</div>
            <div style={{ color:'#7f1d1d', fontSize:13 }}>{configError}</div>
            <div style={{ color:'#7f1d1d', fontSize:12, marginTop:8 }}>
              1. Ve a <strong>vercel.com</strong> → proyecto <strong>litper-guides</strong> → <strong>Settings → Environment Variables</strong><br/>
              2. Agrega <code style={{ background:'#fee2e2', padding:'1px 4px', borderRadius:3 }}>SEVENTEEN_TRACK_TOKEN</code> con tu token de 17track.net<br/>
              3. Redeploy el proyecto
            </div>
          </div>
        )}

        <div style={{ background:'#fff', borderRadius:12, padding:16, marginBottom:16, boxShadow:'0 1px 3px rgba(0,0,0,0.08)' }}>
          <div style={{ fontWeight:700, marginBottom:6, color:DARK, fontSize:14, display:'flex', alignItems:'center', gap:8 }}>
            📋 Pega tus guías aquí
            {parsedCount > 0 && !loading && (
              <span style={{ fontWeight:600, color:ORANGE, background:'#fff5f0', border:`1px solid ${ORANGE}`, padding:'1px 10px', borderRadius:20, fontSize:12 }}>
                {parsedCount} guía{parsedCount !== 1 ? 's' : ''} detectada{parsedCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div style={{ color:'#6b7280', fontSize:12, marginBottom:8 }}>
            Copia y pega directamente desde Excel — 1 columna (guías) o 2 columnas (guías + teléfono). Hasta 200 guías. Detecta transportadora automáticamente.
          </div>
          <div style={{ display:'flex', gap:10 }}>
            <textarea value={inputText} onChange={e => setInputText(e.target.value)} onKeyDown={handleKeyDown}
              placeholder={`Pega columna de Excel con guías:\n0141234567\n0141234568\n3634567890\n\nO con teléfono (2 columnas):\n0141234567\t3001234567`}
              style={{ flex:1, height:130, resize:'vertical', border:'1.5px solid #e5e7eb', borderRadius:8, padding:10, fontSize:13, fontFamily:'monospace', outline:'none', lineHeight:1.6 }}
            />
            <div style={{ display:'flex', flexDirection:'column', gap:8, justifyContent:'flex-end' }}>
              <button onClick={handleTrack} disabled={loading || !inputText.trim()}
                style={{ padding:'10px 20px', background:loading?'#9ca3af':ORANGE, color:'#fff', border:'none', borderRadius:8, fontWeight:700, cursor:loading?'not-allowed':'pointer', fontSize:14, minWidth:150 }}>
                {loading ? '⏳ Consultando...' : `🔍 Consultar${parsedCount > 0 ? ` (${parsedCount})` : ''}`}
              </button>
              {guides.length > 0 && (
                <button onClick={() => downloadCSV(guides)}
                  style={{ padding:'8px 20px', background:'#f0fdf4', color:'#15803d', border:'1px solid #86efac', borderRadius:8, fontWeight:600, cursor:'pointer', fontSize:13 }}>
                  📥 Exportar CSV
                </button>
              )}
              <button onClick={() => { setInputText(''); setGuides([]); setError(''); setFilter('all'); }}
                style={{ padding:'8px 20px', background:'#f3f4f6', color:'#4b5563', border:'1px solid #e5e7eb', borderRadius:8, fontWeight:600, cursor:'pointer', fontSize:13 }}>
                🗑️ Limpiar
              </button>
            </div>
          </div>
          {loading && progress && (
            <div style={{ marginTop:10, background:'#fff5f0', border:`1px solid ${ORANGE}`, borderRadius:8, padding:'8px 12px', fontSize:13, color:ORANGE, fontWeight:600, display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ display:'inline-block', width:16, height:16, border:`2px solid ${ORANGE}`, borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
              {progress}
            </div>
          )}
          {error && <div style={{ color:'#dc2626', fontSize:13, marginTop:8 }}>⚠️ {error}</div>}
        </div>

        {total > 0 && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(130px, 1fr))', gap:10, marginBottom:16 }}>
            {[
              { label:'Total', val:total, key:'all', bg:'#fff', border:'#e5e7eb', text:DARK },
              { label:'🟢 En curso / Entregado', val:entregados, key:'green', bg:'#dcfce7', border:'#16a34a', text:'#15803d' },
              { label:'🟡 Alerta', val:alertas, key:'yellow', bg:'#fef9c3', border:'#ca8a04', text:'#854d0e' },
              { label:'🔴 Crítico', val:criticos, key:'red', bg:'#fee2e2', border:'#dc2626', text:'#991b1b' },
            ].map(card => (
              <div key={card.key} onClick={() => setFilter(filter === card.key ? 'all' : card.key)}
                style={{ background:filter===card.key?card.bg:'#fff', border:`2px solid ${filter===card.key?card.border:'#e5e7eb'}`, borderRadius:10, padding:'12px 16px', cursor:'pointer', transition:'all 0.15s' }}>
                <div style={{ fontSize:26, fontWeight:800, color:filter===card.key?card.text:DARK }}>{card.val}</div>
                <div style={{ fontSize:12, color:'#6b7280', marginTop:2 }}>{card.label}</div>
              </div>
            ))}
          </div>
        )}

        {filtered.length > 0 && (
          <div style={{ background:'#fff', borderRadius:12, boxShadow:'0 1px 3px rgba(0,0,0,0.08)', overflow:'hidden' }}>
            <div style={{ padding:'12px 16px', borderBottom:'1px solid #f3f4f6', display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:8 }}>
              <div style={{ fontWeight:700, fontSize:14, color:DARK }}>
                {filtered.length} guía{filtered.length!==1?'s':''}{filter !== 'all' ? ` — filtro: ${filter}` : ''}
              </div>
              <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                {criticos > 0 && <span style={{ fontSize:12, color:'#991b1b', background:'#fee2e2', padding:'3px 10px', borderRadius:20, fontWeight:600 }}>🚨 {criticos} críticas</span>}
                <button onClick={() => downloadCSV(guides)} style={{ fontSize:11, color:'#15803d', background:'#f0fdf4', border:'1px solid #86efac', padding:'3px 10px', borderRadius:20, cursor:'pointer', fontWeight:600 }}>📥 CSV</button>
              </div>
            </div>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                <thead>
                  <tr style={{ background:'#f9fafb' }}>
                    {['#','Guía','Transportadora','Estado Litper','Ciudad','Días','Último evento','Acciones'].map(h => (
                      <th key={h} style={{ padding:'10px 12px', textAlign:'left', fontWeight:600, color:'#6b7280', whiteSpace:'nowrap', borderBottom:'1px solid #f3f4f6' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((g, i) => {
                    const sc = SEMAFORO_COLORS[g.semaforo];
                    return (
                      <tr key={g.number + i} style={{ borderBottom:'1px solid #f9fafb' }}>
                        <td style={{ padding:'10px 12px', color:'#9ca3af', width:32 }}>{i+1}</td>
                        <td style={{ padding:'10px 12px', fontWeight:700, fontFamily:'monospace', color:DARK, whiteSpace:'nowrap' }}>
                          <div>{g.number}</div>
                          {g.phone && <div style={{ fontWeight:400, color:'#6b7280', fontSize:11, fontFamily:'sans-serif' }}>📱 {g.phone}</div>}
                        </td>
                        <td style={{ padding:'10px 12px', whiteSpace:'nowrap' }}>
                          <a href={g.carrierUrl} target="_blank" rel="noopener noreferrer" style={{ color:ORANGE, fontWeight:600, textDecoration:'none', fontSize:12 }}>🔗 {g.carrier}</a>
                        </td>
                        <td style={{ padding:'10px 12px', whiteSpace:'nowrap' }}>
                          <span style={{ display:'inline-flex',alignItems:'center',gap:5,background:sc.bg,color:sc.text,border:`1px solid ${sc.border}`,padding:'3px 10px',borderRadius:20,fontWeight:700,fontSize:12 }}>
                            <span style={{ width:7,height:7,borderRadius:'50%',background:sc.dot,display:'inline-block' }} />
                            {STATUS_ICONS[g.litperStatus]||''} {g.litperStatus}
                          </span>
                        </td>
                        <td style={{ padding:'10px 12px', color:'#4b5563' }}>{g.city||'—'}</td>
                        <td style={{ padding:'10px 12px', color:g.days>5?'#dc2626':g.days>2?'#ca8a04':'#4b5563', fontWeight:g.days>2?700:400 }}>{g.days!=null?`${g.days}d`:'—'}</td>
                        <td style={{ padding:'10px 12px', color:'#6b7280', fontSize:12, maxWidth:220, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{g.description||'—'}</td>
                        <td style={{ padding:'10px 12px', whiteSpace:'nowrap' }}>
                          <span style={{ display:'inline-flex', gap:4 }}><WhatsAppButton guide={g} /><TicketButton guide={g} /></span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!loading && guides.length === 0 && !configError && (
          <div style={{ background:'#fff', borderRadius:12, padding:40, textAlign:'center', boxShadow:'0 1px 3px rgba(0,0,0,0.08)' }}>
            <div style={{ fontSize:48, marginBottom:12 }}>📦</div>
            <div style={{ fontWeight:700, color:DARK, fontSize:18, marginBottom:8 }}>Rastreo masivo de guías COD</div>
            <div style={{ color:'#6b7280', fontSize:14, maxWidth:460, margin:'0 auto', lineHeight:1.7 }}>
              Copia una columna de Excel con los números de guía y pégala arriba.<br/>
              <strong>Hasta 200 guías por consulta.</strong> Detecta la transportadora automáticamente.<br/>
              Con teléfono en segunda columna: abre WhatsApp directo al cliente.
            </div>
            <div style={{ marginTop:20, display:'inline-flex', gap:10, flexWrap:'wrap', justifyContent:'center' }}>
              {['014.../114... → Interrapidísimo','363... → Coordinadora','615/616... → TCC','Envia → Envia'].map(tag => (
                <span key={tag} style={{ background:'#f3f4f6', color:'#4b5563', padding:'5px 12px', borderRadius:20, fontSize:12, fontWeight:600 }}>{tag}</span>
              ))}
            </div>
            <div style={{ marginTop:16, background:'#fff5f0', borderRadius:10, padding:'12px 20px', display:'inline-block', textAlign:'left' }}>
              <div style={{ fontSize:12, fontWeight:700, color:ORANGE, marginBottom:6 }}>💡 Cómo usar desde Excel:</div>
              <div style={{ fontSize:12, color:'#4b5563', lineHeight:1.8 }}>
                1. Selecciona la columna de guías en Excel → Ctrl+C<br/>
                2. Haz clic en el cuadro de arriba → Ctrl+V<br/>
                3. Clic en <strong>Consultar</strong> o presiona <strong>Ctrl+Enter</strong>
              </div>
            </div>
          </div>
        )}

        {guides.length > 0 && (
          <div style={{ marginTop:16, background:'#fff', borderRadius:12, padding:16, boxShadow:'0 1px 3px rgba(0,0,0,0.08)' }}>
            <div style={{ fontWeight:700, color:DARK, fontSize:13, marginBottom:10 }}>📋 Protocolo de gestión</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:10 }}>
              {[
                { color:'#fee2e2', border:'#fca5a5', icon:'↩️', title:'DEVOLUCIÓN / REENVÍO', steps:['Copiar plantilla → enviar WhatsApp','Copiar ticket → crear en Dropi','Marcar en spreadsheet: REENVÍO'] },
                { color:'#fef9c3', border:'#fde047', icon:'🏢', title:'RECLAMO EN OFICINA', steps:['Notificar cliente por WhatsApp','Si lleva 3+ días → crear ticket Dropi','Marcar en spreadsheet: RECLAMO'] },
                { color:'#dcfce7', border:'#86efac', icon:'🚚', title:'EN REPARTO', steps:['Enviar notificación de entrega','Verificar el día siguiente','Marcar en spreadsheet: ENTREGADO'] },
              ].map(card => (
                <div key={card.title} style={{ background:card.color, border:`1px solid ${card.border}`, borderRadius:8, padding:12 }}>
                  <div style={{ fontWeight:700, fontSize:12, marginBottom:6 }}>{card.icon} {card.title}</div>
                  {card.steps.map((s,i) => (
                    <div key={i} style={{ fontSize:11, color:'#374151', marginBottom:3 }}><span style={{ color:'#6b7280', marginRight:4 }}>{i+1}.</span>{s}</div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
