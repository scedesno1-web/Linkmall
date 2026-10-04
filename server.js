// 링크몰 (의존성 없음, Node 18+)
// 실행: node server.js  →  http://localhost:3000
// 저장소: SUPABASE_URL + SUPABASE_KEY 가 있으면 Supabase, 없으면 db.json 파일
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BASE = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

// ---------- 저장소 ----------
const SB_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SB_KEY = (process.env.SUPABASE_KEY || '').trim();
const useSB = !!(SB_URL && SB_KEY);
const enc = encodeURIComponent;

const sbHeaders = (extra) => {
  const h = { apikey: SB_KEY, 'Content-Type': 'application/json', ...extra };
  if (SB_KEY.startsWith('eyJ')) h.Authorization = 'Bearer ' + SB_KEY; // 예전 방식(JWT) 키일 때만
  return h;
};
async function sbGet(table, query) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${query}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`supabase GET ${table} ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbInsert(table, row) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, { method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`supabase INSERT ${table} ${r.status} ${await r.text()}`);
}

const sbStore = {
  async createShop(s) { await sbInsert('shops', s); },
  async shopById(id) { return (await sbGet('shops', `id=eq.${enc(id)}&select=*`))[0]; },
  async shopByKey(key) { return (await sbGet('shops', `key=eq.${enc(key)}&select=*`))[0]; },
  async createItem(i) { await sbInsert('items', i); },
  async itemById(id) { return (await sbGet('items', `id=eq.${enc(id)}&select=*`))[0]; },
  async itemsByShop(shopId) { return sbGet('items', `shop=eq.${enc(shopId)}&select=*&order=created.desc`); },
  async createOrder(o) { await sbInsert('orders', { token: o.token, item: o.item, price: o.price, paid_at: o.paidAt }); },
  async orderByToken(t) {
    const o = (await sbGet('orders', `token=eq.${enc(t)}&select=*`))[0];
    return o && { token: o.token, item: o.item, price: o.price, paidAt: o.paid_at };
  },
  async ordersForItems(ids) {
    if (!ids.length) return [];
    return (await sbGet('orders', `item=in.(${ids.map(enc).join(',')})&select=*`)).map((o) => ({ token: o.token, item: o.item, price: o.price, paidAt: o.paid_at }));
  },
};

const DB = path.join(__dirname, 'db.json');
const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return { shops: {}, items: {}, orders: {} }; } };
const save = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));
const fileStore = {
  async createShop(s) { const d = load(); d.shops[s.id] = s; save(d); },
  async shopById(id) { return load().shops[id]; },
  async shopByKey(key) { return Object.values(load().shops).find((s) => s.key === key); },
  async createItem(i) { const d = load(); d.items[i.id] = i; save(d); },
  async itemById(id) { return load().items[id]; },
  async itemsByShop(shopId) { return Object.values(load().items).filter((i) => i.shop === shopId).sort((a, b) => b.created - a.created); },
  async createOrder(o) { const d = load(); d.orders[o.token] = o; save(d); },
  async orderByToken(t) { return load().orders[t]; },
  async ordersForItems(ids) { return Object.values(load().orders).filter((o) => ids.includes(o.item)); },
};
const store = useSB ? sbStore : fileStore;

// ---------- 공통 ----------
const rid = (n = 6) => crypto.randomBytes(n).toString('base64url');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = (n) => Number(n).toLocaleString('ko-KR') + '원';

const css = `
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"Noto Sans KR",sans-serif;background:#f5f6f8;color:#1b1d21}
.w{max-width:520px;margin:0 auto;padding:20px 16px 60px}h1{font-size:22px;margin:8px 0 4px}h2{font-size:17px;margin:24px 0 8px}
.card{background:#fff;border-radius:14px;padding:16px;margin:10px 0;box-shadow:0 1px 3px rgba(0,0,0,.06)}
input,textarea{width:100%;padding:12px;border:1px solid #d9dce1;border-radius:10px;font-size:15px;margin:4px 0 10px;font-family:inherit}
textarea{min-height:90px}button,.btn{display:inline-block;background:#4f46e5;color:#fff;border:0;border-radius:10px;padding:12px 16px;font-size:15px;font-weight:600;text-decoration:none;cursor:pointer;width:100%;text-align:center}
.sub{color:#6b7280;font-size:13px}.price{font-weight:700;color:#4f46e5}.lock{background:#eef0ff;border-radius:10px;padding:12px;color:#4f46e5;font-size:14px}
.secret{white-space:pre-wrap;word-break:break-all;background:#ecfdf5;border-radius:10px;padding:14px}code{background:#eee;padding:2px 6px;border-radius:6px;word-break:break-all}
a{color:#4f46e5}.warn{background:#fff7ed;color:#9a3412;border-radius:10px;padding:10px;font-size:13px}
`;
const page = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${css}</style></head><body><div class="w">${body}</div></body></html>`;

const send = (res, code, html, headers = {}) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
const redirect = (res, to) => { res.writeHead(303, { Location: to }); res.end(); };
const readForm = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b))));
});

async function notify(shop, text) {
  if (!shop || !shop.webhook || !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(shop.webhook)) return;
  try { await fetch(shop.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }) }); } catch (e) { console.error('webhook 실패', e.message); }
}

// ---------- 라우트 ----------
const routes = [];
const route = (method, re, fn) => routes.push({ method, re, fn });
const notFound = (res, msg) => send(res, 404, page('없음', `<h1>${msg}</h1>`));

route('GET', /^\/$/, (req, res) => send(res, 200, page('링크몰', `
<h1>🔗 링크몰</h1><p class="sub">링크 하나로 팔고, 결제되면 자동으로 열려요.</p>
<form class="card" method="post" action="/shops"><b>내 상점 만들기</b><br>
<input name="name" placeholder="상점 이름" required maxlength="40">
<input name="webhook" placeholder="디스코드 웹훅 URL (선택, 판매 알림용)">
<button>상점 만들기</button></form>
<p class="warn">⚠️ 테스트 결제 모드입니다. 실제 돈이 오가지 않아요.</p>`)));

route('POST', /^\/shops$/, async (req, res) => {
  const f = await readForm(req);
  const shop = { id: rid(4), key: rid(12), name: String(f.name || '').slice(0, 40), webhook: (f.webhook || '').trim(), created: Date.now() };
  await store.createShop(shop);
  redirect(res, `/m/${shop.key}`);
});

route('GET', /^\/m\/([\w-]+)$/, async (req, res, m) => {
  const shop = await store.shopByKey(m[1]);
  if (!shop) return notFound(res, '상점을 찾을 수 없어요');
  const items = await store.itemsByShop(shop.id);
  const orders = await store.ordersForItems(items.map((i) => i.id));
  const total = orders.reduce((s, o) => s + o.price, 0);
  send(res, 200, page(shop.name, `
<h1>${esc(shop.name)} 관리</h1>
<div class="card"><b>내 상점 링크 (공유하세요)</b><br><code>${BASE}/s/${shop.id}</code><br><a href="/s/${shop.id}">열어보기</a></div>
<div class="warn">관리 주소는 비밀번호와 같아요. 북마크하고 공유하지 마세요: <code>${BASE}/m/${shop.key}</code></div>
<h2>매출 ${won(total)} · 판매 ${orders.length}건</h2>
<h2>아이템 추가</h2>
<form class="card" method="post" action="/m/${shop.key}/items">
<input name="title" placeholder="제목" required maxlength="80">
<input name="price" type="number" min="100" step="100" placeholder="가격 (원)" required>
<textarea name="preview" placeholder="미리보기 (결제 전 공개되는 설명)" required></textarea>
<textarea name="secret" placeholder="잠금 정보 (결제 후에만 공개: 내용, 링크 등)" required></textarea>
<label style="display:flex;gap:8px;align-items:center;margin:0 0 10px"><input type="checkbox" name="pub" checked style="width:auto;margin:0"> 상점 목록에 공개 (끄면 링크로만 열려요)</label>
<button>등록</button></form>
<h2>내 아이템</h2>
${items.map((i) => `<div class="card"><b>${esc(i.title)}</b> <span class="price">${won(i.price)}</span> <span class="sub">· ${i.pub ? '공개' : '비공개(링크로만)'}</span><br><a href="/i/${i.id}">${BASE}/i/${i.id}</a></div>`).join('') || '<p class="sub">아직 없어요</p>'}`));
});

route('POST', /^\/m\/([\w-]+)\/items$/, async (req, res, m) => {
  const shop = await store.shopByKey(m[1]);
  if (!shop) return notFound(res, '상점을 찾을 수 없어요');
  const f = await readForm(req);
  const price = parseInt(f.price, 10);
  if (!(price >= 100)) return send(res, 400, page('오류', '<h1>가격은 100원 이상이어야 해요</h1>'));
  const item = { id: rid(9), shop: shop.id, pub: f.pub === 'on', title: String(f.title).slice(0, 80), price, preview: String(f.preview).slice(0, 2000), secret: String(f.secret).slice(0, 10000), created: Date.now() };
  await store.createItem(item);
  redirect(res, `/m/${shop.key}`);
});

route('GET', /^\/s\/([\w-]+)$/, async (req, res, m) => {
  const shop = await store.shopById(m[1]);
  if (!shop) return notFound(res, '상점을 찾을 수 없어요');
  const items = (await store.itemsByShop(shop.id)).filter((i) => i.pub);
  send(res, 200, page(shop.name, `<h1>${esc(shop.name)}</h1><p class="sub">링크몰 상점</p>
${items.map((i) => `<a href="/i/${i.id}" style="text-decoration:none;color:inherit"><div class="card"><b>${esc(i.title)}</b><br><span class="price">${won(i.price)}</span></div></a>`).join('') || '<p class="sub">등록된 아이템이 없어요</p>'}`));
});

route('GET', /^\/i\/([\w-]+)$/, async (req, res, m) => {
  const item = await store.itemById(m[1]);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  const shop = await store.shopById(item.shop);
  const sold = (await store.ordersForItems([item.id])).length;
  send(res, 200, page(item.title, `<a class="sub" href="/s/${shop.id}">← ${esc(shop.name)}</a>
<h1>${esc(item.title)}</h1><p class="price" style="font-size:20px">${won(item.price)}</p><p class="sub">판매 ${sold}건</p>
<div class="card" style="white-space:pre-wrap">${esc(item.preview)}</div>
<div class="lock">🔒 결제하면 바로 잠금이 풀려요</div><br>
<form method="post" action="/i/${item.id}/pay"><button>${won(item.price)} 결제하고 열기 (테스트)</button></form>
<p class="sub">테스트 모드: 실제 결제 없이 버튼만 누르면 결제 완료로 처리됩니다.</p>`));
});

// ⚠️ 테스트 결제: 실제 서비스에서는 PG(토스페이먼츠/포트원) 결제 승인 확인 후에만 주문을 생성해야 합니다.
route('POST', /^\/i\/([\w-]+)\/pay$/, async (req, res, m) => {
  const item = await store.itemById(m[1]);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  const order = { token: rid(16), item: item.id, price: item.price, paidAt: Date.now() };
  await store.createOrder(order);
  await notify(await store.shopById(item.shop), `💰 새 주문! ${item.title} (${won(item.price)})`);
  redirect(res, `/o/${order.token}`);
});

route('GET', /^\/o\/([\w-]+)$/, async (req, res, m) => {
  const order = await store.orderByToken(m[1]);
  if (!order) return notFound(res, '주문을 찾을 수 없어요');
  const item = await store.itemById(order.item);
  send(res, 200, page('내 보관함', `<h1>🔓 잠금 해제됨</h1><h2>${esc(item.title)}</h2>
<div class="secret">${esc(item.secret)}</div>
<p class="sub">이 주소를 북마크하면 언제든 다시 볼 수 있어요: <code>${BASE}/o/${order.token}</code></p>`));
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  for (const r of routes) {
    const m = url.pathname.match(r.re);
    if (r.method === req.method && m) {
      try { return await r.fn(req, res, m); } catch (e) { console.error(e); return send(res, 500, page('오류', '<h1>문제가 생겼어요</h1>')); }
    }
  }
  notFound(res, '페이지를 찾을 수 없어요');
}).listen(PORT, () => console.log(`링크몰 실행 중 → ${BASE} (저장소: ${useSB ? 'Supabase' : 'db.json 파일'})`));
