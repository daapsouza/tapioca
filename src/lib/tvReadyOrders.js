const TOKEN_KEY = "comanda-tv-ready-token-v1";
const QUEUE_KEY = "comanda-tv-ready-queue-v1";
const DEVICE_ID_KEY = "comanda-tv-device-id-v1";
const ORDERS_KEY = "comanda-local-orders-v1";
const API_URL = "https://tvadmin.colonialplazapinda.com.br/backend/api/orders/ready-notice.php";
const REQUEST_URL = import.meta.env.DEV ? "/tv-ready-notice" : API_URL;
const MAX_QUEUE_AGE_MS = 10 * 60 * 1000;
const BUILT_IN_TOKEN = import.meta.env.VITE_M10_READY_ORDER_TOKEN?.trim() || "";
const nativeReadyOrderRequests = new Map();
let nextNativeReadyOrderRequestId = 0;

if (typeof window !== "undefined") {
  window.__m10ReadyOrderResult = (requestId, resultText) => {
    const request = nativeReadyOrderRequests.get(requestId);
    if (!request) return;
    nativeReadyOrderRequests.delete(requestId);
    window.clearTimeout(request.timeoutId);
    try {
      request.resolve(JSON.parse(resultText));
    } catch {
      request.reject(new Error("A resposta do servidor de TVs não pôde ser interpretada."));
    }
  };
}

function readQueue() {
  const saved = localStorage.getItem(QUEUE_KEY);
  if (!saved) return [];

  const queue = JSON.parse(saved);
  if (!Array.isArray(queue)) {
    throw new Error("A fila de avisos da TV está em um formato inválido.");
  }
  return queue;
}

function saveQueue(queue) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

function getStoredOrders() {
  const orders = JSON.parse(localStorage.getItem(ORDERS_KEY) || "[]");
  if (!Array.isArray(orders)) {
    throw new Error("Os pedidos salvos neste aparelho estão em um formato inválido.");
  }
  return orders;
}

function createEventId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getOrderEventId(order) {
  const createdAt = Date.parse(order.createdAt);
  const orderId = String(order.id);
  if (!Number.isFinite(createdAt) || !/^[a-zA-Z0-9-]{1,24}$/.test(orderId)) {
    throw new Error("Não foi possível identificar este pedido para evitar avisos duplicados.");
  }

  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = createEventId();
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  return `${deviceId}-${createdAt}-${orderId}`;
}

function normalizeQueue(queue) {
  const ordersById = new Map(getStoredOrders().map((order) => [order.id, order]));
  const seenOrderIds = new Set();
  const normalized = [];

  for (const event of queue) {
    const order = ordersById.get(event.orderId);
    if (!order) {
      normalized.push(event);
      continue;
    }
    if (order.tvNoticeStatus === "sent" || seenOrderIds.has(event.orderId)) continue;

    seenOrderIds.add(event.orderId);
    normalized.push({ ...event, eventId: getOrderEventId(order) });
  }

  if (JSON.stringify(normalized) !== JSON.stringify(queue)) saveQueue(normalized);
  return normalized;
}

export function getTvReadyToken() {
  return localStorage.getItem(TOKEN_KEY) || BUILT_IN_TOKEN;
}

export function saveTvReadyToken(token) {
  const normalized = token.trim();
  if (normalized) {
    localStorage.setItem(TOKEN_KEY, normalized);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
  return normalized || BUILT_IN_TOKEN;
}

export function queueReadyOrder(order, { force = false } = {}) {
  const queue = readQueue();
  const savedOrder = getStoredOrders().find((item) => item.id === order.id);
  const currentOrder = savedOrder || order;
  if (currentOrder.tvNoticeStatus === "sent" && !force) {
    const remaining = queue.filter((event) => event.orderId !== order.id);
    if (remaining.length !== queue.length) saveQueue(remaining);
    return remaining.length;
  }

  const existingIndex = queue.findIndex((event) => event.orderId === order.id && event.status === "pending");
  if (existingIndex >= 0) {
    const existing = queue[existingIndex];
    const normalized = { ...existing, eventId: getOrderEventId(currentOrder) };
    if (existing.eventId !== normalized.eventId) {
      queue[existingIndex] = normalized;
      saveQueue(queue);
    }
    return queue.length;
  }

  queue.push({
    eventId: getOrderEventId(currentOrder),
    orderId: order.id,
    customerName: order.customerName,
    room: order.room,
    queuedAt: Date.now(),
    status: "pending",
  });
  saveQueue(queue);
  updateOrderNotice(order.id, "pending", "Aguardando envio às TVs.");
  return queue.length;
}

export async function syncReadyOrderQueue(token) {
  const queue = normalizeQueue(readQueue());
  const remaining = [];
  let sent = 0;
  let disabled = 0;
  let expired = 0;
  let lastError = "";

  if (!token) {
    return {
      sent,
      pending: queue.length,
      expired,
      error: queue.length ? "Configure o token de integração da TV para enviar os avisos." : "",
    };
  }

  for (const event of queue) {
    if (Date.now() - event.queuedAt > MAX_QUEUE_AGE_MS) {
      updateOrderNotice(event.orderId, "expired", "O aviso não foi enviado: o aparelho ficou sem conexão por mais de 10 minutos.");
      expired += 1;
      continue;
    }

    try {
      const payload = {
        integration_token: token,
        event_id: event.eventId,
        customer_name: event.customerName,
        room: event.room,
      };
      let result;
      if (typeof window.M10Printer?.sendReadyOrderAsync === "function") {
        result = await sendReadyOrderWithNativeBridge(payload);
      } else {
        const response = await fetch(REQUEST_URL, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain;charset=UTF-8",
          },
          credentials: "omit",
          cache: "no-store",
          body: JSON.stringify(payload),
        });
        result = await response.json().catch(() => ({}));
        if (!response.ok && !result.error) {
          result.error = `Falha ao enviar aviso para a TV (HTTP ${response.status}).`;
        }
      }
      if (result.ok !== true) {
        throw new Error(result.error || `Falha ao enviar aviso para a TV.`);
      }

      if (result.disabled === true) {
        updateOrderNotice(event.orderId, "disabled", "Os avisos de pedidos estão desativados no TV Admin.");
        disabled += 1;
        continue;
      }

      updateOrderNotice(event.orderId, "sent", "");
      sent += 1;
    } catch (error) {
      lastError = error.message || "Não foi possível enviar o aviso para a TV.";
      remaining.push(event);
      updateOrderNotice(event.orderId, "pending", lastError);
    }
  }

  saveQueue(remaining);
  return { sent, disabled, pending: remaining.length, expired, error: lastError };
}

function updateOrderNotice(orderId, status, error) {
  const orders = getStoredOrders();
  const index = orders.findIndex((order) => order.id === orderId);
  if (index < 0) return;

  orders[index] = { ...orders[index], tvNoticeStatus: status, tvNoticeError: error };
  localStorage.setItem("comanda-local-orders-v1", JSON.stringify(orders));
}

function sendReadyOrderWithNativeBridge(payload) {
  const requestId = `tv-${Date.now()}-${++nextNativeReadyOrderRequestId}`;
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      nativeReadyOrderRequests.delete(requestId);
      reject(new Error("O servidor de TVs não respondeu em 20 segundos."));
    }, 20000);
    nativeReadyOrderRequests.set(requestId, { resolve, reject, timeoutId });
    try {
      window.M10Printer.sendReadyOrderAsync(JSON.stringify(payload), requestId);
    } catch (error) {
      window.clearTimeout(timeoutId);
      nativeReadyOrderRequests.delete(requestId);
      reject(error);
    }
  });
}
