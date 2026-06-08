import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_SHOP_LEVEL_BONUS_POINTS,
  DEFAULT_SHOP_LEVEL_THRESHOLDS_POINTS,
  competitionRadiusForLevel
} from "./constants";
import {
  baseHourlyRate,
  competitionPressure,
  distanceMeters,
  getBusyLabel
} from "./geo";
import type {
  BeginDemandEventInput,
  Bulletin,
  CreateBulletinInput,
  DeleteBulletinInput,
  DeletePinInput,
  DeleteWarehouseInput,
  DemandEvent,
  EndDemandEventInput,
  ExportPlacePinInput,
  ExportRestockPinInput,
  GameAdapter,
  GamePin,
  GameState,
  HomeBase,
  LeaderboardRow,
  PlacePinInput,
  PlaceWarehouseInput,
  PlayerProfile,
  RestockPinInput,
  RestockWarehouseInput,
  ScoreHistoryPoint,
  ShopLevelConfig,
  UpdateBulletinInput,
  UpdateHomeBaseInput,
  UpdateShopLevelConfigInput,
  Warehouse
} from "../types";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const MANUAL_ACCOUNT_DOMAIN = "players.mudslingers.test";
const BULLETIN_IMAGE_BUCKET = "bulletin-images";
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
const DEFAULT_SHOP_LEVEL_CONFIG: ShopLevelConfig = {
  thresholdsPoints: DEFAULT_SHOP_LEVEL_THRESHOLDS_POINTS,
  bonusPointsPerLevel: DEFAULT_SHOP_LEVEL_BONUS_POINTS
};

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
        scoreHistory: [],
        bulletins: [],
        demandEvents: [],
        warehouses: [],
        homeBase: null,
        shopLevelConfig: DEFAULT_SHOP_LEVEL_CONFIG,
        isDemoMode: false
      };
    }

    await this.supabase.rpc("settle_player_income");

    const [profile, pins, leaderboard, bulletins, demandEvents, warehouses, homeBase, shopLevelConfig] = await Promise.all([
      this.fetchProfile(user.id),
      this.fetchPins(),
      this.fetchLeaderboard(),
      this.fetchBulletins(),
      this.fetchDemandEvents(),
      this.fetchWarehouses(),
      this.fetchHomeBase(),
      this.fetchShopLevelConfig()
    ]);
    const scoreHistory = await this.fetchScoreHistory(leaderboard);

    return {
      profile,
      pins,
      leaderboard,
      scoreHistory,
      bulletins,
      demandEvents,
      warehouses,
      homeBase,
      shopLevelConfig,
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

  async upgradePinRadius(input: { pinId: string }): Promise<GameState> {
    const { error } = await this.supabase.rpc("upgrade_pin_radius", {
      p_pin_id: input.pinId
    });

    if (error) throw error;
    return this.refresh();
  }

  async createBulletin(input: CreateBulletinInput): Promise<GameState> {
    const imagePath = await this.uploadBulletinImage(input.imageFile);

    const { error } = await this.supabase.rpc("create_bulletin", {
      p_title: input.title,
      p_body: input.body,
      p_image_path: imagePath
    });

    if (error) {
      await this.supabase.storage.from(BULLETIN_IMAGE_BUCKET).remove([imagePath]);
      throw error;
    }

    return this.refresh();
  }

  async updateBulletin(input: UpdateBulletinInput): Promise<GameState> {
    const nextImagePath = input.imageFile
      ? await this.uploadBulletinImage(input.imageFile)
      : null;

    const { data, error } = await this.supabase.rpc("update_bulletin", {
      p_bulletin_id: input.bulletinId,
      p_title: input.title,
      p_body: input.body,
      p_image_path: nextImagePath
    });

    if (error) {
      if (nextImagePath) await this.removeBulletinImages([nextImagePath]);
      throw error;
    }

    if (nextImagePath) {
      const previousImagePath = getRpcStringField(data, "previous_image_path");
      if (previousImagePath && previousImagePath !== nextImagePath) {
        await this.removeBulletinImages([previousImagePath]);
      }
    }

    return this.refresh();
  }

  async deleteBulletin(input: DeleteBulletinInput): Promise<GameState> {
    const { data, error } = await this.supabase.rpc("delete_bulletin", {
      p_bulletin_id: input.bulletinId
    });

    if (error) throw error;

    if (typeof data === "string") {
      await this.removeBulletinImages([data]);
    }

    return this.refresh();
  }

  async deletePin(input: DeletePinInput): Promise<GameState> {
    const { error } = await this.supabase.rpc("delete_pin", {
      p_pin_id: input.pinId
    });

    if (error) throw error;
    return this.refresh();
  }

  async deleteWarehouse(input: DeleteWarehouseInput): Promise<GameState> {
    const { error } = await this.supabase.rpc("delete_warehouse", {
      p_warehouse_id: input.warehouseId
    });

    if (error) throw error;
    return this.refresh();
  }

  async beginDemandEvent(input: BeginDemandEventInput): Promise<GameState> {
    const { error } = await this.supabase.rpc("begin_demand_event", {
      p_lat: input.lat,
      p_lng: input.lng,
      p_radius_m: input.radiusM,
      p_duration_hours: input.durationHours
    });

    if (error) throw error;
    return this.refresh();
  }

  async endDemandEvent(input: EndDemandEventInput): Promise<GameState> {
    const { error } = await this.supabase.rpc("end_demand_event", {
      p_event_id: input.eventId
    });

    if (error) throw error;
    return this.refresh();
  }

  async updateShopLevelConfig(input: UpdateShopLevelConfigInput): Promise<GameState> {
    const { error } = await this.supabase.rpc("update_shop_level_config", {
      p_thresholds_points: input.thresholdsPoints
    });

    if (error) throw error;
    return this.refresh();
  }

  async placeWarehouse(input: PlaceWarehouseInput): Promise<GameState> {
    const { error } = await this.supabase.rpc("place_warehouse", {
      p_lat: input.lat,
      p_lng: input.lng,
      p_name: input.name,
      p_tier: input.tier,
      p_accuracy_m: input.accuracy
    });

    if (error) throw error;
    return this.refresh();
  }

  async restockWarehouse(input: RestockWarehouseInput): Promise<GameState> {
    const { error } = await this.supabase.rpc("restock_warehouse", {
      p_warehouse_id: input.warehouseId,
      p_lat: input.lat,
      p_lng: input.lng,
      p_accuracy_m: input.accuracy
    });

    if (error) throw error;
    return this.refresh();
  }

  async exportPlacePin(input: ExportPlacePinInput): Promise<GameState> {
    const { error } = await this.supabase.rpc("export_place_pin", {
      p_warehouse_id: input.warehouseId,
      p_lat: input.lat,
      p_lng: input.lng,
      p_name: input.name,
      p_pin_type: input.pinType
    });

    if (error) throw error;
    return this.refresh();
  }

  async exportRestockPin(input: ExportRestockPinInput): Promise<GameState> {
    const { error } = await this.supabase.rpc("export_restock_pin", {
      p_warehouse_id: input.warehouseId,
      p_pin_id: input.pinId
    });

    if (error) throw error;
    return this.refresh();
  }

  async updateHomeBase(input: UpdateHomeBaseInput): Promise<GameState> {
    const { error } = await this.supabase.rpc("update_home_base", {
      p_lat: input.lat,
      p_lng: input.lng
    });

    if (error) throw error;
    return this.refresh();
  }

  private async fetchProfile(userId: string): Promise<PlayerProfile | null> {
    const withMode = await this.supabase
      .from("profiles")
      .select("id, display_name, points_balance, player_color, account_role, player_mode")
      .eq("id", userId)
      .single();

    if (!withMode.error) return mapProfileRow(withMode.data, userId);

    const withRole = await this.supabase
      .from("profiles")
      .select("id, display_name, points_balance, player_color, account_role")
      .eq("id", userId)
      .single();

    if (!withRole.error) return mapProfileRow(withRole.data, userId);

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

    const rows = (data ?? []) as Record<string, unknown>[];
    const malformedRows = rows.filter((row) => !isPinRpcRow(row));
    if (malformedRows.length > 0) {
      return this.fetchPinsDirectly();
    }

    return rows.map(mapPinRow).filter(isVisiblePin);
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

  private async fetchScoreHistory(leaderboard: LeaderboardRow[]): Promise<ScoreHistoryPoint[]> {
    const { data, error } = await this.supabase.rpc("get_score_history");

    if (error) {
      const message = error.message ?? "";
      if (error.code === "PGRST202" || message.includes("get_score_history")) {
        return currentScoreHistoryFromLeaderboard(leaderboard);
      }
      throw error;
    }

    const rows = (data ?? []) as Record<string, unknown>[];
    if (
      rows.length > 0 &&
      rows.every((row) => !("lifetime_income" in row) && !("active_pins" in row))
    ) {
      return currentScoreHistoryFromLeaderboard(leaderboard);
    }

    const history = rows.map(mapScoreHistoryRow);
    return history.length > 0 ? history : currentScoreHistoryFromLeaderboard(leaderboard);
  }

  private async fetchBulletins(): Promise<Bulletin[]> {
    const { data, error } = await this.supabase.rpc("get_bulletins");

    if (error) {
      const message = error.message ?? "";
      if (error.code === "PGRST202" || message.includes("get_bulletins")) {
        return [];
      }
      throw error;
    }

    return (data ?? []).map((row: Record<string, unknown>) =>
      mapBulletinRow(row, this.publicBulletinImageUrl(String(row.image_path)))
    );
  }

  private async fetchDemandEvents(): Promise<DemandEvent[]> {
    const { data, error } = await this.supabase.rpc("get_demand_events");

    if (error) {
      const message = error.message ?? "";
      if (error.code === "PGRST202" || message.includes("get_demand_events")) {
        return [];
      }
      throw error;
    }

    return (data ?? []).map(mapDemandEventRow).filter(isActiveDemandEvent);
  }

  private async fetchWarehouses(): Promise<Warehouse[]> {
    const { data, error } = await this.supabase.rpc("get_visible_warehouses");

    if (error) {
      const message = error.message ?? "";
      if (error.code === "PGRST202" || message.includes("get_visible_warehouses")) {
        return [];
      }
      throw error;
    }

    return (data ?? []).map(mapWarehouseRow).filter(hasWarehouseCoordinate);
  }

  private async fetchHomeBase(): Promise<HomeBase | null> {
    const { data, error } = await this.supabase.rpc("get_home_base");

    if (error) {
      const message = error.message ?? "";
      if (error.code === "PGRST202" || message.includes("get_home_base")) {
        return null;
      }
      throw error;
    }

    return mapHomeBase(data);
  }

  private async fetchShopLevelConfig(): Promise<ShopLevelConfig> {
    const { data, error } = await this.supabase.rpc("get_shop_level_config");

    if (error) {
      const message = error.message ?? "";
      if (error.code === "PGRST202" || message.includes("get_shop_level_config")) {
        return DEFAULT_SHOP_LEVEL_CONFIG;
      }
      throw error;
    }

    return normalizeShopLevelConfig(data);
  }

  private async uploadBulletinImage(file: File): Promise<string> {
    const {
      data: { user }
    } = await this.supabase.auth.getUser();

    if (!user) throw new Error("You must be signed in.");

    const path = `${user.id}/${Date.now()}-${crypto.randomUUID()}-${safeStorageFileName(file.name)}`;
    const { error } = await this.supabase.storage
      .from(BULLETIN_IMAGE_BUCKET)
      .upload(path, file, {
        cacheControl: "3600",
        contentType: file.type || "image/jpeg",
        upsert: false
      });

    if (error) throw error;
    return path;
  }

  private publicBulletinImageUrl(path: string): string {
    const { data } = this.supabase.storage.from(BULLETIN_IMAGE_BUCKET).getPublicUrl(path);
    return data.publicUrl;
  }

  private async removeBulletinImages(paths: string[]): Promise<void> {
    const cleanPaths = paths.filter(Boolean);
    if (cleanPaths.length === 0) return;

    await this.supabase.storage.from(BULLETIN_IMAGE_BUCKET).remove(cleanPaths);
  }

  private async fetchPinsDirectly(): Promise<GamePin[]> {
    const { data, error } = await this.supabase
      .from("pins")
      .select(`
        id,
        owner_id,
        name,
        pin_type,
        radius_level,
        lat,
        lng,
        busy_score,
        placed_at,
        visible_at,
        last_restocked_at,
        restock_due_at,
        expires_at,
        disabled_at,
        profiles!pins_owner_id_fkey(display_name, player_color)
      `)
      .lte("visible_at", new Date().toISOString())
      .order("placed_at", { ascending: false });

    if (error) throw error;
    return calculateFallbackPinRates(
      ((data ?? []) as Record<string, unknown>[])
        .map(mapDirectPinRow)
        .filter(isVisiblePin)
    );
  }
}

function isPinRpcRow(row: Record<string, unknown>): boolean {
  return (
    typeof row.owner_id === "string" &&
    Number.isFinite(Number(row.lat)) &&
    Number.isFinite(Number(row.lng))
  );
}

function mapPinRow(row: Record<string, unknown>): GamePin {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    ownerName: String(row.owner_name),
    ownerColor: safeColor(row.owner_color, String(row.owner_id)),
    name: String(row.name),
    pinType: row.pin_type as GamePin["pinType"],
    radiusLevel: normalizeRadiusLevel(row.radius_level),
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
    competitionPressure: Number(row.competition_pressure),
    lifetimeIncome: safeNumber(row.lifetime_income_points, 0)
  };
}

function mapDirectPinRow(row: Record<string, unknown>): GamePin {
  const profile = getRelatedProfile(row.profiles);
  const busyScore = Number(row.busy_score);

  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    ownerName: String(profile.display_name ?? "Player"),
    ownerColor: safeColor(profile.player_color, String(row.owner_id)),
    name: String(row.name),
    pinType: row.pin_type as GamePin["pinType"],
    radiusLevel: normalizeRadiusLevel(row.radius_level),
    lat: Number(row.lat),
    lng: Number(row.lng),
    busyScore,
    busyLabel: getBusyLabel(busyScore),
    placedAt: String(row.placed_at),
    visibleAt: String(row.visible_at),
    lastRestockedAt: row.last_restocked_at ? String(row.last_restocked_at) : null,
    restockDueAt: row.restock_due_at ? String(row.restock_due_at) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    status: getDirectPinStatus(row),
    currentHourlyRate: 0,
    competitionPressure: 0,
    lifetimeIncome: 0
  };
}

function getRelatedProfile(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return (value[0] ?? {}) as Record<string, unknown>;
  if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  return {};
}

function getDirectPinStatus(row: Record<string, unknown>): GamePin["status"] {
  if (row.disabled_at) return "disabled";

  const pinType = row.pin_type as GamePin["pinType"];
  const expiresAt = row.expires_at ? new Date(String(row.expires_at)).getTime() : null;
  const restockDueAt = row.restock_due_at ? new Date(String(row.restock_due_at)).getTime() : null;
  const now = Date.now();

  if (pinType === "temporary" && expiresAt !== null && expiresAt <= now) return "expired";
  if (pinType === "standard" && restockDueAt !== null && restockDueAt <= now) return "needs_restock";
  return "stocked";
}

function calculateFallbackPinRates(pins: GamePin[]): GamePin[] {
  return pins.map((pin) => {
    if (pin.status !== "stocked") {
      return {
        ...pin,
        currentHourlyRate: 0,
        competitionPressure: 0
      };
    }

    const totalPressure = pins.reduce((sum, other) => {
      if (other.id === pin.id || other.status !== "stocked") return sum;
      const distance = distanceMeters(pin, other);
      return sum + competitionPressure(distance, competitionRadiusForLevel(other.radiusLevel));
    }, 0);

    return {
      ...pin,
      competitionPressure: Number(totalPressure.toFixed(3)),
      currentHourlyRate: Number(
        (baseHourlyRate(pin.busyScore) / (1 + totalPressure)).toFixed(2)
      )
    };
  });
}

function isVisiblePin(pin: GamePin): boolean {
  return pin.status !== "disabled" && !(pin.pinType === "temporary" && pin.status === "expired");
}

function mapProfileRow(row: Record<string, unknown>, fallbackKey: string): PlayerProfile {
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    pointsBalance: Number(row.points_balance),
    playerColor: safeColor(row.player_color, fallbackKey),
    isAdmin: row.account_role === "admin",
    playerMode: row.player_mode === "export" ? "export" : "local"
  };
}

function mapBulletinRow(row: Record<string, unknown>, imageUrl: string): Bulletin {
  return {
    id: String(row.id),
    title: String(row.title),
    body: String(row.body),
    imagePath: String(row.image_path),
    imageUrl,
    authorId: String(row.author_id),
    authorName: String(row.author_name),
    publishedAt: String(row.published_at)
  };
}

function mapDemandEventRow(row: Record<string, unknown>): DemandEvent {
  return {
    id: String(row.id),
    label: String(row.label || "double demand zone"),
    lat: Number(row.lat),
    lng: Number(row.lng),
    radiusM: Number(row.radius_m),
    multiplier: Number(row.multiplier),
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
    endedAt: row.ended_at ? String(row.ended_at) : null
  };
}

function mapWarehouseRow(row: Record<string, unknown>): Warehouse {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    ownerName: String(row.owner_name),
    ownerColor: safeColor(row.owner_color, String(row.owner_id)),
    name: String(row.name),
    tier: row.tier === "medium" || row.tier === "large" ? row.tier : "small",
    radiusM: safeNumber(row.radius_m, 100),
    lat: Number(row.lat),
    lng: Number(row.lng),
    placedAt: String(row.placed_at),
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    availableAt: row.available_at ? String(row.available_at) : null,
    creditAvailable: Boolean(row.credit_available),
    status: row.status === "cooldown" || row.status === "empty" ? row.status : "available"
  };
}

function hasWarehouseCoordinate(warehouse: Warehouse): boolean {
  return (
    Number.isFinite(warehouse.lat) &&
    Number.isFinite(warehouse.lng) &&
    Math.abs(warehouse.lat) <= 90 &&
    Math.abs(warehouse.lng) <= 180
  );
}

function mapHomeBase(value: unknown): HomeBase | null {
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  const lat = Number(record.lat);
  const lng = Number(record.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    lat,
    lng,
    updatedAt: record.updated_at ? String(record.updated_at) : null
  };
}

function normalizeShopLevelConfig(value: unknown): ShopLevelConfig {
  if (typeof value !== "object" || value === null) return DEFAULT_SHOP_LEVEL_CONFIG;

  const record = value as Record<string, unknown>;
  const rawThresholds = Array.isArray(record.thresholds_points)
    ? record.thresholds_points
    : Array.isArray(record.thresholdsPoints)
      ? record.thresholdsPoints
      : DEFAULT_SHOP_LEVEL_THRESHOLDS_POINTS;
  const thresholdsPoints = rawThresholds
    .map((threshold) => Number(threshold))
    .filter((threshold) => Number.isFinite(threshold) && threshold > 0)
    .slice(0, 5);
  const bonusPointsPerLevel = safeNumber(
    record.bonus_points_per_level ?? record.bonusPointsPerLevel,
    DEFAULT_SHOP_LEVEL_BONUS_POINTS
  );

  return {
    thresholdsPoints: thresholdsPoints.length === 5
      ? thresholdsPoints
      : DEFAULT_SHOP_LEVEL_THRESHOLDS_POINTS,
    bonusPointsPerLevel: bonusPointsPerLevel > 0
      ? bonusPointsPerLevel
      : DEFAULT_SHOP_LEVEL_BONUS_POINTS
  };
}

function isActiveDemandEvent(event: DemandEvent): boolean {
  const endsAt = new Date(event.endsAt).getTime();

  return (
    Number.isFinite(event.lat) &&
    Number.isFinite(event.lng) &&
    Number.isFinite(event.radiusM) &&
    Number.isFinite(event.multiplier) &&
    Math.abs(event.lat) <= 90 &&
    Math.abs(event.lng) <= 180 &&
    event.radiusM > 0 &&
    event.multiplier > 1 &&
    !event.endedAt &&
    Number.isFinite(endsAt) &&
    endsAt > Date.now()
  );
}

function safeNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getRpcStringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : null;
}

function mapScoreHistoryRow(row: Record<string, unknown>): ScoreHistoryPoint {
  return {
    playerId: String(row.player_id),
    displayName: String(row.display_name),
    playerColor: safeColor(row.player_color, String(row.player_id)),
    pointsBalance: Number(row.points_balance),
    lifetimeIncome: safeNumber(row.lifetime_income, 0),
    activePins: Math.max(0, Math.floor(safeNumber(row.active_pins, 0))),
    recordedAt: String(row.recorded_at)
  };
}

function currentScoreHistoryFromLeaderboard(leaderboard: LeaderboardRow[]): ScoreHistoryPoint[] {
  const now = new Date().toISOString();
  return leaderboard.map((row) => ({
    playerId: row.playerId,
    displayName: row.displayName,
    playerColor: row.playerColor,
    pointsBalance: row.pointsBalance,
    lifetimeIncome: row.lifetimeIncome,
    activePins: row.activePins,
    recordedAt: now
  }));
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

function safeStorageFileName(fileName: string): string {
  const safe = fileName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return safe || "bulletin-image.jpg";
}

function safeColor(value: unknown, fallbackKey: string): string {
  if (typeof value === "string" && HEX_COLOR_PATTERN.test(value)) return value;
  return colorFromId(fallbackKey);
}

function normalizeRadiusLevel(value: unknown): number {
  const level = Math.floor(Number(value) || 0);
  return Math.max(0, level);
}

function colorFromId(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return PLAYER_COLORS[hash % PLAYER_COLORS.length];
}
