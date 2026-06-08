import { useEffect, useMemo, useRef } from "react";
import maplibregl, { type GeoJSONSource, type LngLatLike, type Map, type Marker } from "maplibre-gl";
import { competitionRadiusForLevel, EDINBURGH_CENTER } from "../lib/constants";
import { competitionPressure, distanceMeters } from "../lib/geo";
import type { DemandEvent, GamePin, HomeBase, LocationReading, Warehouse } from "../types";

interface GameMapProps {
  pins: GamePin[];
  warehouses: Warehouse[];
  homeBase: HomeBase | null;
  currentPlayerId: string | null;
  playerLocation: LocationReading | null;
  focusLocation: LocationFocus | null;
  buildPreview: BuildPreview | null;
  warehousePreview: WarehousePreview | null;
  demandEvents: DemandEvent[];
  selectedPinId: string | null;
  showAllRadii: boolean;
  exportTargetRadiusM: number | null;
  nowMs: number;
  isDemoMode: boolean;
  isChoosingMapTarget: boolean;
  onSelectPin: (pin: GamePin) => void;
  onMapCenterChange: (center: { lat: number; lng: number }) => void;
}

export interface LocationFocus {
  lat: number;
  lng: number;
  requestId: number;
}

interface BuildPreview {
  name: string;
  pinType: GamePin["pinType"];
  location: LocationReading;
}

interface WarehousePreview {
  name: string;
  radiusM: number;
  location: LocationReading;
}

interface MarkerEntry {
  marker: Marker;
  pin: GamePin;
}

interface ProjectedMarkerEntry extends MarkerEntry {
  point: { x: number; y: number };
}

const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const EARTH_RADIUS_M = 6_371_000;
const SHINGLE_DISTANCE_PX = 34;
const SHINGLE_RING_SIZE = 6;
const SHINGLE_FIRST_RING_RADIUS_PX = 17;
const SHINGLE_RING_STEP_PX = 11;
const ALL_RADIUS_SOURCE_ID = "all-shop-radii";
const ALL_RADIUS_FILL_LAYER_ID = "all-shop-radii-fill";
const ALL_RADIUS_LINE_LAYER_ID = "all-shop-radii-line";
const WAREHOUSE_RADIUS_SOURCE_ID = "warehouse-radii";
const WAREHOUSE_RADIUS_FILL_LAYER_ID = "warehouse-radii-fill";
const WAREHOUSE_RADIUS_LINE_LAYER_ID = "warehouse-radii-line";
const EXPORT_TARGET_SOURCE_ID = "export-target-radius";
const EXPORT_TARGET_FILL_LAYER_ID = "export-target-radius-fill";
const EXPORT_TARGET_LINE_LAYER_ID = "export-target-radius-line";
const COMPETITION_RADIUS_SOURCE_ID = "competition-radius";
const COMPETITION_RADIUS_FILL_LAYER_ID = "competition-radius-fill";
const COMPETITION_RADIUS_LINE_LAYER_ID = "competition-radius-line";
const DEMAND_EVENT_AREA_SOURCE_ID = "demand-event-area";
const DEMAND_EVENT_AREA_FILL_LAYER_ID = "demand-event-area-fill";
const DEMAND_EVENT_AREA_LINE_LAYER_ID = "demand-event-area-line";
const EMPTY_RADIUS_DATA: Parameters<GeoJSONSource["setData"]>[0] = {
  type: "FeatureCollection",
  features: []
};

export function GameMap({
  pins,
  warehouses,
  homeBase,
  currentPlayerId,
  playerLocation,
  focusLocation,
  buildPreview,
  warehousePreview,
  demandEvents,
  selectedPinId,
  showAllRadii,
  exportTargetRadiusM,
  nowMs,
  isDemoMode,
  isChoosingMapTarget,
  onSelectPin,
  onMapCenterChange
}: GameMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const markersRef = useRef<MarkerEntry[]>([]);
  const warehouseMarkersRef = useRef<Marker[]>([]);
  const playerLocationMarkerRef = useRef<Marker | null>(null);
  const buildPreviewMarkerRef = useRef<Marker | null>(null);
  const warehousePreviewMarkerRef = useRef<Marker | null>(null);
  const homeBaseMarkerRef = useRef<Marker | null>(null);
  const demandEventLabelMarkersRef = useRef<Marker[]>([]);
  const visiblePins = useMemo(() => pins.filter(hasValidCoordinate), [pins]);
  const selectedPin = useMemo(
    () => visiblePins.find((pin) => pin.id === selectedPinId) ?? null,
    [selectedPinId, visiblePins]
  );
  const affectedPinIds = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedPin || selectedPin.status !== "stocked") return ids;

    for (const pin of visiblePins) {
      if (pin.id === selectedPin.id || pin.status !== "stocked") continue;
      const distance = distanceMeters(selectedPin, pin);
      if (competitionPressure(distance, competitionRadiusForLevel(selectedPin.radiusLevel)) > 0) {
        ids.add(pin.id);
      }
    }

    return ids;
  }, [selectedPin, visiblePins]);

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
      markersRef.current.forEach((entry) => entry.marker.remove());
      markersRef.current = [];
      warehouseMarkersRef.current.forEach((marker) => marker.remove());
      warehouseMarkersRef.current = [];
      playerLocationMarkerRef.current?.remove();
      playerLocationMarkerRef.current = null;
      buildPreviewMarkerRef.current?.remove();
      buildPreviewMarkerRef.current = null;
      warehousePreviewMarkerRef.current?.remove();
      warehousePreviewMarkerRef.current = null;
      homeBaseMarkerRef.current?.remove();
      homeBaseMarkerRef.current = null;
      demandEventLabelMarkersRef.current.forEach((marker) => marker.remove());
      demandEventLabelMarkersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [onMapCenterChange]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    let shingleFrame: number | null = null;
    const scheduleShingles = () => {
      if (shingleFrame !== null) return;

      shingleFrame = window.requestAnimationFrame(() => {
        shingleFrame = null;
        updateMarkerShingles(map, markersRef.current, selectedPinId);
      });
    };

    markersRef.current.forEach((entry) => entry.marker.remove());
    markersRef.current = visiblePins.map((pin, index) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = [
        "pin-marker",
        pin.ownerId === currentPlayerId ? "pin-marker--own" : "pin-marker--rival",
        pin.status !== "stocked" ? "pin-marker--inactive" : "",
        pin.id === selectedPinId ? "pin-marker--selected" : "",
        affectedPinIds.has(pin.id) ? "pin-marker--affected" : ""
      ]
        .filter(Boolean)
        .join(" ");
      element.title = pin.name;
      element.style.setProperty("--pin-color", pin.ownerColor);
      element.setAttribute("aria-label", pin.name);

      if (pin.status === "stocked" && pin.currentHourlyRate > 0) {
        const incomePulse = document.createElement("span");
        const durationMs = getIncomePulseDurationMs(pin.currentHourlyRate);
        incomePulse.className = "pin-income-bubble";
        incomePulse.textContent = "+";
        incomePulse.setAttribute("aria-hidden", "true");
        incomePulse.style.setProperty("--income-color", pin.ownerColor);
        incomePulse.style.setProperty("--income-duration", `${durationMs}ms`);
        incomePulse.style.setProperty("--income-delay", `-${getIncomePulseOffsetMs(pin.id, index, durationMs)}ms`);
        incomePulse.style.setProperty("--income-drift", `${getIncomePulseDriftPx(pin.id)}px`);
        element.appendChild(incomePulse);
      }

      if (affectedPinIds.has(pin.id)) {
        const impactBadge = document.createElement("span");
        impactBadge.className = "pin-impact-badge";
        impactBadge.textContent = "!";
        impactBadge.setAttribute("aria-hidden", "true");
        element.appendChild(impactBadge);
      }

      element.addEventListener("click", (event) => {
        event.stopPropagation();
        onSelectPin(pin);
      });

      const marker = new maplibregl.Marker({ element, anchor: "center" })
        .setLngLat([pin.lng, pin.lat])
        .addTo(map);

      return { marker, pin };
    });
    updateMarkerShingles(map, markersRef.current, selectedPinId);
    map.on("move", scheduleShingles);
    map.on("zoom", scheduleShingles);
    map.on("resize", scheduleShingles);

    return () => {
      if (shingleFrame !== null) window.cancelAnimationFrame(shingleFrame);
      map.off("move", scheduleShingles);
      map.off("zoom", scheduleShingles);
      map.off("resize", scheduleShingles);
      markersRef.current.forEach((entry) => entry.marker.remove());
      markersRef.current = [];
    };
  }, [affectedPinIds, currentPlayerId, onSelectPin, selectedPinId, visiblePins]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    warehouseMarkersRef.current.forEach((marker) => marker.remove());
    warehouseMarkersRef.current = warehouses.filter(hasValidCoordinate).map((warehouse) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = [
        "warehouse-marker",
        warehouse.creditAvailable ? "warehouse-marker--ready" : "warehouse-marker--empty"
      ]
        .filter(Boolean)
        .join(" ");
      element.title = warehouse.name;
      element.style.setProperty("--warehouse-color", warehouse.ownerColor);
      element.setAttribute("aria-label", warehouse.name);

      return new maplibregl.Marker({ element, anchor: "center" })
        .setLngLat([warehouse.lng, warehouse.lat])
        .addTo(map);
    });

    const updateWarehouseLayers = () => {
      ensureWarehouseRadiusLayers(map);
      const source = map.getSource(WAREHOUSE_RADIUS_SOURCE_ID) as GeoJSONSource | undefined;
      source?.setData(createWarehouseRadiusFeatureCollection(warehouses));
    };

    if (map.isStyleLoaded()) {
      updateWarehouseLayers();
    } else {
      map.once("load", updateWarehouseLayers);
    }

    return () => {
      map.off("load", updateWarehouseLayers);
      warehouseMarkersRef.current.forEach((marker) => marker.remove());
      warehouseMarkersRef.current = [];
    };
  }, [warehouses]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const updateAllRadiusLayer = () => {
      ensureAllShopRadiusLayers(map);
      const source = map.getSource(ALL_RADIUS_SOURCE_ID) as GeoJSONSource | undefined;
      source?.setData(
        showAllRadii
          ? createShopRadiusFeatureCollection(visiblePins)
          : EMPTY_RADIUS_DATA
      );
    };

    if (map.isStyleLoaded()) {
      updateAllRadiusLayer();
      return;
    }

    map.once("load", updateAllRadiusLayer);
    return () => {
      map.off("load", updateAllRadiusLayer);
    };
  }, [showAllRadii, visiblePins]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const shouldShowHomeBaseMarker = homeBase && hasValidCoordinate(homeBase) && exportTargetRadiusM !== null;

    if (!shouldShowHomeBaseMarker) {
      homeBaseMarkerRef.current?.remove();
      homeBaseMarkerRef.current = null;
    } else if (!homeBaseMarkerRef.current) {
      const element = document.createElement("div");
      element.className = "home-base-marker";
      element.title = "Home base";
      homeBaseMarkerRef.current = new maplibregl.Marker({
        element,
        anchor: "center"
      })
        .setLngLat([homeBase.lng, homeBase.lat])
        .addTo(map);
    } else {
      homeBaseMarkerRef.current.setLngLat([homeBase.lng, homeBase.lat]);
    }

    const updateExportTargetLayer = () => {
      ensureExportTargetLayers(map);
      const source = map.getSource(EXPORT_TARGET_SOURCE_ID) as GeoJSONSource | undefined;
      source?.setData(
        homeBase && exportTargetRadiusM
          ? createRadiusFeatureCollection(homeBase, exportTargetRadiusM)
          : EMPTY_RADIUS_DATA
      );
    };

    if (map.isStyleLoaded()) {
      updateExportTargetLayer();
      return;
    }

    map.once("load", updateExportTargetLayer);
    return () => {
      map.off("load", updateExportTargetLayer);
    };
  }, [exportTargetRadiusM, homeBase]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const updateRadiusLayer = () => {
      ensureCompetitionRadiusLayers(map);
      const source = map.getSource(COMPETITION_RADIUS_SOURCE_ID) as GeoJSONSource | undefined;
      source?.setData(
        selectedPin
          ? createRadiusFeatureCollection(selectedPin, competitionRadiusForLevel(selectedPin.radiusLevel))
          : EMPTY_RADIUS_DATA
      );
    };

    if (map.isStyleLoaded()) {
      updateRadiusLayer();
      return;
    }

    map.once("load", updateRadiusLayer);
    return () => {
      map.off("load", updateRadiusLayer);
    };
  }, [selectedPin]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const updateDemandEventLayers = () => {
      ensureDemandEventLayers(map);
      const areaSource = map.getSource(DEMAND_EVENT_AREA_SOURCE_ID) as GeoJSONSource | undefined;

      areaSource?.setData(createDemandEventAreaFeatureCollection(demandEvents));
      demandEventLabelMarkersRef.current.forEach((marker) => marker.remove());
      demandEventLabelMarkersRef.current = demandEvents.filter(hasValidCoordinate).map((event) => {
        const element = document.createElement("div");
        const title = document.createElement("strong");
        const detail = document.createElement("small");

        element.className = "demand-event-label-marker";
        title.textContent = event.label;
        detail.textContent = formatDemandEventRemaining(event.endsAt, nowMs);
        element.append(title, detail);

        return new maplibregl.Marker({
          element,
          anchor: "bottom",
          offset: [0, -16]
        })
          .setLngLat([event.lng, event.lat])
          .addTo(map);
      });
    };

    if (map.isStyleLoaded()) {
      updateDemandEventLayers();
      return;
    }

    map.once("load", updateDemandEventLayers);
    return () => {
      map.off("load", updateDemandEventLayers);
    };
  }, [demandEvents, nowMs]);

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
    if (!map) return;

    if (!buildPreview || !hasValidCoordinate(buildPreview.location)) {
      buildPreviewMarkerRef.current?.remove();
      buildPreviewMarkerRef.current = null;
      return;
    }

    if (!buildPreviewMarkerRef.current) {
      const element = document.createElement("div");
      element.className = [
        "build-preview-marker",
        buildPreview.pinType === "temporary" ? "build-preview-marker--temporary" : ""
      ]
        .filter(Boolean)
        .join(" ");
      element.title = buildPreview.name;
      buildPreviewMarkerRef.current = new maplibregl.Marker({
        element,
        anchor: "center"
      })
        .setLngLat([buildPreview.location.lng, buildPreview.location.lat])
        .addTo(map);
    } else {
      buildPreviewMarkerRef.current.setLngLat([
        buildPreview.location.lng,
        buildPreview.location.lat
      ]);
    }
  }, [buildPreview]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!warehousePreview || !hasValidCoordinate(warehousePreview.location)) {
      warehousePreviewMarkerRef.current?.remove();
      warehousePreviewMarkerRef.current = null;
      return;
    }

    if (!warehousePreviewMarkerRef.current) {
      const element = document.createElement("div");
      element.className = "warehouse-preview-marker";
      element.title = warehousePreview.name;
      warehousePreviewMarkerRef.current = new maplibregl.Marker({
        element,
        anchor: "center"
      })
        .setLngLat([warehousePreview.location.lng, warehousePreview.location.lat])
        .addTo(map);
    } else {
      warehousePreviewMarkerRef.current.setLngLat([
        warehousePreview.location.lng,
        warehousePreview.location.lat
      ]);
    }
  }, [warehousePreview]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedPin) return;

    map.easeTo({
      center: [selectedPin.lng, selectedPin.lat],
      duration: 500,
      zoom: Math.max(map.getZoom(), 14)
    });
  }, [selectedPin]);

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
      {isDemoMode || isChoosingMapTarget ? <div className="map-crosshair" aria-hidden="true" /> : null}
    </div>
  );
}

function ensureAllShopRadiusLayers(map: Map): void {
  if (!map.getSource(ALL_RADIUS_SOURCE_ID)) {
    map.addSource(ALL_RADIUS_SOURCE_ID, {
      type: "geojson",
      data: EMPTY_RADIUS_DATA
    });
  }

  const beforeSelectedRadiusLayer = map.getLayer(COMPETITION_RADIUS_FILL_LAYER_ID)
    ? COMPETITION_RADIUS_FILL_LAYER_ID
    : undefined;

  if (!map.getLayer(ALL_RADIUS_FILL_LAYER_ID)) {
    map.addLayer({
      id: ALL_RADIUS_FILL_LAYER_ID,
      type: "fill",
      source: ALL_RADIUS_SOURCE_ID,
      paint: {
        "fill-color": ["get", "ownerColor"],
        "fill-opacity": [
          "case",
          ["==", ["get", "status"], "stocked"],
          0.08,
          0.035
        ]
      }
    }, beforeSelectedRadiusLayer);
  }

  if (!map.getLayer(ALL_RADIUS_LINE_LAYER_ID)) {
    map.addLayer({
      id: ALL_RADIUS_LINE_LAYER_ID,
      type: "line",
      source: ALL_RADIUS_SOURCE_ID,
      paint: {
        "line-color": ["get", "ownerColor"],
        "line-opacity": [
          "case",
          ["==", ["get", "status"], "stocked"],
          0.38,
          0.18
        ],
        "line-width": [
          "case",
          ["==", ["get", "status"], "stocked"],
          1.5,
          1
        ]
      }
    }, beforeSelectedRadiusLayer);
  }
}

function ensureWarehouseRadiusLayers(map: Map): void {
  if (!map.getSource(WAREHOUSE_RADIUS_SOURCE_ID)) {
    map.addSource(WAREHOUSE_RADIUS_SOURCE_ID, {
      type: "geojson",
      data: EMPTY_RADIUS_DATA
    });
  }

  if (!map.getLayer(WAREHOUSE_RADIUS_FILL_LAYER_ID)) {
    map.addLayer({
      id: WAREHOUSE_RADIUS_FILL_LAYER_ID,
      type: "fill",
      source: WAREHOUSE_RADIUS_SOURCE_ID,
      paint: {
        "fill-color": ["get", "ownerColor"],
        "fill-opacity": 0.055
      }
    });
  }

  if (!map.getLayer(WAREHOUSE_RADIUS_LINE_LAYER_ID)) {
    map.addLayer({
      id: WAREHOUSE_RADIUS_LINE_LAYER_ID,
      type: "line",
      source: WAREHOUSE_RADIUS_SOURCE_ID,
      paint: {
        "line-color": ["get", "ownerColor"],
        "line-opacity": 0.52,
        "line-width": 1.5,
        "line-dasharray": [1.4, 1.2]
      }
    });
  }
}

function ensureExportTargetLayers(map: Map): void {
  if (!map.getSource(EXPORT_TARGET_SOURCE_ID)) {
    map.addSource(EXPORT_TARGET_SOURCE_ID, {
      type: "geojson",
      data: EMPTY_RADIUS_DATA
    });
  }

  if (!map.getLayer(EXPORT_TARGET_FILL_LAYER_ID)) {
    map.addLayer({
      id: EXPORT_TARGET_FILL_LAYER_ID,
      type: "fill",
      source: EXPORT_TARGET_SOURCE_ID,
      paint: {
        "fill-color": "#21745c",
        "fill-opacity": 0.11
      }
    });
  }

  if (!map.getLayer(EXPORT_TARGET_LINE_LAYER_ID)) {
    map.addLayer({
      id: EXPORT_TARGET_LINE_LAYER_ID,
      type: "line",
      source: EXPORT_TARGET_SOURCE_ID,
      paint: {
        "line-color": "#21745c",
        "line-opacity": 0.74,
        "line-width": 2,
        "line-dasharray": [2, 1.2]
      }
    });
  }
}

function ensureCompetitionRadiusLayers(map: Map): void {
  if (!map.getSource(COMPETITION_RADIUS_SOURCE_ID)) {
    map.addSource(COMPETITION_RADIUS_SOURCE_ID, {
      type: "geojson",
      data: EMPTY_RADIUS_DATA
    });
  }

  if (!map.getLayer(COMPETITION_RADIUS_FILL_LAYER_ID)) {
    map.addLayer({
      id: COMPETITION_RADIUS_FILL_LAYER_ID,
      type: "fill",
      source: COMPETITION_RADIUS_SOURCE_ID,
      paint: {
        "fill-color": "#2f5f9f",
        "fill-opacity": 0.12
      }
    });
  }

  if (!map.getLayer(COMPETITION_RADIUS_LINE_LAYER_ID)) {
    map.addLayer({
      id: COMPETITION_RADIUS_LINE_LAYER_ID,
      type: "line",
      source: COMPETITION_RADIUS_SOURCE_ID,
      paint: {
        "line-color": "#2f5f9f",
        "line-opacity": 0.68,
        "line-width": 2
      }
    });
  }
}

function ensureDemandEventLayers(map: Map): void {
  if (!map.getSource(DEMAND_EVENT_AREA_SOURCE_ID)) {
    map.addSource(DEMAND_EVENT_AREA_SOURCE_ID, {
      type: "geojson",
      data: EMPTY_RADIUS_DATA
    });
  }

  if (!map.getLayer(DEMAND_EVENT_AREA_FILL_LAYER_ID)) {
    map.addLayer({
      id: DEMAND_EVENT_AREA_FILL_LAYER_ID,
      type: "fill",
      source: DEMAND_EVENT_AREA_SOURCE_ID,
      paint: {
        "fill-color": "#f0ae49",
        "fill-opacity": 0.22
      }
    });
  }

  if (!map.getLayer(DEMAND_EVENT_AREA_LINE_LAYER_ID)) {
    map.addLayer({
      id: DEMAND_EVENT_AREA_LINE_LAYER_ID,
      type: "line",
      source: DEMAND_EVENT_AREA_SOURCE_ID,
      paint: {
        "line-color": "#b7791f",
        "line-opacity": 0.82,
        "line-width": 2,
        "line-dasharray": [1.5, 1.2]
      }
    });
  }
}

function updateMarkerShingles(
  map: Map,
  entries: MarkerEntry[],
  selectedPinId: string | null
): void {
  if (entries.length === 0) return;

  const projectedEntries = entries.map((entry) => {
    const point = map.project([entry.pin.lng, entry.pin.lat]);
    return {
      ...entry,
      point: { x: point.x, y: point.y }
    };
  });

  for (const group of getShingleGroups(projectedEntries)) {
    const orderedGroup = [...group].sort((a, b) => {
      if (a.pin.id === selectedPinId) return -1;
      if (b.pin.id === selectedPinId) return 1;
      return a.pin.id.localeCompare(b.pin.id);
    });

    orderedGroup.forEach((entry, index) => {
      entry.marker.setOffset(getShingleOffset(index));
    });
  }
}

function getShingleGroups(entries: ProjectedMarkerEntry[]): ProjectedMarkerEntry[][] {
  const groups: ProjectedMarkerEntry[][] = [];
  const visited = new Set<string>();

  for (const entry of entries) {
    if (visited.has(entry.pin.id)) continue;

    const group: ProjectedMarkerEntry[] = [];
    const queue = [entry];
    visited.add(entry.pin.id);

    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      group.push(current);

      for (const candidate of entries) {
        if (visited.has(candidate.pin.id)) continue;
        if (screenDistance(current.point, candidate.point) > SHINGLE_DISTANCE_PX) continue;

        visited.add(candidate.pin.id);
        queue.push(candidate);
      }
    }

    groups.push(group);
  }

  return groups;
}

function getShingleOffset(index: number): [number, number] {
  if (index === 0) return [0, 0];

  const shingleIndex = index - 1;
  const ring = Math.floor(shingleIndex / SHINGLE_RING_SIZE);
  const positionInRing = shingleIndex % SHINGLE_RING_SIZE;
  const radius = SHINGLE_FIRST_RING_RADIUS_PX + ring * SHINGLE_RING_STEP_PX;
  const angle =
    -Math.PI / 2 +
    (positionInRing / SHINGLE_RING_SIZE) * Math.PI * 2 +
    ring * 0.35;

  return [
    Math.round(Math.cos(angle) * radius),
    Math.round(Math.sin(angle) * radius)
  ];
}

function screenDistance(
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function createRadiusFeatureCollection(
  center: { lat: number; lng: number },
  radiusM: number
): Parameters<GeoJSONSource["setData"]>[0] {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [createRadiusCoordinates(center, radiusM)]
        }
      }
    ]
  };
}

function createShopRadiusFeatureCollection(
  pins: GamePin[]
): Parameters<GeoJSONSource["setData"]>[0] {
  return {
    type: "FeatureCollection",
    features: pins.map((pin) => ({
      type: "Feature",
      properties: {
        id: pin.id,
        ownerColor: pin.ownerColor,
        status: pin.status
      },
      geometry: {
        type: "Polygon",
        coordinates: [
          createRadiusCoordinates(
            pin,
            competitionRadiusForLevel(pin.radiusLevel)
          )
        ]
      }
    }))
  };
}

function createWarehouseRadiusFeatureCollection(
  warehouses: Warehouse[]
): Parameters<GeoJSONSource["setData"]>[0] {
  return {
    type: "FeatureCollection",
    features: warehouses.filter(hasValidCoordinate).map((warehouse) => ({
      type: "Feature",
      properties: {
        id: warehouse.id,
        ownerColor: warehouse.ownerColor,
        status: warehouse.status
      },
      geometry: {
        type: "Polygon",
        coordinates: [createRadiusCoordinates(warehouse, warehouse.radiusM)]
      }
    }))
  };
}

function createDemandEventAreaFeatureCollection(
  events: DemandEvent[]
): Parameters<GeoJSONSource["setData"]>[0] {
  return {
    type: "FeatureCollection",
    features: events.filter(hasValidCoordinate).map((event) => ({
      type: "Feature",
      properties: {
        id: event.id
      },
      geometry: {
        type: "Polygon",
        coordinates: [createRadiusCoordinates(event, event.radiusM)]
      }
    }))
  };
}

function formatDemandEventRemaining(endsAt: string, nowMs: number): string {
  const diffMs = new Date(endsAt).getTime() - nowMs;
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "ending now";

  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m remaining`;

  const hours = Math.ceil(minutes / 60);
  return `${hours}h remaining`;
}

function createRadiusCoordinates(
  center: { lat: number; lng: number },
  radiusM: number
): number[][] {
  const coordinates: number[][] = [];
  const lat = toRadians(center.lat);
  const lng = toRadians(center.lng);
  const angularDistance = radiusM / EARTH_RADIUS_M;

  for (let step = 0; step <= 96; step += 1) {
    const bearing = (step / 96) * 2 * Math.PI;
    const destinationLat = Math.asin(
      Math.sin(lat) * Math.cos(angularDistance) +
        Math.cos(lat) * Math.sin(angularDistance) * Math.cos(bearing)
    );
    const destinationLng =
      lng +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat),
        Math.cos(angularDistance) - Math.sin(lat) * Math.sin(destinationLat)
      );

    coordinates.push([toDegrees(destinationLng), toDegrees(destinationLat)]);
  }

  return coordinates;
}

function getIncomePulseDurationMs(hourlyRate: number): number {
  const normalizedRate = Math.max(0, Math.min(12, hourlyRate));
  return Math.round(7200 - normalizedRate * 300);
}

function getIncomePulseOffsetMs(pinId: string, index: number, durationMs: number): number {
  return (hashString(pinId) + index * 809) % durationMs;
}

function getIncomePulseDriftPx(pinId: string): number {
  return (hashString(`${pinId}:drift`) % 19) - 9;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
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
