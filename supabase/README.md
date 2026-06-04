# Supabase Notes

The first migration creates the MVP database, game RPCs, and Row Level Security policies.

## Important Functions

- `place_pin(lat, lng, name, pin_type, accuracy_m)`
- `restock_pin(pin_id, lat, lng, accuracy_m)`
- `settle_player_income()`
- `get_visible_pins()`
- `get_leaderboard()`

The game uses `pin_income_periods` so passive income remains historically correct when nearby pins appear, go out of stock, or get restocked.

## Placeholder Scoring

`score_location` currently creates a deterministic score from the rounded coordinate cell. It includes a small Edinburgh-center boost for playtesting. Replace this with an Edge Function or scheduled import once the OSM/WorldPop scoring path is ready.

## Free-Tier-Friendly Behavior

There is no background scheduler. Income is settled when players load the app or perform actions. For the expected group size, `get_visible_pins` and `get_leaderboard` settle all users before returning map rates or rankings.
