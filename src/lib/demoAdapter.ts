import {
  DEFAULT_SHOP_LEVEL_BONUS_POINTS,
  DEFAULT_SHOP_LEVEL_THRESHOLDS_POINTS,
  competitionRadiusForLevel,
  GAME_CONFIG
} from "./constants";
import {
  baseHourlyRate,
  competitionPressure,
  distanceMeters,
  getBusyLabel,
  projectPointBetweenHomeBases
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
  ExportPlayerHome,
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
  RenamePinInput,
  RestockPinInput,
  RestockWarehouseInput,
  ScoreHistoryPoint,
  ShopLevelConfig,
  UpdateBulletinInput,
  UpdateExportHomeBaseInput,
  UpdateHomeBaseInput,
  UpdateShopLevelConfigInput,
  Warehouse
} from "../types";

const STORAGE_KEY = "coffee-pin-demo-state-v1";
const DEMO_PLAYER_ID = "player-you";
const DEMO_PLAYER_COLORS: Record<string, string> = {
  "player-you": "#21745c",
  "player-anya": "#ba3c3a",
  "player-nico": "#2f5f9f",
  "player-sam": "#8a5b20"
};
const FALLBACK_PLAYER_COLORS = [
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
const DEMO_BULLETIN_IMAGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 520'%3E%3Crect width='1200' height='520' fill='%2321745c'/%3E%3Cpath d='M0 390 C180 330 280 450 430 390 C560 338 690 318 840 372 C1010 432 1100 350 1200 302 L1200 520 L0 520 Z' fill='%23f4f1e8' opacity='.96'/%3E%3Ccircle cx='938' cy='156' r='78' fill='%23f0ae49'/%3E%3Crect x='130' y='146' width='388' height='210' rx='24' fill='%23ffffff' opacity='.94'/%3E%3Crect x='170' y='184' width='184' height='26' rx='13' fill='%2321745c'/%3E%3Crect x='170' y='236' width='280' height='18' rx='9' fill='%2369736f' opacity='.55'/%3E%3Crect x='170' y='276' width='236' height='18' rx='9' fill='%2369736f' opacity='.45'/%3E%3C/svg%3E";
const DEFAULT_SHOP_LEVEL_CONFIG: ShopLevelConfig = {
  thresholdsPoints: DEFAULT_SHOP_LEVEL_THRESHOLDS_POINTS,
  bonusPointsPerLevel: DEFAULT_SHOP_LEVEL_BONUS_POINTS
};

interface DemoStore {
  profile: PlayerProfile;
  pins: GamePin[];
  leaderboard: LeaderboardRow[];
  bulletins: Bulletin[];
  demandEvents: DemandEvent[];
  warehouses: DemoWarehouse[];
  homeBase: HomeBase | null;
  exportPlayers: ExportPlayerHome[];
  shopLevelConfig: ShopLevelConfig;
  lastSettledAt: string;
}

interface DemoWarehouse extends Warehouse {
  disabledAt: string | null;
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

  async signIn(_username = "", _password = ""): Promise<GameState> {
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
    const cost = getPinCost(input.pinType);

    if (this.store.profile.playerMode === "export") {
      throw new Error("Export players must build through export placement.");
    }
    if (this.store.profile.pointsBalance < cost) {
      throw new Error("Not enough tokens.");
    }

    const now = new Date();
    const pin: GamePin = {
      id: crypto.randomUUID(),
      ownerId: DEMO_PLAYER_ID,
      ownerName: "You",
      ownerColor: this.store.profile.playerColor,
      name: input.name.trim() || "New Shop",
      pinType: input.pinType,
      radiusLevel: 0,
      lat: input.lat,
      lng: input.lng,
      physicalLat: null,
      physicalLng: null,
      busyScore: estimateDemoBusyScore(input.lat, input.lng),
      busyLabel: "Steady",
      placedAt: now.toISOString(),
      visibleAt: now.toISOString(),
      lastRestockedAt: input.pinType === "standard" ? now.toISOString() : null,
      restockDueAt: input.pinType === "standard"
        ? addHours(now, GAME_CONFIG.standardRestockHours).toISOString()
        : null,
      expiresAt: input.pinType === "temporary"
        ? addHours(now, GAME_CONFIG.temporaryExpiryHours).toISOString()
        : null,
      status: "stocked",
      currentHourlyRate: 0,
      competitionPressure: 0,
      lifetimeIncome: 0
    };

    pin.busyLabel = getBusyLabel(pin.busyScore);
    this.store.profile.pointsBalance -= cost;
    this.store.pins = [pin, ...this.store.pins];
    this.recalculatePins();
    saveStore(this.store);
    return this.state();
  }

  async upgradePinRadius(input: { pinId: string }): Promise<GameState> {
    this.settleIncome();
    const pin = this.store.pins.find((item) => item.id === input.pinId);

    if (!pin) throw new Error("Pin was not found.");
    if (pin.ownerId !== DEMO_PLAYER_ID) throw new Error("This is not your pin.");
    if (pin.radiusLevel >= GAME_CONFIG.radiusUpgradeMaxLevel) {
      throw new Error("This shop's radius is already fully upgraded.");
    }
    if (this.store.profile.pointsBalance < GAME_CONFIG.radiusUpgradeCost) {
      throw new Error("Not enough tokens.");
    }

    this.store.profile.pointsBalance -= GAME_CONFIG.radiusUpgradeCost;
    pin.radiusLevel += 1;
    this.recalculatePins();
    saveStore(this.store);
    return this.state();
  }

  async renamePin(input: RenamePinInput): Promise<GameState> {
    this.settleIncome();
    const pin = this.store.pins.find((item) => item.id === input.pinId);
    const nextName = input.name.trim();

    if (!pin) throw new Error("Shop was not found.");
    if (pin.ownerId !== DEMO_PLAYER_ID) throw new Error("You can only rename your own shops.");
    if (!nextName) throw new Error("Add a shop name.");
    if (pin.name === nextName) throw new Error("Choose a new shop name.");
    if (this.store.profile.pointsBalance < GAME_CONFIG.renameCost) {
      throw new Error("Not enough tokens.");
    }

    this.store.profile.pointsBalance -= GAME_CONFIG.renameCost;
    pin.name = nextName.slice(0, 80);
    saveStore(this.store);
    return this.state();
  }

  async createBulletin(input: CreateBulletinInput): Promise<GameState> {
    if (!this.store.profile.isAdmin) throw new Error("Only admins can send bulletins.");
    if (!input.title.trim()) throw new Error("Add a bulletin title.");
    if (!input.body.trim()) throw new Error("Add bulletin copy.");

    const now = new Date();
    const imageUrl = await readFileAsDataUrl(input.imageFile);
    this.store.bulletins = [
      {
        id: crypto.randomUUID(),
        title: input.title.trim(),
        body: input.body.trim(),
        imagePath: `demo/${crypto.randomUUID()}`,
        imageUrl,
        authorId: this.store.profile.id,
        authorName: this.store.profile.displayName,
        publishedAt: now.toISOString()
      },
      ...this.store.bulletins
    ];
    saveStore(this.store);
    return this.state();
  }

  async updateBulletin(input: UpdateBulletinInput): Promise<GameState> {
    if (!this.store.profile.isAdmin) throw new Error("Only admins can edit bulletins.");
    if (!input.title.trim()) throw new Error("Add a bulletin title.");
    if (!input.body.trim()) throw new Error("Add bulletin copy.");

    const bulletin = this.store.bulletins.find((item) => item.id === input.bulletinId);
    if (!bulletin) throw new Error("Bulletin was not found.");

    bulletin.title = input.title.trim();
    bulletin.body = input.body.trim();

    if (input.imageFile) {
      bulletin.imagePath = `demo/${crypto.randomUUID()}`;
      bulletin.imageUrl = await readFileAsDataUrl(input.imageFile);
    }

    saveStore(this.store);
    return this.state();
  }

  async deleteBulletin(input: DeleteBulletinInput): Promise<GameState> {
    if (!this.store.profile.isAdmin) throw new Error("Only admins can delete bulletins.");

    const nextBulletins = this.store.bulletins.filter((item) => item.id !== input.bulletinId);
    if (nextBulletins.length === this.store.bulletins.length) {
      throw new Error("Bulletin was not found.");
    }

    this.store.bulletins = nextBulletins;
    saveStore(this.store);
    return this.state();
  }

  async deletePin(input: DeletePinInput): Promise<GameState> {
    this.settleIncome();
    const pin = this.store.pins.find((item) => item.id === input.pinId);

    if (!pin) throw new Error("Shop was not found.");
    if (pin.ownerId !== DEMO_PLAYER_ID) throw new Error("You can only delete your own shops.");

    this.store.pins = this.store.pins.filter((item) => item.id !== input.pinId);
    this.recalculatePins();
    this.store.leaderboard = buildLeaderboard(this.store);
    saveStore(this.store);
    return this.state();
  }

  async deleteWarehouse(input: DeleteWarehouseInput): Promise<GameState> {
    const warehouse = this.store.warehouses.find((item) => item.id === input.warehouseId);

    if (!warehouse) throw new Error("Warehouse was not found.");
    if (warehouse.ownerId !== DEMO_PLAYER_ID) throw new Error("You can only delete your own warehouses.");

    const now = new Date();
    warehouse.disabledAt = now.toISOString();
    warehouse.creditAvailable = false;
    warehouse.status = "empty";
    if (!warehouse.availableAt || new Date(warehouse.availableAt).getTime() <= now.getTime()) {
      warehouse.availableAt = now.toISOString();
    }
    saveStore(this.store);
    return this.state();
  }

  async beginDemandEvent(input: BeginDemandEventInput): Promise<GameState> {
    if (!this.store.profile.isAdmin) throw new Error("Only admins can begin events.");
    if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) {
      throw new Error("Choose a valid event location.");
    }
    if (input.radiusM < 25 || input.radiusM > 5000) {
      throw new Error("Event radius must be between 25m and 5000m.");
    }
    if (input.durationHours < 0.25 || input.durationHours > 168) {
      throw new Error("Event duration must be between 0.25 and 168 hours.");
    }

    this.settleIncome();
    const now = new Date();
    this.store.demandEvents = [
      {
        id: crypto.randomUUID(),
        label: "double demand zone",
        lat: input.lat,
        lng: input.lng,
        radiusM: input.radiusM,
        multiplier: 2,
        startsAt: now.toISOString(),
        endsAt: addHours(now, input.durationHours).toISOString(),
        endedAt: null
      },
      ...this.store.demandEvents
    ];
    this.recalculatePins();
    saveStore(this.store);
    return this.state();
  }

  async endDemandEvent(input: EndDemandEventInput): Promise<GameState> {
    if (!this.store.profile.isAdmin) throw new Error("Only admins can end events.");

    const event = this.store.demandEvents.find((item) => item.id === input.eventId);
    if (!event) throw new Error("Event was not found.");
    if (event.endedAt) throw new Error("This event has already ended.");

    this.settleIncome();
    const now = new Date().toISOString();
    event.endedAt = now;
    event.endsAt = now;
    this.recalculatePins();
    saveStore(this.store);
    return this.state();
  }

  async updateShopLevelConfig(input: UpdateShopLevelConfigInput): Promise<GameState> {
    if (!this.store.profile.isAdmin) throw new Error("Only admins can edit shop levels.");

    this.store.shopLevelConfig = normalizeShopLevelConfig({
      thresholdsPoints: input.thresholdsPoints,
      bonusPointsPerLevel: this.store.shopLevelConfig.bonusPointsPerLevel
    });
    this.recalculatePins();
    saveStore(this.store);
    return this.state();
  }

  async placeWarehouse(input: PlaceWarehouseInput): Promise<GameState> {
    const now = new Date();

    if (this.store.profile.playerMode !== "export") {
      throw new Error("Only export players can build warehouses.");
    }
    const exportHomeBase = this.exportHomeBaseForCurrentPlayer();
    const radiusM = Math.max(0, Math.round(distanceMeters(exportHomeBase, input) * GAME_CONFIG.exportDistanceMultiplier));
    if (this.store.profile.pointsBalance < GAME_CONFIG.warehouseCost) {
      throw new Error("Not enough tokens.");
    }
    const overlappingWarehouse = this.store.warehouses.find((warehouse) =>
      doesWarehouseBlockPlacement(warehouse, now) &&
      distanceMeters(warehouse, input) <= GAME_CONFIG.warehouseFootprintM * 2
    );
    if (overlappingWarehouse) {
      throw new Error("Warehouse radius overlaps another warehouse.");
    }

    this.store.profile.pointsBalance -= GAME_CONFIG.warehouseCost;
    this.store.warehouses = [
      {
        id: crypto.randomUUID(),
        ownerId: DEMO_PLAYER_ID,
        ownerName: "You",
        ownerColor: this.store.profile.playerColor,
        name: input.name.trim() || "Warehouse",
        tier: "distance",
        radiusM,
        lat: input.lat,
        lng: input.lng,
        placedAt: now.toISOString(),
        lastUsedAt: null,
        availableAt: null,
        creditAvailable: true,
        status: "available",
        disabledAt: null
      },
      ...this.store.warehouses
    ];
    saveStore(this.store);
    return this.state();
  }

  async restockWarehouse(input: RestockWarehouseInput): Promise<GameState> {
    const warehouse = this.store.warehouses.find((item) => item.id === input.warehouseId);
    if (!warehouse) throw new Error("Warehouse was not found.");
    if (this.store.profile.playerMode !== "export") {
      throw new Error("Only export players can restock warehouses.");
    }
    const exportHomeBase = this.exportHomeBaseForCurrentPlayer();
    if (warehouse.creditAvailable) throw new Error("Warehouse already has an export credit.");
    if (warehouse.availableAt && new Date(warehouse.availableAt).getTime() > Date.now()) {
      throw new Error("Warehouse is still cooling down.");
    }
    if (this.store.profile.pointsBalance < GAME_CONFIG.warehouseRestockCost) {
      throw new Error("Not enough tokens.");
    }

    const distance = distanceMeters(warehouse, input);
    if (distance > GAME_CONFIG.restockRadiusM) {
      throw new Error(`You are ${Math.round(distance)}m away.`);
    }

    this.store.profile.pointsBalance -= GAME_CONFIG.warehouseRestockCost;
    warehouse.radiusM = Math.max(0, Math.round(distanceMeters(exportHomeBase, warehouse) * GAME_CONFIG.exportDistanceMultiplier));
    warehouse.creditAvailable = true;
    warehouse.status = "available";
    saveStore(this.store);
    return this.state();
  }

  async exportPlacePin(input: ExportPlacePinInput): Promise<GameState> {
    if (this.store.profile.playerMode !== "export") throw new Error("Only export players can build this way.");

    const homeBase = this.store.homeBase;
    const exportHomeBase = this.getOwnExportHomeBase();
    if (!homeBase) throw new Error("Home base has not been set.");
    if (this.store.profile.pointsBalance < GAME_CONFIG.exportShopCost) throw new Error("Not enough tokens.");

    const projected = projectPointBetweenHomeBases(exportHomeBase, homeBase, input);

    const now = new Date();
    const pin: GamePin = {
      id: crypto.randomUUID(),
      ownerId: DEMO_PLAYER_ID,
      ownerName: "You",
      ownerColor: this.store.profile.playerColor,
      name: input.name.trim() || "New Shop",
      pinType: input.pinType,
      radiusLevel: 0,
      lat: projected.lat,
      lng: projected.lng,
      physicalLat: input.lat,
      physicalLng: input.lng,
      busyScore: estimateDemoBusyScore(projected.lat, projected.lng),
      busyLabel: "Steady",
      placedAt: now.toISOString(),
      visibleAt: now.toISOString(),
      lastRestockedAt: input.pinType === "standard" ? now.toISOString() : null,
      restockDueAt: input.pinType === "standard"
        ? addHours(now, GAME_CONFIG.standardRestockHours).toISOString()
        : null,
      expiresAt: input.pinType === "temporary"
        ? addHours(now, GAME_CONFIG.temporaryExpiryHours).toISOString()
        : null,
      status: "stocked",
      currentHourlyRate: 0,
      competitionPressure: 0,
      lifetimeIncome: 0
    };

    pin.busyLabel = getBusyLabel(pin.busyScore);
    this.store.profile.pointsBalance -= GAME_CONFIG.exportShopCost;
    this.store.pins = [pin, ...this.store.pins];
    this.recalculatePins();
    saveStore(this.store);
    return this.state();
  }

  async exportRestockPin(input: ExportRestockPinInput): Promise<GameState> {
    const pin = this.store.pins.find((item) => item.id === input.pinId);
    if (this.store.profile.playerMode !== "export") throw new Error("Only export players can restock this way.");
    if (!pin) throw new Error("Pin was not found.");
    if (pin.ownerId !== DEMO_PLAYER_ID) throw new Error("This is not your shop.");
    if (pin.pinType !== "standard") throw new Error("Kiosks cannot be restocked.");
    if (this.store.profile.pointsBalance < GAME_CONFIG.restockCost) throw new Error("Not enough tokens.");

    const restockTarget = hasPhysicalPinCoordinate(pin)
      ? { lat: pin.physicalLat, lng: pin.physicalLng }
      : { lat: pin.lat, lng: pin.lng };
    const distance = distanceMeters(restockTarget, input);

    if (distance > GAME_CONFIG.restockRadiusM) {
      throw new Error(`You are ${Math.round(distance)}m away.`);
    }

    const now = new Date();
    this.store.profile.pointsBalance -= GAME_CONFIG.restockCost;
    pin.status = "stocked";
    pin.lastRestockedAt = now.toISOString();
    pin.restockDueAt = addHours(now, GAME_CONFIG.standardRestockHours).toISOString();
    this.recalculatePins();
    saveStore(this.store);
    return this.state();
  }

  async updateHomeBase(input: UpdateHomeBaseInput): Promise<GameState> {
    if (!this.store.profile.isAdmin) throw new Error("Only admins can set the home base.");
    this.store.homeBase = {
      lat: input.lat,
      lng: input.lng,
      updatedAt: new Date().toISOString()
    };
    saveStore(this.store);
    return this.state();
  }

  async updateExportHomeBase(input: UpdateExportHomeBaseInput): Promise<GameState> {
    if (!this.store.profile.isAdmin) throw new Error("Only admins can set export home bases.");
    const player = this.store.exportPlayers.find((item) => item.playerId === input.playerId);
    if (!player) throw new Error("Export player was not found.");

    player.homeBase = {
      lat: input.lat,
      lng: input.lng,
      updatedAt: new Date().toISOString()
    };
    saveStore(this.store);
    return this.state();
  }

  async restockPin(input: RestockPinInput): Promise<GameState> {
    this.settleIncome();
    const pin = this.store.pins.find((item) => item.id === input.pinId);

    if (this.store.profile.playerMode === "export") {
      throw new Error("Export players must restock through export placement.");
    }
    if (!pin) throw new Error("Pin was not found.");
    if (pin.ownerId !== DEMO_PLAYER_ID) throw new Error("This is not your pin.");
    if (pin.pinType !== "standard") throw new Error("Kiosks cannot be restocked.");
    if (this.store.profile.pointsBalance < GAME_CONFIG.restockCost) {
      throw new Error("Not enough tokens.");
    }

    const distance = distanceMeters(
      { lat: pin.lat, lng: pin.lng },
      { lat: input.lat, lng: input.lng }
    );

    if (distance > GAME_CONFIG.restockRadiusM) {
      throw new Error(`You are ${Math.round(distance)}m away.`);
    }

    const now = new Date();
    this.store.profile.pointsBalance -= GAME_CONFIG.restockCost;
    pin.lastRestockedAt = now.toISOString();
    pin.restockDueAt = addHours(now, GAME_CONFIG.standardRestockHours).toISOString();
    pin.status = "stocked";
    this.recalculatePins();
    saveStore(this.store);
    return this.state();
  }

  private getOwnExportHomeBase(): HomeBase {
    const homeBase = this.store.exportPlayers.find((item) => item.playerId === this.store.profile.id)?.homeBase;
    if (!homeBase) throw new Error("An admin needs to set your export home base first.");
    return homeBase;
  }

  private state(): GameState {
    return {
      profile: this.store.profile,
      pins: this.store.pins,
      leaderboard: this.store.leaderboard,
      scoreHistory: buildDemoScoreHistory(this.store),
      bulletins: this.store.bulletins,
      demandEvents: activeDemandEvents(this.store.demandEvents),
      warehouses: visibleDemoWarehouses(this.store.warehouses),
      homeBase: this.store.homeBase,
      exportPlayers: this.store.exportPlayers,
      shopLevelConfig: this.store.shopLevelConfig,
      isDemoMode: true
    };
  }

  private exportHomeBaseForCurrentPlayer(): HomeBase {
    const homeBase = this.store.exportPlayers.find((item) => item.playerId === this.store.profile.id)?.homeBase;
    if (!homeBase) throw new Error("An admin needs to set your export home base first.");
    return homeBase;
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
        const pinEarned = pin.currentHourlyRate * hours;
        pin.lifetimeIncome += pinEarned;
        earned += pinEarned;
      }
    }

    this.store.profile.pointsBalance += earned;
    this.store.lastSettledAt = now.toISOString();
    this.store.leaderboard = buildLeaderboard(this.store);
  }

  private recalculatePins(): void {
    const now = new Date();
    this.store.demandEvents = activeDemandEvents(this.store.demandEvents, now);
    for (const pin of this.store.pins) {
      refreshPinStatus(pin, now);
    }
    this.store.pins = this.store.pins.filter(
      (pin) => !(pin.pinType === "temporary" && pin.status === "expired")
    );

    for (const pin of this.store.pins) {
      if (pin.status !== "stocked") {
        pin.currentHourlyRate = 0;
        pin.competitionPressure = 0;
        continue;
      }

      const totalPressure = this.store.pins.reduce((sum, other) => {
        if (other.id === pin.id || other.status !== "stocked") return sum;
        const distance = distanceMeters(pin, other);
        return sum + competitionPressure(distance, competitionRadiusForLevel(other.radiusLevel));
      }, 0);

      const multiplier = demandMultiplierForPin(pin, this.store.demandEvents, now);
      const level = shopLevelForIncome(pin.lifetimeIncome, this.store.shopLevelConfig);
      const levelBonus = level * this.store.shopLevelConfig.bonusPointsPerLevel;

      pin.competitionPressure = Number(totalPressure.toFixed(3));
      pin.currentHourlyRate = Number(
        (((baseHourlyRate(pin.busyScore) * multiplier) / (1 + totalPressure)) + levelBonus).toFixed(2)
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
      playerColor: demoColorForPlayer(DEMO_PLAYER_ID),
      pointsBalance: GAME_CONFIG.startingPoints,
      isAdmin: true,
      playerMode: "local"
    },
    pins,
    leaderboard: [],
    bulletins: [createDemoBulletin(now)],
    demandEvents: [],
    warehouses: [],
    homeBase: {
      lat: 55.9533,
      lng: -3.1883,
      updatedAt: now.toISOString()
    },
    exportPlayers: [],
    shopLevelConfig: DEFAULT_SHOP_LEVEL_CONFIG,
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

  const normalizedProfile: PlayerProfile = {
    id: profile.id,
    displayName: profile.displayName || "You",
    playerColor: normalizeColor(profile.playerColor, profile.id),
    pointsBalance: Number.isFinite(profile.pointsBalance)
      ? Number(profile.pointsBalance)
      : GAME_CONFIG.startingPoints,
    isAdmin: profile.isAdmin !== false,
    playerMode: profile.playerMode === "export" ? "export" : "local"
  };

  const store: DemoStore = {
    profile: normalizedProfile,
    pins: pins.map((pin, index) => normalizePin(pin ?? undefined, fallback.pins[index])),
    leaderboard: [],
    bulletins: normalizeBulletins(candidate.bulletins, fallback.bulletins),
    demandEvents: normalizeDemandEvents(candidate.demandEvents),
    warehouses: Array.isArray(candidate.warehouses)
      ? candidate.warehouses.map(normalizeWarehouse)
      : fallback.warehouses,
    homeBase: normalizeHomeBase(candidate.homeBase) ?? fallback.homeBase,
    exportPlayers: normalizeExportPlayers(candidate.exportPlayers, normalizedProfile),
    shopLevelConfig: normalizeShopLevelConfig(candidate.shopLevelConfig),
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
  const ownerId = pin?.ownerId || safeFallback.ownerId;

  return {
    id: pin?.id || safeFallback.id,
    ownerId,
    ownerName: pin?.ownerName || safeFallback.ownerName,
    ownerColor: normalizeColor(pin?.ownerColor, ownerId),
    name: pin?.name || safeFallback.name,
    pinType: pin?.pinType === "temporary" ? "temporary" : "standard",
    radiusLevel: normalizeRadiusLevel(pin?.radiusLevel ?? safeFallback.radiusLevel),
    lat: Number.isFinite(pin?.lat) ? Number(pin?.lat) : safeFallback.lat,
    lng: Number.isFinite(pin?.lng) ? Number(pin?.lng) : safeFallback.lng,
    physicalLat: safeOptionalCoordinate(pin?.physicalLat, 90),
    physicalLng: safeOptionalCoordinate(pin?.physicalLng, 180),
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
      : 0,
    lifetimeIncome: Number.isFinite(pin?.lifetimeIncome)
      ? Math.max(0, Number(pin?.lifetimeIncome))
      : safeFallback.lifetimeIncome
  };
}

function normalizeWarehouse(candidate: Partial<DemoWarehouse>): DemoWarehouse {
  const tier = candidate.tier === "distance" || candidate.tier === "large" || candidate.tier === "medium" ? candidate.tier : "small";
  const radiusM = Number.isFinite(candidate.radiusM)
    ? Math.max(0, Number(candidate.radiusM))
    : tier === "large"
      ? 300
      : tier === "medium"
        ? 200
        : 100;
  const creditAvailable = candidate.creditAvailable !== false;

  return {
    id: candidate.id || crypto.randomUUID(),
    ownerId: candidate.ownerId || DEMO_PLAYER_ID,
    ownerName: candidate.ownerName || "You",
    ownerColor: normalizeColor(candidate.ownerColor, candidate.ownerId || DEMO_PLAYER_ID),
    name: candidate.name || "Warehouse",
    tier,
    radiusM,
    lat: Number.isFinite(candidate.lat) ? Number(candidate.lat) : 55.9533,
    lng: Number.isFinite(candidate.lng) ? Number(candidate.lng) : -3.1883,
    placedAt: candidate.placedAt || new Date().toISOString(),
    lastUsedAt: candidate.lastUsedAt ?? null,
    availableAt: candidate.availableAt ?? null,
    creditAvailable,
    status: creditAvailable
      ? "available"
      : candidate.status === "empty"
        ? "empty"
        : "cooldown",
    disabledAt: candidate.disabledAt ?? null
  };
}

function visibleDemoWarehouses(warehouses: DemoWarehouse[]): Warehouse[] {
  return warehouses
    .filter((warehouse) => !warehouse.disabledAt)
    .map(({ disabledAt: _disabledAt, ...warehouse }) => warehouse);
}

function doesWarehouseBlockPlacement(warehouse: DemoWarehouse, now: Date): boolean {
  if (!warehouse.disabledAt) return true;
  if (!warehouse.availableAt) return false;
  return new Date(warehouse.availableAt).getTime() > now.getTime();
}

function normalizeHomeBase(candidate: unknown): HomeBase | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const value = candidate as Partial<HomeBase>;
  const lat = Number(value.lat);
  const lng = Number(value.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    lat,
    lng,
    updatedAt: value.updatedAt ?? null
  };
}

function normalizeExportPlayers(candidate: unknown, profile: PlayerProfile): ExportPlayerHome[] {
  const players = Array.isArray(candidate)
    ? candidate
        .map((item) => normalizeExportPlayerHome(item as Partial<ExportPlayerHome>))
        .filter((item): item is ExportPlayerHome => item !== null)
    : [];

  if (profile.playerMode === "export" && !players.some((item) => item.playerId === profile.id)) {
    players.push({
      playerId: profile.id,
      displayName: profile.displayName,
      playerColor: profile.playerColor,
      homeBase: null
    });
  }

  return players;
}

function normalizeExportPlayerHome(candidate: Partial<ExportPlayerHome>): ExportPlayerHome | null {
  if (!candidate.playerId) return null;

  return {
    playerId: candidate.playerId,
    displayName: candidate.displayName || "Export Player",
    playerColor: normalizeColor(candidate.playerColor, candidate.playerId),
    homeBase: normalizeHomeBase(candidate.homeBase)
  };
}

function normalizeBulletins(candidate: unknown, fallback: Bulletin[]): Bulletin[] {
  if (!Array.isArray(candidate)) return fallback;

  return candidate
    .map((bulletin) => normalizeBulletin(bulletin as Partial<Bulletin>))
    .filter((bulletin): bulletin is Bulletin => bulletin !== null);
}

function normalizeBulletin(candidate: Partial<Bulletin>): Bulletin | null {
  if (!candidate || typeof candidate.id !== "string") return null;

  return {
    id: candidate.id,
    title: candidate.title || "Bulletin",
    body: candidate.body || "",
    imageUrl: candidate.imageUrl || DEMO_BULLETIN_IMAGE,
    imagePath: candidate.imagePath || `demo/${candidate.id}`,
    authorId: candidate.authorId || DEMO_PLAYER_ID,
    authorName: candidate.authorName || "You",
    publishedAt: candidate.publishedAt || new Date().toISOString()
  };
}

function normalizeDemandEvents(candidate: unknown): DemandEvent[] {
  if (!Array.isArray(candidate)) return [];

  return activeDemandEvents(
    candidate
      .map((event) => normalizeDemandEvent(event as Partial<DemandEvent>))
      .filter((event): event is DemandEvent => event !== null)
  );
}

function normalizeDemandEvent(candidate: Partial<DemandEvent>): DemandEvent | null {
  if (!candidate || typeof candidate.id !== "string") return null;

  const lat = Number(candidate.lat);
  const lng = Number(candidate.lng);
  const radiusM = Number(candidate.radiusM);
  const multiplier = Number(candidate.multiplier);
  const endsAt = candidate.endsAt || "";

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    !Number.isFinite(radiusM) ||
    !Number.isFinite(multiplier) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180 ||
    radiusM <= 0 ||
    multiplier <= 1 ||
    Number.isNaN(new Date(endsAt).getTime())
  ) {
    return null;
  }

  return {
    id: candidate.id,
    label: candidate.label || "double demand zone",
    lat,
    lng,
    radiusM,
    multiplier,
    startsAt: candidate.startsAt || new Date().toISOString(),
    endsAt,
    endedAt: candidate.endedAt ?? null
  };
}

function activeDemandEvents(events: DemandEvent[], now = new Date()): DemandEvent[] {
  const nowMs = now.getTime();

  return events.filter((event) => {
    const startsAt = new Date(event.startsAt).getTime();
    const endsAt = new Date(event.endsAt).getTime();
    return (
      !event.endedAt &&
      Number.isFinite(startsAt) &&
      Number.isFinite(endsAt) &&
      startsAt <= nowMs &&
      endsAt > nowMs
    );
  });
}

function demandMultiplierForPin(pin: GamePin, events: DemandEvent[], now: Date): number {
  const activeEvents = activeDemandEvents(events, now);

  return activeEvents.reduce((multiplier, event) => {
    if (distanceMeters(pin, event) > event.radiusM) return multiplier;
    return Math.max(multiplier, event.multiplier);
  }, 1);
}

function normalizeShopLevelConfig(candidate: unknown): ShopLevelConfig {
  if (typeof candidate !== "object" || candidate === null) return DEFAULT_SHOP_LEVEL_CONFIG;

  const record = candidate as Record<string, unknown>;
  const thresholdsPoints = Array.isArray(record.thresholdsPoints)
    ? record.thresholdsPoints.map(Number)
    : Array.isArray(record.thresholds_points)
      ? record.thresholds_points.map(Number)
      : DEFAULT_SHOP_LEVEL_THRESHOLDS_POINTS;
  const cleanedThresholds = thresholdsPoints
    .filter((threshold) => Number.isFinite(threshold) && threshold > 0)
    .slice(0, 5);
  const bonusPointsPerLevel = Number(
    record.bonusPointsPerLevel ?? record.bonus_points_per_level
  );

  return {
    thresholdsPoints: cleanedThresholds.length === 5
      ? cleanedThresholds
      : DEFAULT_SHOP_LEVEL_THRESHOLDS_POINTS,
    bonusPointsPerLevel: Number.isFinite(bonusPointsPerLevel) && bonusPointsPerLevel > 0
      ? bonusPointsPerLevel
      : DEFAULT_SHOP_LEVEL_BONUS_POINTS
  };
}

function shopLevelForIncome(lifetimeIncome: number, config: ShopLevelConfig): number {
  return config.thresholdsPoints.reduce((level, threshold) => {
    return lifetimeIncome >= threshold ? level + 1 : level;
  }, 0);
}

function demoLifetimeIncomeForPin(pinId: string): number {
  switch (pinId) {
    case "pin-princes":
      return 178;
    case "pin-meadows":
      return 64;
    case "pin-leith":
      return 104;
    case "pin-stockbridge":
      return 22;
    default:
      return 0;
  }
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
    ownerColor: demoColorForPlayer(ownerId),
    name,
    pinType: "standard",
    radiusLevel: 0,
    lat,
    lng,
    physicalLat: null,
    physicalLng: null,
    busyScore,
    busyLabel: getBusyLabel(busyScore),
    placedAt: now.toISOString(),
    visibleAt: now.toISOString(),
    lastRestockedAt: now.toISOString(),
    restockDueAt: addHours(now, GAME_CONFIG.standardRestockHours).toISOString(),
    expiresAt: null,
    status: "stocked",
    currentHourlyRate: 0,
    competitionPressure: 0,
    lifetimeIncome: demoLifetimeIncomeForPin(id)
  };
}

function createDemoBulletin(now: Date): Bulletin {
  return {
    id: "bulletin-welcome",
    title: "Opening week routes",
    body: "The first rush is live. Look for underserved busy streets, keep an eye on rival clusters, and remember to restock before your shops go cold.",
    imagePath: "demo/welcome.svg",
    imageUrl: DEMO_BULLETIN_IMAGE,
    authorId: DEMO_PLAYER_ID,
    authorName: "You",
    publishedAt: now.toISOString()
  };
}

function refreshPinStatus(pin: GamePin, now: Date): void {
  if (pin.pinType === "temporary" && pin.expiresAt && new Date(pin.expiresAt) <= now) {
    pin.status = "expired";
    return;
  }

  if (pin.pinType === "temporary") {
    pin.status = "stocked";
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
  const ensure = (playerId: string, displayName: string, playerColor: string) => {
    if (!players.has(playerId)) {
      players.set(playerId, {
        playerId,
        displayName,
        playerColor,
        pointsBalance: playerId === DEMO_PLAYER_ID ? store.profile.pointsBalance : 160 + players.size * 47,
        activePins: 0,
        lifetimeIncome: playerId === DEMO_PLAYER_ID ? Math.max(0, store.profile.pointsBalance - GAME_CONFIG.startingPoints) : 90 + players.size * 26
      });
    }
    return players.get(playerId)!;
  };

  ensure(store.profile.id, store.profile.displayName, store.profile.playerColor);
  for (const pin of store.pins) {
    const row = ensure(pin.ownerId, pin.ownerName, pin.ownerColor);
    if (!(pin.pinType === "temporary" && pin.status === "expired")) row.activePins += 1;
  }

  return [...players.values()].sort((a, b) => b.pointsBalance - a.pointsBalance);
}

function buildDemoScoreHistory(store: DemoStore): ScoreHistoryPoint[] {
  const now = new Date();
  const leaderboard = store.leaderboard.length > 0 ? store.leaderboard : buildLeaderboard(store);

  return leaderboard.flatMap((row, playerIndex) => {
    const points = Math.max(0, row.pointsBalance);
    const lifetimeIncome = Math.max(0, row.lifetimeIncome);
    const activePins = Math.max(0, row.activePins);
    const drift = 34 + playerIndex * 9;
    const wobble = playerIndex % 2 === 0 ? 18 : -12;

    return [5, 4, 3, 2, 1, 0].map((daysAgo, pointIndex) => {
      const baseline = Math.max(0, points - drift * daysAgo + wobble * Math.sin(pointIndex + playerIndex));
      const lifetimeBaseline = Math.max(
        0,
        lifetimeIncome - (18 + playerIndex * 7) * daysAgo
      );
      const pinBaseline = Math.max(
        0,
        activePins - Math.max(0, Math.ceil((daysAgo - 2 - (playerIndex % 2)) / 2))
      );

      return {
        playerId: row.playerId,
        displayName: row.displayName,
        playerColor: row.playerColor,
        pointsBalance: daysAgo === 0 ? points : Number(baseline.toFixed(2)),
        lifetimeIncome: daysAgo === 0 ? lifetimeIncome : Number(lifetimeBaseline.toFixed(2)),
        activePins: daysAgo === 0 ? activePins : pinBaseline,
        recordedAt: addHours(now, -24 * daysAgo).toISOString()
      };
    });
  });
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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Could not read image."));
      }
    });
    reader.addEventListener("error", () => reject(new Error("Could not read image.")));
    reader.readAsDataURL(file);
  });
}

function getPinCost(pinType: PlacePinInput["pinType"]): number {
  return pinType === "temporary" ? GAME_CONFIG.temporaryPinCost : GAME_CONFIG.standardPinCost;
}

function safeOptionalCoordinate(value: unknown, maxAbs: number): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > maxAbs) return null;
  return parsed;
}

function hasPhysicalPinCoordinate(
  pin: GamePin
): pin is GamePin & { physicalLat: number; physicalLng: number } {
  return (
    Number.isFinite(pin.physicalLat) &&
    Number.isFinite(pin.physicalLng) &&
    Math.abs(pin.physicalLat as number) <= 90 &&
    Math.abs(pin.physicalLng as number) <= 180
  );
}

function normalizeRadiusLevel(value: unknown): number {
  return Math.max(
    0,
    Math.min(GAME_CONFIG.radiusUpgradeMaxLevel, Math.floor(Number(value) || 0))
  );
}

function normalizeColor(color: unknown, fallbackKey: string): string {
  if (typeof color === "string" && HEX_COLOR_PATTERN.test(color)) return color;
  return demoColorForPlayer(fallbackKey);
}

function demoColorForPlayer(playerId: string): string {
  if (DEMO_PLAYER_COLORS[playerId]) return DEMO_PLAYER_COLORS[playerId];

  let hash = 0;
  for (let index = 0; index < playerId.length; index += 1) {
    hash = (hash * 31 + playerId.charCodeAt(index)) >>> 0;
  }

  return FALLBACK_PLAYER_COLORS[hash % FALLBACK_PLAYER_COLORS.length];
}
