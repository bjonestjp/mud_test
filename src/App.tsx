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
  UserPlus,
  Users,
  X
} from "lucide-react";
import { GameMap } from "./components/GameMap";
import type { LocationFocus } from "./components/GameMap";
import { createGameAdapter } from "./lib/gameAdapter";
import { EDINBURGH_CENTER, GAME_CONFIG, pointsToTokens } from "./lib/constants";
import { requestCurrentLocation } from "./lib/geo";
import type { GamePin, GameState, LocationReading } from "./types";

const EMPTY_STATE: GameState = {
  profile: null,
  pins: [],
  leaderboard: [],
  isDemoMode: false
};

type ActivePanel = "newShop" | "shops" | "leaderboard" | null;

export default function App() {
  const adapter = useMemo(() => createGameAdapter(), []);
  const [game, setGame] = useState<GameState>(EMPTY_STATE);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [mapCenter, setMapCenter] = useState({ lat: 55.9533, lng: -3.1883 });
  const [playerLocation, setPlayerLocation] = useState<LocationReading | null>(null);
  const [focusLocation, setFocusLocation] = useState<LocationFocus | null>(null);
  const [shopName, setShopName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const [notice, setNotice] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const selectedPin = game.pins.find((pin) => pin.id === selectedPinId) ?? null;
  const ownPins = game.pins.filter((pin) => pin.ownerId === game.profile?.id);

  const run = useCallback(
    async (work: () => Promise<GameState | void>, success?: string) => {
      setIsBusy(true);
      setNotice("");
      try {
        const next = await work();
        if (next) setGame(next);
        if (success) setNotice(success);
      } catch (error) {
        setNotice(formatErrorMessage(error));
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
    if (authNotice) setNotice(authNotice);
  }, []);

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
    await run(() => adapter.signIn(email.trim(), password), "Signed in");
  };

  const signUp = () => {
    const normalizedEmail = email.trim();
    if (!normalizedEmail || password.length < 6) {
      setNotice("Enter an email and a password of at least 6 characters.");
      return;
    }

    void run(() => adapter.signUp(normalizedEmail, password), "Account created");
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

  const placePin = () =>
    run(async () => {
      const location = await getPlacementLocation(game.isDemoMode, playerLocation);
      setPlayerLocation(location);
      setFocusLocation({
        lat: location.lat,
        lng: location.lng,
        requestId: Date.now()
      });
      const next = await adapter.placePin({
        lat: location.lat,
        lng: location.lng,
        accuracy: location.accuracy,
        name: shopName || "New Shop",
        pinType: "standard"
      });
      setShopName("");
      setSelectedPinId(next.pins[0]?.id ?? null);
      setActivePanel(null);
      return next;
    }, "Shop placed");

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
              <p>Sign in or create an account.</p>
            </div>
          </div>
          <label className="field">
            <span>Email</span>
            <input
              value={email}
              type="email"
              autoComplete="email"
              onChange={(event) => setEmail(event.target.value)}
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
          <button
            className="secondary-action"
            type="button"
            onClick={signUp}
            disabled={isBusy}
          >
            <UserPlus size={18} />
            Create Account
          </button>
          {notice ? <p className="notice">{notice}</p> : null}
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

      <nav className="bottom-actions" aria-label="Game actions">
        <button
          className={activePanel === "newShop" ? "bottom-action bottom-action--active" : "bottom-action"}
          type="button"
          onClick={() => setActivePanel("newShop")}
        >
          <MapPin size={20} />
          <span>New</span>
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

      {activePanel ? (
        <section className="screen-panel" role="dialog" aria-modal="true">
          <div className="screen-panel__header">
            <div className="section-title">
              {activePanel === "newShop" ? <MapPin size={20} /> : null}
              {activePanel === "shops" ? <Users size={20} /> : null}
              {activePanel === "leaderboard" ? <Trophy size={20} /> : null}
              <h2>{getPanelTitle(activePanel)}</h2>
            </div>
            <button className="icon-button" type="button" onClick={() => setActivePanel(null)} title="Close">
              <X size={20} />
            </button>
          </div>

          <div className="screen-panel__body">
            {activePanel === "newShop" ? (
              <NewShopPanel
                shopName={shopName}
                setShopName={setShopName}
                pointsBalance={game.profile?.pointsBalance ?? 0}
                isBusy={isBusy}
                isDemoMode={game.isDemoMode}
                hasPlayerLocation={Boolean(playerLocation)}
                onPlacePin={placePin}
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

      {notice ? <div className="toast">{notice}</div> : null}
    </main>
  );
}

function NewShopPanel({
  shopName,
  setShopName,
  pointsBalance,
  isBusy,
  isDemoMode,
  hasPlayerLocation,
  onPlacePin
}: {
  shopName: string;
  setShopName: (value: string) => void;
  pointsBalance: number;
  isBusy: boolean;
  isDemoMode: boolean;
  hasPlayerLocation: boolean;
  onPlacePin: () => void;
}) {
  return (
    <div className="panel-stack">
      <label className="field">
        <span>Shop name</span>
        <input
          value={shopName}
          placeholder="New Shop"
          onChange={(event) => setShopName(event.target.value)}
          maxLength={42}
        />
      </label>
      <div className="metric-row">
        <span>Cost</span>
        <strong>{pointsToTokens(GAME_CONFIG.standardPinCost)} tokens</strong>
      </div>
      <div className="metric-row">
        <span>Location</span>
        <strong>{isDemoMode ? "Simulated" : hasPlayerLocation ? "GPS ready" : "GPS on drop"}</strong>
      </div>
      <button
        className="primary-action"
        type="button"
        onClick={onPlacePin}
        disabled={isBusy || pointsBalance < GAME_CONFIG.standardPinCost}
      >
        <Plus size={20} />
        Drop Shop
      </button>
    </div>
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
              <span>{pin.name}</span>
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
          <span>{index + 1}. {row.displayName}</span>
          <strong>{pointsToTokens(row.pointsBalance)}</strong>
        </div>
      ))}
    </div>
  );
}

function getPanelTitle(panel: Exclude<ActivePanel, null>): string {
  switch (panel) {
    case "newShop":
      return "New Shop";
    case "shops":
      return "Your Shops";
    case "leaderboard":
      return "Leaderboard";
  }
}

function formatPlayerSummary(game: GameState): string {
  const name = game.profile?.displayName ?? (game.isDemoMode ? "Demo player" : "Player");
  const tokens = pointsToTokens(game.profile?.pointsBalance ?? 0);
  return `${name} · ${tokens} tokens`;
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
        <strong>{pin.ownerName}</strong>
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
        <span>{pin.status === "stocked" ? formatRestock(pin.restockDueAt) : formatStatus(pin.status)}</span>
      </div>
      {isOwner ? (
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
