export const EDINBURGH_CENTER: [number, number] = [-3.1883, 55.9533];

export const GAME_CONFIG = {
  tokenUnit: 100,
  startingPoints: 300,
  standardPinCost: 200,
  temporaryPinCost: 100,
  exportShopCost: 100,
  warehouseCost: 100,
  warehouseRestockCost: 100,
  warehouseRestockHours: 48,
  restockCost: 25,
  restockRadiusM: 50,
  competitionRadiusM: 150,
  radiusUpgradeCost: 300,
  radiusUpgradeMaxLevel: 1,
  standardRestockHours: 48,
  temporaryExpiryHours: 72,
  maxAcceptedAccuracyM: 100
};

export const WAREHOUSE_TIERS = [
  {
    tier: "small",
    label: "Small Warehouse",
    radiusM: 100,
    blurb: "A compact export base with 100m home-base reach."
  },
  {
    tier: "medium",
    label: "Medium Warehouse",
    radiusM: 200,
    blurb: "A sturdier export base with 200m home-base reach."
  },
  {
    tier: "large",
    label: "Large Warehouse",
    radiusM: 300,
    blurb: "A broad export base with 300m home-base reach."
  }
] as const;

export const DEFAULT_SHOP_LEVEL_THRESHOLDS_POINTS = [25, 50, 90, 150, 250];
export const DEFAULT_SHOP_LEVEL_BONUS_POINTS = 1;

export function competitionRadiusForLevel(radiusLevel: number | null | undefined): number {
  const safeLevel = Math.max(
    0,
    Math.min(GAME_CONFIG.radiusUpgradeMaxLevel, Math.floor(Number(radiusLevel) || 0))
  );

  return GAME_CONFIG.competitionRadiusM * 2 ** safeLevel;
}

export function pointsToTokens(points: number): string {
  return (points / GAME_CONFIG.tokenUnit).toFixed(2).replace(/\.00$/, "");
}

export function pointsToWholeTokens(points: number): number {
  return Math.max(0, Math.floor(points / GAME_CONFIG.tokenUnit));
}

export function pointsToTokenProgress(points: number): number {
  const safePoints = Math.max(0, points);
  return (safePoints % GAME_CONFIG.tokenUnit) / GAME_CONFIG.tokenUnit;
}
