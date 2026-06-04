export const EDINBURGH_CENTER: [number, number] = [-3.1883, 55.9533];

export const GAME_CONFIG = {
  tokenUnit: 100,
  startingPoints: 300,
  standardPinCost: 200,
  temporaryPinCost: 100,
  restockRadiusM: 50,
  competitionRadiusM: 300,
  standardRestockHours: 72,
  maxAcceptedAccuracyM: 100
};

export function pointsToTokens(points: number): string {
  return (points / GAME_CONFIG.tokenUnit).toFixed(2).replace(/\.00$/, "");
}
