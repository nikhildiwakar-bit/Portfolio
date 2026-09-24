# 📺 TV Control with Claude

Office ke Dahua (DHI-LPH65-ST420) aur Panasonic (LH55AN6ND) TVs ko chat se chalayein:
"Dahua par YouTube kholo", "Panasonic par yeh meeting join karo", "PDF dikhao", "volume 30 karo".

```
Aap (phone/laptop browser) → yeh app (office PC) → Claude API
                                     ↓
                               TV (Wi-Fi par ADB)
```

Content seedha TV par khulta hai, isliye laptop se screen share nahi karni padti.

## Kya chahiye
- Ek office computer jo hamesha on rahe (Windows/Linux/Mac), TVs wale Wi-Fi par
- Python 3.10+ — https://www.python.org/downloads/ (install karte waqt "Add to PATH" tick karein)
- Android Platform Tools (adb) — https://developer.android.com/tools/releases/platform-tools
  (zip kholein aur folder ko PATH mein daalein)
- Claude API key — https://console.anthropic.com

## Step 1: TVs par ADB on karein (dono TVs par)
1. Settings → About → **Build number** par 7 baar tap karein → Developer options on.
2. Developer options → **USB debugging** on karein (aur "Network/Wireless debugging" ho to woh bhi).
3. Settings → Network se TV ka **IP address** note karein.
4. Router mein dono TVs ke IP **fix (DHCP reservation)** kar dein, taaki badlein nahi.

> Menu locked ho to installer / admin password lagega. Kuch panels par ADB port 5555
> pehli baar USB cable laga kar `adb tcpip 5555` chalane se on hota hai.

## Step 2: Setup
1. `tvs.example.json` ko copy karke `tvs.json` banayein aur dono IP likhein.
2. Pehli baar dono TVs se connect karein; TV par "Allow USB debugging?" aaye to **Always allow** tick karke OK:
   ```
   adb connect 192.168.1.50:5555
   adb connect 192.168.1.51:5555
   ```
3. API key set karein:
   - Windows: `setx ANTHROPIC_API_KEY "sk-ant-..."` (phir naya terminal kholein)
   - Linux/Mac: `export ANTHROPIC_API_KEY="sk-ant-..."`

## Step 3: Chalayein
- Windows: `start.bat` par double-click
- Linux/Mac: `./start.sh`

Phir kisi bhi phone/laptop (same Wi-Fi) ke browser mein kholein: `http://<office-PC-ka-IP>:8080`

## Kya kya kar sakte hain
| Kaam | Example |
|---|---|
| YouTube | "Dahua par lofi music chalao" |
| Website | "Panasonic par fsksurat.in kholo" |
| Meeting | "Dahua par yeh Zoom join karo: https://zoom.us/j/..." (TV par Zoom/Meet/Teams app honi chahiye) |
| PDF/PPT/photo/video | Page par file upload karein → "isko Dahua par kholo" (TV par PDF/Office viewer app honi chahiye) |
| Remote | "next page", "back jao", "home", "pause karo" |
| Volume | "dono TVs ka volume 20 karo" |
| Status / restart | "Panasonic ka status batao", "Dahua hang hai, restart karo" |

Har minute app TVs se dobara connect karta hai aur unhe sleep mein jaane se rokta hai
(`tvs.json` mein `"keep_awake": false` karke band kar sakte hain).

## Dhyan dein
- API usage ka paisa lagta hai (har command ka thoda sa). Default model `claude-opus-5` hai;
  sasta chahiye to `CLAUDE_MODEL=claude-haiku-4-5` set karein.
- Yeh page sirf office Wi-Fi par kholein. Isko internet par public na karein, warna koi bhi TVs chala sakta hai.
- TV khud hardware/garmi ki wajah se band ho raha ho to software se woh theek nahi hoga.
