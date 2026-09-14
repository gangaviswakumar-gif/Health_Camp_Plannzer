/* SehatRoute local decision-support prototype. Run from a local web server so CSV files can load. */
document.addEventListener('DOMContentLoaded', () => bootstrap().catch(showLoadError));

const SOURCE_FILES = {
  access: 'wayanad_accessibility_scores.csv', environment: 'wayanad_environmental_risk.csv',
  demographics: 'wayanad_demographic_vulnerability_data.csv', cases: 'unresolved_cases_ratio_based.csv',
  outreach: 'outreach gap.csv'
};
const DEFAULT_WEIGHTS = { access: 30, environment: 20, cases: 20, outreach: 20, demographic: 10 };
let villages = [], selectedVillage = null, srMap, markerLayer, weights = {...DEFAULT_WEIGHTS};

async function bootstrap() {
  const sources = Object.fromEntries(await Promise.all(Object.entries(SOURCE_FILES).map(async ([key, file]) => [key, parseCsv(await (await fetch(file)).text())])));
  villages = mergeSources(sources);
  renderShell(); initializeMap(); recalculate();
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (ch === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(v => v !== '')) rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = rows.shift().map(h => h.trim());
  return rows.map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] || '').trim()])));
}
const norm = value => (value || '').replace(/\(Part\)/gi, '').trim().toLowerCase();
const num = value => Number.parseFloat(value) || 0;
const clamp = value => Math.max(0, Math.min(100, value));
function indexBy(rows) { return new Map(rows.map(row => [norm(row.village), row])); }

function mergeSources(s) {
  const byAccess = indexBy(s.access), byEnv = indexBy(s.environment), byDemo = indexBy(s.demographics), byCases = indexBy(s.cases), byOutreach = indexBy(s.outreach);
  const childValues = s.demographics.map(d => num(d.child_percentage_0_6));
  const minChild = Math.min(...childValues), maxChild = Math.max(...childValues);
  return s.demographics.map(d => {
    const key = norm(d.village), access = byAccess.get(key) || {}, env = byEnv.get(key) || {}, cases = byCases.get(key) || {}, outreach = byOutreach.get(key) || {};
    const childPct = num(d.child_percentage_0_6);
    return {
      id: key, village: d.village.trim(), population: num(d.population), childPopulation: num(d.child_population_0_6), childPct,
      elderlyEstimated: num(d.elderly_population_estimated), elderlyPct: num(d.elderly_percentage_estimated),
      elderlyType: d.elderly_data_type, access: num(access.accessibility_need_score), roadKm: num(access.nearest_road_distance_km), duration: num(access.nearest_road_duration_min), facility: access.nearest_facility || 'Not recorded', facilityType: access.nearest_facility_type || '—',
      environment: num(env.environmental_risk_score), environmentBand: env.environmental_risk_band || 'Not recorded',
      childNeed: maxChild === minChild ? 50 : clamp((childPct - minChild) / (maxChild - minChild) * 100),
      caseRate: num(cases.unresolved_case_rate_per_1000), simulatedCases: num(cases.unresolved_cases), reportedCases: num(cases.reported_cases),
      outreachDate: outreach.last_verified_event_date || '', outreachType: outreach.event_type || '', outreachSummary: outreach.event_summary || '', outreachUrl: outreach.source_url || '', evidenceClass: outreach.evidence_classification || 'No public dated event found', gapStatus: outreach.outreach_gap_status || 'Needs verification', researchStatus: outreach.research_status || 'Needs local verification'
    };
  });
}

function outreachNeed(v) {
  const text = `${v.evidenceClass} ${v.gapStatus} ${v.researchStatus}`.toLowerCase();
  if (text.includes('no public dated') || text.includes('needs local')) return 100;
  if (!v.outreachDate) return text.includes('facility') ? 65 : 75;
  const ageMonths = (Date.now() - new Date(v.outreachDate).getTime()) / 2629800000;
  if (ageMonths > 36) return 90;
  if (ageMonths > 12) return 65;
  return 20;
}
function caseNeed(v) { const max = Math.max(...villages.map(x => x.caseRate), 0.01); return clamp(v.caseRate / max * 100); }
function demographicNeed(v) { return v.childNeed; }
function scoreVillage(v) {
  const factors = { access: v.access, demographic: demographicNeed(v), environment: v.environment, outreach: outreachNeed(v), cases: caseNeed(v) };
  const active = Object.entries(weights).filter(([, weight]) => weight > 0);
  const totalWeight = active.reduce((sum, [, weight]) => sum + weight, 0) || 1;
  const contributions = Object.fromEntries(Object.entries(factors).map(([key, value]) => [key, active.some(([activeKey]) => activeKey === key) ? value * (weights[key] / totalWeight) : 0]));
  return {...v, factors, contributions, score: Object.values(contributions).reduce((sum, value) => sum + value, 0)};
}
function priority(score) { return score >= 70 ? 'High' : score >= 45 ? 'Moderate' : 'Routine'; }

function recalculate() {
  villages = villages.map(scoreVillage).sort((a, b) => b.score - a.score).map((v, i) => ({...v, rank: i + 1, priority: priority(v.score)}));
  selectedVillage = villages.find(v => v.id === selectedVillage?.id) || villages[0];
  renderAll();
}

function renderShell() {
  document.body.innerHTML = `
  <style>
  :root{--ink:#17332a;--muted:#61746c;--bg:#f4f7f5;--card:#fff;--line:#dfe9e3;--green:#167a55;--navy:#103d2d;--high:#b42318;--moderate:#b54708;--routine:#157347;--shadow:0 8px 28px rgba(21,55,43,.08)}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,Arial,sans-serif}header{background:var(--navy);color:#fff;padding:18px 28px;display:flex;justify-content:space-between;align-items:center;gap:16px}.brand{display:flex;align-items:center;gap:12px}.logo{width:42px;height:42px;border-radius:12px;background:#d8f0e4;color:#126044;display:grid;place-items:center;font-weight:800}h1{font-size:20px;margin:0}.subtitle{font-size:12px;opacity:.75;margin-top:3px}.tag{font-size:11px;background:#ffffff18;border:1px solid #ffffff21;border-radius:999px;padding:8px 11px}main{max-width:1480px;margin:auto;padding:22px}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}.card{background:var(--card);border:1px solid var(--line);box-shadow:var(--shadow);border-radius:15px}.kpi{padding:16px}.label{font-size:10px;font-weight:800;color:var(--muted);letter-spacing:.06em}.value{font-size:27px;font-weight:800;margin:7px 0 2px}.note{font-size:11px;color:var(--muted);line-height:1.4}.toolbar{padding:15px;margin-bottom:16px;display:flex;gap:14px;align-items:end;flex-wrap:wrap}.control{min-width:130px;flex:1}.control label{display:flex;justify-content:space-between;font-size:11px;font-weight:700;margin-bottom:6px}.control b{color:var(--green)}input[type=range]{width:100%;accent-color:var(--green)}select,input[type=search],button{font:inherit;border:1px solid var(--line);border-radius:9px;padding:9px 10px;background:#fff;color:var(--ink);font-size:12px}button{cursor:pointer;font-weight:700}button.primary{background:var(--green);border-color:var(--green);color:#fff}.layout{display:grid;grid-template-columns:1.5fr .92fr;gap:16px}.panel{padding:16px}.head{display:flex;justify-content:space-between;align-items:start;gap:10px;margin-bottom:13px}.title{font-size:15px;font-weight:800}.sub{font-size:11px;color:var(--muted);margin-top:3px}.filters{display:flex;gap:8px;flex-wrap:wrap}#map{height:460px;border-radius:11px;overflow:hidden}.table-wrap{max-height:470px;overflow:auto;border:1px solid var(--line);border-radius:11px}table{width:100%;border-collapse:collapse;font-size:12px}th{position:sticky;top:0;background:#f7faf8;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em;text-align:left}th,td{padding:10px;border-bottom:1px solid var(--line);white-space:nowrap}tbody tr{cursor:pointer}tbody tr:hover{background:#f4faf6}.pill{display:inline-block;padding:4px 7px;border-radius:999px;font-size:10px;font-weight:800}.high{background:#fde8e7;color:var(--high)}.moderate{background:#fff0dc;color:var(--moderate)}.routine{background:#e5f5ed;color:var(--routine)}.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.box{background:#f7faf8;border:1px solid var(--line);border-radius:11px;padding:10px}.box small{display:block;color:var(--muted);font-size:10px;margin-bottom:4px}.box strong{font-size:14px}.factor{margin:12px 0}.factor-head{display:flex;justify-content:space-between;font-size:11px;margin-bottom:5px}.bar{height:8px;background:#e6eee9;border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;background:var(--green);border-radius:99px}.explain{font-size:11px;line-height:1.55;background:#f7faf8;border:1px solid var(--line);padding:11px;border-radius:11px;margin-top:11px}.callout{border-left:3px solid var(--green)}.warning{border-left-color:#c88900;background:#fff9ea}.muted{color:var(--muted)}.hidden{display:none}@media(max-width:1050px){.layout{grid-template-columns:1fr}.kpis{grid-template-columns:1fr 1fr}}@media(max-width:620px){header{padding:14px}main{padding:12px}.kpis{grid-template-columns:1fr}.toolbar{display:block}.control{margin:10px 0}}
  </style>
  <header><div class="brand"><div class="logo">SR</div><div><h1>SehatRoute</h1><div class="subtitle">Wayanad outreach prioritisation and verification workspace</div></div></div><div class="tag">Explainable decision support · prototype</div></header>
  <main><section class="kpis"><div class="card kpi"><div class="label">VILLAGES ANALYSED</div><div class="value" id="kVillages">—</div><div class="note">Integrated across five supplied datasets</div></div><div class="card kpi"><div class="label">PRIORITY OUTREACH</div><div class="value" id="kPriority">—</div><div class="note" id="kPriorityNote">—</div></div><div class="card kpi"><div class="label">PUBLIC-EVIDENCE GAP</div><div class="value" id="kGap">—</div><div class="note">Requires local camp-history verification</div></div><div class="card kpi"><div class="label">TOP RECOMMENDATION</div><div class="value" id="kTop">—</div><div class="note" id="kTopNote">—</div></div></section>
  <section class="card toolbar"><div style="min-width:180px"><div class="title">Scenario controls</div><div class="sub">Weights recalculate every score and explanation.</div></div>${slider('access','Access difficulty')}${slider('environment','Environmental risk')}${slider('cases','Unresolved-case proxy')}${slider('outreach','Outreach evidence gap')}${slider('demographic','Children / elderly')}<button id="reset">Reset weights</button><button class="primary" id="export">Export current ranking</button></section>
  <section class="layout"><div><div class="card panel"><div class="head"><div><div class="title">Priority map</div><div class="sub">Marker colour reflects the current, adjustable score.</div></div><div class="filters"><select id="priorityFilter"><option value="All">All priorities</option><option>High</option><option>Moderate</option><option>Routine</option></select></div></div><div id="map"></div></div><div class="card panel" style="margin-top:16px"><div class="head"><div><div class="title">Village priority ranking</div><div class="sub">Click a row to inspect the decision trail.</div></div><input id="search" type="search" placeholder="Search village"></div><div class="table-wrap"><table><thead><tr><th>Rank</th><th>Village</th><th>Priority</th><th>Score</th><th>Top reason</th><th>Evidence</th></tr></thead><tbody id="rows"></tbody></table></div></div></div><aside><div class="card panel"><div class="head"><div><div class="title">Explainable recommendation</div><div class="sub">Factors and evidence for the selected village</div></div></div><div id="detail"></div></div><div class="card panel" style="margin-top:16px"><div class="title">Model safeguards</div><div class="explain callout"><b>What this does:</b> ranks outreach planning need, not disease burden, diagnosis, or individual eligibility.</div><div class="explain warning"><b>Data limits:</b> 60+ figures are district-rate estimates. The unresolved-case input is a simulated planning proxy and contributes 20% by default; replace it with validated case/outreach data before operational use. “No public record found” is an evidence gap, not proof that no camp occurred.</div></div></aside></section></main>`;
}
function slider(key, label) { return `<div class="control"><label><span>${label}</span><b id="${key}Value">${weights[key]}%</b></label><input id="${key}" type="range" min="0" max="60" step="5" value="${weights[key]}"></div>`; }
function initializeMap() { srMap = L.map('map').setView([11.70, 76.08], 10); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution:'© OpenStreetMap contributors'}).addTo(srMap); markerLayer = L.layerGroup().addTo(srMap); bindControls(); }
function bindControls() {
  Object.keys(DEFAULT_WEIGHTS).forEach(key => document.getElementById(key).addEventListener('input', e => { weights[key] = num(e.target.value); document.getElementById(`${key}Value`).textContent = `${weights[key]}%`; recalculate(); }));
  document.getElementById('reset').onclick = () => { weights = {...DEFAULT_WEIGHTS}; Object.keys(DEFAULT_WEIGHTS).forEach(k => { document.getElementById(k).value = weights[k]; document.getElementById(`${k}Value`).textContent = `${weights[k]}%`; }); recalculate(); };
  document.getElementById('priorityFilter').onchange = renderAll; document.getElementById('search').oninput = renderTable; document.getElementById('export').onclick = exportRanking;
}
function colour(priority) { return priority === 'High' ? '#b42318' : priority === 'Moderate' ? '#b54708' : '#157347'; }
function badge(priority) { return `<span class="pill ${priority.toLowerCase()}">${priority}</span>`; }
function activeFactors(v) { return Object.entries(v.contributions).filter(([, value]) => value > 0).sort((a,b) => b[1] - a[1]); }
function labelFor(key) { return ({access:'access difficulty',demographic:'child-population vulnerability',environment:'environmental exposure',outreach:'outreach evidence gap',cases:'simulated unresolved-case proxy'})[key]; }
function renderAll() { renderKpis(); renderMap(); renderTable(); renderDetail(selectedVillage); }
function renderKpis() { const high = villages.filter(v => v.priority === 'High').length, moderate = villages.filter(v => v.priority === 'Moderate').length, gap = villages.filter(v => outreachNeed(v) >= 75).length, top = villages[0]; document.getElementById('kVillages').textContent = villages.length; document.getElementById('kPriority').textContent = high + moderate; document.getElementById('kPriorityNote').textContent = `${high} high and ${moderate} moderate priority`; document.getElementById('kGap').textContent = gap; document.getElementById('kTop').textContent = top.village; document.getElementById('kTopNote').textContent = `Score ${top.score.toFixed(1)} · ${labelFor(activeFactors(top)[0][0])}`; }
function renderMap() { markerLayer.clearLayers(); const filter = document.getElementById('priorityFilter').value; villages.filter(v => filter === 'All' || v.priority === filter).forEach(v => { const dataPoint = typeof DATA !== 'undefined' ? DATA.find(x => norm(x.village) === v.id) : null; if (!dataPoint) return; const marker = L.circleMarker([dataPoint.lat, dataPoint.lng], {radius:v.priority==='High'?9:7,color:colour(v.priority),fillColor:colour(v.priority),fillOpacity:.8,weight:2}).addTo(markerLayer); marker.bindTooltip(`${v.village} · ${v.score.toFixed(1)}`); marker.on('click', () => { selectedVillage = v; renderDetail(v); }); }); }
function renderTable() { const q = document.getElementById('search').value.toLowerCase(), filter = document.getElementById('priorityFilter').value; const rows = villages.filter(v => (filter === 'All' || v.priority === filter) && v.village.toLowerCase().includes(q)).map(v => { const [reason] = activeFactors(v); return `<tr data-id="${v.id}"><td>#${v.rank}</td><td><b>${v.village}</b></td><td>${badge(v.priority)}</td><td><b>${v.score.toFixed(1)}</b></td><td>${labelFor(reason[0])}</td><td>${v.outreachDate || 'Not dated'}</td></tr>`; }).join(''); document.getElementById('rows').innerHTML = rows || '<tr><td colspan="6">No matching villages.</td></tr>'; document.querySelectorAll('#rows tr[data-id]').forEach(row => row.onclick = () => { selectedVillage = villages.find(v => v.id === row.dataset.id); renderDetail(selectedVillage); }); }
function renderDetail(v) { const factors = activeFactors(v); const evidence = v.outreachDate ? `${v.outreachDate} · ${v.outreachType || 'Dated activity'}` : v.evidenceClass; const summary = factors.slice(0,3).map(([key, contribution]) => `${labelFor(key)} adds <b>${contribution.toFixed(1)}</b> points`).join('; '); document.getElementById('detail').innerHTML = `<div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px"><div><div style="font-size:21px;font-weight:800">${v.village}</div><div class="sub">Rank #${v.rank} of ${villages.length}</div></div><div style="text-align:right">${badge(v.priority)}<div style="font-size:25px;font-weight:800;margin-top:4px">${v.score.toFixed(1)}</div></div></div><div class="detail-grid"><div class="box"><small>Population (2011)</small><strong>${v.population.toLocaleString()}</strong></div><div class="box"><small>Nearest facility</small><strong>${v.facility}</strong></div><div class="box"><small>Road journey</small><strong>${v.roadKm.toFixed(1)} km · ${v.duration.toFixed(0)} min</strong></div><div class="box"><small>Latest public event</small><strong>${v.outreachDate || 'Not dated'}</strong></div></div><div style="margin-top:16px;font-size:13px;font-weight:800">Score contribution</div>${factors.map(([key, contribution]) => `<div class="factor"><div class="factor-head"><span>${labelFor(key)} <span class="muted">(${v.factors[key].toFixed(1)}/100)</span></span><b>${contribution.toFixed(1)} points</b></div><div class="bar"><i style="width:${Math.min(100,contribution / Math.max(...factors.map(x=>x[1])) * 100)}%"></i></div></div>`).join('')}<div class="explain callout"><b>Why this rank:</b> ${summary}. It is <b>${v.priority.toLowerCase()}</b> priority under the current weights. Change the sliders to test planning assumptions; all ranks update immediately.</div><div class="explain"><b>Outreach evidence:</b> ${evidence}<br>${v.outreachSummary || 'No dated public human-health event was located in the current evidence file.'}${v.outreachUrl ? `<br><a href="${v.outreachUrl}" target="_blank" rel="noopener">Open source record</a>` : ''}</div><div class="explain warning"><b>Interpretation note:</b> children 0–6: ${v.childPopulation.toLocaleString()} (${v.childPct.toFixed(2)}%). Estimated 60+: ${v.elderlyEstimated.toLocaleString()} (${v.elderlyPct.toFixed(2)}%); this is not village-level observed elderly data.</div>`; }
function exportRanking() { const headers = ['rank','village','priority','score','accessibility_need','environmental_risk','demographic_need','outreach_evidence_need','latest_public_event_date','top_reason']; const lines = [headers.join(',')].concat(villages.map(v => [v.rank, v.village, v.priority, v.score.toFixed(1), v.access.toFixed(1), v.environment.toFixed(1), demographicNeed(v).toFixed(1), outreachNeed(v).toFixed(1), v.outreachDate, labelFor(activeFactors(v)[0][0])].map(value => `"${String(value).replaceAll('"','""')}"`).join(','))); const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([lines.join('\n')], {type:'text/csv'})); link.download = 'sehatroute-current-ranking.csv'; link.click(); URL.revokeObjectURL(link.href); }
function showLoadError(error) { document.body.innerHTML = `<main style="max-width:720px;margin:70px auto;font-family:Arial"><h1>SehatRoute could not load its local data</h1><p>This prototype reads the five CSV files dynamically. Open it through a local server in this folder, not by double-clicking the HTML file.</p><pre>${error.message}</pre><p>PowerShell: <code>python -m http.server 8000</code>, then open <code>http://localhost:8000/SehatRoute_Wayanad_UI.html</code>.</p></main>`; }
