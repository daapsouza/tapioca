package com.hotelcolonial.comanda;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

final class LocalOrderSyncClient {
    private LocalOrderSyncClient() {}

    static JSONObject fetchOrders(String ipAddress, String token) throws Exception {
        JSONObject request = new JSONObject();
        request.put("action", "orders");
        request.put("token", token);
        return send(ipAddress, request);
    }

    static JSONObject completeOrder(String ipAddress, String token, String orderId) throws Exception {
        JSONObject request = new JSONObject();
        request.put("action", "complete");
        request.put("token", token);
        request.put("orderId", orderId);
        return send(ipAddress, request);
    }

    static JSONObject reopenOrder(String ipAddress, String token, String orderId) throws Exception {
        JSONObject request = new JSONObject();
        request.put("action", "reopen");
        request.put("token", token);
        request.put("orderId", orderId);
        return send(ipAddress, request);
    }

    private static JSONObject send(String ipAddress, JSONObject request) throws Exception {
        if (!isIpv4Address(ipAddress)) {
            throw new IOException("Informe o IP IPv4 do M10 do hóspede.");
        }
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(ipAddress, LocalOrderSyncServer.PORT), 2500);
            socket.setSoTimeout(3500);
            try (BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(
                    socket.getOutputStream(), StandardCharsets.UTF_8));
                 BufferedReader reader = new BufferedReader(new InputStreamReader(
                         socket.getInputStream(), StandardCharsets.UTF_8))) {
                writer.write(request.toString());
                writer.newLine();
                writer.flush();
                String responseText = reader.readLine();
                if (responseText == null) throw new IOException("O M10 do hóspede não respondeu.");
                JSONObject response = new JSONObject(responseText);
                if (!response.optBoolean("ok")) {
                    throw new IOException(response.optString("error", "Falha na conexão local."));
                }
                return response;
            }
        }
    }

    private static boolean isIpv4Address(String value) {
        if (value == null || !value.matches("\\d{1,3}(\\.\\d{1,3}){3}")) return false;
        String[] parts = value.split("\\.");
        for (String part : parts) {
            int octet = Integer.parseInt(part);
            if (octet < 0 || octet > 255) return false;
        }
        return true;
    }
}
