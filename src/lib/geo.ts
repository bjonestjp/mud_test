import type { BusyLabel, LocationReading } from "../types";

const EARTH_RADIUS_M = 6_371_000;

export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLng = toRadians(b.lng - a.lng);

  const h =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(deltaLng / 2) *
      Math.sin(deltaLng / 2);

  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function getBusyLabel(score: number): BusyLabel {
  if (score >= 76) return "Packed";
  if (score >= 51) return "Busy";
  if (score >= 26) return "Steady";
  return "Quiet";
}

export function requestCurrentLocation(): Promise<LocationReading> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Location is not available in this browser."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy ?? null
        });
      },
      () => reject(new Error("Location permission was not granted.")),
      {
        enableHighAccuracy: true,
        maximumAge: 10_000,
        timeout: 15_000
      }
    );
  });
}

export function competitionPressure(
  distanceM: number,
  competitionRadiusM: number
): number {
  if (distanceM <= 0) return 1;
  if (distanceM >= competitionRadiusM) return 0;
  return Math.pow(1 - distanceM / competitionRadiusM, 2);
}

export function baseHourlyRate(busyScore: number): number {
  return Math.max(1, Math.round(2 + busyScore * 0.08));
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
