const CONFIG_KEY = "comanda-attendant-connection-v1";
const pendingRequests = new Map();
let nextRequestId = 0;

if (typeof window !== "undefined") {
  window.__m10LocalOrdersResult = (requestId, responseText) => {
    const request = pendingRequests.get(requestId);
    if (!request) return;
    pendingRequests.delete(requestId);
    window.clearTimeout(request.timeoutId);
    try {
      const response = JSON.parse(responseText);
      if (response.ok !== true) {
        request.reject(new Error(response.error || "Falha na conexão com o M10 do hóspede."));
        return;
      }
      request.resolve(response);
    } catch (error) {
      request.reject(error instanceof Error
        ? error
        : new Error("A resposta do M10 do hóspede não pôde ser interpretada."));
    }
  };

  window.__m10ApplyLocalOrders = (ordersText) => {
    try {
      const orders = JSON.parse(ordersText);
      if (!Array.isArray(orders)) throw new Error("A lista de pedidos recebida é inválida.");
      window.dispatchEvent(new CustomEvent("m10-local-orders-updated", { detail: orders }));
    } catch (error) {
      console.error("Não foi possível aplicar a atualização local de pedidos:", error);
    }
  };
}

export function getLocalOrderServerInfo() {
  if (typeof window.M10Printer?.getLocalOrderServerInfo !== "function") return null;
  const info = JSON.parse(window.M10Printer.getLocalOrderServerInfo());
  if (info.enabled !== true) return null;
  return info;
}

export function getAttendantConnection() {
  const saved = localStorage.getItem(CONFIG_KEY);
  if (!saved) return { ip: "", token: "" };
  const connection = JSON.parse(saved);
  if (!connection || typeof connection !== "object") {
    throw new Error("A configuração de conexão está inválida.");
  }
  return {
    ip: typeof connection.ip === "string" ? connection.ip : "",
    token: typeof connection.token === "string" ? connection.token : "",
  };
}

export function saveAttendantConnection(ip, token) {
  const connection = { ip: ip.trim(), token: token.trim().toUpperCase() };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(connection));
  return connection;
}

export function requestLocalOrders(ip, token) {
  return callBridge("requestLocalOrdersAsync", [ip, token]);
}

export function completeLocalOrder(ip, token, orderId) {
  return callBridge("completeLocalOrderAsync", [ip, token, orderId]);
}

export function reopenLocalOrder(ip, token, orderId) {
  return callBridge("reopenLocalOrderAsync", [ip, token, orderId]);
}

function callBridge(method, args) {
  const bridge = window.M10Printer;
  const bridgeMethod = bridge?.[method];
  if (typeof bridgeMethod !== "function") {
    return Promise.reject(new Error("Esta função está disponível somente no APK Atendente instalado em um M10."));
  }

  const requestId = `local-orders-${++nextRequestId}`;
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("O M10 do hóspede não respondeu. Confira o Wi-Fi e o IP."));
    }, 5000);
    pendingRequests.set(requestId, { resolve, reject, timeoutId });
    try {
      bridge[method](...args, requestId);
    } catch (error) {
      pendingRequests.delete(requestId);
      window.clearTimeout(timeoutId);
      reject(error);
    }
  });
}
