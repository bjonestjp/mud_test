export type PinType = "standard" | "temporary";

export type PinStatus = "stocked" | "needs_restock" | "expired" | "disabled";

export type BusyLabel = "Quiet" | "Steady" | "Busy" | "Packed";

export interface PlayerProfile {
  id: string;
  displayName: string;
  pointsBalance: number;
  playerColor: string;
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
  recordedAt: string;
}

export interface GameState {
  profile: PlayerProfile | null;
  pins: GamePin[];
  leaderboard: LeaderboardRow[];
  scoreHistory: ScoreHistoryPoint[];
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

export interface GameAdapter {
  isDemoMode: boolean;
  initialize(): Promise<GameState>;
  signIn(username: string, password: string): Promise<GameState>;
  signOut(): Promise<GameState>;
  refresh(): Promise<GameState>;
  placePin(input: PlacePinInput): Promise<GameState>;
  restockPin(input: RestockPinInput): Promise<GameState>;
  upgradePinRadius(input: UpgradeRadiusInput): Promise<GameState>;
}
