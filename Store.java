package app.kehribar;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** Arayüz ile arka plan işçisi arasındaki dosyalar ve bildirimler. */
final class Store {
    private Store() {}

    static final Object LOCK = new Object();
    static final String CHANNEL = "kehribar_main";

    static File snap(Context c) { return new File(c.getFilesDir(), "snapshot.json"); }
    static File queue(Context c) { return new File(c.getFilesDir(), "queue.json"); }

    static String read(File f) {
        if (!f.exists()) return null;
        try (FileInputStream in = new FileInputStream(f)) {
            return Net.read(in);
        } catch (IOException e) {
            return null;
        }
    }

    static void write(File f, String s) throws IOException {
        File t = new File(f.getPath() + ".tmp");
        try (FileOutputStream o = new FileOutputStream(t)) {
            o.write(s.getBytes(StandardCharsets.UTF_8));
        }
        if (!t.renameTo(f)) {
            f.delete();
            t.renameTo(f);
        }
    }

    static void saveSnapshot(Context c, String json) {
        synchronized (LOCK) {
            try { write(snap(c), json); } catch (IOException ignored) { }
        }
    }

    static void enqueue(Context c, JSONObject item) {
        synchronized (LOCK) {
            try {
                String raw = read(queue(c));
                JSONArray a = (raw == null || raw.isEmpty()) ? new JSONArray() : new JSONArray(raw);
                a.put(item);
                write(queue(c), a.toString());
            } catch (Exception ignored) { }
        }
    }

    static String drain(Context c) {
        synchronized (LOCK) {
            String raw = read(queue(c));
            if (raw == null || raw.isEmpty()) return "[]";
            queue(c).delete();
            return raw;
        }
    }

    static void wipe(Context c) {
        synchronized (LOCK) {
            snap(c).delete();
            queue(c).delete();
        }
        c.getSharedPreferences("worker", Context.MODE_PRIVATE).edit().clear().apply();
    }

    static void ensureChannel(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Kehribar", NotificationManager.IMPORTANCE_DEFAULT));
        }
    }

    static void notifyUser(Context c, int id, String title, String body) {
        try {
            if (Build.VERSION.SDK_INT >= 33
                    && c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                return;
            }
            ensureChannel(c);
            Intent i = new Intent(c, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    .putExtra("open", "inbox");
            PendingIntent pi = PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            String one = body.replace('\n', ' ');
            if (one.length() > 120) one = one.substring(0, 117) + "...";
            Notification n = new Notification.Builder(c, CHANNEL)
                    .setSmallIcon(R.drawable.ic_stat)
                    .setContentTitle(title)
                    .setContentText(one)
                    .setStyle(new Notification.BigTextStyle().bigText(body))
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .build();
            c.getSystemService(NotificationManager.class).notify(id, n);
        } catch (Exception ignored) { }
    }
}
