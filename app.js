const ui = {
  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  scanBtn: document.getElementById("scanBtn"),
  addPortBtn: document.getElementById("addPortBtn"),
  refreshPortsBtn: document.getElementById("refreshPortsBtn"),
  portSelect: document.getElementById("portSelect"),
  scanSec: document.getElementById("scanSec"),
  scanPhase: document.getElementById("scanPhase"),
  measurePhase: document.getElementById("measurePhase"),
  autoRefresh: document.getElementById("autoRefresh"),
  autoSec: document.getElementById("autoSec"),
  statusBadge: document.getElementById("statusBadge"),
  lastUpdate: document.getElementById("lastUpdate"),
  logLine: document.getElementById("logLine"),
  trendDeviceSelect: document.getElementById("trendDeviceSelect"),
  trendParamButton: document.getElementById("trendParamButton"),
  trendParamList: document.getElementById("trendParamList"),
  trendTimeRange: document.getElementById("trendTimeRange"),
  trendSummary: document.getElementById("trendSummary"),
  trendChart: document.getElementById("trendChart"),
  exportVisibleArchiveBtn: document.getElementById("exportVisibleArchiveBtn"),
  exportArchiveBtn: document.getElementById("exportArchiveBtn"),
  clearArchiveBtn: document.getElementById("clearArchiveBtn"),
  nameDeviceSelect: document.getElementById("nameDeviceSelect"),
  deviceNameInput: document.getElementById("deviceNameInput"),
  nameParamSelect: document.getElementById("nameParamSelect"),
  paramNameInput: document.getElementById("paramNameInput"),
  saveNamesBtn: document.getElementById("saveNamesBtn"),
  clearNamesBtn: document.getElementById("clearNamesBtn"),
  alertDeviceSelect: document.getElementById("alertDeviceSelect"),
  alertParamSelect: document.getElementById("alertParamSelect"),
  alertMinInput: document.getElementById("alertMinInput"),
  alertMaxInput: document.getElementById("alertMaxInput"),
  alertOfflineInput: document.getElementById("alertOfflineInput"),
  addAlertRuleBtn: document.getElementById("addAlertRuleBtn"),
  alertRulesList: document.getElementById("alertRulesList"),
  alertList: document.getElementById("alertList"),
  alertSummary: document.getElementById("alertSummary"),
  cards: document.getElementById("cards"),
  cardTemplate: document.getElementById("cardTemplate")
};

const FIXED_BAUD_RATE = 115200;
const ARCHIVE_STORAGE_KEY = "tplung-live-archive-v2";
const NAMES_STORAGE_KEY = "tplung-live-names-v1";
const ALERT_RULES_STORAGE_KEY = "tplung-live-alert-rules-v1";
const LAST_SEEN_STORAGE_KEY = "tplung-live-last-seen-v1";
const LIVE_PREFS_STORAGE_KEY = "tplung-live-prefs-v1";
const ARCHIVE_MAX_POINTS_PER_DEVICE = 2000;
const TREND_TIME_RANGES = {
  all: { ms: null, label: "весь архив" },
  900000: { ms: 15 * 60 * 1000, label: "15 мин" },
  3600000: { ms: 60 * 60 * 1000, label: "1 час" },
  21600000: { ms: 6 * 60 * 60 * 1000, label: "6 часов" },
  86400000: { ms: 24 * 60 * 60 * 1000, label: "24 часа" }
};
const FLAG_DATA_HR202_SIGNAL_MASK = 1 << 10;
const FLAG_DATA_THERMISTOR_SIGNAL_MASK = 1 << 11;
const FLAG_DATA_W1_THERM_SIGNAL_MASK = 1 << 11;

let currentLiveData = {};

class ThermoSerialClient {
  constructor() {
    this.port = null;
    this.knownPorts = [];
    this.reader = null;
    this.writer = null;
    this.readLoopTask = null;
    this.rx = new Uint8Array(0);
    this.autoTimer = null;
    this.busy = false;
  }

  get connected() {
    return !!this.port;
  }

  async loadKnownPorts() {
    if (!("serial" in navigator)) {
      this.knownPorts = [];
      return [];
    }
    this.knownPorts = await navigator.serial.getPorts();
    return this.knownPorts;
  }

  async requestNewPort() {
    if (!("serial" in navigator)) {
      throw new Error("Web Serial API не поддерживается в этом браузере");
    }
    const newPort = await navigator.serial.requestPort();
    await this.loadKnownPorts();
    return newPort;
  }

  async connect(baudRate, selectedPort = null) {
    if (!("serial" in navigator)) {
      throw new Error("Web Serial API не поддерживается в этом браузере");
    }

    this.port = selectedPort || await this.requestNewPort();
    await this.port.open({ baudRate, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });

    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.rx = new Uint8Array(0);
    this.readLoopTask = this.readLoop();
  }

  async disconnect() {
    this.stopAutoRefresh();

    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch (_e) {
      }
      this.reader.releaseLock();
      this.reader = null;
    }

    if (this.writer) {
      this.writer.releaseLock();
      this.writer = null;
    }

    if (this.port) {
      try {
        await this.port.close();
      } catch (_e) {
      }
      this.port = null;
    }
  }

  async readLoop() {
    try {
      while (this.reader) {
        const { value, done } = await this.reader.read();
        if (done) {
          break;
        }
        if (value && value.length) {
          this.rx = concatUint8(this.rx, value);
        }
      }
    } catch (_e) {
    }
  }

  async sendCmd(cmd) {
    if (!this.writer) {
      throw new Error("Порт не подключен");
    }
    const bytes = new TextEncoder().encode(cmd);
    await this.writer.write(bytes);
  }

  async stopScanAndMeasure() {
    if (!this.writer) {
      return;
    }
    await this.sendCmd("at01");
    await sleep(50);
    await this.sendCmd("at03");
  }

  clearRx() {
    this.rx = new Uint8Array(0);
  }

  async scan(scanSec, options = {}) {
    if (!this.connected) {
      throw new Error("Сначала подключите порт");
    }
    if (this.busy) {
      return null;
    }

    this.busy = true;
    try {
      const scanEnabled = options.scanEnabled !== false;
      const measureEnabled = options.measureEnabled !== false;
      this.clearRx();

      if (scanEnabled) {
        await this.sendCmd("at00");
        await sleep(scanSec * 1000);

        await this.sendCmd("at01");
        await sleep(500);
      }

      if (measureEnabled) {
        await this.sendCmd("at02");
        await sleep(2000);

        await this.sendCmd("at03");
      }

      const snapshot = this.rx;
      this.clearRx();
      return parseAdvData(snapshot);
    } finally {
      this.busy = false;
    }
  }

  startAutoRefresh(callback) {
    this.stopAutoRefresh();
    const sec = clampInt(Number(ui.autoSec.value), 5, 180, 15);
    this.autoTimer = setInterval(callback, sec * 1000);
  }

  stopAutoRefresh() {
    if (this.autoTimer) {
      clearInterval(this.autoTimer);
      this.autoTimer = null;
    }
  }
}

const client = new ThermoSerialClient();

function portLabel(port, idx) {
  const info = port.getInfo ? port.getInfo() : {};
  const usb = info.usbVendorId || info.usbProductId
    ? `USB ${toHex(info.usbVendorId)}:${toHex(info.usbProductId)}`
    : "Serial device";
  return `${idx + 1}. ${usb}`;
}

function toHex(v) {
  if (v === undefined || v === null) {
    return "----";
  }
  return Number(v).toString(16).toUpperCase().padStart(4, "0");
}

async function refreshPortList() {
  if (!("serial" in navigator)) {
    ui.portSelect.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Web Serial API не поддерживается";
    ui.portSelect.appendChild(opt);
    ui.portSelect.disabled = true;
    return;
  }

  const ports = await client.loadKnownPorts();
  ui.portSelect.innerHTML = "";

  if (!ports.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Нет разрешенных портов, нажмите Добавить порт";
    ui.portSelect.appendChild(opt);
    ui.portSelect.disabled = true;
    return;
  }

  ports.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = portLabel(p, i);
    ui.portSelect.appendChild(opt);
  });
  ui.portSelect.disabled = false;
}

function concatUint8(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(v, min, max, fallback) {
  if (!Number.isFinite(v)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function clampInputValue(input, min, max, fallback) {
  input.value = String(clampInt(Number(input.value), min, max, fallback));
}

function modbusCrc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xa001;
      } else {
        crc >>>= 1;
      }
    }
  }
  return crc & 0xffff;
}

function readU16LE(arr, idx) {
  if (idx + 1 >= arr.length) {
    return null;
  }
  return arr[idx] | (arr[idx + 1] << 8);
}

function readS8(arr, idx) {
  const v = arr[idx] ?? 0;
  return v > 127 ? v - 256 : v;
}

function readS16LE(arr, idx) {
  if (idx + 1 >= arr.length) {
    return null;
  }
  const raw = arr[idx] | (arr[idx + 1] << 8);
  const signed = ((raw ^ 0x8000) - 0x8000);
  return signed / 10.0;
}

function readU32BE(arr, idx) {
  if (idx + 3 >= arr.length) {
    return null;
  }
  return (
    (arr[idx] * 0x1000000 +
      (arr[idx + 1] << 16) +
      (arr[idx + 2] << 8) +
      arr[idx + 3]) >>> 0
  );
}

function readU32LE(arr, idx) {
  if (idx + 3 >= arr.length) {
    return null;
  }
  return (
    (arr[idx + 3] * 0x1000000 +
      (arr[idx + 2] << 16) +
      (arr[idx + 1] << 8) +
      arr[idx]) >>> 0
  );
}

function ensureDevice(result, mac) {
  if (!result[mac]) {
    result[mac] = {
      data_present: 0,
      RSSI: null,
      batt: null,
      Humi: { flags: null },
      Thermo: { flags: null },
      Energomera: { flags: null }
    };
    for (let i = 0; i < 8; i += 1) {
      result[mac].Humi[`T${i}`] = null;
      result[mac].Humi[`H${i}`] = null;
      result[mac].Thermo[`T${i}`] = null;
    }
    for (let i = 0; i < 4; i += 1) {
      result[mac].Energomera[`E${i}`] = null;
    }
  }
}

function parseAdvData(buffer) {
  const result = {};
  const minPacketLen = 19;
  let pos = 0;

  while (pos + minPacketLen <= buffer.length) {
    const hdr = readU16LE(buffer, pos);
    if (hdr !== 0xaa55) {
      pos += 1;
      continue;
    }

    const len = buffer[pos + 2];
    if (!len || pos + len > buffer.length) {
      pos += 1;
      continue;
    }

    const packet = buffer.slice(pos + 2, pos + 2 + len);
    if (packet.length < 4) {
      pos += 1;
      continue;
    }

    const payloadPlusCrc = packet.slice(1);
    if (payloadPlusCrc.length < 3) {
      pos += 1;
      continue;
    }

    const crcRecv = readU16LE(payloadPlusCrc, payloadPlusCrc.length - 2);
    const payload = payloadPlusCrc.slice(0, payloadPlusCrc.length - 2);
    const crcCalc = modbusCrc16(packet.slice(0, packet.length - 2));
    if (crcRecv === null || crcCalc !== crcRecv) {
      pos += 1;
      continue;
    }

    pos += len;

    if (payload.length < 9) {
      continue;
    }

    const vendorId = readU16LE(payload, 0);
    const packType = payload[2];
    if (vendorId !== 0xfffe) {
      continue;
    }

    const rssiPresent = (packType & 0x20) !== 0;
    const rssi = rssiPresent ? readS8(payload, 3) : null;
    const macOff = rssiPresent ? 4 : 3;
    if (macOff + 6 > payload.length) {
      continue;
    }

    const macRaw = payload.slice(macOff, macOff + 6);
    const macBytes = [...macRaw].reverse().map((v) => v.toString(16).padStart(2, "0").toUpperCase());
    const mac = macBytes.join(":");
    ensureDevice(result, mac);
    result[mac].RSSI = rssi;

    const adv = payload.slice(rssiPresent ? 10 : 9);
    let idx = 0;

    if (packType & 1) {
      if (idx + 4 > adv.length) {
        continue;
      }
      result[mac].PacketTimeRawBytes = [adv[idx], adv[idx + 1], adv[idx + 2], adv[idx + 3]];
      result[mac].PacketTime = readU32LE(adv, idx);
      idx += 4;
    }

    if (packType & 2) {
      if (idx + 2 > adv.length) {
        continue;
      }
      const flags = (adv[idx + 1] << 8) | adv[idx];
      result[mac].Humi.flags = flags;
      result[mac].data_present = 1;
      result[mac].batt = flags >> 14;
      idx += 2;

      if (flags & 0x200) {
        for (let i = 0, j = 0; i < 8; i += 2, j += 1) {
          if (flags & (1 << i)) {
            const t = readS16LE(adv, idx);
            if (t === null) {
              break;
            }
            result[mac].Humi[`T${j}`] = t;
            idx += 2;

            if (flags & (1 << (i + 1))) {
              const h = readS16LE(adv, idx);
              if (h === null) {
                break;
              }
              result[mac].Humi[`H${j}`] = h;
              idx += 2;
            } else {
              result[mac].Humi[`H${j}`] = null;
            }
          } else {
            result[mac].Humi[`T${j}`] = null;
            result[mac].Humi[`H${j}`] = null;
          }
        }
      } else {
        if (!(flags & 0x2)) {
          const h = readS16LE(adv, idx);
          idx += 2;
          const t = readS16LE(adv, idx);
          idx += 2;
          result[mac].Humi.H0 = h;
          result[mac].Humi.T0 = t;
        } else {
          if (flags & 1) {
            result[mac].Humi.H0 = readS16LE(adv, idx);
          }
          idx += 2;

          for (let i = 0; i < 7; i += 1) {
            if (flags & (2 << i)) {
              result[mac].Humi[`T${i}`] = readS16LE(adv, idx);
              idx += 2;
            } else {
              result[mac].Humi[`T${i}`] = null;
            }
          }
        }
      }
    }

    if (packType & 4) {
      if (idx + 2 > adv.length) {
        continue;
      }
      const flags = (adv[idx + 1] << 8) | adv[idx];
      result[mac].Energomera.flags = flags;
      result[mac].data_present = 1;
      idx += 2;

      for (let i = 0; i < 4; i += 1) {
        if (flags & (1 << i)) {
          if (idx + 4 > adv.length) {
            break;
          }
          const e =
            (adv[idx]) |
            (adv[idx + 1] << 8) |
            (adv[idx + 2] << 16) |
            (adv[idx + 3] << 24);
          result[mac].Energomera[`E${i}`] = e >>> 0;
          idx += 4;
        } else {
          result[mac].Energomera[`E${i}`] = null;
        }
      }
    }

    if (packType & 8) {
      if (idx + 2 > adv.length) {
        continue;
      }
      const flags = (adv[idx + 1] << 8) | adv[idx];
      result[mac].Thermo.flags = flags;
      result[mac].data_present = 1;
      result[mac].batt = flags >> 14;
      idx += 2;

      for (let i = 0; i < 8; i += 1) {
        if (flags & (1 << i)) {
          result[mac].Thermo[`T${i}`] = readS16LE(adv, idx);
          idx += 2;
        } else {
          result[mac].Thermo[`T${i}`] = null;
        }
      }
    }

    if (!(packType & 0x0e)) {
      if (idx < adv.length) {
        result[mac].batt = adv[idx];
      }
    }
  }

  return result;
}

function chip(text, cls = "") {
  const el = document.createElement("span");
  el.className = `chip ${cls}`.trim();
  el.textContent = text;
  return el;
}

function tile(key, value, unit = "", cls = "") {
  const wrap = document.createElement("div");
  wrap.className = `tile ${cls}`.trim();

  const k = document.createElement("span");
  k.className = "k";
  k.textContent = key;

  const v = document.createElement("span");
  v.className = "v";
  v.textContent = `${value}${unit}`;

  wrap.append(k, v);
  return wrap;
}

function energyTile(key, value, cls = "") {
  return tile(key, formatEnergyValue(value), " kWh", cls);
}

function formatEnergyValue(value) {
  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3
  }).format(Number(value));
}

function energyCounter(pairIndex, tarif1, tarif2, addr = "", alertKeys = new Set(), names = loadNames()) {
  const wrap = document.createElement("div");
  wrap.className = "energy-counter";

  const title = document.createElement("strong");
  title.textContent = `Счетчик ${pairIndex + 1}`;

  const tiles = document.createElement("div");
  tiles.className = "energy-counter-grid";

  const value1 = tarif1 === null || tarif1 === undefined ? 0 : tarif1 / 1000.0;
  const value2 = tarif2 === null || tarif2 === undefined ? 0 : tarif2 / 1000.0;
  const param1 = `Energy E${pairIndex * 2}`;
  const param2 = `Energy E${pairIndex * 2 + 1}`;
  tiles.append(
    energyTile(displayParamName(addr, param1, names), value1, alertKeys.has(alertKey(addr, param1)) ? "threshold-tile" : ""),
    energyTile(displayParamName(addr, param2, names), value2, alertKeys.has(alertKey(addr, param2)) ? "threshold-tile" : ""),
    energyTile("total", value1 + value2)
  );

  wrap.append(title, tiles);
  return wrap;
}

function rssiClass(v) {
  if (v > -75) {
    return "rssi-good";
  }
  if (v > -85) {
    return "rssi-mid";
  }
  return "rssi-low";
}

function batteryPercentFromState(state) {
  const n = Number(state);
  if (!Number.isFinite(n) || n < 0 || n > 3) {
    return null;
  }
  return n === 3 ? 100 : n === 2 ? 75 : n === 1 ? 50 : 25;
}

function batteryClass(state) {
  const pct = batteryPercentFromState(state);
  if (pct === null) {
    return "";
  }
  if (pct > 60) {
    return "batt-good";
  }
  if (pct > 25) {
    return "batt-mid";
  }
  return "batt-low";
}

function formatPacketTime(value, rawBytes = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return String(value);
  }

  const bytes = Array.isArray(rawBytes) && rawBytes.length === 4 ? rawBytes : null;
  const rtcSec = bytes ? readU32LE(bytes, 0) : (n >>> 0);

  // TPlung отдает PacketTime как уже локальное время устройства в секундах,
  // поэтому читаем компоненты в UTC, чтобы не добавлять timezone браузера повторно.
  const dt = new Date(rtcSec * 1000);
  if (Number.isNaN(dt.getTime())) {
    return String(rtcSec >>> 0);
  }

  const pad2 = (v) => String(v).padStart(2, "0");
  const dd = pad2(dt.getUTCDate());
  const mm = pad2(dt.getUTCMonth() + 1);
  const yy = pad2(dt.getUTCFullYear() % 100);
  const hh = pad2(dt.getUTCHours());
  const mi = pad2(dt.getUTCMinutes());
  const ss = pad2(dt.getUTCSeconds());

  return `${dd}.${mm}.${yy} ${hh}:${mi}:${ss}`;
}

function loadArchive() {
  try {
    const raw = localStorage.getItem(ARCHIVE_STORAGE_KEY);
    if (!raw) {
      return { version: 1, devices: {} };
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.devices || typeof parsed.devices !== "object") {
      return { version: 1, devices: {} };
    }

    return parsed;
  } catch (_e) {
    return { version: 1, devices: {} };
  }
}

function saveArchive(archive) {
  try {
    localStorage.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify(archive));
    return true;
  } catch (_e) {
    return false;
  }
}

function loadJsonStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (_e) {
    return fallback;
  }
}

function saveJsonStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (_e) {
    return false;
  }
}

function normalizeLivePrefs(rawPrefs = {}) {
  const trendParamsByDevice = rawPrefs.trendParamsByDevice && typeof rawPrefs.trendParamsByDevice === "object"
    ? rawPrefs.trendParamsByDevice
    : {};
  const normalizedTrendParamsByDevice = {};
  for (const [device, params] of Object.entries(trendParamsByDevice)) {
    if (typeof device === "string" && Array.isArray(params)) {
      normalizedTrendParamsByDevice[device] = params.filter((param) => typeof param === "string");
    }
  }

  return {
    version: 1,
    scanSec: clampInt(Number(rawPrefs.scanSec), 3, 60, 10),
    scanPhase: rawPrefs.scanPhase !== false,
    measurePhase: rawPrefs.measurePhase !== false,
    autoRefresh: rawPrefs.autoRefresh === true,
    autoSec: clampInt(Number(rawPrefs.autoSec), 5, 180, 15),
    trendDevice: typeof rawPrefs.trendDevice === "string" ? rawPrefs.trendDevice : "",
    trendTimeRange: TREND_TIME_RANGES[rawPrefs.trendTimeRange] ? rawPrefs.trendTimeRange : "all",
    trendParamsByDevice: normalizedTrendParamsByDevice
  };
}

function loadLivePrefs() {
  return normalizeLivePrefs(loadJsonStore(LIVE_PREFS_STORAGE_KEY, { version: 1 }));
}

function applyLivePrefs() {
  const prefs = loadLivePrefs();
  ui.scanSec.value = String(prefs.scanSec);
  ui.scanPhase.checked = prefs.scanPhase;
  ui.measurePhase.checked = prefs.measurePhase;
  ui.autoRefresh.checked = prefs.autoRefresh;
  ui.autoSec.value = String(prefs.autoSec);
  ui.trendTimeRange.value = prefs.trendTimeRange;
}

function saveLivePrefs(patch = {}) {
  const current = loadLivePrefs();
  const selectedDevice = typeof patch.trendDevice === "string"
    ? patch.trendDevice
    : ui.trendDeviceSelect.value || current.trendDevice;
  const trendParamsByDevice = patch.trendParamsByDevice && typeof patch.trendParamsByDevice === "object"
    ? patch.trendParamsByDevice
    : { ...current.trendParamsByDevice };
  if (!patch.skipTrendParams) {
    const paramsDevice = ui.trendDeviceSelect.value || current.trendDevice;
    if (paramsDevice) {
      trendParamsByDevice[paramsDevice] = getSelectedTrendParams();
    }
  }

  const next = normalizeLivePrefs({
    ...current,
    scanSec: ui.scanSec.value,
    scanPhase: ui.scanPhase.checked,
    measurePhase: ui.measurePhase.checked,
    autoRefresh: ui.autoRefresh.checked,
    autoSec: ui.autoSec.value,
    trendDevice: selectedDevice,
    trendTimeRange: ui.trendTimeRange.value,
    trendParamsByDevice,
    ...patch
  });

  saveJsonStore(LIVE_PREFS_STORAGE_KEY, next);
  return next;
}

function loadNames() {
  const names = loadJsonStore(NAMES_STORAGE_KEY, { version: 1, devices: {} });
  if (!names.devices || typeof names.devices !== "object") {
    names.devices = {};
  }
  return names;
}

function saveNames(names) {
  return saveJsonStore(NAMES_STORAGE_KEY, names);
}

function loadLastSeen() {
  const store = loadJsonStore(LAST_SEEN_STORAGE_KEY, { version: 1, devices: {} });
  if (!store.devices || typeof store.devices !== "object") {
    store.devices = {};
  }
  return store;
}

function saveLastSeen(lastSeen) {
  return saveJsonStore(LAST_SEEN_STORAGE_KEY, lastSeen);
}

function updateLastSeen(data, timestamp = Date.now()) {
  const lastSeen = loadLastSeen();
  for (const addr of Object.keys(data || {})) {
    lastSeen.devices[addr] = timestamp;
  }
  saveLastSeen(lastSeen);
}

function archivedLastSeen(addr) {
  const archive = loadArchive();
  const points = archive.devices?.[addr] || [];
  if (!points.length) {
    return null;
  }
  const maxTs = Math.max(...points.map((point) => Number(point.ts)).filter(Number.isFinite));
  return Number.isFinite(maxTs) ? maxTs : null;
}

function deviceLastSeen(addr) {
  const stored = numericValue(loadLastSeen().devices?.[addr]);
  return stored !== null ? stored : archivedLastSeen(addr);
}

function deviceNameEntry(addr, names = loadNames()) {
  return names.devices?.[addr] || {};
}

function displayDeviceName(addr, names = loadNames()) {
  const name = deviceNameEntry(addr, names).name?.trim();
  return name ? `${name} (${addr})` : addr;
}

function displayParamName(addr, param, names = loadNames()) {
  const label = deviceNameEntry(addr, names).channels?.[param]?.trim();
  return label ? `${label} (${param})` : param;
}

function getKnownDevices() {
  const archive = loadArchive();
  const names = loadNames();
  return [...new Set([
    ...Object.keys(archive.devices || {}),
    ...Object.keys(currentLiveData || {}),
    ...Object.keys(names.devices || {}),
    ...Object.keys(loadLastSeen().devices || {})
  ])].filter(Boolean).sort();
}

function getLatestDeviceParams(addr) {
  const params = new Set();
  const dev = currentLiveData?.[addr];
  if (dev) {
    for (const param of Object.keys(collectTrendValues(dev))) {
      params.add(param);
    }
  }

  const archive = loadArchive();
  const points = archive.devices?.[addr] || [];
  for (const param of getLatestArchiveParams(points)) {
    params.add(param);
  }

  const names = loadNames();
  for (const param of Object.keys(deviceNameEntry(addr, names).channels || {})) {
    params.add(param);
  }

  return [...params].sort((a, b) => a.localeCompare(b, "ru-RU", { numeric: true }));
}

function getAllKnownParams() {
  const params = new Set();
  for (const addr of getKnownDevices()) {
    for (const param of getLatestDeviceParams(addr)) {
      params.add(param);
    }
  }
  return [...params].sort((a, b) => a.localeCompare(b, "ru-RU", { numeric: true }));
}

function loadAlertRules() {
  const store = loadJsonStore(ALERT_RULES_STORAGE_KEY, { version: 1, rules: [] });
  return Array.isArray(store.rules) ? store.rules : [];
}

function saveAlertRules(rules) {
  return saveJsonStore(ALERT_RULES_STORAGE_KEY, { version: 1, rules });
}

function alertKey(addr, param) {
  return `${addr}\u0000${param}`;
}

function alertRuleText(rule, names = loadNames()) {
  const device = rule.device === "*" ? "Все устройства" : displayDeviceName(rule.device, names);
  const param = rule.param === "*"
    ? "любые данные"
    : rule.device === "*" ? rule.param : displayParamName(rule.device, rule.param, names);
  const parts = [];
  if (rule.min !== null && rule.min !== undefined) {
    parts.push(`min ${rule.min}`);
  }
  if (rule.max !== null && rule.max !== undefined) {
    parts.push(`max ${rule.max}`);
  }
  if (rule.offlineMin !== null && rule.offlineMin !== undefined) {
    parts.push(`нет данных ${rule.offlineMin} мин`);
  }
  return `${device}: ${param}, ${parts.join(", ")}`;
}

function evaluateAlertRules(data) {
  const rules = loadAlertRules();
  const alerts = [];
  const now = Date.now();
  const knownDevices = getKnownDevices();

  for (const rule of rules) {
    if (!rule || rule.enabled === false) {
      continue;
    }

    const targetDevices = rule.device === "*" ? knownDevices : [rule.device].filter(Boolean);
    const offlineMin = numericValue(rule.offlineMin);
    if (offlineMin !== null && offlineMin > 0) {
      for (const addr of targetDevices) {
        const lastSeenTs = deviceLastSeen(addr);
        if (lastSeenTs === null) {
          continue;
        }

        const offlineMs = now - lastSeenTs;
        if (offlineMs >= offlineMin * 60 * 1000) {
          alerts.push({
            type: "offline",
            device: addr,
            param: rule.param || "*",
            value: offlineMs / 60000,
            rule,
            reason: `нет данных ${Math.floor(offlineMs / 60000)} мин`
          });
        }
      }
    }

    if (!rule.param || rule.param === "*") {
      continue;
    }

    for (const [addr, dev] of Object.entries(data || {})) {
      if (rule.device !== "*" && rule.device !== addr) {
        continue;
      }

      const values = collectTrendValues(dev);
      const value = numericValue(values[rule.param]);
      if (value === null) {
        continue;
      }

      const belowMin = rule.min !== null && rule.min !== undefined && value < Number(rule.min);
      const aboveMax = rule.max !== null && rule.max !== undefined && value > Number(rule.max);
      if (belowMin || aboveMax) {
        alerts.push({
          device: addr,
          param: rule.param,
          value,
          rule,
          reason: belowMin ? `ниже ${rule.min}` : `выше ${rule.max}`
        });
      }
    }
  }

  return alerts;
}

function renderAlertNotifications(alerts) {
  ui.alertList.innerHTML = "";
  const rules = loadAlertRules();
  ui.alertSummary.textContent = alerts.length
    ? `Активно: ${alerts.length}`
    : rules.length
      ? `Правил: ${rules.length}`
      : "Правил нет";

  if (!alerts.length) {
    const empty = document.createElement("div");
    empty.className = "alert-empty";
    empty.textContent = rules.length ? "Активных срабатываний нет" : "Добавьте правило после появления устройства в Live или архиве";
    ui.alertList.appendChild(empty);
    return;
  }

  const names = loadNames();
  for (const alert of alerts) {
    const item = document.createElement("div");
    item.className = "alert-item active-alert";
    const title = document.createElement("strong");
    title.textContent = displayDeviceName(alert.device, names);
    const text = document.createElement("span");
    text.textContent = alert.type === "offline"
      ? `Устройство не обнаружено (${alert.reason})`
      : `${displayParamName(alert.device, alert.param, names)}: ${formatTrendValue(alert.value, alert.param)} (${alert.reason})`;
    item.append(title, text);
    ui.alertList.appendChild(item);
  }
}

function renderAlertRulesList() {
  const rules = loadAlertRules();
  ui.alertRulesList.innerHTML = "";
  if (!rules.length) {
    const empty = document.createElement("div");
    empty.className = "rule-empty";
    empty.textContent = "Пороговые правила пока не заданы";
    ui.alertRulesList.appendChild(empty);
    return;
  }

  const names = loadNames();
  for (const rule of rules) {
    const row = document.createElement("div");
    row.className = "rule-row";
    const text = document.createElement("span");
    text.textContent = alertRuleText(rule, names);
    const btn = document.createElement("button");
    btn.className = "btn btn-small";
    btn.type = "button";
    btn.textContent = "Удалить";
    btn.addEventListener("click", () => {
      saveAlertRules(loadAlertRules().filter((item) => item.id !== rule.id));
      renderAlertRulesList();
      renderAlertNotifications(evaluateAlertRules(currentLiveData));
      renderCards(currentLiveData);
      logLine("Пороговое правило удалено");
    });
    row.append(text, btn);
    ui.alertRulesList.appendChild(row);
  }
}

function refreshNameEditor({ keepDeviceName = false, keepParamName = false } = {}) {
  const names = loadNames();
  const devices = getKnownDevices();
  const previousDevice = ui.nameDeviceSelect.value;
  const previousParam = ui.nameParamSelect.value;
  const currentDeviceName = ui.deviceNameInput.value;
  const currentParamName = ui.paramNameInput.value;
  const selectedDevice = setSelectOptions(ui.nameDeviceSelect, devices, "Нет устройств", (addr) => displayDeviceName(addr, names));
  ui.deviceNameInput.disabled = !selectedDevice;
  ui.saveNamesBtn.disabled = !selectedDevice;
  ui.clearNamesBtn.disabled = !Object.keys(names.devices || {}).length;
  ui.deviceNameInput.value = keepDeviceName && selectedDevice === previousDevice
    ? currentDeviceName
    : selectedDevice ? deviceNameEntry(selectedDevice, names).name || "" : "";

  const params = selectedDevice ? getLatestDeviceParams(selectedDevice) : [];
  const selectedParam = setSelectOptions(ui.nameParamSelect, params, "Нет каналов", (param) => displayParamName(selectedDevice, param, names));
  ui.paramNameInput.disabled = !selectedParam;
  ui.paramNameInput.value = keepParamName && selectedDevice === previousDevice && selectedParam === previousParam
    ? currentParamName
    : selectedDevice && selectedParam
    ? deviceNameEntry(selectedDevice, names).channels?.[selectedParam] || ""
    : "";
}

function refreshAlertEditor() {
  const names = loadNames();
  const devices = ["*", ...getKnownDevices()];
  const selectedDevice = setSelectOptions(ui.alertDeviceSelect, devices, "Нет устройств", (addr) => addr === "*" ? "Все устройства" : displayDeviceName(addr, names));
  const params = selectedDevice === "*" ? getAllKnownParams() : getLatestDeviceParams(selectedDevice);
  setSelectOptions(ui.alertParamSelect, params, "Нет параметров", (param) => selectedDevice === "*" ? param : displayParamName(selectedDevice, param, names));
  ui.addAlertRuleBtn.disabled = !selectedDevice || selectedDevice === "*" && !getKnownDevices().length;
}

function refreshLiveTools({ keepNameDrafts = false } = {}) {
  refreshNameEditor({ keepDeviceName: keepNameDrafts, keepParamName: keepNameDrafts });
  refreshAlertEditor();
  renderAlertRulesList();
  renderAlertNotifications(evaluateAlertRules(currentLiveData));
}

function numericValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function collectTrendValues(dev) {
  const values = {};
  const add = (key, value) => {
    const n = numericValue(value);
    if (n !== null) {
      values[key] = n;
    }
  };

  add("RSSI", dev.RSSI);
  add("Batt", batteryPercentFromState(dev.batt));

  for (let i = 0; i < 8; i += 1) {
    add(`Thermo T${i}`, dev.Thermo?.[`T${i}`]);
    add(`Humi T${i}`, dev.Humi?.[`T${i}`]);
    add(`Humi H${i}`, dev.Humi?.[`H${i}`]);
  }

  for (let i = 0; i < 4; i += 1) {
    const raw = dev.Energomera?.[`E${i}`];
    const n = numericValue(raw);
    if (n !== null) {
      values[`Energy E${i}`] = n / 1000.0;
    }
  }

  return values;
}

function appendArchiveData(data, timestamp = Date.now()) {
  const archive = loadArchive();
  let added = 0;

  for (const [addr, dev] of Object.entries(data)) {
    const values = collectTrendValues(dev);
    if (!Object.keys(values).length) {
      continue;
    }

    const points = archive.devices[addr] || [];
    points.push({ ts: timestamp, values });
    archive.devices[addr] = points.slice(-ARCHIVE_MAX_POINTS_PER_DEVICE);
    added += 1;
  }

  if (!added) {
    return { added: 0, saved: true };
  }

  return { added, saved: saveArchive(archive) };
}

function trendUnit(param) {
  if (param === "Batt") {
    return "%";
  }
  if (param === "RSSI") {
    return " dBm";
  }
  if (param.startsWith("Thermo T") || param.startsWith("Humi T")) {
    return " C";
  }
  if (param.startsWith("Humi H")) {
    return "%";
  }
  if (param.startsWith("Energy E")) {
    return " kWh";
  }
  return "";
}

function formatTrendValue(value, param) {
  const digits = param.startsWith("Energy E") ? 3 : 1;
  return `${Number(value).toFixed(digits)}${trendUnit(param)}`;
}

function formatTrendTime(ts) {
  return new Date(ts).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function csvCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function archiveCsvFilename(scope = "archive") {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `tplung-${scope}-${stamp}.csv`;
}

function collectArchiveParams(archive) {
  const params = new Set();
  for (const points of Object.values(archive.devices)) {
    for (const point of points || []) {
      for (const param of Object.keys(point.values || {})) {
        params.add(param);
      }
    }
  }
  return [...params].sort((a, b) => a.localeCompare(b, "ru-RU", { numeric: true }));
}

function buildArchiveCsvRows(devicePointsList, params) {
  const header = ["datetime_iso", "datetime_local", "device", ...params];
  const rows = [header];

  for (const { device, points: sourcePoints } of devicePointsList) {
    const points = [...(sourcePoints || [])].sort((a, b) => a.ts - b.ts);
    for (const point of points) {
      const date = new Date(point.ts);
      rows.push([
        date.toISOString(),
        formatTrendTime(point.ts),
        device,
        ...params.map((param) => point.values?.[param] ?? "")
      ]);
    }
  }

  return rows.map((row) => row.map(csvCell).join(";")).join("\r\n");
}

function buildArchiveCsv(archive) {
  const params = collectArchiveParams(archive);
  const devicePointsList = Object.keys(archive.devices)
    .sort()
    .map((device) => ({ device, points: archive.devices[device] || [] }));
  return buildArchiveCsvRows(devicePointsList, params);
}

function downloadArchiveCsv(csv, filename, pointCount, label) {
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  logLine(`${label}: ${pointCount} точек`);
}

function exportArchiveCsv() {
  const archive = loadArchive();
  const pointCount = Object.values(archive.devices).reduce((total, points) => total + (points?.length || 0), 0);
  if (!pointCount) {
    logLine("Архив пуст, экспортировать нечего");
    return;
  }

  downloadArchiveCsv(buildArchiveCsv(archive), archiveCsvFilename("archive"), pointCount, "Экспорт всего CSV");
}

function exportVisibleArchiveCsv() {
  const archive = loadArchive();
  const selectedDevice = ui.trendDeviceSelect.value;
  const selectedParams = getSelectedTrendParams();
  const points = selectedDevice ? archive.devices[selectedDevice] || [] : [];

  if (!selectedDevice || !points.length) {
    logLine("Нет выбранного устройства для экспорта");
    return;
  }
  if (!selectedParams.length) {
    logLine("Выберите параметры для экспорта");
    return;
  }

  const filtered = filterTrendPointsByTime(points);
  const visiblePoints = filtered.points.filter((point) => selectedParams.some((param) => numericValue(point.values?.[param]) !== null));
  if (!visiblePoints.length) {
    logLine("В выбранном периоде нет точек для экспорта");
    return;
  }

  const csv = buildArchiveCsvRows([{ device: selectedDevice, points: visiblePoints }], selectedParams);
  downloadArchiveCsv(csv, archiveCsvFilename("visible"), visiblePoints.length, `Экспорт видимого CSV (${filtered.label})`);
}

function getLatestArchiveParams(points) {
  const latestPoint = [...points].reverse().find((point) => point.values && Object.keys(point.values).length);
  if (!latestPoint) {
    return [];
  }
  return Object.keys(latestPoint.values).sort((a, b) => a.localeCompare(b, "ru-RU", { numeric: true }));
}

function setSelectOptions(select, values, emptyText, labelFor = (value) => value, preferredValue = null) {
  const previous = select.value;
  select.innerHTML = "";

  if (!values.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = emptyText;
    select.appendChild(opt);
    select.disabled = true;
    return "";
  }

  for (const value of values) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = labelFor(value);
    select.appendChild(opt);
  }
  select.disabled = false;
  select.value = preferredValue && values.includes(preferredValue)
    ? preferredValue
    : values.includes(previous)
      ? previous
      : values[0];
  return select.value;
}

function getSelectedTrendParams() {
  return [...ui.trendParamList.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
}

function setTrendParamButtonText(selectedCount, totalCount) {
  if (!totalCount) {
    ui.trendParamButton.textContent = "Нет параметров";
    return;
  }
  ui.trendParamButton.textContent = selectedCount ? `Выбрано: ${selectedCount}` : "Выберите параметры";
}

function setParamChecklistOptions(values, emptyText, labelFor = (value) => value, preferredValues = null) {
  const hasPreferredValues = Array.isArray(preferredValues);
  const previous = hasPreferredValues ? preferredValues : getSelectedTrendParams();
  ui.trendParamList.innerHTML = "";

  if (!values.length) {
    const empty = document.createElement("div");
    empty.className = "trend-param-empty";
    empty.textContent = emptyText;
    ui.trendParamList.appendChild(empty);
    ui.trendParamButton.disabled = true;
    setTrendParamButtonText(0, 0);
    return [];
  }

  let selected = previous.filter((value) => values.includes(value));
  if (!selected.length && (!hasPreferredValues || previous.length)) {
    selected = [values[0]];
  }

  ui.trendParamButton.disabled = false;
  for (const value of values) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = value;
    checkbox.checked = selected.includes(value);
    checkbox.addEventListener("change", () => {
      setTrendParamButtonText(getSelectedTrendParams().length, values.length);
      saveLivePrefs();
      renderSelectedTrendChart();
    });
    label.append(checkbox, document.createTextNode(labelFor(value)));
    ui.trendParamList.appendChild(label);
  }

  setTrendParamButtonText(selected.length, values.length);
  return selected;
}

function trendColor(idx) {
  const colors = ["#f2b84b", "#55c7d8", "#4bd08f", "#ef6d6d", "#c59cff", "#f28ec4"];
  return colors[idx % colors.length];
}

function buildTrendSeries(points, param) {
  return points
    .map((point) => ({ ts: point.ts, value: numericValue(point.values?.[param]) }))
    .filter((point) => point.value !== null)
    .sort((a, b) => a.ts - b.ts);
}

function getTrendTimeRange() {
  return TREND_TIME_RANGES[ui.trendTimeRange.value] || TREND_TIME_RANGES.all;
}

function filterTrendPointsByTime(points) {
  const range = getTrendTimeRange();
  if (!range.ms || points.length < 2) {
    return { points, label: range.label };
  }

  const maxTs = Math.max(...points.map((point) => point.ts));
  const minTs = maxTs - range.ms;
  return {
    points: points.filter((point) => point.ts >= minTs && point.ts <= maxTs),
    label: range.label
  };
}

function renderTrendChart(points, params, totalPoints = points.length, rangeLabel = "весь архив") {
  const selectedDevice = ui.trendDeviceSelect.value;
  const names = loadNames();
  const seriesList = params
    .map((param) => ({ param, series: buildTrendSeries(points, param) }))
    .filter((item) => item.series.length);

  const maxPoints = Math.max(0, ...seriesList.map((item) => item.series.length));
  if (!seriesList.length || maxPoints < 2) {
    ui.trendSummary.textContent = `${maxPoints} из ${totalPoints} точек, ${rangeLabel}`;
    ui.trendChart.innerHTML = '<div class="empty">Недостаточно точек для графика</div>';
    return;
  }

  const width = 760;
  const height = 280;
  const padLeft = 58;
  const padRight = 18;
  const padTop = 18;
  const padBottom = 42;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const allPoints = seriesList.flatMap((item) => item.series);
  const minTs = Math.min(...allPoints.map((point) => point.ts));
  const maxTs = Math.max(...allPoints.map((point) => point.ts));
  let minValue = Math.min(...allPoints.map((point) => point.value));
  let maxValue = Math.max(...allPoints.map((point) => point.value));

  if (minValue === maxValue) {
    minValue -= 1;
    maxValue += 1;
  }

  const valuePad = (maxValue - minValue) * 0.08;
  minValue -= valuePad;
  maxValue += valuePad;

  const x = (ts, idx) => {
    if (maxTs === minTs) {
      return padLeft + (idx / Math.max(1, maxPoints - 1)) * plotWidth;
    }
    return padLeft + ((ts - minTs) / (maxTs - minTs)) * plotWidth;
  };
  const y = (value) => padTop + ((maxValue - value) / (maxValue - minValue)) * plotHeight;
  const seriesSvg = seriesList.map((item, itemIdx) => {
    const color = trendColor(itemIdx);
    const path = item.series.map((point, idx) => `${x(point.ts, idx).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
    const circles = item.series.length <= 80
      ? item.series.map((point, idx) => {
        const cx = x(point.ts, idx).toFixed(1);
        const cy = y(point.value).toFixed(1);
        const title = escapeHtml(`${item.param}: ${formatTrendValue(point.value, item.param)}\n${formatTrendTime(point.ts)}`);
        return `<g class="trend-point"><title>${title}</title><circle class="trend-hit" cx="${cx}" cy="${cy}" r="8" /><circle class="trend-dot" cx="${cx}" cy="${cy}" r="2.6" style="fill: ${color}" /></g>`;
      }).join("")
      : "";
    return `<polyline class="trend-line" style="stroke: ${color}" points="${path}" /><g class="trend-points">${circles}</g>`;
  }).join("");
  const legend = seriesList.map((item, idx) => {
    const latest = item.series[item.series.length - 1];
    const paramLabel = selectedDevice ? displayParamName(selectedDevice, item.param, names) : item.param;
    return `<span><i style="background: ${trendColor(idx)}"></i>${escapeHtml(paramLabel)}: ${escapeHtml(formatTrendValue(latest.value, item.param))}</span>`;
  }).join("");

  ui.trendSummary.textContent = `${seriesList.length} параметров, до ${maxPoints} из ${totalPoints} точек, ${rangeLabel}`;
  ui.trendChart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Тренд ${escapeHtml(params.map((param) => selectedDevice ? displayParamName(selectedDevice, param, names) : param).join(", "))}">
      <line class="trend-axis" x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${height - padBottom}" />
      <line class="trend-axis" x1="${padLeft}" y1="${height - padBottom}" x2="${width - padRight}" y2="${height - padBottom}" />
      <line class="trend-grid-line" x1="${padLeft}" y1="${padTop + plotHeight / 2}" x2="${width - padRight}" y2="${padTop + plotHeight / 2}" />
      <text class="trend-label" x="8" y="${padTop + 5}">${maxValue.toFixed(1)}</text>
      <text class="trend-label" x="8" y="${height - padBottom}">${minValue.toFixed(1)}</text>
      <text class="trend-label" x="${padLeft}" y="${height - 12}">${formatTrendTime(minTs)}</text>
      <text class="trend-label trend-label-end" x="${width - padRight}" y="${height - 12}">${formatTrendTime(maxTs)}</text>
      ${seriesSvg}
    </svg>
    <div class="trend-legend">${legend}</div>
  `;
}

function renderSelectedTrendChart() {
  const archive = loadArchive();
  const selectedDevice = ui.trendDeviceSelect.value;
  const selectedParams = getSelectedTrendParams();
  const points = selectedDevice ? archive.devices[selectedDevice] || [] : [];

  if (!selectedDevice || !points.length) {
    ui.trendSummary.textContent = "Архив пуст";
    ui.trendChart.innerHTML = '<div class="empty">Тренды появятся после получения данных</div>';
    return;
  }

  if (!selectedParams.length) {
    ui.trendSummary.textContent = "Параметры не выбраны";
    ui.trendChart.innerHTML = '<div class="empty">Отметьте один или несколько параметров</div>';
    return;
  }

  const filtered = filterTrendPointsByTime(points);
  renderTrendChart(filtered.points, selectedParams, points.length, filtered.label);
}

function refreshTrendView() {
  const archive = loadArchive();
  const names = loadNames();
  const prefs = loadLivePrefs();
  const devices = Object.keys(archive.devices).filter((addr) => archive.devices[addr]?.length).sort();
  const selectedDevice = setSelectOptions(
    ui.trendDeviceSelect,
    devices,
    "Нет данных",
    (addr) => displayDeviceName(addr, names),
    prefs.trendDevice
  );

  if (!selectedDevice) {
    setParamChecklistOptions([], "Нет параметров");
    ui.trendSummary.textContent = "Архив пуст";
    ui.trendChart.innerHTML = '<div class="empty">Тренды появятся после получения данных</div>';
    return;
  }

  const points = archive.devices[selectedDevice] || [];
  const latestParams = getLatestArchiveParams(points);
  const hasSavedTrendParams = Object.prototype.hasOwnProperty.call(prefs.trendParamsByDevice, selectedDevice);
  const preferredTrendParams = hasSavedTrendParams ? prefs.trendParamsByDevice[selectedDevice] : [latestParams[0]];
  const selectedParams = setParamChecklistOptions(
    latestParams,
    "Нет актуальных параметров",
    (param) => displayParamName(selectedDevice, param, names),
    preferredTrendParams
  );
  if (!latestParams.length) {
    ui.trendSummary.textContent = `${points.length} точек в архиве`;
    ui.trendChart.innerHTML = '<div class="empty">В последней записи выбранного MAC нет параметров</div>';
    saveLivePrefs({ trendDevice: selectedDevice });
    return;
  }
  if (!selectedParams.length) {
    ui.trendSummary.textContent = "Параметры не выбраны";
    ui.trendChart.innerHTML = '<div class="empty">Отметьте один или несколько параметров</div>';
    saveLivePrefs({ trendDevice: selectedDevice });
    return;
  }

  const filtered = filterTrendPointsByTime(points);
  renderTrendChart(filtered.points, selectedParams, points.length, filtered.label);
  saveLivePrefs({ trendDevice: selectedDevice });
}

function renderCards(data) {
  ui.cards.innerHTML = "";
  const addrs = Object.keys(data).sort();
  const names = loadNames();
  const alerts = evaluateAlertRules(data);
  const alertKeys = new Set(alerts.map((alert) => alertKey(alert.device, alert.param)));
  renderAlertNotifications(alerts);

  if (!addrs.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Нет данных, выполните сканирование";
    ui.cards.appendChild(empty);
    return;
  }

  for (const addr of addrs) {
    const dev = data[addr];
    const node = ui.cardTemplate.content.firstElementChild.cloneNode(true);

    node.querySelector(".dev-title").textContent = displayDeviceName(addr, names);

    const head = node.querySelector(".head-chips");
    if (dev.RSSI !== null && dev.RSSI !== undefined) {
      const cls = [rssiClass(Number(dev.RSSI) || -120)];
      if (alertKeys.has(alertKey(addr, "RSSI"))) {
        cls.push("alert-chip");
      }
      head.appendChild(chip(`RSSI ${dev.RSSI}`, cls.join(" ")));
    }
    if (dev.batt !== null && dev.batt !== undefined) {
      const battPct = batteryPercentFromState(dev.batt);
      if (battPct !== null) {
        const cls = [batteryClass(dev.batt)];
        if (alertKeys.has(alertKey(addr, "Batt"))) {
          cls.push("alert-chip");
        }
        head.appendChild(chip(`Batt ${battPct}%`, cls.join(" ")));
      }
    }
    if (dev.PacketTime !== undefined) {
      head.appendChild(chip(`Time ${formatPacketTime(dev.PacketTime, dev.PacketTimeRawBytes)}`));
    }

    const w1Signal = !!(dev.Thermo?.flags & FLAG_DATA_W1_THERM_SIGNAL_MASK);
    const thermistorSignal = !!(dev.Humi?.flags & FLAG_DATA_THERMISTOR_SIGNAL_MASK);
    const hr202Signal = !!(dev.Humi?.flags & FLAG_DATA_HR202_SIGNAL_MASK);
    if (w1Signal) {
      head.appendChild(chip("W1 signal", "signal-chip"));
    }
    if (thermistorSignal) {
      head.appendChild(chip("Thermistor signal", "signal-chip"));
    }
    if (hr202Signal) {
      head.appendChild(chip("HR202 signal", "signal-chip"));
    }

    const measureGrid = node.querySelector(".measure-grid");
    for (let i = 0; i < 8; i += 1) {
      const param = `Thermo T${i}`;
      const tv = dev.Thermo?.[`T${i}`];
      if (tv !== null && tv !== undefined) {
        const cls = [w1Signal ? "signal-tile" : ""];
        if (alertKeys.has(alertKey(addr, param))) {
          cls.push("threshold-tile");
        }
        measureGrid.appendChild(tile(displayParamName(addr, param, names), Number(tv).toFixed(1), " C", cls.join(" ")));
      }
    }

    for (let i = 0; i < 8; i += 1) {
      const tempParam = `Humi T${i}`;
      const tv = dev.Humi?.[`T${i}`];
      if (tv !== null && tv !== undefined) {
        const cls = [thermistorSignal ? "signal-tile" : ""];
        if (alertKeys.has(alertKey(addr, tempParam))) {
          cls.push("threshold-tile");
        }
        measureGrid.appendChild(tile(displayParamName(addr, tempParam, names), Number(tv).toFixed(1), " C", cls.join(" ")));
      }
      const humiParam = `Humi H${i}`;
      const hv = dev.Humi?.[`H${i}`];
      if (hv !== null && hv !== undefined) {
        const cls = [hr202Signal ? "signal-tile" : ""];
        if (alertKeys.has(alertKey(addr, humiParam))) {
          cls.push("threshold-tile");
        }
        measureGrid.appendChild(tile(displayParamName(addr, humiParam, names), Number(hv).toFixed(1), " %", cls.join(" ")));
      }
    }

    const energyGrid = node.querySelector(".energy-grid");
    for (let pairIndex = 0; pairIndex < 2; pairIndex += 1) {
      const tarif1 = dev.Energomera?.[`E${pairIndex * 2}`];
      const tarif2 = dev.Energomera?.[`E${pairIndex * 2 + 1}`];
      if (tarif1 !== null && tarif1 !== undefined || tarif2 !== null && tarif2 !== undefined) {
        energyGrid.appendChild(energyCounter(pairIndex, tarif1, tarif2, addr, alertKeys, names));
      }
    }

    ui.cards.appendChild(node);
  }
}

function renderCardsMessage(text) {
  ui.cards.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = text;
  ui.cards.appendChild(empty);
}

function selectedPortLabel() {
  const option = ui.portSelect.selectedOptions?.[0];
  const text = option?.textContent?.trim();
  return text && ui.portSelect.value !== "" ? text : "выбранный порт";
}

function setStatus(connected) {
  ui.statusBadge.textContent = connected ? "Подключено" : "Не подключено";
  ui.statusBadge.classList.toggle("badge-on", connected);
  ui.statusBadge.classList.toggle("badge-off", !connected);
  ui.connectBtn.disabled = connected;
  ui.disconnectBtn.disabled = !connected;
  ui.scanBtn.disabled = !connected;
}

function logLine(text) {
  ui.logLine.textContent = text;
}

function setControlsDisabled(disabled) {
  ui.addPortBtn.disabled = disabled;
  ui.refreshPortsBtn.disabled = disabled;
  ui.connectBtn.disabled = disabled;
  ui.disconnectBtn.disabled = true;
  ui.scanBtn.disabled = true;
}

function ensureSecureContext() {
  if (window.isSecureContext) {
    return true;
  }

  setControlsDisabled(true);
  ui.statusBadge.textContent = "Небезопасный контекст";
  ui.statusBadge.classList.remove("badge-on");
  ui.statusBadge.classList.add("badge-off");
  logLine("Откройте через http://localhost:8080 или https:// (не file://)");
  return false;
}

async function doScan() {
  if (!client.connected) {
    return;
  }
  const scanSec = clampInt(Number(ui.scanSec.value), 3, 60, 10);
  const scanEnabled = ui.scanPhase.checked;
  const measureEnabled = ui.measurePhase.checked;
  if (!scanEnabled && !measureEnabled) {
    logLine("Выберите сканирование, измерение или оба режима");
    return;
  }

  const modeText = scanEnabled && measureEnabled
    ? `сканирование ${scanSec} сек + измерение`
    : scanEnabled
      ? `сканирование ${scanSec} сек`
      : "измерение";
  try {
    ui.scanBtn.disabled = true;
    logLine(`Выполняется: ${modeText}...`);
    const data = await client.scan(scanSec, { scanEnabled, measureEnabled });
    if (data) {
      const deviceCount = Object.keys(data).length;
      if (!deviceCount) {
        currentLiveData = {};
        const portText = selectedPortLabel();
        renderCardsMessage(`Порт ${portText} не отвечает: проверьте, что выбран правильный USB-донгл и устройство отвечает на команды.`);
        refreshLiveTools({ keepNameDrafts: true });
        ui.lastUpdate.textContent = `Обновление: ${new Date().toLocaleTimeString()}`;
        logLine(`Порт ${portText} не отвечает`);
        return;
      }
      currentLiveData = data;
      updateLastSeen(data);
      const archiveResult = appendArchiveData(data);
      renderCards(data);
      refreshTrendView();
      refreshLiveTools({ keepNameDrafts: true });
      ui.lastUpdate.textContent = `Обновление: ${new Date().toLocaleTimeString()}`;
      const archiveText = archiveResult.saved ? `архив +${archiveResult.added}` : "архив не сохранен";
      logLine(`Готово: устройств ${deviceCount}, ${archiveText}`);
    }
  } catch (e) {
    logLine(`Ошибка скана: ${e.message}`);
  } finally {
    ui.scanBtn.disabled = !client.connected;
  }
}

ui.connectBtn.addEventListener("click", async () => {
  try {
    let selectedPort = null;
    const selectedIndex = Number(ui.portSelect.value);
    if (!Number.isNaN(selectedIndex) && selectedIndex >= 0 && selectedIndex < client.knownPorts.length) {
      selectedPort = client.knownPorts[selectedIndex];
    }

    if (!selectedPort) {
      selectedPort = await client.requestNewPort();
      await refreshPortList();
    }

    await client.connect(FIXED_BAUD_RATE, selectedPort);
    setStatus(true);
    logLine("Порт подключен (USB 12\u00a0Мбит/с)");
    currentLiveData = {};
    renderCards({});
    refreshLiveTools({ keepNameDrafts: true });
    if (ui.autoRefresh.checked) {
      client.startAutoRefresh(doScan);
    }
  } catch (e) {
    logLine(`Ошибка подключения: ${e.message}`);
  }
});

ui.addPortBtn.addEventListener("click", async () => {
  try {
    await client.requestNewPort();
    await refreshPortList();
    logLine("Порт добавлен в разрешенные");
  } catch (e) {
    logLine(`Добавление порта отменено или не удалось: ${e.message}`);
  }
});

ui.disconnectBtn.addEventListener("click", async () => {
  try {
    await client.stopScanAndMeasure();
  } catch (_e) {
  }
  await client.disconnect();
  setStatus(false);
  logLine("Сканирование и измерение остановлены, порт отключен");
});

ui.refreshPortsBtn.addEventListener("click", async () => {
  try {
    await refreshPortList();
    logLine("Список портов обновлен");
  } catch (e) {
    logLine(`Ошибка обновления портов: ${e.message}`);
  }
});

ui.scanBtn.addEventListener("click", doScan);

ui.scanSec.addEventListener("change", () => {
  clampInputValue(ui.scanSec, 3, 60, 10);
  saveLivePrefs();
});
ui.scanPhase.addEventListener("change", () => saveLivePrefs());
ui.measurePhase.addEventListener("change", () => saveLivePrefs());

ui.trendDeviceSelect.addEventListener("change", () => {
  saveLivePrefs({ trendDevice: ui.trendDeviceSelect.value, skipTrendParams: true });
  refreshTrendView();
});
ui.trendTimeRange.addEventListener("change", () => {
  saveLivePrefs();
  renderSelectedTrendChart();
});
ui.trendParamButton.addEventListener("click", () => {
  ui.trendParamList.hidden = !ui.trendParamList.hidden;
});
document.addEventListener("click", (event) => {
  if (ui.trendParamList.hidden) {
    return;
  }

  const target = event.target;
  if (ui.trendParamButton.contains(target) || ui.trendParamList.contains(target)) {
    return;
  }

  ui.trendParamList.hidden = true;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    ui.trendParamList.hidden = true;
  }
});
ui.clearArchiveBtn.addEventListener("click", () => {
  localStorage.removeItem(ARCHIVE_STORAGE_KEY);
  refreshTrendView();
  refreshLiveTools({ keepNameDrafts: true });
  logLine("Архив трендов очищен");
});

ui.nameDeviceSelect.addEventListener("change", refreshNameEditor);
ui.nameParamSelect.addEventListener("change", () => refreshNameEditor({ keepDeviceName: true }));
ui.saveNamesBtn.addEventListener("click", () => {
  const addr = ui.nameDeviceSelect.value;
  if (!addr) {
    return;
  }

  const param = ui.nameParamSelect.value;
  const deviceName = ui.deviceNameInput.value.trim();
  const paramName = ui.paramNameInput.value.trim();
  const names = loadNames();
  const entry = names.devices[addr] || { channels: {} };
  entry.channels = entry.channels || {};

  if (deviceName) {
    entry.name = deviceName;
  } else {
    delete entry.name;
  }

  if (param) {
    if (paramName) {
      entry.channels[param] = paramName;
    } else {
      delete entry.channels[param];
    }
  }

  if (!entry.name && !Object.keys(entry.channels).length) {
    delete names.devices[addr];
  } else {
    names.devices[addr] = entry;
  }

  saveNames(names);
  renderCards(currentLiveData);
  refreshTrendView();
  refreshLiveTools();
  logLine("Имена устройств и каналов сохранены");
});

ui.clearNamesBtn.addEventListener("click", () => {
  localStorage.removeItem(NAMES_STORAGE_KEY);
  renderCards(currentLiveData);
  refreshTrendView();
  refreshLiveTools();
  logLine("Локальные имена сброшены");
});

ui.alertDeviceSelect.addEventListener("change", refreshAlertEditor);
ui.addAlertRuleBtn.addEventListener("click", () => {
  const device = ui.alertDeviceSelect.value;
  const param = ui.alertParamSelect.value || "*";
  const min = numericValue(ui.alertMinInput.value);
  const max = numericValue(ui.alertMaxInput.value);
  const offlineMin = numericValue(ui.alertOfflineInput.value);

  if (!device) {
    logLine("Выберите устройство для порога");
    return;
  }
  if ((min !== null || max !== null) && param === "*") {
    logLine("Выберите параметр для Min/Max порога");
    return;
  }
  if (min === null && max === null && offlineMin === null) {
    logLine("Укажите Min, Max или время отсутствия данных");
    return;
  }
  if (min !== null && max !== null && min > max) {
    logLine("Min не должен быть больше Max");
    return;
  }
  if (offlineMin !== null && offlineMin < 1) {
    logLine("Время отсутствия данных должно быть не меньше 1 минуты");
    return;
  }

  const rules = loadAlertRules();
  rules.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    device,
    param,
    min,
    max,
    offlineMin,
    enabled: true
  });
  saveAlertRules(rules);
  ui.alertMinInput.value = "";
  ui.alertMaxInput.value = "";
  ui.alertOfflineInput.value = "";
  renderAlertRulesList();
  renderCards(currentLiveData);
  logLine("Пороговое правило добавлено");
});

ui.exportArchiveBtn.addEventListener("click", exportArchiveCsv);
ui.exportVisibleArchiveBtn.addEventListener("click", exportVisibleArchiveCsv);

ui.autoRefresh.addEventListener("change", () => {
  saveLivePrefs();
  if (!ui.autoRefresh.checked) {
    client.stopAutoRefresh();
    logLine("Автообновление выключено");
    return;
  }

  client.startAutoRefresh(doScan);
  logLine(`Автообновление включено (${ui.autoSec.value} сек)`);
});

ui.autoSec.addEventListener("change", () => {
  clampInputValue(ui.autoSec, 5, 180, 15);
  saveLivePrefs();
  if (ui.autoRefresh.checked) {
    client.startAutoRefresh(doScan);
    logLine(`Новый интервал автообновления: ${ui.autoSec.value} сек`);
  }
});

window.addEventListener("beforeunload", async () => {
  await client.disconnect();
});

if ("serial" in navigator && navigator.serial.addEventListener) {
  navigator.serial.addEventListener("connect", () => {
    refreshPortList().catch(() => {});
  });

  navigator.serial.addEventListener("disconnect", () => {
    refreshPortList().catch(() => {});
  });
}

applyLivePrefs();
setStatus(false);
renderCards({});
refreshTrendView();
refreshLiveTools();
if (ensureSecureContext()) {
  refreshPortList().catch(() => {
    logLine("Не удалось получить список портов");
  });
}