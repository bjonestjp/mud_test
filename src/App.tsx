import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Coffee,
  LocateFixed,
  LogIn,
  LogOut,
  MapPin,
  PackageCheck,
  Plus,
  RefreshCcw,
  Timer,
  Trophy,
  Users,
  X
} from "lucide-react";
import { GameMap } from "./components/GameMap";
import type { LocationFocus } from "./components/GameMap";
import { createGameAdapter } from "./lib/gameAdapter";
import { EDINBURGH_CENTER, GAME_CONFIG, pointsToTokens } from "./lib/constants";
import { requestCurrentLocation } from "./lib/geo";
import type { GamePin, GameState, LocationReading, PinType } from "./types";

const EMPTY_STATE: GameState = {
  profile: null,
  pins: [],
  leaderboard: [],
  isDemoMode: false
};

type ActivePanel = "build" | "shops" | "leaderboard" | null;

interface Notice {
  message: string;
  tone: "info" | "error";
}

interface ShopTypeOption {
  pinType: PinType;
  label: string;
  blurb: string;
  costPoints: number;
}

interface PendingBuild {
  name: string;
  pinType: PinType;
  label: string;
  costPoints: number;
  location: LocationReading;
}

const SHOP_TYPES: ShopTypeOption[] = [
  {
    pinType: "standard",
    label: "Standard Shop",
    blurb: "A bog standard coffee shop.",
    costPoints: GAME_CONFIG.standardPinCost
  },
  {
    pinType: "temporary",
    label: "Pop-Up Kiosk",
    blurb: "A temporary mud stall that's gone after three days.",
    costPoints: GAME_CONFIG.temporaryPinCost
  }
];

export default function App() {
  const adapter = useMemo(() => createGameAdapter(), []);
  const [game, setGame] = useState<GameState>(EMPTY_STATE);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [mapCenter, setMapCenter] = useState({ lat: 55.9533, lng: -3.1883 });
  const [playerLocation, setPlayerLocation] = useState<LocationReading | null>(null);
  const [focusLocation, setFocusLocation] = useState<LocationFocus | null>(null);
  const [shopName, setShopName] = useState("");
  const [selectedBuildType, setSelectedBuildType] = useState<PinType | null>(null);
  const [pendingBuild, setPendingBuild] = useState<PendingBuild | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const selectedPin = game.pins.find((pin) => pin.id === selectedPinId) ?? null;
  const ownPins = game.pins.filter((pin) => pin.ownerId === game.profile?.id);
  const selectedShopType = SHOP_TYPES.find((option) => option.pinType === selectedBuildType) ?? null;

  const run = useCallback(
    async (work: () => Promise<GameState | void>, success?: string) => {
      setIsBusy(true);
      setNotice(null);
      try {
        const next = await work();
        if (next) setGame(next);
        if (success) setNotice({ message: success, tone: "info" });
      } catch (error) {
        setNotice({ message: formatErrorMessage(error), tone: "error" });
      } finally {
        setIsBusy(false);
      }
    },
    []
  );

  useEffect(() => {
    void run(() => adapter.initialize());
  }, [adapter, run]);

  useEffect(() => {
    const authNotice = readAuthNoticeFromUrl();
    if (authNotice) setNotice({ message: authNotice, tone: "error" });
  }, []);

  useEffect(() => {
    if (notice?.tone !== "info") return;

    const timeout = window.setTimeout(() => {
      setNotice((current) => (current === notice ? null : current));
    }, 2600);

    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!game.isDemoMode || playerLocation) return;

    setPlayerLocation({
      lat: EDINBURGH_CENTER[1],
      lng: EDINBURGH_CENTER[0],
      accuracy: null
    });
  }, [game.isDemoMode, playerLocation]);

  const refresh = () => run(() => adapter.refresh(), "Updated");

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    await run(() => adapter.signIn(username.trim(), password), "Signed in");
  };

  const signOut = () => run(() => adapter.signOut(), game.isDemoMode ? "Demo reset" : "Signed out");

  const locatePlayer = () =>
    run(async () => {
      const location = await getFreshPlayerLocation(game.isDemoMode, mapCenter);
      setPlayerLocation(location);
      setFocusLocation({
        lat: location.lat,
        lng: location.lng,
        requestId: Date.now()
      });
    }, game.isDemoMode ? "Simulated location set" : "Location found");

  const previewBuild = () =>
    run(async () => {
      if (!selectedShopType) {
        throw new Error("Choose a shop type first.");
      }

      const location = await getPlacementLocation(game.isDemoMode, playerLocation);
      setPlayerLocation(location);
      setFocusLocation({
        lat: location.lat,
        lng: location.lng,
        requestId: Date.now()
      });
      setPendingBuild({
        name: shopName.trim() || selectedShopType.label,
        pinType: selectedShopType.pinType,
        label: selectedShopType.label,
        costPoints: selectedShopType.costPoints,
        location
      });
      setActivePanel(null);
    }, "Check the map, then confirm");

  const confirmBuild = () => {
    if (!pendingBuild) return;

    void run(async () => {
      const next = await adapter.placePin({
        lat: pendingBuild.location.lat,
        lng: pendingBuild.location.lng,
        accuracy: pendingBuild.location.accuracy,
        name: pendingBuild.name,
        pinType: pendingBuild.pinType
      });
      setShopName("");
      setSelectedPinId(next.pins[0]?.id ?? null);
      setPendingBuild(null);
      setSelectedBuildType(null);
      setActivePanel(null);
      return next;
    }, `${pendingBuild.label} built`);
  };

  const cancelBuild = () => {
    setPendingBuild(null);
  };

  const restockPin = () => {
    if (!selectedPin) return;

    void run(async () => {
      const location = await getRestockLocation(game.isDemoMode, playerLocation);
      setPlayerLocation(location);
      setFocusLocation({
        lat: location.lat,
        lng: location.lng,
        requestId: Date.now()
      });
      return adapter.restockPin({
        pinId: selectedPin.id,
        lat: location.lat,
        lng: location.lng,
        accuracy: location.accuracy
      });
    }, "Restocked");
  };

  if (!game.profile && !game.isDemoMode) {
    return (
      <main className="auth-screen">
        <form className="auth-panel" onSubmit={signIn}>
          <div className="brand-lockup">
            <span className="brand-mark">
              <Coffee size={26} />
            </span>
            <div>
              <h1>mudslingers</h1>
              <p>Player sign in.</p>
            </div>
          </div>
          <label className="field">
            <span>Username</span>
            <input
              value={username}
              type="text"
              autoCapitalize="none"
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              value={password}
              type="password"
              autoComplete="current-password"
              minLength={6}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <button className="primary-action" type="submit" disabled={isBusy}>
            <LogIn size={18} />
            Sign In
          </button>
          {notice ? <p className="notice">{notice.message}</p> : null}
        </form>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <GameMap
        pins={game.pins}
        currentPlayerId={game.profile?.id ?? null}
        playerLocation={playerLocation}
        focusLocation={focusLocation}
        buildPreview={pendingBuild}
        selectedPinId={selectedPinId}
        isDemoMode={game.isDemoMode}
        onSelectPin={(pin) => {
          setSelectedPinId(pin.id);
          if (pin.ownerId === game.profile?.id) setActivePanel("shops");
        }}
        onMapCenterChange={setMapCenter}
      />

      <header className="top-bar">
        <div className="brand-lockup brand-lockup--compact">
          <span className="brand-mark">
            <Coffee size={22} />
          </span>
          <div>
            <h1>mudslingers</h1>
            <p>{formatPlayerSummary(game)}</p>
          </div>
        </div>
        <div className="top-actions">
          <button className="icon-button" type="button" onClick={locatePlayer} disabled={isBusy} title={game.isDemoMode ? "Set simulated location" : "Center on my location"}>
            <LocateFixed size={18} />
          </button>
          <button className="icon-button" type="button" onClick={refresh} disabled={isBusy} title="Refresh">
            <RefreshCcw size={18} />
          </button>
          <button className="icon-button" type="button" onClick={signOut} disabled={isBusy} title={game.isDemoMode ? "Reset demo" : "Sign out"}>
            <LogOut size={18} />
          </button>
        </div>
      </header>

      {pendingBuild ? (
        <BuildConfirmBar
          build={pendingBuild}
          isBusy={isBusy}
          onConfirm={confirmBuild}
          onCancel={cancelBuild}
        />
      ) : (
        <nav className="bottom-actions" aria-label="Game actions">
          <button
            className={activePanel === "build" ? "bottom-action bottom-action--active" : "bottom-action"}
            type="button"
            onClick={() => setActivePanel("build")}
          >
            <MapPin size={20} />
            <span>Build</span>
          </button>
          <button
            className={activePanel === "shops" ? "bottom-action bottom-action--active" : "bottom-action"}
            type="button"
            onClick={() => setActivePanel("shops")}
          >
            <Users size={20} />
            <span>Shops</span>
          </button>
          <button
            className={activePanel === "leaderboard" ? "bottom-action bottom-action--active" : "bottom-action"}
            type="button"
            onClick={() => setActivePanel("leaderboard")}
          >
            <Trophy size={20} />
            <span>Scores</span>
          </button>
        </nav>
      )}

      {activePanel ? (
        <section className="screen-panel" role="dialog" aria-modal="true">
          <div className="screen-panel__header">
            <div className="section-title">
              {activePanel === "build" ? <MapPin size={20} /> : null}
              {activePanel === "shops" ? <Users size={20} /> : null}
              {activePanel === "leaderboard" ? <Trophy size={20} /> : null}
              <h2>{getPanelTitle(activePanel)}</h2>
            </div>
            <button className="icon-button" type="button" onClick={() => setActivePanel(null)} title="Close">
              <X size={20} />
            </button>
          </div>

          <div className="screen-panel__body">
            {activePanel === "build" ? (
              <BuildPanel
                shopTypes={SHOP_TYPES}
                selectedBuildType={selectedBuildType}
                onSelectBuildType={setSelectedBuildType}
                shopName={shopName}
                setShopName={setShopName}
                pointsBalance={game.profile?.pointsBalance ?? 0}
                isBusy={isBusy}
                isDemoMode={game.isDemoMode}
                hasPlayerLocation={Boolean(playerLocation)}
                onPreviewBuild={previewBuild}
              />
            ) : null}

            {activePanel === "shops" ? (
              <YourShopsPanel
                pins={ownPins}
                selectedPin={selectedPin?.ownerId === game.profile?.id ? selectedPin : null}
                isBusy={isBusy}
                onSelectPin={setSelectedPinId}
                onRestock={restockPin}
              />
            ) : null}

            {activePanel === "leaderboard" ? (
              <LeaderboardPanel leaderboard={game.leaderboard} />
            ) : null}
          </div>
        </section>
      ) : null}

      {notice ? <div className={`toast toast--${notice.tone}`}>{notice.message}</div> : null}
    </main>
  );
}

function BuildPanel({
  shopTypes,
  selectedBuildType,
  onSelectBuildType,
  shopName,
  setShopName,
  pointsBalance,
  isBusy,
  isDemoMode,
  hasPlayerLocation,
  onPreviewBuild
}: {
  shopTypes: ShopTypeOption[];
  selectedBuildType: PinType | null;
  onSelectBuildType: (pinType: PinType | null) => void;
  shopName: string;
  setShopName: (value: string) => void;
  pointsBalance: number;
  isBusy: boolean;
  isDemoMode: boolean;
  hasPlayerLocation: boolean;
  onPreviewBuild: () => void;
}) {
  const selectedOption = shopTypes.find((option) => option.pinType === selectedBuildType) ?? null;

  if (!selectedOption) {
    return (
      <div className="shop-type-list">
        {shopTypes.map((option) => (
          <button
            className="shop-type-button"
            type="button"
            key={option.pinType}
            onClick={() => onSelectBuildType(option.pinType)}
            disabled={isBusy || pointsBalance < option.costPoints}
          >
            <span>
              <strong>{option.label}</strong>
              <small>{option.blurb}</small>
            </span>
            <b>{formatTokenAmount(option.costPoints)}</b>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="panel-stack">
      <button className="text-action" type="button" onClick={() => onSelectBuildType(null)}>
        Change type
      </button>
      <div className="selected-build-type">
        <span>
          <strong>{selectedOption.label}</strong>
          <small>{selectedOption.blurb}</small>
        </span>
        <b>{formatTokenAmount(selectedOption.costPoints)}</b>
      </div>
      <label className="field">
        <span>Shop name</span>
        <input
          value={shopName}
          placeholder={selectedOption.label}
          onChange={(event) => setShopName(event.target.value)}
          maxLength={42}
        />
      </label>
      <div className="metric-row">
        <span>Cost</span>
        <strong>{formatTokenAmount(selectedOption.costPoints)}</strong>
      </div>
      <div className="metric-row">
        <span>Location</span>
        <strong>{isDemoMode ? "Simulated" : hasPlayerLocation ? "GPS ready" : "GPS on preview"}</strong>
      </div>
      <button
        className="primary-action"
        type="button"
        onClick={onPreviewBuild}
        disabled={isBusy || pointsBalance < selectedOption.costPoints}
      >
        <MapPin size={20} />
        Preview Location
      </button>
    </div>
  );
}

function BuildConfirmBar({
  build,
  isBusy,
  onConfirm,
  onCancel
}: {
  build: PendingBuild;
  isBusy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="build-confirm-bar">
      <div>
        <span>{build.label}</span>
        <strong>{build.name}</strong>
        <small>{formatTokenAmount(build.costPoints)}</small>
      </div>
      <div className="build-confirm-actions">
        <button className="secondary-action" type="button" onClick={onCancel} disabled={isBusy}>
          Cancel
        </button>
        <button className="primary-action" type="button" onClick={onConfirm} disabled={isBusy}>
          <Plus size={18} />
          Confirm
        </button>
      </div>
    </section>
  );
}

function YourShopsPanel({
  pins,
  selectedPin,
  isBusy,
  onSelectPin,
  onRestock
}: {
  pins: GamePin[];
  selectedPin: GamePin | null;
  isBusy: boolean;
  onSelectPin: (pinId: string) => void;
  onRestock: () => void;
}) {
  if (pins.length === 0) {
    return <p className="muted">No shops yet.</p>;
  }

  return (
    <div className="stack-list">
      {pins.map((pin) => {
        const isSelected = pin.id === selectedPin?.id;

        return (
          <article className={isSelected ? "shop-card shop-card--selected" : "shop-card"} key={pin.id}>
            <button
              className="list-row"
              type="button"
              onClick={() => onSelectPin(pin.id)}
            >
              <span className="list-row__label">
                <ColorDot color={pin.ownerColor} />
                {pin.name}
              </span>
              <strong>{formatRate(pin.currentHourlyRate)}/h</strong>
            </button>
            {isSelected ? (
              <PinDetail
                pin={pin}
                isOwner
                onRestock={onRestock}
                isBusy={isBusy}
              />
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function LeaderboardPanel({
  leaderboard
}: {
  leaderboard: GameState["leaderboard"];
}) {
  return (
    <div className="stack-list">
      {leaderboard.map((row, index) => (
        <div className="list-row list-row--static" key={row.playerId}>
          <span className="list-row__label">
            <ColorDot color={row.playerColor} />
            {index + 1}. {row.displayName}
          </span>
          <strong>{pointsToTokens(row.pointsBalance)}</strong>
        </div>
      ))}
    </div>
  );
}

function getPanelTitle(panel: Exclude<ActivePanel, null>): string {
  switch (panel) {
    case "build":
      return "Build";
    case "shops":
      return "Your Shops";
    case "leaderboard":
      return "Leaderboard";
  }
}

function formatPlayerSummary(game: GameState): string {
  const name = game.profile?.displayName ?? (game.isDemoMode ? "Demo player" : "Player");
  return `${name} · ${formatTokenAmount(game.profile?.pointsBalance ?? 0)}`;
}

function formatTokenAmount(points: number): string {
  const tokens = pointsToTokens(points);
  return `${tokens} ${tokens === "1" ? "token" : "tokens"}`;
}

function PinDetail({
  pin,
  isOwner,
  onRestock,
  isBusy
}: {
  pin: GamePin;
  isOwner: boolean;
  onRestock: () => void;
  isBusy: boolean;
}) {
  return (
    <div className="detail-grid">
      <div className="metric-card">
        <span>Owner</span>
        <strong className="metric-card__value">
          <ColorDot color={pin.ownerColor} />
          {pin.ownerName}
        </strong>
      </div>
      <div className="metric-card">
        <span>Busy</span>
        <strong>{pin.busyLabel}</strong>
      </div>
      <div className="metric-card">
        <span>Income</span>
        <strong>{formatRate(pin.currentHourlyRate)}/h</strong>
      </div>
      <div className="metric-card">
        <span>Pressure</span>
        <strong>{formatRate(pin.competitionPressure)}</strong>
      </div>
      <div className="status-strip">
        <Timer size={16} />
        <span>{formatPinTiming(pin)}</span>
      </div>
      {isOwner && pin.pinType === "standard" ? (
        <button className="secondary-action" type="button" onClick={onRestock} disabled={isBusy}>
          <PackageCheck size={18} />
          Restock
        </button>
      ) : null}
    </div>
  );
}

function readAuthNoticeFromUrl(): string {
  if (!window.location.hash.startsWith("#")) return "";

  const params = new URLSearchParams(window.location.hash.slice(1));
  const errorDescription = params.get("error_description");
  const errorCode = params.get("error_code");

  if (!errorDescription && !errorCode) return "";

  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return errorDescription ?? `Auth error: ${errorCode}`;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;

  if (typeof error === "object" && error !== null) {
    const candidate = error as { message?: unknown; error_description?: unknown; details?: unknown };
    if (typeof candidate.message === "string") return candidate.message;
    if (typeof candidate.error_description === "string") return candidate.error_description;
    if (typeof candidate.details === "string") return candidate.details;
  }

  if (typeof error === "string") return error;

  return "Something went wrong. Check the browser console or Supabase logs for details.";
}

async function getFreshPlayerLocation(
  isDemoMode: boolean,
  mapCenter: { lat: number; lng: number }
): Promise<LocationReading> {
  if (isDemoMode) {
    return {
      ...mapCenter,
      accuracy: null
    };
  }

  const location = await requestCurrentLocation();
  assertUsableAccuracy(location);
  return location;
}

async function getPlacementLocation(
  isDemoMode: boolean,
  playerLocation: LocationReading | null
): Promise<LocationReading> {
  if (isDemoMode) {
    return playerLocation ?? {
      lat: EDINBURGH_CENTER[1],
      lng: EDINBURGH_CENTER[0],
      accuracy: null
    };
  }

  const location = await requestCurrentLocation();
  assertUsableAccuracy(location);
  return location;
}

async function getRestockLocation(
  isDemoMode: boolean,
  playerLocation: LocationReading | null
): Promise<LocationReading> {
  return getPlacementLocation(isDemoMode, playerLocation);
}

function assertUsableAccuracy(location: LocationReading): void {
  if (
    location.accuracy !== null &&
    location.accuracy > GAME_CONFIG.maxAcceptedAccuracyM
  ) {
    throw new Error(
      `Location accuracy is ${Math.round(location.accuracy)}m. Try again somewhere with a clearer signal.`
    );
  }
}

function formatRestock(value: string | null): string {
  if (!value) return "No deadline";
  const diffMs = new Date(value).getTime() - Date.now();
  if (diffMs <= 0) return "Needs restock";
  const hours = Math.ceil(diffMs / 3_600_000);
  if (hours > 24) return `${Math.ceil(hours / 24)}d stocked`;
  return `${hours}h stocked`;
}

function formatExpiry(value: string | null): string {
  if (!value) return "No expiry";
  const diffMs = new Date(value).getTime() - Date.now();
  if (diffMs <= 0) return "Expired";
  const hours = Math.ceil(diffMs / 3_600_000);
  if (hours > 24) return `${Math.ceil(hours / 24)}d until removed`;
  return `${hours}h until removed`;
}

function formatPinTiming(pin: GamePin): string {
  if (pin.status !== "stocked") return formatStatus(pin.status);
  if (pin.pinType === "temporary") return formatExpiry(pin.expiresAt);
  return formatRestock(pin.restockDueAt);
}

function formatStatus(status: GamePin["status"]): string {
  switch (status) {
    case "needs_restock":
      return "Needs restock";
    case "expired":
      return "Expired";
    case "disabled":
      return "Disabled";
    default:
      return "Stocked";
  }
}

function formatRate(value: number | null | undefined): string {
  return Number.isFinite(value) ? Number(value).toFixed(2) : "0.00";
}

function ColorDot({ color }: { color: string }) {
  return (
    <i
      className="color-dot"
      style={{ "--dot-color": color } as Record<string, string>}
      aria-hidden="true"
    />
  );
}
