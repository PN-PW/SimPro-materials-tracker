# SimPro Materials Tracker — Install & Update Guide

## Who this is for

Any PowerNaturally staff member who needs the material delivery tracker inside SimPro.  
You need **Google Chrome** or **Microsoft Edge** on a desktop/laptop.

---

## 1. Install Tampermonkey (once per browser)

1. Open the extension store for your browser:
   - **Chrome**: [chrome.google.com/webstore](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - **Edge**: [microsoftedge.microsoft.com/addons](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)
2. Click **Add to Chrome / Get** and confirm.
3. The Tampermonkey icon (a dark circle with two white dots) appears in the toolbar. Done.

---

## 2. Install the script (once per browser)

1. Click this link:  
   **[Install SimPro Materials Tracker](https://raw.githubusercontent.com/PN-PW/SimPro-materials-tracker/master/userscripts/simpro-materials-tracker.user.js)**
2. Tampermonkey intercepts it and shows an **Install** page.
3. Click **Install**.
4. Open SimPro and navigate to any Cost Centre → **Stock → Allocated** tab. The tracker loads automatically and asks you to sign in on first use.

> **Sign-in**: use your `@powernaturally.co.uk` email. Ask Pawel if you don't have a tracker account yet.

---

## 3. Updates — how they work

The script checks GitHub for a newer version every time Tampermonkey polls (default: once a day).

**When an update is available** you'll see a badge on the Tampermonkey icon. Click it → **Check for script updates** → **Update**. Takes 10 seconds.

**To check immediately**: Tampermonkey icon → Dashboard → find the script → click the circular arrow (↻ Check for updates).

You never need to re-download or re-install the script manually after the initial install.

---

## 4. Adding a new user (admin task)

1. **Supabase Dashboard** → Authentication → Users → **Add user** → Create new user.
   - Enter their work email + a temporary password, tick **Auto Confirm User** → **Create user**.
2. Ask them to follow steps 1–2 above to install the script.
3. When they first open a Cost Centre in SimPro the tracker will ask them to sign in with the credentials you just created.
4. Back in SimPro (as admin): open any Cost Centre → Allocated tab → click **Manage users** in the tracker bar → change their role to **Editor** (or **Admin** if appropriate).

> New users default to `readonly` — they can see tracking data but can't change anything until promoted.

---

## 5. Role summary

| Role       | View tracking | Edit tracking | Manage users |
|------------|:-------------:|:-------------:|:------------:|
| `readonly` |       ✓       |               |              |
| `editor`   |       ✓       |       ✓       |              |
| `admin`    |       ✓       |       ✓       |       ✓      |

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| Tracker columns don't appear on the Allocated tab | Hard-reload the page: **Ctrl+Shift+R** |
| "Sync failed" toast | Check your internet connection; the script retries automatically |
| Columns appear on Required / In Stock tabs | You're on an older version — click Tampermonkey → Check for updates |
| "Sign in" keeps reappearing | Your session expired; sign in again with your tracker credentials |
| You see a UUID (e.g. `6cf372ac…`) instead of a name in change history | Your account has no profile row — ask Pawel to run the user backfill query in Supabase |

---

## 7. For Pawel — deploying a script update

1. Edit `userscripts/simpro-materials-tracker.user.js` — bump `@version` in the header.
2. `git add` → `git commit` → `git push` to `master`.
3. Users will be notified automatically the next time Tampermonkey polls (up to 24 hours), or immediately if they check manually.

No further action needed.
