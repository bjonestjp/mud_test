export type PinType = "standard" | "temporary";

export type PinStatus = "stocked" | "needs_restock" | "expired" | "disabled";

export type BusyLabel = "Quiet" | "Steady" | "Busy" | "Packed";

export interface PlayerProfile {
  id: string;
  displayName: string;
  pointsBalance: number;
  playerColor: string;
  isAdmin: boolean;
}

export interface GamePin {
  id: string;
  ownerId: string;
  ownerName: string;
  ownerColor: string;
  name: string;
  pinType: PinType;
  radiusLevel: number;
  lat: number;
  lng: number;
  busyScore: number;
  busyLabel: BusyLabel;
  placedAt: string;
  visibleAt: string;
  lastRestockedAt: string | null;
  restockDueAt: string | null;
  expiresAt: string | null;
  status: PinStatus;
  currentHourlyRate: number;
  competitionPressure: number;
  lifetimeIncome: number;
}

export interface LeaderboardRow {
  playerId: string;
  displayName: string;
  playerColor: string;
  pointsBalance: number;
  activePins: number;
  lifetimeIncome: number;
}

export interface ScoreHistoryPoint {
  playerId: string;
  displayName: string;
  playerColor: string;
  pointsBalance: number;
  lifetimeIncome: number;
  activePins: number;
  recordedAt: string;
}

export interface Bulletin {
  id: string;
  title: string;
  body: string;
  imagePath: string;
  imageUrl: string;
  authorId: string;
  authorName: string;
  publishedAt: string;
}

export interface DemandEvent {
  id: string;
  label: string;
  lat: number;
  lng: number;
  radiusM: number;
  multiplier: number;
  startsAt: string;
  endsAt: string;
  endedAt: string | null;
}

export interface ShopLevelConfig {
  thresholdsPoints: number[];
  bonusPointsPerLevel: number;
}

export interface GameState {
  profile: PlayerProfile | null;
  pins: GamePin[];
  leaderboard: LeaderboardRow[];
  scoreHistory: ScoreHistoryPoint[];
  bulletins: Bulletin[];
  demandEvents: DemandEvent[];
  shopLevelConfig: ShopLevelConfig;
  isDemoMode: boolean;
}

export interface LocationReading {
  lat: number;
  lng: number;
  accuracy: number | null;
}

export interface PlacePinInput {
  lat: number;
  lng: number;
  name: string;
  pinType: PinType;
  accuracy: number | null;
}

export interface RestockPinInput {
  pinId: string;
  lat: number;
  lng: number;
  accuracy: number | null;
}

export interface UpgradeRadiusInput {
  pinId: string;
}

export interface CreateBulletinInput {
  title: string;
  body: string;
  imageFile: File;
}

export interface UpdateBulletinInput {
  bulletinId: string;
  title: string;
  body: string;
  imageFile?: File | null;
}

export interface DeleteBulletinInput {
  bulletinId: string;
}

export interface BeginDemandEventInput {
  lat: number;
  lng: number;
  radiusM: number;
  durationHours: number;
}

export interface EndDemandEventInput {
  eventId: string;
}

export interface UpdateShopLevelConfigInput {
  thresholdsPoints: number[];
}

export interface GameAdapter {
  isDemoMode: boolean;
  initialize(): Promise<GameState>;
  signIn(username: string, password: string): Promise<GameState>;
  signOut(): Promise<GameState>;
  refresh(): Promise<GameState>;
  placePin(input: PlacePinInput): Promise<GameState>;
  restockPin(input: RestockPinInput): Promise<GameState>;
  upgradePinRadius(input: UpgradeRadiusInput): Promise<GameState>;
  createBulletin(input: CreateBulletinInput): Promise<GameState>;
  updateBulletin(input: UpdateBulletinInput): Promise<GameState>;
  deleteBulletin(input: DeleteBulletinInput): Promise<GameState>;
  beginDemandEvent(input: BeginDemandEventInput): Promise<GameState>;
  endDemandEvent(input: EndDemandEventInput): Promise<GameState>;
  updateShopLevelConfig(input: UpdateShopLevelConfigInput): Promise<GameState>;
}
