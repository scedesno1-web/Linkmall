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

async function sbPatch(table, query, row) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${query}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`supabase PATCH ${table} ${r.status} ${await r.text()}`);
}
async function sbDelete(table, query) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${query}`, { method: 'DELETE', headers: sbHeaders({ Prefer: 'return=minimal' }) });
  if (!r.ok) throw new Error(`supabase DELETE ${table} ${r.status} ${await r.text()}`);
}

const sbStore = {
  async createShop(s) { await sbInsert('shops', s); },
  async updateShop(id, f) { await sbPatch('shops', `id=eq.${enc(id)}`, f); },
  async shopsByOwner(uid) { return sbGet('shops', `owner=eq.${enc(uid)}&select=*&order=created.desc`); },
  async shopBySms(t) { return (await sbGet('shops', `sms_token=eq.${enc(t)}&select=*`))[0]; },
  async createUser(u) { await sbInsert('users', u); },
  async userByEmail(e) { return (await sbGet('users', `email=eq.${enc(e)}&select=*`))[0]; },
  async userById(id) { return (await sbGet('users', `id=eq.${enc(id)}&select=*`))[0]; },
  async createDeposit(d) { await sbInsert('deposits', d); },
  async depositByToken(t) { return (await sbGet('deposits', `token=eq.${enc(t)}&select=*`))[0]; },
  async waitingDeposits(shopId) { return sbGet('deposits', `shop=eq.${enc(shopId)}&status=eq.waiting&select=*&order=created.desc`); },
  async setDepositDone(t) { await sbPatch('deposits', `token=eq.${enc(t)}`, { status: 'done' }); },
  async shopById(id) { return (await sbGet('shops', `id=eq.${enc(id)}&select=*`))[0]; },
  async shopByKey(key) { return (await sbGet('shops', `key=eq.${enc(key)}&select=*`))[0]; },
  async createItem(i) { await sbInsert('items', i); },
  async itemById(id) { return (await sbGet('items', `id=eq.${enc(id)}&select=*`))[0]; },
  async updateItem(id, f) { await sbPatch('items', `id=eq.${enc(id)}`, f); },
  async deleteItem(id) { await sbDelete('items', `id=eq.${enc(id)}`); },
  async updateUser(id, f) { await sbPatch('users', `id=eq.${enc(id)}`, f); },
  async userByCode(c) { const r = await sbGet('users', `id=like.${enc(c)}*&select=*&limit=2`); return r.length === 1 ? r[0] : null; },
  async listUsers(q) { return sbGet('users', `select=id,email,banned,created,extra_shops&order=created.desc&limit=100${q ? `&email=ilike.*${enc(q)}*` : ''}`); },
  async allShops() { return sbGet('shops', 'select=*&order=created.desc&limit=200'); },
  async searchShops(q, ownerIds) {
    const a = await sbGet('shops', `name=ilike.*${enc(q)}*&select=*&order=created.desc&limit=100`);
    const b = ownerIds.length ? await sbGet('shops', `owner=in.(${ownerIds.map(enc).join(',')})&select=*&order=created.desc&limit=100`) : [];
    const seen = new Set();
    return [...a, ...b].filter((x) => !seen.has(x.id) && seen.add(x.id)).sort((x, y) => y.created - x.created);
  },
  // 포인트 증감: points가 읽은 값 그대로일 때만 갱신(동시 결제에도 잔액이 틀어지지 않음). 잔액 부족이면 null
  async addPoints(uid, delta) {
    for (let n = 0; n < 8; n++) {
      const u = await sbStore.userById(uid);
      if (!u) return null;
      const cur = Number(u.points || 0); const np = cur + delta;
      if (np < 0) return null;
      const r = await fetch(`${SB_URL}/rest/v1/users?id=eq.${enc(uid)}&points=eq.${cur}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ points: np }) });
      if (!r.ok) throw new Error(`supabase addPoints ${r.status} ${await r.text()}`);
      if ((await r.json()).length) return np;
    }
    return null;
  },
  async addEarned(shopId, delta) {
    for (let n = 0; n < 8; n++) {
      const sh = await sbStore.shopById(shopId);
      if (!sh) return null;
      const cur = Number(sh.earned || 0); const np = Math.max(0, cur + delta);
      const r = await fetch(`${SB_URL}/rest/v1/shops?id=eq.${enc(shopId)}&earned=eq.${cur}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ earned: np }) });
      if (!r.ok) throw new Error(`supabase addEarned ${r.status} ${await r.text()}`);
      if ((await r.json()).length) return np;
    }
    return null;
  },
  async shopPoints(uid, shopId) { const r = await sbGet('shop_points', `user_id=eq.${enc(uid)}&shop=eq.${enc(shopId)}&select=points`); return r[0] ? Number(r[0].points) : 0; },
  // 상점별 포인트 증감(동시 결제에도 안전). 잔액 부족이면 null
  async addShopPoints(uid, shopId, delta) {
    for (let n = 0; n < 8; n++) {
      const r = await sbGet('shop_points', `user_id=eq.${enc(uid)}&shop=eq.${enc(shopId)}&select=points`);
      if (!r[0]) {
        if (delta < 0) return null;
        try { await sbInsert('shop_points', { user_id: uid, shop: shopId, points: delta }); return delta; }
        catch (e) { if (!/23505|409|duplicate/i.test(e.message)) throw e; continue; }
      }
      const cur = Number(r[0].points); const np = cur + delta;
      if (np < 0) return null;
      const rr = await fetch(`${SB_URL}/rest/v1/shop_points?user_id=eq.${enc(uid)}&shop=eq.${enc(shopId)}&points=eq.${cur}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ points: np }) });
      if (!rr.ok) throw new Error(`supabase addShopPoints ${rr.status} ${await rr.text()}`);
      if ((await rr.json()).length) return np;
    }
    return null;
  },
  async userShopPoints(uid) { return sbGet('shop_points', `user_id=eq.${enc(uid)}&select=shop,points&order=points.desc`); },
  async shopCharges(shopId) { return sbGet('charges', `shop=eq.${enc(shopId)}&status=eq.waiting&select=*&order=created.desc&limit=100`); },
  async userShopCharges(uid, shopId) { return sbGet('charges', `user_id=eq.${enc(uid)}&shop=eq.${enc(shopId)}&status=eq.waiting&select=*&order=created.desc`); },
  async ledgerForUserShop(uid, shopId) { return sbGet('ledger', `user_id=eq.${enc(uid)}&shop=eq.${enc(shopId)}&select=*&order=created.desc&limit=30`); },
  async createCharge(c) { await sbInsert('charges', c); },
  async reviewByToken(t) { return (await sbGet('reviews', `token=eq.${enc(t)}&select=*`))[0]; },
  async reviewById(id) { return (await sbGet('reviews', `id=eq.${enc(id)}&select=*`))[0]; },
  async createReview(r) { await sbInsert('reviews', r); },
  async updateReview(id, f) { await sbPatch('reviews', `id=eq.${enc(id)}`, f); },
  async deleteReview(id) { await sbDelete('reviews', `id=eq.${enc(id)}`); },
  async reviewsForItem(itemId) { return sbGet('reviews', `item=eq.${enc(itemId)}&select=*&order=created.desc&limit=100`); },
  async reviewsByShop(shopId) { return sbGet('reviews', `shop=eq.${enc(shopId)}&select=item,rating&limit=2000`); },
  async createShopRequest(r) { try { await sbInsert('shop_requests', r); } catch (e) { if (!/23505|409|duplicate/i.test(e.message)) throw e; } },
  async shopRequestByUser(uid) { return (await sbGet('shop_requests', `user_id=eq.${enc(uid)}&select=*`))[0]; },
  async deleteShopRequest(uid) { await sbDelete('shop_requests', `user_id=eq.${enc(uid)}`); },
  async listShopRequests() { return sbGet('shop_requests', 'select=*&order=created.asc&limit=100'); },
  async chargeByToken(t) { return (await sbGet('charges', `token=eq.${enc(t)}&select=*`))[0]; },
  async waitingCharges() { return sbGet('charges', 'status=eq.waiting&select=*&order=created.desc&limit=200'); },
  async userCharges(uid) { return sbGet('charges', `user_id=eq.${enc(uid)}&status=eq.waiting&select=*&order=created.desc`); },
  async claimCharge(t, to = 'done') {
    const r = await fetch(`${SB_URL}/rest/v1/charges?token=eq.${enc(t)}&status=eq.waiting`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ status: to }) });
    if (!r.ok) throw new Error(`supabase claimCharge ${r.status} ${await r.text()}`);
    return (await r.json()).length > 0;
  },
  async addLedger(l) { await sbInsert('ledger', l); },
  async ledgerForUser(uid) { return sbGet('ledger', `user_id=eq.${enc(uid)}&select=*&order=created.desc&limit=30`); },
  async createTitle(t) { await sbInsert('titles', t); },
  async titlesByShop(shopId) { return sbGet('titles', `shop=eq.${enc(shopId)}&select=*&order=created.asc`); },
  async titleById(id) { return (await sbGet('titles', `id=eq.${enc(id)}&select=*`))[0]; },
  async deleteTitle(id) { await sbDelete('user_titles', `title=eq.${enc(id)}`); await sbDelete('titles', `id=eq.${enc(id)}`); },
  async grantTitle(uid, tid, shopId) { try { await sbInsert('user_titles', { user_id: uid, title: tid, shop: shopId, created: Date.now() }); } catch (e) { if (!/23505|409|duplicate/i.test(e.message)) throw e; } },
  async revokeTitle(uid, tid) { await sbDelete('user_titles', `user_id=eq.${enc(uid)}&title=eq.${enc(tid)}`); },
  async titleHolders(tid) { return sbGet('user_titles', `title=eq.${enc(tid)}&select=user_id&limit=50`); },
  async userTitles(uid) {
    const g = await sbGet('user_titles', `user_id=eq.${enc(uid)}&select=title`);
    if (!g.length) return [];
    return sbGet('titles', `id=in.(${g.map((x) => enc(x.title)).join(',')})&select=*`);
  },
  // 재고 한 줄 꺼내기: stock_ver가 그대로일 때만 갱신(동시에 두 명이 같은 줄을 가져가는 걸 막음)
  async popStock(itemId) {
    for (let n = 0; n < 8; n++) {
      const it = await sbStore.itemById(itemId);
      if (!it || it.stock == null) return null;
      const lines = stockLines(it.stock);
      if (!lines.length) return null;
      const ver = it.stock_ver || 0;
      const r = await fetch(`${SB_URL}/rest/v1/items?id=eq.${enc(itemId)}&stock_ver=eq.${ver}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ stock: lines.slice(1).join('\n'), stock_ver: ver + 1 }) });
      if (!r.ok) throw new Error(`supabase popStock ${r.status} ${await r.text()}`);
      if ((await r.json()).length) return lines[0];
    }
    return null;
  },
  async itemsByShop(shopId) { return sbGet('items', `shop=eq.${enc(shopId)}&select=*&order=created.desc`); },
  async createOrder(o) { await sbInsert('orders', { token: o.token, item: o.item, price: o.price, paid_at: o.paidAt, ...(o.delivered != null ? { delivered: o.delivered } : {}), ...(o.buyer ? { buyer: o.buyer } : {}) }); },
  async orderByToken(t) {
    const o = (await sbGet('orders', `token=eq.${enc(t)}&select=*`))[0];
    return o && { token: o.token, item: o.item, price: o.price, paidAt: o.paid_at, delivered: o.delivered, buyer: o.buyer };
  },
  async ordersForItems(ids) {
    if (!ids.length) return [];
    return (await sbGet('orders', `item=in.(${ids.map(enc).join(',')})&select=*`)).map((o) => ({ token: o.token, item: o.item, price: o.price, paidAt: o.paid_at, delivered: o.delivered, buyer: o.buyer }));
  },
};

const DB = path.join(__dirname, 'db.json');
const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return { shops: {}, items: {}, orders: {} }; } };
const save = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));
const L = () => { const d = load(); d.users = d.users || {}; d.deposits = d.deposits || {}; d.charges = d.charges || {}; d.ledger = d.ledger || []; d.titles = d.titles || {}; d.user_titles = d.user_titles || []; d.shop_points = d.shop_points || {}; d.reviews = d.reviews || {}; d.shop_requests = d.shop_requests || {}; return d; };
const fileStore = {
  async updateShop(id, f) { const d = L(); if (d.shops[id]) Object.assign(d.shops[id], f); save(d); },
  async shopsByOwner(uid) { return Object.values(L().shops).filter((s) => s.owner === uid).sort((a, b) => b.created - a.created); },
  async shopBySms(t) { return Object.values(L().shops).find((s) => s.sms_token === t); },
  async createUser(u) { const d = L(); d.users[u.id] = u; save(d); },
  async userByEmail(e) { return Object.values(L().users).find((u) => u.email === e); },
  async userById(id) { return L().users[id]; },
  async createDeposit(x) { const d = L(); d.deposits[x.token] = x; save(d); },
  async depositByToken(t) { return L().deposits[t]; },
  async waitingDeposits(shopId) { return Object.values(L().deposits).filter((x) => x.shop === shopId && x.status === 'waiting').sort((a, b) => b.created - a.created); },
  async setDepositDone(t) { const d = L(); if (d.deposits[t]) d.deposits[t].status = 'done'; save(d); },
  async createShop(s) { const d = load(); d.shops[s.id] = s; save(d); },
  async shopById(id) { return load().shops[id]; },
  async shopByKey(key) { return Object.values(load().shops).find((s) => s.key === key); },
  async createItem(i) { const d = load(); d.items[i.id] = i; save(d); },
  async itemById(id) { return load().items[id]; },
  async updateItem(id, f) { const d = load(); if (d.items[id]) Object.assign(d.items[id], f); save(d); },
  async deleteItem(id) { const d = load(); delete d.items[id]; save(d); },
  async updateUser(id, f) { const d = L(); if (d.users[id]) Object.assign(d.users[id], f); save(d); },
  async userByCode(c) { const r = Object.values(L().users).filter((u) => u.id.startsWith(c)); return r.length === 1 ? r[0] : null; },
  async listUsers(q) { return Object.values(L().users).filter((u) => !q || u.email.includes(q.toLowerCase())).sort((a, b) => b.created - a.created).slice(0, 100).map((u) => ({ id: u.id, email: u.email, banned: !!u.banned, created: u.created, extra_shops: u.extra_shops || 0 })); },
  async allShops() { return Object.values(L().shops).sort((a, b) => b.created - a.created); },
  async searchShops(q, ownerIds) { const k = q.toLowerCase(); return Object.values(L().shops).filter((x) => String(x.name || '').toLowerCase().includes(k) || ownerIds.includes(x.owner)).sort((a, b) => b.created - a.created); },
  async addPoints(uid, delta) { const d = L(); const u = d.users[uid]; if (!u) return null; const np = Number(u.points || 0) + delta; if (np < 0) return null; u.points = np; save(d); return np; },
  async addEarned(shopId, delta) { const d = L(); const sh = d.shops[shopId]; if (!sh) return null; sh.earned = Math.max(0, Number(sh.earned || 0) + delta); save(d); return sh.earned; },
  async shopPoints(uid, shopId) { return Number(L().shop_points[uid + '|' + shopId] || 0); },
  async addShopPoints(uid, shopId, delta) { const d = L(); const k = uid + '|' + shopId; const np = Number(d.shop_points[k] || 0) + delta; if (np < 0) return null; d.shop_points[k] = np; save(d); return np; },
  async userShopPoints(uid) { return Object.entries(L().shop_points).filter(([k]) => k.startsWith(uid + '|')).map(([k, v]) => ({ shop: k.split('|')[1], points: v })); },
  async shopCharges(shopId) { return Object.values(L().charges).filter((c) => c.shop === shopId && c.status === 'waiting').sort((a, b) => b.created - a.created); },
  async userShopCharges(uid, shopId) { return Object.values(L().charges).filter((c) => c.user_id === uid && c.shop === shopId && c.status === 'waiting').sort((a, b) => b.created - a.created); },
  async ledgerForUserShop(uid, shopId) { return L().ledger.filter((l) => l.user_id === uid && l.shop === shopId).sort((a, b) => b.created - a.created).slice(0, 30); },
  async createCharge(c) { const d = L(); d.charges[c.token] = c; save(d); },
  async reviewByToken(t) { return Object.values(L().reviews).find((r) => r.token === t); },
  async reviewById(id) { return L().reviews[id]; },
  async createReview(r) { const d = L(); d.reviews[r.id] = r; save(d); },
  async updateReview(id, f) { const d = L(); if (d.reviews[id]) Object.assign(d.reviews[id], f); save(d); },
  async deleteReview(id) { const d = L(); delete d.reviews[id]; save(d); },
  async reviewsForItem(itemId) { return Object.values(L().reviews).filter((r) => r.item === itemId).sort((a, b) => b.created - a.created).slice(0, 100); },
  async reviewsByShop(shopId) { return Object.values(L().reviews).filter((r) => r.shop === shopId).map((r) => ({ item: r.item, rating: r.rating })); },
  async createShopRequest(r) { const d = L(); if (!d.shop_requests[r.user_id]) d.shop_requests[r.user_id] = r; save(d); },
  async shopRequestByUser(uid) { return L().shop_requests[uid]; },
  async deleteShopRequest(uid) { const d = L(); delete d.shop_requests[uid]; save(d); },
  async listShopRequests() { return Object.values(L().shop_requests).sort((a, b) => a.created - b.created); },
  async chargeByToken(t) { return L().charges[t]; },
  async waitingCharges() { return Object.values(L().charges).filter((c) => c.status === 'waiting').sort((a, b) => b.created - a.created); },
  async userCharges(uid) { return Object.values(L().charges).filter((c) => c.user_id === uid && c.status === 'waiting').sort((a, b) => b.created - a.created); },
  async claimCharge(t, to = 'done') { const d = L(); const c = d.charges[t]; if (!c || c.status !== 'waiting') return false; c.status = to; save(d); return true; },
  async addLedger(l) { const d = L(); d.ledger.push(l); save(d); },
  async ledgerForUser(uid) { return L().ledger.filter((l) => l.user_id === uid).sort((a, b) => b.created - a.created).slice(0, 30); },
  async createTitle(t) { const d = L(); d.titles[t.id] = t; save(d); },
  async titlesByShop(shopId) { return Object.values(L().titles).filter((t) => t.shop === shopId).sort((a, b) => a.created - b.created); },
  async titleById(id) { return L().titles[id]; },
  async deleteTitle(id) { const d = L(); delete d.titles[id]; d.user_titles = d.user_titles.filter((x) => x.title !== id); save(d); },
  async grantTitle(uid, tid, shopId) { const d = L(); if (!d.user_titles.some((x) => x.user_id === uid && x.title === tid)) d.user_titles.push({ user_id: uid, title: tid, shop: shopId, created: Date.now() }); save(d); },
  async revokeTitle(uid, tid) { const d = L(); d.user_titles = d.user_titles.filter((x) => !(x.user_id === uid && x.title === tid)); save(d); },
  async titleHolders(tid) { return L().user_titles.filter((x) => x.title === tid).slice(0, 50).map((x) => ({ user_id: x.user_id })); },
  async userTitles(uid) { const d = L(); return d.user_titles.filter((x) => x.user_id === uid).map((x) => d.titles[x.title]).filter(Boolean); },
  async popStock(itemId) {
    const d = load(); const it = d.items[itemId];
    if (!it || it.stock == null) return null;
    const lines = stockLines(it.stock);
    if (!lines.length) return null;
    it.stock = lines.slice(1).join('\n'); save(d);
    return lines[0];
  },
  async itemsByShop(shopId) { return Object.values(load().items).filter((i) => i.shop === shopId).sort((a, b) => b.created - a.created); },
  async createOrder(o) { const d = load(); d.orders[o.token] = o; save(d); },
  async orderByToken(t) { return load().orders[t]; },
  async ordersForItems(ids) { return Object.values(load().orders).filter((o) => ids.includes(o.item)); },
};
// 재고: 줄바꿈으로 한 줄에 하나. 빈 줄은 무시
const stockLines = (t) => String(t == null ? '' : t).split('\n').map((x) => x.trim()).filter(Boolean);
const parseStock = (t) => stockLines(t).slice(0, 2000).map((x) => x.slice(0, 1000)).join('\n');
const store = useSB ? sbStore : fileStore;

// ---------- 공통 ----------
const rid = (n = 6) => crypto.randomBytes(n).toString('base64url');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = (n) => Number(n).toLocaleString('ko-KR') + '원';

// ---------- 토스페이먼츠 (키가 없으면 기존 테스트 결제 유지) ----------
const TOSS_CK = (process.env.TOSS_CLIENT_KEY || '').trim();
const TOSS_SK = (process.env.TOSS_SECRET_KEY || '').trim();
const useToss = !!(TOSS_CK && TOSS_SK);
const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const BANKS = { '02': '산업은행', '03': '기업은행', '06': '국민은행', '07': '수협은행', '11': '농협은행', '20': '우리은행', '23': 'SC제일은행', '31': '대구은행', '32': '부산은행', '34': '광주은행', '35': '제주은행', '37': '전북은행', '39': '경남은행', '45': '새마을금고', '48': '신협', '71': '우체국', '81': '하나은행', '88': '신한은행', '89': '케이뱅크', '90': '카카오뱅크', '92': '토스뱅크' };

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
const page = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/png" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><title>${esc(title)}</title><style>${css}</style></head><body><div class="w">${body}</div></body></html>`;

const pointsBlock = (item, me, bal, shop) => {
  const price = Number(item.price);
  const canCharge = !!(shop.bank && shop.account && shop.holder);
  if (!me) return `<div class="lock">🔒 이 상점 포인트로 구매하면 바로 잠금이 풀려요</div><br><a class="btn" href="/login?next=${enc('/i/' + item.id)}">로그인하고 구매하기</a>`;
  return `<div class="lock">🔒 이 상점 포인트로 구매하면 바로 잠금이 풀려요</div><br>
<div class="card"><span class="sub">${esc(shop.name)} 포인트 (1P = 1원, 이 상점에서만 사용)</span><br><b>${pts(bal)}</b>
${bal >= price ? `<form method="post" action="/i/${item.id}/buy" onsubmit="return confirm('${price.toLocaleString('ko-KR')}P를 사용해 구매할까요?')"><button>${pts(price)}로 구매하기</button></form>` : `<p class="warn">포인트가 ${pts(price - bal)} 부족해요</p>`}
${canCharge ? `<a href="/w/${shop.id}">이 상점 포인트 충전하기</a>` : '<p class="sub">이 상점은 아직 충전을 받지 않아요</p>'}</div>`;
};
const payBlock = (item, shop) => {
  const hasDep = !!(shop && shop.bank && shop.account);
  if (!useToss && !hasDep) return `<div class="lock">🔒 결제하면 바로 잠금이 풀려요</div><br>
<form method="post" action="/i/${item.id}/pay"><button>${won(item.price)} 결제하고 열기 (테스트)</button></form>
<p class="sub">테스트 모드: 실제 결제 없이 버튼만 누르면 결제 완료로 처리됩니다.</p>`;
  let out = `<div class="lock">🔒 결제하면 바로 잠금이 풀려요</div><br>`;
  if (hasDep) out += `<div class="card"><b>🏦 계좌로 입금</b>
<p class="sub">${shop.pay_mode === 'auto' ? '입금이 확인되면 자동으로 열려요' : '판매자가 입금을 확인하면 열려요'}</p>
<form method="post" action="/i/${item.id}/deposit"><input name="name" placeholder="입금자명 (은행 앱에 찍히는 내 이름)" required minlength="2" maxlength="20"><button style="background:#0f766e">${won(item.price)} 입금 신청</button></form></div>`;
  if (useToss) {
    const orderId = item.id + rid(10); // 앞 12자 = 아이템 ID, 뒤 14자 = 랜덤 (총 26자)
    out += `<div class="card"><button id="payVbank" style="background:#0f766e">🏦 ${won(item.price)} 가상계좌로 입금</button><br><br>
<button id="payCard">💳 ${won(item.price)} 카드로 결제</button>
<p class="sub" id="payMsg">가상계좌는 입금이 확인되면 자동으로 열려요. 결제 후 나오는 주소를 꼭 저장해 두세요.</p></div>
<script src="https://js.tosspayments.com/v2/standard"></script>
<script>
const pay = async (method) => {
  try {
    const tp = TossPayments(${js(TOSS_CK)});
    const payment = tp.payment({ customerKey: TossPayments.ANONYMOUS });
    await payment.requestPayment({
      method: method,
      amount: { currency: 'KRW', value: ${Number(item.price)} },
      orderId: ${js(orderId)},
      orderName: ${js(String(item.title).slice(0, 100))},
      successUrl: ${js(BASE + '/pay/success')},
      failUrl: ${js(BASE + '/pay/fail')}
    });
  } catch (e) { document.getElementById('payMsg').textContent = '결제가 취소되었거나 열 수 없어요.'; }
};
document.getElementById('payCard').onclick = () => pay('CARD');
document.getElementById('payVbank').onclick = () => pay('VIRTUAL_ACCOUNT');
</script>`;
  }
  return out;
};

const send = (res, code, html, headers = {}) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
const redirect = (res, to, headers = {}) => { res.writeHead(303, { Location: to, ...headers }); res.end(); };
const readForm = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b))));
});

const NOTI = { sale: '💰 판매 (새 주문)', charge: '⏳ 포인트 충전 신청', stock: '📦 재고 알림 (재고가 0이 됐을 때)' };
// 저장 형태: 주소 또는 주소#n=sale,warn  (#n= 없음 = 전부 켜짐, #n=- = 전부 꺼짐)
const parseHook = (w) => {
  const [url, frag = ''] = String(w || '').split('#');
  const mm = frag.match(/^n=(.*)$/);
  const on = mm ? (mm[1] === '-' ? [] : mm[1].split(',').map((k) => (k === 'warn' ? 'stock' : k)).filter((k) => NOTI[k])) : Object.keys(NOTI);
  return { url, on };
};
const buildHook = (url, on) => (!url ? '' : on.length === Object.keys(NOTI).length ? url : url + '#n=' + (on.length ? on.join(',') : '-'));
const MAX_HOOKS = 5; // 상점당 웹훅 최대 개수
const HOOK_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//;
const HOOK_SAVE_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/[\w\-\/.]+$/;
// 저장 형태: 줄바꿈으로 구분된 여러 개 (예전 1개짜리 값도 그대로 읽힘)
const parseHooks = (w) => String(w || '').split('\n').map((x) => x.trim()).filter(Boolean).map(parseHook).filter((h) => h.url).slice(0, MAX_HOOKS);
const buildHooks = (list) => list.map((h) => buildHook(h.url, h.on)).join('\n');

async function notify(shop, text, kind = 'stock') {
  if (!shop || !shop.webhook) return;
  const targets = parseHooks(shop.webhook).filter((h) => HOOK_RE.test(h.url) && h.on.includes(kind)); // 판매자가 끈 종류는 안 보냄
  if (!targets.length) return;
  if (!sendOk('nt:' + shop.id, 3, 60000)) { console.error('알림 건너뜀(1분 3번 제한)', shop.id); return; }
  await Promise.all(targets.map((h) =>
    fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }) })
      .catch((e) => console.error('webhook 실패', e.message))));
}

// 등록된 웹훅 전부에 테스트 메시지를 보내고 개수별 결과를 돌려줌
async function testWebhooks(shop) {
  const hooks = parseHooks(shop && shop.webhook);
  return Promise.all(hooks.map(async (h, i) => {
    const n = i + 1;
    if (!HOOK_RE.test(h.url)) return { n, ok: false, msg: '디스코드 웹훅 주소 형식이 아니에요' };
    try {
      const r = await fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `✅ 링크몰 테스트 알림이에요. (웹훅 ${n}번) 선택한 알림이 이 채널로 와요.`, allowed_mentions: { parse: [] } }) });
      if (r.ok) return { n, ok: true };
      return { n, ok: false, msg: r.status === 404 || r.status === 401 ? '웹훅이 삭제됐거나 주소가 틀려요 (' + r.status + ')' : '디스코드가 거절했어요 (' + r.status + ')' };
    } catch (e) { return { n, ok: false, msg: '디스코드에 연결하지 못했어요' }; }
  }));
}
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const DEP_TTL = 24 * 3600 * 1000; // 입금 신청 유효시간 24시간

// ---------- 로그인 (쿠키 세션, 의존성 없음) ----------
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('linkmall-session:' + (SB_KEY || __dirname)).digest('hex');
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
const hashPw = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex'); };
const checkPw = (pw, stored) => {
  const [salt, h] = String(stored || '').split(':');
  if (!salt || !h) return false;
  const a = Buffer.from(h, 'hex'); const b = crypto.scryptSync(pw, salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const getCookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter((a) => a[0]));
const currentUser = async (req) => (req._cu !== undefined ? req._cu : (req._cu = await currentUserRaw(req)));
async function currentUserRaw(req) {
  const c = getCookies(req).sid;
  if (!c) return null;
  const [uid, exp, sig] = c.split('.');
  if (!uid || !exp || !sig || Number(exp) < Date.now()) return null;
  const user = await store.userById(uid);
  if (!user || user.banned) return null;
  const good = sign(uid + '.' + exp + '.' + pwTag(user));
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  return user;
}
const DAY = 86400000;
const pwTag = (u) => crypto.createHash('sha256').update(String(u.pw)).digest('hex').slice(0, 10);
const sessionCookie = (u) => { const exp = Date.now() + 30 * DAY; return `sid=${u.id}.${exp}.${sign(u.id + '.' + exp + '.' + pwTag(u))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}` + (BASE.startsWith('https') ? '; Secure' : ''); };
const clearCookie = 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[\w\-\/.?=&%]*$/.test(n)) ? n : '/my';
const fails = new Map();
const lockLeft = (k) => { const f = fails.get(k); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; };
const locked = (k) => lockLeft(k) > 0;
const waitText = (sec) => (sec >= 60 ? `${Math.ceil(sec / 60)}분` : `${sec}초`);
const lockMsg = (k) => `시도가 너무 많아요. ${waitText(lockLeft(k))} 뒤에 다시 해주세요`;
// 5번째 실패부터 잠금: 1분 → 2분 → 4분 → 8분 … (상한 60분). 24시간 동안 실패가 없으면 처음부터
const addFail = (k) => {
  const now = Date.now();
  let f = fails.get(k);
  if (!f || now - f.t > 86400000) f = { n: 0, until: 0, t: now };
  f.n += 1; f.t = now;
  if (f.n >= 5) f.until = now + Math.min(60 * 2 ** (f.n - 5), 3600) * 1000;
  fails.set(k, f);
};

// ---------- 이메일 인증 코드 (가입 때만, Brevo HTTP API) ----------
const BREVO_KEY = (process.env.BREVO_API_KEY || '').trim();
const MAIL_FROM = (process.env.MAIL_FROM || '').trim();
const MAIL_SCRIPT_URL = (process.env.MAIL_SCRIPT_URL || '').trim();       // 구글 앱스 스크립트 웹앱 주소 (선택)
const MAIL_SCRIPT_SECRET = (process.env.MAIL_SCRIPT_SECRET || '').trim(); // 스크립트와 맞춘 비밀 문자열
const useScript = !!(MAIL_SCRIPT_URL && MAIL_SCRIPT_SECRET);
const useMail = useScript || !!(BREVO_KEY && MAIL_FROM);
const MAIL_DAILY = useScript ? 90 : 250; // 앱스 스크립트(일반 Gmail)는 하루 수신자 100명 한도
const EMAIL_RE = /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/;
const sends = new Map();
const sendOk = (k, max, ms) => { const now = Date.now(); const a = (sends.get(k) || []).filter((t) => now - t < ms); if (a.length >= max) { sends.set(k, a); return false; } a.push(now); sends.set(k, a); return true; };
setInterval(() => { const now = Date.now(); for (const [k, a] of sends) if (!a.length || now - a[a.length - 1] > 86400000) sends.delete(k); for (const [k, f] of fails) if (now - f.t > 86400000) fails.delete(k); }, 600000).unref();
const codeHash = (email, code) => crypto.createHmac('sha256', SESSION_SECRET).update('code:' + email + ':' + code).digest('base64url');
const mkToken = (email, code) => { const p = Buffer.from(JSON.stringify({ e: email, x: Date.now() + 10 * 60000, c: codeHash(email, code) })).toString('base64url'); return p + '.' + sign(p); };
const readToken = (t) => {
  const [p, sg] = String(t || '').split('.');
  if (!p || !sg) return null;
  const good = sign(p);
  if (sg.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sg), Buffer.from(good))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.x > Date.now() ? o : null; } catch { return null; }
};
async function sendMail(to, subject, html) {
  try {
    if (useScript) {
      const r = await fetch(MAIL_SCRIPT_URL, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ secret: MAIL_SCRIPT_SECRET, to, subject, html }) });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || !d.ok) { console.error('script 메일 실패', r.status); return false; }
      return true;
    }
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: '링크몰', email: MAIL_FROM }, to: [{ email: to }], subject, htmlContent: html }),
    });
    if (!r.ok) { console.error('mail 실패', r.status, (await r.text()).slice(0, 200)); return false; }
    return true;
  } catch (e) { console.error('mail 오류', e.message); return false; }
}
const verifyPage = (res, t, next, email, err) => send(res, 200, page('인증 코드', `<h1>📧 인증 코드 입력</h1>
<p class="sub">${esc(email)} 로 6자리 코드를 보냈어요. 10분 안에 입력하세요. 안 오면 스팸함도 확인해 보세요.</p>${err ? `<p class="warn">${esc(err)}</p>` : ''}
<form class="card" method="post" action="/signup/verify"><input type="hidden" name="t" value="${esc(t)}"><input type="hidden" name="next" value="${esc(next)}">
<input name="code" placeholder="인증 코드 6자리" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
<input name="pw" type="password" placeholder="사용할 비밀번호 (8자 이상)" autocomplete="new-password" required minlength="8" maxlength="100">
<button>가입 완료</button></form>
<p class="sub"><a href="/login?next=${enc(next)}">처음부터 다시</a></p>`));

// ---------- 로봇 방지 (가입할 때만) ----------
// TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY 가 있으면 Cloudflare "로봇이 아닙니다" 체크박스,
// 없으면 내장 숫자 그림 퀴즈(설정 필요 없음)
const TS_SITE = (process.env.TURNSTILE_SITE_KEY || '').trim();
const TS_SECRET = (process.env.TURNSTILE_SECRET_KEY || '').trim();
const useTurnstile = !!(TS_SITE && TS_SECRET);
const DIGITS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};
const capHash = (a) => crypto.createHmac('sha256', SESSION_SECRET).update('cap:' + a).digest('base64url');
const usedCaps = new Map(); // 한 번 시도한 퀴즈는 다시 못 씀 (정답 돌려쓰기·무작위 대입 방지)
const R = (a, b) => a + Math.random() * (b - a);
function captchaHtml() {
  if (useTurnstile) return `<div class="cf-turnstile" data-sitekey="${esc(TS_SITE)}" style="margin:6px 0 10px"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;
  const ans = Array.from({ length: 5 }, () => crypto.randomInt(0, 10)).join('');
  const p = Buffer.from(JSON.stringify({ c: capHash(ans), x: Date.now() + 5 * 60000 })).toString('base64url');
  const tok = p + '.' + sign(p);
  let g = '';
  [...ans].forEach((d, i) => {
    const cells = DIGITS[d].flatMap((row, y) => [...row].map((v, x) => (v === '1' ? `<rect x="${(x * 5 + R(-0.6, 0.6)).toFixed(1)}" y="${(y * 5 + R(-0.6, 0.6)).toFixed(1)}" width="5" height="5"/>` : '')));
    g += `<g transform="translate(${12 + i * 34} ${R(8, 18).toFixed(1)}) rotate(${R(-14, 14).toFixed(1)} 12 17)" fill="hsl(${Math.floor(R(0, 360))} 55% 35%)">${cells.join('')}</g>`;
  });
  let noise = '';
  for (let i = 0; i < 5; i++) noise += `<line x1="${R(0, 190).toFixed(0)}" y1="${R(0, 64).toFixed(0)}" x2="${R(0, 190).toFixed(0)}" y2="${R(0, 64).toFixed(0)}" stroke="hsl(${Math.floor(R(0, 360))} 40% 55%)" stroke-width="1.6"/>`;
  return `<p class="sub" style="margin:8px 0 0">🤖 로봇이 아닙니다 확인 — 그림 속 숫자 5자리를 입력하세요</p>
<svg viewBox="0 0 190 64" style="width:190px;max-width:100%;background:#f3f4f6;border-radius:10px;margin:6px 0;display:block">${g}${noise}</svg>
<input type="hidden" name="ct" value="${tok}"><input name="cc" placeholder="숫자 5자리" inputmode="numeric" autocomplete="off" maxlength="5" required>
<p class="sub" style="margin:0 0 10px"><a href="javascript:location.reload()">그림이 안 보이면 새로 받기</a></p>`;
}
async function captchaOk(f, req) {
  if (useTurnstile) {
    const resp = String(f['cf-turnstile-response'] || '');
    if (!resp) return false;
    try {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret: TS_SECRET, response: resp, remoteip: ip }) });
      const d = await r.json();
      return !!d.success;
    } catch (e) { console.error('turnstile 오류', e.message); return false; }
  }
  const tok = readToken(f.ct);
  if (!tok) return false;
  const id = String(f.ct).split('.')[1];
  if (usedCaps.has(id)) return false;
  usedCaps.set(id, tok.x);
  if (usedCaps.size > 500) for (const [k, x] of usedCaps) if (x < Date.now()) usedCaps.delete(k);
  const a = Buffer.from(capHash(str(f.cc, 5)));
  const b = Buffer.from(String(tok.c || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const CAP_FAIL = '로봇 확인에 실패했어요. 새 그림으로 다시 해주세요';

// ---------- 포인트 · 관리자 설정 ----------
const ADMIN_LIST = (process.env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const isAdmin = (u) => !!u && useMail && ADMIN_LIST.includes(String(u.email).toLowerCase()); // 이메일 인증이 켜져 있어야 관리자 권한 동작(남이 먼저 가입해 가로채는 것 방지)
const CHARGE_TTL = 24 * 3600 * 1000;
const MIN_CHARGE = 1000; const MAX_CHARGE = 500000;
const pts = (n) => Number(n || 0).toLocaleString('ko-KR') + 'P';
const fmtDate = (t) => new Date(Number(t)).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
const FREE_SHOPS = 3; // 운영자 동의 없이 만들 수 있는 상점 수
const shopLimit = (u) => (isAdmin(u) ? Infinity : Math.max(0, FREE_SHOPS + Number(u.extra_shops || 0))); // 운영자가 사람마다 조절 (/admin)
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
const SEL_STYLE = 'width:100%;padding:12px;border:1px solid #d9dce1;border-radius:10px;font-size:15px;margin:4px 0 10px';
const badgeHtml = (name) => `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:#eef0ff;color:#4338ca;font-size:13px;margin:2px">${esc(name)}</span>`;
const titleSelect = (titles, cur) => (titles.length ? `<select name="title_id" style="${SEL_STYLE}"><option value="">구매 시 지급할 칭호 없음</option>${titles.map((t) => `<option value="${t.id}" ${t.id === cur ? 'selected' : ''}>🏷️ ${esc(t.name)} 자동 지급</option>`).join('')}</select>` : '');

// 관리 권한: 링크가 아니라 로그인한 상점 주인(또는 운영자)만
async function manageShop(req, res, key) {
  const shop = await store.shopByKey(key);
  if (!shop) { notFound(res, '상점을 찾을 수 없어요'); return null; }
  const u = await currentUser(req);
  if (!u) { redirect(res, '/login?next=' + enc('/m/' + shop.key)); return null; }
  if (isAdmin(u)) return shop;
  if (shop.deleted) { notFound(res, '삭제된 상점이에요'); return null; }
  if (!shop.owner) { redirect(res, '/claim/' + shop.key); return null; }
  if (u.id !== shop.owner) { send(res, 403, page('권한 없음', '<h1>이 상점의 주인이 아니에요</h1>')); return null; }
  return shop;
}
async function adminOnly(req, res) {
  const u = await currentUser(req);
  if (!u) { redirect(res, '/login?next=/admin'); return null; }
  if (!isAdmin(u)) { send(res, 403, page('권한 없음', '<h1>운영자만 볼 수 있어요</h1>')); return null; }
  return u;
}

// 충전 확인: 한 번만 포인트 지급(상태를 waiting→done으로 바꾼 쪽만 지급). 포인트는 그 상점 전용
async function confirmCharge(ch) {
  if (!ch.shop) return false;
  if (!(await store.claimCharge(ch.token, 'done'))) return false;
  const bal = await store.addShopPoints(ch.user_id, ch.shop, Number(ch.amount));
  if (bal == null) { console.error('충전 지급 실패', ch.token); return false; }
  await store.addLedger({ id: rid(9), user_id: ch.user_id, shop: ch.shop, delta: Number(ch.amount), kind: 'charge', ref: ch.token, note: '충전', created: Date.now() });
  return true;
}
// 꺼낸 재고 한 줄을 되돌림
async function restoreStock(itemId, line) {
  const it = await store.itemById(itemId);
  if (it) await store.updateItem(itemId, { stock: [line, ...stockLines(it.stock)].join('\n'), ...(useSB ? { stock_ver: (it.stock_ver || 0) + 1 } : {}) });
}

// 주문 생성 + 재고형 아이템이면 한 줄을 꺼내 구매자에게 지급
async function placeOrder(order, item) {
  let line = null;
  if (item.stock != null) {
    line = await store.popStock(item.id);
    order.delivered = line == null ? '' : line;
  }
  try { await store.createOrder(order); }
  catch (e) {
    if (line != null) { // 주문 저장 실패하면 꺼낸 줄을 되돌림
      const it = await store.itemById(item.id);
      if (it) await store.updateItem(item.id, { stock: [line, ...stockLines(it.stock)].join('\n'), ...(useSB ? { stock_ver: (it.stock_ver || 0) + 1 } : {}) });
    }
    throw e;
  }
  if (item.stock != null && line == null) await notify(await store.shopById(item.shop), `⚠️ 재고가 없는데 결제가 확인됐어요: ${item.title}. 구매자에게 직접 보내주세요 (${BASE}/o/${order.token})`, 'stock');
  return order;
}

// ---------- 계좌 입금 확인 ----------
async function confirmDeposit(dep) {
  const existing = await store.orderByToken(dep.token);
  if (existing) { if (dep.status !== 'done') await store.setDepositDone(dep.token); return existing; }
  const item = await store.itemById(dep.item);
  if (!item) return null;
  if (item.stock != null && !stockLines(item.stock).length) {
    await notify(await store.shopById(dep.shop), `⚠️ 재고가 0인데 입금이 도착했어요: ${item.title} · 입금자 ${dep.name} (${won(dep.amount)}). 입금자에게 환불해 주세요.`, 'stock');
    return null;
  }
  const order = { token: dep.token, item: dep.item, price: Number(dep.amount), paidAt: Date.now() };
  try { await placeOrder(order, item); } catch (e) {
    const again = await store.orderByToken(dep.token);
    if (again) return again;
    throw e;
  }
  await store.setDepositDone(dep.token);
  await notify(await store.shopById(dep.shop), `💰 입금 확인! ${item.title} (${won(order.price)})`, 'sale');
  return order;
}

const readBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => resolve(b));
});

// 토스에 주문번호로 결제 상태 조회 (실패하면 null)
async function tossPayment(orderId) {
  try {
    const r = await fetch('https://api.tosspayments.com/v1/payments/orders/' + enc(orderId), { headers: { Authorization: 'Basic ' + Buffer.from(TOSS_SK + ':').toString('base64') } });
    return r.ok ? await r.json() : null;
  } catch (e) { console.error('toss 조회 실패', e.message); return null; }
}

// 입금/결제 완료된 결제를 주문으로 기록 (여러 번 불려도 한 번만 생성)
async function finalizePaid(p) {
  const orderId = p.orderId;
  const existing = await store.orderByToken(orderId);
  if (existing) return existing;
  const item = await store.itemById(orderId.slice(0, 12));
  if (!item) return null;
  const order = { token: orderId, item: item.id, price: Number(p.totalAmount), paidAt: Date.now() };
  try { await placeOrder(order, item); } catch (e) {
    const again = await store.orderByToken(orderId);
    if (again) return again;
    throw e;
  }
  await notify(await store.shopById(item.shop), `💰 새 주문! ${item.title} (${won(order.price)})`, 'sale');
  return order;
}

// ---------- 라우트 ----------
const routes = [];
const route = (method, re, fn) => routes.push({ method, re, fn });

// 웹 아이콘 (파비콘 / 홈 화면 아이콘). 이미지는 코드에 포함돼 있어 파일이 따로 필요 없어요
const ICON_SMALL = Buffer.from('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', 'base64');
const ICON_LARGE = Buffer.from('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', 'base64');
route('GET', /^\/(favicon\.ico|apple-touch-icon\.png)$/, (req, res, m) => {
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
  res.end(m[1] === 'favicon.ico' ? ICON_SMALL : ICON_LARGE);
});
const notFound = (res, msg) => send(res, 404, page('없음', `<h1>${msg}</h1>`));

route('GET', /^\/$/, async (req, res) => {
  const u = await currentUser(req);
  send(res, 200, page('링크몰', `
<h1>🔗 링크몰</h1><p class="sub">링크 하나로 팔고, 결제되면 자동으로 열려요.</p>
<div class="card">${u ? '<a class="btn" href="/my">내 상점으로 가기</a>' : '<a class="btn" href="/login">로그인 · 가입하고 상점 만들기</a>'}</div>`));
});

route('GET', /^\/login$/, async (req, res) => {
  const q = new URL(req.url, BASE).searchParams;
  const next = safeNext(q.get('next'));
  const err = q.get('e');
  const signup = useMail
    ? `<form class="card" method="post" action="/signup/start"><b>처음이면 가입</b><input type="hidden" name="next" value="${esc(next)}">
<input name="email" type="email" placeholder="이메일" autocomplete="username" required maxlength="100">
${captchaHtml()}
<button>인증 코드 받기</button><p class="sub">이메일로 6자리 코드를 보내드려요.</p></form>`
    : `<form class="card" method="post" action="/signup"><b>처음이면 가입</b><input type="hidden" name="next" value="${esc(next)}">
<input name="email" placeholder="이메일" autocomplete="username" required maxlength="100">
<input name="pw" type="password" placeholder="비밀번호 (8자 이상)" autocomplete="new-password" required minlength="8" maxlength="100">
${captchaHtml()}
<button>가입하기</button></form>`;
  send(res, 200, page('로그인', `<h1>🔗 로그인</h1>${err ? `<p class="warn">${esc(err)}</p>` : ''}
<form class="card" method="post" action="/login"><b>로그인</b><input type="hidden" name="next" value="${esc(next)}">
<input name="email" placeholder="이메일" autocomplete="username" required maxlength="100">
<input name="pw" type="password" placeholder="비밀번호" autocomplete="current-password" required maxlength="100">
<button>로그인</button></form>
${signup}`));
});

route('POST', /^\/signup\/start$/, async (req, res) => {
  const f = await readForm(req);
  const next = safeNext(f.next);
  const back = (e) => redirect(res, `/login?e=${enc(e)}&next=${enc(next)}`);
  if (!useMail) return back('이메일 인증이 설정되지 않았어요');
  if (!(await captchaOk(f, req))) return back(CAP_FAIL);
  const email = str(f.email, 100).toLowerCase();
  if (!EMAIL_RE.test(email)) return back('이메일 형식이 아니에요');
  if (await store.userByEmail(email)) return back('이미 가입된 이메일이에요');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!sendOk('e:' + email, 1, 60000)) return back('1분 뒤에 다시 요청해 주세요');
  if (!sendOk('ip:' + ip, 20, 3600000) || !sendOk('all', MAIL_DAILY, 86400000)) return back('요청이 너무 많아요. 잠시 뒤에 다시 해주세요');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const ok = await sendMail(email, `[링크몰] 인증 코드 ${code}`, `<div style="font-family:sans-serif"><p>링크몰 가입 인증 코드예요.</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>10분 안에 입력해 주세요. 본인이 요청하지 않았다면 무시하세요.</p></div>`);
  if (!ok) return back('메일을 보내지 못했어요. 잠시 뒤에 다시 해주세요');
  verifyPage(res, mkToken(email, code), next, email, '');
});

route('POST', /^\/signup\/verify$/, async (req, res) => {
  const f = await readForm(req);
  const next = safeNext(f.next);
  const tok = readToken(f.t);
  if (!tok) return redirect(res, `/login?e=${enc('인증 시간이 지났어요. 다시 시도해 주세요')}&next=${enc(next)}`);
  const key = 'v:' + tok.e;
  const again = (e) => verifyPage(res, f.t, next, tok.e, e);
  if (locked(key)) return again(lockMsg(key));
  const a = Buffer.from(codeHash(tok.e, str(f.code, 6)));
  const b = Buffer.from(tok.c);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { addFail(key); return again('코드가 맞지 않아요'); }
  const pw = String(f.pw || '');
  if (pw.length < 8 || pw.length > 100) return again('비밀번호는 8자 이상이어야 해요');
  if (await store.userByEmail(tok.e)) return redirect(res, `/login?e=${enc('이미 가입된 이메일이에요')}&next=${enc(next)}`);
  const user = { id: rid(9), email: tok.e, pw: hashPw(pw), created: Date.now() };
  await store.createUser(user);
  fails.delete(key);
  redirect(res, next, { 'Set-Cookie': sessionCookie(user) });
});

route('POST', /^\/signup$/, async (req, res) => {
  const f = await readForm(req);
  if (useMail) return redirect(res, `/login?e=${enc('이메일 인증으로 가입해 주세요')}&next=${enc(safeNext(f.next))}`);
  const email = str(f.email, 100).toLowerCase();
  const pw = String(f.pw || '');
  const back = (e) => redirect(res, `/login?e=${enc(e)}&next=${enc(safeNext(f.next))}`);
  if (!(await captchaOk(f, req))) return back(CAP_FAIL);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return back('이메일 형식이 아니에요');
  if (pw.length < 8 || pw.length > 100) return back('비밀번호는 8자 이상이어야 해요');
  if (await store.userByEmail(email)) return back('이미 가입된 이메일이에요');
  const user = { id: rid(9), email, pw: hashPw(pw), created: Date.now() };
  await store.createUser(user);
  redirect(res, safeNext(f.next), { 'Set-Cookie': sessionCookie(user) });
});

route('POST', /^\/login$/, async (req, res) => {
  const f = await readForm(req);
  const email = str(f.email, 100).toLowerCase();
  const back = (e) => redirect(res, `/login?e=${enc(e)}&next=${enc(safeNext(f.next))}`);
  if (locked(email)) return back(lockMsg(email));
  const user = await store.userByEmail(email);
  if (!user || !checkPw(String(f.pw || '').slice(0, 100), user.pw)) { addFail(email); return back('이메일 또는 비밀번호가 맞지 않아요'); }
  if (user.banned) return back('정지된 계정이에요');
  fails.delete(email);
  redirect(res, safeNext(f.next), { 'Set-Cookie': sessionCookie(user) });
});

route('GET', /^\/account$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=/account');
  const q = new URL(req.url, BASE).searchParams;
  send(res, 200, page('계정 설정', `<a class="sub" href="/my">← 내 상점</a><h1>계정 설정</h1><p class="sub">${esc(u.email)}</p>
${q.get('m') ? `<p class="card">${esc(q.get('m'))}</p>` : ''}${q.get('e') ? `<p class="warn">${esc(q.get('e'))}</p>` : ''}
<form class="card" method="post" action="/account/password"><b>비밀번호 변경</b>
<input name="cur" type="password" placeholder="현재 비밀번호" autocomplete="current-password" required maxlength="100">
<input name="pw" type="password" placeholder="새 비밀번호 (8자 이상)" autocomplete="new-password" required minlength="8" maxlength="100">
<input name="pw2" type="password" placeholder="새 비밀번호 확인" autocomplete="new-password" required minlength="8" maxlength="100">
<button>변경하기</button></form>`));
});

route('POST', /^\/account\/password$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=/account');
  const f = await readForm(req);
  const back = (k, t) => redirect(res, `/account?${k}=${enc(t)}`);
  const key = 'pw:' + u.id;
  if (locked(key)) return back('e', lockMsg(key));
  const cur = String(f.cur || '').slice(0, 100);
  if (!checkPw(cur, u.pw)) { addFail(key); return back('e', '현재 비밀번호가 맞지 않아요'); }
  const pw = String(f.pw || '');
  if (pw.length < 8 || pw.length > 100) return back('e', '새 비밀번호는 8자 이상이어야 해요');
  if (pw !== String(f.pw2 || '')) return back('e', '새 비밀번호 확인이 달라요');
  if (pw === cur) return back('e', '현재와 다른 비밀번호를 써주세요');
  const nu = { ...u, pw: hashPw(pw) };
  await store.updateUser(u.id, { pw: nu.pw });
  fails.delete(key);
  redirect(res, '/account?m=' + enc('비밀번호를 바꿨어요'), { 'Set-Cookie': sessionCookie(nu) });
});

route('POST', /^\/logout$/, (req, res) => redirect(res, '/', { 'Set-Cookie': clearCookie }));

route('GET', /^\/my$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=/my');
  const q = new URL(req.url, BASE).searchParams;
  const shops = (await store.shopsByOwner(u.id)).filter((x) => !x.deleted);
  const limit = shopLimit(u);
  const atLimit = shops.length >= limit;
  const pendingReq = atLimit ? await store.shopRequestByUser(u.id) : null;
  send(res, 200, page('내 상점', `<h1>내 상점</h1><p class="sub">${esc(u.email)} · <a href="/account">비밀번호 변경</a></p>
${q.get('m') ? `<p class="card">${esc(q.get('m'))}</p>` : ''}${q.get('e') ? `<p class="warn">${esc(q.get('e'))}</p>` : ''}
<div class="card"><a href="/wallet">💰 내 포인트 · 칭호</a>${isAdmin(u) ? ' · <a href="/admin">👑 관리자</a>' : ''}</div>
${shops.map((x) => `<div class="card"><b>${esc(x.name)}</b><br><a href="/m/${x.key}">관리하기</a> · <a href="/s/${x.id}">상점 보기</a></div>`).join('') || '<p class="sub">아직 상점이 없어요</p>'}
${atLimit ? `<div class="card"><b>상점은 ${limit}개까지 만들 수 있어요 (현재 ${shops.length}개)</b><p class="sub">더 만들려면 운영자의 동의가 필요해요.</p>${pendingReq ? '<p class="warn">신청이 접수됐어요. 운영자가 승인하면 상점을 만들 수 있어요.</p>' : `<form method="post" action="/my/shop-request"><textarea name="note" placeholder="상점이 더 필요한 이유" required maxlength="300"></textarea><button>상점 추가 신청</button></form>`}</div>` : `<form class="card" method="post" action="/shops"><b>새 상점 만들기</b> <span class="sub">(${shops.length}/${Number.isFinite(limit) ? limit : '제한 없음'})</span><br>
<input name="name" placeholder="상점 이름" required maxlength="40">
<input name="webhook" placeholder="디스코드 웹훅 URL (선택, 판매 알림용)">
<button>상점 만들기</button></form>`}
<form method="post" action="/logout"><button style="background:#6b7280">로그아웃</button></form>`));
});

route('POST', /^\/shops$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=/my');
  const f = await readForm(req);
  const mine = (await store.shopsByOwner(u.id)).filter((x) => !x.deleted);
  if (mine.length >= shopLimit(u)) return redirect(res, `/my?e=${enc('상점을 더 만들려면 운영자의 동의가 필요해요')}`);
  const shop = { id: rid(4), key: rid(12), name: str(f.name, 40), webhook: str(f.webhook, 300).split('#')[0], owner: u.id, created: Date.now() };
  await store.createShop(shop);
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/my\/shop-request$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=/my');
  const f = await readForm(req);
  const mine = (await store.shopsByOwner(u.id)).filter((x) => !x.deleted);
  if (mine.length < shopLimit(u)) return redirect(res, '/my');
  await store.createShopRequest({ user_id: u.id, note: str(f.note, 300), created: Date.now() });
  redirect(res, `/my?m=${enc('신청이 접수됐어요. 운영자가 확인할 때까지 기다려 주세요')}`);
});

route('POST', /^\/m\/([\w-]+)\/webhook$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  const url = str(f.webhook, 300).split('#')[0];
  const on = Object.keys(NOTI).filter((k) => f['n_' + k] === '1');
  const list = parseHooks(shop.webhook);
  const idx = f.idx === undefined || f.idx === '' ? -1 : parseInt(f.idx, 10);
  const back = `<p><a href="/m/${shop.key}">← 상점 관리로</a></p>`;
  const fail = (msg) => send(res, 400, page('웹훅 저장', `<h1>⚠️ 저장하지 못했어요</h1><p class="warn">${esc(msg)}</p>${back}`));
  let title = '✅ 저장했어요';
  if (idx >= 0) {
    if (!list[idx]) return fail('목록이 바뀌었어요. 상점 관리로 돌아가서 다시 해주세요.');
    if (f.del === '1' || !url) { list.splice(idx, 1); title = '✅ 웹훅을 삭제했어요'; }
    else if (!HOOK_SAVE_RE.test(url)) return fail('디스코드 웹훅 주소 형식이 아니에요. https://discord.com/api/webhooks/ 로 시작해야 해요.');
    else list[idx] = { url, on };
  } else {
    if (!url) return fail('웹훅 주소를 입력해 주세요.');
    if (!HOOK_SAVE_RE.test(url)) return fail('디스코드 웹훅 주소 형식이 아니에요. https://discord.com/api/webhooks/ 로 시작해야 해요.');
    if (list.length >= MAX_HOOKS) return fail(`웹훅은 상점당 ${MAX_HOOKS}개까지 등록할 수 있어요.`);
    list.push({ url, on });
  }
  if (new Set(list.map((h) => h.url)).size !== list.length) return fail('같은 웹훅 주소가 이미 등록돼 있어요.');
  await store.updateShop(shop.id, { webhook: buildHooks(list) });
  send(res, 200, page('웹훅 저장', `<h1>${title}</h1><p class="sub">상점 관리에서 "테스트 알림 보내기"를 눌러 잘 오는지 확인해 보세요. (등록 ${list.length}/${MAX_HOOKS}개)</p>${back}`));
});

route('POST', /^\/m\/([\w-]+)\/webhook-test$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const back = `<p><a href="/m/${shop.key}">← 상점 관리로</a></p>`;
  if (!sendOk('wh:' + shop.id, 20, 86400000)) return send(res, 429, page('오늘은 여기까지', `<h1>테스트는 하루 20번까지예요</h1><p class="sub">내일 다시 해주세요.</p>${back}`));
  const rs = await testWebhooks(shop);
  if (!rs.length) return send(res, 200, page('알림 테스트', `<h1>⚠️ 등록된 웹훅이 없어요</h1>${back}`));
  const bad = rs.filter((x) => !x.ok);
  const lines = rs.map((x) => `<p class="${x.ok ? 'sub' : 'warn'}">${x.ok ? '✅' : '⚠️'} 웹훅 ${x.n}번: ${x.ok ? '보냈어요' : esc(x.msg)}</p>`).join('');
  send(res, 200, page('알림 테스트', `<h1>${bad.length ? '⚠️ 일부는 보내지 못했어요' : '✅ 보냈어요'}</h1>${lines}<p class="sub">${bad.length ? '웹훅 주소는 디스코드 채널 설정 → 연동 → 웹훅에서 다시 복사할 수 있어요.' : '각 디스코드 채널에 테스트 메시지가 왔는지 확인해 보세요.'}</p>${back}`));
});

route('GET', /^\/m\/([\w-]+)$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const items = await store.itemsByShop(shop.id);
  const orders = await store.ordersForItems(items.map((i) => i.id));
  const total = orders.reduce((s, o) => s + o.price, 0);
  const waiting = await store.waitingDeposits(shop.id);
  const me = await currentUser(req);
  const titles = await store.titlesByShop(shop.id);
  const holders = {};
  for (const t of titles) holders[t.id] = await store.titleHolders(t.id);
  const charges = await store.shopCharges(shop.id);
  const hooks = parseHooks(shop.webhook);
  const notiBoxes = (on) => Object.entries(NOTI).map(([k, label]) => `<label style="display:block;padding:5px 0;font-size:14px"><input type="checkbox" name="n_${k}" value="1" style="width:auto;padding:0;margin:0 8px 0 0;vertical-align:middle" ${on.includes(k) ? 'checked' : ''}>${label}</label>`).join('');
  const hookCards = hooks.map((h, i) => `<form class="card" method="post" action="/m/${shop.key}/webhook"><b>웹훅 ${i + 1}</b><input type="hidden" name="idx" value="${i}"><input name="webhook" value="${esc(h.url)}" maxlength="300" autocomplete="off">
<p class="sub" style="margin:4px 0">이 웹훅으로 받을 알림</p>${notiBoxes(h.on)}
<button style="margin-top:8px">저장</button> <button name="del" value="1" style="margin-top:6px;background:#dc2626" onclick="return confirm('이 웹훅을 삭제할까요?')">삭제</button></form>`).join('');
  const hookAdd = hooks.length < MAX_HOOKS
    ? `<form class="card" method="post" action="/m/${shop.key}/webhook"><b>웹훅 추가</b><input name="webhook" placeholder="https://discord.com/api/webhooks/..." maxlength="300" autocomplete="off" required>
<p class="sub" style="margin:4px 0">이 웹훅으로 받을 알림</p>${notiBoxes(Object.keys(NOTI))}<button style="margin-top:8px">추가</button></form>`
    : `<p class="sub">웹훅을 ${MAX_HOOKS}개 다 등록했어요. 새로 추가하려면 하나를 삭제하세요.</p>`;
  send(res, 200, page(shop.name, `
<h1>${esc(shop.name)} 관리</h1>
<div class="card"><b>내 상점 링크 (공유하세요)</b><br><code>${BASE}/s/${shop.id}</code><br><a href="/s/${shop.id}">열어보기</a></div>
<div class="card"><b>🔔 디스코드 알림</b> <span class="sub">(${hooks.length}/${MAX_HOOKS}개)</span><p class="sub">새 주문·입금 알림을 받을 디스코드 웹훅 주소예요. 최대 ${MAX_HOOKS}개까지 등록할 수 있고, 웹훅마다 받을 알림 종류를 따로 고를 수 있어요.</p>
${hookCards}${hookAdd}
<form method="post" action="/m/${shop.key}/webhook-test" style="margin-top:8px"><button${hooks.length ? '' : ' disabled style="background:#9ca3af"'}>테스트 알림 보내기 (하루 20번까지)</button></form></div>
${shop.owner ? '' : (me ? `<form class="card" method="post" action="/m/${shop.key}/claim"><b>이 상점을 내 계정에 연결</b><p class="sub">연결하면 로그인한 나만 관리할 수 있어요.</p><button>내 계정에 연결</button></form>` : `<div class="warn">아직 계정에 연결되지 않은 상점이에요. <a href="/login?next=${enc('/m/' + shop.key)}">로그인</a>해서 연결하세요.</div>`)}
<h2>🏷️ 칭호</h2>
<form class="card" method="post" action="/m/${shop.key}/titles"><input name="name" placeholder="새 칭호 이름 (예: VIP)" required maxlength="20"><button>칭호 만들기</button></form>
${titles.map((t) => `<div class="card">${badgeHtml(t.name)} <span class="sub">${(holders[t.id] || []).length}명 보유</span>
<form method="post" action="/m/${shop.key}/titles/${t.id}/grant"><input name="code" placeholder="회원번호 8자리 (구매자 지갑에 표시)" required minlength="8" maxlength="12"><button>칭호 주기</button></form>
${(holders[t.id] || []).map((h) => `<form method="post" action="/m/${shop.key}/titles/${t.id}/revoke" style="display:inline"><input type="hidden" name="uid" value="${esc(h.user_id)}"><span class="sub">${esc(h.user_id.slice(0, 8))}</span> <button style="width:auto;padding:4px 10px;background:#6b7280">회수</button></form> `).join('')}
<form method="post" action="/m/${shop.key}/titles/${t.id}/delete" onsubmit="return confirm('칭호를 삭제하면 받은 사람에게서도 사라져요. 삭제할까요?')"><button style="background:#dc2626">칭호 삭제</button></form></div>`).join('') || '<p class="sub">아직 칭호가 없어요</p>'}
<h2>🏦 충전 받을 계좌</h2>
<form class="card" method="post" action="/m/${shop.key}/pay">
<input name="bank" placeholder="은행 (예: 카카오뱅크)" value="${esc(shop.bank)}" maxlength="20">
<input name="account" placeholder="계좌번호" value="${esc(shop.account)}" maxlength="40">
<input name="holder" placeholder="예금주" value="${esc(shop.holder)}" maxlength="20">
<button>저장</button><p class="sub">구매자가 이 상점 포인트를 충전할 때 이 계좌가 보여요. 은행·계좌번호·예금주를 모두 적어야 충전이 열리고, 비우면 꺼져요. 입금은 직접 확인해서 승인해요.</p></form>
<h2>⏳ 충전 대기 ${charges.length}건</h2>
${charges.map((c) => `<div class="card"><b>${esc(c.name)}</b> <span class="price">${won(c.amount)}</span><br><span class="sub">회원 ${esc(c.user_id.slice(0, 8))} · ${fmtDate(c.created)}${Date.now() > c.created + CHARGE_TTL ? ' · 기한 지남' : ''}</span>
<form method="post" action="/m/${shop.key}/charges/${c.token}/confirm"><button>입금 확인 (포인트 지급)</button></form>
<form method="post" action="/m/${shop.key}/charges/${c.token}/reject"><button style="background:#6b7280">거절</button></form></div>`).join('') || '<p class="sub">충전 대기가 없어요</p>'}
<h2>🎁 포인트 직접 조정</h2>
<form class="card" method="post" action="/m/${shop.key}/points"><input name="code" placeholder="회원번호 8자리" required minlength="8" maxlength="12"><input name="delta" type="number" placeholder="증감 (예: 1000 또는 -500)" required><input name="note" placeholder="메모 (선택)" maxlength="40"><button>조정</button></form>
<h2>매출 ${won(total)} · 판매 ${orders.length}건</h2>
<h2>아이템 추가</h2>
<form class="card" method="post" action="/m/${shop.key}/items">
<input name="title" placeholder="제목" required maxlength="80">
<input name="price" type="number" min="100" step="100" placeholder="가격 (원)" required>
<textarea name="preview" placeholder="미리보기 (결제 전 공개되는 설명)" required></textarea>
<textarea name="secret" placeholder="잠금 정보 (결제 후에만 공개: 내용, 링크 등). 재고를 쓰면 비워도 돼요"></textarea>
<textarea name="stock" placeholder="재고 (선택). 한 줄에 하나씩 적으면 구매할 때마다 한 줄씩 순서대로 지급돼요. 예) 치킨버거 ⏎ 불고기버거. 비우면 재고 제한 없이 같은 잠금 정보를 보여줘요"></textarea>
${titleSelect(titles, '')}
<label style="display:flex;gap:8px;align-items:center;margin:0 0 10px"><input type="checkbox" name="pub" checked style="width:auto;margin:0"> 상점 목록에 공개 (끄면 링크로만 열려요)</label>
<button>등록</button></form>
<h2>내 아이템</h2>
${items.map((i) => `<div class="card"><b>${esc(i.title)}</b> <span class="price">${won(i.price)}</span> <span class="sub">· ${i.pub ? '공개' : '비공개(링크로만)'}${i.stock != null ? ` · 재고 ${stockLines(i.stock).length}개` : ''}</span><br><a href="/i/${i.id}">${BASE}/i/${i.id}</a><br><a href="/m/${shop.key}/items/${i.id}/edit">✏️ 수정·삭제</a></div>`).join('') || '<p class="sub">아직 없어요</p>'}`));
});

route('POST', /^\/m\/([\w-]+)\/items$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  const price = parseInt(f.price, 10);
  if (!(price >= 100)) return send(res, 400, page('오류', '<h1>가격은 100원 이상이어야 해요</h1>'));
  const secret = String(f.secret || '').slice(0, 10000);
  const stock = parseStock(f.stock);
  if (!secret.trim() && !stock) return send(res, 400, page('오류', '<h1>잠금 정보나 재고 중 하나는 적어주세요</h1>'));
  const item = { id: rid(9), shop: shop.id, pub: f.pub === 'on', title: String(f.title).slice(0, 80), price, preview: String(f.preview).slice(0, 2000), secret, created: Date.now() };
  if (stock) item.stock = stock;
  if (f.title_id) { const t = await store.titleById(String(f.title_id)); if (t && t.shop === shop.id) item.title_id = t.id; }
  await store.createItem(item);
  redirect(res, `/m/${shop.key}`);
});

route('GET', /^\/m\/([\w-]+)\/items\/([\w-]+)\/edit$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const item = await store.itemById(m[2]);
  if (!item || item.shop !== shop.id) return notFound(res, '아이템을 찾을 수 없어요');
  const sold = (await store.ordersForItems([item.id])).length;
  const titles = await store.titlesByShop(shop.id);
  send(res, 200, page('아이템 수정', `<a class="sub" href="/m/${shop.key}">← 관리로 돌아가기</a>
<h1>아이템 수정</h1>
${sold ? `<p class="warn">이미 ${sold}건 팔렸어요. 가격을 바꿔도 이전 주문 금액은 그대로이고, 잠금 정보를 바꾸면 이전 구매자에게도 바뀐 내용이 보여요.</p>` : ''}
<form class="card" method="post" action="/m/${shop.key}/items/${item.id}">
<input name="title" value="${esc(item.title)}" required maxlength="80">
<input name="price" type="number" min="100" step="100" value="${esc(item.price)}" required>
<textarea name="preview" required>${esc(item.preview)}</textarea>
<textarea name="secret" placeholder="잠금 정보 (재고를 쓰면 비워도 돼요)">${esc(item.secret)}</textarea>
<label style="display:flex;gap:8px;align-items:center;margin:0 0 10px"><input type="checkbox" name="use_stock" ${item.stock != null ? 'checked' : ''} style="width:auto;margin:0"> 재고 사용 (한 줄에 하나, 구매할 때마다 순서대로 지급)</label>
<textarea name="stock" placeholder="남은 재고 (한 줄에 하나)">${esc(item.stock || '')}</textarea>
${titleSelect(titles, item.title_id)}
<label style="display:flex;gap:8px;align-items:center;margin:0 0 10px"><input type="checkbox" name="pub" ${item.pub ? 'checked' : ''} style="width:auto;margin:0"> 상점 목록에 공개 (끄면 링크로만 열려요)</label>
<button>저장</button></form>
<h2>삭제</h2>
${sold ? '<p class="sub">판매 기록이 있는 아이템은 삭제할 수 없어요. 구매자가 계속 열람해야 하니까요. 대신 위에서 공개를 꺼서 목록에서 숨기세요.</p>'
 : `<form method="post" action="/m/${shop.key}/items/${item.id}/delete" onsubmit="return confirm('정말 삭제할까요? 되돌릴 수 없어요.')"><button style="background:#dc2626">이 아이템 삭제</button></form>`}`));
});

route('POST', /^\/m\/([\w-]+)\/items\/([\w-]+)$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const item = await store.itemById(m[2]);
  if (!item || item.shop !== shop.id) return notFound(res, '아이템을 찾을 수 없어요');
  const f = await readForm(req);
  const price = parseInt(f.price, 10);
  if (!(price >= 100)) return send(res, 400, page('오류', '<h1>가격은 100원 이상이어야 해요</h1>'));
  const useStock = f.use_stock === 'on';
  const secret = String(f.secret || '').slice(0, 10000);
  const stock = useStock ? parseStock(f.stock) : null;
  if (!secret.trim() && !useStock) return send(res, 400, page('오류', '<h1>잠금 정보나 재고 중 하나는 적어주세요</h1>'));
  const upd = { pub: f.pub === 'on', title: String(f.title).slice(0, 80), price, preview: String(f.preview).slice(0, 2000), secret };
  if (useStock || item.stock != null) { upd.stock = stock; upd.stock_ver = (item.stock_ver || 0) + 1; }
  let tid = null;
  if (f.title_id) { const t = await store.titleById(String(f.title_id)); if (t && t.shop === shop.id) tid = t.id; }
  if (tid || item.title_id) upd.title_id = tid;
  await store.updateItem(item.id, upd);
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/m\/([\w-]+)\/items\/([\w-]+)\/delete$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const item = await store.itemById(m[2]);
  if (!item || item.shop !== shop.id) return notFound(res, '아이템을 찾을 수 없어요');
  if ((await store.ordersForItems([item.id])).length) return send(res, 400, page('삭제 불가', `<h1>판매 기록이 있어 삭제할 수 없어요</h1><p><a href="/m/${shop.key}/items/${item.id}/edit">돌아가기</a></p>`));
  await store.deleteItem(item.id);
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/m\/([\w-]+)\/claim$/, async (req, res, m) => {
  const shop = await store.shopByKey(m[1]);
  if (!shop) return notFound(res, '상점을 찾을 수 없어요');
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/m/' + shop.key));
  if (!shop.owner) await store.updateShop(shop.id, { owner: u.id });
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/m\/([\w-]+)\/pay$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  const upd = { bank: str(f.bank, 20), account: str(f.account, 40), holder: str(f.holder, 20) };
  await store.updateShop(shop.id, upd);
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/m\/([\w-]+)\/deposits\/([\w-]+)\/confirm$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const dep = await store.depositByToken(m[2]);
  if (dep && dep.shop === shop.id) {
    const order = await confirmDeposit(dep);
    if (!order) return send(res, 400, page('확인 불가', `<h1>재고가 없어서 확인할 수 없어요</h1><p class="sub">입금자에게 환불해 주세요. 재고를 채운 뒤 다시 확인하면 열려요.</p><p><a href="/m/${shop.key}">돌아가기</a></p>`));
  }
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/i\/([\w-]+)\/deposit$/, async (req, res, m) => {
  const item = await store.itemById(m[1]);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  const shop = await store.shopById(item.shop);
  if (!shop || !shop.bank || !shop.account) return send(res, 400, page('오류', '<h1>이 상점은 계좌 입금을 받지 않아요</h1>'));
  if (item.stock != null && !stockLines(item.stock).length) return send(res, 400, page('품절', `<h1>품절이에요</h1><p><a href="/i/${item.id}">돌아가기</a></p>`));
  const f = await readForm(req);
  const name = str(f.name, 20);
  if (name.length < 2) return send(res, 400, page('오류', `<h1>입금자명을 2자 이상 적어주세요</h1><p><a href="/i/${item.id}">돌아가기</a></p>`));
  const dep = { token: rid(16), item: item.id, shop: shop.id, name, amount: Number(item.price), status: 'waiting', created: Date.now() };
  await store.createDeposit(dep);
  await notify(shop, `⏳ 입금 대기: ${item.title} (${won(dep.amount)}) · 입금자명 ${name}`, 'deposit');
  redirect(res, `/o/${dep.token}`);
});

// 입금 문자 수신 (자동 확인). 문자 내용에 '입금', 대기 주문의 입금자명, 금액이 모두 있으면 확인
route('POST', /^\/sms\/([\w-]+)$/, async (req, res, m) => {
  const shop = await store.shopBySms(m[1]);
  if (!shop || shop.pay_mode !== 'auto') { res.writeHead(404); return res.end('no'); }
  let text = await readBody(req);
  try { const j = JSON.parse(text); if (j && typeof j === 'object') text = Object.values(j).join(' '); } catch {}
  let result = 'ignored';
  if (/입금/.test(text)) {
    const flat = text.replace(/\s/g, '');
    const plain = text.replace(/,/g, '');
    const waiting = (await store.waitingDeposits(shop.id)).filter((d) => Date.now() <= d.created + DEP_TTL);
    const hit = waiting.filter((d) => flat.includes(d.name.replace(/\s/g, '')) && new RegExp('(^|\\D)' + d.amount + '(\\D|$)').test(plain));
    if (hit.length === 1) { await confirmDeposit(hit[0]); result = 'ok'; }
    else if (hit.length > 1) { result = 'ambiguous'; }
    else result = 'nomatch';
  }
  res.writeHead(200); res.end(result);
});

route('GET', /^\/claim\/([\w-]+)$/, async (req, res, m) => {
  const shop = await store.shopByKey(m[1]);
  if (!shop) return notFound(res, '상점을 찾을 수 없어요');
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/claim/' + shop.key));
  if (shop.owner) return send(res, 403, page('이미 주인이 있어요', '<h1>이미 주인이 있는 상점이에요</h1>'));
  send(res, 200, page('상점 연결', `<h1>${esc(shop.name)}</h1><p class="sub">이 상점을 내 계정(${esc(u.email)})에 연결할까요? 연결하면 로그인한 나만 관리할 수 있어요.</p><form method="post" action="/m/${shop.key}/claim"><button>내 계정에 연결</button></form>`));
});

// 이 상점 포인트로 구매
route('POST', /^\/i\/([\w-]+)\/buy$/, async (req, res, m) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/i/' + m[1]));
  const item = await store.itemById(m[1]);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  const shopB = await store.shopById(item.shop);
  if (!shopB || shopB.deleted) return notFound(res, '아이템을 찾을 수 없어요');
  const price = Number(item.price);
  const soldOut = () => send(res, 400, page('품절', `<h1>품절이에요</h1><p><a href="/i/${item.id}">돌아가기</a></p>`));
  let line = null;
  let soldLast = false; // 이번 구매로 재고가 0이 됐는지
  if (item.stock != null) {
    line = await store.popStock(item.id);
    if (line == null) return soldOut();
    const after = await store.itemById(item.id);
    soldLast = !!after && !stockLines(after.stock).length;
  }
  const bal = await store.addShopPoints(u.id, item.shop, -price);
  if (bal == null) {
    if (line != null) await restoreStock(item.id, line);
    return send(res, 400, page('포인트 부족', `<h1>이 상점 포인트가 부족해요</h1><p><a href="/w/${item.shop}">충전하러 가기</a></p>`));
  }
  const order = { token: rid(16), item: item.id, price, paidAt: Date.now(), buyer: u.id, ...(line != null ? { delivered: line } : {}) };
  try { await store.createOrder(order); }
  catch (e) { await store.addShopPoints(u.id, item.shop, price); if (line != null) await restoreStock(item.id, line); throw e; }
  try { await store.addLedger({ id: rid(9), user_id: u.id, shop: item.shop, delta: -price, kind: 'buy', ref: order.token, note: item.title, created: Date.now() }); } catch (e) { console.error('ledger', e.message); }
  if (item.title_id) { const t = await store.titleById(item.title_id); if (t) await store.grantTitle(u.id, t.id, item.shop); }
  const shopN = await store.shopById(item.shop);
  await notify(shopN, `💰 새 주문! ${item.title} (${won(price)})`, 'sale');
  if (soldLast) await notify(shopN, `📦 재고가 0이 됐어요: ${item.title}. 재고를 채워주세요.`, 'stock');
  redirect(res, `/o/${order.token}`);
});

// 내 포인트 · 칭호 (상점별 목록)
route('GET', /^\/wallet$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=/wallet');
  const rows = await store.userShopPoints(u.id);
  const titles = await store.userTitles(u.id);
  const cards = [];
  for (const r of rows) { const sh = await store.shopById(r.shop); if (sh) cards.push(`<a href="/w/${sh.id}" style="text-decoration:none;color:inherit"><div class="card"><b>${esc(sh.name)}</b><br><span class="price">${pts(r.points)}</span></div></a>`); }
  send(res, 200, page('내 포인트', `<a class="sub" href="/my">← 내 상점</a><h1>💰 내 포인트</h1><p class="sub">포인트는 충전한 상점에서만 쓸 수 있어요 (1P = 1원). 회원번호 <b>${esc(u.id.slice(0, 8))}</b> · 칭호를 받을 때 판매자에게 알려주세요.</p>
${titles.length ? `<div class="card"><b>🏷️ 내 칭호</b><br>${titles.map((t) => badgeHtml(t.name)).join('')}</div>` : ''}
<h2>상점별 포인트</h2>
${cards.join('') || '<p class="sub">아직 충전한 상점이 없어요. 상점 페이지에서 포인트를 충전해 보세요.</p>'}`));
});

// 상점 전용 지갑: 충전 신청 / 입금 안내 / 내역
route('GET', /^\/w\/([\w-]+)$/, async (req, res, m) => {
  const shop = await store.shopById(m[1]);
  if (!shop || shop.deleted) return notFound(res, '상점을 찾을 수 없어요');
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/w/' + shop.id));
  const q = new URL(req.url, BASE).searchParams;
  const canCharge = !!(shop.bank && shop.account && shop.holder);
  const bal = await store.shopPoints(u.id, shop.id);
  const pending = (await store.userShopCharges(u.id, shop.id)).filter((c) => Date.now() <= c.created + CHARGE_TTL);
  const log = await store.ledgerForUserShop(u.id, shop.id);
  const label = { charge: '충전', buy: '구매', admin: '상점 조정' };
  send(res, 200, page(shop.name + ' 포인트', `<a class="sub" href="/s/${shop.id}">← ${esc(shop.name)}</a><h1>💰 ${esc(shop.name)} 포인트</h1>
${q.get('m') ? `<p class="card">${esc(q.get('m'))}</p>` : ''}${q.get('e') ? `<p class="warn">${esc(q.get('e'))}</p>` : ''}
<div class="card"><span class="sub">보유 포인트 (1P = 1원 · 이 상점에서만 사용)</span><br><span class="price" style="font-size:28px">${pts(bal)}</span></div>
<h2>포인트 충전</h2>
${canCharge ? `<form class="card" method="post" action="/w/${shop.id}/charge">
<input name="amount" type="number" min="${MIN_CHARGE}" max="${MAX_CHARGE}" step="100" placeholder="충전 금액 (${MIN_CHARGE.toLocaleString('ko-KR')}원 이상)" required>
<input name="name" placeholder="입금자명 (은행 앱에 찍히는 내 이름)" required minlength="2" maxlength="20">
<button>충전 신청</button><p class="sub">신청 후 아래 계좌로 입금하면, 상점 운영자가 입금을 확인한 뒤 포인트가 들어와요. 충전한 포인트는 환불되지 않아요.</p></form>` : '<p class="warn">이 상점은 아직 충전을 받지 않아요</p>'}
${pending.map((c) => `<div class="card"><b>입금해 주세요</b><br>${esc(shop.bank)} <b>${esc(shop.account)}</b> (예금주 ${esc(shop.holder)})<br><span class="price">${won(c.amount)}</span><br><span class="sub">입금자명 <b>${esc(c.name)}</b> 그대로 · 기한 ${fmtDate(c.created + CHARGE_TTL)}<br>운영자가 확인하면 포인트가 들어와요 (20초마다 자동 확인)</span>
<form method="post" action="/w/${shop.id}/charge/${c.token}/cancel"><button style="background:#6b7280">신청 취소</button></form></div>`).join('')}
${pending.length ? '<script>setTimeout(function(){location.reload()},20000)</script>' : ''}
<h2>내역</h2>
${log.map((l) => `<div class="card"><span class="sub">${fmtDate(l.created)}</span><br>${l.kind === 'buy' ? `<a href="/o/${esc(l.ref)}">${esc(label.buy)} · ${esc(l.note)}</a>` : `${esc(label[l.kind] || l.kind)}${l.note && l.kind === 'admin' ? ' · ' + esc(l.note) : ''}`} <b>${l.delta > 0 ? '+' : ''}${Number(l.delta).toLocaleString('ko-KR')}P</b></div>`).join('') || '<p class="sub">아직 내역이 없어요</p>'}`));
});

route('POST', /^\/w\/([\w-]+)\/charge$/, async (req, res, m) => {
  const shop = await store.shopById(m[1]);
  if (!shop || shop.deleted) return notFound(res, '상점을 찾을 수 없어요');
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/w/' + shop.id));
  const f = await readForm(req);
  const back = (k, t) => redirect(res, `/w/${shop.id}?${k}=${enc(t)}`);
  if (!(shop.bank && shop.account && shop.holder)) return back('e', '이 상점은 아직 충전을 받지 않아요');
  const amount = parseInt(f.amount, 10);
  const name = str(f.name, 20);
  if (!(amount >= MIN_CHARGE && amount <= MAX_CHARGE)) return back('e', `충전 금액은 ${MIN_CHARGE.toLocaleString('ko-KR')}원~${MAX_CHARGE.toLocaleString('ko-KR')}원이에요`);
  if (name.length < 2) return back('e', '입금자명을 2자 이상 적어주세요');
  const active = (await store.userShopCharges(u.id, shop.id)).filter((c) => Date.now() <= c.created + CHARGE_TTL);
  if (active.length >= 3) return back('e', '입금 대기 중인 신청이 3건이에요. 하나를 취소하거나 입금한 뒤에 신청해 주세요');
  await store.createCharge({ token: rid(12), user_id: u.id, shop: shop.id, amount, name, status: 'waiting', created: Date.now() });
  await notify(shop, `⏳ 충전 신청: ${name} · ${won(amount)} — 입금을 확인하고 관리 페이지에서 승인해 주세요`, 'charge');
  back('m', '충전 신청이 접수됐어요. 아래 계좌로 입금해 주세요');
});

route('POST', /^\/w\/([\w-]+)\/charge\/([\w-]+)\/cancel$/, async (req, res, m) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/w/' + m[1]));
  const c = await store.chargeByToken(m[2]);
  if (c && c.user_id === u.id && c.shop === m[1]) await store.claimCharge(c.token, 'cancelled');
  redirect(res, `/w/${m[1]}`);
});

// 상점 운영자: 충전 승인/거절, 포인트 직접 조정
route('POST', /^\/m\/([\w-]+)\/charges\/([\w-]+)\/(confirm|reject)$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const c = await store.chargeByToken(m[2]);
  if (c && c.shop === shop.id) { if (m[3] === 'confirm') await confirmCharge(c); else await store.claimCharge(c.token, 'rejected'); }
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/m\/([\w-]+)\/points$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  const back = (msg) => send(res, 400, page('오류', `<h1>${esc(msg)}</h1><p><a href="/m/${shop.key}">돌아가기</a></p>`));
  const code = str(f.code, 12);
  const delta = parseInt(f.delta, 10);
  if (!/^[\w-]{8,12}$/.test(code)) return back('회원번호는 8자리예요');
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10000000) return back('증감 금액이 올바르지 않아요');
  const target = await store.userByCode(code);
  if (!target) return back('그 회원번호의 사용자를 찾을 수 없어요');
  const bal = await store.addShopPoints(target.id, shop.id, delta);
  if (bal == null) return back('보유 포인트보다 많이 차감할 수 없어요');
  await store.addLedger({ id: rid(9), user_id: target.id, shop: shop.id, delta, kind: 'admin', ref: shop.id, note: str(f.note, 40), created: Date.now() });
  redirect(res, `/m/${shop.key}`);
});

// 칭호 만들기 / 주기 / 회수 / 삭제 (상점 주인)
route('POST', /^\/m\/([\w-]+)\/titles$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  const name = str(f.name, 20);
  const back = (msg) => send(res, 400, page('오류', `<h1>${esc(msg)}</h1><p><a href="/m/${shop.key}">돌아가기</a></p>`));
  if (!name) return back('칭호 이름을 적어주세요');
  if ((await store.titlesByShop(shop.id)).length >= 30) return back('칭호는 상점당 30개까지 만들 수 있어요');
  await store.createTitle({ id: rid(6), shop: shop.id, name, created: Date.now() });
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/m\/([\w-]+)\/titles\/([\w-]+)\/(grant|revoke|delete)$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const t = await store.titleById(m[2]);
  if (!t || t.shop !== shop.id) return notFound(res, '칭호를 찾을 수 없어요');
  const f = await readForm(req);
  const back = (msg) => send(res, 400, page('오류', `<h1>${esc(msg)}</h1><p><a href="/m/${shop.key}">돌아가기</a></p>`));
  if (m[3] === 'delete') await store.deleteTitle(t.id);
  else if (m[3] === 'revoke') { const uid = str(f.uid, 12); if (/^[\w-]{8,12}$/.test(uid)) await store.revokeTitle(uid, t.id); }
  else {
    const code = str(f.code, 12);
    if (!/^[\w-]{8,12}$/.test(code)) return back('회원번호는 8자리예요');
    const target = await store.userByCode(code);
    if (!target) return back('그 회원번호의 사용자를 찾을 수 없어요');
    await store.grantTitle(target.id, t.id, shop.id);
  }
  redirect(res, `/m/${shop.key}`);
});

// 운영자 페이지: 모든 사용자 정지/해제, 모든 상점 관리 진입
route('GET', /^\/admin$/, async (req, res) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const q = new URL(req.url, BASE).searchParams;
  const search = str(q.get('q'), 50);
  const users = await store.listUsers(search);
  const sq = str(q.get('sq'), 50); // 상점 검색: 상점 이름 또는 주인 이메일
  const owners = sq ? await store.listUsers(sq) : [];
  const shops = sq ? await store.searchShops(sq, owners.map((o) => o.id)) : await store.allShops();
  const reqs = await store.listShopRequests();
  const emailMap = new Map(users.map((x) => [x.id, x.email]));
  for (const o of owners) emailMap.set(o.id, o.email);
  if (sq) for (const sh of shops) if (sh.owner && !emailMap.has(sh.owner)) { const x = await store.userById(sh.owner); if (x) emailMap.set(x.id, x.email); }
  for (const r of reqs) if (!emailMap.has(r.user_id)) { const x = await store.userById(r.user_id); if (x) emailMap.set(x.id, x.email); }
  const emailOf = (id) => emailMap.get(id) || (id ? id.slice(0, 8) : '없음');
  send(res, 200, page('운영자', `<a class="sub" href="/my">← 내 상점</a><h1>👑 운영자</h1>
${q.get('m') ? `<p class="card">${esc(q.get('m'))}</p>` : ''}${q.get('e') ? `<p class="warn">${esc(q.get('e'))}</p>` : ''}
<h2>📨 상점 추가 신청 ${reqs.length}건</h2>
${reqs.map((r) => `<div class="card"><b>${esc(emailOf(r.user_id))}</b><br><span class="sub" style="white-space:pre-wrap">${esc(r.note)}</span>
<form method="post" action="/admin/requests/${r.user_id}/approve"><button>승인 (상점 1개 더 허용)</button></form>
<form method="post" action="/admin/requests/${r.user_id}/reject"><button style="background:#6b7280">거절</button></form></div>`).join('') || '<p class="sub">신청이 없어요</p>'}
<h2>🏪 상점 (${shops.length})</h2>
<form method="get" action="/admin"><input name="sq" placeholder="상점 이름 또는 주인 이메일 검색" value="${esc(sq)}"><input type="hidden" name="q" value="${esc(search)}"><button>검색</button>${sq ? '<p class="sub"><a href="/admin' + (search ? '?q=' + enc(search) : '') + '">검색 지우기</a></p>' : ''}</form>
${shops.map((sh) => `<div class="card"><b>${esc(sh.name)}</b>${sh.deleted ? ' 🗑️ 삭제됨' : ''}<br><span class="sub">주인 ${esc(emailOf(sh.owner))}</span><br><a href="/m/${sh.key}">관리하기</a>${sh.deleted ? '' : ` · <a href="/s/${sh.id}">보기</a>`}
${sh.deleted ? `<form method="post" action="/admin/shops/${sh.id}/restore"><button style="background:#0f766e">복구</button></form>` : `<form method="post" action="/admin/shops/${sh.id}/delete" onsubmit="return confirm('이 상점을 삭제할까요? 사이트에서 사라지고 새 구매·충전이 막혀요. (복구할 수 있어요)')"><button style="background:#dc2626">상점 삭제</button></form>`}</div>`).join('') || `<p class="sub">${sq ? '검색 결과가 없어요' : '상점이 없어요'}</p>`}
<h2>👥 사용자</h2>
<form method="get" action="/admin"><input type="hidden" name="sq" value="${esc(sq)}"><input name="q" placeholder="이메일 검색" value="${esc(search)}"><button>검색</button></form>
${users.map((x) => `<div class="card"><b>${esc(x.email)}</b>${x.banned ? ' 🚫 정지' : ''}${isAdmin(x) ? ' 👑' : ''}<br><span class="sub">회원번호 ${esc(x.id.slice(0, 8))}</span>
${isAdmin(x) ? '' : `<form method="post" action="/admin/users/${x.id}/limit" style="margin-top:8px"><span class="sub">🏪 상점 한도 (현재 ${shops.filter((sh) => sh.owner === x.id && !sh.deleted).length}개 만듦)</span><input name="n" type="number" min="0" max="100" value="${shopLimit(x)}" required><button>한도 저장</button><button name="reset" value="1" formnovalidate style="background:#6b7280;margin-top:6px">기본값(${FREE_SHOPS}개)으로</button></form><form method="post" action="/admin/users/${x.id}/ban"><input type="hidden" name="v" value="${x.banned ? 0 : 1}"><button style="background:${x.banned ? '#0f766e' : '#dc2626'}">${x.banned ? '정지 해제' : '계정 정지'}</button></form>`}</div>`).join('') || '<p class="sub">사용자가 없어요</p>'}`));
});

route('POST', /^\/admin\/shops\/([\w-]+)\/(delete|restore)$/, async (req, res, m) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const sh = await store.shopById(m[1]);
  if (!sh) return redirect(res, `/admin?e=${enc('상점을 찾을 수 없어요')}`);
  await store.updateShop(sh.id, { deleted: m[2] === 'delete' });
  redirect(res, `/admin?m=${enc(m[2] === 'delete' ? '상점을 삭제했어요' : '상점을 복구했어요')}`);
});

route('POST', /^\/admin\/requests\/([\w-]+)\/(approve|reject)$/, async (req, res, m) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const target = await store.userById(m[1]);
  if (target && m[2] === 'approve') await store.updateUser(target.id, { extra_shops: Number(target.extra_shops || 0) + 1 });
  await store.deleteShopRequest(m[1]);
  redirect(res, `/admin?m=${enc(m[2] === 'approve' ? '승인했어요. 상점을 1개 더 만들 수 있어요' : '신청을 거절했어요')}`);
});

// 사람마다 상점 한도 정하기 (0~100개, 기본값으로 되돌리기 가능)
route('POST', /^\/admin\/users\/([\w-]+)\/limit$/, async (req, res, m) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const f = await readForm(req);
  const done = (k, t) => redirect(res, `/admin?${k}=${enc(t)}`);
  const target = await store.userById(m[1]);
  if (!target) return done('e', '사용자를 찾을 수 없어요');
  if (isAdmin(target)) return done('e', '운영자 계정은 한도가 없어요');
  if (f.reset === '1') { await store.updateUser(target.id, { extra_shops: 0 }); return done('m', `${target.email} 한도를 기본값(${FREE_SHOPS}개)으로 되돌렸어요`); }
  const n = parseInt(f.n, 10);
  if (!(n >= 0 && n <= 100)) return done('e', '한도는 0~100 사이 숫자로 넣어주세요');
  await store.updateUser(target.id, { extra_shops: n - FREE_SHOPS });
  done('m', `${target.email} 상점 한도를 ${n}개로 정했어요`);
});

route('POST', /^\/admin\/users\/([\w-]+)\/ban$/, async (req, res, m) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const f = await readForm(req);
  const done = (k, t) => redirect(res, `/admin?${k}=${enc(t)}`);
  const target = await store.userById(m[1]);
  if (!target) return done('e', '사용자를 찾을 수 없어요');
  if (isAdmin(target)) return done('e', '운영자 계정은 정지할 수 없어요');
  await store.updateUser(target.id, { banned: f.v === '1' });
  done('m', f.v === '1' ? '계정을 정지했어요' : '정지를 풀었어요');
});

route('GET', /^\/s\/([\w-]+)$/, async (req, res, m) => {
  const shop = await store.shopById(m[1]);
  if (!shop || shop.deleted) return notFound(res, '상점을 찾을 수 없어요');
  const items = (await store.itemsByShop(shop.id)).filter((i) => i.pub);
  const me = await currentUser(req);
  const bal = me ? await store.shopPoints(me.id, shop.id) : 0;
  const rmap = new Map();
  for (const r of await store.reviewsByShop(shop.id)) { const a = rmap.get(r.item) || { n: 0, sum: 0 }; a.n += 1; a.sum += r.rating; rmap.set(r.item, a); }
  send(res, 200, page(shop.name, `<h1>${esc(shop.name)}</h1><p class="sub">링크몰 상점</p>
<div class="card">${me ? `💰 이 상점 포인트 <b>${pts(bal)}</b> · <a href="/w/${shop.id}">충전하기</a>` : `<a href="/login?next=${enc('/s/' + shop.id)}">로그인하고 포인트 충전하기</a>`}</div>
${items.map((i) => `<a href="/i/${i.id}" style="text-decoration:none;color:inherit"><div class="card"><b>${esc(i.title)}</b><br><span class="price">${won(i.price)}</span>${rmap.get(i.id) ? ` <span class="sub">★${(rmap.get(i.id).sum / rmap.get(i.id).n).toFixed(1)} (${rmap.get(i.id).n})</span>` : ''}${i.stock != null ? (stockLines(i.stock).length ? ` <span class="sub">재고 ${stockLines(i.stock).length}개</span>` : ' <span class="sub">품절</span>') : ''}</div></a>`).join('') || '<p class="sub">등록된 아이템이 없어요</p>'}`));
});

route('GET', /^\/i\/([\w-]+)$/, async (req, res, m) => {
  const item = await store.itemById(m[1]);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  const shop = await store.shopById(item.shop);
  if (!shop || shop.deleted) return notFound(res, '아이템을 찾을 수 없어요');
  const sold = (await store.ordersForItems([item.id])).length;
  const me = await currentUser(req);
  const bal = me ? await store.shopPoints(me.id, shop.id) : 0;
  const reviews = await store.reviewsForItem(item.id);
  const canMod = !!me && (me.id === shop.owner || isAdmin(me));
  const avg = reviews.length ? reviews.reduce((a, r) => a + r.rating, 0) / reviews.length : 0;
  send(res, 200, page(item.title, `<a class="sub" href="/s/${shop.id}">← ${esc(shop.name)}</a>
<h1>${esc(item.title)}</h1><p class="price" style="font-size:20px">${won(item.price)}</p><p class="sub">판매 ${sold}건${item.stock != null ? ` · 재고 ${stockLines(item.stock).length}개` : ''}</p>
<div class="card" style="white-space:pre-wrap">${esc(item.preview)}</div>
${item.stock != null && !stockLines(item.stock).length ? '<div class="warn">😢 품절이에요</div>' : pointsBlock(item, me, bal, shop)}
<h2>⭐ 후기 ${reviews.length ? `${avg.toFixed(1)} (${reviews.length})` : ''}</h2>
${reviews.map((r) => `<div class="card">${stars(r.rating)} <span class="sub">구매자 ${esc(r.user_id.slice(0, 4))} · ${new Date(Number(r.created)).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}</span><br><span style="white-space:pre-wrap">${esc(r.body)}</span>${canMod ? `<form method="post" action="/i/${item.id}/reviews/${r.id}/delete" onsubmit="return confirm('이 후기를 삭제할까요?')"><button style="background:#dc2626">후기 삭제</button></form>` : ''}</div>`).join('') || '<p class="sub">아직 후기가 없어요. 구매한 사람이 남길 수 있어요.</p>'}`));
});

// ⚠️ 테스트 결제: 실제 서비스에서는 PG(토스페이먼츠/포트원) 결제 승인 확인 후에만 주문을 생성해야 합니다.
route('POST', /^\/i\/([\w-]+)\/pay$/, async (req, res, m) => {
  return send(res, 403, page('막힘', '<h1>이제 포인트로만 구매할 수 있어요</h1>'));
  const item = await store.itemById(m[1]);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  if (item.stock != null && !stockLines(item.stock).length) return send(res, 400, page('품절', `<h1>품절이에요</h1><p><a href="/i/${item.id}">돌아가기</a></p>`));
  const order = { token: rid(16), item: item.id, price: item.price, paidAt: Date.now() };
  await placeOrder(order, item);
  await notify(await store.shopById(item.shop), `💰 새 주문! ${item.title} (${won(item.price)})`, 'sale');
  redirect(res, `/o/${order.token}`);
});

route('GET', /^\/pay\/success$/, async (req, res) => {
  const q = new URL(req.url, BASE).searchParams;
  const paymentKey = q.get('paymentKey');
  const orderId = q.get('orderId');
  if (!useToss || !paymentKey || !orderId || orderId.length !== 26) return send(res, 400, page('오류', '<h1>잘못된 결제 요청이에요</h1>'));
  if (await store.orderByToken(orderId)) return redirect(res, `/o/${orderId}`); // 새로고침 대비
  const item = await store.itemById(orderId.slice(0, 12));
  if (!item) return send(res, 404, page('오류', '<h1>아이템을 찾을 수 없어요</h1>'));
  if (item.stock != null && !stockLines(item.stock).length) return send(res, 400, page('품절', `<h1>품절이라 결제를 승인하지 않았어요</h1><p class="sub">카드 결제는 청구되지 않아요.</p><p><a href="/i/${item.id}">돌아가기</a></p>`));
  // 금액은 URL이 아니라 DB의 가격으로 승인 요청 (토스가 실제 결제액과 대조)
  const r = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(TOSS_SK + ':').toString('base64'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentKey, orderId, amount: Number(item.price) }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (await store.orderByToken(orderId)) return redirect(res, `/o/${orderId}`);
    return send(res, 400, page('결제 실패', `<h1>결제 승인에 실패했어요</h1><p>${esc(d.message || '')}</p><p><a href="/i/${item.id}">다시 시도</a></p>`));
  }
  if (d.status === 'DONE') await finalizePaid(d); // 카드: 바로 완료 / 가상계좌: 입금 후 완료
  redirect(res, `/o/${orderId}`);
});

// 토스 웹훅 (가상계좌 입금 통보). 본문은 믿지 않고 토스에 다시 조회해서 확인
route('POST', /^\/pay\/webhook$/, async (req, res) => {
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch {}
  const orderId = body.orderId || (body.data && body.data.orderId);
  if (useToss && typeof orderId === 'string' && orderId.length === 26) {
    const p = await tossPayment(orderId);
    if (p && p.status === 'DONE') await finalizePaid(p);
  }
  res.writeHead(200); res.end('ok');
});

route('GET', /^\/pay\/fail$/, (req, res) => {
  const q = new URL(req.url, BASE).searchParams;
  send(res, 200, page('결제 실패', `<h1>결제가 완료되지 않았어요</h1><p class="sub">${esc(q.get('message') || '')}</p><p><a href="javascript:history.go(-2)">돌아가기</a></p>`));
});

route('GET', /^\/o\/([\w-]+)$/, async (req, res, m) => {
  let order = await store.orderByToken(m[1]);
  if (!order) {
    const dep = await store.depositByToken(m[1]);
    if (dep) {
      if (dep.status === 'done') order = await confirmDeposit(dep);
      else {
        const shop = await store.shopById(dep.shop);
        const depItem = await store.itemById(dep.item);
        if (depItem && depItem.stock != null && !stockLines(depItem.stock).length) return send(res, 200, page('품절', `<h1>😢 품절이에요</h1><p class="sub">이미 입금했다면 판매자에게 환불을 요청해 주세요. 입금자명 ${esc(dep.name)}, ${won(dep.amount)}</p>`));
        if (Date.now() > dep.created + DEP_TTL) return send(res, 200, page('만료', `<h1>입금 기한이 지났어요</h1><p class="sub">이미 입금했다면 판매자에게 확인을 요청하세요.</p><p><a href="/i/${esc(dep.item)}">다시 주문하기</a></p>`));
        return send(res, 200, page('입금 대기', `<h1>🏦 입금해 주세요</h1>
<div class="card"><b>${esc(shop && shop.bank)}</b><br><span style="font-size:20px;font-weight:700">${esc(shop && shop.account)}</span><br>예금주 ${esc(shop && shop.holder)}<br><span class="price">${won(dep.amount)}</span></div>
<div class="warn">입금자명은 <b>${esc(dep.name)}</b> 그대로, 금액도 정확히 맞춰서 보내주세요.</div>
<p class="sub">${shop && shop.pay_mode === 'auto' ? '입금이 확인되면 이 페이지가 자동으로 열려요.' : '판매자가 입금을 확인하면 이 페이지가 열려요.'} (15초마다 확인)</p>
<p class="sub">입금 기한 ${esc(new Date(dep.created + DEP_TTL).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }))}<br>이 주소를 북마크하세요: <code>${BASE}/o/${esc(m[1])}</code></p>
<script>setTimeout(function(){location.reload()},15000)</script>`));
      }
    }
  }
  if (!order && useToss && m[1].length === 26) {
    const p = await tossPayment(m[1]);
    if (p && p.status === 'DONE') order = await finalizePaid(p);
    else if (p && p.status === 'WAITING_FOR_DEPOSIT') {
      const v = p.virtualAccount || {};
      const bank = BANKS[v.bankCode] || (v.bankCode ? '은행코드 ' + v.bankCode : '');
      const due = v.dueDate ? new Date(v.dueDate).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '';
      return send(res, 200, page('입금 대기', `<h1>🏦 입금을 기다리고 있어요</h1>
<div class="card"><b>${esc(bank)}</b><br><span style="font-size:20px;font-weight:700">${esc(v.accountNumber)}</span><br><span class="price">${won(p.totalAmount)}</span><br><span class="sub">입금기한 ${esc(due)}</span></div>
<p class="sub">입금이 확인되면 이 페이지가 자동으로 열려요 (30초마다 확인). 이 주소를 북마크하세요: <code>${BASE}/o/${esc(m[1])}</code></p>
<script>setTimeout(function(){location.reload()},30000)</script>`));
    } else if (p && (p.status === 'EXPIRED' || p.status === 'CANCELED' || p.status === 'ABORTED')) {
      return send(res, 200, page('만료', `<h1>입금 기한이 지났거나 취소됐어요</h1><p><a href="/i/${esc(m[1].slice(0, 12))}">다시 주문하기</a></p>`));
    }
  }
  if (!order) return notFound(res, '주문을 찾을 수 없어요');
  const item = await store.itemById(order.item);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  const me = await currentUser(req);
  let reviewBox = '';
  if (me && order.buyer && order.buyer === me.id) {
    const rv = await store.reviewByToken(order.token);
    const qq = new URL(req.url, BASE).searchParams;
    reviewBox = `<h2>⭐ 후기 ${rv ? '수정' : '남기기'}</h2>${qq.get('e') ? `<p class="warn">${esc(qq.get('e'))}</p>` : ''}
<form class="card" method="post" action="/o/${order.token}/review">
<select name="rating" style="${SEL_STYLE}">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}" ${rv && rv.rating === n ? 'selected' : ''}>${stars(n)} (${n}점)</option>`).join('')}</select>
<textarea name="body" placeholder="후기를 남겨주세요 (최대 300자)" maxlength="300">${esc(rv ? rv.body : '')}</textarea>
<button>${rv ? '후기 수정' : '후기 등록'}</button><p class="sub">후기는 모든 사람에게 보여요.</p></form>`;
  }
  send(res, 200, page('내 보관함', `<h1>🔓 잠금 해제됨</h1><h2>${esc(item.title)}</h2>
${order.delivered ? `<p class="sub">지급된 상품</p><div class="secret">${esc(order.delivered)}</div>` : (item.stock != null && order.delivered === '' ? '<div class="warn">재고가 부족해서 아직 지급되지 않았어요. 판매자가 직접 보내드려요. 판매자에게 문의해 주세요.</div>' : '')}
${item.secret ? `<div class="secret">${esc(item.secret)}</div>` : ''}
<p class="sub">이 주소를 북마크하면 언제든 다시 볼 수 있어요: <code>${BASE}/o/${order.token}</code></p>
${reviewBox}`));
});

// 후기 등록/수정 (구매자 본인만, 주문당 1개)
route('POST', /^\/o\/([\w-]+)\/review$/, async (req, res, m) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/o/' + m[1]));
  const order = await store.orderByToken(m[1]);
  if (!order || !order.buyer || order.buyer !== u.id) return send(res, 403, page('권한 없음', '<h1>구매한 사람만 후기를 남길 수 있어요</h1>'));
  const item = await store.itemById(order.item);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  const f = await readForm(req);
  const rating = parseInt(f.rating, 10);
  if (!(rating >= 1 && rating <= 5)) return redirect(res, `/o/${order.token}?e=${enc('별점은 1~5점이에요')}`);
  const body = str(f.body, 300);
  const old = await store.reviewByToken(order.token);
  if (old) await store.updateReview(old.id, { rating, body });
  else await store.createReview({ id: rid(9), token: order.token, item: item.id, shop: item.shop, user_id: u.id, rating, body, created: Date.now() });
  redirect(res, `/o/${order.token}`);
});

// 후기 삭제 (그 상점 주인 또는 운영자)
route('POST', /^\/i\/([\w-]+)\/reviews\/([\w-]+)\/delete$/, async (req, res, m) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/i/' + m[1]));
  const item = await store.itemById(m[1]);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  const shop = await store.shopById(item.shop);
  if (!shop || !(u.id === shop.owner || isAdmin(u))) return send(res, 403, page('권한 없음', '<h1>상점 주인이나 운영자만 후기를 삭제할 수 있어요</h1>'));
  const rv = await store.reviewById(m[2]);
  if (rv && rv.item === item.id) await store.deleteReview(rv.id);
  redirect(res, `/i/${item.id}`);
});

// 로그인 없이 열어둘 곳: 첫 화면, 로그인·가입, 외부 서버가 부르는 웹훅(결제·문자)
const PUBLIC = [
  ['GET', /^\/$/], ['GET', /^\/(favicon\.ico|apple-touch-icon\.png)$/], ['GET', /^\/login$/], ['POST', /^\/login$/],
  ['POST', /^\/signup(\/start|\/verify)?$/], ['POST', /^\/logout$/],
  ['POST', /^\/pay\/webhook$/], ['POST', /^\/sms\/[\w-]+$/],
];
http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  if (!PUBLIC.some(([m, re]) => m === req.method && re.test(url.pathname))) {
    let me = null;
    try { me = await currentUser(req); } catch (e) { console.error(e); return send(res, 500, page('오류', '<h1>문제가 생겼어요</h1>')); }
    if (!me) return redirect(res, `/login?e=${enc('가입하고 로그인해야 쓸 수 있어요')}&next=${enc(req.method === 'GET' ? url.pathname + url.search : '/my')}`);
  }
  for (const r of routes) {
    const m = url.pathname.match(r.re);
    if (r.method === req.method && m) {
      try { return await r.fn(req, res, m); } catch (e) { console.error(e); return send(res, 500, page('오류', '<h1>문제가 생겼어요</h1>')); }
    }
  }
  notFound(res, '페이지를 찾을 수 없어요');
}).listen(PORT, () => console.log(`링크몰 실행 중 → ${BASE} (저장소: ${useSB ? 'Supabase' : 'db.json 파일'})`));
