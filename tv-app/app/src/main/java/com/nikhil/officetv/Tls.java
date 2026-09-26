package com.nikhil.officetv;

import android.content.Context;

import java.io.IOException;
import java.io.InputStream;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * HTTPS for old TVs: Android 7.0 and older do not trust Let's Encrypt's ISRG roots, so we trust the
 * system CAs plus the roots bundled in assets/certs/.
 */
final class Tls {
    private static final String CERT_DIR = "certs";
    private static volatile SSLSocketFactory cached;

    private Tls() {}

    /** Never throws; falls back to the platform default factory (and notes why). */
    static SSLSocketFactory socketFactory(Context c) {
        SSLSocketFactory f = cached;
        if (f != null) return f;
        synchronized (Tls.class) {
            if (cached == null) cached = create(c);
            return cached;
        }
    }

    private static SSLSocketFactory create(Context c) {
        try {
            KeyStore bundled = loadCerts(c);
            X509TrustManager system = trustManager(null);
            X509TrustManager extra = bundled == null ? null : trustManager(bundled);
            if (extra == null) {
                CrashLog.note(c, "TLS: bundled certificates missing, using system CAs only.");
                return HttpsURLConnection.getDefaultSSLSocketFactory();
            }
            return factory(new Composite(system, extra));
        } catch (Throwable t) {
            CrashLog.note(c, "TLS setup failed, using default: " + t);
            return HttpsURLConnection.getDefaultSSLSocketFactory();
        }
    }

    static SSLSocketFactory factory(X509TrustManager tm) throws GeneralSecurityException {
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[] {tm}, null);
        return ctx.getSocketFactory();
    }

    /** All .pem/.crt files in assets/certs/ as a KeyStore, or null if there are none. */
    private static KeyStore loadCerts(Context c) throws IOException, GeneralSecurityException {
        String[] names = c.getAssets().list(CERT_DIR);
        if (names == null) return null;
        List<InputStream> streams = new ArrayList<>();
        try {
            for (String n : names) {
                String lower = n.toLowerCase(Locale.US);
                if (lower.endsWith(".pem") || lower.endsWith(".crt")) streams.add(c.getAssets().open(CERT_DIR + "/" + n));
            }
            return keyStore(streams);
        } finally {
            for (InputStream in : streams) {
                try {
                    in.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    /** PEM or DER certificates -> KeyStore of trusted entries, or null if none could be read. */
    static KeyStore keyStore(List<InputStream> certs) throws GeneralSecurityException, IOException {
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
        ks.load(null, null);
        int n = 0;
        for (InputStream in : certs) {
            Collection<? extends Certificate> list;
            try {
                list = cf.generateCertificates(in);
            } catch (CertificateException e) {
                continue;
            }
            for (Certificate cert : list) ks.setCertificateEntry("bundled-" + n++, cert);
        }
        return n == 0 ? null : ks;
    }

    /** The X509TrustManager for a KeyStore (null = the system CAs). */
    static X509TrustManager trustManager(KeyStore ks) throws GeneralSecurityException {
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(ks);
        for (TrustManager tm : tmf.getTrustManagers()) {
            if (tm instanceof X509TrustManager) return (X509TrustManager) tm;
        }
        return null;
    }

    /** Trusts a chain if any of its trust managers does. Hostname checks stay with HttpsURLConnection. */
    static final class Composite implements X509TrustManager {
        private final X509TrustManager[] tms;

        Composite(X509TrustManager... tms) {
            List<X509TrustManager> l = new ArrayList<>();
            for (X509TrustManager tm : tms) if (tm != null) l.add(tm);
            this.tms = l.toArray(new X509TrustManager[0]);
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            CertificateException first = null;
            for (X509TrustManager tm : tms) {
                try {
                    tm.checkClientTrusted(chain, authType);
                    return;
                } catch (CertificateException | RuntimeException e) {
                    if (first == null) first = asCertError(e);
                }
            }
            throw first != null ? first : new CertificateException("No trust manager");
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            CertificateException first = null;
            for (X509TrustManager tm : tms) {
                try {
                    tm.checkServerTrusted(chain, authType);
                    return;
                } catch (CertificateException | RuntimeException e) {
                    if (first == null) first = asCertError(e);
                }
            }
            throw first != null ? first : new CertificateException("No trust manager");
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            List<X509Certificate> all = new ArrayList<>();
            for (X509TrustManager tm : tms) {
                try {
                    X509Certificate[] a = tm.getAcceptedIssuers();
                    if (a != null) for (X509Certificate x : a) all.add(x);
                } catch (RuntimeException ignored) {
                }
            }
            return all.toArray(new X509Certificate[0]);
        }

        private static CertificateException asCertError(Exception e) {
            if (e instanceof CertificateException) return (CertificateException) e;
            return new CertificateException(e);
        }
    }
}
