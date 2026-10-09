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
  async userByEmail(e) {
    const hit = (await sbGet('users', `email=eq.${enc(e)}&select=*`))[0];
    if (hit) return hit;
    // 예전 버전에서 대문자 그대로 저장된 이메일도 찾기 (_ % 는 와일드카드라 이스케이프, 결과는 소문자로 다시 비교)
    const pat = e.replace(/[\\%_]/g, (c) => '\\' + c);
    return (await sbGet('users', `email=ilike.${enc(pat)}&select=*&limit=5`)).find((u) => String(u.email).toLowerCase() === e);
  },
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
  async deleteUser(id) { // 회원 탈퇴: 이 회원의 포인트·칭호·대기 중 충전·상점 추가 신청을 지우고 계정 삭제 (주문·후기 기록은 번호만 남김)
    const e = enc(id);
    await sbDelete('shop_points', `user_id=eq.${e}`);
    await sbDelete('user_titles', `user_id=eq.${e}`);
    await sbDelete('charges', `user_id=eq.${e}&status=eq.waiting`);
    await sbDelete('shop_requests', `user_id=eq.${e}`);
    await sbDelete('users', `id=eq.${e}`);
  },
  async purgeShop(id) { // 상점 영구 삭제: 상점과 딸린 기록(아이템·주문·후기·입금·충전·포인트·칭호·내역)을 전부 지움. 자식 → 부모 순서
    const e = enc(id);
    const ids = (await sbStore.itemsByShop(id)).map((i) => i.id);
    for (let n = 0; n < ids.length; n += 50) await sbDelete('orders', `item=in.(${ids.slice(n, n + 50).map(enc).join(',')})`);
    for (const t of ['reviews', 'user_titles', 'titles', 'shop_points', 'charges', 'deposits', 'ledger', 'items']) await sbDelete(t, `shop=eq.${e}`);
    await sbDelete('shops', `id=eq.${e}`);
  },
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
  // 재고 n줄을 한 번에 꺼내기 (모자라면 아무것도 안 꺼내고 null)
  async popStockN(itemId, n) {
    for (let t = 0; t < 8; t++) {
      const it = await sbStore.itemById(itemId);
      if (!it || it.stock == null) return null;
      const lines = stockLines(it.stock);
      if (lines.length < n) return null;
      const ver = it.stock_ver || 0;
      const r = await fetch(`${SB_URL}/rest/v1/items?id=eq.${enc(itemId)}&stock_ver=eq.${ver}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ stock: lines.slice(n).join('\n'), stock_ver: ver + 1 }) });
      if (!r.ok) throw new Error(`supabase popStockN ${r.status} ${await r.text()}`);
      if ((await r.json()).length) return lines.slice(0, n);
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
  async userByEmail(e) { return Object.values(L().users).find((u) => String(u.email).toLowerCase() === e); },
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
  async deleteUser(id) {
    const d = L();
    for (const k of Object.keys(d.shop_points)) if (k.startsWith(id + '|')) delete d.shop_points[k];
    d.user_titles = d.user_titles.filter((x) => x.user_id !== id);
    for (const [k, c] of Object.entries(d.charges)) if (c.user_id === id && c.status === 'waiting') delete d.charges[k];
    delete d.shop_requests[id];
    delete d.users[id];
    save(d);
  },
  async purgeShop(id) {
    const d = L(); d.orders = d.orders || {};
    const itemIds = new Set(Object.values(d.items).filter((i) => i.shop === id).map((i) => i.id));
    for (const [k, o] of Object.entries(d.orders)) if (itemIds.has(o.item)) delete d.orders[k];
    for (const k of itemIds) delete d.items[k];
    for (const [k, r] of Object.entries(d.reviews)) if (r.shop === id) delete d.reviews[k];
    for (const [k, x] of Object.entries(d.deposits)) if (x.shop === id) delete d.deposits[k];
    for (const [k, c] of Object.entries(d.charges)) if (c.shop === id) delete d.charges[k];
    const titleIds = new Set(Object.values(d.titles).filter((t) => t.shop === id).map((t) => t.id));
    for (const k of titleIds) delete d.titles[k];
    d.user_titles = d.user_titles.filter((x) => x.shop !== id && !titleIds.has(x.title));
    for (const k of Object.keys(d.shop_points)) if (k.endsWith('|' + id)) delete d.shop_points[k];
    d.ledger = d.ledger.filter((l) => l.shop !== id);
    delete d.shops[id];
    save(d);
  },
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
  async popStockN(itemId, n) {
    const d = load(); const it = d.items[itemId];
    if (!it || it.stock == null) return null;
    const lines = stockLines(it.stock);
    if (lines.length < n) return null;
    it.stock = lines.slice(n).join('\n'); save(d);
    return lines.slice(0, n);
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
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;font-family:-apple-system,"Pretendard","Noto Sans KR",sans-serif;background:#fff;color:#18181b}
.top{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.94);backdrop-filter:blur(8px);display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid #eee}
.top .logo{flex:1;font-size:18px;font-weight:800;text-decoration:none;color:#18181b}
.chip{font-size:13px;font-weight:700;background:#f4f4f5;color:#18181b;border-radius:999px;padding:9px 13px;text-decoration:none;white-space:nowrap}
.w{max-width:560px;margin:0 auto;padding:18px 18px 70px}
h1{font-size:24px;margin:10px 0 6px}h2{font-size:19px;margin:28px 0 10px}
.card{background:#fafafa;border:1px solid #f0f0f0;border-radius:22px;padding:18px;margin:12px 0;box-shadow:0 3px 12px rgba(0,0,0,.06)}
input,textarea,select{width:100%;padding:14px;border:1px solid #e4e4e7;border-radius:16px;font-size:15px;margin:4px 0 10px;font-family:inherit;background:#fff;color:#18181b}
input:focus,textarea:focus,select:focus{outline:2px solid #18181b;border-color:#18181b}
textarea{min-height:90px}
button,.btn{display:inline-block;background:#18181b;color:#fff;border:0;border-radius:18px;padding:15px 16px;font-size:16px;font-weight:700;text-decoration:none;cursor:pointer;width:100%;text-align:center;font-family:inherit}
.sub{color:#71717a;font-size:13px}.price{font-weight:700;color:#18181b}.lock{background:#f4f4f5;border-radius:16px;padding:14px;color:#18181b;font-size:14px}
.secret{white-space:pre-wrap;word-break:break-all;background:#ecfdf5;border-radius:16px;padding:14px}code{background:#f4f4f5;padding:2px 6px;border-radius:8px;word-break:break-all}
a{color:#18181b}.btn,.logo,.chip{text-decoration:none}.warn{background:#fff7ed;color:#9a3412;border-radius:16px;padding:13px 16px;font-size:13px}
`;
const page = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/png" href="/favicon.ico?v=${ICON_VER}"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${ICON_VER}"><title>${esc(title)}</title><style>${css}</style></head><body><div class="top"><a class="logo" href="/">🔗 링크몰</a><a class="chip" href="/my">내 상점</a></div><div class="w">${body}</div></body></html>`;

// ---------- 상점 화면 테마 (모바일 앱 느낌: 상단바 + 왼쪽 메뉴 + 큰 카드) ----------
const shopCss = `
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;font-family:-apple-system,"Pretendard","Noto Sans KR",sans-serif;background:#fff;color:#18181b}
a{color:inherit}
.top{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.94);backdrop-filter:blur(8px);display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid #eee}
.ib{width:42px;height:42px;border:0;background:#f4f4f5;border-radius:13px;display:grid;place-items:center;cursor:pointer;padding:0;color:#18181b}
.top b{font-size:17px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip{font-size:13px;font-weight:700;background:#f4f4f5;border-radius:999px;padding:9px 13px;text-decoration:none;white-space:nowrap}
.main{max-width:560px;margin:0 auto;padding:18px 18px 70px}
.ov{position:fixed;inset:0;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .2s;z-index:40}
.dr{position:fixed;top:0;left:0;bottom:0;width:min(88vw,380px);background:#fff;z-index:50;transform:translateX(-103%);transition:transform .25s;padding:24px 18px;overflow:auto}
body.open .ov{opacity:1;pointer-events:auto}body.open .dr{transform:none}
.brand{display:flex;align-items:center;gap:14px;margin-bottom:34px}.brand img{width:48px;height:48px;border-radius:13px}.brand b{flex:1;font-size:19px}
.nv{display:flex;align-items:center;gap:14px;padding:16px 14px;font-size:17px;text-decoration:none;border-radius:18px;margin-bottom:6px}
.nv.on{background:#18181b;color:#fff;box-shadow:0 10px 22px rgba(0,0,0,.18)}
.dr h3{font-size:22px;margin:30px 0 12px 12px}
.pc{display:block;background:#fafafa;border:1px solid #f0f0f0;border-radius:28px;box-shadow:0 3px 12px rgba(0,0,0,.08);margin:0 0 22px;overflow:hidden;text-decoration:none;color:inherit}
.pc.off{opacity:.55}
.pg{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.pg .pc{margin:0;border-radius:18px;box-shadow:0 2px 8px rgba(0,0,0,.07)}
.pg .im{aspect-ratio:1/1}.pg .im svg{width:36px;height:36px}
.pg .pb{padding:12px 12px 14px}
.pg .pb h2{font-size:15px;margin:0 0 6px;line-height:1.3;min-height:2.6em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all}
.pg .rt{font-size:13px;gap:4px;margin-bottom:8px}.pg .rt svg{width:15px;height:15px}
.pg .pr{flex-direction:column;align-items:flex-start;gap:2px}.pg .pr>b{font-size:17px}.pg .pr span{font-size:12px}
.im{background:#f4f4f4;aspect-ratio:16/9;display:grid;place-items:center;color:#71717a;border-bottom:1px solid #ececec;position:relative;overflow:hidden}
.im img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.pb{padding:22px 24px 24px}.pb h2{font-size:22px;margin:0 0 12px}
.rt{display:flex;align-items:center;gap:8px;font-size:17px;margin-bottom:14px;color:#3f3f46}.rt svg{fill:#facc15}
.pr{display:flex;align-items:center;justify-content:space-between}.pr>b{font-size:28px}.pr span{color:#71717a;font-size:15px}.pr span b{color:#18181b}
.bx{background:#fafafa;border:1px solid #f0f0f0;border-radius:22px;padding:16px 18px;margin:14px 0}
.sm{color:#71717a;font-size:13px}
.nt{background:#fff7ed;color:#9a3412;border-radius:16px;padding:13px 16px;font-size:14px;margin:12px 0}
.qt{display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid #e4e4e7;border-radius:20px;padding:10px 14px;margin:14px 0 8px}
.qt .st{display:flex;align-items:center;gap:6px}
.qt button{width:44px;height:44px;border-radius:13px;border:0;background:#f4f4f5;font-size:24px;line-height:1;cursor:pointer;color:#18181b}
.qt input{width:70px;text-align:center;border:0;font-size:22px;font-weight:700;background:transparent;font-family:inherit;color:#18181b;-moz-appearance:textfield}
.qt input::-webkit-outer-spin-button,.qt input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.qk{display:flex;gap:8px;margin-bottom:6px}.qk button{flex:1;padding:10px 0;border:0;border-radius:12px;background:#f4f4f5;font-size:14px;font-weight:600;cursor:pointer;color:#18181b}
.tot{display:flex;justify-content:space-between;align-items:center}.tot b{font-size:24px}
.bb{display:block;width:100%;background:#18181b;color:#fff;border:0;border-radius:20px;padding:18px;font-size:18px;font-weight:700;cursor:pointer;text-align:center;text-decoration:none;font-family:inherit}
.bb[disabled]{background:#d4d4d8;cursor:not-allowed}
input,textarea,select{font-family:inherit}
.secret{white-space:pre-wrap;word-break:break-all;background:#ecfdf5;border-radius:16px;padding:14px}
`;
const ICO = {
  bag: '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M8.5 10.5a3.5 3.5 0 0 0 7 0"/><path d="M4 7h16"/></svg>',
  menu: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  x: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  home: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/></svg>',
  coin: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5h4a1.75 1.75 0 0 1 0 3.5h-3a1.75 1.75 0 0 0 0 3.5h4"/></svg>',
  cube: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/></svg>',
  star: '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M12 2.5l2.9 6.2 6.6.8-4.9 4.6 1.3 6.6L12 17.4 6.1 20.7l1.3-6.6L2.5 9.5l6.6-.8z"/></svg>',
};
const shopPage = (shop, title, body, me, bal, next, active = 'home') => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/png" href="/favicon.ico?v=${ICON_VER}"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${ICON_VER}"><title>${esc(title)}</title><style>${shopCss}</style></head><body>
<div class="top"><button class="ib" type="button" onclick="document.body.classList.add('open')" aria-label="메뉴">${ICO.menu}</button><b>${esc(shop.name)}</b>${me ? `<a class="chip" href="/w/${shop.id}">💰 ${pts(bal)}</a>` : `<a class="chip" href="/login?next=${enc(next)}">로그인</a>`}</div>
<div class="ov" onclick="document.body.classList.remove('open')"></div>
<nav class="dr"><div class="brand"><img src="/apple-touch-icon.png?v=${ICON_VER}" alt=""><b>${esc(shop.name)}</b><button class="ib" type="button" style="background:none" onclick="document.body.classList.remove('open')" aria-label="닫기">${ICO.x}</button></div>
<a class="nv${active === 'home' ? ' on' : ''}" href="/s/${shop.id}">${ICO.home}대시보드</a>
<a class="nv" href="/w/${shop.id}">${ICO.coin}포인트 충전</a>
<h3>카테고리</h3>
<a class="nv${active === 'items' ? ' on' : ''}" href="/s/${shop.id}">${ICO.cube}${esc(shop.name)}</a></nav>
<div class="main">${body}</div></body></html>`;

const pointsBlock = (item, me, bal, shop) => {
  const price = Number(item.price);
  const canCharge = !!(shop.bank && shop.account && shop.holder);
  const nextUrl = '/i/' + item.id;
  if (!me) return `<a class="bb" href="/login?next=${enc(nextUrl)}">로그인하고 구매하기</a>`;
  const multi = item.stock != null;
  const max = multi ? Math.max(1, Math.min(MAX_QTY, stockLines(item.stock).length)) : 1;
  const chargeLink = canCharge ? `<a href="/w/${shop.id}">충전하기</a>` : '(이 상점은 아직 충전을 받지 않아요)';
  return `<form method="post" action="/i/${item.id}/buy" id="bf">
${multi ? `<div class="qt"><span style="font-weight:600">수량</span><div class="st"><button type="button" id="mi" aria-label="하나 빼기">−</button><input id="q" name="qty" type="number" inputmode="numeric" min="1" max="${max}" value="1"><button type="button" id="pl" aria-label="하나 더하기">+</button></div></div>
<div class="qk"><button type="button" data-add="5">+5</button><button type="button" data-add="10">+10</button><button type="button" data-set="${max}">최대 (${max}개)</button></div>` : '<input type="hidden" name="qty" value="1">'}
<div class="bx tot"><span class="sm">총 결제 포인트</span><b id="tot">${pts(price)}</b></div>
<div class="nt" id="lack" hidden>포인트가 <b id="lk"></b> 부족해요 · ${chargeLink}</div>
<button class="bb" id="bb">구매하기</button></form>
<script>(function(){var P=${price},B=${Number(bal) || 0},M=${max},q=document.getElementById('q'),tot=document.getElementById('tot'),lack=document.getElementById('lack'),lk=document.getElementById('lk'),bb=document.getElementById('bb'),f=document.getElementById('bf');
function n(){var v=q?parseInt(q.value,10):1;if(!(v>=1))v=1;if(v>M)v=M;return v}
function fmt(x){return x.toLocaleString('ko-KR')+'P'}
function upd(){var v=n(),t=P*v;tot.textContent=fmt(t);if(t>B){lack.hidden=false;lk.textContent=fmt(t-B);bb.disabled=true;bb.textContent='포인트가 부족해요'}else{lack.hidden=true;bb.disabled=false;bb.textContent=(M>1||v>1?v+'개 ':'')+fmt(t)+' 구매하기'}}
if(q){q.addEventListener('input',function(){if(q.value!==''){q.value=n()}upd()});q.addEventListener('blur',function(){q.value=n();upd()});
document.getElementById('mi').onclick=function(){q.value=Math.max(1,n()-1);upd()};document.getElementById('pl').onclick=function(){q.value=Math.min(M,n()+1);upd()};
Array.prototype.forEach.call(document.querySelectorAll('[data-add]'),function(b){b.onclick=function(){q.value=Math.min(M,n()+parseInt(b.dataset.add,10));upd()}});
Array.prototype.forEach.call(document.querySelectorAll('[data-set]'),function(b){b.onclick=function(){q.value=Math.min(M,parseInt(b.dataset.set,10));upd()}})}
f.onsubmit=function(){var v=n();if(q)q.value=v;return confirm(fmt(P*v)+'를 사용해 '+(v>1?v+'개를 ':'')+'구매할까요?')};upd()})();</script>`;
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

const cleanImage = (v) => { v = String(v || ''); return v.length <= 400000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : ''; };
const imgField = (curId) => `<div style="margin:4px 0 12px"><b style="font-size:14px">🖼️ 상품 사진 (선택)</b>
<img id="imp" ${curId ? `src="/img/${curId}"` : ''} alt="" style="${curId ? 'display:block;' : 'display:none;'}width:100%;max-height:260px;object-fit:cover;border-radius:16px;margin:8px 0">
<input type="file" id="imf" accept="image/*">
<input type="hidden" name="image" id="imv">
${curId ? '<label style="display:flex;gap:8px;align-items:center;margin:0 0 6px"><input type="checkbox" name="del_image" style="width:auto;margin:0"> 현재 사진 삭제</label>' : ''}
<span class="sub">사진은 자동으로 줄여서 올려요</span></div>
<script>(function(){var f=document.getElementById('imf'),v=document.getElementById('imv'),p=document.getElementById('imp');f.onchange=function(){var file=f.files[0];if(!file)return;var r=new FileReader();r.onload=function(){var im=new Image();im.onload=function(){var s=Math.min(1,640/Math.max(im.width,im.height));var c=document.createElement('canvas');c.width=Math.round(im.width*s);c.height=Math.round(im.height*s);var x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.drawImage(im,0,0,c.width,c.height);var d=c.toDataURL('image/jpeg',0.72);v.value=d;p.src=d;p.style.display='block'};im.onerror=function(){alert('이 사진은 읽을 수 없어요');f.value='';v.value=''};im.src=r.result};r.readAsDataURL(file)}})();</script>`;

const NOTI = { sale: '💰 판매 (새 주문)', charge: '⏳ 포인트 충전 신청', stock: '📦 재고 알림 (재고가 0이 됐을 때)', review: '⭐ 후기 (새 후기가 달렸을 때)' };
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

// 꺼낸 재고 여러 줄을 되돌림
async function restoreLines(itemId, lines) {
  const it = await store.itemById(itemId);
  if (it) await store.updateItem(itemId, { stock: [...lines, ...stockLines(it.stock)].join('\n'), ...(useSB ? { stock_ver: (it.stock_ver || 0) + 1 } : {}) });
}
// 한 주문에 지급된 개수 (재고형은 지급된 줄 수, 그 외 1)
const orderQty = (o) => (o && o.delivered ? Math.max(1, stockLines(o.delivered).length) : 1);
const MAX_QTY = 50;

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
const ICON_VER = '4'; // 아이콘 이미지를 바꿀 때마다 숫자를 올리면 브라우저가 새 아이콘을 다시 받아가요
const ICON_SMALL = Buffer.from('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', 'base64');
const ICON_LARGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAABvA0lEQVR42u29d7xl11EmWlVr7xPuPTeHDkqWLVmyHOQgy1HOCRtnY8NgGH7EAcPwZoYwA8zDMwxj3puZN4+ZNzziA2McwMY2xgEckIMsWTnbyi11vH3zyTusqnp/1Fr7nG4Ft6Tbcgt0BXKr+94+5+xdu1bVV9/3FaoqPPH1xNcDfdETl+CJryeC44mvJ4Ljia8nguOJryeC44mvJ4Ljia8nguOJryeC44mvfyRfyT+pT6v2BQAACICI8fftDwERELH6/X/iX/hPASGNIYFEJ3TXFUBECBExXJ/w/wj28/9EoucfZ3Coqt0/VRVVR+H07Pb6+w4cue/gysFDRze229mw8L5Egslmc2amtWd5/qzT9551xp7lxYXv+hIiAgAU/+bqFU/SB3kMfmpngqP6kRN/B4/gR6oPaT97gj9oGQIRVFVEnSMA6PZ637rmpquv//ad9x5e2+wN8kIlfDsCAKhLHIA4gnpam6gne5ZnL37OM1/2kovm5ma63f5wmOdlqaLO4USzMdVqTbUmqldkZiI6kbf3iK/bw73T38vgOPVzhojYM72+sfWFL3/jK9+87tDqFiDV0hqh88KgACoAioCImqQJJije+4IRYXa6tbS48JSzT280G2vrm9mw8N7nhR9muQrX6+niXOvcs0971gVPfeo5T3LkLJGc6KH1GCbOf4TB8Wg+m5UXRJTl+ac+96VPfeFrm52iXm9SQp69sCToEJFZijwvfakKQJAmBMoL87PnnvPkpz/taXt3L+e+PHxkdf+hI9vbnSIritIX3osXUVFVz6VyOVFLzjpt+ZIXPufFF1/YmpwEAFGlHT1cTtJp9U8ncygAHhcZ19982//zJx+7Y9/ByckpoESFkRARe73B5tp6r9dDwHo9nZxoNBu1JHEK9NJLXvCaV1wyNTV1eGXt9jvvOXRkpdPuZYUvvQcWFlCrXRAEFEHJOUckwsL+9N1zr3vZRa97xYvTND02hYze2xMF6fcqOAAAVRQQEPFjn/rCH3/4b5FqaS0dDjMEUOCV1aOdza3pVuPpT33yxc971rOf9fS9e5YXF+cT5+49eKQ78Lv37L5n3/7LvnX9vv2H8rxMkoSZ82GWFVlZFL7wqpLlJRFNzU5PTU3V6nWLRZckhJgPuuc9ec+P/9Dbzj/3bFUB+MfQDz/ug8OeTRElQhH577//kU/9/WVT01PCIsLi+eCB/RsbK8847+wfeuf3f99rX3HmGadXP+tZrrvlDoW0Vq9ddsU1V117yzAvFXR7a+vo2hohInCW5aDgiMqyPP+cM0T8vv1HhjlPtKZ37d4zOz+nCqpSq6WcFyn6H3z7a972xlc/skLyieA4KSgGIg2G2W/91z+87JrbWtPT+XBQq6W9Xu/bt978tHNO/9c/96NveePr0rRmZQF7TtNkc7t93a13T0/NbWxsX3rZFUfXt5l1/8GDd91918xU45IXPveGm79zz32HZ+fmmblRqwnLhRc85X/919/IhtnV19/01W9e89VvXtvuDc8868lzC/MAWEtcQpQPe298zYt+/J+91RGqnvT4OKlFyckKDlVFADiZl2a80S1L/2u/9btXXH9na3ZmOMxqabJy5Mjqyv5f+Kkf+uVf+KlGva7KLELoDJxYWdu49Y6Du3bvvfLq6y79xuWCtLm1ffttt89ONd/yfa/4kR982zlnnbFv/6Ff/o3//JVvXDc7t4AIjXo9L/LnPevcP/+9DzQaDQC45779//P//eCHP/H5pD75tKc/fXpmxpFr1mt5lr30ovN+7sffY410vAa4411rdQVOUny497///Sfjtj2yz/nw4hoxQJ+Iv/mB//XVb94wMzc3LIo0Se+8846puv75733gve9+m1UPiOCIAJCIDh1d+9Z1dzz5Kedcdvm3vvTVbwrgnXftO3Dv3T/49tf+jw/8+lve8Kr52RnPvDA38+63v6kshl+77KrJySlW35ps7bvvyNGVI6995Uu894vz8294zctf+dKLb7/j9uuuu3GiNdWammKRRqNx975Dq6srFz/3mfGd4ol8nEd2BU5e5tjh4Bh/r1ihzScGDZ1gPI0lDBQR59yffeRTH/3El2bn5rKirNUat99201PPnPv4n/2Ppz/tqd4zIhpIJaqEtNXpfeWbN51+xlmXffPKy6+8BhCvvf76ZiL/83d+7af/+Q9OtSaZGRAdEYuo6ite+sKpifo/fP2Kicmposynp6ZvuWPf6XsWn37+ud57VT39tD0/9K43TzTSL//D18uSZ+bmSs8TE83b777Pl/mzn3H+idy/h3URHgE2eEoEx+hNW1zgd/+Q418n/iqIqCrOuWtuuOUD//1PJ1ozeVEm9drtt3/nvLMW/ubDf7C4uOA9J4lDRAAFBQD0zH/31auXdp124023/MPXvynMV3zriudc8JS/+IP/cuEznsbMCEiO7FMQEQIw8wue/xzl8quXXTU5MZWXRa3evPzKa173yhfNzc4GHB3hBRc95/xzzvr0Zz7fH+Rzc3Pe88TE5K233X3a3oWzTtsjIg/16RSqz3/iYfQYDAh3IDgesGpBfKi08aA/csKvYv/Z6/f/3W/9z04mLOIBDh46sDjj/ubDfzg/N8vMSeKqn7Kb/a3rvq3UOLq69pnPfTFJkiuuvPylz3/GX/zBf7PvdzEsxl+IiFjkJS983s0333zrd/bVa3VE6HQHa6tH3/T6V4iqcw4AvOennnP2M5927kf+8pPDYd6aaqkoJbWbbr71khc9Z6LZOO4DHvcqo/nwg1+H47JLlTlO3slCO5Itqig+wRxw/29+WB8PEVWBiP7kL/76ngMraS1Vom634/P2h/7f/7K8OM/Mds9ijlEiuvfgkYNHt4nc577wFXLJTTfd9KLnPv3Pf/+/NZsNFnHOWaK7/2ex8ex//e1f27M8ned5URStqdbfX3rVZd+61hFZQZOmSVn6l1/ywv/rt//tof33rq6slmWpqpvd4mOf/vvjYu6421zNCOG7Xbrxa/XILt1jFBx6v6+H9VPwSKdxAMAiztHd9+7/5OcunZiYLL0HhKOH7/udX//FZ5z/VO+9c6Q6ei27N1fdcPv09NxlV1wtgAf275+ZoD/63d9u1Osi4oiqtzT+9uwXRMTMS4sLv/KvfqLf33bkmD262of+6rNVpKpqkrjS+3e89Q2/8NM/fOcdd2TDIXueaE1946qbbr97HxGJyHihMIoJULDm7rsljOPe5MmGIWhHcsaJFw2PIFtUF/S4l/n9P/3L3qC0W3vvffve+oaXvfc9b/fecgYiWkED9kDecOudwwIOHjp81z37+/3+4UP3/t+/8xsL83M2Ux1/M8dljupwEZF3vuVNL3juBb1+17PWJyeuvuG2O+7eR0SqNsBD55wI/9Iv/uQzzj/rnnvuURUpOS/x05/7aijRrQAaOw6s0jCW0UNki+Pez8Ot0h674Bg/yB+sgPiumWb80TyRM6j6QbudN91625e/dlW9Xvfed7u9VMvf+KWfU1Uba9hfbP8mwmGWXX71LYDJ1dfexIjX33TDD//AGy950cU+nj73z2fHXXe7l4mjH/vhd5VFToAq0h3kX/yHKwBAJbwaIYhos9n49V/6F5325ubmprCvpfVrb77zzrvvJSRmqV7uxKf898+1jw10SY8sYTyCM+/+Z/kj6FCqH/nUZ79UlDZ5h4MHD/zkj77z7LPOsEn9+HfaRfz2HfsGBd538PBWu3N0ba3VdL/8L3/aCpEHfCgf+EoRKegbXv2yc590el4U4n2S1K68/tuqag2O/aBzjplf+6qXvun1lxw4cB9zyeyzUr9w6eXxL38YH/z+OeyxyRk7VpA+gsB6NIUOEW1ubX/9iusbzaaI73Z781ONn3rvD4zf7GogZ/Fxwy33UFLfd8+9rHrH7d/+0Xe/effykhEBH7A2fLB3Liyt1uRLX/Tc4aCPRGktvf2u+w4cOmwgSvy28P2/8NPvdSDdXt+zT2q1a2+8Y3O7TYShyDhpuOIOliOPqiB9DH7kuC8j533jymuPrG2naQ2Qjq6tvPaVL9i1vChj1ECDyCx1HziyemitPRgONzc3NzbWUvI/8p63VVn9YZOsAF7x4ouc9RYAm53eDbfcDgAqUmHk5EhVn/3MC5737KcdPnRQfYEiR9fb1990mw13TupDtYOphR7LHPDo37H9DZddcT25mihkRYnA/+wH3vIgzSEAwM233QOutra+xqr37b/vtS9/yZmn7b1fmjmxi0WEAM96xtMW5qbZe/alAN56+z3Hv0lAC+K3fN8rtzZXsywvfcmKt3znbgufB29Ndh5wejwdK4/+TOkPh7fesS+t1USh0+097dwnX3ThM2CM6zsWJQAA9+w/7FyysbElqoN+9+1vfM0jzroWc7t3L59+2nKRZyw+TesHDq8CwHEUQXszL3vx82cmJ3udrrLU0vSe/Uci4fRkHdk7Gx+Ps+AAgHv3HzyyugnOecT+IHvxxRemSSIi+ECYdH847PayvCy6w952r7M4N/Pii59r05ZHeq4pES0vzvrSJ0i1em2r02P2iDRe69i7PW3v7mec/5StrS0ETZw7dHT96NrGSe01drZQffwFx3du3zccFESJKCHwJS947gPfRVAAOHRkdTj0RV6I1/WV1QvOfdLc7LQ8Ko6qAMD87IyIACgotrv9YZ6P3XIECCRnAHjuhRf0+wNEco4GWXHfgcMnEhynCMnm8SeH3LfvoHhVBV/K1GTjqeecDQBjD+7oAgPAwYMrZSllUQpge3v7hRddWFW1j+Zrbn4WNAgbBsNiMBgeU3KMTZUuvPACQmQWUFGgo+tbcAK9yilCIaOT+pTv7E/ZJdt/8IgiqmqeDXcvzp22Zxc8OKno0JHVovRlWYqCI3zus57xKN+V/XJ6qhVvsZpA5gHfLgA85ewzJyYb3ntQQMCVtQ14yFn1KUXMO1la2UcW+ycydmq3u84lAFSUxeLcQqPReCC0MVzi1bWtovS5SOF5qjV51hl7AYAePqfmmLwAQIAKIKpOEREf8H7aq8zNzjbrqfeeCEF1c7Pz6JGM+//gqTuVfUC490QfAlUYg4Qf4kcUFBE983a3C4gq6j1PtVoP8kJhVNHrDZRlOMizLJ9o1mdnp+HhzHTuD1djLGgUFQjBhjcq44fF+A9ONOsucYOyyFVK0O1ub+yv2YFEe1IzDe1gWIyH8ImGMyKMURMemhEDACLsPdvtERV8cI2Z/UFeeEUSVV/4ei1pNhuPLGEc98aIyFT6gCAsaseKwv0/CCI6QmGvzKTH10aVSvthIVcPxgU5RY+V8SdsfKhx4ifrCedGNFkqIZBSLU0fPJAAAMrSIzhV8MyttJYmycO99A/4xsg5IoeIoIBa/YjavT9uyC7CoCFDxuAIZYoCQKyOEfGhBZXH/bUnm8yxA8HxYDf14ZF34OHw1NEeUREQCjNVeMBWBQDysmRNzXUjTZMTUbNWw/SHKALYMxnXTaFiaVRUfkTUQEwEFimZEwAAUtC8KI2m9KC3/yGHO/DYCiSTRx8W96evPSzCH5xgZCgAgiiwCIAoKKgy+4f4aVbt9QfiHLMgkUXSiafAh4h+BABFUGABzxxP1TA2Cd9vGY5IWIQZFUUxLzwiZFk2GObdXq/THaytbx1Z3eh0uy943jOe+6wLHuzqjUfqcb8+FY+V49LaiSS6MXrLI3g9AACHgCigBhuoqDzE20NVYfEg4WHFcZzqu2SOB/sgVlrVG03nUiInACxqqJe7X/B57/v9oQoQpayA5O5b2frt//WRXrtXluWwLLKsaG93RQGRvnHNzf/tN39xz/LiQ9zv497YyU4hyaM8U07kHBnP0o+MFnss5bq6B2I1hD7wW1JjnSMhqIBy4lwklj7gKXR8zhAZzdarmE6SBAAS57xn74XBS80NsmJ9Y3Or3e10e51ef6vd3Wp3tzv9QZaXBRQeW0kN1RG53iC/9qb7vJTeF1k+3N7YWJhpnfWkJxeeDx7Yd+jwyv2D4xi1x2MLjiU7dZqcSI55xJ/z2NhCBVRE1AdGLCpVi6ogqCNCZmaVIIAaSd+rQlJDjWAHAY5VQeN/v+ZF2e31i9If3WiffsYZ84sLkxOtycnGn/zlF4eDvmctmZ1LvJe8kJI5LwopS1ZUVRbvEuxsHLn9pusL0dL7ohhecN5Tzzzzydvb2ysrR7Nh33t/f/z04RaeO6hnSR7ZaTIeIo9VOIeDXFUUwwWwHhIfpBCO1l4ARADKzF44AdCIUMVvPv4TZHne6w+2O73N7fZ2p9fp9rfbvc12N8vKbi/zAqXARRc9h0VUJS+Kew+s5tlwOBgMBoNhNihynxXee1+WpTA3Gw1AFPUpgPo8G3SAknqavOSlLz7zrLNWjqwcOXKwVm8qaOnL45CL762FwyM8Vh77RIeooY/F6tTA+7eddj4oaJBKqiAoEiABqNaSY1rfYTbs9ofd7qA/GGxtd7Y7ve12f7vXG2T5cFD0hlnJKgKl56L04n1elllecFFkw2Gn280HWVbkeZkpi+dSWFgYAZGccwkgIaBzDogQHQE5dIlLgH2apC9+0Qvm5ufuuP3WXmeQpCkoCIt1VQmNU5ZAYNyl7jE9WB5Tq8lH520VfuESF1oPwiRJRUREI9e8OgowAHwEhEAIaS31Ulx783fa7U63N2x3et1+3hvkw7wovAgLs5bM7NmzH+TDMi97/V6728uG2XAw7A0HPi+EfSlC4XhCIlBAo2cQJc4BmfNPIPsIAAhQmtYQgrscoSuLcmnXrr2n7en3+6edfrrDpCxLEe32evcdWn/K6nqjUZ9qTSYP4jOm3026v4Ph81gEx8M/erSCKsaJ1wYPEBKrFEUxyLOCPVFADTxzt9vtD7J2p9cbDDe2u6vrW3ffe+QpT51jVqfY65ef/Luri6JkYVDNcj8cZmVZdAf94WAw6A+6/f5w0C/KoigLLplF7FElRAUkBHKYEAHYMEWN02XUc7E3KwKR+G6Te1Gu+dKXhfeuVJdLqYlb29i89trrZ+YXpyZbU5ON6dlWrVY7vVa/4rq7rrjujtZkc3ZqKnHQbNbnZ1q7dy1NtxpzszMzUxMTzUaz0XjMhizfe5PaGAjhegYYdOyxOW7uhaATjUZrZrbVbGLa+OyXLltd2+z0h1lW9rMhCwCQFxSBbJi1u4MiGzIkUpad7e61193Y7Xa6/X6WD8u8KPJCmEthUCXnEJGQkBCR0tTAV1VVEIPdlFkUABUFxM44DWUvCECIEAEAZUNEEQHAS1n6QrSmoiyi5ADg7rvucsm9iJQ4l9TStNGsp7WEwLmkVqulSSKitUZzsjXVbNaSNKnXklazJly88dUv+v7XvOyB0ZedPnKSx/g0qRKB/QHFk7SqymEM+e4Oht1ef6vTWdtqd9r99na33R2ce/6znvncqXpzwhFmRf6lK76T58PCZ8LA3ud5XuRFf1hkw2G33yuY67VGL8uThIbZ8Mqrr3TOmcTRkXNISZokGPnCCmJwNoqa0SCgqJIIo4ICAnAgLseRIYVwFggdj32jWVBpSCjgvRcWRQABYS+OGmlNVFV8Kex9WRZ5WasRQOLcxOREMjXdmGhOTU+1pqbrzSY4p6p9ln5P/vyTX37Osy447SHhkMdl5ogg2DFBMCjK/mC43e72Or3tTq8/zHu9fqc3aPcGg2HZ6WfDsixYlAlEhUvnEt5eGWTDfq/b7/f7/WG31x5mfV9IUeTCDACIDpFYdWZmBh2BCCrUk1pZa1jnoqACqHZwQJAkASAqsoqiCdAkQCUV118BUEVGoxTlqouigJsjgSKoMHthX7Jv1Oqiai5UpS+a9frc/Pz8/Ozs/ML87CySS2u16empickpYUHQNEnAubwosyzL8nyQlQIle1/mWb3R7Gdy8NDRf2TBEZrvtc3ttfXNrXZnu93r9rKjm+2NrX6Wl4VXVWD2gJAQMvs8z/uDYW8w7HV6vUF/OMzyPB/mgzzLmYUAVAQRCMmmLYSUOodJ0EODYKnKwnmRsbA9+MJqgaGgUSkZ2kU7PUglgB6hzwFVdTY3iXUQGYEDQRVERUBUQFhLXwqLiICCQ+cIHMj8zEzuuSi9ivR73dmZmbe86c21WoKOMElAtSy5KApf+kG/PxhkRTZkX3rWktUzs4gwq4Ioc1nMLSwR1Ta3uzDGNfquqO6pHhz2rH367y798jduIJeKeFUkcnlRtNvdXrc3zLLhcJhnw17Wl5IVRES8995zUBsiEBISOYA0dRhVp6oqCqqiKiyAAGF+LsAqKnVmQUUEUgVmQburRsgIIxIFBEskbJWvnXwIZCcQgIAAA4v4shQWUfbM1jekaa3RqE8vzCzMzU/PTM3NzMzPzc3NzU1MTPQGGaXJRz7yl+LZZoVprSbC7e3BMM+yPCvysvBlURTsxewsARBQER1YmY2IoKhKAILofZnWJzrd3njuPXnj2eRkHBzHVc7268NrG3/zlavr9dZsq1VLEyQEERGenJjYqiWb21vsi7KElCgHX5bshUMFJyLKZF9IqsLMiAIaJMiqIJWMCdDyP6uIiudSg1NxkNFKOCAEo3waLfkAgSNRUfaswt579ix2yFDiKElco9FYmJ+emZ6enpqan1+YX1yYm1uYnpmZmmpNT09PNJtEwMLKnOdlrz/IDq+sb26xDy6oiFTk+e233wGAqqTKAsKGzRIQOgcu5CdEseGziCpQVaOJpM4NsgKO5RadpPMl2el6Ah+wCEXEo6ubZall0b35hhunZ2dakxOtiYlWa2pubub0M86YaDTIoXMJAjL7YVYUvvB5vrm9sbq23u501lbXV46sbG5tJkkNAchhABBVY58AdhnFsrAKC/vS+5LZa+G9jU/jdQY7AljYe68snsXOqVpCjXptZnJifn529949y0tLu3ctLy0tzM3Nzc3OtFpTtTRF51ig9DwYDrv94bA/WFvf6A/6/cFgMBwWg6zIyqIsO4NBVnBRlvH519KX5JJouUAADCoxPDDC+PZ0GWQSokXUzkFBhHb7ATLHKRocDyb9Pu5Nb212yty3t7fvvPOOeq0hKmidW5o0ms1mrV5LaXpmZm52YXqmNTMzu7S4uLy0dPbZZ6W1tCgKUF2cn/29P/jjv/n05+fmZlVTUFVUAQFQVAJEJEUgBAHSREBFufDZYKjoBnnWHfQ21zcAFETBATlo1GvTU5Nzc8t7lpcXl5Z2LS0sLS0tLy7Mzs7NTk+3plrNZhMJmKUoil6W9Xu99bWNze12u9Pt94fdfn+Y5XlWlKUvRUTAA6NizSUUjI0oSZAcqXDpi7RWFwFRRUAJ7Q8lQKxqTZKqEpCNCHDUDKNoKYoqRlGQre0OnAQJ08k9Vh500GwDi2zoXJLneT1NG/UaKwMoIHmWbqfTYRFhz/fa40KO0rTWbDZVtFlPfuBdb37tq18+NTWFKmT0K1EIhWGERhVFWdizL7nMfemZ/dzsPKgAkjCnqK9++fNPO+30pYXZpaXF5V2LcwuzC3OzszPTkxMtR1Qy51k5HGTtbm9ru3NoZaXb67c7vU6vNxjmwzwvytJ79pbqCSqSArmkloACpioqQoAoQUxLiLW0gZQAogC4JMVYgUlV9kCoeBXIyKiqUJ2TqmLTQCYUYUTo9zOzLjrZDUuyU2njuFHtMW9aAQAGWZY4Eu8VgFXMQ01JgRApSVxoHABUVAgpy/OVoytPOmvvT/7YP3v9q152+513//vf/D8uv/KamblZVfXKpfe+LD17FSWiRpo0GvWZqcnW7OLS7OzUZGtycuryK65CUEAoymLX8vzv/6//s9GcUJHSl71ev90fbnfaB4+s9bvdbr/fHeT93mA4zPLCD/OSS+s9EAGBAIkAE6y5dCzXGw9sNNdRJYjdLyAhCiC51DkHighk/EJhUVUKU6Cql4u/sHMRoeqfK8iEmQG0nw2zLJ+cnDjVZysPFROj7wEA2NhsA2LOTImz/gERVKxxICscFBUBVXRza3W6Nfnz/+LH3/WO7y/y/Hf+6+99+C8/VXZ7NNHMhlmapq3Jidn5meX5ucXFudNOO+2M0/eedfrevbt3Ly8tTc22akl9a7u/td2/4fqbmVnJASgrfv2K6zrdfn+Y9fuDfn/Yz/Lcs7AgCyCBc4TkEBEdJYTOTn5AFWN5CajKmMeBhl1gGkE0BWUFtG0dyoBaei68z0upFSU4GmaFZwBAxcAjjccHIFDkDlhVpAgIgDZCBBVEEAER6A+yYZZNTk48JKvw1CtIHyKA1ta3ci+DbEgIDsMaHEJQUdQxFz3EPM9e/uLn/eh7f3j36ad95ctf++hffPjoevslFz/3yWefsXvXrl27lpeWF3ctLramW63JyWajRkQsviiKbFgOBv3V9fWtrf6tt929vt3u9gdq+3IAet3BN751oyA6cgDqgBBd6hw5IkQBhfi0Rp8uSwoqKiFXSHQMFkUEq2ARAA1hBxVEYwsyKgJkZTHoDpRLzyIC7FV8nhdFmjgkDEU0WgCivRyrRPSVCBVV1J4+BFQAFWHJ2ff6g8WF+ZM90k8efSicwMmHAJDl3vvSZ1ngUgAqgld1sbJSACXM8vzcJ5/567/2K6lz3X7vnLPP+t3/+78sLy+kaZokDlSKsszyvNvtr62t3n53p9PudvuDTq8/HOZcgogwoC+53e7lpRcFEUUCEVXVZqMhgRSiAcMCEWUUJ6AGZ9jGDNCRm1vIDYabWeIP1qYEICTAZgoG0bVDlVCLopiqwU/81Lv/3fv/L2F2jrwvz9iz9O63v+rjn/miQBKyBaCSHSgqoIiKCmKyGzaK+sioWVjsRO70Bo8DPgc8EI30/seKiOQlo4Kwt0I+Zg7CePSKKqIriuK8c58y2Wxsbm2JwMz83Gavd8+BQ73BYDDo51mRFWVeFGXpSxZV8CxqehB0CTlyaeooTaRkcEWZ1GoASkSpo5ISVQi1DsT0rQBqARF+oQgKIIaOGIQeDj9SMPMvQQBBBRAENCAVAUAC3GoXIcXyl372vbv3nuXzwtUnLGjKIn/Viy7sdbc+/fdXNCdasfCUUKVYaAGgIKBKRVgLiQsZVNUzQL8/fBzwOb4r88++odfvr29tF6X37AFJAeNtUNUQLQqKogQwzHNyyQ233HXDLXdCkhSeQSBxCKRElCYJOnJYcykikFNRm5hFBEyMewycce6BWQURMK25Rh3IsQoAkB0U8Zi3s2BschYjB20ah6KCgKarNwaakY8q4pZGjhGAonOdTvflFz/jtL27r73h1iIftOpNVFBm7/O19bXnPOuCv//GjaVXFxKG2NtAIBlRFCBEB6rJMSxwfCmA2u334UEE2TuIo9OOFKTf9SsvymFRlmXOviQiDTUHQsjmYdkaqaLqcJCxIiuVomktnZyoT7aa9Ua93qjVaomdSlYiemFR041opICixDst6lm49CWrAJESAoW6AhW1Epwh2pFh/6jawAQAQAIMpQAogahhrxR+HqvkE/6AVVlVmcvTdu9aXd249oabu50uoS/KXFWPrm7dd2CF0O3etVwWHgKN2Y5eJyASy4iwdsIYAIoIgiAIJAIquN3uPcQd2an+NtnBwvPBpiqIMBjmrFj6Us3WwmoOgHCKo8HXpjyVfJiVJU80GrXEISqrB0VEsvoPjTqsI3UIhkuJ4QlTJFBUGfb6Wl16UmWf5xk5xwCCrBWRROIE3v6FokBq/RSQCoMahyM6WIIQVJqIwOSLkzhERVR0SEVelmW5ur5Zq9e5KLxzArixvtXpDeaKvFFPFY3eLnZ4WWFDlU87YuS3yCiVIRrCsX0sSLrjOeMRZo6H/9oKAO1Oj0vx3o9000EWpgCKo9uiADjI87wsgUaIUMQRrLUDjh6jIKr2rFouCU83sCoXwze/5gUzU3URQQLPujg39YoXPr3IBxRrZDuR4gcTBEVFFVRQMfphReTE8K0KooCiI6vyeCYFJYOFki/Ljc2N4TA78/TdNgzKsmz/gfsWFmbPPPtJR9c3VtfXCFWUTRqJ4e8Zq+CrCWF4hMgeHy+eVbuh5sCTlDN25lg5wXns1nanKEtflhYMDsEBohrYiRihbxVEdP3BsPCFgHhmtlZX4j0QFQZhVVHx7D174dIze8+evS/Zl6zS2dp+3csufuWLnlP0h3mW+1LywbC7vf3Siy580bMvyIc5gAUBSBjnxi9lwQgfKBjtD1RABCWUnmgYuKgoCqDRSQFQkRhBTXEp/s47715b23jqk0978Quet76xcXRtc3p67l/83M+sbbXvvffgxtp66hAMJoZRZzRWwiiI2iXSaAijoKVnQNpu9+EUFzWd+Nd2u6MK7AsCDDJiDBASAMUqUFWBELz3nsU5srKBEFUBdWQQiKAsEV5jRUSQWEIgFVl5+u6F173yBXffex+L2uifmQdFvrG+/rIXPPuW2+/rDzwSqXIkgxoFDNm6SOUw4BVBkIhvoaoShAMpJDMMw7/4zKOCsvfTUzPfuX3fU88+8/S9C+999xsvevYFvVyee9Fz6omsra3e/O07lZFUWVgxsWMyvk54wcgm0HBeBbwFgRWROr2+9z5JkpOKg5182ycEAGh3+wromSkhcBRqfUQgVAS7RaSIqoTOF0XpfZK4YNqpGFvfirM/5jgKogZSqYkXyJfFOU86rVlPDxw80hsMyFFZFOBwkOUHDh1OHDzpjF1lWUSJPArIWEYPNY1hXoBilWfoUwIHKMISqIqKKALxdtpAWNilrtma/vtLLz+8upkNOuc/ZfcLn3MO5u1ht3PbHffuP7I+MdE05I8AUDCC7xg4yhI4JxXjzJJJKNFUs7wovR+bXD3+ModW0sP1zTaLcFlGACpOEwxXHHl0KKKWeeELdkmCiCIBQLBvjlGAAhJ/L1A4TU9nfW295jY2tu656z4ptdfr1wV8kRd5uXJ07clnndFIXaBxqUaEAw3ltCMl3pgIQ4QuJfQpEhoYBLAyFUM5rAqiJlwovZ+dnVtb95/63Nee+bSn7N69UG80h5n/9nfuObzRnp+bE1WOvY5KGBtokPJZb4QKEip2NXAOCEBYAaA/yAfD7CGY6KdocBzXztiv17e6JfuiyFFDEsdAxTW6TvhmayI9Q+nVuQRCykA1CchI58iKioIKoBTH3QiAjgjKoljd2FrZ2Gy2mqJ+0O8XRZ71+1xks9Mzvd5gfX2bRRJzp4zcnzDfAI3DUmtcSYUBlcKEw3oWwdEslcIILZDUpep5cubZxcVet3/drffit++FxLHXRqMxMz/v2aNhOgqxGQZUJCO1ASAShsltRORMmKPI4lG1P8i73f7C3OxJXea180ywY+dwYS7V6/WcEke6DRJGB/DQvIVTRhVBCi6KMk/MTUMDDxAQA/XLZAESnmgRJOOHIjgAUaGE7rjr3rNOWz7jtL0XPeeCy6+8eXpmptNuv/OtrzvttL37D68cOrpGzqlo1TJFf4fQqQZJipUAGA+vMEJBshpBBcgJGL+oqkDChMYm+cDQmmq1Wi2b8ydJKipcspURqAhx+mqUdkULFiOva2zjxAxiWJWUlQVAitJ3+oPHAdnnAWf3o3MFoCjKfn8AKGbmGp7SStUeJcuhTEfy3hd53pycACTP3tYVGFsO441AG3wCWliYvYIVgxOTU/fedcfhI6uzMxM/8xPvffYzbrjtjn1PO/+cd7z59Wsb6wcOHj26vrmwuNt7b4eJqiKQpXc768RulKlSNBSsaiOP4HBqkRPZ6RGciNAJ2icUAGVDKdB2IrNEmmsoMQFBCVAUWJgIKtt8CQMdHiNToSogkSqWLJtb24+DmuPB+Uhh2NofDPvDQpjF+4B9xUECaUCtwnBFAJGE2fuSHBKiD05x0R42wk0WTAY3oETmH4gqJgnWmxNf+PtL3/HWNyAWr3vty9/2ljc4wo3NzaNrW5dedtXU0h4vHLBPtKPB7nSAOUlBgEFRFMng0QBVGuWENNQ5GkvmALtjZAhHloZW4kwjamBk/kE1MQAYAzOiji7ibbEAjX8VKTGoL1h8u9ODB3Q1OgUzxwMlN6sRod3tDwaZCIsqYQCywsMOZqIFNOrxkRBJJQFwGBsAlfhTsYoNl5hiZT+60kWeze9a3nfH1l/99Rcuecnz2+2sliZ5URw4cvSmW++cnJ2r12vsmdDpaH2WCChFyNQYZgrgIvgQu25RRGVVUQCC2IAKSITUFSCQVQQEkWSsW44wV5zwAzogDSAYBnobjGwhFASq6LA5n5IIe597kU73pA9mk52qOh/EDFQBsNcb5HlpQwRbrwVVGYXIGug0QMFaUFR8WTpyhKTi1YmKKgJZLicExXgwGagtQYQvSKACyMLnPPX8Iwf3f+ErlzVqE0hYliUkyd7TT5uYmCi9DwuLIypLYLgq2qo3hjiWxxEQhdYxB96NqCKj4njGFxVEACVVUgQgRQAliKMaHVG/bDwEhKGiCMSAcGFsIBxlt5WMzsIFQERUtBum9qcen2M8Gh5MN1F1rO12x5jeVooSBBIoEkicc48eGEBmn+UZEgKCqIA6O+LDjDIAQzhK7eFoIxvIWfrxzHvOPGtp9+5hP/fC9UatMTGpwp5DZIS5rCoqqCgF3qfaQw9V6FmNKYpAOBqZBsGjzekwMLcscxEbdSzoJgNtXBVUGTHkF8tEbB2YdekB0ok9fWhtjVtkb0aduVmJENJ2pwdwajPBHmKdOtooEWCr3fYi3jMEeBEJnSCr/bGEzXhGx0QCFsxzRiIiFJMhxUmqja8DP9vqDXumQEGFAOPAFRSwKAokmpiaBCBW78uyMgYKdm8glX4p3EgNXYeAGmXDKO4aGOHxBIoNxug0U2OKGScIK19SCaiIogAAirEIVRRIgDFSOezvMYuZcOXGeKSBaGTWqyIlS5LWN7fbD02T+F4Gx0OnjWOw805fFFh8uAto2xvJ/lMQAYWArGMz7XJWegB05CroEBFUBK3IqPDR0OfYg44MihX4ak8sgwe2mh+RgsgxFIlCdv+Cf2iccVgjZJ9J4mRUWYOfkN3OqJox8ZFgNRRUUBABpKqoDJguYATsBK0Ar8os1PARQiME0U59VL7aZzXkBYUBtNvrxxru0Q9HTwJ8/l11E/YmNze2QdEzR+Pw+PQDRvMTrEbvqCAs2TCzb2KRaDtqsHK0OdA4tlQAQWRLCEixDxADokcsHBXlQE4UA8gl3jZQYVUR9ZbdMaAbgqOzpRp9CahpGwPtV8X4p0GlBIBCKAheVUKyMR6ghD4LjZsYslQwqUTLFBIJUErAka+mVvCK2FtCVSXUfj8bDjM4mV76j+pYOcEI7fT7iGrm8FZ2xYeIAhfCznutukvNsszW3lj1FeTtFWcCNELpQGHwEWVioCAoOJqpWxPIavAzgoyIiVE2H6An0xsJAEIgAdibEwmgVeALhkCx8W38W0KvOuJ44EicQiIs9juW1tRIX1Kh9GNillCtUVT+UyT8xBmciooCdvvDbn8wOdE8eTUHnaScMR497e2eo0S8V6jIOgAEASPGYBCuEgLBqwyzLPQlEOvGWFsIqhhjDFUA2J5hVRODiJiMMPw7kLUUSIHACgzRwCMzFa4YGCWiqqjKqqUEsleYnBMGmXtQTyjYODecYahWXQogEKJDw0GcgnnnQxizUnw7gggS0pcqsECsTKyxF1UAD5H8CHG2QhFmVASAXpZvd7v3hzp2MJEkJzVnICILd7o9RFThKiUahR8BkQJrF2HEplLRoihtwzOrOBEAYFC0k9w4/Ypqj7oaQBrOgYQCziRQDfHNvx4VGBCMy1PpRSJmFSAPHVOnisamLPbdFQwn1ma5KDaJXEKriSC4OVSIqQTDB7RUZ/oWsQZaYYSsiJ0hsbcRA+KxGkyHv9nGyEVRbG+1x4DoHS44Tu5U1mrmLCu2uwMwneCIihxPe6x6UQjjUFAAKL3nCv5CEbWGDwRjcyNICFT1nEYbNjY/Yqj8Q3upKhyfKRuLBLJwaFNtNIsjPXNkdiKItbGB+A0CivYpEBwqgAABipKqsLWi9luVjFWCRwSFliryh4DiuVGxq0GrFhrCvCbQXMiFHj06NAColIXfbHdPKkh6MoMDAAH6/eFwWCCAiCBhjH2y1h4JjcQAcW+vfdLhYCAKhA5EVQwUUWPxabxoYpTwgCppVZ6qjuYWGNrlOLnRkVtPPOrDcYXh8K82naPlpHDlWQJJPlo82PMuWgKAWXt5AV+URe4VNLENDaoiOVvbY52YokAIdWWx9eaqVgZxGNWPkmjUwbCO6CIACCQKrLq6tlnVOCdDN3sy+RwKgLDV7nT7fUzrElDRkCMrZpf1cRQoFmKmJcNhrkJp0hDj6hl1DAHNhB7DfQQkU6qN08TiaN1GJOaBXpWmqkIBI0FQUbLZP1KUtIeq06BSQYJgDeXYsPPwloE0HBZIVBZ+mA9riZtu1huTTQYtvXZ6/WFe1Gs155yE+S9K0MwJiAQfQgParZox6B0D6BvLnjDB1Woio+pFEGhzo11d68eBecv9o6PfHzCLI44zcKB4IzmO4SkW/VZwiIJnVlYkFFFv54+EViWElLm3VHUqVnO4UDU4HcVDVdNogGcrm2yQ0KkaPdkQc8WgkyMb6QlWytWgiiWsCAlJe3trab716le/9KUXX3jaabubtVQB87I4fGj1G1fd+IWvXHF0vT09MyvhOKkAXbazTUIHFAU8aF0uIml1zCCYVQ2GURwEkLTTq5ik+Lg6VuIYbbvbCfMAUEdU2azEc5UQQCnY89inJMSiKLx4c9+y4tCFSayRkqGiYShEYbvdY0CMEDuM8kkk7xJYkwgK5gwoYbyrVWk5BvtG1q+wRrmqgqqyCpgDAueDd3//Je952+t3Lc5DNNRW1dZEc3F29llPf+o7vv/Vf/IXn/zCpVfVmy0RMUWsISiV7X7Q6VZ8eEthAiiASAqRMibB4NCKMXLU7nQfH3wOeICNCAIAG5sdz4rgRwPVeFWQImotkiZpmEAgElGW58yMZoIR1QkMUlX7Y/72AXuIMLQAOvsf0hFlxF5IAhk03PvA0Bgtvq8kSlVMBWxBjpkGKwDmRYk8/Lc//8OvvuSFIr6f9RFckiYOiQA9c56XorI4P/0b/+onzz5z9//zp5+uN6dE4tRFnFQFsUY9pbW5ka5aGdNVs2ON0A6oOIROd2AylsdBcBxn9WS/WF9vs1dn9brNF8I296CnHpEeKCQGRCiKgYqPyoEw5K4m3TYOJWM4ICqSBqAIABRFkKoJJ4w0ZKOxfwwYqEYqMmLTREudwE+DgNazKqmh/sIiw177/f/mJ199ycWDbOgcNWrNXj9f39wqS+8QKEkmJyYnGvUi9574h9/5/YeObn3sby6dmW6JD45EkUUbRzMgSIhB/iJRuxKCKC6Qq5jymhJttbu9/mBmeuokubjs8I63+2e5zXYHkUouAAkIwGrAMJW0tkCIAjBNYfiKvpSiLCLQzCqe1NSKEGTyAAKioBSOg8BNreZTYfplDTAIhacUNTKERvVLYNpI5LFiyPGgEnqdYNemIqRESdrZXvvZH3vHa19+cW8wSJPUkTu8snHjrXdddfWNh1dXAWTPnt0XXfiM5z7zqXt3L2Z50R8MfupH33n19bfuP7KR1lLl0VY4ALOgCOmLYgiMSGUgsdoIUe0IWFQBesOi2+vPTE+dJCeGZMdzxtg0jgBga3OLEMuCQx+IxnVQiQphAFJgDGvbAmvPllGQc4xiUulw4gNF4lW4YwxKIpE9Ejjoo8UsES5jQz5Cw1SBLBA5Ggadh3IRye6YGI0z7GwTAAWXuG638543v+K973hDf9BHIO/1nnsPfPGr3/r0579y+MgasxdQULniquvf+wNvfdVLL1pcmM2zcnZ26j1vfd1//t0/q6U1CFU0hE7WlFBjgqZwjkT+qkZ21BharApaeN/t9aun89RqZe+/3Q3GF7IQAsBmu6eoXjwaUgkk1TxCgUOqR0TkCIYRkffee0/oUGwDAYpVkzY3ZY09MaqiV7EbCKgsSuHek1YwJYGqHWdAdsVRKwvHyv4gZLQAhwhWFD/rWFWQ3FZ7+4XPPud9P/GeoixtR+V9B1Y+8bdf/Ohff356ZvHMJz3J5jueeWVj408+/ImJieYrX/K8Rj3pD7MXXXzhrqW5zfaQiKzIBTRZm2hFLQxRryMOUQDPAdE0GRipbzjIyvXN9smjGe+Ayn7cguEYehhAXpTd/hBQRYSCUtpEbqHKIqyKD6z6PERkkWGesXibmQBHq1GRMP2S0MVE/YcK2HKNUJyIRM26aVtNUQnCYUGcgBjZQkeMITF5IkZFNqKBTSoIkiRuMOjvXZ7+N+/758xclL6W1rd6g0svv/ov//rzs3OLcwuzQCSIQJTWantPP+3o+tbnv/L1dneAgOx5YXbm7DP35nlBYURiVJWRZ24kdtjYD1AEOLCXwkRYAUBCdyZSlnx0fePkDWbpUaaN8ZUX9/+efr/fH/SdcTSiK0oQa1irSGFEy1pBkwoARVn6siAKsLKASJisxQuIYrC1meGAAqnRxTFOJ8Jkzew6grpNVcQHdQlUg3cgQWSoFmMo2LQ+xJf5qZe+nGrSb/7STy3OTvcHGSWu2x9cf+O3P/yJzzSnpqdnpkrv2ZY3qUohnJfzs3MHDxzu9HoBkFeam5/3XGqkswmHfsg4b1gRVhEU7A+D6wcDcNAqAAfjCRbVja3OIx6LnpRj5cSXPPYGw0FWIrkwpwIgJDM3copKIEHphWZUjLGuEs/CkiTpOCkm6hKAAt8nDMVMXBKqNg2DFbKqxpA3CZKTasIe2FrKtuKLtSJ0SWQC2TeTucN6ljLv//tf/Zmnn3v25labkrTTHd5+x33/34c+WYpbWJ4v80IqjDbUKJrWauQSUzyoaMnsyIVdc6aviywyURlp7yhIaKzcMY9KQXBYrbdERRARIFrf3IZj2YLf46nsiYSFBdD6xtZwWDhKApFJQdAocgEkNtMUBQ5NB4BXBYDBcJjlmYqS+WXY40WBcC4KoDwmAUBU9JESbEwsFQlgvRFOQ+TgaE4V1h+wqpPgvjFqoQL5kwhFEKm9vfFzP/7Olzz/wnanV6vV+oP8jn0H/+BP//KeAyt7zjijKHOJ1ogIpq9AQBLBqemJ6ckJ9qwi3vtOtxuACwDEIJWLRDGMdGmpTAoNCLaiHce2WBKAiFeB9Y1NqBi1jxeE1O7A9nanKMpaOpK1IhJGwzxz+NSgXwFR8SoWJaJa5HnqElAR8RioGARoxDyJe6lHTKFI7RNFlKhPUhVUdDCGvoXOR4Jtij3jgS5saYIUQZWN/+Ectbe33vHGl//g27/v8OpW4igRXNvsfPyTn7v6+pvOPPucPMsNYRcgEg3KOZAkSfOiOPfsM3YtLeT5AIm6g+zoypqjsLDFHFtEYfwfrAZvdnXi+lKbu0CFCNpgCGlru6tho+XjaGSvAADDvFRAVg6uo8YupmjiDeoC8TbuKwkWz4AARe5dw0HVcWKFFXHQUmOFtga4VIOV6Wjabf9E8z+goDeJuIHYLg4QZK3IIhi+R0GRIBtmL7n4Wd//+pd/6m+/vL21nSS13buWb/r27Zd+4+rTzzxLgdn8huwAQDTTP0X1vnTi3/TaSxwpi6aEKyurBw+vJEli7ppoZUQoToGUAqyioJVzSzyhgpoBRxx9UXAJbXU7WZ41643H21QWYHVtXRVRCWKeiBxjQFSyKWWgbIrE5h4BhaUoy0ajhhH5iKu0zBEfxx0K4j+IYLQLiIxBHLdlkjAykUAcCTYY6kPDJBqNo2JOEhVNU7e6tv2+X/7Ph44c5TJPXDIzPe0FlnbvSWq1kj2AsiggEBAhWYtNLllbPfqjP/DG5134zI3N9cQlXvCaG25e39qempkT8TGXRnKYhoGfSqXogdHYMHb+QYMZkHwGSAf9PMvyZr3xeDpWYnBsFGVJqIBO0QFwkDVW65oIAw80DC1tuwXkvuwPs4nJlpJjDoA7IQFIyCzKUSVpJAdCFTLBdVDARpEkBitcxZE7W2R5h/McBQCrzW0UcRoSkW6vu7JydHFx5vnPeQYAttvt1bUNEcm9p3rqkHwwh0A1JzLVJE22trZefPEzf/qfv2d7a4sU2fNqt//FSy93SYoVcwQDPwA1SiiNfGbicQ4dLFYc0jg+pDBIUlIZDLNutz83M3MyQNKTGxzd/hABWFgQCAHRqaKir1xgbcfMaDMWmA0wqWqel8zGKUYNUo/ovxCedCak+DeZ9rUKF61cISEwyeLEQsd4JYqRVxzLYwUGUcA0rWXDgZTZS59/wRte/ZKnn/vkudlpQBxkxcbG5u137vvy16+85sY7kqRGjkQYkUjDKtFur3fOWUsf+LV/6fOsLAqXJoOc/+YLX77ltjsXFpd96a1XFbUtO2S2dKNMgRGJGwH3MGJCjfaJAagOh+X2dvvM0/fCSfD4OSnBUX3AbrcHkS5asQIrphNE12hEUi0xeOkBgBIgMwMgIHn1hHG7GkSbE1UgwwYwdnIqlT1j1ZSEs8LMpKtaDyJ4bwQSRSCHpoRQACBHnc7205+y530/9u4Ln3k+ez8cFP3ugJUVcH5m6nWvfMkbXv2SSy+/5r//3ofXt/vNiQkQUfBASZ6XjVT/06/9QrNWW1vfcokbFP7yq2/66Mf/drI1xWpSLoqzoIpVFPks1Srl4A4T1VNoK6TAMCNjDKlKWXpjdejj6FgJfucb29YzBnHhyOBVwxDNVOxRwGHVABKySpbnrKLAoIKCaItrzGgJAwxmpzRGzjGMAPFQowa5oSprxbQLVXEoijGIACQYwwAhbm+uv/qlz3n/r/xsPUnXVtc8K5EjtOwHWVn0j66Ro5e+4Lln7N3zq//hvx9Z7040Giws7Dnv/6f/8ItPOv20Q4dW6rW0YLnj7gO/98cfKlmn6nXPPrqdh6KTTXShlaN28AYLJKOKDRYOQ2t4gwYLFNnL2voWnJzooJORNiw48qLY3Goj2POtRoyLKCRGt60whESiMIyK0ZUXOfvSKaAICmqAksNqr2AEKNELkDlYT1d/p/HHA+jKBrPFzX8YKOqVmZNVKAKpSzvb7Zdf/Kz3/8ov5INsZXWdXOqStJ8VB1Y39x04ur7ZLr26JGHmA4eOLC/M/dav/+J0M8nyIQBtb6y978d/4MUXP/fgoZUkIS+yst7+ow9+9Mja5szcnPc+gPgB4DcYV0xRNRK9oCBFHkcYR8YKGZRHKzjQSOxHLThOQnQkO32ajI69LCvy0gdwyPzeA2ClWDkY2+hMQ81g6j4DIHzpJWwlCEyOStGkysEPyMZrGIRKWBXyEhnkGlZKB5QLMfa4o5l4eO8MlCTdbu9Z55/1/n/384Net9/vp7X6MCsPHD76zatuvPk7t2dZvmtp6YLzz7ngvLP3Li/U6snm1vaTz9j79je99g8/9Ik+d9/5lle9661vuGfffudIALe2Bx/8yKduuOWO5eVdwj4epxWpKHKcj+lBgqYKEcb8YAIuQogIyibnt7kCwOZW+/FB9rH4sLO/2+sPhjkRihgTMFwUa1yjtTgoIAGw+NFomgAACl+YY6xokCHH7nVMzFYxxhFZlUAoWFiqGl+0GrcGpLrC1A3Gj5N6VEIaDAZL8xP/8dd+Hll6vYFL0nZneP0td3zyb//uhltu914ajdp1cseXv375C577zHe9+Q0XnHdWLa3fcdd9N9xyWz7MX/biZ/+bn/2xw4ePiAgStXvFX//tl/7uy1+fX1ywBemAIxYsjjjPoLZa5JjEG1v+wH8aLevRyg8dVEWIqN0+WWTBHXb2Cb4XouCw3W4P+gNMGvH5NCeTiDUYP1eretxOOCVABEJkLrzVG541CYpnCEQARI5LWgJx0CSLzDy22wLDUF6MqCwhQkOccNAzACigw6Jkp/63fvV9c9NTq0fXa2kyzPmGW+/4vT/+0J333HfR8y6cn5u9+97DLnGDfv+r37x6YmJi7953qvQ/+LFPX3rZ1c8870m/+Svva7c7ZV7Wakl/UHzl61d95BOfmZqZqShlUFnLWf8dXUXCIEeC+mHcHVl0jNUYOUyVo4NdeCvsTrnguB9ptCpFBQDavUHhuZmCihA5QEUiUCZVIBfbCdt1FfbeBNWTmpNYwcyoKGF9dNXoY6B/a6Ds68iLCUXZYAu7qhwIEhSmt2HLdPSEQyBbXwGY9du/9avvO+8pTzqw/0Cj3mDB/YdXPvrxv7nj7n2vf9Ulv/3v/zdR+bGf/bedXjY93Urr9SuuvXluZubOu+668obbzj5j+QP/+//WrKdHtraSJO1nfOUN3/6jD34kSetpmjJLPCGw6k9FjBdduZOEDFe1qSEBY6WyCXQTjGpd4wI5hLXN7cL7WpLsOEhKO5U5RsutKoLgVpuDd1GY4UbehoWPMohtqSKMWiWtLiOUZSkiQArCKmwEHRSb3bOIl+h4PfaciYIKiqoAC4iyKosos7KwqI++TBp5AqUKOdra2vqZH33X61/14v37DwBSVvh7Dx39i49/7ubb933/973qd/7jL5dFliL9xi//3ESDNjY2xYsofvCjn/zGFdc9/byz/scHfm3X0uLKymo9TUuW2+667w//5C8Kr5NTLR+XYFdiRohvWky+EnsrA+BjwQRRnxnMi4JwTnT8S1TJUafTszXEp1bmOC5Oj4vclfUNDm5ZKGhS5jBhNSQSgteKdW5B8hpsLxTZs0isF46ZQGnlmWNSOY4j30oaY/rDEVM0VnUVxRzF/O21liTbm1tvfs2L//kPvvXeew/Y5H51s/1Xn/rCZVdct/e0037iR96jZdHvDTq+87Rzn/zHv/ufPv3ZL97ynTv7w+yiZzzlBRdd+JY3vrLm3KGDh5NaUgKsbGz/2Uc+vrK+uWvXLu/LMGwMU1iOzhyhUx1j0oanjCJKUy1Rxwj/h70jQGFbKiICJEnaHwzb7c7i3OyOZ45kR0oNeCDL/vXNbYhldkWJjHwNkWDJgaziAI1u5TBY/YjIsMxYzKxRCUfcBwxCAeOCYTVzCyhHnGlFdjeigkdRUXQUqhMKs+80cd1e96ILz/3ln//xlcNHiqKkJNnuZV+89PLP/v1Xlpf35tnw45/67Lve+obpiUaSJqurq/NzM7/4L360KIpBlqWuhqibG5vd/qBZr6vo2lbnzz/8qVtvv2d5126LjPDmgsGmGsskyvYAYSS9GCGclc0hBGdtEaXQ4wlBmO+H80Y4F98fZg/xlJ4SmeO4399YWzcRM5pgCGx/VmByBuoFKpn3nkTAwzapILD30dQ2VGkjmxtQH2t9irgymaN8cA8NK7AEzdUgxo+9gKAthu33B2fuWXj/r/58v9vtD4ZJmnb6+RVX3/jxT/7t1NQMOHCQfO7LlyngG17z0t2LM816fbvd2djYTJKaqnhfes9pkpJz3UG+sd392F9/9muXX7u8uCQspJWfHIJIHL5iLDGNKm07GeKahugWRaGxicMUDL4dRvzBCL8bMX8wzNc3tsaBju/ZMp77N64P+Iex/1aJ12XMqRzGHdYiH1yCnAtNYQ2+5NJ7JFQ1a1cMJn4UD+BqYXnwAlQAdMHQ1MhqZMwZQ08ozH5DWslznzr933/552ouWVlbqdVqg6y4+fa7P/TRTyKmzeaEMFOSTE62PvWZL261229/02vP2LtcT5wSMgsSpLU6Oc4K7nV7375z399+9ou337VvedfusJ0jCJVGU76AjYcwMRFPDHaNtgBgKwJkVH1hrLkjpaeyFLA2l1nMH2zH9faP6lh58MwBqtrpDqKoMNoUy0hziDgGByFpxVkHRAAHwMoizBI38oS9ahoXbIktXZBoeh1ZWBJr27DqhkxVjejF6KZkR9xg0P3Vf/kTe5d3HTh4sNloeK8Hjqx/7OOf6fQG83PzpXgiYu/TJJldXPiHr195zz0HX37JC8475+zp1tR0q1Gv11hkq925d/+ha66/+fLLrym8LC4tczBiN8qFUlTEVJq2qqCopLchACIf142WvEGQyZoXnsSGBaKGJ1wXMbKgnjrHyoMuJ1dFxEE23Gz3iVIZeUiC0bTCxjLjzQZWH5gRZWX3qwDK3nu2HcS2uU1ZoncchEVxOnIKtuo9AkiqAoQoVYVSGa6jIlG/P3jx85/zipdcvP/g/sQlBfuN7f5HP/HZu+89tLS8VLIn5yz/O8BGrbZr1+6Vta0//+gn52am9+7Zs3t5oZYmgzxfWd24+559w8Fgenpucb7F4QwFAuKRuCH054ThyFC05VJAYx83CPglrlkxSCAM8SsfZ6iY6IY42xjg6NG1cbLg9/5Yeeiv4TDv9weRviZxTGv5wrqQ8LTY0iwMOSM2/Ijeq/clEaqKsDfPv+AVaK1f1ERLlapDyrAgDBfJGEUUV4kDoDIkSG99w2sG3Z6IepLtzd5ffervvnnVDct7dvsgkxGjnJQiNqednZsGmNnYWL/+pps9q+FxE5PNs888ozfIuPQqPtgFVNTn4EgI1SJJJDRZBJpnFSBBXKFR4Z5a2YmBuZnhSKUXzlNFdXEIQUSdbv/xQfaxHqzT7fUHQ3IusFbi7tVqR2Z1RipS5e0ZTRAAwYkwi109GLNthEjGG83fUUFUHJA9kVb2RwYzBEIHkKoQIpIOsuHTzz3z3Ced3u1soaPM69euuPYLX7p0eddelEBO1qo3VnFI4JmSpL3d/qF3vP4Nr3zRfQcOM/Pk5MTZZ53+d5de+dFP/l29ltpsVSRQGgUURCiqMgzOQQUzNaTRaEVAMbLWNJhXGrM6JIyK0SgGAVjzJ2RWEeyc2+p04Vgm6amaOVQBsdPt5UXhas2Y6VHH/zwKEqtqQaP+vRKFMrOKoAozgyOMR0VV4wZRQyRCCIoYVyIMxStGEdhuFow2gL7Mn3rO2Y6Axbuk3u0Nvv6NKycnp9LUec9KFdMj1AteuOZcd3v7wqc/+Zf+5U9LMXzmBeclScKKn/m7Sz/6ic/VGhMS81eYjOEIXYmCCdAqHYDZElXojEDlRAhRTSFAAERh9zCOdzSqOObk7MhtbrZFhIh2Fuo4GZlDAWC73Su9pA0nwBjvYIgDo1+rKqBDkCAoQRt8hJ2gCCxSelYR4GqFhW2HCzxPVCUkifM8qzpdNPFgEQobWWNTg+hVEkVCWJyfK4oSAJ1L19c2Nre7relp730wUA9mUXa0oCMcZtni/NR/+PV/vXLo8Mrq2kSzDuCu+/Zd/+P3/zxJ6zYtorG5oIalYlg9FBSSRFzJZF0ZjHYZm52+Bs6t2aUa1yTOkGSkmoDqwUJFwHZ3OMiy1sTEqc7nsKJ5fWOTWcKANVgXYFAE6Pj3hvNFWGIxL5Wlny+9Kjiy5Yta+W2EoV1oSWzxKxCAC+5uigoWJSjBwBpEUYQEbCNtvVHLfVmyAkKvN2BVU42YJo+DxZDdXudZEPkD//FXUoeHDx9pNOqstO/A6oc++mkBrNUSz1xxPCuU1kxeVNUBkgJJcEs2PWPkf1VdbjQ10uCDLmIO6xHtCCgJmgdAlGLYeAa7vX6vv/NLFOgkZY6NzW1Voehob2QW0RGjWuL8ydI+hgIS0VzlCFm1ZB8XkZvBqKKVrqrR7hxQwlYOUWUZ2YsGQ8Z4h8YRNGYeZlnuvRfxRVFv1JyjuL0ArOYYyWgR8mHvP/27Xzj/yWfefc+BtDlZeD14ZPOP/uxjK6vr061JZab4ChK3Y1M89ioTO4EwZTHPUwHbzBFafZRKuzVa60WxDbN4EREVs2CVSFUA2zYxGGZWk+6saHZnB29xAgBgmJ2YY8bIazZgG8rVoFUUgEF8ZcpQyc5ElL01G2PSV7tMcbcXWaEvGqdwGqLErGfHbE8i6woBhGV1fcP7klWGefGkM/fOzUx55rDCzcbAzCriEtfd3vpXP/PPXvfqS7592x2NRkNF273BR//6b267Z9/M7DSzj7tZ4pYnAAlk+oiOhrUsgKoEY84blT+IRo+fUFyP1yfV0tDQoupYsxrHmtDtD4Ki+tTMHDZaqajF6xttIhd3RAcRfSDFRoPvKEcwpbRSkP5hJZovfTR2lrjiN3hqaZi/BtGShvXRI4qginBlmITjPgugCnDPPQf7mVfBLMv3LM+/+mUv7LS3kySpzkUiJKSVQ4fe87ZX//iP/MB1N9xs9nZFKZ/5/FeuvObGxYVFYbHH3wxEVKSKknhSRCpX5DFJSJlkkRrX5ALFZ0gDOQ6qResCIVVydNSz/40CSRXV0svmZmfHQVLaubSh4/4cq+ubcSiKCEQVbT7w8aMyNRhWB+AiNHJBHwfee2P5BVaGVqbQweQp3JXIiYlCfcAx2w2JwgdzmGfPtbR2x933rhzdIABHsLG5+SPvfssrX/L81ZWVPMt9yd7zsD9cWTn0jje98l//3E9ee90tg34GCqXoV7951Re/fNnCwgKEkAWQMfF/AOOC5G60o0NJQMmYbcFwIbB2JL5picoaVkNRLMQFREnstANU2+Qd3A9DhyMgolvtnScLJo8+YYy3T6pq3Xa70yUkFbGRvAQVfPD2ZYnNCRyzxKxyZTPSpzAbzhh/PIobbFgiMRVHlxMRohFJNFb0QQEUsARRSdJkfXPzuhtv2fvaSxKXDAf5+trqb/zK+84//5yvfv3yrXYXEc8478w3v+FVr7nkpbfecltn0Gs2G6xw/U3f+atP/m1rquXINl2ikIyLSUYegRr76dhuIwRUtPIkhOA8Wi0ODaANVv0sKOFYtzICAqJYAUbTyLgP8BRjgt2vDsL+YLjV7iChVPMAHX0eRZQwirVpW+U9PjJyMZxLgiG9QFU92GhXRvBIvPIBN7UXMjZzmNqHZR0AAbRGEp1oNL/29W9dcN45Z5+x7BJc3dza6nXf/sZXv+dtr/d5nibJxFSr3e5cc+MNnqWWuqwo7z209sGP/LWiq9dr3vtQzLAiVEaolrMEIay8DRsXVMwBy0uwKo4rSiN0EeGw0Q5lVbO1ibi6TZvDWmRCMlf0uAeOEfHI0fVTnexjWaTd7vR6A3PqrKYfI1UZUNzlZSvfTMWqiA7HlnlhWFsEMYrirkRjXdriEVQcs64eCQ3GZi4RnpVqY6Ow1uq17a32X/315977Q29bnJtKXFIU/qZbvj3ZbEy3JkW1PxgO8zxJE5e4YSmHjqx/8EMf7/YGM7Mzvix1NDIJPhDGYZKwb1sDJC5BvGStZ8hq0UwGxvCQSk+DWDl0B7zTPmdc01MRZEEqxbUIRaOOU4ImOM4IPK7aAID+YJjlBRHFWkGrciM65VXEa1O0VDSwwI6yzOE9xyVNlTVkrPCxSrfViRbkHxL9SCsX0nCyj63k9MzTM1O33XH3//fBv7ztzv2dzlA8NJoNRtzs9rZ7fQZt1OuOkqzkm2656w//6MNH1zamZ6bZ+2qXeWiRwiauipwWrR6ChzaIybFCNWK9y2haCFFcE3Cg2Alb6T1aqVDRoTGYYYerSsogzqW9Xm4k3OPImt+DzHH/heTjX1vbnbz0jWZNxBy5RgDwmA40TNpGY/4AiWHc6qxsZD7zjqzYHwH6qWS0lZo+rOKq9iZhNa4abSUGitdaQBcW5u7et/+P/vQvLnnpiy98+tP27l6caNYIHIOWAnlerKysX37VdZddfjUizs5Os/dg5tY6RiWJ62CNKoIBwMSR51tEKuyJoLD2IPxhtMsdrfsKbKZQa1YmtbHIPuYcN7sITJN0q93N8qJRr8HOIegnZV350bW1oiiazYlKUC+qcaEaEIALG/hUgs4l9rSVNRMAAHj2nn3sUqFaVVR1fAKMFdNyZLgW2NuIgX0ZCxr7rlAjGiS3uDDf7fU++/kvX3XNjU85+4zdywuNerPwZafbPbSyemD/oX5vMDUzXa+nKiOPkHD8V1LsaCsC8fQSiZ7D0bdnXEQjgek3OgKD+HdU3ge7KeuzHI58OcIWTIz7jQ3qQdzc7vR6vUZ9/tQevAFsbHUjMDjCdowGTJG/Ve0MrsYEhChQmTsjInrmUG1U36ZoQBJWC7PiAtBq7RZVG0YjYDQGP2DcXIKGGJBgq9VqTkz0ev2rrrlRhAFAlBGQknRycmJhaUGrJY8A1Q7I6JQgGLcNa6AzxlY6hrk9x6a/G1vsExjEMmZJAdWOANCkOhJt6B9NrqIoAShuyrSmuNPPtru9xYV5UXWnMp9jbW0t+nDF1ZqmVzYjeqw4c9G6RqTiqcTlAQBR04OEgOZoDgrAElYiWgqh4LBhE6hADNBIztZYe4wJlbXyCArpioUQW5PNVmuiYjVSuKMizOFwxwrH0Jg3YojEU7HqjlSVRxKmsPhF4wozWzQXnxxLKkaxDsry0XGjAkQ6tq9cwqMDWBXiguQoy7ONzfY5T9pJHGzHgwMBYH2rHVd9R00OBMcRQGBFBCRCK+u1KrTGDFolOOuwhDYHRl6BUaOiVn/ZT0lcxlcR6AA47gqMrueRwS6V4X21DEmrFBNNt8KWlmrndNBWjXRH1fLgKLZADalQI+qG4dkwaUJYr3LsGCocJJFbFAXelTOV7TC3egoFJarszbtMYx2jw2G2vr5xSvM5LD2ub3WASAKFKawHVjXb97g8nlVBkAjGrjKOkSsBQFjCerxI8peqmAwbvat4QtUxafK4lCxyMdkEiBhEkXEtW+WQHkBb6xdMVhOZI4gjJcHoxo72xY4KptFacg0rIMPyDkM2K6NTiSu5WEBVXJSW299EiCoqOlp8pmNCJwtDmyRHQakv8uzQ0bVTOjgMHl1d37QN01DtVAk1gFSuVqG00nDNMJIio1LYVooHTgyOJnLVhC9YElQFYZV7bBU52UKFCLZaHYejGWnsNzC8dCUwCisppWq5R8kiomowcqrHQIMPhMQowhrhxaOSE6p1g7HJtWFjiD1RGHGdImmQYyFdzV+iHXvcmB1CRgBwbX37lAiOB2Qc2W/mRdHuDIgIpMryWDkoWElG0XkcMfLxycxrcaS+D8vl43JyBFHbtjXSI1TkygosrTxxJAiPQ5mII2/gWIBETJPGoFUYTUQjJXwEl8TdP8EqH0YLOcIEHeLKsMj+rSaxGBcIhZWAEDlJYfVyNZqM5pvmlUgjgA0CnVgVrQhBpDCXEQIAQtpxBH3nV4d2e/12t+eI2Ho/k4AqVA95aPnHLnCYnyFVaHhUMQmFFp8QHKr66IUllfgxgiUjP9oQgViZf1GFP8arHKRVcfIiY98dN5QLiO13qJgIWnmiV0TFMMJFZAVFcRpdCaPFPoxo8eH8chXGEfaIjSGl8fQIy2cx9t4R0sDKlt1+PFo+C4ISru00SLqz5i2ACJ1ub9DPkEjZB1lXtZIR4k56sH2wZEnZZo/BAaoamFmzEEg3tvtKJezUUBgtHK0KxGqVRkVKrQxdtWLvAcQ9cxrX8oWBrWloDdgPuUll9IbGz7MIxNuBF7bQSRy028lStVRcmUwEknkYn5g/mlVO1QgluB1h2HVcLT4OSDmggrpoGaWjmQuoo/Wt9ikcHKAA2O50szxL0mYgCEZ/2FA2CkRJoGnR7Lyp1F8uMmdV0QzRw05HGaH9FNN7XBsbemCBMWJA6AEAaYRpBpAC0TSXwZIysiQiOB1wmTAdDste4oQMq4RXLXUJe6RiIWxQmIrZgcRBtEJMB9GIQSu7zajkqdZPqyISgFXFapV8fDcI4EEJgEPFE84mR7S5uV36Mk3SnTIW3FGaoCoAbG11irzEQGuLjEAR0Gh9EBifVPnBarXHvJKXxmgzZ9m4YMdMGCr2UFUNoOhIdigxMiDUNZHzEcbkUYIY6WRGN7H/Q8MbKnaKhoIRxnyFJZrnV7UwRq1ddHwLsUdhp1/om0nBKToBCidnSGuGtFIl50UkRQJCrWgKaNu4CZCAnL3JaoYDqqqOXH+YDYf5iMd7KmSO4wb3K0dXS+/NQCVUhRQKbqkumgR35xAdwiayF1VCIECONAxW0bD9m+LRFE+I4NZYuRVEfCCw0TAuM8ewLPrYtjAM2RGj/EwZAAIkBRB2Wset4aFGirOOSOKyl3RoOrewHoqizQbH3YF2C21Sa10PRv2nhPaXo9VCGMz42GLHYTMikHmCOcXqm10EbFKXZIOi0+1NT7V2yrB2J2mC9ovV9U0WcxAOzYmtq+eQAwCUxZaHxPV3VbsxMjPXaIgmrMEwUquxSjUrCTviQnlhnD0JZ3C1gXJsf6hxniNDTNn463FWoiPSeUXsVEsngeiuIuKrnQf23JuTu8WoYTLGBK50WLb9Z6xUiUVmdC8j48JGgrWOtLKhNQa1vTRxNZD5c5gJTVxn5sgNhtmWNSyqp1bNUeWPzXZPEc0A0kBMsd1ClQI4gs1cGRLY8RoFkiOmhK1wBRQOBhVhN2j0NVEBRetyBQEIiQAleAMHwEDCmRXyMFbb5SLxuVqRZKMN1DGgyxqKsCtDcEx0w6AUCp5QdCNGIgfEnkjCNC6iLBDcesM7q/xGZQQNGCMsWidCQO6djhaIKlcO7RVnDMX8cYPx6ykSHMe6xREArK6tEdEYDhQ5T2MGmhgIcgSxfwkhgXGPBEaLYYk1H1DlDs8gLk5tDDowYARQOZDLoEI+KrTCdshVgxvRaN4xkgqNMCiB0OgGax7Q2BHrSKUHI9Qf4x6f0V4UBLUbGctUrSD5ipago+VAMpobW4yCjY6qGI58ByQMqyXIvgWdtbSedW1HEfRkpw6Uij26sbEVwF/TpAWoSiMhI5ggIFTs2uAtOL6122p6QVXPI5ofRLkTIOMYS5Qqjx/r/BXHZ/xxT3V1wISV9CElx3NN1YXiwOYWwb4NqzGyhkK6YqSJkTNC6GN1igT6WrAHHA0gHdoIZsysONpYRWoLIiCZbAPGbQODRVS0CbPHMBgliWknCdjL0bVNmwA72oGO5dH6c+CYJY1B5tudXoIEI29HMOkWAYWPExgL4fh1CTlHcUkASiWjjWNVUttbLzpiAsVXjFsP4rwFKqn6aNVGxS6Na0ssTUTNHMRXgSpJa9BCV8uhBAEMd9AKSA0nTeVTHuKzGvsZ0kEaZ3UYyRd2xXjcURW1kiXELBr7acO6LJxFggO4OiEMFwSj+ZkI6srRdRhtPfteE4xDAYVh71C3193udClxYvBodeoEVx1A22hvwBgm9Uat1qiDar/XixyZMMM1o0FlxRQry6wxiHz0YITVefYD1Ww4rC7VcUv04NuijIC24m8MlaxWt8YVtpWJLQW7umCObp+9ErXpiAMQVzNUll4qtgHD5rlQCTpHAxqopj2ooiJkfyAuWMtZ10DGSAis47DTxWhlVKmxEcncjEV4R86E5BHUGCO2fyRx2fFAgJ3+sNvPIhehQoehsv437FkBGrV6o9k0V4JGvdEf9McXmGnVSYZHX8JoKtgy2tolEIyShWNQcOWKNVNt2Rj3C46WfjrmDDwmkDD2umUXp5GRWLW5esyZNeItBeOVKjhhBOOG21ntEw5s+ZhO7HypbI6s6lSvowlSFfrogoVVNQmWwBUBh6prG1slC4vsiNw+ebihEQpMHevUgls9u0a62e4NsgIB2QsShrk9YFwtjswMDidbU816Q2MPmNZco1bvDzN0xnwAF6+wdZi253xsJ7PdWNJqBam1MgyBbAeqpKKV5a2OrbFXUXXoRERA7DpHx2iMek1b/GVNssHbQToTFNzROFTikRIIQIGIEc/Pys7ayMMiNDL5QY0pQAJ2HBz0IghCZGNnxMqYu9pCIsH4iQObRBVYBGRtY3MwyBzuTDP78IIj6g5x9PiIWvIovdRqenhlYzAs0loNKuu8uODPbGabzeZUq0WOTE2KEUSYaE4MhnkFVJt7nO0TNe6urWOqMK7otxc6mxEfLwCucEyHhGMU+QBvs3EzA7uimtFBEEjB2F5owsozSAFc8EIA4jEcldCSP+AIGg9c4rimXmO5E5KUVgAPoiCpsAHA0Q0qFBNWcAsiqhIeI9eqQAFUh4QK0KjXRYSZG436Yx0cwfDA5ORh0YEKiyiUhU/qfv/Bw0VZ1Go142lVYy8Vqafp1MxUrVYLemgd8X1FOK0ljXoty3N0BJViFsdUBeOPQrAcVI0KUytKKI7IwmDU+mCs1EORURToPIRKcRdMIHAhKhIhBhawqgKSBJanvagZxNLoXUVRVnU6jWDY0fQlkDCCCzcYTqwCFJKRAqqLayDirj8jFIRJsjGRQl9D1WMXAzlxdS7LC59xHqFmZbEjUMfDCw5m8Z5VMe4IAWE2X8WiyJO8fuTwEV+U2pTguIHIZZkk6fTMdHNiIiFkEbLUHRchgBIhIMLERDPL8+hmC8GONIxMw7lfDVRskWJYazPiGEpoGeKcrCogIPYTWm3EEmUMNj6jbw9nJwa+Z9x0jIEpH3K+BnZbhLWANOy5hUhBGmeNYbUuGTCeJdX0toJZASDGHI2NsCv7GaoqliCl1XCdgChJu4Ps9D1L73rrGzvdgSOC70lwFKVXARVh1VJYmFkERLJhDkira+uqop6BpRQVhNbkxPzsbJokbKvmRzpGGDn+IAFIvV5zzoyLyMp98/MMTthVewqRZlqxUmPKr2SmZtEyIlTYBIRQlaEyyoWgT6iM6YO1tEhFMSRAkVjqSGTpRXszBGPCqwM0Q4mw0MMajuisQrFF52gIYVFiFmKIjq0j1mqwU+Uhc7oTN4pCrPSdgCgqwszsc5/X68kv/+JPnH7a7mGWNRuNHYFIH3ZwlCWrqrIvRZmZRbz3wJJnmRL2+n0bUbIv6o2JhV3LE82GnYIOg42iTcwdhieMyA5vTFNqTU62O52EgoCBEFnEC1e3uYIgYbQILeSVWDOYbxiSzbtRq+2KotWuNNuiAWOZ2TorHMkcQ81t+U0pnCsBtwz+6VGdhMAu9hoCokpS6QoqfV9ATlACc9Y2IlZ7VyxnmXGqjeODiTcCoENbdSiqLN57Fi8qTKqNem1ubur88875wXd838XPPK/IBo1aI6GdGbw9zIJURFhUxTN7ltJ7X/qyLEE1ywt06dz0LAKo8uLC9OzCLnQ170tEcgSiDNa1KWCQeoZKLxwlQq3J1mAwkAhEW7EyEowAHiP1CsiEVsr6KJGVWI8GKLoiW0Vb3PhxIHJrIO7/RAomDnGHwWj8EwmNoTOPARp1K9Gsa+TshVZCj4YiAApCGGcxodG3pQHB9z2ulBVbVs3MyuxVVRkR6o3G7HRrcX569/Ly7qWl3Qtzy8uLu5bm9+5ZmG42UDVN0oRoh2Lj4eIcqqpsI1ZhFs/svfcli+S+zDvtp59/bj0h71k0YdYkASBSUdZIZdJKfhwIHVFhQKqa1tLmRLPX7aMLd5Q5OCYJK1AYmcfMywGLJqlAcAxbB6ytJI2KVbMnk7BnAc2QTqJaWapAqEbq4VyKM45wdMU+OfJ+KqcdDcunhIyCjpUDNWgFgNr0z7QZFVCCSGirqUVFxYvn0gsTgXNucqI5PzO/MDe1vLSwZ/fynl1LiwtzczNTk5MTCbnEYeKcs2U24MiliEQE5AgeewdjWw19P7MSsI2bvX7/9L27vu81l3zsk19gwX5eTs3OtFqTSeLUiwiQ3TgkiWRyrIpSJCscJiYmu70+SHRTkur1dAwWjd5QARDDwIlS0mrkLRCd5C1C1EyTAzRpMTLm/jci/0etSrz11RuFSMmrwFR76Mf3UcKod4qE9TB5QbFtc1HThiriWbyIZ0YA52iiXp+dm5qbm1lYnFlanFteWlhamJ+bnW5NNutpmqRJLXEO0TlKXJIkSb2WpmmSuASdS9NaLU2ShJwj59z3wN46VE22dAvFOVKhxDkVFcRaLRkMsh/8gbcsLS5//ktfO7K+OSiLbrc9NdmabrWSxPmw3LXy6lGMwmZEm5dxreZqtdowyxxRdFyT2LiYO9ZIQhJBFKxkSjD2SAZn7HCKVSwh5NDpjDG7K9UDRhFqAFzHRstWI2M1TNdqD22cNpuisxpIEoZME16GxYctQqLOuXqazLYmZudmFhfnl5dml5eW9iwtzs1MNZuNZj1JkrD93FGSpkmSJIlztbSWJo7IJUliQZA4R4SUJIlzSeKQyBEh7Uxw4MNqiLfbneEgV1UWKb0XZi7tXPFFUealz/MiK/Jarbmx0f7KZVd++etXrBxdq9Vqk83GVKvVak1Z9RFmWVJhk0rWc4pHgm4/P7q2ljgCkFqtPtmazYd9LotQEIw8W0K7RxGTHq3NCBAF2kTNHvZQgkTZOyFW7rE4XtLocfkicn1GCsQREQ9H9az59IffY/O38+yFbd16ktLkZG12enp5YWF5cWHX0tLS4vz83ExraqJRryWJc0SE4IiIXOrQOSTn6vVaQs4RJUniksQBkSOLCEfOOSDnnHOESI6IiFyCAERYq6VmgfHYBUen0x1mudlslZ5L78WzMOdl4b1nz3lZ5r7MhjkIANB9KyuXfv2qb15xzVanm9bqU1OTM9PTkxOTRI6Zg3gkeFprKD9BldzBg4fKskTEWq02NT2TZ33OCySn44tXKlxa4bh7Vq3rsNvLtr0gLHWuVM6jAZulEGeSmrjJnDUaq4zNX8ICvjgEwaCkARFhsc7eq2KauFq9NtWanJ5uLi8s7FleWlxeWFyYn5manJxo1tKEAJPEOUJCIMLEJWmSpKlzSZIQucShc4SUJM45QiBKXOIoRSJCcs5ZKBChhQWSEhKhM2gP0SUJ4mMbHL3eIMtzVWHWkoU9s/di6aP0LFyy98xFXuZZOcyGngsFOnx4/VvX3vSta29eWdtoNOqTE5Mz09OtyRYSeu8DET9yJlQlqaUb29vrR1cTckmtPjnVKrLMF3ms8yPoXi2kr2DIis1eifyx2ho6Wm4SBfsVNwcqfyWbgEYcbIRKkG2jxurnhFk9C/tSWIgoTZPWZHN6qrW4OLdreXH38sLiwuz87PREs9Go19MkcY4AEwyh4FJHiSOXEIVEQM65NCGixHKCI7K4QCIiR0hE6AiJMP4XIpFVxYQECEhASEZbIaJHP7R/eMExGAyLvATQ0nMpoqzeM7MX9uK5tGhhLsqSS1+UZZ7nWTZUBedqq5vdr33z6suvvP7o5latXpuenJqdmW5ONBC0KEpQRXRhAkOJABy4b5+yT9L65NRMPhz6MidyYekORthhdK+NekMS5ehRnh35xmNO64pjzith2ipjSxfDXx+YPogq1lR6YQFVIEqJGo3a9PT0wtzcwsLcnqWFpcWF+bnZ1kSj2azXanYAoMPwfCep1Qx2V8NRQEhkRYJzFMpMsjzgyDkCQocEaIFASGgb00MAmBodbMw04orERwbhsQ6OLCuK0tvCRS/KbOi5NbReVNl79lywF+89c176siy891mWs4CjZHVt++tX3nDZVdeubWw2m83JiWar0ZyYbCKhciVOxyRJV1ePbm1s1muNyenZPBv4IkPnpJpM4LE+2QGyxjE1G1Rla6WuGxk0VJ5/geQXYg0DUC7C4iWsQ3fO1erJzNTE/NzcrqWF5aXFpYW5+fnZqalWqzlRqyVplGYTUpJYWZCmiUuTFAkTR4lVEIghOtCBQyRKnN1355xFBRDFrICWGgAIye45hbdof0BV6hzxVkfqqZ0hjT+s4CiKwpemRxGJYxUWKVmYhdmriPhQq3r2BXthLksuy3KYl3mWG0f/0MrGZVdd/81rrt/Y7NRTN9WampmempyYAJvpIyJilg8P7N/v0npratYXWVnkRCR07EeP+76rLKLjk/1RBTlaA4TVPloarbiwPCgsIpKmlKRoHdbs7PTy8uKuXYsLczMzM1PTk5ONWq2Wps6RIyJHRJg4SpMECcmhQ2siyDmyf8gljtCRI8KE7JdA6CB8PyECOazyAcWTIgTHiJMeqIEROscTkaY+psHhvZntEAsLqwKrxvmKwfyiLOKZlVlYyrJglpK5KEvvpSy5yPPhsMvMQMnh1a0rrrrxsiuu2dxuN+r1qVZramZ6ojmBgN6XgLSycniYla2ZOZ9nZZGRM++XsI2XzIEDxi1v4BgbwYiGH8uhEmH1pX0SRcTUuanWxMzU5Pzc7OLi/J7dC/NzM/MzU63JyXq95pLQLloJmDpK05pzzjmXBASKHDlERKLUOSRyjhIrDQiqCsESBlaVAqFzVi8AhWgIMRGa4NgFV8ztKix2fEXozgSHKKsoGz90hE4JsxdVZhEWr+o9a5gJsXgpfVkye+9L773novB5PrBaBDA5tLJ+2beuu+Lq6ze2Oo2J5vT09OzkVK1eI3Kdfv/okaNTM3NlPizzIVCYP3F8gqKsI1Snpjqi6OJSGUCJKLMX8QKQJjTRqE+3JmdmZhYX5ncvLy4tzi8tzE9NTtbrSb3mEssKhGSYlXOJSyiEgnNEVf1olaKzo8ElVg2GqoIIiByiC8nA/iucGrZjnYDQVgIQKBAFZyKCOJysDojHJhQebXBExow505v/BgYdjzGrwjBOJcYGWwoxPMSz91x4X+RFURaF98OsYGbn3JHD61+74rorrr1xc3t7YmKq1WrNTs9MTE4dPnzAi0qZ+yJDwkpzguPkrQDNB5dFFmHPXlWFnaNGPW1NNGdnppeX5nbtXty1tLQ4Pzcz1Wo2G2nqUpc6IkS1A8KOA4OciJxzSESJc4hEjgxyIEOaXGgfMEkQMSECQAuLUL4gOrJjAdDajrAKhKL3gN1zilUxjVEPK7HS9yYsHmFwjOCEys5CxDKKCrLYnJ1DPmFvY5GSmdmziGef50XhS/bsvc+95nlZ5ANlZob7Dq1/41tXX339t7d7g8lWa3ZmTsT3en1fZsqFc84UPkbVsYqDmdl7z6zCAJQ615ioz0y1pqenl5dm9to0YmZqutVqNuq1eppQQqh254jAuSRNnEucSxNHlBIBhqzgEpfE7BCefbv3FQ5JlMQtIESgiITokAIrH5EgJIaRu2rcHPI9zAcnKziOhdKreYQAgjAHVo6gTW6FvUg4a+zLAqTgovTsS+/ZW1tTlD7Ls3w4NFr+6vr2N6686etXXrvZ7jXqTSL1ZYGk6AhFfMnsmVkANE2TiWZzqjU5Oz21uDC7a2lpYWFuYWFmbqbVqKf1ugGPLjzxRJS4JHEJOUsDdgY458i5hEL5qGjfSESUoiUHm5nHW27wNCC5+FuhsUSHFD3LqaKPEpKOMsWpHhA7ExzHRknl6K2sbH43IiwcbHtDgLB4lsJ7YbFbLF68L8uyLOx/yjzPc1RASvYfXv3GFdd/44rrVtZWnUsowcS5NKWZydbszMz83OyeXcu7di0sLszPTk1ONhu1WuoSQgAMYBEkzqVJYnkgTdLEkaHPgEgOE0pClUhkwWMBBAR2Xlj1iM4hQPivyO9D0qrbjDTPCJ1jlFhB5en0PT4dvpfBEQULEWJWLyaZF88qoKSKts0vzPl97IGZvWHwIkVR5EXJzGVZFmU5zHPjiB44vH7DTd/e2u7Wm/W52dby8vz83OzkxEQtTWppYhCiQ3QElhqco8Q5lzpCsiqSqjYyIM9IGOLCeokEDY1CGsObMPw6EBADBIkY8cfKv79KBhXNGY4F507618lrXlB3esf1mKAUFDhsyrEiVkBZWUMWUeGytIKVPXNZluzFsy99WXgu8iLPc1ElTGyxiSqbQsERxq4hBoFDjCiz/SuJUIOz+YOdDi60EQSIscM0CSKGVgMqUNqEAmGAAiEnxWjAx2cu+N4FRyWAe6BwYfPQYQ5uI2JNMQuHyaWK1RPi7egpfcksHPOMGdyERzsACQFGRqsY48DSvsvudBL6SEcE9geOMCLSVd1o6nkX1c5ovUPohcbwhocFOh23LODxlTNOVuY4/n1XtImwPVVFOGxxFGFz/xEWURZmAeuAWaFkAfbh281PRwVi0idyEEaaFdpsVQOEOSVCwBgxVgcIVThU54LNJiAcIFUfcezU/jE5IsaUo/iwvvlUP1bGc8YDvtGqtbHuxpZCapBIgSoIC6vx2C1kbANcaHN0jEbqkKI40TIEVPcbKQRHvPdQRYWx8aoqwUDK+08j4mwHH/ED+nATRvWXf9dXuX9AjP/7VA+OE7+O91/xpGMqs9EvVeFBrEjG0MNRFTjyajimP8CKsx63FD6OS4bH4LQ66cfKE1//CL7+f0knrm/ke4SFAAAAAElFTkSuQmCC', 'base64');
route('GET', /^\/(favicon\.ico|apple-touch-icon\.png)$/, (req, res, m) => {
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
  res.end(m[1] === 'favicon.ico' ? ICON_SMALL : ICON_LARGE);
});
const DEFAULT_IMG = Buffer.from('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', 'base64');
route('GET', /^\/default-product\.jpg$/, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
  res.end(DEFAULT_IMG);
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
<div class="card"><b>🔔 디스코드 알림</b> <span class="sub">(${hooks.length}/${MAX_HOOKS}개)</span><p class="sub">새 주문·입금·후기 알림을 받을 디스코드 웹훅 주소예요. 최대 ${MAX_HOOKS}개까지 등록할 수 있고, 웹훅마다 받을 알림 종류를 따로 고를 수 있어요.</p>
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
<h2>매출 ${won(total)} · 판매 ${orders.reduce((a, o) => a + orderQty(o), 0)}건</h2>
<h2>아이템 추가</h2>
<form class="card" method="post" action="/m/${shop.key}/items">
<input name="title" placeholder="제목" required maxlength="80">
<input name="price" type="number" min="100" step="100" placeholder="가격 (원)" required>
<textarea name="preview" placeholder="미리보기 (결제 전 공개되는 설명)" required></textarea>
<textarea name="secret" placeholder="잠금 정보 (결제 후에만 공개: 내용, 링크 등). 재고를 쓰면 비워도 돼요"></textarea>
<textarea name="stock" placeholder="재고 (선택). 한 줄에 하나씩 적으면 구매할 때마다 한 줄씩 순서대로 지급돼요. 예) 치킨버거 ⏎ 불고기버거. 비우면 재고 제한 없이 같은 잠금 정보를 보여줘요"></textarea>
${imgField('')}
${titleSelect(titles, '')}
<label style="display:flex;gap:8px;align-items:center;margin:0 0 10px"><input type="checkbox" name="pub" checked style="width:auto;margin:0"> 상점 목록에 공개 (끄면 링크로만 열려요)</label>
<button>등록</button></form>
<h2>내 아이템</h2>
${items.map((i) => `<div class="card">${i.image ? `<img src="/img/${i.id}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:12px;float:right;margin-left:10px">` : ''}<b>${esc(i.title)}</b> <span class="price">${won(i.price)}</span> <span class="sub">· ${i.pub ? '공개' : '비공개(링크로만)'}${i.stock != null ? ` · 재고 ${stockLines(i.stock).length}개` : ''}</span><br><a href="/i/${i.id}">${BASE}/i/${i.id}</a><br><a href="/m/${shop.key}/items/${i.id}/edit">✏️ 수정·삭제</a></div>`).join('') || '<p class="sub">아직 없어요</p>'}`));
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
  const img = cleanImage(f.image); if (img) item.image = img;
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
${imgField(item.image ? item.id : '')}
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
  const img = cleanImage(f.image);
  if (img) upd.image = img; else if (f.del_image === 'on' && item.image) upd.image = null;
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

// 이 상점 포인트로 구매 (재고형 아이템은 qty개를 한 번에)
route('POST', /^\/i\/([\w-]+)\/buy$/, async (req, res, m) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/i/' + m[1]));
  const item = await store.itemById(m[1]);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  const shopB = await store.shopById(item.shop);
  if (!shopB || shopB.deleted) return notFound(res, '아이템을 찾을 수 없어요');
  const f = await readForm(req);
  const multi = item.stock != null;
  let qty = multi ? parseInt(f.qty, 10) : 1;
  if (!(qty >= 1)) qty = 1;
  if (qty > MAX_QTY) return send(res, 400, page('수량 초과', `<h1>한 번에 최대 ${MAX_QTY}개까지 살 수 있어요</h1><p><a href="/i/${item.id}">돌아가기</a></p>`));
  const unit = Number(item.price);
  const total = unit * qty;
  const soldOut = () => send(res, 400, page('품절', `<h1>품절이에요</h1><p><a href="/i/${item.id}">돌아가기</a></p>`));
  let lines = null;
  let soldLast = false; // 이번 구매로 재고가 0이 됐는지
  if (multi) {
    lines = await store.popStockN(item.id, qty);
    if (lines == null) {
      const now = await store.itemById(item.id);
      const left = now && now.stock != null ? stockLines(now.stock).length : 0;
      if (!left) return soldOut();
      return send(res, 400, page('재고 부족', `<h1>재고가 ${left}개만 남았어요</h1><p class="sub">${qty}개는 살 수 없어요. 수량을 줄여서 다시 시도해 주세요.</p><p><a href="/i/${item.id}">돌아가기</a></p>`));
    }
    const after = await store.itemById(item.id);
    soldLast = !!after && !stockLines(after.stock).length;
  }
  const bal = await store.addShopPoints(u.id, item.shop, -total);
  if (bal == null) {
    if (lines) await restoreLines(item.id, lines);
    return send(res, 400, page('포인트 부족', `<h1>이 상점 포인트가 부족해요</h1><p class="sub">${qty > 1 ? `${qty}개 ` : ''}${pts(total)}가 필요해요.</p><p><a href="/w/${item.shop}">충전하러 가기</a></p>`));
  }
  const order = { token: rid(16), item: item.id, price: total, paidAt: Date.now(), buyer: u.id, ...(lines ? { delivered: lines.join('\n') } : {}) };
  try { await store.createOrder(order); }
  catch (e) { await store.addShopPoints(u.id, item.shop, total); if (lines) await restoreLines(item.id, lines); throw e; }
  try { await store.addLedger({ id: rid(9), user_id: u.id, shop: item.shop, delta: -total, kind: 'buy', ref: order.token, note: qty > 1 ? `${item.title} × ${qty}` : item.title, created: Date.now() }); } catch (e) { console.error('ledger', e.message); }
  if (item.title_id) { const t = await store.titleById(item.title_id); if (t) await store.grantTitle(u.id, t.id, item.shop); }
  const shopN = await store.shopById(item.shop);
  await notify(shopN, `💰 새 주문! ${item.title}${qty > 1 ? ` × ${qty}` : ''} (${won(total)})`, 'sale');
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
${sh.deleted ? `<form method="post" action="/admin/shops/${sh.id}/restore"><button style="background:#0f766e">복구</button></form><form method="post" action="/admin/shops/${sh.id}/purge" onsubmit="return confirm('${esc(sh.name).replace(/&#39;/g, '')} 상점을 영구 삭제할까요?\\n아이템·주문·후기·충전·포인트 기록이 모두 지워지고, 구매자도 구매한 내용을 다시 볼 수 없어요. 절대 되돌릴 수 없어요.')"><button style="background:#7f1d1d;margin-top:6px">영구 삭제</button></form>` : `<form method="post" action="/admin/shops/${sh.id}/delete" onsubmit="return confirm('이 상점을 삭제할까요? 사이트에서 사라지고 새 구매·충전이 막혀요. (복구할 수 있어요)')"><button style="background:#dc2626">상점 삭제</button></form>`}</div>`).join('') || `<p class="sub">${sq ? '검색 결과가 없어요' : '상점이 없어요'}</p>`}
<h2>👥 사용자</h2>
<form method="get" action="/admin"><input type="hidden" name="sq" value="${esc(sq)}"><input name="q" placeholder="이메일 검색" value="${esc(search)}"><button>검색</button></form>
${users.map((x) => `<div class="card"><b>${esc(x.email)}</b>${x.banned ? ' 🚫 정지' : ''}${isAdmin(x) ? ' 👑' : ''}<br><span class="sub">회원번호 ${esc(x.id.slice(0, 8))}</span>
${isAdmin(x) ? '' : `<form method="post" action="/admin/users/${x.id}/limit" style="margin-top:8px"><span class="sub">🏪 상점 한도 (현재 ${shops.filter((sh) => sh.owner === x.id && !sh.deleted).length}개 만듦)</span><input name="n" type="number" min="0" max="100" value="${shopLimit(x)}" required><button>한도 저장</button></form><form method="post" action="/admin/users/${x.id}/ban"><input type="hidden" name="v" value="${x.banned ? 0 : 1}"><button style="background:${x.banned ? '#0f766e' : '#dc2626'}">${x.banned ? '정지 해제' : '계정 정지'}</button></form><form method="post" action="/admin/users/${x.id}/delete" onsubmit="return confirm('${esc(x.email)} 회원을 탈퇴시킬까요?\\n포인트·칭호가 지워지고, 이 회원의 상점은 삭제 처리돼요. 되돌릴 수 없어요.')"><button style="background:#7f1d1d;margin-top:6px">회원 탈퇴시키기</button></form>`}</div>`).join('') || '<p class="sub">사용자가 없어요</p>'}`));
});

route('POST', /^\/admin\/shops\/([\w-]+)\/(delete|restore)$/, async (req, res, m) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const sh = await store.shopById(m[1]);
  if (!sh) return redirect(res, `/admin?e=${enc('상점을 찾을 수 없어요')}`);
  await store.updateShop(sh.id, { deleted: m[2] === 'delete' });
  redirect(res, `/admin?m=${enc(m[2] === 'delete' ? '상점을 삭제했어요' : '상점을 복구했어요')}`);
});

// 상점 영구 삭제: 먼저 '상점 삭제'(휴지통)한 상점만 가능 — 실수 방지용 2단계
route('POST', /^\/admin\/shops\/([\w-]+)\/purge$/, async (req, res, m) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const done = (k, t) => redirect(res, `/admin?${k}=${enc(t)}`);
  const sh = await store.shopById(m[1]);
  if (!sh) return done('e', '상점을 찾을 수 없어요');
  if (!sh.deleted) return done('e', '먼저 "상점 삭제"를 한 뒤에 영구 삭제할 수 있어요');
  try {
    await store.purgeShop(sh.id);
    done('m', `${sh.name} 상점을 영구 삭제했어요`);
  } catch (e) { console.error('상점 영구 삭제 실패', e); done('e', '영구 삭제 중 문제가 생겼어요. 잠시 뒤 다시 해주세요'); }
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

route('POST', /^\/admin\/users\/([\w-]+)\/delete$/, async (req, res, m) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const done = (k, t) => redirect(res, `/admin?${k}=${enc(t)}`);
  const target = await store.userById(m[1]);
  if (!target) return done('e', '사용자를 찾을 수 없어요');
  if (isAdmin(target)) return done('e', '운영자 계정은 탈퇴시킬 수 없어요');
  try {
    // 이 회원의 상점은 삭제 처리하고 주인 연결을 끊어요 (관리자 화면에서 복구는 가능)
    const mine = await store.shopsByOwner(target.id);
    for (const sh of mine) await store.updateShop(sh.id, { deleted: true, owner: null });
    await store.deleteUser(target.id);
    done('m', `${target.email} 회원을 탈퇴시켰어요${mine.length ? ` (상점 ${mine.length}개는 삭제 처리했어요)` : ''}`);
  } catch (e) { console.error('회원 탈퇴 실패', e); done('e', '탈퇴 처리 중 문제가 생겼어요. 잠시 뒤 다시 해주세요'); }
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

route('GET', /^\/img\/([\w-]+)$/, async (req, res, m) => {
  const item = await store.itemById(m[1]);
  const mm = item && typeof item.image === 'string' && item.image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!mm) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': mm[1], 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
  res.end(Buffer.from(mm[2], 'base64'));
});

route('GET', /^\/s\/([\w-]+)$/, async (req, res, m) => {
  const shop = await store.shopById(m[1]);
  if (!shop || shop.deleted) return notFound(res, '상점을 찾을 수 없어요');
  const items = (await store.itemsByShop(shop.id)).filter((i) => i.pub);
  const me = await currentUser(req);
  const bal = me ? await store.shopPoints(me.id, shop.id) : 0;
  const rmap = new Map();
  for (const r of await store.reviewsByShop(shop.id)) { const a = rmap.get(r.item) || { n: 0, sum: 0 }; a.n += 1; a.sum += r.rating; rmap.set(r.item, a); }
  const card = (i) => {
    const rv = rmap.get(i.id);
    const left = i.stock != null ? stockLines(i.stock).length : null;
    const stockTxt = left == null ? '무제한' : left ? `${left}개` : '품절';
    return `<a class="pc${left === 0 ? ' off' : ''}" href="/i/${i.id}"><div class="im"><img src="${i.image ? `/img/${i.id}` : `/default-product.jpg?v=${ICON_VER}`}" alt="" loading="lazy"></div><div class="pb"><h2>${esc(i.title)}</h2>
<div class="rt">${ICO.star}<span>${rv ? (rv.sum / rv.n).toFixed(1) : '-'}</span>${rv ? `<span class="sm">(${rv.n})</span>` : ''}</div>
<div class="pr"><b>${won(i.price)}</b><span>재고: <b>${stockTxt}</b></span></div></div></a>`;
  };
  send(res, 200, shopPage(shop, shop.name, (items.length ? `<div class="pg">${items.map(card).join('')}</div>` : '<p class="sm">등록된 아이템이 없어요</p>'), me, bal, '/s/' + shop.id, 'items'));
});

route('GET', /^\/i\/([\w-]+)$/, async (req, res, m) => {
  const item = await store.itemById(m[1]);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  const shop = await store.shopById(item.shop);
  if (!shop || shop.deleted) return notFound(res, '아이템을 찾을 수 없어요');
  const sold = (await store.ordersForItems([item.id])).reduce((a, o) => a + orderQty(o), 0);
  const me = await currentUser(req);
  const bal = me ? await store.shopPoints(me.id, shop.id) : 0;
  const reviews = await store.reviewsForItem(item.id);
  const canMod = !!me && (me.id === shop.owner || isAdmin(me));
  const avg = reviews.length ? reviews.reduce((a, r) => a + r.rating, 0) / reviews.length : 0;
  const left = item.stock != null ? stockLines(item.stock).length : null;
  const stockTxt = left == null ? '무제한' : left ? `${left}개` : '품절';
  const body = `<a class="sm" style="text-decoration:none" href="/s/${shop.id}">← ${esc(shop.name)}</a>
<div class="pc" style="margin-top:12px"><div class="im" style="aspect-ratio:4/3"><img src="${item.image ? `/img/${item.id}` : `/default-product.jpg?v=${ICON_VER}`}" alt=""></div><div class="pb"><h2>${esc(item.title)}</h2>
<div class="rt">${ICO.star}<span>${reviews.length ? avg.toFixed(1) : '-'}</span>${reviews.length ? `<span class="sm">(${reviews.length})</span>` : ''}<span class="sm" style="margin-left:auto">판매 ${sold}건</span></div>
<div class="pr"><b>${won(item.price)}</b><span>재고: <b>${stockTxt}</b></span></div></div></div>
${item.preview ? `<div class="bx" style="white-space:pre-wrap">${esc(item.preview)}</div>` : ''}
${left === 0 ? '<div class="nt">😢 품절이에요</div>' : pointsBlock(item, me, bal, shop)}
<h3 style="font-size:20px;margin:30px 0 10px">⭐ 후기 ${reviews.length ? `${avg.toFixed(1)} (${reviews.length})` : ''}</h3>
${reviews.map((r) => `<div class="bx">${stars(r.rating)} <span class="sm">구매자 ${esc(r.user_id.slice(0, 4))} · ${new Date(Number(r.created)).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}</span><br><span style="white-space:pre-wrap">${esc(r.body)}</span>${canMod ? `<form method="post" action="/i/${item.id}/reviews/${r.id}/delete" onsubmit="return confirm('이 후기를 삭제할까요?')"><button class="bb" style="background:#dc2626;margin-top:10px;padding:12px;font-size:15px">후기 삭제</button></form>` : ''}</div>`).join('') || '<p class="sm">아직 후기가 없어요. 구매한 사람이 남길 수 있어요.</p>'}`;
  send(res, 200, shopPage(shop, item.title, body, me, bal, '/i/' + item.id, 'items'));
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
${order.delivered ? `<p class="sub">지급된 상품${orderQty(order) > 1 ? ` (${orderQty(order)}개)` : ''}</p><div class="secret">${esc(order.delivered)}</div>` : (item.stock != null && order.delivered === '' ? '<div class="warn">재고가 부족해서 아직 지급되지 않았어요. 판매자가 직접 보내드려요. 판매자에게 문의해 주세요.</div>' : '')}
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
  // 상점 주인에게 후기 알림 (기다리지 않고 보냄 — 디스코드가 느려도 후기 저장은 바로 끝남)
  store.shopById(item.shop).then((sh) => notify(sh, `⭐ ${old ? '후기 수정' : '새 후기'}! ${item.title} · ${stars(rating)} (${rating}점)${body ? '\n' + body.slice(0, 200).split('\n').map((x) => '> ' + x).join('\n') : ''}\n${BASE}/i/${item.id}`, 'review')).catch((e) => console.error('후기 알림 실패', e.message));
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
