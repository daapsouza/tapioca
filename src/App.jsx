import { useEffect, useMemo, useRef, useState } from "react";
import {
  checkPrinterBridge,
  getBridgeUrl,
  getPrinterConfig,
  hasNativePrinter,
  printReceipt,
  saveBridgeUrl,
  savePrinterConfig,
} from "./lib/printer.js";
import tapiocaCardImage from "./assets/tapioca-card.jpg";
import omeletteCardImage from "./assets/omelette-card.jpg";
import homeLogo from "./assets/logo-colonial-plaza.webp";
import {
  createLocalOrder,
  getLocalDay,
  getOrders,
  getTapiocaKind,
  replaceLocalOrders,
  updateLocalOrder,
} from "./lib/orders.js";
import {
  completeLocalOrder,
  getAttendantConnection,
  getLocalOrderServerInfo,
  requestLocalOrders,
  reopenLocalOrder,
  saveAttendantConnection,
} from "./lib/localOrderSync.js";
import {
  getTvReadyToken,
  queueReadyOrder,
  saveTvReadyToken,
  syncReadyOrderQueue,
} from "./lib/tvReadyOrders.js";

const SWEET_INGREDIENTS = ["Chocolate", "Leite condensado", "Coco"];
const SAVORY_INGREDIENTS = ["Queijo", "Presunto", "Tomate", "Cebola", "Orégano"];
const TAPIOCA_EXTRAS = ["Manteiga", "Simples"];
const APP_MODE = import.meta.env.VITE_APP_MODE || "guest";
const ATTENDANT_PRINT_STORAGE_KEY = "comanda-attendant-auto-print-v1";
const AUTOMATIC_PRINT_RETRY_DELAYS = [1500, 4000, 10000];
const MENU = {
  tapioca: {
    title: "Tapioca",
    description: "Salgadas ou doces — com seus ingredientes favoritos.",
    groups: [
      { title: "Salgada", kind: "salgada", items: [...SAVORY_INGREDIENTS, ...TAPIOCA_EXTRAS] },
      { title: "Doce", kind: "doce", items: SWEET_INGREDIENTS },
    ],
  },
  omelete: {
    title: "Omelete",
    description: "Somente opções salgadas, preparadas na hora.",
    groups: [{ title: "Salgados", items: [...SAVORY_INGREDIENTS, "Simples"] }],
  },
};

function getAttendantPrintLedger() {
  const saved = localStorage.getItem(ATTENDANT_PRINT_STORAGE_KEY);
  if (!saved) return {};
  const ledger = JSON.parse(saved);
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    throw new Error("O histórico de impressão automática está inválido.");
  }
  return ledger;
}

function getAttendantPrintKey(ip, order) {
  return JSON.stringify([ip, order.id, order.createdAt]);
}

function Brand({ compact = false }) {
  return (
    <p className={`brand ${compact ? "brand--compact" : ""}`}>
      HOTEL COLONIAL PLAZA
    </p>
  );
}

function Link({ href, onNavigate, children, className = "" }) {
  return (
    <a
      className={className}
      href={href}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        onNavigate(href);
      }}
    >
      {children}
    </a>
  );
}

function Header({ title, onNavigate, eyebrow = "HOTEL COLONIAL PLAZA" }) {
  return (
    <header className="page-header">
      <Link href="/" onNavigate={onNavigate} className="back-link">
        <span aria-hidden="true">←</span> Voltar
      </Link>
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
    </header>
  );
}

function Home({ onNavigate }) {
  const [currentTime, setCurrentTime] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="home-page">
      <time className="home-clock" dateTime={currentTime.toISOString()}>
        <span className="home-clock-time">
          {currentTime.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
        <span className="home-clock-date">
          {currentTime.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
        </span>
      </time>
      <section className="home-intro">
        <img
          className="home-logo"
          src={homeLogo}
          alt="Colonial Plaza Hotel"
        />
        <h1>Café da manhã</h1>
        <p>Peça seu café com praticidade</p>
        <span className="home-prompt">Escolha os itens do seu pedido</span>
      </section>

      <section className="category-grid" aria-label="Categorias do cardápio">
        <Link href="/pedido/tapioca" onNavigate={onNavigate} className="category-card category-card--tapioca">
          <span className="category-card-photo" style={{ backgroundImage: `url("${tapiocaCardImage}")` }} aria-hidden="true" />
          <h2>Tapioca</h2>
          <p>Salgadas ou doces — com seus ingredientes favoritos.</p>
          <span className="choose-link">ESCOLHER <span aria-hidden="true">→</span></span>
        </Link>
        <Link href="/pedido/omelete" onNavigate={onNavigate} className="category-card category-card--gold">
          <span className="category-card-photo" style={{ backgroundImage: `url("${omeletteCardImage}")` }} aria-hidden="true" />
          <h2>Omelete</h2>
          <p>Somente opções salgadas, preparadas na hora.</p>
          <span className="choose-link">ESCOLHER <span aria-hidden="true">→</span></span>
        </Link>
      </section>

    </main>
  );
}

function OrderPage({ type, onNavigate }) {
  const menu = MENU[type];
  const [ingredients, setIngredients] = useState([]);
  const [variant, setVariant] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [room, setRoom] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedOrder, setSavedOrder] = useState(null);
  const [printState, setPrintState] = useState({ status: "idle", message: "" });

  useEffect(() => {
    document.documentElement.classList.toggle("confirmation-screen", Boolean(savedOrder));
    return () => document.documentElement.classList.remove("confirmation-screen");
  }, [savedOrder]);

  useEffect(() => {
    if (!savedOrder) return undefined;
    const timer = window.setTimeout(() => onNavigate("/"), 3000);
    return () => window.clearTimeout(timer);
  }, [savedOrder, onNavigate]);

  useEffect(() => {
    const scrollTimers = new Set();
    const isGuestInput = (element) =>
      element instanceof HTMLInputElement && Boolean(element.closest(".guest-panel"));

    const keepFocusedFieldVisible = () => {
      const activeField = document.activeElement;
      if (!isGuestInput(activeField)) return;

      activeField.scrollIntoView({ behavior: "auto", block: "center" });
      const viewport = window.visualViewport;
      if (!viewport) return;

      const fieldBounds = activeField.getBoundingClientRect();
      const visibleTop = viewport.offsetTop + 12;
      const visibleBottom = viewport.offsetTop + viewport.height - 24;
      if (fieldBounds.bottom > visibleBottom) {
        window.scrollBy({ top: fieldBounds.bottom - visibleBottom, behavior: "auto" });
      } else if (fieldBounds.top < visibleTop) {
        window.scrollBy({ top: fieldBounds.top - visibleTop, behavior: "auto" });
      }
    };

    const scheduleFieldScroll = () => {
      for (const delay of [80, 240, 480]) {
        const timer = window.setTimeout(() => {
          scrollTimers.delete(timer);
          keepFocusedFieldVisible();
        }, delay);
        scrollTimers.add(timer);
      }
    };

    const handleFocusIn = (event) => {
      if (!isGuestInput(event.target)) return;
      document.documentElement.classList.add("keyboard-open");
      window.M10Printer?.setKeyboardVisible?.(true);
      scheduleFieldScroll();
    };

    const handleFocusOut = () => {
      window.setTimeout(() => {
        if (isGuestInput(document.activeElement)) return;
        document.documentElement.classList.remove("keyboard-open");
        window.M10Printer?.setKeyboardVisible?.(false);
      }, 300);
    };

    const viewport = window.visualViewport;
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    viewport?.addEventListener("resize", scheduleFieldScroll);
    viewport?.addEventListener("scroll", scheduleFieldScroll);
    return () => {
      for (const timer of scrollTimers) window.clearTimeout(timer);
      document.documentElement.classList.remove("keyboard-open");
      window.M10Printer?.setKeyboardVisible?.(false);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      viewport?.removeEventListener("resize", scheduleFieldScroll);
      viewport?.removeEventListener("scroll", scheduleFieldScroll);
    };
  }, []);

  const toggleIngredient = (ingredient) => {
    setIngredients((current) =>
      current.includes(ingredient)
        ? current.filter((item) => item !== ingredient)
        : [...current, ingredient],
    );
  };

  const cancelOrder = (order) => {
    if (!window.confirm(`Cancelar a comanda #${order.id} do apto ${order.room}?`)) return;
    changeStatus(order.id, "cancelled");
  };

  const submitOrder = async (event) => {
    event.preventDefault();
    if (ingredients.length === 0 || saving) return;
    setSaving(true);
    setPrintState({ status: "idle", message: "" });
    try {
      const order = createLocalOrder({
        product: menu.title,
        variant: type === "tapioca" ? variant : "",
        customerName: customerName.trim().toLocaleUpperCase("pt-BR"),
        room: room.replace(/\D/g, ""),
        ingredients,
      });
      setSavedOrder(order);
      setPrintState({
        status: "success",
        message: "Pedido enviado para a cozinha. A comanda será impressa automaticamente no tablet do atendente.",
      });
    } catch (error) {
      setPrintState({ status: "error", message: error.message });
    } finally {
      setSaving(false);
    }
  };

  if (savedOrder) {
    return (
      <main className="content-page confirmation-page">
        <Header title="Pedido enviado" onNavigate={onNavigate} eyebrow="TUDO PRONTO" />
        <section className="confirmation-card">
          <span className="confirmation-mark" aria-hidden="true">✓</span>
          <p className="eyebrow">COMANDA #{savedOrder.id}</p>
          <h2>Obrigado, {savedOrder.customerName}!</h2>
          <p>Seu pedido foi enviado para preparo. Tempo estimado: 30 minutos.</p>
          <div className={`notice notice--${printState.status}`} role="status" aria-live="polite">
            {printState.message || "Pedido registrado."}
          </div>
          <Link href="/" onNavigate={onNavigate} className="button">
            Fazer outro pedido
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="content-page">
      <Header title={menu.title} onNavigate={onNavigate} />
      <form className="order-form" onSubmit={submitOrder}>
        <div className="ingredient-groups">
          {type === "tapioca" && (
            <section className="panel tapioca-kind-picker" aria-label="Tipo de tapioca">
              <span className="kind-picker-label">QUAL VAI SER A SUA?</span>
              <div className="kind-picker-options">
                {menu.groups.map((group) => (
                  <button
                    className={`kind-option ${variant === group.kind ? "kind-option--selected" : ""}`}
                    type="button"
                    key={group.kind}
                    aria-pressed={variant === group.kind}
                    onClick={() => {
                      setVariant(group.kind);
                      setIngredients([]);
                    }}
                  >
                    <span>{group.kind === "doce" ? "✦" : "◉"}</span>
                    <strong>{group.title}</strong>
                  </button>
                ))}
              </div>
            </section>
          )}
          {menu.groups.filter((group) => !group.kind || group.kind === variant).map((group) => (
            <section className="panel ingredient-panel" key={group.title}>
              <div className="section-heading">
                <h2>{group.title}</h2>
                <span>TOQUE PARA SELECIONAR</span>
              </div>
              <div className="ingredient-list">
                {group.items.map((ingredient) => {
                  const selected = ingredients.includes(ingredient);
                  return (
                    <button
                      type="button"
                      key={ingredient}
                      className={`ingredient-chip ${selected ? "ingredient-chip--selected" : ""}`}
                      aria-pressed={selected}
                      onClick={() => toggleIngredient(ingredient)}
                    >
                      <span className="chip-check" aria-hidden="true">{selected ? "✓" : "+"}</span>
                      {ingredient}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <section className="panel summary-panel">
          <div className="section-heading">
            <h2>Seu pedido</h2>
            <span>{ingredients.length} {ingredients.length === 1 ? "ingrediente" : "ingredientes"}</span>
          </div>
          {ingredients.length ? (
            <ul className="selected-list">
              {ingredients.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : (
            <p className="muted-copy">Nenhum ingrediente selecionado ainda — toque nos ingredientes acima para montar seu pedido.</p>
          )}
        </section>

        <aside className="prep-note">
          <span className="prep-clock" aria-hidden="true">◷</span>
          <div>
            <strong>Tempo de preparo: 30 minutos</strong>
            <p>Fique atento à campainha! Bom apetite.</p>
          </div>
        </aside>

        <section className="panel guest-panel">
          <div className="section-heading">
            <h2>Para quem é o pedido?</h2>
            <span>OBRIGATÓRIO</span>
          </div>
          <div className="field-grid">
            <label className="field">
              <span>Nome</span>
              <input
                autoCapitalize="characters"
                autoComplete="name"
                autoCorrect="off"
                maxLength={100}
                required
                value={customerName}
                onChange={(event) => setCustomerName(event.target.value.toLocaleUpperCase("pt-BR"))}
                placeholder="Seu nome"
              />
            </label>
            <label className="field">
              <span>Apartamento / quarto</span>
              <input
                autoComplete="off"
                inputMode="numeric"
                maxLength={20}
                pattern="[0-9]*"
                required
                value={room}
                onChange={(event) => setRoom(event.target.value.replace(/\D/g, ""))}
                placeholder="Ex.: 204"
              />
            </label>
          </div>
        </section>

        {printState.status === "error" && (
          <div className="notice notice--error" role="alert">{printState.message}</div>
        )}
        <button className="button submit-button" type="submit" disabled={saving || ingredients.length === 0 || (type === "tapioca" && !variant)}>
          {saving ? "Enviando pedido…" : "Enviar pedido"}
          {!saving && <span aria-hidden="true">→</span>}
        </button>
      </form>
    </main>
  );
}

function PrinterPage({ onNavigate }) {
  const nativePrinter = hasNativePrinter();
  const [localServerInfo, setLocalServerInfo] = useState(null);
  const [bridgeUrl, setBridgeUrl] = useState(getBridgeUrl());
  const [printerConfig, setPrinterConfig] = useState(() => getPrinterConfig());
  const [connection, setConnection] = useState({ status: "disconnected", message: "Ponte não conectada" });
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const isNetworkPrinter = printerConfig.type === "network";
  const canConnect = !busy && (nativePrinter
    ? !isNetworkPrinter || (printerConfig.ip.trim() && printerConfig.model.trim() && printerConfig.port.trim())
    : bridgeUrl.trim());
  const updateConfig = (changes) => {
    setPrinterConfig((current) => ({ ...current, ...changes }));
    setConnection({ status: "disconnected", message: "Salve e conecte a impressora." });
  };

  useEffect(() => {
    if (!nativePrinter) return undefined;
    const refreshServerInfo = () => {
      try {
        setLocalServerInfo(getLocalOrderServerInfo());
      } catch (error) {
        console.error("Não foi possível carregar os dados de conexão local:", error);
      }
    };
    refreshServerInfo();
    const timer = window.setInterval(refreshServerInfo, 5000);
    return () => window.clearInterval(timer);
  }, [nativePrinter]);

  const connect = async () => {
    setBusy(true);
    setConnection({ status: "connecting", message: "Conectando à impressora…" });
    try {
      const savedConfig = savePrinterConfig(printerConfig);
      setPrinterConfig(savedConfig);
      if (!nativePrinter) {
        const savedUrl = saveBridgeUrl(bridgeUrl);
        setBridgeUrl(savedUrl);
      }
      const response = await checkPrinterBridge(savedConfig);
      setConnection({
        status: "connected",
        message: response.printer || (savedConfig.type === "network"
          ? `Impressora ${savedConfig.model} em ${savedConfig.ip}:${savedConfig.port}`
          : "Impressora integrada M10 pronta"),
      });
    } catch (error) {
      setConnection({ status: "disconnected", message: error.message });
    } finally {
      setBusy(false);
    }
  };

  const printTest = async () => {
    setBusy(true);
    setConnection((current) => ({ ...current, testMessage: "Enviando teste…" }));
    try {
      await printReceipt({
        id: "TESTE",
        createdAt: new Date().toISOString(),
        customerName: "Demonstracao",
        room: "57mm",
        product: "Tapioca",
        variant: "Salgada",
        ingredients: ["Queijo", "Presunto", "Tomate"],
      }, printerConfig);
      setConnection((current) => ({
        ...current,
        testMessage: "Impressão de teste enviada; confira a saída do papel.",
      }));
    } catch (error) {
      setConnection((current) => ({ ...current, testMessage: error.message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="content-page printer-page">
      <Header title="Impressora integrada" onNavigate={onNavigate} eyebrow="CONFIGURAÇÃO" />
      {localServerInfo && (
        <section className="panel local-server-panel">
          <div className="section-heading">
            <h2>Conexão local do atendente</h2>
            <span>{localServerInfo.running && localServerInfo.ip ? "ATIVA" : "AGUARDANDO WI-FI"}</span>
          </div>
          <p>Deixe este M10 ligado na rede Wi‑Fi. No APK Atendente, informe o IP e o código abaixo.</p>
          <div className="local-server-details">
            <div><span>IP deste M10</span><strong>{localServerInfo.ip || "Conecte ao Wi‑Fi"}</strong></div>
            <div><span>Porta</span><strong>{localServerInfo.port}</strong></div>
            <div><span>Código de conexão</span><strong>{localServerInfo.token}</strong></div>
          </div>
          <small className="printer-help">Use uma rede Wi‑Fi compartilhada entre os dois aparelhos e reserve este IP no roteador para evitar que ele mude.</small>
        </section>
      )}
      <section className="panel printer-panel">
        <div className="printer-status">
          <span className={`status-dot status-dot--${connection.status}`} />
          <div>
            <strong>{connection.status === "connected" ? "Conectada" : connection.status === "connecting" ? "Conectando" : "Desconectada"}</strong>
            <p>{connection.message}</p>
          </div>
          <span className="model-badge">{isNetworkPrinter ? "IMPRESSORA IP" : "M10 INTEGRADA"}</span>
        </div>

        {nativePrinter ? (
          <>
            <label className="field printer-type-field">
              <span>Impressora de preparo</span>
              <select
                value={printerConfig.type}
                onChange={(event) => updateConfig({ type: event.target.value })}
              >
                <option value="internal">Impressora embutida do M10</option>
                <option value="network">Impressora térmica por IP</option>
              </select>
            </label>
            {isNetworkPrinter ? (
              <div className="printer-network-fields">
                <label className="field">
                  <span>IP da impressora</span>
                  <input
                    autoCapitalize="none"
                    autoComplete="off"
                    inputMode="decimal"
                    maxLength={15}
                    placeholder="192.168.1.50"
                    value={printerConfig.ip}
                    onChange={(event) => updateConfig({ ip: event.target.value })}
                  />
                </label>
                <div className="field-grid">
                  <label className="field">
                    <span>Modelo informado ao SDK</span>
                    <input
                      autoCapitalize="characters"
                      maxLength={32}
                      placeholder="I9"
                      value={printerConfig.model}
                      onChange={(event) => updateConfig({ model: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Porta TCP</span>
                    <input
                      inputMode="numeric"
                      maxLength={5}
                      value={printerConfig.port}
                      onChange={(event) => updateConfig({ port: event.target.value })}
                    />
                  </label>
                </div>
                <small className="printer-help">Use o IP fixo da impressora na mesma rede Wi-Fi do M10. O SDK Elgin abre a conexão TCP da impressora.</small>
              </div>
            ) : (
              <div className="native-printer-info">
                <span className="native-check" aria-hidden="true">✓</span>
                <p>SDK Elgin integrado ao APK. A impressora embutida funciona sem rede.</p>
              </div>
            )}
          </>
        ) : (
          <label className="field bridge-field">
            <span>Endereço da ponte local</span>
            <input
              autoCapitalize="none"
              autoComplete="url"
              spellCheck="false"
              value={bridgeUrl}
              onChange={(event) => setBridgeUrl(event.target.value)}
              placeholder="http://127.0.0.1:17891"
            />
            <small>No navegador, conecte uma ponte local; no APK, o SDK nativo é utilizado diretamente.</small>
          </label>
        )}

        <div className="printer-actions">
          <button className="button" onClick={connect} disabled={!canConnect}>
            {busy ? "Conectando…" : "Salvar e conectar"}
          </button>
          <button
            className="button button--secondary"
            onClick={printTest}
            disabled={busy || connection.status !== "connected"}
          >
            Imprimir teste
          </button>
        </div>
        {connection.testMessage && (
          <p className={`notice ${connection.testMessage.includes("enviada") ? "notice--success" : "notice--error"}`} role="status">
            {connection.testMessage}
          </p>
        )}
      </section>

      <section className="panel receipt-preview-card">
        <div>
          <h2>Prévia do cupom</h2>
          <p>Confira a composição em bobina de 57 mm antes de imprimir.</p>
        </div>
        <button className="button button--secondary" type="button" onClick={() => setPreviewOpen(true)}>
          Visualizar impressão
        </button>
      </section>

      <section className="panel howto-panel">
        <h2>Como funciona</h2>
        <ol>
          {nativePrinter ? (
            <>
              <li>Selecione a impressora embutida ou informe IP, modelo e porta da impressora térmica de rede.</li>
              <li>Toque em <strong>Salvar e conectar</strong> e use o teste antes do atendimento.</li>
              <li>Use <strong>Imprimir teste</strong> antes de começar o atendimento.</li>
              <li>Novos pedidos são guardados no aparelho e impressos sem abrir a pré-visualização.</li>
            </>
          ) : (
            <>
              <li>Inicie uma ponte de impressão local vinculada ao SDK do Mini PDV M10.</li>
              <li>Informe o endereço local da ponte e toque em <strong>Conectar impressora</strong>.</li>
              <li>Faça um teste. Os pedidos salvos neste aparelho serão impressos automaticamente.</li>
            </>
          )}
        </ol>
        <p className="muted-copy">
          A impressão usa <code>com.elgin.e1.Impressora.Termica</code>: tipo 6 e modelo M8 para a impressora interna, e tipo 3 para IP, conforme os exemplos oficiais Elgin. O retorno do SDK confirma o envio dos comandos, não a saída física do papel; confira a impressão no equipamento. Pedidos permanecem no aparelho; a impressora IP precisa estar na rede local.
        </p>
      </section>
      {previewOpen && (
        <ReceiptPreview
          nativePrinter={nativePrinter}
          onClose={() => setPreviewOpen(false)}
          onPrint={nativePrinter ? printTest : () => window.print()}
        />
      )}
    </main>
  );
}

function ReceiptPreview({ nativePrinter, onClose, onPrint }) {
  const now = new Date();
  const date = `${new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(now)} ${new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now)}`;

  return (
    <div className="receipt-preview-backdrop">
      <section className="receipt-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="receipt-preview-title">
        <header className="receipt-preview-toolbar">
          <div>
            <p className="eyebrow">BOBINA TÉRMICA</p>
            <h2 id="receipt-preview-title">Prévia de impressão · 57 mm</h2>
          </div>
          <button className="receipt-preview-close" type="button" aria-label="Fechar prévia" onClick={onClose}>×</button>
        </header>
        <div className="container-preview">
          <div className="receipt-paper">
            <div className="receipt-center receipt-bold">
              HOTEL COLONIAL<br />
              CAFÉ DA MANHÃ
            </div>
            <div className="receipt-separator" />
            <div>COMANDA #TESTE<br />{date}</div>
            <div className="receipt-separator" />
            <div>QUARTO: 57mm<br />HOSPEDE: Demonstracao</div>
            <div className="receipt-separator" />
            <div className="receipt-bold">TAPIOCA - SALGADA</div>
            <div className="receipt-bold">INGREDIENTES (3)</div>
            <div className="receipt-indent">- Queijo<br />- Presunto<br />- Tomate</div>
            <div className="receipt-separator" />
            <div>PREPARO: 30 MIN</div>
            <div className="receipt-separator" />
          </div>
        </div>
        <div className="receipt-preview-actions">
          <button className="button button--secondary" type="button" onClick={onClose}>Fechar prévia</button>
          <button className="button" type="button" onClick={onPrint}>
            {nativePrinter ? "Imprimir teste pelo SDK Elgin" : "Imprimir cupom"}
          </button>
        </div>
        <p className="receipt-preview-note">
          {nativePrinter
            ? "No M10, o teste é enviado pela impressora integrada. Esta prévia representa o layout; a impressão real usa o SDK Elgin."
            : "A impressão do navegador usa a largura de 57 mm configurada nesta prévia."}
        </p>
      </section>
    </div>
  );
}

const ORDER_STATUSES = [
  { id: "new", label: "Novo" },
  { id: "preparing", label: "Preparando" },
  { id: "ready", label: "Pronto" },
  { id: "delivered", label: "Entregue" },
  { id: "cancelled", label: "Cancelado" },
];

function OrdersPage({ onNavigate }) {
  const [orders, setOrders] = useState(() => getOrders());
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [filter, setFilter] = useState("all");
  const [dayFilter, setDayFilter] = useState(() => getLocalDay({ createdAt: new Date().toISOString() }));
  const [kindFilter, setKindFilter] = useState("all");
  const [error, setError] = useState("");
  const [printingOrders, setPrintingOrders] = useState(() => new Set());
  const [tvToken, setTvToken] = useState(() => getTvReadyToken());
  const [tvTokenDraft, setTvTokenDraft] = useState(() => getTvReadyToken());
  const [tvSyncMessage, setTvSyncMessage] = useState("");
  const syncingTvRef = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const refresh = () => setOrders(getOrders());
  const syncPendingTvNotices = async () => {
    if (syncingTvRef.current) return;
    syncingTvRef.current = true;
    try {
      const result = await syncReadyOrderQueue(tvToken);
      refresh();
      if (result.expired) {
        setTvSyncMessage(`${result.expired} aviso(s) expiraram sem serem enviados.`);
      } else if (result.disabled) {
        setTvSyncMessage("Os avisos de pedidos estão desativados no TV Admin.");
      } else if (result.error) {
        setTvSyncMessage(result.error);
      } else if (result.sent) {
        setTvSyncMessage(`${result.sent} aviso(s) enviado(s) para as TVs.`);
      }
    } catch (cause) {
      setTvSyncMessage(cause.message);
    } finally {
      syncingTvRef.current = false;
    }
  };

  useEffect(() => {
    syncPendingTvNotices();
    const timer = window.setInterval(syncPendingTvNotices, 10000);
    window.addEventListener("online", syncPendingTvNotices);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", syncPendingTvNotices);
    };
  }, [tvToken]);

  const changeStatus = async (id, status) => {
    try {
      const updated = updateLocalOrder(id, { status });
      if (status === "ready") {
        queueReadyOrder(updated);
        refresh();
        await syncPendingTvNotices();
      } else {
        refresh();
      }
      setError("");
    } catch (cause) {
      setError(cause.message);
    }
  };

  const saveTvToken = () => {
    try {
      setTvToken(saveTvReadyToken(tvTokenDraft));
      setTvSyncMessage("Token de integração salvo neste aparelho.");
    } catch (cause) {
      setTvSyncMessage(cause.message);
    }
  };

  const sendReadyOrderToTv = async (order) => {
    try {
      queueReadyOrder(order, { force: true });
      refresh();
      await syncPendingTvNotices();
    } catch (cause) {
      setTvSyncMessage(cause.message);
    }
  };

  const reprint = async (order) => {
    if (printingOrders.has(order.id)) return;
    setPrintingOrders((current) => new Set(current).add(order.id));
    try {
      await printReceipt(order);
      updateLocalOrder(order.id, { printStatus: "printed", printError: "" });
      refresh();
      setError("");
    } catch (cause) {
      updateLocalOrder(order.id, { printStatus: "failed", printError: cause.message });
      refresh();
      setError(`Falha ao imprimir #${order.id}: ${cause.message}`);
    } finally {
      setPrintingOrders((current) => {
        const next = new Set(current);
        next.delete(order.id);
        return next;
      });
    }
  };

  const sortedOrders = [...orders].sort((first, second) => {
    const firstDelivered = first.status === "delivered" ? 1 : 0;
    const secondDelivered = second.status === "delivered" ? 1 : 0;
    return firstDelivered - secondDelivered
      || new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime();
  });
  const availableDays = [...new Set(sortedOrders.map(getLocalDay))].filter((day) => day !== "data-invalida");
  const today = getLocalDay({ createdAt: new Date().toISOString() });
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = getLocalDay({ createdAt: yesterdayDate.toISOString() });
  const dateLabel = (day) => new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  }).format(new Date(`${day}T12:00:00`));
  const dayOptions = [
    { id: "all", label: "Todos os dias" },
    { id: today, label: "Hoje" },
    ...(availableDays.includes(yesterday) ? [{ id: yesterday, label: "Ontem" }] : []),
    ...availableDays
      .filter((day) => day !== today && day !== yesterday)
      .map((day) => ({ id: day, label: new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(new Date(`${day}T12:00:00`)) })),
  ];
  const visibleOrders = sortedOrders.filter((order) => {
    if (filter !== "all" && order.status !== filter) return false;
    if (dayFilter !== "all" && getLocalDay(order) !== dayFilter) return false;
    if (kindFilter === "salgada" || kindFilter === "doce" || kindFilter === "mista") {
      return getTapiocaKind(order) === kindFilter;
    }
    if (kindFilter === "omelete") return order.product === "Omelete";
    return true;
  });
  const createDailyGroups = (dayOrders) => [...new Set(dayOrders.map(getLocalDay))].map((day) => ({
    day,
    orders: dayOrders.filter((order) => getLocalDay(order) === day),
  }));
  const activeDailyGroups = createDailyGroups(visibleOrders.filter((order) => order.status !== "delivered"));
  const deliveredDailyGroups = createDailyGroups(visibleOrders.filter((order) => order.status === "delivered"));
  const groupByApartment = (dayOrders) => {
    const groups = new Map();
    dayOrders.forEach((order) => {
      const room = order.room.trim() || "Sem apartamento";
      const normalizedRoom = room.replace(/^(?:apt(?:o)?|apartamento|quarto)\.?\s*/i, "").trim() || "Sem apartamento";
      const key = normalizedRoom.toLocaleLowerCase("pt-BR");
      if (!groups.has(key)) groups.set(key, { room: normalizedRoom, orders: [] });
      groups.get(key).orders.push(order);
    });
    return [...groups.values()].sort((first, second) => first.room.localeCompare(second.room, "pt-BR", { numeric: true }));
  };
  const renderDailyGroups = (groups) => groups.map(({ day, orders: dayOrders }) => (
    <section className="day-group" key={day}>
      <header className="day-group-heading">
        <div>
          <span className="eyebrow">PEDIDOS DO DIA</span>
          <h2>{day === today ? "Hoje" : day === yesterday ? "Ontem" : dateLabel(day)}</h2>
        </div>
        <span className="day-count">{dayOrders.length} {dayOrders.length === 1 ? "pedido" : "pedidos"}</span>
      </header>
      <div className="apartment-groups">
        {groupByApartment(dayOrders).map(({ room, orders: apartmentOrders }) => (
          <section className="apartment-group" key={`${day}-${room}`}>
            <header className="apartment-heading">
              <span className="apartment-icon" aria-hidden="true">⌂</span>
              <h3>Apto {room}</h3>
              <span>{apartmentOrders.length} {apartmentOrders.length === 1 ? "comanda" : "comandas"}</span>
            </header>
            <div className="orders-list">
              {apartmentOrders.map((order) => {
                const currentStatus = ORDER_STATUSES.find((status) => status.id === order.status) || ORDER_STATUSES[0];
                const deadline = Date.parse(order.createdAt) + 30 * 60 * 1000;
                const remainingMs = deadline - clockNow;
                const showCountdown = !["delivered", "cancelled"].includes(order.status) && Number.isFinite(deadline);
                const countdownSeconds = Math.ceil(Math.abs(remainingMs) / 1000);
                const countdown = `${remainingMs < 0 ? "-" : ""}${String(Math.floor(countdownSeconds / 60)).padStart(2, "0")}:${String(countdownSeconds % 60).padStart(2, "0")}`;
                return (
                  <article className={`order-card order-card--${order.status}`} key={order.id}>
                    <div className="order-card-top">
                      <div className="order-number">
                        <span>COMANDA</span>
                        <strong>#{order.id}</strong>
                      </div>
                      <span className={`order-status order-status--${order.status}`}>{currentStatus.label}</span>
                    </div>
                    <div className="order-customer">
                      <h2>{order.customerName}</h2>
                      <span>QUARTO {order.room}</span>
                    </div>
                    <div className="order-details">
                      <span className="order-product">
                        {order.product}
                        {getTapiocaKind(order) && ` · ${getTapiocaKind(order)}`}
                      </span>
                      <span>{order.ingredients.join(" · ")}</span>
                    </div>
                    {showCountdown && (
                      <div className={`order-countdown${remainingMs < 0 ? " order-countdown--late" : ""}`} role="timer">
                        <span>{remainingMs < 0 ? "TEMPO ESGOTADO" : "TEMPO PARA PREPARO"}</span>
                        <strong>{countdown}</strong>
                      </div>
                    )}
                    <div className="order-card-bottom">
                      <time dateTime={order.createdAt}>
                        {new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(order.createdAt))}
                        <span>{new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(new Date(order.createdAt))}</span>
                      </time>
                      <div className="order-actions">
                        <button className="icon-action" type="button" onClick={() => reprint(order)} disabled={printingOrders.has(order.id)} aria-label={`Imprimir novamente comanda ${order.id}`} title={printingOrders.has(order.id) ? "Imprimindo…" : "Imprimir novamente"}>
                          <PrinterIcon />
                          <span>Imprimir</span>
                        </button>
                        <button className="button order-next-action order-send-tv-button" type="button" onClick={() => sendReadyOrderToTv(order)}>
                          Enviar para TV
                        </button>
                        <button
                          className="button order-next-action"
                          type="button"
                          onClick={() => changeStatus(order.id, order.status === "delivered" ? "new" : "delivered")}
                          disabled={order.status === "cancelled"}
                        >
                          {order.status === "delivered" ? "Reabrir" : order.status === "cancelled" ? "Cancelado" : "Entregue"}
                        </button>
                      </div>
                    </div>
                    {order.printStatus === "failed" && (
                      <p className="order-print-warning" role="status">Impressão pendente: {order.printError}</p>
                    )}
                    {order.tvNoticeStatus === "pending" && (
                      <p className="order-print-warning" role="status">Aviso da TV pendente: {order.tvNoticeError || "tentaremos novamente quando houver conexão."}</p>
                    )}
                    {order.tvNoticeStatus === "expired" && (
                      <p className="order-print-warning" role="status">{order.tvNoticeError}</p>
                    )}
                    {order.tvNoticeStatus === "disabled" && (
                      <p className="order-print-warning" role="status">{order.tvNoticeError}</p>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  ));
  const activeCount = orders.filter((order) => !["delivered", "cancelled"].includes(order.status)).length;

  return (
    <main className="content-page orders-page">
      <Header title="Pedidos" onNavigate={onNavigate} eyebrow="CENTRAL DO CAFÉ" />
      <section className="orders-overview">
        <div className="orders-overview-copy">
          <span className="eyebrow">CENTRAL DE COMANDAS</span>
          <h2>{activeCount === 0 ? "Tudo tranquilo por aqui" : `${activeCount} ${activeCount === 1 ? "pedido em aberto" : "pedidos em aberto"}`}</h2>
          <p>{visibleOrders.length} com {dayFilter === "all" ? "todas as datas" : dayFilter === today ? "data de hoje" : dateLabel(dayFilter)} · agrupados por apartamento</p>
        </div>
        <span className="orders-count">{String(visibleOrders.length).padStart(2, "0")}<small>VISÍVEIS</small></span>
      </section>

      <section className="panel tv-sync-panel">
        <div>
          <h2>Avisos nas TVs</h2>
          <p>O nome e o quarto aparecem em todas as TVs por 30 segundos.</p>
        </div>
        <label className="field">
          <span>Token de integração</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck="false"
            value={tvTokenDraft}
            onChange={(event) => setTvTokenDraft(event.target.value)}
            placeholder="Informe o token configurado no servidor"
          />
        </label>
        <button className="button button--secondary" type="button" onClick={saveTvToken}>Salvar token</button>
        {tvSyncMessage && (
          <p className={`notice ${tvSyncMessage.includes("enviado") || tvSyncMessage.includes("salvo") ? "notice--success" : "notice--error"}`} role="status">
            {tvSyncMessage}
          </p>
        )}
      </section>

      <div className="order-filters day-filters" role="group" aria-label="Filtrar por dia">
        {dayOptions.map((item) => (
          <button
            type="button"
            key={item.id}
            className={`filter-chip ${dayFilter === item.id ? "filter-chip--active" : ""}`}
            aria-pressed={dayFilter === item.id}
            onClick={() => setDayFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="order-filters kind-filters" role="group" aria-label="Filtrar por tipo de pedido">
        {[
          { id: "all", label: "Todos" },
          { id: "salgada", label: "Tapiocas salgadas" },
          { id: "doce", label: "Tapiocas doces" },
          { id: "mista", label: "Mistas antigas" },
          { id: "omelete", label: "Omeletes" },
        ].map((item) => (
          <button
            type="button"
            key={item.id}
            className={`filter-chip ${kindFilter === item.id ? "filter-chip--active" : ""}`}
            aria-pressed={kindFilter === item.id}
            onClick={() => setKindFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="order-filters" role="group" aria-label="Filtrar pedidos">
        {[{ id: "all", label: "Todos" }, ...ORDER_STATUSES].map((item) => (
          <button
            type="button"
            key={item.id}
            className={`filter-chip ${filter === item.id ? "filter-chip--active" : ""}`}
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
            {item.id === "new" && orders.filter((order) => order.status === "new").length > 0 && (
              <span className="filter-count">{orders.filter((order) => order.status === "new").length}</span>
            )}
          </button>
        ))}
      </div>

      {error && <div className="notice notice--error" role="alert">{error}</div>}

      {visibleOrders.length === 0 ? (
        <section className="empty-orders panel">
          <span className="empty-orders-icon" aria-hidden="true">✦</span>
          <h2>{orders.length === 0 ? "Sua primeira comanda começa aqui" : "Nenhum pedido com estes filtros"}</h2>
          <p>{orders.length === 0 ? "Escolha tapioca ou omelete e os pedidos aparecerão nesta aba." : "Mude o dia, tipo ou etapa, ou consulte todas as datas."}</p>
          {orders.length === 0 && (
            <Link href="/" onNavigate={onNavigate} className="button">Abrir cardápio</Link>
          )}
        </section>
      ) : (
        <div className="daily-orders">
          {renderDailyGroups(activeDailyGroups)}
          {deliveredDailyGroups.length > 0 && (
            <section className="delivered-orders">
              <header className="day-group-heading">
                <div>
                  <span className="eyebrow">FINALIZADOS</span>
                  <h2>Pedidos entregues</h2>
                </div>
              </header>
              {renderDailyGroups(deliveredDailyGroups)}
            </section>
          )}
        </div>
      )}
    </main>
  );
}

function PrinterIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="printer-icon">
      <path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M7 14h10v7H7z" />
      <path d="M18 11h.01" />
    </svg>
  );
}

function AttendantApp() {
  const [form, setForm] = useState(() => {
    try {
      return getAttendantConnection();
    } catch (error) {
      console.error("Configuração local de atendimento inválida:", error);
      return { ip: "", token: "" };
    }
  });
  const [connection, setConnection] = useState(form);
  const [connectionEditorOpen, setConnectionEditorOpen] = useState(!form.ip || !form.token);
  const [tvToken, setTvToken] = useState(() => getTvReadyToken());
  const [tvTokenDraft, setTvTokenDraft] = useState(() => getTvReadyToken());
  const [tvTokenEditorOpen, setTvTokenEditorOpen] = useState(false);
  const [orders, setOrders] = useState([]);
  const [activeTab, setActiveTab] = useState("preparing");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [loadingOrderId, setLoadingOrderId] = useState("");
  const [automaticPrints, setAutomaticPrints] = useState({});
  const [tvNotices, setTvNotices] = useState({});
  const syncingRef = useRef(false);
  const ordersSnapshotRef = useRef("");
  const printQueueRef = useRef([]);
  const queuedPrintsRef = useRef(new Set());
  const printWorkerRunningRef = useRef(false);

  const updateOrders = (nextOrders) => {
    const snapshot = JSON.stringify(nextOrders);
    if (snapshot === ordersSnapshotRef.current) return;
    ordersSnapshotRef.current = snapshot;
    setOrders(nextOrders);
  };

  useEffect(() => {
    document.documentElement.classList.add("attendant-screen");
    return () => document.documentElement.classList.remove("attendant-screen");
  }, []);

  const saveAutomaticPrintState = (key, status, printError = "") => {
    const ledger = getAttendantPrintLedger();
    const entry = { status, error: printError };
    ledger[key] = entry;
    localStorage.setItem(ATTENDANT_PRINT_STORAGE_KEY, JSON.stringify(ledger));
    setAutomaticPrints((current) => ({ ...current, [key]: entry }));
  };

  const waitForAutomaticPrintRetry = (delay) =>
    new Promise((resolve) => window.setTimeout(resolve, delay));

  const drainAutomaticPrintQueue = async () => {
    if (printWorkerRunningRef.current) return;
    printWorkerRunningRef.current = true;
    try {
      while (printQueueRef.current.length > 0) {
        const { order, key } = printQueueRef.current.shift();
        let status = "printed";
        let printError = "";
        for (let attempt = 0; ; attempt += 1) {
          try {
            if (!hasNativePrinter()) {
              throw new Error("A impressão automática está disponível somente no APK Atendente instalado no M10.");
            }
            await printReceipt(order, { ...getPrinterConfig(), type: "internal" });
            printError = "";
            break;
          } catch (cause) {
            const retryDelay = cause.retryable === true
              ? AUTOMATIC_PRINT_RETRY_DELAYS[attempt]
              : undefined;
            if (retryDelay === undefined) {
              status = "failed";
              printError = cause instanceof Error ? cause.message : "Não foi possível imprimir esta comanda.";
              break;
            }
            printError = `Falha ao conectar à impressora. Nova tentativa ${attempt + 1} de ${AUTOMATIC_PRINT_RETRY_DELAYS.length} em ${retryDelay / 1000}s.`;
            try {
              saveAutomaticPrintState(key, "printing", printError);
            } catch (saveError) {
              setError(`Não foi possível salvar o estado da impressão automática: ${saveError.message}`);
            }
            await waitForAutomaticPrintRetry(retryDelay);
          }
        }

        try {
          saveAutomaticPrintState(key, status, printError);
        } catch (cause) {
          setAutomaticPrints((current) => ({
            ...current,
            [key]: { status, error: printError },
          }));
          setError(`Não foi possível salvar o resultado da impressão automática: ${cause.message}`);
        } finally {
          queuedPrintsRef.current.delete(key);
        }
      }
    } finally {
      printWorkerRunningRef.current = false;
    }
  };

  const queueAutomaticPrint = (order) => {
    const key = getAttendantPrintKey(connection.ip, order);
    if (queuedPrintsRef.current.has(key)) return;
    try {
      saveAutomaticPrintState(key, "printing");
      queuedPrintsRef.current.add(key);
      printQueueRef.current.push({ order, key });
      void drainAutomaticPrintQueue();
    } catch (cause) {
      setError(`Não foi possível preparar a impressão automática: ${cause.message}`);
    }
  };

  const queueUnprintedOrders = (incomingOrders) => {
    if (!connection.ip || incomingOrders.length === 0) return;
    try {
      const ledger = getAttendantPrintLedger();
      const printQueue = [];
      const printStates = {};
      let ledgerChanged = false;
      const preparingOrders = incomingOrders
        .filter((order) => !["delivered", "cancelled"].includes(order.status))
        .sort((first, second) => Date.parse(first.createdAt) - Date.parse(second.createdAt));

      for (const order of preparingOrders) {
        const key = getAttendantPrintKey(connection.ip, order);
        let entry = ledger[key];
        if (entry?.status === "printing" && !queuedPrintsRef.current.has(key)) {
          entry = {
            status: "failed",
            error: "A impressão foi interrompida. Confira se a comanda saiu antes de tentar novamente.",
          };
          ledger[key] = entry;
          ledgerChanged = true;
        }
        if (!entry) {
          entry = { status: "printing", error: "" };
          ledger[key] = entry;
          printQueue.push({ order, key });
          ledgerChanged = true;
        }
        printStates[key] = entry;
      }

      if (ledgerChanged) {
        localStorage.setItem(ATTENDANT_PRINT_STORAGE_KEY, JSON.stringify(ledger));
      }
      setAutomaticPrints((current) => ({ ...current, ...printStates }));
      if (printQueue.length > 0) {
        for (const item of printQueue) {
          queuedPrintsRef.current.add(item.key);
          printQueueRef.current.push(item);
        }
        void drainAutomaticPrintQueue();
      }
    } catch (cause) {
      setError(`Não foi possível preparar a impressão automática: ${cause.message}`);
    }
  };

  useEffect(() => {
    if (!connection.ip || !connection.token) {
      updateOrders([]);
      setConnected(false);
      return undefined;
    }
    let active = true;
    const syncOrders = async () => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      try {
        const response = await requestLocalOrders(connection.ip, connection.token);
        if (!Array.isArray(response.orders)) {
          throw new Error("O servidor local retornou uma lista de pedidos inválida.");
        }
        if (active) {
          queueUnprintedOrders(response.orders);
          updateOrders(response.orders);
          setConnected(true);
          setError("");
        }
      } catch (cause) {
        if (active) {
          setConnected(false);
          setError(cause.message);
        }
      } finally {
        syncingRef.current = false;
      }
    };
    syncOrders();
    const timer = window.setInterval(syncOrders, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [connection.ip, connection.token]);

  const retryAutomaticPrint = (order) => {
    queueAutomaticPrint(order);
  };

  const sendOrderNoticeToTv = async (order) => {
    const key = getAttendantPrintKey(connection.ip, order);
    setTvNotices((current) => ({ ...current, [key]: { status: "pending", message: "Enviando aviso para as TVs…" } }));
    try {
      queueReadyOrder(order, { force: true });
      const result = await syncReadyOrderQueue(tvToken);
      if (result.sent > 0) {
        setTvNotices((current) => ({ ...current, [key]: { status: "sent", message: "Aviso enviado para as TVs." } }));
      } else if (result.disabled > 0) {
        setTvNotices((current) => ({ ...current, [key]: { status: "disabled", message: "Avisos desativados no TV Admin." } }));
      } else {
        setTvNotices((current) => ({
          ...current,
          [key]: { status: "failed", message: result.error || "O aviso ficou pendente para envio." },
        }));
      }
    } catch (cause) {
      setTvNotices((current) => ({ ...current, [key]: { status: "failed", message: cause.message } }));
    }
  };

  const saveAttendantTvToken = (event) => {
    event.preventDefault();
    try {
      setTvToken(saveTvReadyToken(tvTokenDraft));
      setTvTokenEditorOpen(false);
      setError("");
    } catch (cause) {
      setError(cause.message);
    }
  };

  const saveConnection = (event) => {
    event.preventDefault();
    try {
      const saved = saveAttendantConnection(form.ip, form.token);
      setConnection(saved);
      setConnectionEditorOpen(false);
      setError("");
    } catch (cause) {
      setError(cause.message);
    }
  };

  const completeOrder = async (order) => {
    if (loadingOrderId) return;
    setLoadingOrderId(order.id);
    try {
      const response = await completeLocalOrder(connection.ip, connection.token, order.id);
      if (!Array.isArray(response.orders)) {
        throw new Error("O servidor local retornou uma lista de pedidos inválida.");
      }
      updateOrders(response.orders);
      setConnected(true);
      setError("");
    } catch (cause) {
      setConnected(false);
      setError(cause.message);
    } finally {
      setLoadingOrderId("");
    }
  };

  const reopenOrderForPreparation = async (order) => {
    if (loadingOrderId) return;
    setLoadingOrderId(order.id);
    try {
      const response = await reopenLocalOrder(connection.ip, connection.token, order.id);
      if (!Array.isArray(response.orders)) {
        throw new Error("O servidor local retornou uma lista de pedidos inválida.");
      }
      updateOrders(response.orders);
      setConnected(true);
      setActiveTab("preparing");
      setError("");
    } catch (cause) {
      setConnected(false);
      setError(cause.message);
    } finally {
      setLoadingOrderId("");
    }
  };

  const activeOrders = useMemo(() => orders
    .filter((order) => !["delivered", "cancelled"].includes(order.status))
    .sort((first, second) => Date.parse(first.createdAt) - Date.parse(second.createdAt)), [orders]);
  const completedOrders = useMemo(() => orders
    .filter((order) => order.status === "delivered")
    .sort((first, second) => Date.parse(second.completedAt || second.createdAt) - Date.parse(first.completedAt || first.createdAt)), [orders]);
  const productOrders = (product) => activeOrders.filter((order) => order.product === product);
  const waitingOrders = (product) => productOrders(product).slice(4);
  const waitingOrderCount = ["Tapioca", "Omelete"].reduce(
    (total, product) => total + waitingOrders(product).length,
    0,
  );
  const visibleOrderCount = ["Tapioca", "Omelete"].reduce(
    (total, product) => total + Math.min(productOrders(product).length, 4),
    0,
  );

  return (
    <main className="attendant-page">
      <header className="attendant-header">
        <div>
          <p className="eyebrow">HOTEL COLONIAL PLAZA · ATENDIMENTO</p>
          <h1>Pedidos do Café</h1>
        </div>
        <span className={`attendant-connection${connected ? " attendant-connection--online" : ""}`}>
          <span aria-hidden="true" />
          {connected ? "Conectado" : "Sem conexão"}
        </span>
        {connection.ip && (
          <>
            <button
              className="attendant-config-toggle"
              type="button"
              aria-expanded={tvTokenEditorOpen}
              onClick={() => setTvTokenEditorOpen((open) => !open)}
            >
              {tvTokenEditorOpen ? "Fechar TV" : "Token TV"}
            </button>
            <button
              className="attendant-config-toggle"
              type="button"
              aria-expanded={connectionEditorOpen}
              onClick={() => setConnectionEditorOpen((open) => !open)}
            >
              {connectionEditorOpen ? "Fechar conexão" : "Conexão"}
            </button>
          </>
        )}
      </header>

      {tvTokenEditorOpen && (
        <form className="panel attendant-tv-token-form" onSubmit={saveAttendantTvToken}>
          <label className="field">
            <span>Token para enviar avisos às TVs</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck="false"
              value={tvTokenDraft}
              onChange={(event) => setTvTokenDraft(event.target.value)}
              placeholder="Token configurado no servidor das TVs"
            />
          </label>
          <button className="button" type="submit">Salvar token TV</button>
        </form>
      )}

      {connectionEditorOpen && <form className="panel attendant-connection-form" onSubmit={saveConnection}>
        <label className="field">
          <span>IP do M10 do hóspede</span>
          <input
            autoCapitalize="none"
            autoComplete="off"
            inputMode="decimal"
            maxLength={15}
            placeholder="Ex.: 192.168.1.25"
            required
            value={form.ip}
            onChange={(event) => setForm({ ...form, ip: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Código de conexão</span>
          <input
            autoCapitalize="characters"
            autoComplete="off"
            maxLength={10}
            placeholder="Código mostrado em Impressora no M10 do hóspede"
            required
            value={form.token}
            onChange={(event) => setForm({ ...form, token: event.target.value.toUpperCase() })}
          />
        </label>
        <button className="button" type="submit">Conectar ao M10 do hóspede</button>
        <small>Os dois aparelhos precisam estar na mesma rede Wi‑Fi. A comunicação não usa internet.</small>
      </form>}

      {error && <p className="notice notice--error attendant-error" role="status">{error}</p>}

      <nav className="attendant-tabs" aria-label="Visualização dos pedidos">
        <button
          className={activeTab === "preparing" ? "attendant-tab attendant-tab--active" : "attendant-tab"}
          type="button"
          onClick={() => setActiveTab("preparing")}
        >
          Em preparo <span>{visibleOrderCount}</span>
        </button>
        <button
          className={activeTab === "waiting" ? "attendant-tab attendant-tab--active" : "attendant-tab"}
          type="button"
          onClick={() => setActiveTab("waiting")}
        >
          Novos pedidos <span>{waitingOrderCount}</span>
        </button>
        <button
          className={activeTab === "completed" ? "attendant-tab attendant-tab--active" : "attendant-tab"}
          type="button"
          onClick={() => setActiveTab("completed")}
        >
          Concluídos <span>{completedOrders.length}</span>
        </button>
      </nav>

      {activeTab === "preparing" ? (
        <div className="attendant-columns">
          {["Tapioca", "Omelete"].map((product) => {
            const queuedOrders = productOrders(product);
            return (
              <section className={`attendant-column attendant-column--${product.toLowerCase()}`} key={product}>
                <header className="attendant-column-header">
                  <h2>{product}</h2>
                  <span>{queuedOrders.length} aguardando</span>
                </header>
                {queuedOrders.length === 0 ? (
                  <div className="attendant-empty">Nenhum pedido na fila</div>
                ) : (
                  <div className="attendant-orders">
                    {queuedOrders.slice(0, 4).map((order) => (
                      <article className="attendant-order" key={order.id}>
                        <div className="attendant-order-top">
                          <strong>#{order.id}</strong>
                          <time dateTime={order.createdAt}>
                            {new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(order.createdAt))}
                          </time>
                        </div>
                        <h3>{order.customerName}</h3>
                        <p className="attendant-room">QUARTO {order.room}</p>
                        <p className="attendant-variant">{order.product === "Tapioca" ? order.variant || "\u00a0" : "\u00a0"}</p>
                        <p className="attendant-ingredients">{order.ingredients.join(" · ")}</p>
                        {(() => {
                          const printState = automaticPrints[getAttendantPrintKey(connection.ip, order)];
                          const tvNotice = tvNotices[getAttendantPrintKey(connection.ip, order)];
                          if (!printState && !tvNotice) return null;
                          return (
                            <div className="attendant-order-feedback">
                              {printState && (
                                <span className={`attendant-print-status attendant-print-status--${printState.status}`} role="status">
                                  {printState.status === "printed" && "Impressão automática enviada"}
                                  {printState.status === "printing" && (printState.error || "Imprimindo comanda…")}
                                  {printState.status === "failed" && `Falha na impressão: ${printState.error}`}
                                </span>
                              )}
                              {tvNotice && (
                                <span className={`attendant-tv-status attendant-tv-status--${tvNotice.status}`} role="status">
                                  {tvNotice.message}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                        <div className="attendant-order-actions">
                          <button
                            className="button attendant-order-action attendant-print-action"
                            type="button"
                            disabled={queuedPrintsRef.current.has(getAttendantPrintKey(connection.ip, order))}
                            onClick={() => retryAutomaticPrint(order)}
                            aria-label={`Imprimir comanda ${order.id}`}
                          >
                            <PrinterIcon /> Imprimir
                          </button>
                          <button
                            className="button attendant-order-action attendant-tv-action"
                            type="button"
                            disabled={!connected}
                            onClick={() => sendOrderNoticeToTv(order)}
                          >
                            Enviar TV
                          </button>
                          <button
                            className="button attendant-order-action attendant-complete"
                            type="button"
                            disabled={loadingOrderId === order.id || !connected}
                            onClick={() => completeOrder(order)}
                          >
                            {loadingOrderId === order.id ? "Concluindo…" : "Concluir"}
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : activeTab === "waiting" ? (
        <div className="attendant-waiting-columns">
          {["Tapioca", "Omelete"].map((product) => {
            const queuedOrders = waitingOrders(product);
            return (
              <section className={`attendant-column attendant-column--${product.toLowerCase()}`} key={product}>
                <header className="attendant-column-header">
                  <h2>{product}</h2>
                  <span>{queuedOrders.length} na espera</span>
                </header>
                {queuedOrders.length === 0 ? (
                  <div className="attendant-empty">Nenhum pedido aguardando vaga</div>
                ) : (
                  <ol className="attendant-waiting-list">
                    {queuedOrders.map((order, index) => (
                      <li className="attendant-waiting-order" key={order.id}>
                        <span className="attendant-waiting-position">{index + 5}</span>
                        <div>
                          <strong>#{order.id} · {order.customerName}</strong>
                          <span>Quarto {order.room} · {order.product === "Tapioca" ? order.variant : "Omelete"}</span>
                          <span>{order.ingredients.join(" · ")}</span>
                        </div>
                        <time dateTime={order.createdAt}>
                          {new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(order.createdAt))}
                        </time>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            );
          })}
          {waitingOrderCount > 0 && (
            <p className="attendant-queue-note">
              Os pedidos entram nos cartões de preparo automaticamente quando uma vaga for liberada.
            </p>
          )}
        </div>
      ) : (
        <section className="attendant-completed-list" aria-label="Pedidos concluídos">
          {completedOrders.length === 0 ? (
            <div className="attendant-empty">Nenhum pedido concluído ainda.</div>
          ) : completedOrders.map((order) => (
            <article className="attendant-completed-order" key={order.id}>
              <div>
                <strong>#{order.id} · {order.product}</strong>
                <span>{order.customerName} · Quarto {order.room}</span>
              </div>
              <time dateTime={order.completedAt || order.createdAt}>
                {new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(order.completedAt || order.createdAt))}
              </time>
              <button
                className="button attendant-reopen"
                type="button"
                disabled={loadingOrderId === order.id || !connected}
                onClick={() => reopenOrderForPreparation(order)}
              >
                {loadingOrderId === order.id ? "Reabrindo…" : "Reabrir"}
              </button>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}

function GuestApp() {
  const [path, setPath] = useState(window.location.pathname);
  const [teamMenuOpen, setTeamMenuOpen] = useState(false);

  useEffect(() => {
    const applyOrders = (event) => {
      try {
        replaceLocalOrders(event.detail);
      } catch (error) {
        console.error("Não foi possível atualizar os pedidos sincronizados:", error);
      }
    };
    window.addEventListener("m10-local-orders-updated", applyOrders);
    try {
      window.M10Printer?.publishLocalOrders(JSON.stringify(getOrders()));
    } catch (error) {
      console.error("Não foi possível iniciar a sincronização local dos pedidos:", error);
    }
    return () => window.removeEventListener("m10-local-orders-updated", applyOrders);
  }, []);

  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("home-screen", path === "/");
    return () => document.documentElement.classList.remove("home-screen");
  }, [path]);

  const navigate = (nextPath) => {
    if (nextPath === path) return;
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
    setTeamMenuOpen(false);
    window.scrollTo(0, 0);
  };

  const route = useMemo(() => {
    if (path === "/pedido/tapioca") return <OrderPage key={path} type="tapioca" onNavigate={navigate} />;
    if (path === "/pedido/omelete") return <OrderPage key={path} type="omelete" onNavigate={navigate} />;
    if (path === "/impressora") return <PrinterPage onNavigate={navigate} />;
    if (path === "/pedidos") return APP_MODE === "guest"
      ? <Home onNavigate={navigate} />
      : <OrdersPage onNavigate={navigate} />;
    return <Home onNavigate={navigate} />;
  }, [path]);

  return (
    <>
      {route}
      {path !== "/" && (
        <footer className="site-footer"><Brand compact /><span>Café da manhã feito com carinho</span></footer>
      )}
      <div className={`team-access ${teamMenuOpen ? "team-access--open" : ""}`}>
        {teamMenuOpen && (
          <nav className="team-menu" aria-label="Menu da equipe">
            <Link href="/" onNavigate={navigate} className="team-menu-link">
              <span aria-hidden="true">⌂</span> Cardápio
            </Link>
            {APP_MODE !== "guest" && (
              <Link href="/pedidos" onNavigate={navigate} className="team-menu-link">
                <span aria-hidden="true">▤</span> Pedidos
              </Link>
            )}
            <Link href="/impressora" onNavigate={navigate} className="team-menu-link">
              <PrinterIcon /> Impressora
            </Link>
          </nav>
        )}
        <button
          className="team-access-toggle"
          type="button"
          aria-expanded={teamMenuOpen}
          aria-label={teamMenuOpen ? "Fechar menu da equipe" : "Abrir menu da equipe"}
          onClick={() => setTeamMenuOpen((open) => !open)}
        >
          <span aria-hidden="true">{teamMenuOpen ? "×" : "⋯"}</span>
          <small>{teamMenuOpen ? "Fechar" : "Equipe"}</small>
        </button>
      </div>
    </>
  );
}

export default function App() {
  return APP_MODE === "attendant" ? <AttendantApp /> : <GuestApp />;
}
