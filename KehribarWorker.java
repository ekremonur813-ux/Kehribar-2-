package app.kehribar;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Locale;

/**
 * Uygulama kapalıyken yaklaşık 15 dakikada bir çalışır:
 * günlük özeti gönderir ve takip edilen notların güncel durumunu kontrol eder.
 */
public class KehribarWorker extends Worker {

    public KehribarWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            Context c = getApplicationContext();
            String raw;
            synchronized (Store.LOCK) {
                raw = Store.read(Store.snap(c));
            }
            if (raw == null || raw.isEmpty()) return Result.success();

            JSONObject snap = new JSONObject(raw);
            JSONObject s = snap.getJSONObject("settings");
            JSONArray notes = snap.optJSONArray("notes");
            if (notes == null) notes = new JSONArray();
            SharedPreferences st = c.getSharedPreferences("worker", Context.MODE_PRIVATE);

            ZoneId zone;
            try {
                zone = ZoneId.of(s.optString("timezone", "Europe/Istanbul"));
            } catch (Exception e) {
                zone = ZoneId.of("Europe/Istanbul");
            }
            ZonedDateTime now = ZonedDateTime.now(zone);
            String date = now.toLocalDate().toString();
            String time = String.format(Locale.US, "%02d:%02d", now.getHour(), now.getMinute());

            if (s.optBoolean("daily_enabled", true) && !date.equals(st.getString("daily_last", ""))) {
                int diff = toMin(time) - toMin(s.optString("daily_time", "08:00"));
                if (diff >= 0 && diff <= 180) sendDaily(c, s, notes, st, date, time);
            }
            if (s.optBoolean("watch_enabled", true)
                    && !s.optString("gemini_key", "").isEmpty()
                    && !inQuiet(time, s.optString("quiet_start", "23:00"), s.optString("quiet_end", "07:00"))) {
                runWatch(c, s, notes, st);
            }
        } catch (Throwable ignored) {
            // Arka plan işi sessizce yeniden denenir
        }
        return Result.success();
    }

    /* ---------- Günlük özet ---------- */
    private void sendDaily(Context c, JSONObject s, JSONArray notes, SharedPreferences st, String date, String time) throws Exception {
        st.edit().putString("daily_last", date).apply();
        StringBuilder body = new StringBuilder();

        if (s.optBoolean("weather_enabled", true) && !s.isNull("lat") && !s.isNull("lon")) {
            try {
                String w = weatherText(s.getDouble("lat"), s.getDouble("lon"));
                if (w != null) body.append(w);
            } catch (Exception ignored) { }
        }

        StringBuilder list = new StringBuilder();
        int count = 0;
        for (int i = 0; i < notes.length() && count < 8; i++) {
            JSONObject n = notes.getJSONObject(i);
            if (!n.optBoolean("daily", false)) continue;
            String title = n.optString("title", "");
            String text = n.optString("body", "").replaceAll("\\s+", " ");
            if (title.isEmpty()) title = text.length() > 100 ? text.substring(0, 100) : text;
            else if (!text.isEmpty()) title = title + " \u2014 " + (text.length() > 80 ? text.substring(0, 80) : text);
            list.append("\u2022 ").append(title).append('\n');
            count++;
        }
        if (count > 0) {
            if (body.length() > 0) body.append("\n\n");
            body.append("Bugün için notların:\n").append(list.toString().trim());
        }
        if (body.length() == 0) return;

        int h = Integer.parseInt(time.substring(0, 2));
        String hello = h < 12 ? "Günaydın" : (h < 18 ? "İyi günler" : "İyi akşamlar");
        String name = s.optString("display_name", "");
        if (!name.isEmpty()) hello += ", " + name;
        push(c, 1001, "daily", hello, body.toString());
    }

    /* ---------- Not takibi ---------- */
    private void runWatch(Context c, JSONObject s, JSONArray notes, SharedPreferences st) throws Exception {
        long every = s.optInt("watch_hours", 6) * 3600_000L;
        long nowMs = System.currentTimeMillis();
        int done = 0;
        for (int i = 0; i < notes.length() && done < 2; i++) {
            JSONObject n = notes.getJSONObject(i);
            if (!n.optBoolean("watch", false)) continue;
            long id = n.getLong("id");
            long ver = n.optLong("updated_at", 0);

            long lastCheck = n.optLong("last_check", 0);
            String lastStatus = n.optString("last_status", "");
            if (st.getLong("n_" + id + "_v", -1) == ver) {
                lastCheck = Math.max(lastCheck, st.getLong("n_" + id + "_c", 0));
                String saved = st.getString("n_" + id + "_s", null);
                if (saved != null) lastStatus = saved;
            }
            if (lastCheck > nowMs - every) continue;

            done++;
            try {
                String text = checkNote(s, n.optString("title", ""), n.optString("body", ""), lastStatus);
                boolean same = text.trim().toUpperCase(new Locale("tr", "TR")).startsWith("DE\u011e\u0130\u015e\u0130KL\u0130K YOK");
                SharedPreferences.Editor ed = st.edit().putLong("n_" + id + "_v", ver).putLong("n_" + id + "_c", nowMs);
                JSONObject q = new JSONObject().put("type", "note").put("id", id).put("ver", ver).put("last_check", nowMs);
                if (!same) {
                    ed.putString("n_" + id + "_s", text);
                    q.put("last_status", text);
                }
                ed.apply();
                Store.enqueue(c, q);
                if (!same) {
                    String t = n.optString("title", "");
                    push(c, (int) (2000 + (id % 1000)), "watch", "Takip: " + (t.isEmpty() ? "Not" : t), text);
                }
            } catch (Exception e) {
                // 30 dakika sonra yeniden dene
                st.edit().putLong("n_" + id + "_v", ver).putLong("n_" + id + "_c", nowMs - every + 30 * 60_000L).apply();
            }
        }
    }

    private String checkNote(JSONObject s, String title, String body, String lastStatus) throws Exception {
        String prompt = "Kullanıcının takip ettiği not:\n"
                + "Başlık: " + (title.isEmpty() ? "(yok)" : title) + "\n"
                + "Açıklama: " + (body.isEmpty() ? "(yok)" : body) + "\n\n"
                + "Önceki kontrol sonucu: " + (lastStatus.isEmpty() ? "yok (ilk kontrol)" : lastStatus) + "\n\n"
                + "Google Arama ile bu konunun GÜNCEL durumunu araştır. Türkçe yaz.\n"
                + "İlk kontrolse mevcut durumu en fazla 3 cümleyle özetle.\n"
                + "İlk kontrol değilse ve önceki sonuca göre anlamlı yeni bir gelişme yoksa yalnızca şunu yaz: DEĞİŞİKLİK YOK\n"
                + "Yeni gelişme varsa en fazla 3 cümleyle özetle.";

        JSONObject req = new JSONObject();
        req.put("systemInstruction", new JSONObject().put("parts", new JSONArray().put(
                new JSONObject().put("text", "Sen titiz bir durum takip asistanısın. Yalnızca Türkçe, kısa ve doğrulanabilir bilgi ver."))));
        req.put("contents", new JSONArray().put(new JSONObject().put("role", "user")
                .put("parts", new JSONArray().put(new JSONObject().put("text", prompt)))));
        req.put("tools", new JSONArray().put(new JSONObject().put("google_search", new JSONObject())));

        String model = s.optString("model", "gemini-2.5-flash");
        if (!model.matches("^[A-Za-z0-9._-]+$")) model = "gemini-2.5-flash";
        JSONObject headers = new JSONObject()
                .put("Content-Type", "application/json")
                .put("x-goog-api-key", s.getString("gemini_key"));
        Object[] r = Net.request("POST",
                "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
                headers, req.toString(), 90000);
        if ((Integer) r[0] < 200 || (Integer) r[0] >= 300) throw new Exception("gemini " + r[0]);

        JSONArray parts = new JSONObject((String) r[1]).getJSONArray("candidates")
                .getJSONObject(0).getJSONObject("content").getJSONArray("parts");
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < parts.length(); i++) out.append(parts.getJSONObject(i).optString("text", ""));
        String text = out.toString().trim();
        if (text.isEmpty()) throw new Exception("bos");
        return text;
    }

    /* ---------- Hava durumu ---------- */
    private String weatherText(double lat, double lon) throws Exception {
        String url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon
                + "&current=temperature_2m,apparent_temperature,weather_code"
                + "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1";
        Object[] r = Net.request("GET", url, null, null, 15000);
        if ((Integer) r[0] != 200) return null;
        JSONObject j = new JSONObject((String) r[1]);
        JSONObject cur = j.getJSONObject("current");
        JSONObject d = j.getJSONObject("daily");
        int rain = d.getJSONArray("precipitation_probability_max").isNull(0) ? 0 : d.getJSONArray("precipitation_probability_max").getInt(0);
        return String.format(Locale.US, "Şu an %d°C (hissedilen %d°C), %s. Bugün %d–%d°C, yağış ihtimali %%%d.",
                Math.round(cur.getDouble("temperature_2m")), Math.round(cur.getDouble("apparent_temperature")),
                wmo(cur.getInt("weather_code")),
                Math.round(d.getJSONArray("temperature_2m_min").getDouble(0)),
                Math.round(d.getJSONArray("temperature_2m_max").getDouble(0)), rain);
    }

    private static String wmo(int c) {
        if (c == 0) return "açık";
        if (c == 1) return "çoğunlukla açık";
        if (c == 2) return "parçalı bulutlu";
        if (c == 3) return "kapalı";
        if (c == 45 || c == 48) return "sisli";
        if (c >= 51 && c <= 57) return "çiseliyor";
        if (c >= 61 && c <= 67) return "yağmurlu";
        if (c >= 71 && c <= 77) return "karlı";
        if (c >= 80 && c <= 82) return "sağanak yağışlı";
        if (c == 85 || c == 86) return "kar sağanağı";
        if (c >= 95) return "gök gürültülü fırtına";
        return "değişken";
    }

    /* ---------- Yardımcılar ---------- */
    private void push(Context c, int id, String kind, String title, String body) throws Exception {
        Store.enqueue(c, new JSONObject().put("type", "inbox").put("kind", kind).put("title", title)
                .put("body", body).put("created_at", System.currentTimeMillis()));
        Store.notifyUser(c, id, title, body);
    }

    private static int toMin(String t) {
        return Integer.parseInt(t.substring(0, 2)) * 60 + Integer.parseInt(t.substring(3, 5));
    }

    private static boolean inQuiet(String time, String start, String end) {
        int t = toMin(time), a = toMin(start), b = toMin(end);
        if (a == b) return false;
        return a < b ? (t >= a && t < b) : (t >= a || t < b);
    }
}
