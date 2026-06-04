# Coffee Pins

An async browser game where friends build fictional coffee shops by travelling to real places and dropping pins.

## Local Development

Install dependencies:

```bash
npm install
```

Run the app:

```bash
npm run dev
```

Without Supabase environment variables, the app runs in demo mode with local sample pins around Edinburgh. Demo mode stores state in `localStorage`; the locate button moves a simulated player location to the current map center for desktop playtesting.

## Supabase Setup

1. Create a Supabase project.
2. Enable email/password auth. For the friend-group MVP, turn off email confirmation so accounts do not depend on Supabase auth emails.
3. Run the SQL migration in [supabase/migrations/001_initial_game.sql](supabase/migrations/001_initial_game.sql).
4. Copy `.env.example` to `.env.local`.
5. Fill in:

```text
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

6. Restart the dev server.

For the fuller handoff sequence, use [docs/supabase-launch-checklist.md](docs/supabase-launch-checklist.md).

For a free HTTPS playtest deployment, use [docs/deploy-vercel.md](docs/deploy-vercel.md).

The frontend calls these Supabase RPCs:

- `settle_player_income`
- `place_pin`
- `restock_pin`
- `get_visible_pins`
- `get_leaderboard`

## Current MVP Scope

- Real accounts through Supabase Auth
- Full-screen MapLibre map
- Standard coffee shop pins
- Free map browsing, with live pin placement tied to the player's current browser location
- 3 starting tokens, 2-token standard pin cost
- 50m restock radius
- 300m competition radius
- Own pins and rival pins both compete
- Automatic passive income settlement
- Immediate pin visibility
- Demo-mode fallback when Supabase is not configured

## Busy Score

The migration includes a deterministic placeholder `score_location` function so the game can be playtested before external data calls are wired in.

The intended next version should replace or augment that placeholder with cached OpenStreetMap POI/transit density and WorldPop population density.
