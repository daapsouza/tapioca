const DEFAULT_BRIDGE_URL = "http://127.0.0.1:17891";
const STORAGE_KEY = "comanda-printer-bridge-url";
const PRINTER_STORAGE_KEY = "comanda-printer-config-v1";
const nativePrintRequests = new Map();
let nextNativePrintId = 0;

if (typeof window !== "undefined") {
  window.__m10PrinterResult = (requestId, resultText) => {
    const request = nativePrintRequests.get(requestId);
    if (!request) return;
    nativePrintRequests.delete(requestId);
    window.clearTimeout(request.timeoutId);
    try {
      request.resolve(JSON.parse(resultText));
    } catch {
      request.reject(new Error("A resposta da impressora não pôde ser interpretada."));
    }
  };
}

export const DEFAULT_PRINTER_CONFIG = {
  type: "internal",
  model: "I9",
  ip: "",
  port: "9100",
};

export function hasNativePrinter() {
  return typeof window.M10Printer?.connectPrinter === "function";
}

export function getPrinterConfig() {
  const saved = localStorage.getItem(PRINTER_STORAGE_KEY);
  if (!saved) return { ...DEFAULT_PRINTER_CONFIG };
  const config = JSON.parse(saved);
  if (config?.type !== "internal" && config?.type !== "network") {
    throw new Error("A configuração da impressora salva está inválida.");
  }
  return { ...DEFAULT_PRINTER_CONFIG, ...config };
}

export function savePrinterConfig(config) {
  const normalized = {
    type: config.type,
    model: config.model.trim(),
    ip: config.ip.trim(),
    port: String(config.port).trim(),
  };
  if (!["internal", "network"].includes(normalized.type)) {
    throw new Error("Selecione a impressora embutida ou uma impressora de rede.");
  }
  if (normalized.type === "network") {
    const octets = normalized.ip.split(".");
    const validIp = octets.length === 4 && octets.every((octet) =>
      /^\d{1,3}$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255,
    );
    const port = Number(normalized.port);
    if (!validIp) throw new Error("Informe o IP IPv4 da impressora, por exemplo 192.168.1.50.");
    if (!normalized.model || normalized.model.length > 32) {
      throw new Error("Informe o modelo da impressora (até 32 caracteres).");
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("A porta deve estar entre 1 e 65535.");
    }
    normalized.port = String(port);
  }
  localStorage.setItem(PRINTER_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function getBridgeUrl() {
  return localStorage.getItem(STORAGE_KEY) || DEFAULT_BRIDGE_URL;
}

export function saveBridgeUrl(value) {
  const url = value.trim().replace(/\/+$/, "");
  localStorage.setItem(STORAGE_KEY, url || DEFAULT_BRIDGE_URL);
  return getBridgeUrl();
}

async function bridgeRequest(path, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${getBridgeUrl()}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body?.message || `A ponte respondeu com HTTP ${response.status}.`);
    }
    return body;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("A ponte de impressão não respondeu em 5 segundos.");
    }
    if (error instanceof TypeError) {
      throw new Error("Não foi possível acessar a ponte de impressão neste endereço.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function checkPrinterBridge(printerConfig = getPrinterConfig()) {
  if (hasNativePrinter()) {
    const status = JSON.parse(window.M10Printer.connectPrinter(JSON.stringify(printerConfig)));
    if (status?.ok !== true) {
      throw new Error(status?.message || "A impressora integrada não conectou.");
    }
    return status;
  }

  const status = await bridgeRequest("/health");
  if (status?.ok !== true) {
    throw new Error(status?.message || "A ponte não confirmou que está pronta.");
  }
  return status;
}

function printWithNativeBridge(payload) {
  if (typeof window.M10Printer.printReceiptAsync !== "function") {
    return JSON.parse(window.M10Printer.printReceipt(JSON.stringify(payload)));
  }

  const requestId = `print-${Date.now()}-${++nextNativePrintId}`;
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      nativePrintRequests.delete(requestId);
      reject(new Error("A impressão ainda não foi confirmada após 60 segundos."));
    }, 60000);
    nativePrintRequests.set(requestId, { resolve, reject, timeoutId });
    try {
      window.M10Printer.printReceiptAsync(JSON.stringify(payload), requestId);
    } catch (error) {
      window.clearTimeout(timeoutId);
      nativePrintRequests.delete(requestId);
      reject(error);
    }
  });
}

export async function printReceipt(order, printerConfig = getPrinterConfig()) {
  if (hasNativePrinter()) {
    const result = await printWithNativeBridge({
      printer: printerConfig,
      title: "HOTEL COLONIAL PLAZA",
      subtitle: "CAFÉ DA MANHÃ",
      orderNumber: order.id,
      createdAt: order.createdAt,
      customer: order.customerName,
      room: order.room,
      product: order.product,
      variant: order.variant || "",
      ingredients: order.ingredients,
      preparationMinutes: 30,
      footer: "Fique atento à campainha! Bom apetite!",
    });
    if (result?.ok !== true) {
      const error = new Error(result?.message || "A impressora integrada não confirmou a impressão.");
      error.retryable = result?.retryable === true;
      throw error;
    }
    return result;
  }

  const result = await bridgeRequest("/print", {
    method: "POST",
    body: JSON.stringify({
      device: printerConfig.type === "network" ? "thermal-network" : "elgin-m10",
      sdkClass: "com.elgin.e1.Impressora.Termica",
      printer: printerConfig,
      document: {
        title: "HOTEL COLONIAL PLAZA",
        subtitle: "CAFÉ DA MANHÃ",
        orderNumber: order.id,
        createdAt: order.createdAt,
        customer: order.customerName,
        room: order.room,
        product: order.product,
        variant: order.variant || "",
        ingredients: order.ingredients,
        preparationMinutes: 30,
        footer: "Fique atento à campanhinha! Boa apetite!",
      },
    }),
  });

  if (result?.ok !== true) {
    throw new Error(result?.message || "A ponte não confirmou a impressão.");
  }
  return result;
}
