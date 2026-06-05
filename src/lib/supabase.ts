import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  GameAdapter,
  GamePin,
  GameState,
  LeaderboardRow,
  PlacePinInput,
  PlayerProfile,
  RestockPinInput
} from "../types";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const MANUAL_ACCOUNT_DOMAIN = "players.mudslingers.test";
const PLAYER_COLORS = [
  "#21745c",
  "#2f5f9f",
  "#ba3c3a",
  "#8a5b20",
  "#7a4ab8",
  "#d36b2c",
  "#0f766e",
  "#be185d",
  "#4338ca",
  "#0891b2",
  "#4d7c0f",
  "#b45309",
  "#e11d48",
  "#475569",
  "#6d28d9",
  "#047857",
  "#0369a1",
  "#db2777",
  "#6b8e23",
  "#9f1239"
];
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export function hasSupabaseConfig(): boolean {
  return Boolean(supabaseUrl && supabaseAnonKey);
}

export function createSupabaseGameAdapter(): GameAdapter {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Supabase environment variables are missing.");
  }

  return new SupabaseGameAdapter(createClient(supabaseUrl, supabaseAnonKey));
}

class SupabaseGameAdapter implements GameAdapter {
  isDemoMode = false;

  constructor(private readonly supabase: SupabaseClient) {}

  async initialize(): Promise<GameState> {
    return this.refresh();
  }

  async signIn(username: string, password: string): Promise<GameState> {
    const { error } = await this.supabase.auth.signInWithPassword({
      email: toAuthEmail(username),
      password
    });

    if (error) throw error;
    return this.refresh();
  }

  async signOut(): Promise<GameState> {
    await this.supabase.auth.signOut();
    return this.refresh();
  }

  async refresh(): Promise<GameState> {
    const {
      data: { user }
    } = await this.supabase.auth.getUser();

    if (!user) {
      return {
        profile: null,
        pins: [],
        leaderboard: [],
        isDemoMode: false
      };
    }

    await this.supabase.rpc("settle_player_income");

    const [profile, pins, leaderboard] = await Promise.all([
      this.fetchProfile(user.id),
      this.fetchPins(),
      this.fetchLeaderboard()
    ]);

    return {
      profile,
      pins,
      leaderboard,
      isDemoMode: false
    };
  }

  async placePin(input: PlacePinInput): Promise<GameState> {
    const { error } = await this.supabase.rpc("place_pin", {
      p_lat: input.lat,
      p_lng: input.lng,
      p_name: input.name,
      p_pin_type: input.pinType,
      p_accuracy_m: input.accuracy
    });

    if (error) throw error;
    return this.refresh();
  }

  async restockPin(input: RestockPinInput): Promise<GameState> {
    const { error } = await this.supabase.rpc("restock_pin", {
      p_pin_id: input.pinId,
      p_lat: input.lat,
      p_lng: input.lng,
      p_accuracy_m: input.accuracy
    });

    if (error) throw error;
    return this.refresh();
  }

  private async fetchProfile(userId: string): Promise<PlayerProfile | null> {
    const withColor = await this.supabase
      .from("profiles")
      .select("id, display_name, points_balance, player_color")
      .eq("id", userId)
      .single();

    if (!withColor.error) return mapProfileRow(withColor.data, userId);

    const { data, error } = await this.supabase
      .from("profiles")
      .select("id, display_name, points_balance")
      .eq("id", userId)
      .single();

    if (error) throw error;
    return mapProfileRow(data, userId);
  }

  private async fetchPins(): Promise<GamePin[]> {
    const { data, error } = await this.supabase.rpc("get_visible_pins");
    if (error) throw error;
    return (data ?? []).map(mapPinRow).filter(isVisiblePin);
  }

  private async fetchLeaderboard(): Promise<LeaderboardRow[]> {
    const { data, error } = await this.supabase.rpc("get_leaderboard");
    if (error) throw error;
    return (data ?? []).map((row: Record<string, unknown>) => ({
      playerId: String(row.player_id),
      displayName: String(row.display_name),
      playerColor: safeColor(row.player_color, String(row.player_id)),
      pointsBalance: Number(row.points_balance),
      activePins: Number(row.active_pins),
      lifetimeIncome: Number(row.lifetime_income)
    }));
  }
}

function mapPinRow(row: Record<string, unknown>): GamePin {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    ownerName: String(row.owner_name),
    ownerColor: safeColor(row.owner_color, String(row.owner_id)),
    name: String(row.name),
    pinType: row.pin_type as GamePin["pinType"],
    lat: Number(row.lat),
    lng: Number(row.lng),
    busyScore: Number(row.busy_score),
    busyLabel: row.busy_label as GamePin["busyLabel"],
    placedAt: String(row.placed_at),
    visibleAt: String(row.visible_at),
    lastRestockedAt: row.last_restocked_at ? String(row.last_restocked_at) : null,
    restockDueAt: row.restock_due_at ? String(row.restock_due_at) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    status: row.status as GamePin["status"],
    currentHourlyRate: Number(row.current_hourly_rate),
    competitionPressure: Number(row.competition_pressure)
  };
}

function isVisiblePin(pin: GamePin): boolean {
  return !(pin.pinType === "temporary" && pin.status === "expired");
}

function mapProfileRow(row: Record<string, unknown>, fallbackKey: string): PlayerProfile {
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    pointsBalance: Number(row.points_balance),
    playerColor: safeColor(row.player_color, fallbackKey)
  };
}

function toAuthEmail(usernameOrEmail: string): string {
  const trimmed = usernameOrEmail.trim().toLowerCase();
  if (!trimmed) throw new Error("Enter a username.");
  if (trimmed.includes("@")) return trimmed;

  const username = trimmed
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!username) throw new Error("Enter a username using letters or numbers.");
  return `${username}@${MANUAL_ACCOUNT_DOMAIN}`;
}

function safeColor(value: unknown, fallbackKey: string): string {
  if (typeof value === "string" && HEX_COLOR_PATTERN.test(value)) return value;
  return colorFromId(fallbackKey);
}

function colorFromId(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return PLAYER_COLORS[hash % PLAYER_COLORS.length];
}
