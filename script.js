/* ================================ *
 *   Склад — оперативні статуси     *
 *   app.js (повна версія)          *
 * ================================ */

/* ---------- Налаштування ---------- */

// URL вашого n8n-вебхука
const WEBHOOK_URL = "https://n8n.vetai.win/webhook/da346a7b-9591-46a4-8bd7-e4b150dea063";

// Порядок відображення карток
const STATUS_KEYS = ["Відправлено на склад", "Збирається", "Зібрано"];

// Робочі години (локальний час браузера)
const WORK_HOURS = { start: 8, end: 21 }; // від 08:00 до 21:00 (включно початок, виключно кінець)

// Мінімальний інтервал запитів до бекенда
const MIN_FETCH_INTERVAL_MS = 60_000; // 1 хвилина

// Кольори для типів доставки (Відправка — синій, Самовивіз — жовтий, Доставка — зелений)
const COLORS = {
  "Відправка": "#3B82F6",   // blue-500
  "Самовивіз": "#FACC15",   // yellow-400
  "Доставка":  "#22C55E",   // green-500
};
const LEGEND_ORDER = ["Самовивіз", "Доставка", "Відправка"]; // порядок у легенді та діаграмі

// Ключі localStorage
const LS_KEYS = {
  lastData:   "dash.lastData",
  lastFetch:  "dash.lastFetch",
  authUser:   "dash.auth.user",
  authToken:  "dash.auth.token",
};

/* ---------- DOM-посилання ---------- */
const gridEl     = document.getElementById("grid");
const stampEl    = document.getElementById("stamp");
const errorBoxEl = document.getElementById("errorBox");
const refreshBtn = document.getElementById("refreshBtn");

// елементи авторизації (мають бути у вашому HTML)
const authOverlay = document.getElementById("authOverlay");
const authForm    = document.getElementById("authForm");
const authLogin   = document.getElementById("authLogin");
const authPass    = document.getElementById("authPass");

/* ---------- Стан застосунку ---------- */
let chartsByStatus = {};              // { "Відправлено на склад": Chart, ... }
let currentData     = null;           // останні нормалізовані дані
let isFetching      = false;

/* ---------- Утиліти ---------- */
const two = (n) => String(n).padStart(2, "0");

function setStamp(date = new Date(), label = "оновлено о") {
  const t = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
  stampEl.textContent = `${label} ${t}`;
}
function showError(msg) {
  errorBoxEl.style.display = "block";
  errorBoxEl.textContent = msg;
}
function clearError() {
  errorBoxEl.style.display = "none";
  errorBoxEl.textContent = "";
}
function inWorkHours(d = new Date()) {
  const h = d.getHours();
  return h >= WORK_HOURS.start && h < WORK_HOURS.end;
}
function nowMs() { return Date.now(); }

/* ---------- Авторизація ---------- */
// Проста верифікація: логін/пароль вводить користувач; токен шифруємо базово та кладемо у localStorage.
// Бекенд можна (необов’язково) перевіряти заголовком Authorization: Basic <base64>.
function ensureAuthUI() {
  const token = localStorage.getItem(LS_KEYS.authToken);
  if (token) {
    authOverlay?.classList.add("hidden");
    return true;
  }
  authOverlay?.classList.remove("hidden");
  return false;
}

authForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  const u = (authLogin?.value || "").trim();
  const p = (authPass?.value  || "").trim();
  if (!u || !p) return;

  // Успішний логін (клієнтська перевірка). За потреби — зробіть запит до окремого /auth.
  const token = btoa(`${u}:${p}`);
  localStorage.setItem(LS_KEYS.authUser, u);
  localStorage.setItem(LS_KEYS.authToken, token);

  // Приховуємо модалку
  authOverlay?.classList.add("hidden");

  // Перше завантаження після логіну
  safeLoad();
});

/* ---------- Підготовка макета карток ---------- */
function createCard(statusKey) {
  // контейнер
  const card = document.createElement("div");
  card.className = "card";

  // заголовок + total праворуч
  const head = document.createElement("div");
  head.className = "cardHead";
  const title = document.createElement("div");
  title.className = "label";
  title.textContent = statusKey;
  const total = document.createElement("div");
  total.className = "totalBadge";
  total.textContent = "0 шт.";
  head.appendChild(title);
  head.appendChild(total);

  // кільце
  const box = document.createElement("div");
  box.className = "chartBox";
  const canvas = document.createElement("canvas");
  box.appendChild(canvas);

  // підпис K/O
  const ko = document.createElement("div");
  ko.className = "ko";
  ko.innerHTML = `К: <b>0</b> <span class="dot">•</span> О: <b>0</b>`;

  // легенда
  const legend = document.createElement("div");
  legend.className = "legend";

  card.appendChild(head);
  card.appendChild(box);
  card.appendChild(ko);
  card.appendChild(legend);

  gridEl.appendChild(card);

  // Порожній графік (діаграма будується при першому оновленні)
  const chart = new Chart(canvas.getContext("2d"), {
    type: "doughnut",
    data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderWidth: 0 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "70%",
      plugins: { legend: { display: false }, tooltip: { enabled: true } }
    }
  });

  // зберігаємо хендли для подальшого оновлення
  return { card, chart, totalEl: total, koEl: ko, legendEl: legend, titleEl: title };
}

function mountCards() {
  chartsByStatus = {};
  gridEl.innerHTML = "";
  STATUS_KEYS.forEach((key) => {
    const parts = createCard(key);
    chartsByStatus[key] = parts;
  });
}

/* ---------- Нормалізація/парсинг даних ---------- */
function normalizePayload(raw) {
  // Очікуємо масив об’єктів з ключами:
  //  { Статус, Всього, К: { total, Самовивіз, Доставка, Відправка }, О: {...} }
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const map = new Map();

  for (const row of arr) {
    const status = String(row?.Статус ?? "").trim();
    if (!status) continue;

    const k = row?.К || {};
    const o = row?.О || {};

    const safe = (v) => (Number.isFinite(+v) ? +v : 0);

    map.set(status, {
      Статус: status,
      Всього: safe(row?.Всього ?? (safe(k.total) + safe(o.total))),
      К: {
        total:    safe(k.total),
        Самовивіз: safe(k["Самовивіз"]),
        Доставка:  safe(k["Доставка"]),
        Відправка: safe(k["Відправка"]),
      },
      О: {
        total:    safe(o.total),
        Самовивіз: safe(o["Самовивіз"]),
        Доставка:  safe(o["Доставка"]),
        Відправка: safe(o["Відправка"]),
      },
    });
  }

  // Повертати у фіксованому порядку й із дефолтами на 0
  return STATUS_KEYS.map((key) => {
    if (map.has(key)) return map.get(key);
    return {
      Статус: key, Всього: 0,
      К: { total: 0, Самовивіз: 0, Доставка: 0, Відправка: 0 },
      О: { total: 0, Самовивіз: 0, Доставка: 0, Відправка: 0 },
    };
  });
}

/* ---------- Рендер ---------- */
function fmtLegendLine(label, K, O) {
  const total = K + O;
  return `${label} ${total} (К ${K} / О ${O})`;
}

function updateCard(statusObj) {
  const parts = chartsByStatus[statusObj.Статус];
  if (!parts) return;

  // заголовок: праворуч "X шт."
  parts.totalEl.textContent = `${statusObj.Всього} шт.`;

  // центр К/О
  parts.koEl.innerHTML = `К: <b>${statusObj.К.total}</b> <span class="dot">•</span> О: <b>${statusObj.О.total}</b>`;

  // дані для діаграми (у визначеному порядку)
  const labels = [];
  const data   = [];
  const colors = [];
  for (const label of LEGEND_ORDER) {
    const k = statusObj.К[label] || 0;
    const o = statusObj.О[label] || 0;
    const sum = k + o;
    if (sum > 0) {
      labels.push(`${label} — ${sum} (К ${k} / О ${o})`);
      data.push(sum);
      colors.push(COLORS[label]);
    }
  }
  // якщо усі нулі — малюємо «порожнє» кільце
  const dataset = parts.chart.data.datasets[0];
  parts.chart.data.labels = labels;
  dataset.data = data.length ? data : [1];
  dataset.backgroundColor = data.length ? colors : ["#23324d"];
  parts.chart.update();

  // легенда (кастомна)
  parts.legendEl.innerHTML = "";
  for (const label of LEGEND_ORDER) {
    const k = statusObj.К[label] || 0;
    const o = statusObj.О[label] || 0;
    const row = document.createElement("div");
    row.className = "legendRow";
    row.innerHTML = `
      <span class="dot" style="background:${COLORS[label]}"></span>
      <span class="name">${label}</span>
      <span class="val">${fmtLegendLine("", k, o).trimLeft?.() ?? `${k+o} (К ${k} / О ${o})`}</span>
    `;
    // якщо немає цього типу — робимо прозорішим
    if (k + o === 0) row.classList.add("muted");
    parts.legendEl.appendChild(row);
  }
}

function renderAll(data) {
  // Підпис у заголовку картки (без "(скл.)")
  Object.values(chartsByStatus).forEach(({ titleEl }) => {
    const clean = titleEl.textContent.replace(/\s*\(скл\.\)\s*$/i, "");
    titleEl.textContent = clean;
  });

  for (const row of data) updateCard(row);
}

/* ---------- Завантаження з кешем/обмеженням частоти ---------- */
async function fetchFromBackend() {
  const token = localStorage.getItem(LS_KEYS.authToken);
  const headers = token ? { Authorization: `Basic ${token}` } : {};

  const res = await fetch(WEBHOOK_URL, { method: "GET", headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadData(force = false) {
  // дросель запитів
  const lastFetch = Number(localStorage.getItem(LS_KEYS.lastFetch) || 0);
  const tooSoon = nowMs() - lastFetch < MIN_FETCH_INTERVAL_MS;

  // поза робочими годинами — не ходимо в бекенд без force
  const nonWork = !inWorkHours();

  // якщо занадто часто або поза годинами — віддаємо кеш (якщо є)
  if ((tooSoon || nonWork) && !force) {
    const cached = localStorage.getItem(LS_KEYS.lastData);
    if (cached) {
      const parsed = JSON.parse(cached);
      currentData = normalizePayload(parsed);
      renderAll(currentData);
      setStamp(new Date(lastFetch || nowMs()), nonWork ? "останні дані за" : "кеш на");
      return;
    }
    // якщо кеша немає — підемо в бекенд разово
  }

  if (isFetching) return;
  isFetching = true;
  stampEl.textContent = "оновлюю…";
  clearError();

  try {
    const raw = await fetchFromBackend();
    localStorage.setItem(LS_KEYS.lastFetch, String(nowMs()));
    localStorage.setItem(LS_KEYS.lastData, JSON.stringify(raw));

    currentData = normalizePayload(raw);
    renderAll(currentData);
    setStamp(new Date());
  } catch (e) {
    showError(`Помилка завантаження: ${e?.message || e}`);
    // спробуємо показати кеш, щоб інтерфейс не пустів
    const cached = localStorage.getItem(LS_KEYS.lastData);
    if (cached) {
      currentData = normalizePayload(JSON.parse(cached));
      renderAll(currentData);
      const ts = Number(localStorage.getItem(LS_KEYS.lastFetch) || nowMs());
      setStamp(new Date(ts), "кеш на");
    } else {
      setStamp(new Date());
    }
  } finally {
    isFetching = false;
  }
}

/* Обгортка, що поважає робочі години і throttling */
function safeLoad(force = false) {
  loadData(force);
}

/* ---------- Ініціалізація UI ---------- */
function init() {
  mountCards();
  ensureAuthUI();          // якщо не авторизовано — покаже модалку
  if (localStorage.getItem(LS_KEYS.authToken)) safeLoad(true);

  refreshBtn?.addEventListener("click", () => safeLoad(false));

  // автооновлення щохвилини (але loadData всередині все одно бере кеш при потребі)
  setInterval(() => safeLoad(false), 300_000);
}

/* ---------- Старт ---------- */
document.addEventListener("DOMContentLoaded", init);
