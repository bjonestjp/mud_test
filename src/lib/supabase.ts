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

  async signIn(email: string, password: string): Promise<GameState> {
    const { error } = await this.supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;
    return this.refresh();
  }

  async signUp(email: string, password: string): Promise<GameState> {
    const { data, error } = await this.supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          display_name: email.split("@")[0] || "Player"
        }
      }
    });

    if (error) throw error;
    if (!data.session) {
      throw new Error("Account created, but Supabase still requires email confirmation. Confirm this user in Supabase, then sign in.");
    }

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
    const { data, error } = await this.supabase
      .from("profiles")
      .select("id, display_name, points_balance")
      .eq("id", userId)
      .single();

    if (error) throw error;
    return {
      id: data.id,
      displayName: data.display_name,
      pointsBalance: Number(data.points_balance)
    };
  }

  private async fetchPins(): Promise<GamePin[]> {
    const { data, error } = await this.supabase.rpc("get_visible_pins");
    if (error) throw error;
    return (data ?? []).map(mapPinRow);
  }

  private async fetchLeaderboard(): Promise<LeaderboardRow[]> {
    const { data, error } = await this.supabase.rpc("get_leaderboard");
    if (error) throw error;
    return (data ?? []).map((row: Record<string, unknown>) => ({
      playerId: String(row.player_id),
      displayName: String(row.display_name),
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
