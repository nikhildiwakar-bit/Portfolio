package com.nikhil.officetv.relay;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.Base64;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManagerFactory;

/** A throw-away self-signed certificate (keytool) for the https / wss fakes, and a client factory trusting it. */
final class TestTls {
    final SSLContext server;
    final SSLSocketFactory client;
    final X509Certificate cert;
    final Path pem;

    private TestTls(SSLContext server, SSLSocketFactory client, X509Certificate cert, Path pem) {
        this.server = server;
        this.client = client;
        this.cert = cert;
        this.pem = pem;
    }

    /** Certificate for localhost, 127.0.0.1 and ::1. */
    static TestTls localhost() throws Exception {
        return create("SAN=dns:localhost,ip:127.0.0.1,ip:::1");
    }

    /** san: keytool's -ext value, e.g. "SAN=dns:other.invalid". */
    static TestTls create(String san) throws Exception {
        Path dir = Files.createTempDirectory("otv-tls");
        File ks = dir.resolve("fake.p12").toFile();
        String keytool = System.getProperty("java.home") + File.separator + "bin" + File.separator + "keytool";
        Process p = new ProcessBuilder(keytool, "-genkeypair", "-alias", "fake", "-keyalg", "EC", "-groupname", "secp256r1",
                "-validity", "30", "-dname", "CN=localhost", "-ext", san,
                "-keystore", ks.getPath(), "-storetype", "PKCS12", "-storepass", "changeit", "-keypass", "changeit",
                "-noprompt").redirectErrorStream(true).start();
        String out = new String(FakeNtfy.readAll(p.getInputStream(), 1 << 20), StandardCharsets.UTF_8);
        if (p.waitFor() != 0) throw new IOException("keytool failed: " + out);
        KeyStore store = KeyStore.getInstance("PKCS12");
        try (InputStream in = new FileInputStream(ks)) {
            store.load(in, "changeit".toCharArray());
        }
        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(store, "changeit".toCharArray());
        SSLContext serverCtx = SSLContext.getInstance("TLS");
        serverCtx.init(kmf.getKeyManagers(), null, null);
        Certificate cert = store.getCertificate("fake");
        KeyStore trust = KeyStore.getInstance(KeyStore.getDefaultType());
        trust.load(null, null);
        trust.setCertificateEntry("fake", cert);
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(trust);
        SSLContext clientCtx = SSLContext.getInstance("TLS");
        clientCtx.init(null, tmf.getTrustManagers(), null);
        Path pem = dir.resolve("fake.pem");
        String text = "-----BEGIN CERTIFICATE-----\n"
                + Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII)).encodeToString(cert.getEncoded())
                + "\n-----END CERTIFICATE-----\n";
        Files.write(pem, text.getBytes(StandardCharsets.US_ASCII));
        return new TestTls(serverCtx, clientCtx.getSocketFactory(), (X509Certificate) cert, pem);
    }
}
