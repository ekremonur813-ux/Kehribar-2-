package app.kehribar;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final int REQ_NOTIF = 1;
    private static final int REQ_MIC = 2;

    private WebView web;
    private SpeechRecognizer recognizer;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private String pendingSpeak = null;
    private boolean pendingListen = false;
    static volatile String pendingOpen = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        readOpenExtra(getIntent());

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        web.setBackgroundColor(0xFFFBF1DE);
        setContentView(web);

        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setMediaPlaybackRequiresUserGesture(false);

        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) { }
                return true;
            }
        });
        web.loadUrl("https://" + HOST + "/assets/www/index.html");

        scheduleBackgroundWork();
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        }
    }

    private void scheduleBackgroundWork() {
        Constraints cons = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(KehribarWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(cons)
                .build();
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("kehribar-bg", ExistingPeriodicWorkPolicy.KEEP, req);
    }

    private void readOpenExtra(Intent i) {
        if (i == null) return;
        String o = i.getStringExtra("open");
        if (o != null && !o.isEmpty()) pendingOpen = o;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        readOpenExtra(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        js("window.__resume && window.__resume()");
    }

    @Override
    protected void onPause() {
        super.onPause();
        js("window.__pause && window.__pause()");
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("(function(){return !!(window.__back && window.__back());})()", value -> {
            if (!"true".equals(value)) moveTaskToBack(true);
        });
    }

    @Override
    protected void onDestroy() {
        if (recognizer != null) recognizer.destroy();
        if (tts != null) tts.shutdown();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code == REQ_MIC) {
            boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            if (ok && pendingListen) doListen();
            else if (!ok) js("window.__stt && window.__stt('denied','')");
            pendingListen = false;
        }
    }

    /** Sayfada JavaScript çalıştırır (her iş parçacığından güvenle çağrılır). */
    private void js(final String code) {
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript(code, null);
        });
    }

    /* ---------------- Konuşma tanıma ---------------- */
    private void doListen() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            pendingListen = true;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            js("window.__stt && window.__stt('error','')");
            return;
        }
        if (recognizer == null) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this);
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) { }
                @Override public void onBeginningOfSpeech() { }
                @Override public void onRmsChanged(float rmsdB) { }
                @Override public void onBufferReceived(byte[] buffer) { }
                @Override public void onEndOfSpeech() { }
                @Override public void onEvent(int eventType, Bundle params) { }

                @Override
                public void onError(int error) {
                    String type;
                    if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) type = "silence";
                    else if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) type = "denied";
                    else if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) {
                        if (recognizer != null) recognizer.cancel();
                        type = "silence";
                    } else type = "error";
                    js("window.__stt && window.__stt('" + type + "','')");
                }

                @Override
                public void onResults(Bundle results) {
                    ArrayList<String> r = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    String text = (r != null && !r.isEmpty()) ? r.get(0) : "";
                    js("window.__stt && window.__stt('final'," + JSONObject.quote(text) + ")");
                }

                @Override
                public void onPartialResults(Bundle partial) {
                    ArrayList<String> r = partial.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (r != null && !r.isEmpty()) {
                        js("window.__stt && window.__stt('partial'," + JSONObject.quote(r.get(0)) + ")");
                    }
                }
            });
        }
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "tr-TR");
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
        recognizer.startListening(i);
    }

    private void doSpeak(String text) {
        if (tts == null) {
            pendingSpeak = text;
            tts = new TextToSpeech(this, status -> {
                ttsReady = status == TextToSpeech.SUCCESS;
                if (!ttsReady) {
                    js("window.__ttsDone && window.__ttsDone()");
                    return;
                }
                tts.setLanguage(new Locale("tr", "TR"));
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String utteranceId) { }
                    @Override public void onDone(String utteranceId) { js("window.__ttsDone && window.__ttsDone()"); }
                    @Override public void onError(String utteranceId) { js("window.__ttsDone && window.__ttsDone()"); }
                });
                if (pendingSpeak != null) {
                    tts.speak(pendingSpeak, TextToSpeech.QUEUE_FLUSH, null, "kb");
                    pendingSpeak = null;
                }
            });
        } else if (ttsReady) {
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "kb");
        } else {
            pendingSpeak = text;
        }
    }

    /* ---------------- JavaScript köprüsü ---------------- */
    public class Bridge {

        /** Ağ isteği: CORS sorunu olmasın diye yerel yapılır, sonuç sayfaya geri verilir. */
        @JavascriptInterface
        public void fetch(final String id, final String url, final String method, final String headers, final String body) {
            new Thread(() -> {
                JSONObject h = null;
                try { h = new JSONObject(headers); } catch (Exception ignored) { }
                Object[] r = Net.request(method, url, h, body, 90000);
                js("window.__nf && window.__nf(" + JSONObject.quote(id) + "," + r[0] + "," + JSONObject.quote((String) r[1]) + ")");
            }).start();
        }

        @JavascriptInterface
        public String hashPassword(String password, String saltB64) {
            try {
                byte[] salt = Base64.decode(saltB64, Base64.DEFAULT);
                PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, 120000, 256);
                byte[] h = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
                return Base64.encodeToString(h, Base64.NO_WRAP);
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void saveSnapshot(String json) { Store.saveSnapshot(getApplicationContext(), json); }

        @JavascriptInterface
        public String drainQueue() { return Store.drain(getApplicationContext()); }

        @JavascriptInterface
        public void wipe() { Store.wipe(getApplicationContext()); }

        @JavascriptInterface
        public String runAction(String name, String argsJson) {
            return DeviceActions.run(MainActivity.this, name, argsJson);
        }

        @JavascriptInterface
        public void startListening() { runOnUiThread(() -> doListen()); }

        @JavascriptInterface
        public void stopListening() {
            runOnUiThread(() -> {
                pendingListen = false;
                if (recognizer != null) recognizer.cancel();
            });
        }

        @JavascriptInterface
        public void speak(final String text) { runOnUiThread(() -> doSpeak(text)); }

        @JavascriptInterface
        public void stopSpeak() {
            runOnUiThread(() -> {
                pendingSpeak = null;
                if (tts != null) tts.stop();
            });
        }

        @JavascriptInterface
        public String takeOpen() {
            String o = pendingOpen;
            pendingOpen = "";
            return o == null ? "" : o;
        }

        @JavascriptInterface
        public void requestNotifPermission() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33) {
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
                } else {
                    Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                    startActivity(i);
                }
            });
        }

        @JavascriptInterface
        public void openBatterySettings() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                } catch (Exception e) {
                    startActivity(new Intent(Settings.ACTION_SETTINGS));
                }
            });
        }

        /** Durum ve gezinme çubuğu rengi: açık temada krem, koyu temada koyu kahve. */
        @JavascriptInterface
        public void setBars(final boolean dark) {
            runOnUiThread(() -> {
                int c = dark ? 0xFF1E1411 : 0xFFFBF1DE;
                getWindow().setStatusBarColor(c);
                getWindow().setNavigationBarColor(c);
                View d = getWindow().getDecorView();
                int f = d.getSystemUiVisibility();
                int light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                d.setSystemUiVisibility(dark ? (f & ~light) : (f | light));
                web.setBackgroundColor(c);
            });
        }
    }
}
