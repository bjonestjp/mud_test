import { GAME_CONFIG } from "./constants";
import {
  baseHourlyRate,
  competitionPressure,
  distanceMeters,
  getBusyLabel
} from "./geo";
import type {
  GameAdapter,
  GamePin,
  GameState,
  LeaderboardRow,
  PlacePinInput,
  PlayerProfile,
  RestockPinInput
} from "../types";

const STORAGE_KEY = "coffee-pin-demo-state-v1";
const DEMO_PLAYER_ID = "player-you";

interface DemoStore {
  profile: PlayerProfile;
  pins: GamePin[];
  leaderboard: LeaderboardRow[];
  lastSettledAt: string;
}

export class DemoAdapter implements GameAdapter {
  isDemoMode = true;
  private store: DemoStore;

  constructor() {
    this.store = loadStore();
  }

  async initialize(): Promise<GameState> {
    return this.refresh();
  }

  async signIn(): Promise<GameState> {
    return this.refresh();
  }

  async signUp(): Promise<GameState> {
    return this.refresh();
  }

  async signOut(): Promise<GameState> {
    this.store = createInitialStore();
    saveStore(this.store);
    return this.refresh();
  }

  async refresh(): Promise<GameState> {
    this.settleIncome();
    this.recalculatePins();
    saveStore(this.store);
    return this.state();
  }

  async placePin(input: PlacePinInput): Promise<GameState> {
    this.settleIncome();

    if (this.store.profile.pointsBalance < GAME_CONFIG.standardPinCost) {
      throw new Error("Not enough tokens.");
    }

    const now = new Date();
    const pin: GamePin = {
      id: crypto.randomUUID(),
      ownerId: DEMO_PLAYER_ID,
      ownerName: "You",
      name: input.name.trim() || "New Shop",
      pinType: input.pinType,
      lat: input.lat,
      lng: input.lng,
      busyScore: estimateDemoBusyScore(input.lat, input.lng),
      busyLabel: "Steady",
      placedAt: now.toISOString(),
      visibleAt: now.toISOString(),
      lastRestockedAt: now.toISOString(),
      restockDueAt: addHours(now, GAME_CONFIG.standardRestockHours).toISOString(),
      expiresAt: null,
      status: "stocked",
      currentHourlyRate: 0,
      competitionPressure: 0
    };

    pin.busyLabel = getBusyLabel(pin.busyScore);
    this.store.profile.pointsBalance -= GAME_CONFIG.standardPinCost;
    this.store.pins = [pin, ...this.store.pins];
    this.recalculatePins();
    saveStore(this.store);
    return this.state();
  }

  async restockPin(input: RestockPinInput): Promise<GameState> {
    this.settleIncome();
    const pin = this.store.pins.find((item) => item.id === input.pinId);

    if (!pin) throw new Error("Pin was not found.");
    if (pin.ownerId !== DEMO_PLAYER_ID) throw new Error("This is not your pin.");

    const distance = distanceMeters(
      { lat: pin.lat, lng: pin.lng },
      { lat: input.lat, lng: input.lng }
    );

    if (distance > GAME_CONFIG.restockRadiusM) {
      throw new Error(`You are ${Math.round(distance)}m away.`);
    }

    const now = new Date();
    pin.lastRestockedAt = now.toISOString();
    pin.restockDueAt = addHours(now, GAME_CONFIG.standardRestockHours).toISOString();
    pin.status = "stocked";
    this.recalculatePins();
    saveStore(this.store);
    return this.state();
  }

  private state(): GameState {
    return {
      profile: this.store.profile,
      pins: this.store.pins,
      leaderboard: this.store.leaderboard,
      isDemoMode: true
    };
  }

  private settleIncome(): void {
    const now = new Date();
    const lastSettledAt = new Date(this.store.lastSettledAt);
    const hours = Math.max(0, (now.getTime() - lastSettledAt.getTime()) / 3_600_000);

    if (hours === 0) return;

    let earned = 0;
    for (const pin of this.store.pins) {
      refreshPinStatus(pin, now);
      if (pin.ownerId === DEMO_PLAYER_ID && pin.status === "stocked") {
        earned += pin.currentHourlyRate * hours;
      }
    }

    this.store.profile.pointsBalance += earned;
    this.store.lastSettledAt = now.toISOString();
    this.store.leaderboard = buildLeaderboard(this.store);
  }

  private recalculatePins(): void {
    const now = new Date();
    for (const pin of this.store.pins) {
      refreshPinStatus(pin, now);
    }

    for (const pin of this.store.pins) {
      if (pin.status !== "stocked") {
        pin.currentHourlyRate = 0;
        pin.competitionPressure = 0;
        continue;
      }

      const totalPressure = this.store.pins.reduce((sum, other) => {
        if (other.id === pin.id || other.status !== "stocked") return sum;
        const distance = distanceMeters(pin, other);
        return sum + competitionPressure(distance, GAME_CONFIG.competitionRadiusM);
      }, 0);

      pin.competitionPressure = Number(totalPressure.toFixed(3));
      pin.currentHourlyRate = Number(
        (baseHourlyRate(pin.busyScore) / (1 + totalPressure)).toFixed(2)
      );
    }

    this.store.leaderboard = buildLeaderboard(this.store);
  }
}

function loadStore(): DemoStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialStore();
    return normalizeStore(JSON.parse(raw) as Partial<DemoStore>);
  } catch {
    return createInitialStore();
  }
}

function saveStore(store: DemoStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Demo mode should keep working even when storage is unavailable.
  }
}

function createInitialStore(): DemoStore {
  const now = new Date();
  const pins: GamePin[] = [
    createDemoPin("pin-princes", "player-anya", "Castle View Cart", 55.9526, -3.2008, 92, "Anya"),
    createDemoPin("pin-meadows", "player-you", "Meadows Kiosk", 55.9404, -3.1909, 68, "You"),
    createDemoPin("pin-leith", "player-nico", "Leith Walk Window", 55.9642, -3.1761, 74, "Nico"),
    createDemoPin("pin-stockbridge", "player-sam", "Stockbridge Steam", 55.9581, -3.2076, 61, "Sam")
  ];

  const store: DemoStore = {
    profile: {
      id: DEMO_PLAYER_ID,
      displayName: "You",
      pointsBalance: GAME_CONFIG.startingPoints
    },
    pins,
    leaderboard: [],
    lastSettledAt: now.toISOString()
  };

  store.leaderboard = buildLeaderboard(store);
  return store;
}

function normalizeStore(candidate: Partial<DemoStore>): DemoStore {
  const fallback = createInitialStore();
  const profile = candidate.profile;
  const pins = Array.isArray(candidate.pins) ? candidate.pins : fallback.pins;

  if (!profile || typeof profile.id !== "string") {
    return fallback;
  }

  const store: DemoStore = {
    profile: {
      id: profile.id,
      displayName: profile.displayName || "You",
      pointsBalance: Number.isFinite(profile.pointsBalance)
        ? Number(profile.pointsBalance)
        : GAME_CONFIG.startingPoints
    },
    pins: pins.map((pin, index) => normalizePin(pin ?? undefined, fallback.pins[index])),
    leaderboard: [],
    lastSettledAt: candidate.lastSettledAt || new Date().toISOString()
  };

  store.leaderboard = buildLeaderboard(store);
  return store;
}

function normalizePin(pin: Partial<GamePin> | undefined, fallback?: GamePin): GamePin {
  const safeFallback =
    fallback ??
    createDemoPin(
      crypto.randomUUID(),
      DEMO_PLAYER_ID,
      "Recovered Shop",
      55.9533,
      -3.1883,
      55,
      "You"
    );

  const busyScore = Number.isFinite(pin?.busyScore)
    ? Math.max(0, Math.min(100, Number(pin?.busyScore)))
    : safeFallback.busyScore;

  return {
    id: pin?.id || safeFallback.id,
    ownerId: pin?.ownerId || safeFallback.ownerId,
    ownerName: pin?.ownerName || safeFallback.ownerName,
    name: pin?.name || safeFallback.name,
    pinType: pin?.pinType === "temporary" ? "temporary" : "standard",
    lat: Number.isFinite(pin?.lat) ? Number(pin?.lat) : safeFallback.lat,
    lng: Number.isFinite(pin?.lng) ? Number(pin?.lng) : safeFallback.lng,
    busyScore,
    busyLabel: pin?.busyLabel || getBusyLabel(busyScore),
    placedAt: pin?.placedAt || safeFallback.placedAt,
    visibleAt: pin?.visibleAt || safeFallback.visibleAt,
    lastRestockedAt: pin?.lastRestockedAt ?? safeFallback.lastRestockedAt,
    restockDueAt: pin?.restockDueAt ?? safeFallback.restockDueAt,
    expiresAt: pin?.expiresAt ?? safeFallback.expiresAt,
    status: pin?.status || safeFallback.status,
    currentHourlyRate: Number.isFinite(pin?.currentHourlyRate)
      ? Number(pin?.currentHourlyRate)
      : 0,
    competitionPressure: Number.isFinite(pin?.competitionPressure)
      ? Number(pin?.competitionPressure)
      : 0
  };
}

function createDemoPin(
  id: string,
  ownerId: string,
  name: string,
  lat: number,
  lng: number,
  busyScore: number,
  ownerName: string
): GamePin {
  const now = new Date();
  return {
    id,
    ownerId,
    ownerName,
    name,
    pinType: "standard",
    lat,
    lng,
    busyScore,
    busyLabel: getBusyLabel(busyScore),
    placedAt: now.toISOString(),
    visibleAt: now.toISOString(),
    lastRestockedAt: now.toISOString(),
    restockDueAt: addHours(now, GAME_CONFIG.standardRestockHours).toISOString(),
    expiresAt: null,
    status: "stocked",
    currentHourlyRate: 0,
    competitionPressure: 0
  };
}

function refreshPinStatus(pin: GamePin, now: Date): void {
  if (pin.pinType === "temporary" && pin.expiresAt && new Date(pin.expiresAt) <= now) {
    pin.status = "expired";
    return;
  }

  if (pin.restockDueAt && new Date(pin.restockDueAt) <= now) {
    pin.status = "needs_restock";
    return;
  }

  pin.status = "stocked";
}

function buildLeaderboard(store: DemoStore): LeaderboardRow[] {
  const players = new Map<string, LeaderboardRow>();
  const ensure = (playerId: string, displayName: string) => {
    if (!players.has(playerId)) {
      players.set(playerId, {
        playerId,
        displayName,
        pointsBalance: playerId === DEMO_PLAYER_ID ? store.profile.pointsBalance : 160 + players.size * 47,
        activePins: 0,
        lifetimeIncome: playerId === DEMO_PLAYER_ID ? Math.max(0, store.profile.pointsBalance - GAME_CONFIG.startingPoints) : 90 + players.size * 26
      });
    }
    return players.get(playerId)!;
  };

  ensure(store.profile.id, store.profile.displayName);
  for (const pin of store.pins) {
    const row = ensure(pin.ownerId, pin.ownerName);
    if (pin.status === "stocked") row.activePins += 1;
  }

  return [...players.values()].sort((a, b) => b.pointsBalance - a.pointsBalance);
}

function estimateDemoBusyScore(lat: number, lng: number): number {
  const cityHotspots = [
    { lat: 55.9533, lng: -3.1883, weight: 95 },
    { lat: 55.9486, lng: -3.1989, weight: 82 },
    { lat: 55.9642, lng: -3.1761, weight: 76 },
    { lat: 55.9436, lng: -3.1887, weight: 66 }
  ];

  const best = cityHotspots.reduce((score, hotspot) => {
    const distance = distanceMeters({ lat, lng }, hotspot);
    const weighted = hotspot.weight * Math.max(0.15, 1 - distance / 2500);
    return Math.max(score, weighted);
  }, 24);

  return Math.round(Math.max(12, Math.min(98, best)));
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}
