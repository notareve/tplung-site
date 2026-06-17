const ui = {
  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  addPortBtn: document.getElementById("addPortBtn"),
  refreshPortsBtn: document.getElementById("refreshPortsBtn"),
  portSelect: document.getElementById("portSelect"),
  statusBadge: document.getElementById("statusBadge"),
  firmwareVersion: document.getElementById("firmwareVersion"),
  logLine: document.getElementById("logLine"),
  currentTimeBtn: document.querySelector('[name="currentTime"]'),
  readSettingsBtn: document.getElementById("readSettingsBtn"),
  writeSettingsBtn: document.getElementById("writeSettingsBtn")
};

const FIXED_BAUD_RATE = 115200;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const SETTINGS_SIZE = 86;
const FIRM_VERSION = 0x0302;
const STOP_SCAN_COMMAND = "at01\r\n";
const STOP_MEASURE_COMMAND = "at03\r\n";

const PARAM_HINTS = {
  currentTime: "Записать в RTC устройства текущее время компьютера.",
  periodicMeasurement: "Включает автоматические измерения по заданному периоду.",
  autoMeasurement: "Интервал между автоматическими измерениями, в секундах.",
  timeLimited: "Ограничивает время активной работы после события или запуска.",
  timeLimit: "Длительность ограничения активности, в секундах.",
  advMin: "Минимальный интервал BLE advertising, в миллисекундах.",
  advMax: "Максимальный интервал BLE advertising, в миллисекундах.",
  txPower: "Мощность BLE-передатчика: больше значение - дальше связь и выше расход.",
  advertType: "Формат BLE advertising: Kompius или Home Assistant v2.",
  passKey: "PIN/ключ доступа для защищенных операций настройки.",
  w1Therm: "Включает канал 1-Wire датчиков температуры DS18x20.",
  w1ThermAdv: "Добавляет данные 1-Wire температур в BLE advertising.",
  w1ThermSignal: "Включает сигнал тревоги по условию температуры 1-Wire.",
  w1ThermTmax: "Порог температуры для условия тревоги 1-Wire.",
  w1ThermCondition: "Какой канал 1-Wire сравнивать с Tmax.",
  thermistors: "Включает аналоговые термисторные каналы температуры.",
  thermistorsCount: "Количество используемых термисторных каналов.",
  thermistorSignal: "Включает сигнал тревоги по условию термистора.",
  analogTmin: "Нижний порог температуры для аналогового канала.",
  analogTmax: "Верхний порог температуры для аналогового канала.",
  analogTcondition: "Какой аналоговый температурный канал сравнивать с порогами.",
  hr202: "Включает датчик влажности HR202.",
  hr202Signal: "Включает сигнал тревоги по условию влажности HR202.",
  analogHmin: "Нижний порог влажности HR202.",
  analogHmax: "Верхний порог влажности HR202.",
  analogHcondition: "Какой канал влажности сравнивать с порогами.",
  thermistorAdv: "Добавляет аналоговые датчики в BLE advertising.",
  energoCounter1: "Включает опрос первого счетчика Энергомера.",
  energoCounter1Mac: "MAC-адрес первого счетчика Энергомера.",
  energoCounter1Pin: "PIN первого счетчика Энергомера.",
  energoCounter2: "Включает опрос второго счетчика Энергомера.",
  energoCounter2Mac: "MAC-адрес второго счетчика Энергомера.",
  energoCounter2Pin: "PIN второго счетчика Энергомера.",
  energoCounterAdv: "Добавляет показания Энергомеры в BLE advertising."
};

const FLAGS = {
  autoMeas: 0x0001,
  timeLimited: 0x0004,
  advertTypeMask: 0x0030,
  advertTypeShift: 4,
  w1Therm: 0x0001,
  w1ThermAdv: 0x0002,
  w1Signal: 0x0004,
  thermistor: 0x0001,
  hr202: 0x0002,
  analogAdv: 0x0004,
  thermistorSignal: 0x0008,
  hr202Signal: 0x0010,
  energoCounter1: 0x0001,
  energoCounter2: 0x0002,
  energoAdv: 0x0004
};

const TX_POWER_VALUES = [0x01, 0x03, 0x05, 0x07, 0x0B, 0x0F, 0x13, 0x15, 0x1B, 0x23, 0x2B, 0x3B];

const OFFSETS = {
  general: 0,
  w1: 20,
  analog: 27,
  energo: 56
};

let currentSettingsBytes = null;

class FirmwareSerialClient {
  constructor() {
    this.port = null;
    this.knownPorts = [];
    this.reader = null;
    this.writer = null;
    this.readLoopTask = null;
    this.lineBuffer = "";
    this.lineWaiters = [];
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

  async connect(selectedPort = null) {
    if (!("serial" in navigator)) {
      throw new Error("Web Serial API не поддерживается в этом браузере");
    }

    this.port = selectedPort || await this.requestNewPort();
    await this.port.open({ baudRate: FIXED_BAUD_RATE, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.readLoopTask = this.readLoop();
  }

  async disconnect() {
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
          this.processIncoming(value);
        }
      }
    } catch (_e) {
    }
  }

  processIncoming(bytes) {
    const text = decoder.decode(bytes, { stream: true });
    this.lineBuffer += text;

    while (this.lineBuffer.includes("\n")) {
      const eol = this.lineBuffer.indexOf("\n");
      const line = this.lineBuffer.slice(0, eol).replace(/\r$/, "");
      this.lineBuffer = this.lineBuffer.slice(eol + 1);
      this.handleLine(line);
    }

    if (!text.includes("\n")) {
      logLine(`Ответ USB: ${formatBytes(bytes)}`);
    }
  }

  handleLine(line) {
    if (!line) {
      return;
    }

    logLine(`Ответ USB: ${line}`);

    for (const waiter of [...this.lineWaiters]) {
      if (waiter.matcher(line)) {
        clearTimeout(waiter.timer);
        this.lineWaiters = this.lineWaiters.filter((item) => item !== waiter);
        waiter.resolve(line);
        break;
      }
    }
  }

  async send(text) {
    if (!this.writer) {
      throw new Error("Порт не подключен");
    }
    await this.writer.write(encoder.encode(text));
  }

  waitForLine(matcher, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const waiter = {
        matcher,
        resolve,
        timer: window.setTimeout(() => {
          this.lineWaiters = this.lineWaiters.filter((item) => item !== waiter);
          reject(new Error("Таймаут ответа устройства"));
        }, timeoutMs)
      };
      this.lineWaiters.push(waiter);
    });
  }
}

const client = new FirmwareSerialClient();

function toHex(value) {
  if (value === undefined || value === null) {
    return "----";
  }
  return Number(value).toString(16).toUpperCase().padStart(4, "0");
}

function portLabel(port, index) {
  const info = port.getInfo ? port.getInfo() : {};
  const usb = info.usbVendorId || info.usbProductId
    ? `USB ${toHex(info.usbVendorId)}:${toHex(info.usbProductId)}`
    : "Serial device";
  return `${index + 1}. ${usb}`;
}

function formatBytes(bytes) {
  const text = decoder.decode(bytes).replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  const hex = [...bytes].map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
  return text.trim() ? `${text}  [${hex}]` : `[${hex}]`;
}

function setStatus(connected) {
  ui.statusBadge.textContent = connected ? "Подключено" : "Не подключено";
  ui.statusBadge.classList.toggle("badge-on", connected);
  ui.statusBadge.classList.toggle("badge-off", !connected);
  ui.connectBtn.disabled = connected;
  ui.disconnectBtn.disabled = !connected;
  ui.currentTimeBtn.disabled = !connected;
  ui.readSettingsBtn.disabled = !connected;
  ui.writeSettingsBtn.disabled = !connected || !currentSettingsBytes;
}

function logLine(text) {
  ui.logLine.textContent = text;
}

function setFirmwareVersion(version) {
  if (version === undefined || version === null) {
    ui.firmwareVersion.textContent = "FW --";
    return;
  }

  const major = (version >> 8) & 0xFF;
  const minor = version & 0xFF;
  const hex = version.toString(16).toUpperCase().padStart(4, "0");
  ui.firmwareVersion.textContent = `FW ${major}.${String(minor).padStart(2, "0")} (0x${hex})`;
}

function setControlsDisabled(disabled) {
  ui.addPortBtn.disabled = disabled;
  ui.refreshPortsBtn.disabled = disabled;
  ui.connectBtn.disabled = disabled;
  ui.disconnectBtn.disabled = true;
  ui.currentTimeBtn.disabled = true;
  ui.readSettingsBtn.disabled = true;
  ui.writeSettingsBtn.disabled = true;
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

async function refreshPortList() {
  if (!("serial" in navigator)) {
    ui.portSelect.innerHTML = "";
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Web Serial API не поддерживается";
    ui.portSelect.appendChild(option);
    ui.portSelect.disabled = true;
    return;
  }

  const ports = await client.loadKnownPorts();
  ui.portSelect.innerHTML = "";

  if (!ports.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Нет разрешенных портов, нажмите Добавить порт";
    ui.portSelect.appendChild(option);
    ui.portSelect.disabled = true;
    return;
  }

  ports.forEach((port, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = portLabel(port, index);
    ui.portSelect.appendChild(option);
  });
  ui.portSelect.disabled = false;
}

async function sendCommand(command) {
  const payload = command;
  await client.send(payload);
  logLine(`Команда отправлена: ${payload}`);
}

async function stopScanAndMeasure() {
  if (!client.connected) {
    return;
  }
  await client.send(STOP_SCAN_COMMAND);
  await client.send(STOP_MEASURE_COMMAND);
}

function applyParameterHints() {
  for (const [name, hint] of Object.entries(PARAM_HINTS)) {
    const control = document.querySelector(`[name="${name}"]`);
    const row = control?.closest(".setting-row");
    const label = row?.querySelector("span");
    if (!control || !label) {
      continue;
    }
    label.title = hint;
    control.title = hint;
    label.classList.add("hint-label");
  }
}

function activateSettingsTab(tabName) {
  document.querySelectorAll("[data-settings-tab]").forEach((tab) => {
    const active = tab.getAttribute("data-settings-tab") === tabName;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });

  document.querySelectorAll("[data-settings-screen]").forEach((screen) => {
    const active = screen.getAttribute("data-settings-screen") === tabName;
    screen.classList.toggle("active", active);
    screen.hidden = !active;
  });
}

function getControl(name) {
  return document.querySelector(`[name="${name}"]`);
}

function getNumber(name, min, max) {
  const value = Number(getControl(name).value);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Некорректное значение ${name}`);
  }
  return value;
}

function getPin(name) {
  const value = getControl(name).value.trim();
  if (!/^\d{6}$/.test(value)) {
    throw new Error(`PIN ${name} должен содержать 6 цифр`);
  }
  return value;
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("Некорректный hex в ответе устройства");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function setFlag(flags, mask, enabled) {
  return enabled ? (flags | mask) : (flags & ~mask);
}

function setCheckbox(name, enabled) {
  getControl(name).checked = !!enabled;
}

function readMac(view, offset) {
  const bytes = [];
  for (let index = 0; index < 6; index += 1) {
    bytes.unshift(view.getUint8(offset + index));
  }
  return bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(":");
}

function writeMac(view, offset, value) {
  const clean = value.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (clean.length !== 12) {
    throw new Error("MAC должен содержать 12 hex-символов");
  }

  const bytes = [];
  for (let index = 0; index < 6; index += 1) {
    bytes.push(Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16));
  }

  for (let index = 0; index < 6; index += 1) {
    view.setUint8(offset + index, bytes[5 - index]);
  }
  view.setUint8(offset + 6, 0);
  view.setUint8(offset + 7, 0);
}

function readPin(view, offset) {
  let value = "";
  for (let index = 0; index < 6; index += 1) {
    const byte = view.getUint8(offset + index);
    value += byte <= 9 ? String(byte) : String.fromCharCode(byte);
  }
  return /^\d{6}$/.test(value) ? value : "000000";
}

function writePin(view, offset, value) {
  for (let index = 0; index < 6; index += 1) {
    view.setUint8(offset + index, Number(value[index]));
  }
}

function populateForm(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const general = OFFSETS.general;
  const w1 = OFFSETS.w1;
  const analog = OFFSETS.analog;
  const energo = OFFSETS.energo;
  const generalFlags = view.getUint16(general + 12, true);
  const w1Flags = view.getUint16(w1, true);
  const analogFlags = view.getUint16(analog, true);
  const energoFlags = view.getUint16(energo, true);
  const txPowerIndex = TX_POWER_VALUES.indexOf(view.getUint8(general + 8));

  setCheckbox("periodicMeasurement", generalFlags & FLAGS.autoMeas);
  getControl("autoMeasurement").value = String(view.getUint16(general, true));
  setCheckbox("timeLimited", generalFlags & FLAGS.timeLimited);
  getControl("timeLimit").value = String(view.getUint16(general + 2, true));
  getControl("advMin").value = String(view.getUint16(general + 16, true));
  getControl("advMax").value = String(view.getUint16(general + 18, true));
  getControl("txPower").selectedIndex = txPowerIndex >= 0 ? txPowerIndex : 7;
  getControl("advertType").selectedIndex = (generalFlags & FLAGS.advertTypeMask) >> FLAGS.advertTypeShift;
  getControl("passKey").value = String(view.getUint32(general + 4, true)).padStart(6, "0");

  setCheckbox("w1Therm", w1Flags & FLAGS.w1Therm);
  setCheckbox("w1ThermAdv", w1Flags & FLAGS.w1ThermAdv);
  setCheckbox("w1ThermSignal", w1Flags & FLAGS.w1Signal);
  getControl("w1ThermTmax").value = view.getFloat32(w1 + 2, true).toFixed(2);
  getControl("w1ThermCondition").selectedIndex = view.getUint8(w1 + 6);

  setCheckbox("thermistors", analogFlags & FLAGS.thermistor);
  setCheckbox("hr202", analogFlags & FLAGS.hr202);
  setCheckbox("thermistorAdv", analogFlags & FLAGS.analogAdv);
  setCheckbox("thermistorSignal", analogFlags & FLAGS.thermistorSignal);
  setCheckbox("hr202Signal", analogFlags & FLAGS.hr202Signal);
  getControl("analogHmin").value = view.getFloat32(analog + 2, true).toFixed(2);
  getControl("analogHmax").value = view.getFloat32(analog + 6, true).toFixed(2);
  getControl("analogHcondition").selectedIndex = view.getUint8(analog + 10);
  getControl("analogTmin").value = view.getFloat32(analog + 11, true).toFixed(2);
  getControl("analogTmax").value = view.getFloat32(analog + 15, true).toFixed(2);
  getControl("analogTcondition").selectedIndex = view.getUint8(analog + 19);
  getControl("thermistorsCount").value = String(view.getUint8(analog + 28));

  setCheckbox("energoCounter1", energoFlags & FLAGS.energoCounter1);
  setCheckbox("energoCounter2", energoFlags & FLAGS.energoCounter2);
  setCheckbox("energoCounterAdv", energoFlags & FLAGS.energoAdv);
  getControl("energoCounter1Pin").value = readPin(view, energo + 2);
  getControl("energoCounter1Mac").value = readMac(view, energo + 8);
  getControl("energoCounter2Pin").value = readPin(view, energo + 16);
  getControl("energoCounter2Mac").value = readMac(view, energo + 22);
}

function collectSettingsBytes() {
  if (!currentSettingsBytes) {
    throw new Error("Сначала прочитайте настройки");
  }

  const bytes = new Uint8Array(currentSettingsBytes);
  const view = new DataView(bytes.buffer);
  const general = OFFSETS.general;
  const w1 = OFFSETS.w1;
  const analog = OFFSETS.analog;
  const energo = OFFSETS.energo;

  let generalFlags = view.getUint16(general + 12, true);
  generalFlags = setFlag(generalFlags, FLAGS.autoMeas, getControl("periodicMeasurement").checked);
  generalFlags = setFlag(generalFlags, FLAGS.timeLimited, getControl("timeLimited").checked);
  generalFlags = (generalFlags & ~FLAGS.advertTypeMask) |
    ((getControl("advertType").selectedIndex << FLAGS.advertTypeShift) & FLAGS.advertTypeMask);

  view.setUint16(general, getNumber("autoMeasurement", 1, 65535), true);
  view.setUint16(general + 2, getNumber("timeLimit", 1, 65535), true);
  view.setUint32(general + 4, getNumber("passKey", 0, 999999), true);
  view.setUint8(general + 8, TX_POWER_VALUES[getControl("txPower").selectedIndex] || 0x15);
  view.setUint16(general + 12, generalFlags, true);
  view.setUint16(general + 14, FIRM_VERSION, true);
  view.setUint16(general + 16, getNumber("advMin", 1, 65535), true);
  view.setUint16(general + 18, getNumber("advMax", 1, 65535), true);

  let w1Flags = view.getUint16(w1, true);
  w1Flags = setFlag(w1Flags, FLAGS.w1Therm, getControl("w1Therm").checked);
  w1Flags = setFlag(w1Flags, FLAGS.w1ThermAdv, getControl("w1ThermAdv").checked);
  w1Flags = setFlag(w1Flags, FLAGS.w1Signal, getControl("w1ThermSignal").checked);
  view.setUint16(w1, w1Flags, true);
  view.setFloat32(w1 + 2, getNumber("w1ThermTmax", -1000, 1000), true);
  view.setUint8(w1 + 6, getControl("w1ThermCondition").selectedIndex);

  let analogFlags = view.getUint16(analog, true);
  analogFlags = setFlag(analogFlags, FLAGS.thermistor, getControl("thermistors").checked);
  analogFlags = setFlag(analogFlags, FLAGS.hr202, getControl("hr202").checked);
  analogFlags = setFlag(analogFlags, FLAGS.analogAdv, getControl("thermistorAdv").checked);
  analogFlags = setFlag(analogFlags, FLAGS.thermistorSignal, getControl("thermistorSignal").checked);
  analogFlags = setFlag(analogFlags, FLAGS.hr202Signal, getControl("hr202Signal").checked);
  view.setUint16(analog, analogFlags, true);
  view.setFloat32(analog + 2, getNumber("analogHmin", -1000, 1000), true);
  view.setFloat32(analog + 6, getNumber("analogHmax", -1000, 1000), true);
  view.setUint8(analog + 10, getControl("analogHcondition").selectedIndex);
  view.setFloat32(analog + 11, getNumber("analogTmin", -1000, 1000), true);
  view.setFloat32(analog + 15, getNumber("analogTmax", -1000, 1000), true);
  view.setUint8(analog + 19, getControl("analogTcondition").selectedIndex);
  view.setUint8(analog + 28, getNumber("thermistorsCount", 1, 2));

  let energoFlags = view.getUint16(energo, true);
  energoFlags = setFlag(energoFlags, FLAGS.energoCounter1, getControl("energoCounter1").checked);
  energoFlags = setFlag(energoFlags, FLAGS.energoCounter2, getControl("energoCounter2").checked);
  energoFlags = setFlag(energoFlags, FLAGS.energoAdv, getControl("energoCounterAdv").checked);
  view.setUint16(energo, energoFlags, true);
  writePin(view, energo + 2, getPin("energoCounter1Pin"));
  writeMac(view, energo + 8, getControl("energoCounter1Mac").value);
  writePin(view, energo + 16, getPin("energoCounter2Pin"));
  writeMac(view, energo + 22, getControl("energoCounter2Mac").value);

  return bytes;
}

async function readSettings() {
  const wait = client.waitForLine((line) => line.startsWith("SET:") || line.startsWith("ERR:SETTINGS"));
  await sendCommand("at19\r\n");
  const line = await wait;
  if (!line.startsWith("SET:")) {
    throw new Error(line);
  }

  const parts = line.split(":");
  if (parts.length !== 3) {
    throw new Error("Некорректный ответ настроек");
  }

  const size = Number.parseInt(parts[1], 16);
  const bytes = hexToBytes(parts[2]);
  if (size !== SETTINGS_SIZE || bytes.length !== SETTINGS_SIZE) {
    throw new Error(`Размер настроек не совпадает: ${bytes.length}`);
  }

  const version = new DataView(bytes.buffer).getUint16(14, true);
  if (version !== FIRM_VERSION) {
    throw new Error(`Версия настроек ${version.toString(16)} не поддерживается`);
  }

  currentSettingsBytes = bytes;
  populateForm(bytes);
  setFirmwareVersion(version);
  setStatus(client.connected);

  const deviceTime = await readRtc();
  logLine(`Настройки прочитаны, RTC: ${new Date(deviceTime * 1000).toLocaleString()}`);
}

async function writeSettings() {
  const bytes = collectSettingsBytes();
  const wait = client.waitForLine((line) => line.startsWith("OK:SETTINGS") || line.startsWith("ERR:SETTINGS"));
  await sendCommand(`at1A${bytesToHex(bytes)}\r\n`);
  const line = await wait;
  if (!line.startsWith("OK:SETTINGS")) {
    throw new Error(line);
  }

  currentSettingsBytes = bytes;
  logLine(line === "OK:SETTINGS_RESET" ? "Настройки записаны, нужен reset для TX power" : "Настройки записаны");
}

async function syncRtc() {
  const unixTime = Math.floor(Date.now() / 1000) >>> 0;
  const unixHex = unixTime.toString(16).toUpperCase().padStart(8, "0");
  const wait = client.waitForLine((line) => line === "OK:RTC" || line === "ERR:RTC");
  await sendCommand(`at1B${unixHex}\r\n`);
  const line = await wait;
  if (line !== "OK:RTC") {
    throw new Error(line);
  }

  const deviceTime = await readRtc();
  logLine(`RTC синхронизирован: ${new Date(deviceTime * 1000).toLocaleString()}`);
}

async function readRtc() {
  const wait = client.waitForLine((line) => line.startsWith("RTC:") || line === "ERR:RTC");
  await sendCommand("at1C\r\n");
  const line = await wait;
  if (!line.startsWith("RTC:")) {
    throw new Error(line);
  }

  return Number.parseInt(line.slice(4), 16) >>> 0;
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

    await client.connect(selectedPort);
    await stopScanAndMeasure();
    setStatus(true);
    logLine("Порт подключен, сканирование и измерение остановлены");
  } catch (error) {
    logLine(`Ошибка подключения: ${error.message}`);
  }
});

ui.disconnectBtn.addEventListener("click", async () => {
  await client.disconnect();
  currentSettingsBytes = null;
  setFirmwareVersion(null);
  setStatus(false);
  logLine("Порт отключен");
});

ui.addPortBtn.addEventListener("click", async () => {
  try {
    await client.requestNewPort();
    await refreshPortList();
    logLine("Порт добавлен в разрешенные");
  } catch (error) {
    logLine(`Добавление порта отменено или не удалось: ${error.message}`);
  }
});

ui.refreshPortsBtn.addEventListener("click", async () => {
  try {
    await refreshPortList();
    logLine("Список портов обновлен");
  } catch (error) {
    logLine(`Ошибка обновления портов: ${error.message}`);
  }
});

document.querySelectorAll("[data-settings-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    activateSettingsTab(tab.getAttribute("data-settings-tab"));
  });
});

ui.readSettingsBtn.addEventListener("click", async () => {
  try {
    await readSettings();
  } catch (error) {
    logLine(`Ошибка чтения настроек: ${error.message}`);
  }
});

ui.writeSettingsBtn.addEventListener("click", async () => {
  try {
    await writeSettings();
  } catch (error) {
    logLine(`Ошибка записи настроек: ${error.message}`);
  }
});

ui.currentTimeBtn.addEventListener("click", async () => {
  try {
    await syncRtc();
  } catch (error) {
    logLine(`Ошибка синхронизации RTC: ${error.message}`);
  }
});

window.addEventListener("beforeunload", async () => {
  await client.disconnect();
});

if (ensureSecureContext()) {
  applyParameterHints();
  refreshPortList().catch((error) => logLine(`Ошибка списка портов: ${error.message}`));
}

if ("serial" in navigator && navigator.serial.addEventListener) {
  navigator.serial.addEventListener("connect", () => {
    refreshPortList().catch(() => {});
  });

  navigator.serial.addEventListener("disconnect", () => {
    refreshPortList().catch(() => {});
  });
}
