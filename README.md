# Yandex Temp Mail Inbox — Backend Server

Ye Node.js backend hai Yandex Temp Mail Inbox ke liye. Ek Yandex account
(`Man50or1@yandex.com`) se har visitor ko alag `+tag` temp email milta hai,
jaise `man50or1+uvhxb6@yandex.com`. Sab mail ek hi Yandex inbox me aati hai,
server har mail ke **To** header se `+tag` nikal kar us tag wale visitor ko
dikhata hai. Yandex ki mail kabhi delete nahi hoti, sirf read hoti hai.

> **Password kabhi code me nahi likhna.** App password sirf user ke paas hai.
> Wo sirf server par Setup karte waqt dala jata hai aur `data.json` me save
> hota hai. Kisi bhi response me password wapas nahi bheja jata.

## Endpoints

| Method | Endpoint | Kaam |
|---|---|---|
| GET | `/health` | `{ok:true}` — server zinda hai ya nahi |
| GET | `/api/setup` | `{configured, baseEmail, hasAppPassword}` (password kabhi nahi) |
| POST | `/api/setup` | `{baseEmail, appPassword}` save karo |
| POST | `/api/alias` | Naya random 6-char tag, 60-min expiry, `{address, tag, code, expiresAt}` |
| GET | `/api/alias/:code` | Alias dhoondo, na mile to 404 |
| POST | `/api/sync` | `{tag}` — Yandex IMAP se INBOX parho, `{status, newCount, total, error?}` |
| GET | `/api/messages/:tag` | Us tag ki mail list, newest first |
| GET | `/api/message/:tag/:id` | Ek mail ka full body, read mark karo |

- Setup nahi hai aur `POST /api/alias` bulao to 400 error aata hai:
  `Pehle Setup me apna Yandex base email dalo`
- Sync me error ho (jaise Yandex se connection na ho) to status
  `connect_failed` aur saaf error message aata hai. Mail kabhi invent nahi ki jati.
- IMAP: `imap.yandex.com`, port `993`, SSL. Sirf pehle 50 recent mail parhi
  jati hain. Har mail ka To, From, Subject, Date, text, html save hota hai,
  aur body se 4-8 digit OTP code bhi nikal liya jata hai agar mile.
- Setup, aliases aur messages `data.json` file me save hote hain taake
  restart par setup na khoye. **Render free plan par file ephemeral hai** —
  server restart / redeploy par `data.json` kho sakta hai, phir Owner Setup
  dobara karna hoga. Ye theek hai.

## Local par chalana

```bash
cd yandex-temp-mail-server
npm install
node server.js
# phir dusri terminal me:
curl http://localhost:3000/health
curl http://localhost:3000/api/setup
```

Port: `process.env.PORT` ya `3000`. Koi build step nahi hai.

## Render par deploy (steps)

1. **GitHub repo banao:** Is folder (`server.js`, `package.json`, `README.md`)
   ko ek naye GitHub repo me upload karo, jaise `yandex-temp-mail-server`.
   Repo public ya private, dono chalenge.
2. **Render.com par jao** aur sign in karo (user ka Render account pehle se hai —
   Zako token server bhi wahin chal raha hai).
3. **New + → Web Service** dabao, GitHub repo select karo.
4. Ye settings dalo:
   - **Name:** `yandex-temp-mail-server` (ya koi bhi naam)
   - **Region:** Singapore (Pakistan ke liye sab se nazdeek, fast)
   - **Branch:** main
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
   - Environment variables: kuch nahi chahiye (PORT Render khud deta hai)
5. **Create Web Service** dabao. Pehli dafa deploy me 2-5 minute lag sakte hain.
   Free plan par server 15 minute bina use ke so jata hai, pehli request par
   50 second tak lag sakta hai — ye normal hai.
6. Deploy ho jaye to service ka URL mile ga, jaise
   `https://yandex-temp-mail-server.onrender.com`. Is URL ko browser me khol
   kar `/health` check karo — `{ok:true}` aana chahiye.
7. **Phir artifact ko is URL se jorna hai:** Yandex Temp Mail Inbox artifact
   ke Owner Setup / API base URL me is Render URL ko dalo, phir Setup save
   karo (base email + app password), naya temp email banao, aur test mail
   bhej kar check karo ke inbox me mail dikhti hai ya nahi.

## Notes / Limits

- Yandex IMAP ke liye account me **IMAP ON** hona chahiye aur **App Password**
  chahiye (login password nahi chalega). Naya app password kabhi kabhi
  2-3 ghante baad active hota hai.
- Agar Render se bhi `SSL WRONG_VERSION_NUMBER` jaisa error aaye to samajh
  lo ke Yandex IMAP us network se block hai — phir alag tareeqa chahiye hoga
  (jaise Yandex Mail API ya koi aur provider).
- Ye backend sirf owner ke 1 Yandex account ke liye hai. Visitors ko kabhi
  base email ka password nahi dikhta.
