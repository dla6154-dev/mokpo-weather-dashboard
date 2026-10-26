// fetch-weather-board
// 기상상황부 웹앱용 데이터 수집 (엑셀 파워쿼리/VBA 대체)
//  job=fast   : nmpnt 등대·등표(안좌터미널, 외달도, 방서, 중뢰), 기상특보(예비 포함)   - 10분
//  job=hourly : 해역예보(fct_afs_do), 기상정보 분석(wthr_cmt_rpt 156)                   - 1시간
//  job=tide   : 국립해양조사원 조석예보 6개 지점                                        - 매일
//  job=charts : 예상일기도·수치파랑도 이미지 → Storage(weather-charts)                    - 하루 4회
//  job=all    : 전부
//  job=manual-refresh : 웹앱 버튼으로 전체 자료(부이 포함)를 한 번씩 다시 수집
//  job=manual-one&only=<항목> : 웹앱 '자료 업데이트' 항목 클릭 시 해당 자료만 다시 수집 (항목별 1분에 1번)
// 결과는 public.external_api_cache (id = wb-*) 에 저장. API 키는 jindo_app_secret 테이블에서 읽음.
import { createClient } from 'npm:@supabase/supabase-js@2';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const BUCKET = 'weather-charts';
const CORS_JSON = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type,x-wb-secret', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };

// ---------- 공통 ----------
async function secrets(): Promise<Record<string, string>> {
  const { data, error } = await sb.from('jindo_app_secret').select('key,value').like('key', 'weather_%');
  if (error) throw error;
  return Object.fromEntries((data || []).map((r) => [r.key, r.value]));
}

function kst(d = new Date()) {
  const t = new Date(d.getTime() + 9 * 3600e3);
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    ymd: `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}`,
    hh: p(t.getUTCHours()),
    date: t,
  };
}
const ymdOffset = (days: number) => kst(new Date(Date.now() + days * 86400e3)).ymd;

async function getText(url: string, enc = 'euc-kr', timeout = 20000): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  const buf = await res.arrayBuffer();
  const txt = new TextDecoder(enc).decode(buf);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('?')[0]}: ${txt.slice(0, 160)}`);
  return txt;
}

async function save(id: string, payload: unknown, ttl: number, path: string) {
  const now = Date.now();
  const { error } = await sb.from('external_api_cache').upsert({
    id, cacheKey: id, path, params: {}, payload, ttlSeconds: ttl,
    fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl * 1000).toISOString(),
  });
  if (error) throw error;
}

async function load(id: string): Promise<any> {
  const { data } = await sb.from('external_api_cache').select('payload').eq('id', id).maybeSingle();
  return data?.payload ?? null;
}

async function jobBuoy() {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const response = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/fetch-kma-buoy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(90000),
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw new Error(result.error || `부이 수집 HTTP ${response.status}`);
  return result;
}

// ---------- 해역예보 (fct_afs_do) ----------
const FCST_REGIONS: Record<string, string> = {
  '12A30100': '서해남부앞바다',
  '12A30211': '서해남부북쪽안쪽먼바다',
  '12A30212': '서해남부남쪽안쪽먼바다',
  '12B10100': '남해서부앞바다',
  '12B10201': '남해서부서쪽먼바다',
};

async function jobSeaForecast(k: Record<string, string>, debug: boolean) {
  const now = kst();
  const from = ymdOffset(-1) + '00';
  const url = `https://apihub-pub.kma.go.kr/api/typ01/url/fct_afs_do.php?reg=&tmfc1=${from}&tmfc2=${now.ymd}${now.hh}&disp=1&help=0&authKey=${k.weather_kma_pub_key}`;
  const txt = await getText(url);
  if (debug) return { raw: txt.slice(0, 1500) };
  // REG_ID,TM_FC,TM_EF,MOD,NE,STN,C,MAN_ID,MAN_FC,W1,T,W2,S1,S2,WH1,WH2,SKY,PREP,WF,=
  const best: Record<string, any> = {};
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const c = line.split(',').map((s) => s.trim());
    if (c.length < 19) continue;
    const reg = c[0];
    if (!FCST_REGIONS[reg]) continue;
    const tmEf = c[2];
    const key = `${reg}|${tmEf}`;
    if (!best[key] || best[key].tmFc < c[1]) {
      best[key] = { reg, name: FCST_REGIONS[reg], tmFc: c[1], tmEf, w1: c[9], w2: c[11], s1: c[12], s2: c[13], wh1: c[14], wh2: c[15], wf: c[18] };
    }
  }
  // 오늘 오전(00시)/오후(12시) 슬롯 (없으면 가장 가까운 과거 슬롯)
  const out: Record<string, any> = {};
  for (const [reg, name] of Object.entries(FCST_REGIONS)) {
    for (const [label, hm] of [['오전', '0000'], ['오후', '1200']]) {
      const want = now.ymd + hm;
      const r = best[`${reg}|${want}`];
      if (r) out[`${name}/${label}`] = r;
    }
  }
  const payload = { source: 'fct_afs_do', tmfc2: now.ymd + now.hh, rows: out, count: Object.keys(out).length };
  if (payload.count === 0) throw new Error('해역예보 파싱 결과 없음');
  await save('wb-sea-forecast', payload, 3 * 3600, 'kma/fct_afs_do');
  return { count: payload.count };
}

// ---------- 기상정보 분석 (wthr_cmt_rpt, 광주 156) ----------
function composeComment(lines: string[]): string {
  // 엑셀 '예보'!E11 로직: <기압계…> 첫 줄 + <중점 사항> 2줄 + <유의 사항> 2줄
  const clean = lines.map((l) => l.replace(/^\$\d+#/, '').replace(/#\s*$/, '').trim());
  // 엑셀과 동일: 제목 바로 다음 n줄(빈 줄/다음 제목이면 생략)
  const after = (pat: RegExp, n: number) => {
    const i = clean.findIndex((l) => pat.test(l));
    if (i < 0) return [] as string[];
    const res: string[] = [];
    for (let j = i + 1; j <= i + n && j < clean.length; j++) {
      if (/^</.test(clean[j])) break;
      if (clean[j]) res.push(clean[j]);
    }
    return res;
  };
  const parts = [...after(/기압계/, 1), ...after(/중점\s*사항/, 2), ...after(/<유의/, 2)];
  return parts.join('\n');
}

async function jobComment(k: Record<string, string>, debug: boolean) {
  const url = `https://apihub.kma.go.kr/api/typ01/url/wthr_cmt_rpt.php?stn=156&subcd=0&disp=0&help=1&authKey=${k.weather_kma_hub_key}`;
  const txt = await getText(url);
  if (debug) return { raw: txt.slice(0, 3000) };
  const lines = txt.split(/\r?\n/);
  // 가장 최근 $0#156#YYYYMMDDHHMM 블록 찾기
  let start = -1, tmFc = '';
  lines.forEach((l, i) => {
    const m = l.match(/^\$0#156#(\d{12})/);
    if (m && m[1] > tmFc) { tmFc = m[1]; start = i; }
  });
  if (start < 0) throw new Error('기상정보 블록 없음');
  let end = lines.findIndex((l, i) => i > start && /^\$0#/.test(l));
  if (end < 0) end = lines.length;
  const block = lines.slice(start + 1, end).filter((l) => !l.startsWith('#') && l.trim() !== '=');
  const text = composeComment(block);
  await save('wb-weather-comment', { source: 'wthr_cmt_rpt', stn: 156, tmFc, text, lines: block.map((l) => l.replace(/^\$\d+#/, '')) }, 6 * 3600, 'kma/wthr_cmt_rpt');
  return { tmFc, len: text.length };
}

// ---------- 기상특보 (wrn_now_data, 예비특보 포함) ----------
async function jobWarning(k: Record<string, string>, debug: boolean) {
  const url = `https://apihub-pub.kma.go.kr/api/typ01/url/wrn_now_data.php?fe=f&tm=&disp=0&help=1&authKey=${k.weather_kma_pub_key}`;
  const txt = await getText(url);
  if (debug) return { raw: txt.slice(0, 2500) };
  // REG_UP, REG_UP_KO, REG_ID, REG_KO, TM_FC, TM_EF, WRN, LVL, CMD, ED_TM
  const rows: any[] = [];
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const c = line.split(',').map((s) => s.trim());
    if (c.length < 10) continue;
    if (c[6] === '강풍') continue; // 엑셀과 동일하게 육상 강풍 제외
    rows.push({ regUp: c[1], regId: c[2], region: c[3], tmFc: c[4], tmEf: c[5], wrn: c[6], lvl: c[7], cmd: c[8], edTm: c[9] });
  }
  const byRegion: Record<string, any> = {};
  for (const r of rows) if (!byRegion[r.region]) byRegion[r.region] = r;
  await save('wb-warning', { source: 'wrn_now_data', rows, byRegion }, 30 * 60, 'kma/wrn_now_data');
  return { count: rows.length };
}

// ---------- nmpnt 등대·등표 ----------
const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg: any) => {
  const n = Number(deg);
  return Number.isFinite(n) && String(deg).trim() !== '' ? DIRS[Math.round((((n % 360) + 360) % 360) / 22.5) % 16] : '';
};
function normNmpnt(r: Record<string, any>) {
  const dt = String(r.DATETIME ?? '');
  const v = (x: any) => { const s = String(x ?? '').trim(); return s === '' || s === '-' || s === '미제공' ? '' : s; };
  return {
    stationId: String(r.MMSI_CODE ?? ''), stationName: String(r.MMSI_NM ?? ''), datetime: dt, hhmm: dt.slice(8, 12),
    windDirDeg: v(r.WIND_DIRECT), windDirection: compass(r.WIND_DIRECT), windSpeed: v(r.WIND_SPEED),
    gust: v(r.WIND_GUST_SPEED ?? r.GUST_SPEED), waveHeight: v(r.WAVE_HEIGHT ?? r.WAVE_HEIGTH), visibility: v(r.HORIZON_VISIBL),
    raw: r,
  };
}
function parseXmlRecords(xml: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const m of xml.matchAll(/<record>([\s\S]*?)<\/record>/g)) {
    const rec: Record<string, string> = {};
    for (const f of m[1].matchAll(/<([A-Z_0-9]+)>([\s\S]*?)<\/\1>/g)) rec[f[1]] = f[2].trim();
    out.push(rec);
  }
  return out;
}
async function jobNmpnt(k: Record<string, string>, debug: boolean) {
  const base = 'http://marineweather.nmpnt.go.kr:8001/openWeatherNow.do';
  const results: any[] = [];
  const errors: string[] = [];
  const raws: Record<string, string> = {};
  try {
    const t = await getText(`${base}?serviceKey=${k.weather_nmpnt_key}&resultType=json&mmaf=107&mmsi=1079001,1079008&dataType=2`, 'utf-8');
    raws['107'] = t.slice(0, 1500);
    const j = JSON.parse(t);
    for (const r of j?.result?.recordset ?? []) results.push(normNmpnt(r));
  } catch (e) { errors.push('107: ' + String(e)); }
  try {
    const t = await getText(`${base}?serviceKey=${k.weather_nmpnt_key_112}&resultType=xml&mmaf=112&mmsi=994403901,994403895`, 'utf-8');
    raws['112'] = t.slice(0, 1500);
    for (const r of parseXmlRecords(t)) results.push(normNmpnt(r));
  } catch (e) { errors.push('112: ' + String(e)); }
  if (debug) return { raws, errors };
  if (!results.length) throw new Error('nmpnt 결과 없음: ' + errors.join(' / '));
  const byId = Object.fromEntries(results.map((r) => [r.stationId, r]));
  await save('wb-nmpnt', { source: 'nmpnt', rows: results, byId, errors }, 30 * 60, 'nmpnt/openWeatherNow');
  return { count: results.length, errors };
}

// ---------- 조석 (KHOA tideFcstHghLw) ----------
const TIDE_STATIONS: [string, string][] = [
  ['DT_0007', '목포'], ['SO_0631', '암태'], ['SO_0565', '향화'], ['SO_1248', '옥도'], ['SO_0555', '서망'], ['SO_1264', '계마'],
];
async function jobTide(k: Record<string, string>, debug: boolean) {
  if (debug) {
    const q = new URLSearchParams({ serviceKey: k.weather_khoa_tide_key, pageNo: '1', numOfRows: '10', type: 'JSON', obsCode: 'DT_0007', reqDate: ymdOffset(0) });
    return { raw: (await getText(`https://apis.data.go.kr/1192136/tideFcstHghLw/GetTideFcstHghLwApiService?${q}`, 'utf-8')).slice(0, 1500) };
  }
  const previous = await load('wb-tide');
  const days = [0]; // 기상상황부에 표시하는 오늘 조석만 조회한다.
  const result: Record<string, any> = {};
  const errors: string[] = [];
  for (const off of days) {
    const ymd = ymdOffset(off);
    const st: Record<string, any[]> = {};
    await Promise.all(TIDE_STATIONS.map(async ([code, name]) => {
      const q = new URLSearchParams({ serviceKey: k.weather_khoa_tide_key, pageNo: '1', numOfRows: '10', type: 'JSON', obsCode: code, reqDate: ymd });
      try {
        const t = await getText(`https://apis.data.go.kr/1192136/tideFcstHghLw/GetTideFcstHghLwApiService?${q}`, 'utf-8');
        const j = JSON.parse(t);
        const header = j?.header ?? j?.response?.header;
        if (header?.resultCode && header.resultCode !== '00') throw new Error(header.resultMsg || header.resultCode);
        let items = j?.body?.items?.item ?? j?.response?.body?.items?.item ?? [];
        if (!Array.isArray(items)) items = [items];
        items = items.filter((it: any) => String(it?.predcDt ?? '').slice(0, 10).replace(/-/g, '') === ymd);
        if (!items.length) throw new Error('해당 날짜 조석 자료 없음');
        st[name] = items.map((it: any) => {
          const code = String(it.extrSe);
          const s = String(it.predcDt ?? '');
          return {
            type: code === '1' || code === '3' ? '고조' : code === '2' || code === '4' ? '저조' : code,
            time: s.length >= 16 ? s.slice(11, 16) : s,
            level: it.predcTdlvVl == null ? null : Number(it.predcTdlvVl),
          };
        });
      } catch (e) {
        errors.push(`${name} ${ymd}: ${String(e)}`);
        st[name] = previous?.days?.[ymd]?.[name] ?? [];
      }
    }));
    result[ymd] = st;
  }
  const ok = Object.values(result).some((d: any) => Object.values(d).some((a: any) => a.length));
  if (!ok) throw new Error('조석 결과 없음: ' + errors.slice(0, 3).join(' / '));
  await save('wb-tide', { source: 'khoa/tideFcstHghLw', stations: TIDE_STATIONS.map((s) => s[1]), days: result, errors }, 36 * 3600, 'khoa/tideFcstHghLw');
  return { days: Object.keys(result), errors: errors.length, errorDetails: errors };
}

// ---------- 일기도·파랑도 이미지 ----------
async function jobCharts(debug: boolean) {
  const run = ymdOffset(-1) + '12'; // 엑셀 VBA와 동일: 전날 12UTC 모델
  const W = 'https://www.weather.go.kr/w/repositary/image/cht';
  const list: { slot: string; url: string; ext: string }[] = [
    { slot: 'chart-s012', url: `${W}/img/kim_gdps_erly_asia_surfce_ft06_pa4_s012_${run}.png`, ext: 'png' },
    { slot: 'chart-s036', url: `${W}/img/kim_gdps_erly_asia_surfce_ft06_pa4_s036_${run}.png`, ext: 'png' },
  ];
  for (const s of ['009', '012', '015', '018', '021', '024', '033', '036', '039', '042', '045', '048']) {
    list.push({ slot: `wave-s${s}`, url: `${W}/marine/kim_cww3_gwju_wave_s${s}_${run}.gif`, ext: 'gif' });
  }
  const prev = (await load('wb-charts')) ?? {};
  const images: Record<string, any> = { ...(prev.images ?? {}) };
  const errors: string[] = [];
  await Promise.all(list.map(async (it) => {
    try {
      const res = await fetch(it.url, { signal: AbortSignal.timeout(25000), headers: { Referer: 'https://www.weather.go.kr/' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error('too small');
      const path = `${run}/${it.slot}.${it.ext}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, buf, { upsert: true, contentType: it.ext === 'png' ? 'image/png' : 'image/gif', cacheControl: '3600' });
      if (error) throw error;
      images[it.slot] = { url: `${sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl}?v=${Date.now()}`, source: it.url, run };
    } catch (e) { errors.push(`${it.slot}: ${String(e)}`); }
  }));
  if (debug) return { run, images, errors };
  await save('wb-charts', { run, images, errors }, 36 * 3600, 'kma/charts');
  return { run, fetched: list.length - errors.length, errors };
}


// ---------- 항행경보 (KHOA NavigationalWarning) ----------
function xmlItems(xml: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const rec: Record<string, string> = {};
    for (const f of m[1].matchAll(/<([A-Za-z_0-9]+)>([\s\S]*?)<\/\1>/g)) rec[f[1].toLowerCase()] = f[2].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    out.push(rec);
  }
  return out;
}
const xmlTotal = (xml: string) => Number((xml.match(/<totalCount>(\d+)<\/totalCount>/) || [])[1] || 0);
async function jobNav(k: Record<string, string>, debug: boolean) {
  const today = ymdOffset(0);
  const base = 'https://apis.data.go.kr/1192136/NavigationalWarning';
  const get = (path: string, q: Record<string, string>) => getText(`${base}/${path}?${new URLSearchParams({ serviceKey: k.weather_khoa_tide_key, ...q })}`, 'utf-8', 30000);
  const first = await get('getNavigationalWarningInfo', { date: today, pageNo: '1', numOfRows: '100' });
  if (debug) {
    const docs0 = xmlItems(first);
    const d0 = docs0[0] ? await get('getNavigationalWarningDetailInfo', { doc_num: docs0[0].doc_num || docs0[0].docnum || '', pageNo: '1', numOfRows: '5' }) : '';
    return { list: first.slice(0, 1500), detail: d0.slice(0, 2500) };
  }
  let docs = xmlItems(first);
  const total = xmlTotal(first);
  for (let p = 2; p <= Math.ceil(total / 100); p++) docs = docs.concat(xmlItems(await get('getNavigationalWarningInfo', { date: today, pageNo: String(p), numOfRows: '100' })));
  const nums = [...new Set(docs.map((d) => d.doc_num || d.docnum || d.docno || d.doc_no).filter(Boolean))];
  const rows: any[] = [];
  const errors: string[] = [];
  await Promise.all(nums.map(async (dn) => {
    try {
      const x = await get('getNavigationalWarningDetailInfo', { doc_num: dn, pageNo: '1', numOfRows: '100' });
      for (const it of xmlItems(x)) {
        const dates = String(it.alarm_date || '').split(',').map((s) => s.trim()).filter(Boolean);
        const times = String(it.alarm_time || '').split(',').map((s) => s.trim()).filter(Boolean);
        const n = Math.max(dates.length, times.length);
        for (let i = 0; i < n; i++) {
          if ((dates[i] || '').replace(/\D/g, '') !== today) continue;
          rows.push({ doc_num: dn, name: it.position_nm || '', position: it.position || '', desc: it.position_desc || '', time: (times[i] || '').replace(' ~ ', '~') });
        }
      }
    } catch (e) { errors.push(`${dn}: ${String(e)}`); }
  }));
  rows.sort((a, b) => String(a.doc_num).localeCompare(String(b.doc_num)));
  if (!nums.length && !total && errors.length) throw new Error(errors[0]);
  await save('wb-navwarn', { source: 'khoa/NavigationalWarning', date: today, docCount: nums.length, rows, errors }, 36 * 3600, 'khoa/NavigationalWarning');
  return { date: today, docs: nums.length, rows: rows.length, errors: errors.length, errorDetails: errors };
}

// ---------- 일일 갱신 상태 ----------
async function dailyMissing(): Promise<string[]> {
  const today = ymdOffset(0);
  const run = ymdOffset(-1) + '12';
  const ids = ['wb-tide', 'wb-charts', 'wb-navwarn'];
  const { data } = await sb.from('external_api_cache').select('id,payload').in('id', ids);
  const by: Record<string, any> = Object.fromEntries((data || []).map((r: any) => [r.id, r.payload]));
  const miss: string[] = [];
  if (!by['wb-tide']?.days?.[today]) miss.push('tide');
  const im = by['wb-charts'];
  if (!im || im.run !== run || (im.errors || []).length || Object.values(im.images || {}).some((x: any) => x.run !== run)) miss.push('charts');
  if (by['wb-navwarn']?.date !== today) miss.push('nav');
  return miss;
}

// ---------- 엔트리 ----------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_JSON });
  const u = new URL(req.url);
  const job = u.searchParams.get('job') || 'fast';
  const manual = job === 'manual-refresh';
  const single = job === 'manual-one';
  if ((manual || single) && req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'POST required' }), { status: 405, headers: CORS_JSON });
  }
  let debug = u.searchParams.get('debug') === '1';
  try {
    const k = await secrets();
    const given = req.headers.get('x-wb-secret') || '';
    const trusted = !!k.weather_cron_secret && given === k.weather_cron_secret;
    if (!trusted) debug = false;
    // 웹앱 새로고침 버튼: 키 없이 '오늘 빠진 일일자료'만 다시 받기 (5분에 1번 제한)
    if (!trusted && job !== 'daily-missing' && !manual && !single) {
      return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: CORS_JSON });
    }
    const run = async (name: string, fn: () => Promise<any>) => {
      try { return [name, { ok: true, ...(await fn()) }]; } catch (e) { return [name, { ok: false, error: String(e) }]; }
    };
    // 웹앱 '자료 업데이트' 항목 클릭: 해당 자료만 다시 수집 (항목별 1분에 1번 제한)
    if (single) {
      const one: Record<string, () => Promise<any>> = {
        seaForecast: () => jobSeaForecast(k, debug), warning: () => jobWarning(k, debug), buoy: () => jobBuoy(),
        nmpnt: () => jobNmpnt(k, debug), comment: () => jobComment(k, debug), tide: () => jobTide(k, debug),
        charts: () => jobCharts(debug), nav: () => jobNav(k, debug),
      };
      const only = u.searchParams.get('only') || '';
      if (!Object.hasOwn(one, only)) {
        return new Response(JSON.stringify({ ok: false, error: 'unknown item' }), { status: 400, headers: CORS_JSON });
      }
      if (!trusted) {
        const lockId = `wb-item-lock-${only}`;
        const lock = await load(lockId);
        if (lock?.at && Date.now() - Number(lock.at) < 60e3) {
          return new Response(JSON.stringify({ ok: true, job, only, skipped: 'recent' }), { headers: CORS_JSON });
        }
        await save(lockId, { at: Date.now() }, 120, 'lock');
      }
      const [, value] = await run(only, one[only]);
      return new Response(JSON.stringify({ ok: true, job, only, result: { [only]: value } }), { headers: CORS_JSON });
    }
    const tasks: Promise<any>[] = [];
    if (job === 'fast' || job === 'all' || manual) {
      tasks.push(run('nmpnt', () => jobNmpnt(k, debug)), run('warning', () => jobWarning(k, debug)));
    }
    if (job === 'hourly' || job === 'all' || manual) {
      tasks.push(run('seaForecast', () => jobSeaForecast(k, debug)), run('comment', () => jobComment(k, debug)));
    }
    let want: string[] = [];
    if (job === 'daily' || job === 'all' || manual) want = ['tide', 'charts', 'nav'];
    if (manual) tasks.push(run('buoy', () => jobBuoy()));
    if (job === 'tide') want = ['tide'];
    if (job === 'charts') want = ['charts'];
    if (job === 'nav') want = ['nav'];
    if (job === 'daily-missing') {
      if (!trusted) {
        const lock = await load('wb-daily-lock');
        if (lock?.at && Date.now() - Number(lock.at) < 5 * 60e3) {
          return new Response(JSON.stringify({ ok: true, job, skipped: 'recent', missing: await dailyMissing() }), { headers: CORS_JSON });
        }
        await save('wb-daily-lock', { at: Date.now() }, 600, 'lock');
      }
      want = await dailyMissing();
    }
    if (want.includes('tide')) tasks.push(run('tide', () => jobTide(k, debug)));
    if (want.includes('charts')) tasks.push(run('charts', () => jobCharts(debug)));
    if (want.includes('nav')) tasks.push(run('nav', () => jobNav(k, debug)));
    const result = Object.fromEntries(await Promise.all(tasks));
    return new Response(JSON.stringify({ ok: true, job, result }), { headers: CORS_JSON });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: CORS_JSON });
  }
});
