// === CONFIG ================================================================
const CONFIG = {
  // ❗ підставте ваш n8n webhook
  WEBHOOK_URL: "https://n8n.vetai.win/webhook/da346a7b-9591-46a4-8bd7-e4b150dea063",

  // Данні для простенької авторизації на клієнті
  AUTH: { username: "data", password: "30102020" },

  // Робочі години (локальний час браузера)
  WORK_HOURS: { start: 8, end: 21 }, // 8:00–21:00

  // Обмеження запитів
  MIN_FETCH_MS: 60_000,              // не частіше 1/хв
  AUTO_REFRESH_MS: 300_000           // автооновлення
};

// Порядок статусів і відображувані назви
const STATUS_ORDER = [
  { key: "Відправлено на склад", label: "Відправлено на склад" },
  { key: "Збирається (скл.)", label: "Збирається" },
  { key: "Зібрано (скл.)", label: "Зібрано" },
];

// Кольори сегментів (легенда зі скріншоту: синій/зелений/червоний)
const COLORS = {
  "Самовивіз": "#4da3ff",  // blue
  "Доставка":  "#34c759",  // green
  "Відправка": "#ff3b30",  // red
};

// === STATE / DOM ==========================================================
const grid = document.getElementById("grid");
const stampEl = document.getElementById("stamp");
const errorBox = document.getElementById("errorBox");

const authModal = document.getElementById("authModal");
const loginInput = document.getElementById("loginInput");
const passInput  = document.getElementById("passInput");
const authBtn    = document.getElementById("authBtn");
const authErr    = document.getElementById("authErr");

// Кеш у пам'яті + localStorage
let lastFetchedAt = 0;
let lastData = null;

const LS_KEYS = {
  DATA: "orders.cache.data",
  STAMP: "orders.cache.stamp",
};

// === HELPERS ==============================================================
function setStamp(date = new Date(), extra = "") {
  const two = n => n.toString().padStart(2, "0");
  const t = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
  stampEl.textContent = `оновлено о ${t}${extra}`;
}
function showError(msg) {
  errorBox.style.display = "block";
  errorBox.textContent = msg;
}
function clearError() {
  errorBox.style.display = "none";
  errorBox.textContent = "";
}
function inWorkHours(d = new Date()) {
  const h = d.getHours();
  return h >= CONFIG.WORK_HOURS.start && h < CONFIG.WORK_HOURS.end;
}
function saveCache(data) {
  lastData = data;
  lastFetchedAt = Date.now();
  localStorage.setItem(LS_KEYS.DATA, JSON.stringify(data));
  localStorage.setItem(LS_KEYS.STAMP, String(lastFetchedAt));
}
function loadCache() {
  if (lastData) return lastData;
  const raw = localStorage.getItem(LS_KEYS.DATA);
  const stamp = Number(localStorage.getItem(LS_KEYS.STAMP) || 0);
  if (raw) {
    lastFetchedAt = stamp;
    try { lastData = JSON.parse(raw); } catch {}
  }
  return lastData;
}

// Плагін: великий текст у центрі кола (К/О)
const CenterText = {
  id: "centerText",
  afterDatasetsDraw(chart) {
    const { ctx, chartArea: { width, height } } = chart;
    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data || !meta.data[0]) return;
    const { x, y } = meta.data[0];
    const text = chart.$center || "0/0"; // "К/О"

    ctx.save();
    ctx.font = `700 ${Math.max(20, width * 0.12)}px system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.fillStyle = "#e7eefc";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
    ctx.restore();
  }
};
Chart.register(CenterText);

// === BUILD UI =============================================================
function createCard(statusLabel) {
  const card = document.createElement("div");
  card.className = "card";

  const label = document.createElement("div");
  label.className = "label";
  label.innerHTML = `<span class="label__txt">${statusLabel}</span><span class="smallMuted" data-total="0">0 шт.</span>`;
  card.appendChild(label);

  const box = document.createElement("div");
  box.className = "chartBox";
  const canvas = document.createElement("canvas");
  box.appendChild(canvas);
  card.appendChild(box);

  const badges = document.createElement("div");
  badges.className = "badges";
  badges.innerHTML = `<span class="badge" data-k="0">К: 0</span><span class="badge" data-o="0">О: 0</span>`;
  card.appendChild(badges);

  const leg = document.createElement("div");
  leg.className = "leg";
  leg.innerHTML = `
    <div class="leg__row"><div class="leg__left"><span class="dot dot--blue"></span><span>Самовивіз</span></div><div class="smallMuted" data-leg="Самовивіз">0 (К 0 / О 0)</div></div>
    <div class="leg__row"><div class="leg__left"><span class="dot dot--green"></span><span>Доставка</span></div><div class="smallMuted" data-leg="Доставка">0 (К 0 / О 0)</div></div>
    <div class="leg__row"><div class="leg__left"><span class="dot dot--red"></span><span>Відправка</span></div><div class="smallMuted" data-leg="Відправка">0 (К 0 / О 0)</div></div>
  `;
  card.appendChild(leg);

  // донат
  const chart = new Chart(canvas.getContext("2d"), {
    type: "doughnut",
    data: {
      labels: ["Самовивіз", "Доставка", "Відправка"],
      datasets: [{
        data: [0, 0, 0],
        backgroundColor: [COLORS["Самовивіз"], COLORS["Доставка"], COLORS["Відправка"]],
        borderWidth: 0,
        hoverOffset: 2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      cutout: "72%"
    },
    plugins: [CenterText]
  });

  return { card, chart, label, leg, badges };
}

// Створюємо картки
const cards = {};
STATUS_ORDER.forEach(({ label }) => {
  const built = createCard(label);
  grid.appendChild(built.card);
  cards[label] = built;
});

// === DATA SHAPING =========================================================
function normalize(dataArray) {
  // очікуємо:
  // [{ Статус, К:{total,Самовивіз,Доставка,Відправка}, О:{...}, Всього }]
  const map = new Map();
  for (const row of dataArray || []) {
    map.set(row["Статус"], row);
  }
  return map;
}

function toDisplayRow(row) {
  if (!row) return null;
  const k = row.К || { total: 0, Самовивіз: 0, Доставка: 0, Відправка: 0 };
  const o = row.О || { total: 0, Самовивіз: 0, Доставка: 0, Відправка: 0 };

  const totals = {
    "Самовивіз": Number(k["Самовивіз"] || 0) + Number(o["Самовивіз"] || 0),
    "Доставка":  Number(k["Доставка"]  || 0) + Number(o["Доставка"]  || 0),
    "Відправка": Number(k["Відправка"] || 0) + Number(o["Відправка"] || 0),
  };
  const totalAll = Number(row["Всього"] || 0);
  const kTotal = Number(k.total || 0);
  const oTotal = Number(o.total || 0);
  return { totals, totalAll, k, o };
}

// малюємо одну картку
function renderCard(label, row) {
  const ui = cards[label];
  if (!ui) return;

  const shaped = toDisplayRow(row) || {
    totals:{ "Самовивіз":0,"Доставка":0,"Відправка":0 },
    totalAll:0, k:{total:0}, o:{total:0}
  };

  // заголовок: назва + загальна кількість
  ui.label.querySelector('[data-total]').textContent = `${shaped.totalAll} шт.`;

  // бейджі К/О
  ui.badges.querySelector('[data-k]').textContent = `К: ${shaped.k.total || 0}`;
  ui.badges.querySelector('[data-o]').textContent = `О: ${shaped.o.total || 0}`;

  // центр: "К/О"
  ui.chart.$center = `${shaped.k.total || 0}/${shaped.o.total || 0}`;

  // поновити дані графіка
  ui.chart.data.datasets[0].data = [
    shaped.totals["Самовивіз"],
    shaped.totals["Доставка"],
    shaped.totals["Відправка"],
  ];
  ui.chart.update();

  // легенда рядки: "N (К x / О y)"
  const setLeg = (name, kVal, oVal) => {
    const el = ui.card.querySelector(`[data-leg="${name}"]`);
    const total = (Number(kVal)||0) + (Number(oVal)||0);
    if (el) el.textContent = `${total} (К ${kVal||0} / О ${oVal||0})`;
  };
  setLeg("Самовивіз", row.К?.Самовивіз, row.О?.Самовивіз);
  setLeg("Доставка",  row.К?.Доставка,  row.О?.Доставка);
  setLeg("Відправка", row.К?.Відправка, row.О?.Відправка);
}

// малюємо всі
function renderAll(data) {
  const map = normalize(data);

  STATUS_ORDER.forEach(({ key, label }) => {
    renderCard(label, map.get(key));
  });
}

// === AUTH ================================================================
function isAuthed() {
  return sessionStorage.getItem("auth-ok") === "1";
}
function openAuth() {
  authModal.setAttribute("aria-hidden", "false");
  authErr.hidden = true;
  setTimeout(()=> loginInput.focus(), 0);
}
function closeAuth() {
  authModal.setAttribute("aria-hidden", "true");
}
authBtn.addEventListener("click", () => {
  const u = loginInput.value.trim();
  const p = passInput.value;
  if (u === CONFIG.AUTH.username && p === CONFIG.AUTH.password) {
    sessionStorage.setItem("auth-ok", "1");
    authErr.hidden = true;
    closeAuth();
    // одразу підвантажимо
    loadData(true);
  } else {
    authErr.hidden = false;
  }
});

// === FETCH / CACHE =======================================================
async function fetchData() {
  const res = await fetch(CONFIG.WEBHOOK_URL, { method: "GET" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadData(force = false) {
  clearError();

  // авторизація
  if (!isAuthed()) {
    openAuth();
    return;
  }

  const now = Date.now();
  const canFetch = (now - lastFetchedAt) >= CONFIG.MIN_FETCH_MS;
  const withinWork = inWorkHours();

  // якщо не робочий час — не тягнемо з мережі
  const shouldFetch = force ? (withinWork && canFetch) : (withinWork && canFetch);

  try {
    if (shouldFetch) {
      stampEl.textContent = "оновлюю…";
      const data = await fetchData();
      saveCache(data);
      renderAll(data);
      setStamp(new Date());
    } else {
      // показуємо кеш
      const cached = loadCache();
      if (cached) {
        renderAll(cached);
        const extra = withinWork ? " (кеш)" : " (поза робочим часом)";
        const stamp = new Date(Number(localStorage.getItem(LS_KEYS.STAMP) || Date.now()));
        setStamp(stamp, extra);
      } else {
        // якщо кешу немає — все одно спробуємо потягнути
        const data = await fetchData();
        saveCache(data);
        renderAll(data);
        setStamp(new Date());
      }
    }
  } catch (err) {
    showError("Помилка завантаження: " + (err?.message || err));
    const cached = loadCache();
    if (cached) {
      renderAll(cached);
      const stamp = new Date(Number(localStorage.getItem(LS_KEYS.STAMP) || Date.now()));
      setStamp(stamp, " (кеш після помилки)");
    }
  }
}

// === INIT ================================================================
document.getElementById("refreshBtn").addEventListener("click", () => loadData(false));
loadData(true);                          // перше завантаження
setInterval(() => loadData(false), CONFIG.AUTO_REFRESH_MS);
