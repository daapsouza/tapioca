package com.hotelcolonial.comanda;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class LocalOrderSyncServer {
    static final int PORT = 38741;
    private static final String PREFERENCES = "local_order_sync";
    private static final String ORDERS_KEY = "orders";
    private static final String TOKEN_KEY = "pairing_code";
    private static final int MAX_REQUEST_LENGTH = 2 * 1024 * 1024;
    private static final char[] TOKEN_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".toCharArray();

    interface OrdersListener {
        void onOrdersChanged(JSONArray orders);
    }

    private final SharedPreferences preferences;
    private final OrdersListener listener;
    private final ExecutorService clientExecutor = Executors.newFixedThreadPool(4);
    private final ExecutorService publishExecutor = Executors.newSingleThreadExecutor();
    private final Object ordersLock = new Object();
    private final String pairingCode;
    private volatile boolean running;
    private volatile ServerSocket serverSocket;

    LocalOrderSyncServer(Context context, OrdersListener listener) {
        preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        this.listener = listener;
        pairingCode = loadOrCreatePairingCode();
    }

    void start() {
        if (running) return;
        running = true;
        Thread serverThread = new Thread(this::acceptConnections, "local-orders-server");
        serverThread.setDaemon(true);
        serverThread.start();
    }

    void stop() {
        running = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
                // Closing the server socket is best-effort during Activity shutdown.
            }
        }
        clientExecutor.shutdownNow();
        publishExecutor.shutdownNow();
    }

    JSONObject getInfo() {
        JSONObject info = new JSONObject();
        try {
            info.put("enabled", true);
            info.put("running", running);
            info.put("ip", findLocalIpv4Address());
            info.put("port", PORT);
            info.put("token", pairingCode);
        } catch (JSONException ignored) {
            return new JSONObject();
        }
        return info;
    }

    void publishOrders(String serializedOrders) {
        if (serializedOrders == null || serializedOrders.length() > MAX_REQUEST_LENGTH) return;
        try {
            JSONArray incoming = new JSONArray(serializedOrders);
            publishExecutor.execute(() -> {
                synchronized (ordersLock) {
                    try {
                        JSONArray existing = readOrders();
                        Map<String, JSONObject> merged = new LinkedHashMap<>();
                        for (int index = 0; index < existing.length(); index++) {
                            JSONObject order = existing.optJSONObject(index);
                            if (order != null) merged.put(order.optString("id"), order);
                        }
                        for (int index = 0; index < incoming.length(); index++) {
                            JSONObject order = incoming.optJSONObject(index);
                            if (order == null || order.optString("id").isEmpty()) continue;
                            JSONObject previous = merged.get(order.optString("id"));
                            JSONObject next = new JSONObject(order.toString());
                            if (previous != null && "delivered".equals(previous.optString("status"))) {
                                next.put("status", "delivered");
                                if (previous.has("completedAt")) {
                                    next.put("completedAt", previous.optString("completedAt"));
                                }
                            }
                            merged.put(next.optString("id"), next);
                        }
                        writeOrders(new JSONArray(merged.values()));
                    } catch (JSONException error) {
                        android.util.Log.e("LocalOrderSync", "Invalid local order snapshot.", error);
                    }
                }
            });
        } catch (JSONException error) {
            android.util.Log.e("LocalOrderSync", "Invalid local order snapshot.", error);
        } catch (java.util.concurrent.RejectedExecutionException ignored) {
            // The Activity is shutting down.
        }
    }

    private void acceptConnections() {
        try (ServerSocket server = new ServerSocket(PORT, 12, InetAddress.getByName("0.0.0.0"))) {
            serverSocket = server;
            while (running) {
                Socket client = server.accept();
                clientExecutor.execute(() -> handleClient(client));
            }
        } catch (IOException error) {
            if (running) {
                android.util.Log.e("LocalOrderSync", "Could not start the local order server.", error);
            }
        } catch (java.util.concurrent.RejectedExecutionException ignored) {
            // The Activity is shutting down.
        } finally {
            running = false;
            serverSocket = null;
        }
    }

    private void handleClient(Socket socket) {
        try (Socket client = socket;
             BufferedReader reader = new BufferedReader(new InputStreamReader(
                     client.getInputStream(), StandardCharsets.UTF_8));
             BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(
                     client.getOutputStream(), StandardCharsets.UTF_8))) {
            client.setSoTimeout(5000);
            String line = reader.readLine();
            JSONObject response;
            if (line == null || line.length() > MAX_REQUEST_LENGTH) {
                response = error("Solicitação inválida.");
            } else {
                response = processRequest(new JSONObject(line));
            }
            writer.write(response.toString());
            writer.newLine();
            writer.flush();
        } catch (Exception error) {
            android.util.Log.w("LocalOrderSync", "Local order connection failed.", error);
        }
    }

    private JSONObject processRequest(JSONObject request) throws JSONException {
        if (!matchesToken(request.optString("token", ""))) {
            return error("Código de conexão inválido.");
        }

        String action = request.optString("action", "");
        if ("orders".equals(action)) {
            synchronized (ordersLock) {
                JSONObject result = new JSONObject();
                result.put("ok", true);
                result.put("orders", readOrders());
                return result;
            }
        }
        if ("complete".equals(action)) {
            return updateOrderStatus(request.optString("orderId", ""), true);
        }
        if ("reopen".equals(action)) {
            return updateOrderStatus(request.optString("orderId", ""), false);
        }
        return error("Ação não reconhecida.");
    }

    private JSONObject updateOrderStatus(String orderId, boolean complete) throws JSONException {
        if (orderId.isEmpty()) return error("Pedido inválido.");
        JSONArray updatedOrders;
        boolean found = false;
        synchronized (ordersLock) {
            JSONArray orders = readOrders();
            for (int index = 0; index < orders.length(); index++) {
                JSONObject order = orders.optJSONObject(index);
                if (order == null || !orderId.equals(order.optString("id"))) continue;
                if (complete && !"cancelled".equals(order.optString("status"))) {
                    order.put("status", "delivered");
                    order.put("completedAt", currentIsoDate());
                    found = true;
                } else if (!complete && "delivered".equals(order.optString("status"))) {
                    order.put("status", "new");
                    order.remove("completedAt");
                    found = true;
                }
            }
            if (!found) {
                return error(complete
                        ? "A comanda não está mais em preparo."
                        : "A comanda não está mais entre os pedidos concluídos.");
            }
            writeOrders(orders);
            updatedOrders = orders;
        }

        if (listener != null) listener.onOrdersChanged(updatedOrders);
        JSONObject result = new JSONObject();
        result.put("ok", true);
        result.put("orders", updatedOrders);
        return result;
    }

    private JSONArray readOrders() {
        try {
            return new JSONArray(preferences.getString(ORDERS_KEY, "[]"));
        } catch (JSONException error) {
            android.util.Log.e("LocalOrderSync", "Stored order data is invalid.", error);
            return new JSONArray();
        }
    }

    private void writeOrders(JSONArray orders) {
        if (!preferences.edit().putString(ORDERS_KEY, orders.toString()).commit()) {
            android.util.Log.e("LocalOrderSync", "Could not save shared local orders.");
        }
    }

    private boolean matchesToken(String supplied) {
        return MessageDigest.isEqual(
                pairingCode.getBytes(StandardCharsets.UTF_8),
                supplied.getBytes(StandardCharsets.UTF_8)
        );
    }

    private String loadOrCreatePairingCode() {
        String saved = preferences.getString(TOKEN_KEY, "");
        if (saved != null && !saved.isEmpty()) return saved;
        SecureRandom random = new SecureRandom();
        StringBuilder token = new StringBuilder(10);
        for (int index = 0; index < 10; index++) {
            token.append(TOKEN_CHARS[random.nextInt(TOKEN_CHARS.length)]);
        }
        String generated = token.toString();
        preferences.edit().putString(TOKEN_KEY, generated).apply();
        return generated;
    }

    private static JSONObject error(String message) throws JSONException {
        JSONObject result = new JSONObject();
        result.put("ok", false);
        result.put("error", message);
        return result;
    }

    private static String currentIsoDate() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }

    private static String findLocalIpv4Address() {
        String fallback = "";
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface network = interfaces.nextElement();
                if (!network.isUp() || network.isLoopback()) continue;
                Enumeration<InetAddress> addresses = network.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress address = addresses.nextElement();
                    if (!(address instanceof Inet4Address) || address.isLoopbackAddress()) continue;
                    String value = address.getHostAddress();
                    if (network.getName().startsWith("wlan")) return value;
                    if (fallback.isEmpty()) fallback = value;
                }
            }
        } catch (Exception error) {
            android.util.Log.w("LocalOrderSync", "Could not determine the M10 Wi-Fi address.", error);
        }
        return fallback;
    }
}
