# Co-op fork: join mid-match, rejoin, kick and pause

This is a modified copy of PokéSurvivor (original by JPTER78, PolyForm
Noncommercial 1.0.0 — free to use and modify, never for money).

## What's different

- **Join a match in progress.** Friends can open their friends list, press
  **Join** next to someone who is in a room, and then **Join the game** in the
  room. They come in at the match's current minute and get one random upgrade
  for each level they missed. Their rewards only count from when they joined.
- **Rejoin after a lag-out.** If a guest's connection drops, their game pauses
  with a "reconnecting…" message and they come back with their Pokémon exactly
  as it was once the connection returns (up to 2 minutes). If their game
  closed completely, they reopen it, go back to the room and press
  **Join the game**.
- **Host can kick.** From the room (Kick on a player's card) or mid-match from
  the pause menu. A kicked player can't come back into that room.
- **Host can pause for everyone.** Pause menu → **Pause for everyone**, and
  **Resume for everyone** to continue.

Nobody can join while the host is inside a rift or the Judgment of Arceus;
they're let in automatically as soon as it ends.

## Running your own copy

The game is a static web page, but accounts, friends and rooms use Google
Firebase, so your copy needs its own (free) Firebase project. Your friends
then open your copy's web address instead of pokesurvivor.com.

1. **Create a Firebase project** and set up Authentication, Firestore and
   Realtime Database by following [`FIREBASE.md`](FIREBASE.md) (in Spanish;
   each step names the exact button). Use the free Spark plan. Do not turn on
   "Identity Platform".
2. **Upload this fork's rules** — they include the new kick protection:
   ```
   npx firebase-tools deploy --only firestore,database --project YOUR-PROJECT
   ```
3. **Point the game at your project:** replace the config in
   `js/core/firebase-config.js` with your project's web app config
   (`apiKey`, `authDomain`, `projectId`, `databaseURL`, …).
4. **Rebuild** after any code change:
   ```
   node tools/build.js && node tools/export_data.js && python3 tools/make_seo_pages.py
   ```
5. **Host it** somewhere your friends can reach. The simplest free option is
   GitHub Pages (Settings → Pages; needs a public repo on a free GitHub plan)
   or Firebase Hosting. Then add that domain in Firebase → Authentication →
   Settings → **Authorized domains**, or sign-in won't work.

To try it on your own machine first: run `python3 -m http.server 8000` in this
folder and open `http://localhost:8000/dev.html` (`localhost` is authorized by
default in Firebase).

## Known limits

- Co-op still only uses direct connections (free Google STUN). Players on
  networks that block direct connections (some mobile data, school or work
  Wi-Fi) still can't connect; adding a TURN relay would fix that.
