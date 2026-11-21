const STORAGE_KEY = "comanda-local-orders-v1";
const SWEET_INGREDIENTS = new Set(["Chocolate", "Leite condensado", "Coco"]);

export function getTapiocaKind(order) {
  if (order.product !== "Tapioca") return "";
  if (order.variant === "doce" || order.variant === "salgada") return order.variant;

  const hasSweet = order.ingredients.some((item) => SWEET_INGREDIENTS.has(item));
  const hasSavory = order.ingredients.some((item) => !SWEET_INGREDIENTS.has(item));
  if (hasSweet && hasSavory) return "mista";
  return hasSweet ? "doce" : "salgada";
}

export function getLocalDay(order) {
  const date = new Date(order.createdAt);
  if (Number.isNaN(date.getTime())) return "data-invalida";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function getOrders() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return [];

  const orders = JSON.parse(saved);
  if (!Array.isArray(orders)) {
    throw new Error("Os pedidos salvos neste aparelho estão em um formato inválido.");
  }
  return orders;
}

function saveOrders(orders) {
  const serialized = JSON.stringify(orders);
  localStorage.setItem(STORAGE_KEY, serialized);
  if (typeof window !== "undefined") {
    window.M10Printer?.publishLocalOrders(serialized);
  }
}

export function replaceLocalOrders(orders) {
  if (!Array.isArray(orders)) {
    throw new Error("A resposta do M10 do hóspede contém pedidos inválidos.");
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
}

export function createLocalOrder({ product, variant, customerName, room, ingredients }) {
  const orders = getOrders();
  const lastId = orders.reduce((largest, order) => {
    const id = Number.parseInt(order.id, 10);
    return Number.isFinite(id) ? Math.max(largest, id) : largest;
  }, 0);
  const order = {
    id: String(lastId + 1).padStart(4, "0"),
    createdAt: new Date().toISOString(),
    customerName,
    room,
    product,
    variant,
    ingredients,
    status: "new",
    printStatus: "pending",
    printError: "",
  };
  saveOrders([order, ...orders]);
  return order;
}

export function updateLocalOrder(id, changes) {
  const orders = getOrders();
  const index = orders.findIndex((order) => order.id === id);
  if (index < 0) throw new Error("Este pedido não foi encontrado no aparelho.");

  const updated = { ...orders[index], ...changes };
  const next = [...orders];
  next[index] = updated;
  saveOrders(next);
  return updated;
}
