import { useEffect, useMemo, useRef } from "react";
import maplibregl, { type LngLatLike, type Map, type Marker } from "maplibre-gl";
import { EDINBURGH_CENTER } from "../lib/constants";
import type { GamePin, LocationReading } from "../types";

interface GameMapProps {
  pins: GamePin[];
  currentPlayerId: string | null;
  playerLocation: LocationReading | null;
  focusLocation: LocationFocus | null;
  selectedPinId: string | null;
  isDemoMode: boolean;
  onSelectPin: (pin: GamePin) => void;
  onMapCenterChange: (center: { lat: number; lng: number }) => void;
}

export interface LocationFocus {
  lat: number;
  lng: number;
  requestId: number;
}

const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

export function GameMap({
  pins,
  currentPlayerId,
  playerLocation,
  focusLocation,
  selectedPinId,
  isDemoMode,
  onSelectPin,
  onMapCenterChange
}: GameMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const playerLocationMarkerRef = useRef<Marker | null>(null);
  const visiblePins = useMemo(() => pins.filter(hasValidCoordinate), [pins]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: EDINBURGH_CENTER as LngLatLike,
      zoom: 12.5,
      attributionControl: false
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

    map.on("moveend", () => {
      const center = map.getCenter();
      onMapCenterChange({ lat: center.lat, lng: center.lng });
    });

    mapRef.current = map;

    return () => {
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      playerLocationMarkerRef.current?.remove();
      playerLocationMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [onMapCenterChange]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = visiblePins.map((pin) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = [
        "pin-marker",
        pin.ownerId === currentPlayerId ? "pin-marker--own" : "pin-marker--rival",
        pin.status !== "stocked" ? "pin-marker--inactive" : "",
        pin.id === selectedPinId ? "pin-marker--selected" : ""
      ]
        .filter(Boolean)
        .join(" ");
      element.title = pin.name;
      element.setAttribute("aria-label", pin.name);
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        onSelectPin(pin);
      });

      const marker = new maplibregl.Marker({ element, anchor: "bottom" })
        .setLngLat([pin.lng, pin.lat])
        .addTo(map);

      return marker;
    });

    return () => {
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
    };
  }, [currentPlayerId, onSelectPin, selectedPinId, visiblePins]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!playerLocation || !hasValidCoordinate(playerLocation)) {
      playerLocationMarkerRef.current?.remove();
      playerLocationMarkerRef.current = null;
      return;
    }

    if (!playerLocationMarkerRef.current) {
      const element = document.createElement("div");
      element.className = "player-location-marker";
      element.title = isDemoMode ? "Simulated location" : "Current location";
      playerLocationMarkerRef.current = new maplibregl.Marker({
        element,
        anchor: "center"
      })
        .setLngLat([playerLocation.lng, playerLocation.lat])
        .addTo(map);
    } else {
      playerLocationMarkerRef.current.setLngLat([playerLocation.lng, playerLocation.lat]);
    }
  }, [isDemoMode, playerLocation]);

  useEffect(() => {
    const map = mapRef.current;
    const selectedPin = visiblePins.find((pin) => pin.id === selectedPinId);
    if (!map || !selectedPin) return;

    map.easeTo({
      center: [selectedPin.lng, selectedPin.lat],
      duration: 500,
      zoom: Math.max(map.getZoom(), 14)
    });
  }, [selectedPinId, visiblePins]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusLocation || !hasValidCoordinate(focusLocation)) return;

    map.easeTo({
      center: [focusLocation.lng, focusLocation.lat],
      duration: 500,
      zoom: Math.max(map.getZoom(), 15)
    });
  }, [focusLocation]);

  return (
    <div className="map-shell">
      <div ref={containerRef} className="map-canvas" />
      {isDemoMode ? <div className="map-crosshair" aria-hidden="true" /> : null}
    </div>
  );
}

function hasValidCoordinate<T extends { lat?: number; lng?: number }>(
  value: T | null | undefined
): value is T & { lat: number; lng: number } {
  if (!value) return false;
  const { lat, lng } = value;

  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat as number) <= 90 &&
    Math.abs(lng as number) <= 180
  );
}
