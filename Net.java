package app.kehribar;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

/** Küçük HTTP yardımcısı. Yalnızca izin verilen adreslere bağlanır. */
final class Net {
    private Net() {}

    static boolean allowed(String url) {
        try {
            URL u = new URL(url);
            String h = u.getHost();
            return "https".equals(u.getProtocol())
                    && (h.equals("generativelanguage.googleapis.com")
                    || h.equals("api.open-meteo.com")
                    || h.equals("geocoding-api.open-meteo.com"));
        } catch (Exception e) {
            return false;
        }
    }

    /** @return {Integer status, String body}; status 0 ise ağ hatası. */
    static Object[] request(String method, String url, JSONObject headers, String body, int readTimeoutMs) {
        HttpURLConnection c = null;
        try {
            if (!allowed(url)) {
                return new Object[]{403, "{\"error\":{\"message\":\"Adres izinli degil\"}}"};
            }
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(readTimeoutMs);
            c.setRequestMethod(method);
            if (headers != null) {
                Iterator<String> it = headers.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    c.setRequestProperty(k, headers.getString(k));
                }
            }
            if (body != null && !body.isEmpty() && !"GET".equals(method)) {
                byte[] b = body.getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(b.length);
                try (OutputStream o = c.getOutputStream()) {
                    o.write(b);
                }
            }
            int status = c.getResponseCode();
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            String text = in == null ? "" : read(in);
            return new Object[]{status, text};
        } catch (Exception e) {
            return new Object[]{0, String.valueOf(e.getMessage())};
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static String read(InputStream in) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return bo.toString("UTF-8");
    }
}
