# 📺 Office TV app

Yeh Android app **seedha TV par install hoti hai**. Na PC chahiye, na HDMI, na API key.
Phone se TV ka QR scan karein aur phone ke browser se TV chalayein.

```
Phone (browser)  ──Wi-Fi──>  TV par chal rahi Office TV app  ──>  YouTube / Meet / PDF / PPT
```

Dahua DHI-LPH65-ST420 aur Panasonic LH55AN6ND dono Android par chalte hain, isliye
dono par yahi ek app lagegi.

## Phone se kya kya kar sakte hain
- **Link / meeting / website:** Google Meet, Zoom, Teams, koi bhi website
- **YouTube:** video ka naam likhein ya link paste karein
- **PPT / PDF / photo / video:** phone se file chunein, woh TV par copy hokar khul jaati hai
- **Remote:** slide aage/peeche, scroll, Back, Home, play/pause, volume
- **TV ki apps:** list dekh kar koi bhi app kholein
- **Screen hamesha on:** TV apne aap sleep/band na ho
- TV restart hone par app apne aap chalu ho jaati hai

## Step 1: APK download karein
1. GitHub par repo → **Actions** → **Build Office TV app** → sabse upar wala green run kholein.
2. Neeche **Artifacts** mein **OfficeTV-apk** download karein (zip milega; usme `OfficeTV.apk` hai).
3. `OfficeTV.apk` ko pen drive mein copy karein.

## Step 2: TV par install karein (dono TVs par)
1. Pen drive TV mein lagayein aur TV ka **File Manager** kholein.
2. `OfficeTV.apk` par click karein → **Install**.
   "Unknown sources" ka message aaye to Settings mein jaakar File Manager ko allow karein.
3. TV par **Office TV** app kholein. Screen par QR code, link aur PIN dikhega.

## Step 3: Ek baar ki setup (TV par, remote ya touch se)
1. **Accessibility settings kholo** button dabayein → **Office TV** → **On**.
   Isse Back/Home/slide control chalta hai, aur Android 10+ par links/files TV par khul paate hain.
2. Agar button dikhe to **Display over other apps** permission bhi de dein.
3. **Screen hamesha on rakho** tick rehne dein.
4. PDF/PPT ke liye TV par koi viewer app honi chahiye (jaise **WPS Office**). Meeting ke liye
   Zoom/Teams app, ya browser mein Google Meet.

## Step 4: Phone se chalayein
- Phone ko **usi Wi-Fi** par rakhein jis par TV hai.
- TV par dikh raha **QR scan** karein. Page khulega, PIN apne aap lag jayega.
- Page ko phone ki home screen par bookmark kar lein. Dono TVs ka alag-alag bookmark banayein.
- Router mein dono TVs ka IP fix (DHCP reservation) kar dein, taaki link na badle.

## Suraksha
- Page sirf usi Wi-Fi par khulta hai aur har command ke liye TV par dikh raha PIN chahiye.
- Kisi aur ko access dena band karna ho to TV app mein **Naya PIN banao** dabayein.
- Accessibility permission sirf buttons dabane/swipe ke liye use hoti hai; app screen ka content na padhti hai na kahin bhejti hai.
- APK sign karne ki key (`app/officetv.keystore`) repo mein hai taaki har naya build purani app par update ho sake.
  Yeh sirf office mein sideload karne ke liye theek hai; Play Store ke liye alag key banani hogi.

## Aage: Claude jodna
Abhi app bina API key ke poori chalti hai. API key milne ke baad isme ek chat box joda ja sakta hai
jahan "Dahua par sales wali PPT kholo" jaisi baat likhne par Claude khud sahi button daba de.

## Developers ke liye
`tv-app/` mein koi bhi change push karne par GitHub Actions naya APK bana deta hai
(`.github/workflows/tv-app.yml`). Local build: Android SDK + JDK 17 ke saath `gradle assembleRelease`.
