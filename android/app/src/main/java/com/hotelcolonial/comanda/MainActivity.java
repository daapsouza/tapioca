package com.hotelcolonial.comanda;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.util.Log;

import androidx.webkit.WebViewAssetLoader;

import com.elgin.e1.Impressora.Termica;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.KeyStore;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

public final class MainActivity extends Activity {
    private static final String PRINTER_LOG_TAG = "M10Printer";
    private static final String APP_URL =
            "https://appassets.androidplatform.net/assets/www/index.html";
    private static final String READY_ORDER_API_URL =
            "https://tvadmin.colonialplazapinda.com.br/backend/api/orders/ready-notice.php";
    private static final int RECEIPT_WIDTH = 18;
    private static final int IMMERSIVE_FLAGS =
            View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;

    private WebView webView;
    private boolean printerConnected;
    private volatile boolean keyboardVisible;
    private String connectedPrinterKey = "";
    private final Object printerLock = new Object();
    private final ExecutorService printerExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean printJobRunning = new AtomicBoolean();
    private LocalOrderSyncServer localOrderSyncServer;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        enableImmersiveMode();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        Termica.setContext(this);

        webView = new WebView(this);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setWebViewClient(new LocalAssetClient(
                new WebViewAssetLoader.Builder().addPathHandler(
                        "/assets/",
                        new WebViewAssetLoader.AssetsPathHandler(this)
                ).build()
        ));

        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(false);
        webView.getSettings().setSupportMultipleWindows(false);
        webView.addJavascriptInterface(new PrinterBridge(), "M10Printer");

        if ("guest".equals(BuildConfig.APP_MODE)) {
            localOrderSyncServer = new LocalOrderSyncServer(
                    getApplicationContext(),
                    this::applyRemoteOrdersToWebView
            );
            localOrderSyncServer.start();
        }

        setContentView(webView);
        webView.loadUrl(APP_URL);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && !keyboardVisible) enableImmersiveMode();
    }

    private void enableImmersiveMode() {
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        getWindow().getDecorView().setSystemUiVisibility(IMMERSIVE_FLAGS);
    }

    private void setKeyboardVisible(boolean visible) {
        runOnUiThread(() -> {
            keyboardVisible = visible;
            if (visible) {
                getWindow().setSoftInputMode(
                        WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                );
                getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            } else {
                enableImmersiveMode();
            }
        });
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        printerExecutor.shutdown();
        networkExecutor.shutdown();
        if (localOrderSyncServer != null) {
            localOrderSyncServer.stop();
            localOrderSyncServer = null;
        }
        synchronized (printerLock) {
            closePrinterConnection();
        }
        if (webView != null) {
            webView.removeJavascriptInterface("M10Printer");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private static String printerKey(JSONObject config) {
        String type = config.optString("type", "internal");
        if ("network".equals(type)) {
            return "network|" + config.optString("model", "")
                    + "|" + config.optString("ip", "")
                    + "|" + config.optInt("port", 9100);
        }
        return "internal|6|M8";
    }

    private int openPrinter(JSONObject config) {
        JSONObject selected = config == null ? new JSONObject() : config;
        String type = selected.optString("type", "internal");
        String key = printerKey(selected);
        if (printerConnected && key.equals(connectedPrinterKey)) return 0;
        if (printerConnected) Termica.FechaConexaoImpressora();

        printerConnected = false;
        connectedPrinterKey = "";
        int result;
        if ("network".equals(type)) {
            String model = selected.optString("model", "").trim();
            String ip = selected.optString("ip", "").trim();
            int port = selected.optInt("port", 9100);
            if (model.isEmpty() || ip.isEmpty() || port < 1 || port > 65535) {
                throw new IllegalArgumentException("Informe modelo, IP e porta TCP válidos.");
            }
            result = Termica.AbreConexaoImpressora(3, model, ip, port);
        } else if ("internal".equals(type)) {
            result = Termica.AbreConexaoImpressora(6, "M8", "", 0);
        } else {
            throw new IllegalArgumentException("Tipo de impressora inválido.");
        }

        printerConnected = result == 0;
        if (printerConnected) {
            connectedPrinterKey = key;
        }
        return result;
    }

    private int closePrinterConnection() {
        if (!printerConnected) return 0;
        int result = Termica.FechaConexaoImpressora();
        printerConnected = false;
        connectedPrinterKey = "";
        return result;
    }

    private static void requireSuccess(int result, String operation) {
        if (result != 0) {
            throw new IllegalStateException(operation + " falhou (código " + result + ").");
        }
    }

    private static void requirePrinterOperation(int result, String operation) {
        if (result < 0) {
            throw new IllegalStateException(operation + " falhou (código " + result + ").");
        }
    }

    private static String formatDate(String value) {
        try {
            SimpleDateFormat input = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSX", Locale.US);
            Date date = input.parse(value);
            if (date != null) {
                return new SimpleDateFormat("dd/MM/yyyy HH:mm", new Locale("pt", "BR"))
                        .format(date);
            }
        } catch (Exception ignored) {
            // Use the device clock if the browser date could not be parsed.
        }
        return new SimpleDateFormat("dd/MM/yyyy HH:mm", new Locale("pt", "BR"))
                .format(new Date());
    }

    private void printText(String text, int alignment, int style, int size) {
        requirePrinterOperation(
                Termica.ImpressaoTexto(text, alignment, style, size),
                "Impressão de texto"
        );
    }

    private static void appendReceiptLine(StringBuilder receipt, String text, int indent) {
        String value = text == null ? "" : text.trim().replaceAll("\\s+", " ");
        StringBuilder line = new StringBuilder();
        for (int index = 0; index < indent; index++) {
            line.append(' ');
        }

        int contentWidth = RECEIPT_WIDTH - indent;
        if (value.isEmpty()) {
            receipt.append('\n');
            return;
        }

        for (String word : value.split(" ")) {
            if (line.length() > indent && line.length() + 1 + word.length() <= RECEIPT_WIDTH) {
                line.append(' ');
            } else if (line.length() > indent) {
                receipt.append(line).append('\n');
                line.setLength(0);
                for (int index = 0; index < indent; index++) {
                    line.append(' ');
                }
            }

            int wordOffset = 0;
            while (wordOffset < word.length()) {
                int available = RECEIPT_WIDTH - line.length();
                if (available == 0) {
                    receipt.append(line).append('\n');
                    line.setLength(0);
                    for (int index = 0; index < indent; index++) {
                        line.append(' ');
                    }
                    available = contentWidth;
                }

                int count = Math.min(available, word.length() - wordOffset);
                line.append(word, wordOffset, wordOffset + count);
                wordOffset += count;
                if (wordOffset < word.length()) {
                    receipt.append(line).append('\n');
                    line.setLength(0);
                    for (int index = 0; index < indent; index++) {
                        line.append(' ');
                    }
                }
            }
        }
        receipt.append(line).append('\n');
    }

    private static void appendCenteredReceiptLine(StringBuilder receipt, String text) {
        String value = text == null ? "" : text.trim();
        if (value.length() >= RECEIPT_WIDTH) {
            appendReceiptLine(receipt, value, 0);
            return;
        }
        int padding = (RECEIPT_WIDTH - value.length()) / 2;
        for (int index = 0; index < padding; index++) {
            receipt.append(' ');
        }
        receipt.append(value).append('\n');
    }

    private static void appendReceiptSeparator(StringBuilder receipt, char character) {
        for (int index = 0; index < RECEIPT_WIDTH; index++) {
            receipt.append(character);
        }
        receipt.append('\n');
    }

    private JSONObject response(boolean ok, String message, String printer) throws JSONException {
        JSONObject result = new JSONObject();
        result.put("ok", ok);
        result.put("printer", ok ? printer : JSONObject.NULL);
        if (message != null && !message.isEmpty()) {
            result.put("message", message);
        }
        return result;
    }

    private final class PrinterBridge {
        @JavascriptInterface
        public void setKeyboardVisible(boolean visible) {
            if ("guest".equals(BuildConfig.APP_MODE)) {
                MainActivity.this.setKeyboardVisible(visible);
            }
        }

        @JavascriptInterface
        public String getLocalOrderServerInfo() {
            if (localOrderSyncServer == null) return "{\"enabled\":false}";
            return localOrderSyncServer.getInfo().toString();
        }

        @JavascriptInterface
        public void publishLocalOrders(String ordersJson) {
            if (localOrderSyncServer != null) {
                localOrderSyncServer.publishOrders(ordersJson);
            }
        }

        @JavascriptInterface
        public void requestLocalOrdersAsync(String ipAddress, String token, String requestId) {
            try {
                networkExecutor.execute(() -> {
                    String result;
                    try {
                        result = LocalOrderSyncClient.fetchOrders(ipAddress, token).toString();
                    } catch (Exception error) {
                        result = failedLocalOrderResponse(error);
                    }
                    deliverLocalOrdersResult(requestId, result);
                });
            } catch (Exception error) {
                deliverLocalOrdersResult(requestId, failedLocalOrderResponse(error));
            }
        }

        @JavascriptInterface
        public void completeLocalOrderAsync(
                String ipAddress,
                String token,
                String orderId,
                String requestId
        ) {
            try {
                networkExecutor.execute(() -> {
                    String result;
                    try {
                        result = LocalOrderSyncClient.completeOrder(
                                ipAddress,
                                token,
                                orderId
                        ).toString();
                    } catch (Exception error) {
                        result = failedLocalOrderResponse(error);
                    }
                    deliverLocalOrdersResult(requestId, result);
                });
            } catch (Exception error) {
                deliverLocalOrdersResult(requestId, failedLocalOrderResponse(error));
            }
        }

        @JavascriptInterface
        public void reopenLocalOrderAsync(
                String ipAddress,
                String token,
                String orderId,
                String requestId
        ) {
            try {
                networkExecutor.execute(() -> {
                    String result;
                    try {
                        result = LocalOrderSyncClient.reopenOrder(
                                ipAddress,
                                token,
                                orderId
                        ).toString();
                    } catch (Exception error) {
                        result = failedLocalOrderResponse(error);
                    }
                    deliverLocalOrdersResult(requestId, result);
                });
            } catch (Exception error) {
                deliverLocalOrdersResult(requestId, failedLocalOrderResponse(error));
            }
        }

        @JavascriptInterface
        public String connectPrinter(String configPayload) {
            try {
                synchronized (printerLock) {
                    JSONObject config = new JSONObject(configPayload);
                    int result = openPrinter(config);
                    if (result != 0) {
                        return response(false, "Não foi possível conectar à impressora (código "
                                        + result + ").", "")
                                .toString();
                    }
                    String printerName = "network".equals(config.optString("type"))
                            ? "Impressora " + config.optString("model") + " em "
                                    + config.optString("ip") + ":" + config.optInt("port", 9100)
                            : "Impressora integrada M10";
                    return response(true, "", printerName).toString();
                }
            } catch (Exception error) {
                return failedResponse(error);
            }
        }

        @JavascriptInterface
        public void printReceiptAsync(String payload, String requestId) {
            if (!printJobRunning.compareAndSet(false, true)) {
                deliverPrintResult(requestId, failedPrintResponse(
                        new IllegalStateException("Já existe uma impressão em andamento. Aguarde."),
                        true
                ));
                return;
            }
            try {
                printerExecutor.execute(() -> {
                    String result;
                    try {
                        synchronized (printerLock) {
                            result = printReceipt(payload);
                        }
                    } finally {
                        printJobRunning.set(false);
                    }
                    deliverPrintResult(requestId, result);
                });
            } catch (Exception error) {
                printJobRunning.set(false);
                deliverPrintResult(requestId, failedResponse(error));
            }
        }

        @JavascriptInterface
        public void sendReadyOrderAsync(String payload, String requestId) {
            try {
                networkExecutor.execute(() -> {
                    String result = sendReadyOrder(payload);
                    deliverReadyOrderResult(requestId, result);
                });
            } catch (Exception error) {
                deliverReadyOrderResult(requestId, failedNetworkResponse(error));
            }
        }

        private String printReceipt(String payload) {
            long startedAt = System.currentTimeMillis();
            String stage = "open";
            try {
                JSONObject order = new JSONObject(payload);
                int closeResult = closePrinterConnection();
                requirePrinterOperation(closeResult, "Encerramento da conexão anterior");

                JSONObject printer = order.optJSONObject("printer");
                String printerType = printer == null ? "internal" : printer.optString("type", "internal");
                Log.i(PRINTER_LOG_TAG, "print stage=open");
                int connectionResult = openPrinter(printer);
                requireSuccess(connectionResult, "Conexão com a impressora");

                JSONArray ingredients = order.optJSONArray("ingredients");
                int ingredientCount = ingredients == null ? 0 : ingredients.length();
                StringBuilder receipt = new StringBuilder();
                String variant = order.optString("variant", "");
                String product = order.optString("product", "-");
                if (!variant.isEmpty()) {
                    product += " - " + variant.toUpperCase(new Locale("pt", "BR"));
                }

                appendCenteredReceiptLine(receipt, "HOTEL COLONIAL");
                appendCenteredReceiptLine(receipt, "CAFÉ DA MANHÃ");
                appendReceiptSeparator(receipt, '=');
                appendReceiptLine(receipt, "COMANDA #" + order.optString("orderNumber", "-"), 0);
                appendReceiptLine(receipt, formatDate(order.optString("createdAt", "")), 0);
                appendReceiptSeparator(receipt, '-');
                appendReceiptLine(receipt, "QUARTO: " + order.optString("room", "-"), 0);
                appendReceiptLine(receipt, "HOSPEDE: " + order.optString("customer", "-"), 0);
                appendReceiptSeparator(receipt, '-');
                appendReceiptLine(receipt, product, 0);
                appendReceiptLine(receipt, "INGREDIENTES (" + ingredientCount + ")", 0);
                if (ingredients != null) {
                    for (int index = 0; index < ingredients.length(); index++) {
                        appendReceiptLine(
                                receipt,
                                "- " + ingredients.optString(index),
                                2
                        );
                    }
                }
                appendReceiptSeparator(receipt, '-');
                appendReceiptLine(
                        receipt,
                        "PREPARO: " + order.optInt("preparationMinutes", 30) + " MIN",
                        0
                );
                appendReceiptSeparator(receipt, '=');

                stage = "text";
                Log.i(PRINTER_LOG_TAG, "print stage=text chars=" + receipt.length());
                printText(receipt.toString(), 0, 1, 17);
                stage = "paper";
                Log.i(PRINTER_LOG_TAG, "print stage=feed");
                requirePrinterOperation(Termica.AvancaPapel(
                        "network".equals(printerType) ? 3 : 1
                ), "Avanço de papel");
                Log.i(PRINTER_LOG_TAG, "print stage=cut");
                requirePrinterOperation(Termica.Corte(3), "Corte do papel");
                Log.i(PRINTER_LOG_TAG, "print stage=close");
                requirePrinterOperation(
                        closePrinterConnection(),
                        "Encerramento da conexão com a impressora"
                );

                Log.i(PRINTER_LOG_TAG, "print stage=complete durationMs="
                        + (System.currentTimeMillis() - startedAt));
                return response(true, "", "").toString();
            } catch (Exception error) {
                Log.e(PRINTER_LOG_TAG, "print failed after "
                        + (System.currentTimeMillis() - startedAt) + "ms", error);
                closePrinterConnection();
                return failedPrintResponse(error, "open".equals(stage));
            }
        }
    }

    private void deliverPrintResult(String requestId, String result) {
        WebView target = webView;
        if (target == null) return;
        String script = "window.__m10PrinterResult && window.__m10PrinterResult("
                + JSONObject.quote(requestId) + ", " + JSONObject.quote(result) + ");";
        target.post(() -> target.evaluateJavascript(script, null));
    }

    private String sendReadyOrder(String payload) {
        HttpsURLConnection connection = null;
        try {
            URL url = new URL(READY_ORDER_API_URL);
            connection = (HttpsURLConnection) url.openConnection();
            connection.setSSLSocketFactory(readyOrderSocketFactory());
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "text/plain;charset=UTF-8");
            byte[] request = payload.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(request.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(request);
            }

            int status = connection.getResponseCode();
            InputStream responseStream = status >= 400
                    ? connection.getErrorStream()
                    : connection.getInputStream();
            if (responseStream == null) {
                throw new IllegalStateException("O servidor de TVs retornou uma resposta vazia (HTTP "
                        + status + ").");
            }

            String responseBody;
            try (InputStream input = responseStream;
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    output.write(buffer, 0, count);
                }
                responseBody = output.toString(java.nio.charset.StandardCharsets.UTF_8.name());
            }

            JSONObject result = new JSONObject(responseBody);
            if (status < 200 || status >= 300) {
                result.put("ok", false);
                if (!result.has("error")) {
                    result.put("error", "Falha ao enviar aviso para a TV (HTTP " + status + ").");
                }
            }
            return result.toString();
        } catch (Exception error) {
            return failedNetworkResponse(error);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private javax.net.ssl.SSLSocketFactory readyOrderSocketFactory() throws Exception {
        java.security.cert.CertificateFactory certificateFactory =
                java.security.cert.CertificateFactory.getInstance("X.509");
        java.security.cert.Certificate trustedCa;
        try (InputStream input = getResources().openRawResource(R.raw.ready_order_ca)) {
            trustedCa = certificateFactory.generateCertificate(input);
        }

        KeyStore trustStore = KeyStore.getInstance(KeyStore.getDefaultType());
        trustStore.load(null, null);
        trustStore.setCertificateEntry("tv-ready-order-ca", trustedCa);

        TrustManagerFactory trustManagers =
                TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        trustManagers.init(trustStore);
        SSLContext sslContext = SSLContext.getInstance("TLS");
        sslContext.init(null, trustManagers.getTrustManagers(), null);
        return sslContext.getSocketFactory();
    }

    private void deliverReadyOrderResult(String requestId, String result) {
        WebView target = webView;
        if (target == null) return;
        String script = "window.__m10ReadyOrderResult && window.__m10ReadyOrderResult("
                + JSONObject.quote(requestId) + ", " + JSONObject.quote(result) + ");";
        target.post(() -> target.evaluateJavascript(script, null));
    }

    private void deliverLocalOrdersResult(String requestId, String result) {
        WebView target = webView;
        if (target == null) return;
        String script = "window.__m10LocalOrdersResult && window.__m10LocalOrdersResult("
                + JSONObject.quote(requestId) + ", " + JSONObject.quote(result) + ");";
        target.post(() -> target.evaluateJavascript(script, null));
    }

    private void applyRemoteOrdersToWebView(JSONArray orders) {
        WebView target = webView;
        if (target == null) return;
        String script = "window.__m10ApplyLocalOrders && window.__m10ApplyLocalOrders("
                + JSONObject.quote(orders.toString()) + ");";
        target.post(() -> target.evaluateJavascript(script, null));
    }

    private static String failedLocalOrderResponse(Exception error) {
        try {
            JSONObject result = new JSONObject();
            result.put("ok", false);
            result.put("error", error.getMessage() == null
                    ? "Falha na comunicação local com o M10 do hóspede."
                    : error.getMessage());
            return result.toString();
        } catch (JSONException jsonError) {
            return "{\"ok\":false,\"error\":\"Falha na comunicação local com o M10 do hóspede.\"}";
        }
    }

    private static String failedNetworkResponse(Exception error) {
        try {
            JSONObject result = new JSONObject();
            result.put("ok", false);
            result.put("error", error.getMessage() == null
                    ? "Não foi possível conectar ao servidor de TVs."
                    : "Falha de conexão com o servidor de TVs: " + error.getMessage());
            return result.toString();
        } catch (JSONException jsonError) {
            return "{\"ok\":false,\"error\":\"Não foi possível conectar ao servidor de TVs.\"}";
        }
    }

    private String failedResponse(Exception error) {
        try {
            return response(false, error.getMessage() == null
                    ? "Erro desconhecido na comunicação com a impressora."
                    : error.getMessage(), "").toString();
        } catch (JSONException jsonError) {
            return "{\"ok\":false,\"message\":\"Falha na comunicação com a impressora.\"}";
        }
    }

    private String failedPrintResponse(Exception error, boolean retryable) {
        try {
            JSONObject result = new JSONObject(failedResponse(error));
            result.put("retryable", retryable);
            return result.toString();
        } catch (JSONException jsonError) {
            return "{\"ok\":false,\"message\":\"Falha na comunicação com a impressora.\",\"retryable\":false}";
        }
    }

    private static final class LocalAssetClient extends WebViewClient {
        private final WebViewAssetLoader assetLoader;

        LocalAssetClient(WebViewAssetLoader assetLoader) {
            this.assetLoader = assetLoader;
        }

        @Override
        public android.webkit.WebResourceResponse shouldInterceptRequest(
                WebView view,
                WebResourceRequest request
        ) {
            return assetLoader.shouldInterceptRequest(request.getUrl());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return !APP_URL.equals(request.getUrl().toString());
        }
    }
}
