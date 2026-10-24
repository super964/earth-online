/* EarthOnline — UI 与数据装配 */
"use strict";

const $ = (s) => document.querySelector(s);

const LAYERS = [
  { id: "quakes",     api: "earthquakes", name: "地震",       hint: "USGS · M2.5+ 近一周", color: "#ff4d6d", icon: "◉" },
  { id: "volcanoes",  api: "volcanoes",   name: "活火山",     hint: "GVP · 全新世火山",    color: "#ff6b35", icon: "▲" },
  { id: "wildfires",  api: "wildfires",   name: "野火",       hint: "NASA EONET",         color: "#ff9f1c", icon: "✦" },
  { id: "typhoons",   api: "typhoons",    name: "台风路径",   hint: "日本气象厅 JMA",      color: "#ff5b7f", icon: "🌀" },
  { id: "hurricanes", api: "hurricanes",  name: "飓风预报",   hint: "美国 NHC · 5天锥",    color: "#ffb703", icon: "🌀" },
  { id: "alerts",     api: "alerts",      name: "天气警报",   hint: "NWS · 严重/极端",     color: "#ff2d55", icon: "⚠" },
  { id: "aurora",     api: "aurora",      name: "极光",       hint: "NOAA Kp 指数",        color: "#39ff88", icon: "☾" },
  { id: "iss",        api: "iss",         name: "国际空间站", hint: "实时轨道",            color: "#8fe9ff", icon: "▴" },
  { id: "borders",    api: "countries",   name: "国界",       hint: "地理轮廓",            color: "#4ad9ff", icon: "◇" },
  { id: "clouds",     api: null,          name: "云层",       hint: "全球云量",            color: "#cfe8ff", icon: "☁" },
];

const state = {
  counts: {}, visible: {}, data: {},
  feedFilter: "all", searchTimer: null,
};

const EVENTS_ICONS = { quakes: "◉", wildfires: "✦", alerts: "⚠", typhoons: "🌀", hurricanes: "🌀" };

// ---------------------------------------------------------------- 工具
async function apiGet(name, query = "") {
  const res = await fetch(`/api/${name}${query}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function fmtAgo(ts) {
  if (!ts) return "";
  let d = typeof ts === "number" ? Date.now() - ts : Date.now() - Date.parse(ts);
  if (d < 0) d = 0;
  const m = Math.floor(d / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function fmtCoord(lat, lon) {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
}

// ---------------------------------------------------------------- 图层 UI
function buildLayerList() {
  const box = $("#layer-list");
  box.innerHTML = "";
  for (const L of LAYERS) {
    state.visible[L.id] = true;
    const row = document.createElement("div");
    row.className = "layer-row";
    row.dataset.id = L.id;
    row.innerHTML = `
      <span class="swatch" style="background:${L.color};color:${L.color}"></span>
      <span class="name">${L.icon} ${L.name}
        <span class="hint">${L.hint}</span>
      </span>
      <span class="count" id="cnt-${L.id}">--</span>`;
    row.addEventListener("click", () => {
      state.visible[L.id] = !state.visible[L.id];
      row.classList.toggle("off", !state.visible[L.id]);
      applyVisibility(L.id);
    });
    box.appendChild(row);
  }
}

function applyVisibility(id) {
  const v = state.visible[id];
  if (id === "clouds") { Globe.setCloudsVisible(v); return; }
  Globe.setVisible(id, v);
}

function setCount(id, n) {
  state.counts[id] = n;
  const el = document.getElementById(`cnt-${id}`);
  if (el) el.textContent = n == null ? "--" : n;
  updateEventTotal();
}

function updateEventTotal() {
  const t = ["quakes", "wildfires", "alerts", "typhoons", "hurricanes"]
    .reduce((s, k) => s + (state.counts[k] || 0), 0);
  $("#event-total").textContent = `事件 ${t}`;
}

// ---------------------------------------------------------------- 数据装载
const loadSteps = [];
let stepsDone = 0;
function step(tip) {
  stepsDone++;
  const pct = Math.min(100, Math.round((stepsDone / loadSteps.length) * 100));
  $("#loader-fill").style.width = pct + "%";
  $("#loader-tip").textContent = tip;
}

async function loadData(name) {
  try {
    const j = await apiGet(name);
    return j;
  } catch (e) {
    console.warn(`load ${name} failed`, e);
    return { mode: "error", data: null, error: String(e) };
  }
}



// 事件流
function rebuildFeed() {
  const feed = $("#feed");
  const items = [];
  const push = (kind, icon, t1, t2, ref, sev) =>
    items.push({ kind, icon, t1, t2, ref, sev });

  const quakes = state.data.earthquakes || [];
  for (const q of quakes.slice(0, 40)) {
    push("quakes", "◉", `M ${q.mag?.toFixed(1)} — ${q.place || "未知区域"}`,
      `${fmtAgo(q.time)} · 深度 ${(q.depth || 0).toFixed(0)} km`, q);
  }
  const alerts = state.data.alerts || [];
  for (const a of alerts.slice(0, 30)) {
    push("alerts", "⚠", `${a.event} — ${(a.area || "").slice(0, 60)}`,
      `${fmtAgo(a.sent)} · ${a.severity}`, a, a.severity === "Extreme" ? "extreme" : "severe");
  }
  const fires = state.data.wildfires || [];
  for (const f of fires.slice(0, 25)) {
    push("wildfires", "✦", f.title, `${fmtAgo(f.date)} · ${f.category}`, f);
  }
  const tcs = [...(state.data.typhoons || []), ...(state.data.hurricanes || [])];
  for (const tc of tcs) {
    const cur = tc.current || (tc.forecast || [])[0];
    push(tc.id?.startsWith?.("TC") ? "typhoons" : "hurricanes", "🌀",
      `热带系统:${tc.name || tc.id || "?"}`,
      `${tc.category || ""} · ${cur ? fmtCoord(cur.lat, cur.lon) : ""}`, tc);
  }

  const filtered = state.feedFilter === "all"
    ? items
    : items.filter((i) => i.kind === state.feedFilter);

  feed.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const it of filtered) {
    const row = document.createElement("div");
    row.className = "feed-item" + (it.sev ? ` sev-${it.sev}` : "");
    row.innerHTML = `<span class="icon">${it.icon}</span>
      <span class="body"><div class="t1"></div><div class="t2"></div></span>`;
    row.querySelector(".t1").textContent = it.t1;
    row.querySelector(".t2").textContent = it.t2;
    row.addEventListener("click", () => selectFromFeed(it));
    frag.appendChild(row);
  }
  feed.appendChild(frag);
}

function selectFromFeed(it) {
  showDetail(it.kind, it.ref);
  const lat = it.ref.lat ?? it.ref.latitude;
  const lon = it.ref.lon ?? it.ref.longitude;
  const cur = it.ref.current || (it.ref.forecast || [])[0];
  const flat = lat ?? cur?.lat;
  const flon = lon ?? cur?.lon;
  if (flat != null && flon != null) Globe.focus(flat, flon, 260);
}

// ---------------------------------------------------------------- 详情面板
function showDetail(kind, d) {
  const box = $("#detail-body");
  const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${v ?? "--"}</b></div>`;
  let html = "";
  if (kind === "quakes") {
    html = `<h3>M ${d.mag?.toFixed(1)} ${d.place || ""}</h3>` +
      kv("发震时刻", new Date(d.time).toLocaleString("zh-CN")) +
      kv("震级", d.mag) + kv("深度", `${(d.depth || 0).toFixed(1)} km`) +
      kv("坐标", fmtCoord(d.lat, d.lon)) +
      kv("海啸预警", d.tsunami ? "是" : "否") +
      (d.alert ? kv("机构警报级别", d.alert) : "") +
      (d.url ? `<p><a href="#" data-url="${d.url}">在浏览器中查看 USGS 详情 →</a></p>` : "");
  } else if (kind === "volcanoes") {
    const st = d.status;
    html = `<h3>▲ ${d.name || "火山"}</h3>` +
      kv("国家/地区", d.country) + kv("类型", d.type) +
      kv("海拔", d.elev != null && d.elev !== 0 ? `${d.elev} m` : "--") +
      kv("最近喷发", st > 0 ? `${st} 年`
        : st < 0 ? `约公元前 ${Math.abs(st)} 年` : "全新世(时间不详)") +
      kv("坐标", fmtCoord(d.lat, d.lon));
  } else if (kind === "wildfires") {
    html = `<h3>✦ ${d.title}</h3>` +
      kv("类别", d.category) + kv("发生时间", d.date ? new Date(d.date).toLocaleString("zh-CN") : "--") +
      kv("坐标", fmtCoord(d.lat, d.lon));
  } else if (kind === "alerts") {
    html = `<h3>⚠ ${d.event}</h3>` +
      kv("严重程度", d.severity) + kv("紧急程度", d.urgency) +
      kv("区域", d.area) + kv("发布", d.sender) +
      kv("发布时间", d.sent ? new Date(d.sent).toLocaleString("zh-CN") : "--") +
      kv("失效时间", d.expires ? new Date(d.expires).toLocaleString("zh-CN") : "--") +
      (d.headline ? `<p>${d.headline}</p>` : "") +
      (d.instruction ? `<p>防御指南:${d.instruction}</p>` : "");
  } else if (kind === "typhoons") {
    const c = d.current || (d.track || [])[0];
    html = `<h3>🌀 ${d.name}${d.name_jp && d.name_jp !== d.name ? ` (${d.name_jp})` : ""}</h3>` +
      kv("等级", d.category) + kv("中心气压", c?.pressure ? `${c.pressure} hPa` : "--") +
      kv("中心风速", c?.wind_ms ? `${c.wind_ms} m/s` : "--") +
      kv("阵风", c?.gust_ms ? `${c.gust_ms} m/s` : "--") +
      kv("当前位置", c ? fmtCoord(c.lat, c.lon) : "--") +
      kv("预报点数", (d.track || []).length) +
      kv("报文时间", d.issue || "--");
  } else if (kind === "hurricanes") {
    const c = (d.forecast || [])[0];
    html = `<h3>🌀 ${(d.name || "风暴").replace(/^Tropical (Storm|Hurricane) /, "")}</h3>` +
      kv("盆地", d.basin) + kv("当前位置", c ? fmtCoord(c.lat, c.lon) : "--") +
      kv("最大风速", c?.wind_kt ? `${c.wind_kt} kt` : "--") +
      kv("中心气压", c?.pressure ? `${c.pressure} hPa` : "--") +
      kv("预报时效", c?.label || (c?.hours ? `T+${c.hours}h` : "--")) +
      kv("预报点数", (d.forecast || []).length) +
      `<p>5 天预报锥,来源:美国国家飓风中心 (NHC)。</p>`;
  } else if (kind === "iss") {
    html = `<h3>▴ 国际空间站</h3>` +
      kv("纬度", d.latitude?.toFixed(3)) + kv("经度", d.longitude?.toFixed(3)) +
      kv("高度", `${Math.round(d.altitude)} km`) +
      kv("速度", `${Math.round(d.velocity)} km/h`) +
      kv("地面足迹", `${Math.round(d.footprint)} km`) +
      kv("光照状态", d.visibility === "daylight" ? "日照" : "地影");
  } else if (kind === "aurora") {
    const kp = state.data.aurora?.kp;
    html = `<h3>☾ 极光指数</h3>` +
      kv("当前 Kp", kp ?? "--") +
      kv("活跃等级", kp >= 5 ? "地磁暴" : kp >= 4 ? "活跃" : kp >= 3 ? "一般" : "平静") +
      kv("可见纬度", kp >= 5 ? `约 ${Math.round(66.5 - kp * 1.9)}° 以上` : "高纬地区") +
      `<p>数据:NOAA 行星 K 指数,每 3 分钟更新。</p>`;
  }
  box.innerHTML = html;
  $("#detail").hidden = false;
  const a = box.querySelector("a[data-url]");
  if (a) a.addEventListener("click", (e) => {
    e.preventDefault();
    if (window.pywebview?.api?.open_external)
      window.pywebview.api.open_external(a.dataset.url);
    else window.open(a.dataset.url, "_blank");
  });
}

// ---------------------------------------------------------------- 搜索
const CITY_CACHE = {};
async function doSearch(q) {
  const box = $("#search-result");
  if (q.length < 2) { box.innerHTML = ""; return; }
  try {
    let list = CITY_CACHE[q];
    if (!list) {
      const j = await (await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=zh`
      )).json();
      list = j.results || [];
      CITY_CACHE[q] = list;
    }
    box.innerHTML = "";
    for (const r of list) {
      const el = document.createElement("div");
      el.className = "search-item";
      el.innerHTML = `<span>${r.name}${r.country ? ", " + r.country : ""}</span>
        <span class="ll">${r.latitude.toFixed(1)}, ${r.longitude.toFixed(1)}</span>`;
      el.addEventListener("click", () => {
        Globe.focus(r.latitude, r.longitude, 230);
        box.innerHTML = "";
        $("#search-box").value = r.name;
        loadWeather(r.longitude, r.latitude, r.name);
      });
      box.appendChild(el);
    }
    if (!list.length) box.innerHTML = `<div class="search-item">无结果</div>`;
  } catch {
    box.innerHTML = `<div class="search-item">搜索服务不可用</div>`;
  }
}

async function loadWeather(lon, lat, name) {
  try {
    const j = await apiGet("weather", `?lon=${lon}&lat=${lat}`);
    if (j.data) showWeather(name, lon, lat, j.data);
  } catch { /* 忽略 */ }
}

function showWeather(name, lon, lat, w) {
  const box = $("#detail-body");
  const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${v ?? "--"}</b></div>`;
  box.innerHTML = `<h3>📍 ${name || fmtCoord(lat, lon)}</h3>` +
    kv("天气", w.text) + kv("气温", `${w.temp}°C (体感 ${w.feels}°C)`) +
    kv("风速", `${w.wind} km/h`) + kv("风向", w.wind_dir != null ? `${w.wind_dir}°` : "--") +
    kv("湿度", `${w.humidity}%`) + kv("云量", `${w.cloud}%`) +
    kv("坐标", fmtCoord(lat, lon)) +
    `<p>数据:Open-Meteo · ${w.time || ""}</p>`;
  $("#detail").hidden = false;
}

// ---------------------------------------------------------------- 悬浮提示
function ensureTip() {
  if ($("#hover-tip")) return;
  const t = document.createElement("div");
  t.id = "hover-tip";
  document.getElementById("root").appendChild(t);
}

function showTip(hit, e) {
  const t = $("#hover-tip");
  if (!hit) { t.style.display = "none"; return; }
  let text = "";
  const d = hit.item;
  if (hit.kind === "quakes") text = `M ${d.mag?.toFixed(1)} · ${d.place || ""}`;
  else if (hit.kind === "volcanoes") text = `▲ ${d.name || ""}`;
  else if (hit.kind === "wildfires") text = `✦ ${(d.title || "").slice(0, 40)}`;
  else if (hit.kind === "alert") text = `⚠ ${d.event || ""}`;
  else if (hit.kind === "typhoon") text = `🌀 ${d.name || "台风"}`;
  else if (hit.kind === "hurricane") text = `🌀 ${(d.name || "风暴").replace(/^Tropical (Storm|Hurricane) /, "")}`;
  else if (hit.kind === "iss") text = `▴ ISS 高度 ${Math.round(d.altitude)} km`;
  else return showTip(null);
  t.textContent = text;
  t.style.display = "block";
  const root = document.getElementById("root").getBoundingClientRect();
  t.style.left = Math.min(e.clientX - root.left + 16, root.width - 260) + "px";
  t.style.top = (e.clientY - root.top + 14) + "px";
}

// ---------------------------------------------------------------- 时钟
function startClocks() {
  const tickClock = () => {
    const n = new Date();
    const utc = n.toISOString().slice(11, 19);
    $("#utc-clock").textContent = `${utc} UTC`;
    $("#clock-local").textContent = n.toLocaleTimeString("zh-CN", { hour12: false });
  };
  tickClock();
  setInterval(tickClock, 1000);
}

// ---------------------------------------------------------------- 主流程
async function main() {
  ensureTip();
  buildLayerList();
  startClocks();

  // --- 启动场景
  Globe.init($("#globe"));
  // 深链定位:#geo=纬度,经度[,距离] 便于分享/调试定位到指定区域
  const geoHash = location.hash.match(/^#geo=(-?[\d.]+),(-?[\d.]+)(?:,(\d+))?/);
  if (geoHash) Globe.focus(+geoHash[1], +geoHash[2], geoHash[3] ? +geoHash[3] : undefined);

  Globe.on.coords((e) => {
    const ll = screenLatLon(e);
    if (ll) $("#coords").textContent = fmtCoord(ll.lat, ll.lon);
    else $("#coords").textContent = "-- , --";
  });
  Globe.on.select((hit) => { showDetail(hit.kind, hit.item); showTip(null); });
  Globe.on.hover((hit, e) => showTip(hit, e));

  $("#btn-reset").addEventListener("click", () => Globe.resetView());
  $("#btn-about").addEventListener("click", () => ($("#about-mask").hidden = false));
  $("#about-close").addEventListener("click", () => ($("#about-mask").hidden = true));
  $("#about-mask").addEventListener("click", (e) => {
    if (e.target === $("#about-mask")) $("#about-mask").hidden = true;
  });
  $("#detail-close").addEventListener("click", () => ($("#detail").hidden = true));
  $("#feed-filter").addEventListener("click", () => {
    const order = ["all", "quakes", "alerts", "wildfires", "typhoons"];
    const i = (order.indexOf(state.feedFilter) + 1) % order.length;
    state.feedFilter = order[i];
    $("#feed-filter").textContent =
      { all: "全部", quakes: "地震", alerts: "警报", wildfires: "野火", typhoons: "台风" }[state.feedFilter];
    rebuildFeed();
  });
  $("#search-box").addEventListener("input", (e) => {
    clearTimeout(state.searchTimer);
    const v = e.target.value.trim();
    state.searchTimer = setTimeout(() => doSearch(v), 350);
  });

  // --- 并行装载数据
  loadSteps.push("地震", "火山", "野火", "台风", "飓风", "警报", "极光", "ISS", "国界");
  $("#loader-fill").style.width = "8%";

  const tasks = {
    earthquakes: async (j) => { setCount("quakes", Globe.setQuakes(j.data || [])); },
    volcanoes: async (j) => {
      // data/volcanoes.json 为 GeoJSON FeatureCollection,字段 name/country/type/status/elev
      const raw = Array.isArray(j.data) ? j.data
        : (j.data?.features || []).map((f) => ({
            ...f.properties,
            lon: f.geometry?.coordinates?.[0],
            lat: f.geometry?.coordinates?.[1],
          }));
      const list = raw.map((v) => ({
        ...v,
        recent: v.status != null && v.status >= 1900,
      }));
      setCount("volcanoes", Globe.setVolcanoes(list));
    },
    wildfires: async (j) => { setCount("wildfires", Globe.setWildfires(j.data || [])); },
    typhoons: async (j) => { setCount("typhoons", Globe.setTyphoons(j.data || [])); },
    hurricanes: async (j) => { setCount("hurricanes", Globe.setHurricanes(j.data || [])); },
    alerts: async (j) => { setCount("alerts", (j.data || []).length); Globe.setAlerts(j.data || []); },
    aurora: async (j) => {
      state.data.aurora = j.data;
      Globe.setAurora(j.data?.kp || 0);
      const kp = j.data?.kp;
      setCount("aurora", kp != null ? `Kp ${kp.toFixed(1)}` : "Kp --");
      $("#kp-chip").textContent = `Kp ${kp ?? "--"}${kp >= 5 ? " ⚠磁暴" : ""}`;
    },
    iss: async (j) => {
      state.data.iss = j.data;
      const ok = Globe.setIss(j.data);
      const now = j.data?.now;
      setCount("iss", ok ? "在线" : "离线");
      if (ok && now)
        $("#iss-chip").textContent =
          `ISS ${now.latitude.toFixed(1)}°, ${now.longitude.toFixed(1)}° · ${Math.round(now.altitude)} km`;
    },
    countries: async (j) => {
      // /api/countries 直接返回 GeoJSON 本体(无 {data} 包装)
      const geo = j && j.features ? j : j?.data;
      if (geo) Globe.setBorders(geo);
      const n = (geo?.features || geo || []).length;
      setCount("borders", n ? `${n} 国` : "--");
    },
  };

  const keys = Object.keys(tasks);
  await Promise.allSettled(keys.map(async (k) => {
    const j = await loadData(k);
    if (j.data != null) state.data[k] = j.data;
    await tasks[k](j);
    step(`已加载:${k}`);
  }));

  rebuildFeed();
  updateEventTotal();
  setCount("clouds", "全球");

  // 事件源刷新(周期不同)
  const refreshers = [
    { k: "iss", ms: 20000 }, { k: "earthquakes", ms: 120000 },
    { k: "alerts", ms: 180000 }, { k: "aurora", ms: 300000 },
    { k: "wildfires", ms: 600000 }, { k: "typhoons", ms: 600000 },
    { k: "hurricanes", ms: 900000 },
  ];
  for (const r of refreshers) {
    setInterval(async () => {
      try {
        const j = await loadData(r.k);
        if (j.data == null) return;
        state.data[r.k] = j.data;
        await tasks[r.k](j);
        if (r.k !== "iss") rebuildFeed();
        setNet(j.mode);
      } catch { setNet("error"); }
    }, r.ms);
  }

  // 日照状态
  const ss = Globe.subsolar(new Date());
  $("#sun-chip").textContent = `直射点 ${fmtCoord(ss.lat, ss.lon)}`;

  setNet("live");
  setTimeout(() => {
    $("#loader").classList.add("hide");
    setTimeout(() => $("#loader").remove(), 900);
  }, 600);
}

function setNet(mode) {
  const dot = $("#net-dot"), label = $("#net-label");
  if (mode === "live" || mode === "mem") {
    dot.className = "dot live"; label.textContent = "实时连接";
  } else if (mode === "stale") {
    dot.className = "dot warn"; label.textContent = "缓存数据";
  } else {
    dot.className = "dot err"; label.textContent = "离线模式";
  }
}

// 屏幕坐标 -> 经纬度(供 HUD 显示;复用 raycast)
function screenLatLon(e) {
  return Globe._screenLatLon ? Globe._screenLatLon(e.clientX, e.clientY) : null;
}

main();
