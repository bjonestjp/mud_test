import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Coffee,
  Crosshair,
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
  Users
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
              <h1>Coffee Pins</h1>
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
        onSelectPin={(pin) => setSelectedPinId(pin.id)}
        onMapCenterChange={setMapCenter}
      />

      <header className="top-bar">
        <div className="brand-lockup brand-lockup--compact">
          <span className="brand-mark">
            <Coffee size={22} />
          </span>
          <div>
            <h1>Coffee Pins</h1>
            <p>{game.isDemoMode ? "Demo" : "Live"}</p>
          </div>
        </div>
        <div className="top-actions">
          <div className="balance-pill">
            <span>{pointsToTokens(game.profile?.pointsBalance ?? 0)}</span>
            <small>tokens</small>
          </div>
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

      <aside className="control-panel">
        <section className="drop-panel">
          <div className="section-title">
            <MapPin size={18} />
            <h2>New Shop</h2>
          </div>
          <div className="field-row">
            <input
              value={shopName}
              placeholder="Shop name"
              onChange={(event) => setShopName(event.target.value)}
              maxLength={42}
            />
            <button className="primary-action primary-action--square" type="button" onClick={placePin} disabled={isBusy || (game.profile?.pointsBalance ?? 0) < GAME_CONFIG.standardPinCost} title="Drop shop">
              <Plus size={20} />
            </button>
          </div>
          <div className="metric-row">
            <span>Cost</span>
            <strong>{pointsToTokens(GAME_CONFIG.standardPinCost)} tokens</strong>
          </div>
          <div className="metric-row">
            <span>Location</span>
            <strong>{game.isDemoMode ? "Simulated" : playerLocation ? "GPS ready" : "GPS"}</strong>
          </div>
        </section>

        <section className="pin-detail">
          <div className="section-title">
            <Crosshair size={18} />
            <h2>{selectedPin ? selectedPin.name : "Selected Pin"}</h2>
          </div>
          {selectedPin ? (
            <PinDetail
              pin={selectedPin}
              isOwner={selectedPin.ownerId === game.profile?.id}
              onRestock={restockPin}
              isBusy={isBusy}
            />
          ) : (
            <p className="muted">Select a shop on the map.</p>
          )}
        </section>

        <section className="pin-list">
          <div className="section-title">
            <Users size={18} />
            <h2>Your Shops</h2>
          </div>
          <div className="stack-list">
            {ownPins.map((pin) => (
              <button
                className="list-row"
                type="button"
                key={pin.id}
                onClick={() => setSelectedPinId(pin.id)}
              >
                <span>{pin.name}</span>
                <strong>{formatRate(pin.currentHourlyRate)}/h</strong>
              </button>
            ))}
            {ownPins.length === 0 ? <p className="muted">No shops yet.</p> : null}
          </div>
        </section>

        <section className="leaderboard">
          <div className="section-title">
            <Trophy size={18} />
            <h2>Leaderboard</h2>
          </div>
          <div className="stack-list">
            {game.leaderboard.map((row, index) => (
              <div className="list-row list-row--static" key={row.playerId}>
                <span>{index + 1}. {row.displayName}</span>
                <strong>{pointsToTokens(row.pointsBalance)}</strong>
              </div>
            ))}
          </div>
        </section>
      </aside>

      {notice ? <div className="toast">{notice}</div> : null}
    </main>
  );
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
