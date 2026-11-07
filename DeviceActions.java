package app.kehribar;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.AudioManager;
import android.net.Uri;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.AlarmClock;
import android.provider.Settings;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.List;
import java.util.Locale;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

/** Telefon komutları. Yalnızca sabit bir eylem listesi çalışır. */
final class DeviceActions {
    private DeviceActions() {}

    static String res(boolean ok, String msg) {
        try {
            return new JSONObject().put("ok", ok).put("message", msg).toString();
        } catch (JSONException e) {
            return "{\"ok\":false,\"message\":\"Hata\"}";
        }
    }

    /** Köprü iş parçacığından çağrılır, işi arayüz iş parçacığında yapar. */
    static String run(final Activity a, final String name, final String argsJson) {
        FutureTask<String> ft = new FutureTask<>(() -> {
            try {
                return exec(a, name, new JSONObject(argsJson));
            } catch (Exception e) {
                return res(false, "Komut çalıştırılamadı.");
            }
        });
        a.runOnUiThread(ft);
        try {
            return ft.get(8, TimeUnit.SECONDS);
        } catch (Exception e) {
            return res(false, "Komut zaman aşımına uğradı.");
        }
    }

    static String norm(String s) {
        if (s == null) return "";
        String t = s.toLowerCase(new Locale("tr", "TR"));
        StringBuilder b = new StringBuilder();
        for (char ch : t.toCharArray()) {
            switch (ch) {
                case '\u0131': b.append('i'); break;
                case '\u015f': b.append('s'); break;
                case '\u00e7': b.append('c'); break;
                case '\u011f': b.append('g'); break;
                case '\u00f6': b.append('o'); break;
                case '\u00fc': b.append('u'); break;
                default:
                    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) b.append(ch);
            }
        }
        return b.toString();
    }

    private static String exec(Activity a, String name, JSONObject args) throws Exception {
        switch (name) {
            case "set_volume": return setVolume(a, args);
            case "set_brightness": return setBrightness(a, args);
            case "toggle_flashlight": return flashlight(a, args.optBoolean("on", true));
            case "vibrate": return vibrate(a, args.optInt("ms", 500));
            case "open_app": return openApp(a, args.optString("app_name", ""));
            case "open_settings": return openSettings(a, args.optString("page", "main"));
            case "set_do_not_disturb": return dnd(a, args.optBoolean("on", true));
            case "open_url": return openUrl(a, args.optString("url", ""));
            case "maps_search": return maps(a, args.optString("query", ""));
            case "dial": return dial(a, args.optString("number", ""));
            case "set_alarm": return alarm(a, args);
            case "set_timer": return timer(a, args);
            default: return res(false, "Bu komutu desteklemiyorum.");
        }
    }

    private static String start(Activity a, Intent i, String okMsg, String failMsg) {
        try {
            a.startActivity(i);
            return res(true, okMsg);
        } catch (ActivityNotFoundException e) {
            return res(false, failMsg);
        } catch (SecurityException e) {
            return res(false, failMsg);
        }
    }

    /* ---------- Ses ---------- */
    private static String setVolume(Activity a, JSONObject args) {
        int percent = args.optInt("percent", -1);
        if (percent < 0 || percent > 100) return res(false, "Ses yüzdesini anlayamadım (0-100 arası olmalı).");
        String s = args.optString("stream", "music");
        int stream;
        String label;
        switch (s) {
            case "ring": stream = AudioManager.STREAM_RING; label = "Zil"; break;
            case "alarm": stream = AudioManager.STREAM_ALARM; label = "Alarm"; break;
            case "notification": stream = AudioManager.STREAM_NOTIFICATION; label = "Bildirim"; break;
            case "system": stream = AudioManager.STREAM_SYSTEM; label = "Sistem"; break;
            case "call": stream = AudioManager.STREAM_VOICE_CALL; label = "Arama"; break;
            default: stream = AudioManager.STREAM_MUSIC; label = "Medya";
        }
        AudioManager am = (AudioManager) a.getSystemService(Context.AUDIO_SERVICE);
        try {
            int max = am.getStreamMaxVolume(stream);
            am.setStreamVolume(stream, Math.round(percent / 100f * max), AudioManager.FLAG_SHOW_UI);
            return res(true, label + " sesini %" + percent + " yaptım.");
        } catch (SecurityException e) {
            return res(false, "Rahatsız Etme açıkken bu sesi değiştiremiyorum.");
        }
    }

    /* ---------- Parlaklık ---------- */
    private static String setBrightness(Activity a, JSONObject args) {
        int percent = args.optInt("percent", -1);
        if (percent < 0 || percent > 100) return res(false, "Parlaklık yüzdesini anlayamadım.");
        if (!Settings.System.canWrite(a)) {
            Intent i = new Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:" + a.getPackageName()));
            start(a, i, "", "");
            return res(false, "Parlaklık için izin ekranını açtım. Kehribar'a izin verip komutu tekrar söyle.");
        }
        try {
            Settings.System.putInt(a.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL);
            Settings.System.putInt(a.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS, Math.round(percent * 2.55f));
            return res(true, "Parlaklığı %" + percent + " yaptım.");
        } catch (Exception e) {
            return res(false, "Parlaklık ayarlanamadı.");
        }
    }

    /* ---------- Fener / titreşim ---------- */
    private static String flashlight(Activity a, boolean on) {
        try {
            CameraManager cm = (CameraManager) a.getSystemService(Context.CAMERA_SERVICE);
            for (String id : cm.getCameraIdList()) {
                Boolean flash = cm.getCameraCharacteristics(id).get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                if (flash != null && flash) {
                    cm.setTorchMode(id, on);
                    return res(true, on ? "Feneri açtım." : "Feneri kapattım.");
                }
            }
            return res(false, "Bu telefonda fener bulunamadı.");
        } catch (Exception e) {
            return res(false, "Fener çalıştırılamadı.");
        }
    }

    private static String vibrate(Activity a, int ms) {
        try {
            Vibrator v = (Vibrator) a.getSystemService(Context.VIBRATOR_SERVICE);
            int d = Math.max(50, Math.min(3000, ms));
            v.vibrate(VibrationEffect.createOneShot(d, VibrationEffect.DEFAULT_AMPLITUDE));
            return res(true, "Telefonu titrettim.");
        } catch (Exception e) {
            return res(false, "Titreşim başlatılamadı.");
        }
    }

    /* ---------- Rahatsız Etme ---------- */
    private static String dnd(Activity a, boolean on) {
        NotificationManager nm = (NotificationManager) a.getSystemService(Context.NOTIFICATION_SERVICE);
        if (!nm.isNotificationPolicyAccessGranted()) {
            start(a, new Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS), "", "");
            return res(false, "Rahatsız Etme için izin ekranını açtım. Kehribar'a izin verip komutu tekrar söyle.");
        }
        nm.setInterruptionFilter(on ? NotificationManager.INTERRUPTION_FILTER_PRIORITY : NotificationManager.INTERRUPTION_FILTER_ALL);
        return res(true, on ? "Rahatsız Etme'yi açtım." : "Rahatsız Etme'yi kapattım.");
    }

    /* ---------- Uygulama açma ---------- */
    private static String openApp(Activity a, String name) {
        String target = norm(name);
        if (target.length() < 2) return res(false, "Hangi uygulamayı açacağımı anlayamadım.");
        PackageManager pm = a.getPackageManager();
        Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> list = pm.queryIntentActivities(main, 0);
        ResolveInfo best = null;
        int bestScore = 0;
        for (ResolveInfo ri : list) {
            String label = norm(String.valueOf(ri.loadLabel(pm)));
            int score = 0;
            if (label.equals(target)) score = 3;
            else if (label.startsWith(target) || (label.length() >= 3 && target.startsWith(label))) score = 2;
            else if (target.length() >= 3 && label.contains(target)) score = 1;
            if (score > bestScore) { bestScore = score; best = ri; }
        }
        if (best == null) return res(false, "\"" + name + "\" adlı bir uygulama bulamadım.");
        Intent launch = pm.getLaunchIntentForPackage(best.activityInfo.packageName);
        if (launch == null) return res(false, name + " açılamadı.");
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        String label = String.valueOf(best.loadLabel(pm));
        return start(a, launch, label + " uygulamasını açtım.", label + " açılamadı.");
    }

    private static String openSettings(Activity a, String page) {
        String action;
        String label;
        switch (page) {
            case "sound": action = Settings.ACTION_SOUND_SETTINGS; label = "Ses ve titreşim"; break;
            case "wifi": action = Settings.ACTION_WIFI_SETTINGS; label = "Wi-Fi"; break;
            case "bluetooth": action = Settings.ACTION_BLUETOOTH_SETTINGS; label = "Bluetooth"; break;
            case "display": action = Settings.ACTION_DISPLAY_SETTINGS; label = "Ekran"; break;
            case "battery": action = Settings.ACTION_BATTERY_SAVER_SETTINGS; label = "Pil"; break;
            case "location": action = Settings.ACTION_LOCATION_SOURCE_SETTINGS; label = "Konum"; break;
            case "apps": action = Settings.ACTION_APPLICATION_SETTINGS; label = "Uygulamalar"; break;
            default: action = Settings.ACTION_SETTINGS; label = "Ayarlar";
        }
        return start(a, new Intent(action), label + " ayarlarını açtım.", label + " ayarları açılamadı.");
    }

    /* ---------- Adres / harita / arama ---------- */
    private static String openUrl(Activity a, String url) {
        String u = url.trim();
        if (!u.matches("^https?://[^\\s]{3,500}$")) return res(false, "Geçerli bir web adresi veremedim.");
        return start(a, new Intent(Intent.ACTION_VIEW, Uri.parse(u)), "Adresi açtım.", "Adres açılamadı.");
    }

    private static String maps(Activity a, String q) {
        String query = q.trim();
        if (query.isEmpty()) return res(false, "Neyi arayacağımı anlayamadım.");
        if (query.length() > 120) query = query.substring(0, 120);
        Uri uri = Uri.parse("geo:0,0?q=" + Uri.encode(query));
        String r = start(a, new Intent(Intent.ACTION_VIEW, uri), "Haritada \"" + query + "\" aramasını açtım.", "");
        if (r.contains("\"ok\":true")) return r;
        Uri web = Uri.parse("https://www.google.com/maps/search/?api=1&query=" + Uri.encode(query));
        return start(a, new Intent(Intent.ACTION_VIEW, web), "Haritada \"" + query + "\" aramasını açtım.", "Harita açılamadı.");
    }

    private static String dial(Activity a, String number) {
        String n = number.replaceAll("[\\s()-]", "");
        if (!n.matches("^\\+?[0-9]{3,15}$")) return res(false, "Telefon numarasını anlayamadım.");
        return start(a, new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + n)), n + " için arama ekranını açtım.", "Arama ekranı açılamadı.");
    }

    /* ---------- Alarm / zamanlayıcı ---------- */
    private static String alarm(Activity a, JSONObject args) {
        int h = args.optInt("hour", -1);
        int m = args.optInt("minute", 0);
        if (h < 0 || h > 23 || m < 0 || m > 59) return res(false, "Alarm saatini anlayamadım.");
        Intent i = new Intent(AlarmClock.ACTION_SET_ALARM)
                .putExtra(AlarmClock.EXTRA_HOUR, h)
                .putExtra(AlarmClock.EXTRA_MINUTES, m)
                .putExtra(AlarmClock.EXTRA_MESSAGE, args.optString("label", "Kehribar"))
                .putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        return start(a, i, String.format(Locale.US, "Alarmı %02d:%02d için kurdum.", h, m), "Alarm kurulamadı.");
    }

    private static String timer(Activity a, JSONObject args) {
        int sec = args.optInt("seconds", -1);
        if (sec < 1 || sec > 86400) return res(false, "Süreyi anlayamadım.");
        Intent i = new Intent(AlarmClock.ACTION_SET_TIMER)
                .putExtra(AlarmClock.EXTRA_LENGTH, sec)
                .putExtra(AlarmClock.EXTRA_MESSAGE, args.optString("label", "Kehribar"))
                .putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        String t = sec >= 60 ? (sec / 60) + " dakikalık" : sec + " saniyelik";
        return start(a, i, t + " zamanlayıcı kurdum.", "Zamanlayıcı kurulamadı.");
    }
}
