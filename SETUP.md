# Fountain Pens and Inks — setup

The app is a set of plain files (no build step). You put them on GitHub Pages (free hosting), then connect Google Drive so your phone and PC share the same collection. It takes about 30 minutes, once.

## 1. Put the app online (GitHub Pages, ~10 min)

1. Create a free account at **github.com** (skip if you have one).
2. Top-right **+** → **New repository**. Name it `Fountain-Pens-and-Inks`. Set it to **Public** (GitHub Pages is free for public repositories. Your ink *data* is not stored here, only the app code). Click **Create repository**.
3. On the new repository page, click **uploading an existing file**. Unzip `Fountain-Pens-and-Inks.zip` on your PC and drag **all of its contents** (the files and the `js` and `icons` folders, not the outer folder) into the page. Click **Commit changes**.
4. Go to **Settings → Pages**. Under *Build and deployment*, pick **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
5. After a minute or two, your app is live at `https://YOUR-USERNAME.github.io/Fountain-Pens-and-Inks/`.

At this point the app already works, but it saves only on the device you're using. Your 178 inks from the Excel file are pre-loaded.

## 2. Connect Google Drive (~15 min)

This creates a "key" that lets *your* app save into *your* Google Drive. Google calls it an OAuth Client ID. It's free.

1. Go to **console.cloud.google.com** and sign in with the Google account whose Drive you want to use.
2. At the top, open the project picker → **New project** → name it `Fountain Pens and Inks` → **Create**. Make sure it's selected.
3. Search the top bar for **Google Drive API** → open it → **Enable**.
4. Left menu **APIs & Services → OAuth consent screen** (it may be called **Google Auth Platform**). Click **Get started**:
   - App name: `Fountain Pens and Inks`. User support email: your email.
   - Audience: **External**.
   - Contact email: your email → **Create**.
   - Then open **Audience** → under *Test users* click **Add users** and add your own Gmail address. (While the app is in "Testing" only the listed users can sign in, which is exactly what you want.)
5. **Clients** (or *Credentials → Create credentials → OAuth client ID*):
   - Application type: **Web application**. Name: `Fountain Pens and Inks Web`.
   - **Authorized JavaScript origins** → **Add URI** → `https://YOUR-USERNAME.github.io` (no path, no trailing slash).
   - **Create**. Copy the **Client ID** (ends in `.apps.googleusercontent.com`).
6. Still in **APIs & Services → Credentials**: **Create credentials → API key**. Copy it. Then click the key to **restrict** it:
   - *Application restrictions*: **Websites** → add `https://YOUR-USERNAME.github.io/*`
   - *API restrictions*: **Restrict key** → tick **Google Drive API** → **Save**.
   (The API key is only used by the read-only link you share with others.)
7. Back on GitHub, open `config.js` in your repository → pencil icon (Edit) → paste both values between the quotes:
   ```js
   window.INK_CONFIG = {
     clientId: '1234…apps.googleusercontent.com',
     apiKey: 'AIza…',
   };
   ```
   **Commit changes**. Wait a minute for Pages to update.

## 3. Start using it

- Open the app on your **PC** → **Settings → Sign in & sync**. Google asks for permission. Because the app is in testing mode you may see "Google hasn't verified this app": click **Continue**. A folder called **Fountain Pens and Inks** appears in your Drive.
- Open the same address on your **Android phone** in Chrome → menu ⋮ → **Add to Home screen / Install**. Open it from the home screen → **Settings → Sign in & sync**.
- From then on, every change syncs automatically while you're signed in. The badge (top right on the phone, bottom left on the PC) shows the status. If it says **Tap to sync**, tap it. Google sign-ins last about an hour, so the app sometimes needs that one tap.

### Sharing a read-only link
**Settings → Read-only link for others** → turn it on. After the sync, copy the link. People who open it can browse, search and filter, but can't change anything. It only exposes the catalogue file and your photos, never anything else in your Drive. Turn it off to make everything private again.

## Scanning swatch cards

**Tips for the photo**
- Put the card on a **dark or coloured surface** (a dark notebook cover, cloth or desk). The app finds the card by its edges, and a dark background makes them obvious. A white sheet behind the card makes it *harder*, not easier.
- You don't need white paper for white balance: the card's own white border is the reference.
- Use even light without glare (a light box is great). Shoot roughly from above, but small tilts are corrected automatically.
- If the card isn't found, the app tries to locate the swatch square and works out the card from it. You can always drag the corners.

**Inks → (an ink) → Add swatch card photo** (or **Edit → Scan swatch card**):
1. Take the photo with the camera, or pick one from the gallery. The app finds the card and puts the 4 corners on it. If they're off, drag them; a magnifier helps you place them precisely.
2. **Next**: the card is straightened. The pink target marks the white paper the colours are corrected against; drag it if it isn't on clean white paper. Move or resize the yellow **Swatch** box and the green **Writing** box.
3. Tick **Remember box positions** the first time, so every following card is cropped the same way.
4. **Save**. The app stores 3 images (swatch, writing sample, whole card), measures the ink's colour from the swatch and **selects the colour group automatically**. Tap another group to override it. Your own choice is never overwritten; a later photo then only *suggests* a group.

The default box positions are set for Wearingeul "instant film" cards, which are bank-card size (85.6 × 54 mm). For other card types, adjust the boxes once and tick **Remember box positions**.

Pens get a **Pen** photo and a **Writing sample** photo the same way, with free cropping and the same white-balance target.

## Your data
- **Settings → Export to Excel** gives you a spreadsheet of inks, pens and fill history at any time.
- In Google Drive, `Fountain Pens and Inks/fountain-pens-and-inks.json` holds all data and `Fountain Pens and Inks/photos/` holds every photo as a normal JPG. Nothing is locked in.
- **Download backup** saves the data file locally. **Restore** merges a backup back in.

## Updating the app later
Replace the changed files in the GitHub repository (Add file → Upload files). Your data is not affected: it lives on your devices and in Drive. If an installed app shows an old version, close it fully and reopen it twice.
