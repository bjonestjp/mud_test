# Supabase Launch Checklist

Use this when moving the MVP from demo mode to a real friend-group game.

## 1. Create Project

1. Create a Supabase project on the Free plan.
2. Choose a region close to the players.
3. Save the project URL and anon public key.

## 2. Configure Auth

1. Open **Authentication -> Providers -> Email**.
2. Enable email/password sign-in.
3. For the simplest no-email friend-group launch, turn **Confirm email** off.
4. Add the deployed Cloudflare Pages URL later if you re-enable email confirmation or OAuth.

## 3. Run Database Migration

Run [supabase/migrations/001_initial_game.sql](</Users/bradjones/Documents/current work/june26/rite/supabase/migrations/001_initial_game.sql>) in the Supabase SQL editor or through the Supabase CLI.

If this project already had the first migration applied, run [supabase/migrations/002_manual_players_and_colors.sql](</Users/bradjones/Documents/current work/june26/rite/supabase/migrations/002_manual_players_and_colors.sql>) after it.

The migration creates:

- PostGIS and pgcrypto extensions
- `profiles`
- `pins`
- `pin_income_periods`
- `currency_ledger`
- `location_score_cache`
- Game RPCs
- Row Level Security policies

## 4. Add Local Env

Create `.env.local` from `.env.example`:

```text
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Restart the dev server after editing env values.

## 5. Confirm No-Email Auth

With custom SMTP disabled, Supabase's built-in email sender is heavily limited. For this MVP, keep email confirmation off and use email/password accounts.

## 6. Smoke Test Live Mode

1. Open the app.
2. Confirm the header shows your player name and token total.
3. Create a manual player in Supabase using [docs/manual-player-accounts.md](</Users/bradjones/Documents/current work/june26/rite/docs/manual-player-accounts.md>).
4. Sign in with that username and password.
5. Confirm your profile row has `300` points and a hex `player_color`.
6. Drop a pin from a phone browser.
7. Confirm the pin appears for all signed-in players in that player's colour.
8. Restock the pin while within 50m.

## 7. Invite Friends

For the first playtest, keep access social rather than technical:

- Share the app link only with the test group.
- Give each player their username and password.
- Ask players to report weird balances with screenshots.

The `currency_ledger` table should make disputes debuggable.

## 8. Before Public Sharing

Do these before the game leaves the friend group:

- Add a minimum spacing rule or warning for exact overlapping pins.
- Replace placeholder `score_location` with cached OSM/WorldPop scoring.
- Add basic admin views for players, pins, and ledger entries.
- Add rate limits or cooldowns for pin placement.
- Review Supabase usage after the first week.
