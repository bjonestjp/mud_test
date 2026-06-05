# mudslingers MVP Spec

## Product Shape

This is an async multi-user browser game for a small friend group. Players compete to build fictional coffee shops by travelling to real physical locations and dropping pins from their phones.

The MVP should feel like a lightweight territory game:

- Players sign in with real accounts.
- Players start with a small number of simple tokens.
- Dropping a shop pin costs tokens, so players cannot spam the map.
- Pins earn passive income based on how busy/populous the area is.
- Nearby pins reduce each other's income, including pins owned by the same player.
- Standard pins stop earning after 72 hours unless the owner physically revisits and restocks them.
- Pins are visible to all players immediately.
- Income accrues automatically, but calculations happen lazily when players open the app or perform an action.

The initial group size is around 20 users. Cheating resistance only needs to be casual.

## Recommended Free Stack

- Frontend hosting: Cloudflare Pages
- Database/auth/backend state: Supabase Free
- Database spatial queries: Supabase PostGIS
- Maps: MapLibre GL JS
- Tiles: OpenFreeMap for MVP, with a later option to move to Protomaps/PMTiles
- Busy area scoring: OpenStreetMap POI/transit density plus WorldPop population density, cached by location cell

This keeps the app serverless from the player's point of view. Supabase Postgres is the source of truth, and no always-on server or paid scheduler is required.

## Core Game Constants

These should live in a database table or config module so they are easy to tune.

| Setting | MVP value |
| --- | ---: |
| Visible token unit | 100 internal points |
| Starting balance | 300 points, shown as 3 tokens |
| Standard pin cost | 200 points, shown as 2 tokens |
| Restock radius | 50 meters |
| Competition radius | 300 meters |
| Standard pin restock window | 72 hours |
| Pin visibility | Immediate |
| Own pins compete | Yes |
| Income accrual | Automatic, settled lazily |

Temporary pins can be represented in the data model from the start, but do not need to be exposed in the first UI.

## MVP Screens

### Sign In

- Email/password auth.
- First login creates a profile with a display name and starting balance.

### Map

- Full-screen map centered on the player's current location when available.
- Players can pan and zoom freely to scout existing pins and open areas.
- Shows all visible pins.
- Pin color or icon distinguishes owner vs other players.
- Selecting a pin shows owner, name, status, busy score, hourly income, restock state, and nearby competition impact.

### Drop Pin

- Player taps a map action.
- App requests current phone location using the browser Geolocation API.
- The pin is placed at the player's current verified location, not at the current map center.
- Backend verifies the player has enough points.
- Backend scores the area, spends the cost, creates the pin, recalculates affected nearby pins, and returns the result.

Demo mode may simulate the player's current location for desktop testing. The simulated location can be moved from the current map center with the locate action, but ordinary map browsing should not silently change where a pin will be placed.

### Restock

- Player selects one of their standard pins.
- App requests current phone location.
- Backend verifies the player is within 50m of the pin.
- Backend updates `last_restocked_at` and `restock_due_at`, then recalculates affected nearby pins.

### Leaderboard

- Shows player display name, token balance, active pin count, and total lifetime income.
- For MVP, the leaderboard can update on page load/action rather than in realtime.

## Busy Score

Each pin receives a `busy_score` from 0 to 100 at placement time. This is intended to represent how likely a coffee shop is to sell drinks there.

Recommended MVP formula:

```text
busy_score =
  0.55 * poi_density_score
  + 0.25 * transit_density_score
  + 0.20 * population_density_score
```

Where:

- `poi_density_score` counts nearby shops, cafes, restaurants, pubs, offices, tourism, amenities, leisure spots, and similar OSM features.
- `transit_density_score` counts nearby stations, stops, platforms, and transport hubs.
- `population_density_score` uses WorldPop or a cached population-density source.

Scores should be cached by a stable location cell, not raw coordinate, so multiple nearby pin drops reuse the same score.

Suggested cache resolution: roughly 100m to 150m cells.

The score should be explainable in the UI as a simple label:

- `Quiet`
- `Steady`
- `Busy`
- `Packed`

Exact details can stay hidden for MVP.

## Income Formula

Use internal numeric points for all math. The UI can still show simple tokens. The visible conversion remains simple:

```text
100 points = 1 token
```

```text
base_hourly_points = max(1, round(2 + busy_score * 0.08))
```

With `busy_score` from 0 to 100, this gives a base range of roughly 2 to 10 points per hour.

Competition reduces income:

```text
pressure_from_pin = (1 - distance_m / competition_radius_m)^2
total_pressure = sum(pressure_from_pin for each active stocked pin within radius)
competition_multiplier = 1 / (1 + total_pressure)
hourly_rate_points = round(base_hourly_points * competition_multiplier, 2)
```

Only active, stocked pins compete. Pins that need restocking do not earn and do not compete. Temporary pins, once added, compete only until they expire.

This produces intuitive behavior:

- A rival pin very close by hurts a lot.
- A rival pin near the edge of the radius barely matters.
- Multiple nearby pins stack pressure.
- A player's own nearby pins reduce each other too.

## Temporal Income Correctness

Naive lazy calculation is not enough. If a pin earns alone for a day, then another player places a nearby pin, the first pin should only receive reduced income from the moment the competing pin appeared.

The MVP should use income periods.

An income period records a rate over a specific span:

```text
pin_income_periods
  pin_id
  starts_at
  ends_at
  hourly_rate_points
  busy_score
  competition_pressure
  ending_reason
```

When a game event changes income, the backend closes affected current periods at the event timestamp and opens new periods with recalculated rates.

Events that change income:

- A pin is placed.
- A pin is restocked.
- A standard pin reaches `restock_due_at`.
- A temporary pin reaches `expires_at`.
- A pin is deleted or administratively disabled.
- A future scoring formula migration is applied.

There is no paid scheduler. Instead, each period should end at the earliest known future rate-change boundary:

```text
period_ends_at =
  min(
    this_pin.restock_due_at_or_expires_at,
    earliest_nearby_competing_pin.restock_due_at_or_expires_at
  )
```

When a player opens the app, views the leaderboard, places a pin, or restocks a pin, the backend settles income up to `now()` by walking any expired periods and generating the next period if needed.

This keeps offline income historically accurate:

- If a competitor appears, earlier income is preserved at the old rate.
- If a competitor goes out of stock while nobody is online, affected pins can regain income from that exact deadline when settlement next runs.
- If a pin itself goes out of stock, it stops earning exactly at its restock deadline.

## Data Model

### `profiles`

```text
id uuid primary key references auth.users(id)
display_name text not null
points_balance numeric(12,2) not null default 300
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
```

### `game_config`

```text
key text primary key
value jsonb not null
updated_at timestamptz not null default now()
```

Example keys:

- `currency`
- `pin_costs`
- `competition`
- `income_formula`
- `scoring_formula`

### `pins`

```text
id uuid primary key default gen_random_uuid()
owner_id uuid not null references profiles(id)
name text not null
pin_type text not null check (pin_type in ('standard', 'temporary'))
lat double precision not null
lng double precision not null
geog geography(Point, 4326) not null
busy_score integer not null check (busy_score between 0 and 100)
score_cell_key text not null
placed_at timestamptz not null default now()
visible_at timestamptz not null default now()
last_restocked_at timestamptz
restock_due_at timestamptz
expires_at timestamptz
disabled_at timestamptz
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
```

Indexes:

```text
create index pins_geog_idx on pins using gist (geog);
create index pins_owner_idx on pins (owner_id);
create index pins_visible_idx on pins (visible_at);
create index pins_restock_due_idx on pins (restock_due_at);
```

### `pin_income_periods`

```text
id uuid primary key default gen_random_uuid()
pin_id uuid not null references pins(id)
starts_at timestamptz not null
ends_at timestamptz
hourly_rate_points numeric(10,2) not null
busy_score integer not null
competition_pressure numeric(10,4) not null
ending_reason text
created_at timestamptz not null default now()
```

Indexes:

```text
create index pin_income_periods_pin_idx on pin_income_periods (pin_id, starts_at);
create index pin_income_periods_open_idx on pin_income_periods (pin_id) where ends_at is null;
```

For this design, `ends_at` can usually be set to the next known deadline. It may be null only when no known future boundary exists.

### `currency_ledger`

```text
id uuid primary key default gen_random_uuid()
player_id uuid not null references profiles(id)
amount_points numeric(12,2) not null
balance_after numeric(12,2) not null
reason text not null
source_pin_id uuid references pins(id)
created_at timestamptz not null default now()
```

Use this for every balance change:

- starting grant
- pin purchase
- income settlement
- admin adjustment

### `location_score_cache`

```text
score_cell_key text primary key
center_lat double precision not null
center_lng double precision not null
busy_score integer not null
poi_density_score integer not null
transit_density_score integer not null
population_density_score integer not null
source_details jsonb not null default '{}'
scoring_version integer not null default 1
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
```

## Backend Operations

Prefer Postgres RPC functions for game-state transactions. Use an Edge Function only where external API calls are needed, such as busy-score calculation.

### `score_location(lat, lng)`

Type: Supabase Edge Function or server-side helper.

Responsibilities:

- Convert raw coordinates to a stable score cell key.
- Return cached score if available.
- Fetch OSM/WorldPop signals if missing.
- Normalize the signals to 0-100 sub-scores.
- Save to `location_score_cache`.
- Return score details.

### `place_pin(lat, lng, name, pin_type)`

Type: authenticated backend operation.

Responsibilities:

- Settle the player's income before checking balance.
- Verify the player has enough points.
- Get or create location score.
- Insert pin.
- Spend pin cost in `currency_ledger`.
- Find all active/stocked pins within 300m, including own pins.
- Close affected current income periods at placement time.
- Credit settled income for any periods closed by the event.
- Recalculate and open new periods for affected pins.
- Return the new pin and updated player balance.

### `restock_pin(pin_id, current_lat, current_lng)`

Responsibilities:

- Verify pin belongs to the authenticated player.
- Verify player is within 50m of the pin.
- Settle relevant income up to now.
- Update `last_restocked_at = now()` and `restock_due_at = now() + interval '72 hours'`.
- Find all active/stocked pins within 300m.
- Close and reopen affected periods.
- Credit settled income for any periods closed by the event.
- Return updated pin and balance.

### `settle_player_income(player_id)`

Responsibilities:

- For each active pin owned by the player, settle income periods up to now.
- Credit earned points via `currency_ledger`.
- Update `profiles.points_balance`.
- Return updated balance and per-pin income summary.

This should run on app load, before pin placement, before restocking, and before leaderboard display.

For the MVP group size, leaderboard display can settle all active players before reading rankings. With around 20 players, that is simpler than maintaining a background job and keeps the rankings honest.

### `get_visible_pins(bounds)`

Responsibilities:

- Return all pins with `visible_at <= now()` within the map bounds.
- Include owner display name, busy label, active/restock state, and current approximate hourly rate.
- Do not expose unnecessary auth/user metadata.

## Security and Trust

MVP security posture:

- Trust browser geolocation enough for a friend group.
- Backend remains authoritative for currency, ownership, restock checks, and scoring.
- Use Row Level Security so players can only mutate their own profile and pins through approved functions.
- Let players read visible pins and public leaderboard rows.
- Do not store continuous location history.
- Store only pin coordinates and the location reported at restock/drop time if needed for debugging.

Optional later anti-cheat:

- Reject low-accuracy geolocation readings, for example `accuracy > 100m`.
- Add cooldowns for pin placement.
- Flag impossible travel speed between consecutive actions.
- Require photo proof for special events.

## MVP Build Order

1. Create Supabase project and enable Auth/PostGIS.
2. Build schema, indexes, RLS, and core RPC functions.
3. Build a minimal web app with sign-in, map, visible pins, and player balance.
4. Add drop-pin flow with current location and token cost.
5. Add income periods and settlement.
6. Add competition recalculation within 300m.
7. Add restock flow with 50m location verification.
8. Add busy-score cache with a placeholder formula.
9. Replace placeholder busy score with OSM/WorldPop scoring.
10. Add leaderboard and pin detail panels.
11. Playtest with manual config tuning.

The placeholder busy score in step 8 is useful because it lets the core game be tested before external data calls are involved.

## Later Features

### Temporary Pins

Cheaper pins that expire completely after 72 hours.

Suggested starting values:

```text
temporary_pin_cost = 100 points
expires_at = placed_at + 72 hours
restock_due_at = null
```

Temporary pins should earn and compete until `expires_at`, then stop earning and stop competing.

### Upgrades

Potential upgrade paths:

- Longer restock window.
- Reduced competition pressure.
- Better income multiplier.
- One-time shield against nearby competition.
- Cosmetic shop names/icons.

### Visibility Variants

The data model supports future delayed visibility through `visible_at`.

Possible later modes:

- Immediate visibility, current MVP.
- Delayed reveal after 24 hours.
- Reveal only after earning starts.
- Owner-only until restocked.
- District-level hints instead of exact pins.

## Open Design Questions

- Should players be allowed to place pins indoors if geolocation accuracy is poor?
- Should a pin be allowed directly on top of another pin, or should there be a minimum spacing rule?
- Should restocking cost anything, or just require the physical visit?
- Should players name pins freely, or should names be generated/moderated?
- Should inactive/restock-needed pins remain visible on the map?
- Should a player lose the original pin purchase cost forever, or should deleting a pin refund anything?

Recommended MVP answers:

- Allow poor indoor accuracy only if reported accuracy is under 100m.
- Add a soft minimum spacing warning, but no hard block at first.
- Restocking is free.
- Free text names are fine for a friend group.
- Restock-needed pins remain visible but show as inactive.
- No refunds for deleted pins in MVP.
