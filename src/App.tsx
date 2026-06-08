import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleDashed,
  Coffee,
  ImagePlus,
  LocateFixed,
  LogIn,
  LogOut,
  MapPin,
  MessageSquare,
  PackageCheck,
  Plus,
  RefreshCcw,
  Send,
  ShieldCheck,
  Timer,
  Trophy,
  Users,
  X,
  Zap
} from "lucide-react";
import { GameMap } from "./components/GameMap";
import type { LocationFocus } from "./components/GameMap";
import { createGameAdapter } from "./lib/gameAdapter";
import {
  competitionRadiusForLevel,
  DEFAULT_SHOP_LEVEL_BONUS_POINTS,
  DEFAULT_SHOP_LEVEL_THRESHOLDS_POINTS,
  EDINBURGH_CENTER,
  GAME_CONFIG,
  pointsToTokenProgress,
  pointsToWholeTokens
} from "./lib/constants";
import { requestCurrentLocation } from "./lib/geo";
import type { Bulletin, DemandEvent, GamePin, GameState, LeaderboardRow, LocationReading, PinType, ScoreHistoryPoint, ShopLevelConfig } from "./types";

const DEFAULT_SHOP_LEVEL_CONFIG: ShopLevelConfig = {
  thresholdsPoints: DEFAULT_SHOP_LEVEL_THRESHOLDS_POINTS,
  bonusPointsPerLevel: DEFAULT_SHOP_LEVEL_BONUS_POINTS
};

const EMPTY_STATE: GameState = {
  profile: null,
  pins: [],
  leaderboard: [],
  scoreHistory: [],
  bulletins: [],
  demandEvents: [],
  shopLevelConfig: DEFAULT_SHOP_LEVEL_CONFIG,
  isDemoMode: false
};

type ActivePanel = "build" | "shops" | "leaderboard" | "messages" | "admin" | "bulletin" | "event" | "levels" | null;

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

interface EventCenter {
  lat: number;
  lng: number;
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

const SHOP_LEVEL_VISUALS = [
  { label: "Grey Dot", dots: 1, color: "#8c9691" },
  { label: "Green Dots", dots: 2, color: "#21745c" },
  { label: "Blue Dots", dots: 3, color: "#2f5f9f" },
  { label: "Purple Dots", dots: 4, color: "#7a4ab8" },
  { label: "Gold Dots", dots: 5, color: "#d49a25" }
] as const;

interface ShopLevelModel {
  currentLevel: number;
  currentVisual: (typeof SHOP_LEVEL_VISUALS)[number] | null;
  nextLevel: number | null;
  nextVisual: (typeof SHOP_LEVEL_VISUALS)[number] | null;
  previousThreshold: number;
  nextThreshold: number | null;
  progress: number;
  bonusPointsPerHour: number;
}

type ScoreMetricKey = "current" | "lifetime" | "shops";

interface ScoreMetricConfig {
  key: ScoreMetricKey;
  label: string;
  chartTitle: string;
  leaderboardTitle: string;
  getLeaderboardValue: (row: LeaderboardRow) => number;
  getHistoryValue: (point: ScoreHistoryPoint) => number;
  formatValue: (value: number) => string;
  formatAxisValue: (value: number) => string;
}

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
  const [pendingRestockPinId, setPendingRestockPinId] = useState<string | null>(null);
  const [pendingRadiusUpgradePinId, setPendingRadiusUpgradePinId] = useState<string | null>(null);
  const [isChoosingDemandEventCenter, setIsChoosingDemandEventCenter] = useState(false);
  const [pendingDemandEventCenter, setPendingDemandEventCenter] = useState<EventCenter | null>(null);
  const [eventDurationHours, setEventDurationHours] = useState("2");
  const [eventRadiusM, setEventRadiusM] = useState("300");
  const [shopLevelThresholdInputs, setShopLevelThresholdInputs] = useState<string[]>(
    () => DEFAULT_SHOP_LEVEL_THRESHOLDS_POINTS.map(pointsToTokenInput)
  );
  const [bulletinTitle, setBulletinTitle] = useState("");
  const [bulletinBody, setBulletinBody] = useState("");
  const [bulletinImageFile, setBulletinImageFile] = useState<File | null>(null);
  const [bulletinImagePreview, setBulletinImagePreview] = useState("");
  const [editingBulletinId, setEditingBulletinId] = useState<string | null>(null);
  const [pendingDeleteBulletinId, setPendingDeleteBulletinId] = useState<string | null>(null);
  const [showAllRadii, setShowAllRadii] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const previousBalanceRef = useRef<number | null>(null);
  const [balancePulseKey, setBalancePulseKey] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const selectedPin = game.pins.find((pin) => pin.id === selectedPinId) ?? null;
  const selectedOwnPin = selectedPin?.ownerId === game.profile?.id ? selectedPin : null;
  const pendingRestockPin = game.pins.find((pin) => pin.id === pendingRestockPinId) ?? null;
  const pendingRadiusUpgradePin = game.pins.find((pin) => pin.id === pendingRadiusUpgradePinId) ?? null;
  const editingBulletin = game.bulletins.find((bulletin) => bulletin.id === editingBulletinId) ?? null;
  const pendingDeleteBulletin = game.bulletins.find((bulletin) => bulletin.id === pendingDeleteBulletinId) ?? null;
  const ownPins = game.pins.filter((pin) => pin.ownerId === game.profile?.id);
  const selectedShopType = SHOP_TYPES.find((option) => option.pinType === selectedBuildType) ?? null;
  const activeDemandEvents = game.demandEvents.filter((event) => isDemandEventActive(event, nowMs));
  const shopLevelConfig = useMemo(
    () => normalizeShopLevelConfig(game.shopLevelConfig),
    [game.shopLevelConfig]
  );
  const shopLevelThresholdKey = shopLevelConfig.thresholdsPoints.join(",");

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

  useEffect(() => {
    const currentBalance = game.profile?.pointsBalance;
    if (currentBalance === undefined) {
      previousBalanceRef.current = null;
      return;
    }

    const previousBalance = previousBalanceRef.current;
    if (previousBalance !== null && currentBalance > previousBalance) {
      setBalancePulseKey((value) => value + 1);
    }

    previousBalanceRef.current = currentBalance;
  }, [game.profile?.pointsBalance]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 60_000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    setShopLevelThresholdInputs(
      shopLevelConfig.thresholdsPoints.map(pointsToTokenInput)
    );
  }, [shopLevelThresholdKey, shopLevelConfig.thresholdsPoints]);

  useEffect(() => {
    if (!bulletinImageFile) {
      setBulletinImagePreview("");
      return;
    }

    const previewUrl = URL.createObjectURL(bulletinImageFile);
    setBulletinImagePreview(previewUrl);

    return () => URL.revokeObjectURL(previewUrl);
  }, [bulletinImageFile]);

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

  const requestRestock = (pinId: string) => {
    setPendingRestockPinId(pinId);
  };

  const requestRadiusUpgrade = (pinId: string) => {
    setPendingRadiusUpgradePinId(pinId);
  };

  const openSelectedShop = () => {
    if (!selectedOwnPin) return;

    setSelectedPinId(selectedOwnPin.id);
    setActivePanel("shops");
  };

  const clearSelectedPin = () => {
    setSelectedPinId(null);
  };

  const closeActivePanel = () => {
    if (activePanel === "event") {
      setPendingDemandEventCenter(null);
    }
    setActivePanel(null);
  };

  const cancelRestock = () => {
    setPendingRestockPinId(null);
  };

  const cancelRadiusUpgrade = () => {
    setPendingRadiusUpgradePinId(null);
  };

  const clearBulletinForm = () => {
    setBulletinTitle("");
    setBulletinBody("");
    setBulletinImageFile(null);
    setEditingBulletinId(null);
  };

  const startCreateBulletin = () => {
    clearBulletinForm();
    setActivePanel("bulletin");
  };

  const startDemandEventCenterSelection = () => {
    setSelectedPinId(null);
    setActivePanel(null);
    setPendingDemandEventCenter(null);
    setIsChoosingDemandEventCenter(true);
    setNotice(null);
  };

  const cancelDemandEventCenterSelection = () => {
    setIsChoosingDemandEventCenter(false);
    setPendingDemandEventCenter(null);
  };

  const confirmDemandEventCenter = () => {
    setPendingDemandEventCenter(mapCenter);
    setIsChoosingDemandEventCenter(false);
    setActivePanel("event");
  };

  const cancelDemandEventSetup = () => {
    setPendingDemandEventCenter(null);
    setActivePanel("admin");
  };

  const startShopLevelEditor = () => {
    setShopLevelThresholdInputs(shopLevelConfig.thresholdsPoints.map(pointsToTokenInput));
    setActivePanel("levels");
  };

  const startEditBulletin = (bulletin: Bulletin) => {
    setBulletinTitle(bulletin.title);
    setBulletinBody(bulletin.body);
    setBulletinImageFile(null);
    setEditingBulletinId(bulletin.id);
    setActivePanel("bulletin");
  };

  const requestDeleteBulletin = (bulletinId: string) => {
    setPendingDeleteBulletinId(bulletinId);
  };

  const cancelDeleteBulletin = () => {
    setPendingDeleteBulletinId(null);
  };

  const confirmRestock = () => {
    if (!pendingRestockPin) return;
    const pinId = pendingRestockPin.id;

    void run(async () => {
      const location = await getRestockLocation(game.isDemoMode, playerLocation);
      setPlayerLocation(location);
      setFocusLocation({
        lat: location.lat,
        lng: location.lng,
        requestId: Date.now()
      });
      const next = await adapter.restockPin({
        pinId,
        lat: location.lat,
        lng: location.lng,
        accuracy: location.accuracy
      });
      setPendingRestockPinId(null);
      return next;
    }, "Restocked");
  };

  const confirmRadiusUpgrade = () => {
    if (!pendingRadiusUpgradePin) return;
    const pinId = pendingRadiusUpgradePin.id;

    void run(async () => {
      const next = await adapter.upgradePinRadius({ pinId });
      setPendingRadiusUpgradePinId(null);
      return next;
    }, "Radius upgraded");
  };

  const submitBulletin = (event: React.FormEvent) => {
    event.preventDefault();

    void run(async () => {
      const next = editingBulletin
        ? await adapter.updateBulletin({
            bulletinId: editingBulletin.id,
            title: bulletinTitle,
            body: bulletinBody,
            imageFile: bulletinImageFile
          })
        : await adapter.createBulletin({
            title: bulletinTitle,
            body: bulletinBody,
            imageFile: requireBulletinImageFile(bulletinImageFile)
          });

      clearBulletinForm();
      setActivePanel("messages");
      return next;
    }, editingBulletin ? "Bulletin updated" : "Bulletin sent");
  };

  const confirmDeleteBulletin = () => {
    if (!pendingDeleteBulletin) return;
    const bulletinId = pendingDeleteBulletin.id;

    void run(async () => {
      const next = await adapter.deleteBulletin({ bulletinId });
      setPendingDeleteBulletinId(null);
      if (editingBulletinId === bulletinId) clearBulletinForm();
      return next;
    }, "Bulletin deleted");
  };

  const submitDemandEvent = (event: React.FormEvent) => {
    event.preventDefault();
    if (!pendingDemandEventCenter) return;

    void run(async () => {
      const durationHours = readBoundedNumber(eventDurationHours, "Duration", 0.25, 168);
      const radiusM = readBoundedNumber(eventRadiusM, "Radius", 25, 5000);
      const next = await adapter.beginDemandEvent({
        lat: pendingDemandEventCenter.lat,
        lng: pendingDemandEventCenter.lng,
        durationHours,
        radiusM
      });

      setPendingDemandEventCenter(null);
      setActivePanel(null);
      return next;
    }, "Event started");
  };

  const endDemandEvent = (eventId: string) => {
    void run(() => adapter.endDemandEvent({ eventId }), "Event ended");
  };

  const submitShopLevelConfig = (event: React.FormEvent) => {
    event.preventDefault();

    void run(async () => {
      const thresholdsPoints = shopLevelThresholdInputs.map((value, index) => {
        const tokens = readBoundedNumber(value, SHOP_LEVEL_VISUALS[index].label, 0.01, 999);
        return Math.round(tokens * GAME_CONFIG.tokenUnit * 100) / 100;
      });

      ensureIncreasingThresholds(thresholdsPoints);
      return adapter.updateShopLevelConfig({ thresholdsPoints });
    }, "Shop levels updated");
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
        demandEvents={activeDemandEvents}
        selectedPinId={selectedPinId}
        showAllRadii={showAllRadii}
        nowMs={nowMs}
        isDemoMode={game.isDemoMode}
        isChoosingDemandEventCenter={isChoosingDemandEventCenter}
        onSelectPin={(pin) => {
          setSelectedPinId(pin.id);
        }}
        onMapCenterChange={setMapCenter}
      />

      <header className="top-bar">
        <div className="top-stack">
          <div className="brand-lockup brand-lockup--compact">
            <span className="brand-mark">
              <Coffee size={22} />
            </span>
            <div>
              <h1>mudslingers</h1>
              <PlayerSummary game={game} pulseKey={balancePulseKey} />
            </div>
          </div>
          <button
            className={showAllRadii ? "map-radius-toggle map-radius-toggle--active" : "map-radius-toggle"}
            type="button"
            aria-pressed={showAllRadii}
            onClick={() => setShowAllRadii((value) => !value)}
          >
            <CircleDashed size={16} />
            <span>{showAllRadii ? "Hide zones" : "Show zones"}</span>
          </button>
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

      {game.profile?.isAdmin && !activePanel && !pendingBuild && !pendingRestockPin && !pendingRadiusUpgradePin && !pendingDeleteBulletin && !isChoosingDemandEventCenter ? (
        <button className="admin-map-button" type="button" onClick={() => setActivePanel("admin")}>
          <ShieldCheck size={16} />
          Admin
        </button>
      ) : null}

      {selectedPin && !activePanel && !pendingBuild && !pendingRestockPin && !pendingRadiusUpgradePin && !isChoosingDemandEventCenter ? (
        <section className="map-selection-card" aria-label="Selected shop">
          {selectedOwnPin ? (
            <button className="selected-shop-button" type="button" onClick={openSelectedShop}>
              <ColorDot color={selectedOwnPin.ownerColor} />
              <ShopNameWithLevel pin={selectedOwnPin} config={shopLevelConfig} />
            </button>
          ) : (
            <div className="selected-shop-label">
              <ColorDot color={selectedPin.ownerColor} />
              <span className="selected-shop-copy">
                <strong>
                  <ShopNameWithLevel pin={selectedPin} config={shopLevelConfig} />
                </strong>
                <small>{selectedPin.ownerName}</small>
              </span>
            </div>
          )}
          <button className="icon-button map-selection-dismiss" type="button" onClick={clearSelectedPin} title="Hide radius" aria-label="Hide radius">
            <X size={18} />
          </button>
        </section>
      ) : null}

      {pendingBuild ? (
        <BuildConfirmBar
          build={pendingBuild}
          isBusy={isBusy}
          onConfirm={confirmBuild}
          onCancel={cancelBuild}
        />
      ) : isChoosingDemandEventCenter ? (
        <EventCenterConfirmBar
          center={mapCenter}
          isBusy={isBusy}
          onConfirm={confirmDemandEventCenter}
          onCancel={cancelDemandEventCenterSelection}
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
          <button
            className={activePanel === "messages" ? "bottom-action bottom-action--active" : "bottom-action"}
            type="button"
            onClick={() => setActivePanel("messages")}
          >
            <MessageSquare size={20} />
            <span>Messages</span>
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
              {activePanel === "messages" ? <MessageSquare size={20} /> : null}
              {activePanel === "admin" || activePanel === "bulletin" || activePanel === "levels" ? <ShieldCheck size={20} /> : null}
              {activePanel === "event" ? <Zap size={20} /> : null}
              <h2>{getPanelTitle(activePanel)}</h2>
            </div>
            <button className="icon-button" type="button" onClick={closeActivePanel} title="Close">
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
                selectedPin={selectedOwnPin}
                shopLevelConfig={shopLevelConfig}
                isBusy={isBusy}
                nowMs={nowMs}
                onSelectPin={setSelectedPinId}
                onRequestRestock={requestRestock}
                onRequestRadiusUpgrade={requestRadiusUpgrade}
              />
            ) : null}

            {activePanel === "leaderboard" ? (
              <ScoresPanel leaderboard={game.leaderboard} scoreHistory={game.scoreHistory} />
            ) : null}

            {activePanel === "messages" ? (
              <MessagesPanel
                bulletins={game.bulletins}
                isAdmin={Boolean(game.profile?.isAdmin)}
                isBusy={isBusy}
                onEdit={startEditBulletin}
                onDelete={requestDeleteBulletin}
              />
            ) : null}

            {activePanel === "admin" ? (
              <AdminPanel
                demandEvents={activeDemandEvents}
                nowMs={nowMs}
                isBusy={isBusy}
                onCreateBulletin={startCreateBulletin}
                onBeginEvent={startDemandEventCenterSelection}
                onEditShopLevels={startShopLevelEditor}
                onEndEvent={endDemandEvent}
              />
            ) : null}

            {activePanel === "bulletin" ? (
              <BulletinComposerPanel
                mode={editingBulletin ? "edit" : "create"}
                title={bulletinTitle}
                body={bulletinBody}
                imageFile={bulletinImageFile}
                imagePreview={bulletinImagePreview || editingBulletin?.imageUrl || ""}
                isBusy={isBusy}
                onTitleChange={setBulletinTitle}
                onBodyChange={setBulletinBody}
                onImageChange={setBulletinImageFile}
                onBack={() => setActivePanel(editingBulletin ? "messages" : "admin")}
                onSubmit={submitBulletin}
              />
            ) : null}

            {activePanel === "event" && pendingDemandEventCenter ? (
              <DemandEventPanel
                center={pendingDemandEventCenter}
                durationHours={eventDurationHours}
                radiusM={eventRadiusM}
                isBusy={isBusy}
                onDurationHoursChange={setEventDurationHours}
                onRadiusMChange={setEventRadiusM}
                onBack={cancelDemandEventSetup}
                onSubmit={submitDemandEvent}
              />
            ) : null}

            {activePanel === "levels" ? (
              <ShopLevelsPanel
                inputs={shopLevelThresholdInputs}
                config={shopLevelConfig}
                isBusy={isBusy}
                onInputChange={(index, value) => {
                  setShopLevelThresholdInputs((current) =>
                    current.map((item, itemIndex) => itemIndex === index ? value : item)
                  );
                }}
                onBack={() => setActivePanel("admin")}
                onSubmit={submitShopLevelConfig}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {pendingRestockPin ? (
        <RestockConfirmPanel
          pin={pendingRestockPin}
          shopLevelConfig={shopLevelConfig}
          pointsBalance={game.profile?.pointsBalance ?? 0}
          isBusy={isBusy}
          onConfirm={confirmRestock}
          onCancel={cancelRestock}
        />
      ) : null}

      {pendingRadiusUpgradePin ? (
        <RadiusUpgradeConfirmPanel
          pin={pendingRadiusUpgradePin}
          shopLevelConfig={shopLevelConfig}
          pointsBalance={game.profile?.pointsBalance ?? 0}
          isBusy={isBusy}
          onConfirm={confirmRadiusUpgrade}
          onCancel={cancelRadiusUpgrade}
        />
      ) : null}

      {pendingDeleteBulletin ? (
        <DeleteBulletinConfirmPanel
          bulletin={pendingDeleteBulletin}
          isBusy={isBusy}
          onConfirm={confirmDeleteBulletin}
          onCancel={cancelDeleteBulletin}
        />
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

function EventCenterConfirmBar({
  center,
  isBusy,
  onConfirm,
  onCancel
}: {
  center: EventCenter;
  isBusy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="build-confirm-bar event-confirm-bar">
      <div>
        <span>Double demand zone</span>
        <strong>Confirm map center</strong>
        <small>{formatCoordinatePair(center)}</small>
      </div>
      <div className="build-confirm-actions">
        <button className="secondary-action" type="button" onClick={onCancel} disabled={isBusy}>
          Cancel
        </button>
        <button className="primary-action" type="button" onClick={onConfirm} disabled={isBusy}>
          <MapPin size={18} />
          Confirm
        </button>
      </div>
    </section>
  );
}

function YourShopsPanel({
  pins,
  selectedPin,
  shopLevelConfig,
  isBusy,
  nowMs,
  onSelectPin,
  onRequestRestock,
  onRequestRadiusUpgrade
}: {
  pins: GamePin[];
  selectedPin: GamePin | null;
  shopLevelConfig: ShopLevelConfig;
  isBusy: boolean;
  nowMs: number;
  onSelectPin: (pinId: string) => void;
  onRequestRestock: (pinId: string) => void;
  onRequestRadiusUpgrade: (pinId: string) => void;
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
                <ShopNameWithLevel pin={pin} config={shopLevelConfig} />
              </span>
              <strong>{formatHourlyTokenRate(pin.currentHourlyRate)}</strong>
            </button>
            {isSelected ? (
              <PinDetail
                pin={pin}
                shopLevelConfig={shopLevelConfig}
                isOwner
                nowMs={nowMs}
                onRequestRestock={() => onRequestRestock(pin.id)}
                onRequestRadiusUpgrade={() => onRequestRadiusUpgrade(pin.id)}
                isBusy={isBusy}
              />
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function ScoresPanel({
  leaderboard,
  scoreHistory
}: {
  leaderboard: GameState["leaderboard"];
  scoreHistory: GameState["scoreHistory"];
}) {
  const [activeMetric, setActiveMetric] = useState<ScoreMetricKey>("current");
  const metric = SCORE_METRICS[activeMetric];
  const sortedLeaderboard = useMemo(
    () => sortLeaderboardForMetric(leaderboard, metric),
    [leaderboard, metric]
  );

  return (
    <div className="scores-stack">
      <div className="score-tabs" role="tablist" aria-label="Score views">
        {SCORE_METRIC_ORDER.map((metricKey) => {
          const option = SCORE_METRICS[metricKey];

          return (
            <button
              className={activeMetric === metricKey ? "score-tab score-tab--active" : "score-tab"}
              type="button"
              role="tab"
              aria-selected={activeMetric === metricKey}
              key={metricKey}
              onClick={() => setActiveMetric(metricKey)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <ScoreHistoryChart
        leaderboard={sortedLeaderboard}
        scoreHistory={scoreHistory}
        metric={metric}
      />
      <section className="leaderboard-section" aria-label="Leaderboard">
        <div className="panel-subtitle">
          <h3>{metric.leaderboardTitle}</h3>
        </div>
        <div className="stack-list">
          {sortedLeaderboard.map((row, index) => (
            <div className="list-row list-row--static" key={row.playerId}>
              <span className="list-row__label">
                <ColorDot color={row.playerColor} />
                {index + 1}. {row.displayName}
              </span>
              <strong>{metric.formatValue(metric.getLeaderboardValue(row))}</strong>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function MessagesPanel({
  bulletins,
  isAdmin,
  isBusy,
  onEdit,
  onDelete
}: {
  bulletins: Bulletin[];
  isAdmin: boolean;
  isBusy: boolean;
  onEdit: (bulletin: Bulletin) => void;
  onDelete: (bulletinId: string) => void;
}) {
  if (bulletins.length === 0) {
    return <p className="muted">No messages yet.</p>;
  }

  return (
    <div className="bulletin-list">
      {bulletins.map((bulletin) => (
        <article className="bulletin-card" key={bulletin.id}>
          <div className="bulletin-card__header">
            <h3>{bulletin.title}</h3>
            <span>{formatBulletinDate(bulletin.publishedAt)}</span>
          </div>
          <img src={bulletin.imageUrl} alt="" />
          <div className="bulletin-card__body">
            <p>{bulletin.body}</p>
            <div className="bulletin-card__meta">
              <small>Sent by {bulletin.authorName}</small>
              {isAdmin ? (
                <span className="bulletin-admin-actions">
                  <button className="text-action" type="button" onClick={() => onEdit(bulletin)} disabled={isBusy}>
                    Edit
                  </button>
                  <button className="text-action text-action--danger" type="button" onClick={() => onDelete(bulletin.id)} disabled={isBusy}>
                    Delete
                  </button>
                </span>
              ) : null}
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

function AdminPanel({
  demandEvents,
  nowMs,
  isBusy,
  onCreateBulletin,
  onBeginEvent,
  onEditShopLevels,
  onEndEvent
}: {
  demandEvents: DemandEvent[];
  nowMs: number;
  isBusy: boolean;
  onCreateBulletin: () => void;
  onBeginEvent: () => void;
  onEditShopLevels: () => void;
  onEndEvent: (eventId: string) => void;
}) {
  return (
    <div className="admin-action-list">
      <button className="shop-type-button" type="button" onClick={onCreateBulletin}>
        <span>
          <strong>Bulletin</strong>
          <small>Send a message with an image to every player.</small>
        </span>
        <Send size={20} />
      </button>
      <button className="shop-type-button" type="button" onClick={onBeginEvent}>
        <span>
          <strong>Begin Event</strong>
          <small>Create a timed double income zone on the map.</small>
        </span>
        <Zap size={20} />
      </button>
      <button className="shop-type-button" type="button" onClick={onEditShopLevels}>
        <span>
          <strong>Shop Levels</strong>
          <small>Edit lifetime sales thresholds for testing.</small>
        </span>
        <Trophy size={20} />
      </button>
      {demandEvents.length > 0 ? (
        <section className="admin-event-list" aria-label="Active events">
          <div className="panel-subtitle">
            <h3>Active Events</h3>
          </div>
          {demandEvents.map((event) => (
            <div className="admin-event-row" key={event.id}>
              <span>
                <strong>{event.label}</strong>
                <small>{formatDemandEventRemaining(event, nowMs)} · {formatRadiusMeters(event.radiusM)}</small>
              </span>
              <button className="danger-action" type="button" onClick={() => onEndEvent(event.id)} disabled={isBusy}>
                End
              </button>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function DemandEventPanel({
  center,
  durationHours,
  radiusM,
  isBusy,
  onDurationHoursChange,
  onRadiusMChange,
  onBack,
  onSubmit
}: {
  center: EventCenter;
  durationHours: string;
  radiusM: string;
  isBusy: boolean;
  onDurationHoursChange: (value: string) => void;
  onRadiusMChange: (value: string) => void;
  onBack: () => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <form className="panel-stack event-form" onSubmit={onSubmit}>
      <button className="text-action" type="button" onClick={onBack}>
        Back
      </button>
      <div className="selected-build-type">
        <span>
          <strong>Double demand zone</strong>
          <small>{formatCoordinatePair(center)}</small>
        </span>
        <b>2x</b>
      </div>
      <label className="field">
        <span>Duration (hours)</span>
        <input
          value={durationHours}
          type="number"
          inputMode="decimal"
          min="0.25"
          max="168"
          step="0.25"
          onChange={(event) => onDurationHoursChange(event.target.value)}
          required
        />
      </label>
      <label className="field">
        <span>Radius (meters)</span>
        <input
          value={radiusM}
          type="number"
          inputMode="numeric"
          min="25"
          max="5000"
          step="25"
          onChange={(event) => onRadiusMChange(event.target.value)}
          required
        />
      </label>
      <div className="metric-row">
        <span>Income</span>
        <strong>2x inside zone</strong>
      </div>
      <button className="primary-action" type="submit" disabled={isBusy}>
        <Zap size={18} />
        Begin Event
      </button>
    </form>
  );
}

function ShopLevelsPanel({
  inputs,
  config,
  isBusy,
  onInputChange,
  onBack,
  onSubmit
}: {
  inputs: string[];
  config: ShopLevelConfig;
  isBusy: boolean;
  onInputChange: (index: number, value: string) => void;
  onBack: () => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <form className="panel-stack shop-level-form" onSubmit={onSubmit}>
      <button className="text-action" type="button" onClick={onBack}>
        Back
      </button>
      <div className="selected-build-type">
        <span>
          <strong>Lifetime Sales Levels</strong>
          <small>{formatHourlyTokenRate(config.bonusPointsPerLevel)} per level</small>
        </span>
        <b>5 levels</b>
      </div>
      <div className="shop-level-editor-list">
        {SHOP_LEVEL_VISUALS.map((visual, index) => (
          <label className="shop-level-editor-row" key={visual.label}>
            <span className="shop-level-editor-row__label">
              <ShopLevelIcon visual={visual} />
              <span>
                <strong>{visual.label}</strong>
                <small>Level {index + 1}</small>
              </span>
            </span>
            <input
              value={inputs[index] ?? ""}
              type="number"
              inputMode="decimal"
              min="0.01"
              max="999"
              step="0.01"
              onChange={(event) => onInputChange(index, event.target.value)}
              required
            />
          </label>
        ))}
      </div>
      <button className="primary-action" type="submit" disabled={isBusy}>
        <Trophy size={18} />
        Save Levels
      </button>
    </form>
  );
}

function BulletinComposerPanel({
  mode,
  title,
  body,
  imageFile,
  imagePreview,
  isBusy,
  onTitleChange,
  onBodyChange,
  onImageChange,
  onBack,
  onSubmit
}: {
  mode: "create" | "edit";
  title: string;
  body: string;
  imageFile: File | null;
  imagePreview: string;
  isBusy: boolean;
  onTitleChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  onImageChange: (file: File | null) => void;
  onBack: () => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const isEditing = mode === "edit";

  return (
    <form className="bulletin-form" onSubmit={onSubmit}>
      <button className="text-action" type="button" onClick={onBack}>
        Back
      </button>
      <label className="field">
        <span>Title</span>
        <input
          value={title}
          maxLength={120}
          onChange={(event) => onTitleChange(event.target.value)}
          required
        />
      </label>
      <label className="field">
        <span>Image</span>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(event) => onImageChange(event.target.files?.[0] ?? null)}
          required={!isEditing && !imageFile}
        />
      </label>
      {imagePreview ? (
        <img className="bulletin-image-preview" src={imagePreview} alt="" />
      ) : (
        <div className="bulletin-image-empty">
          <ImagePlus size={22} />
        </div>
      )}
      <label className="field">
        <span>Body</span>
        <textarea
          value={body}
          rows={8}
          maxLength={5000}
          onChange={(event) => onBodyChange(event.target.value)}
          required
        />
      </label>
      <button className="primary-action" type="submit" disabled={isBusy || !title.trim() || !body.trim() || (!isEditing && !imageFile)}>
        <Send size={18} />
        {isEditing ? "Save Bulletin" : "Send Bulletin"}
      </button>
    </form>
  );
}

function ScoreHistoryChart({
  leaderboard,
  scoreHistory,
  metric
}: {
  leaderboard: LeaderboardRow[];
  scoreHistory: ScoreHistoryPoint[];
  metric: ScoreMetricConfig;
}) {
  const chart = useMemo(
    () => buildScoreChartModel(leaderboard, scoreHistory, metric),
    [leaderboard, scoreHistory, metric]
  );

  if (!chart) {
    return (
      <section className="score-chart-card" aria-label="Score history">
        <div className="score-chart-card__header">
          <h3>{metric.chartTitle}</h3>
        </div>
        <p className="muted">No scores yet.</p>
      </section>
    );
  }

  return (
    <section className="score-chart-card" aria-label="Score history">
      <div className="score-chart-card__header">
        <h3>{metric.chartTitle}</h3>
        <span>{formatDateRange(chart.minTime, chart.maxTime)}</span>
      </div>
      <div className="score-chart-frame">
        <svg className="score-chart" viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label="Player score history">
          {chart.yTicks.map((tick) => (
            <g key={tick.value}>
              <line
                className="score-chart__grid"
                x1={chart.plotLeft}
                x2={chart.plotRight}
                y1={tick.y}
                y2={tick.y}
              />
              <text className="score-chart__axis-label" x={chart.plotLeft - 8} y={tick.y + 4} textAnchor="end">
                {metric.formatAxisValue(tick.value)}
              </text>
            </g>
          ))}
          <line
            className="score-chart__axis"
            x1={chart.plotLeft}
            x2={chart.plotRight}
            y1={chart.plotBottom}
            y2={chart.plotBottom}
          />
          <text className="score-chart__axis-label" x={chart.plotLeft} y={chart.height - 8} textAnchor="start">
            {formatChartTickDate(chart.minTime)}
          </text>
          <text className="score-chart__axis-label" x={chart.plotRight} y={chart.height - 8} textAnchor="end">
            {formatChartTickDate(chart.maxTime)}
          </text>
          {chart.series.map((series) => (
            <g key={series.playerId}>
              {series.path ? (
                <path className="score-chart__line" d={series.path} stroke={series.playerColor} />
              ) : null}
              {series.points.map((point, pointIndex) => (
                <circle
                  className="score-chart__point"
                  key={`${series.playerId}-${point.time}-${pointIndex}`}
                  cx={point.x}
                  cy={point.y}
                  r={point.isLatest ? 2.1 : 1.2}
                  fill={series.playerColor}
                />
              ))}
            </g>
          ))}
        </svg>
      </div>
      <div className="score-chart-legend">
        {chart.series.map((series) => (
          <div className="score-chart-legend__item" key={series.playerId}>
            <span>
              <ColorDot color={series.playerColor} />
              {series.displayName}
            </span>
            <strong>{metric.formatValue(series.latestPoints)}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function getPanelTitle(panel: Exclude<ActivePanel, null>): string {
  switch (panel) {
    case "build":
      return "Build";
    case "shops":
      return "Your Shops";
    case "leaderboard":
      return "Scores";
    case "messages":
      return "Messages";
    case "admin":
      return "Admin";
    case "bulletin":
      return "Bulletin";
    case "event":
      return "Begin Event";
    case "levels":
      return "Shop Levels";
  }
}

function PlayerSummary({
  game,
  pulseKey
}: {
  game: GameState;
  pulseKey: number;
}) {
  const name = game.profile?.displayName ?? (game.isDemoMode ? "Demo player" : "Player");
  const points = game.profile?.pointsBalance ?? 0;
  const wholeTokens = pointsToWholeTokens(points);
  const progress = pointsToTokenProgress(points);

  return (
    <div className="player-summary">
      <span className="player-summary__name">{name}</span>
      <span aria-hidden="true">·</span>
      <strong>{formatTokenAmount(points)}</strong>
      <TokenProgressRing
        progress={progress}
        color={game.profile?.playerColor ?? "#21745c"}
        pulseKey={pulseKey}
        label={`${Math.round(progress * 100)}% toward token ${wholeTokens + 1}`}
      />
    </div>
  );
}

function formatTokenAmount(points: number): string {
  const tokens = pointsToWholeTokens(points);
  return `${tokens} ${tokens === 1 ? "token" : "tokens"}`;
}

function formatTokenScore(points: number): string {
  const tokens = Math.max(0, points) / GAME_CONFIG.tokenUnit;
  const label = tokens === 1 ? "token" : "tokens";
  return `${tokens.toFixed(2)} ${label}`;
}

function formatShopCount(value: number): string {
  const count = Math.max(0, Math.floor(value));
  return `${count} ${count === 1 ? "shop" : "shops"}`;
}

const SCORE_METRICS: Record<ScoreMetricKey, ScoreMetricConfig> = {
  current: {
    key: "current",
    label: "Current",
    chartTitle: "Current Tokens",
    leaderboardTitle: "Current Tokens",
    getLeaderboardValue: (row) => row.pointsBalance,
    getHistoryValue: (point) => point.pointsBalance,
    formatValue: formatTokenAmount,
    formatAxisValue: formatAxisTokenLabel
  },
  lifetime: {
    key: "lifetime",
    label: "Lifetime",
    chartTitle: "Lifetime Tokens",
    leaderboardTitle: "Lifetime Tokens",
    getLeaderboardValue: (row) => row.lifetimeIncome,
    getHistoryValue: (point) => point.lifetimeIncome,
    formatValue: formatTokenScore,
    formatAxisValue: formatAxisTokenLabel
  },
  shops: {
    key: "shops",
    label: "Shops",
    chartTitle: "Total Shops",
    leaderboardTitle: "Total Shops",
    getLeaderboardValue: (row) => row.activePins,
    getHistoryValue: (point) => point.activePins,
    formatValue: formatShopCount,
    formatAxisValue: (value) => Math.round(value).toString()
  }
};
const SCORE_METRIC_ORDER: ScoreMetricKey[] = ["current", "lifetime", "shops"];

function sortLeaderboardForMetric(
  leaderboard: LeaderboardRow[],
  metric: ScoreMetricConfig
): LeaderboardRow[] {
  return [...leaderboard].sort((a, b) => {
    const valueDifference = metric.getLeaderboardValue(b) - metric.getLeaderboardValue(a);
    if (Math.abs(valueDifference) > 0.001) return valueDifference;
    return a.displayName.localeCompare(b.displayName);
  });
}

const SCORE_CHART_WIDTH = 640;
const SCORE_CHART_HEIGHT = 280;
const SCORE_CHART_PLOT = {
  left: 46,
  right: 620,
  top: 18,
  bottom: 238
};

interface ScoreChartPoint {
  time: number;
  value: number;
  x: number;
  y: number;
  isLatest: boolean;
}

interface ScoreChartSeries {
  playerId: string;
  displayName: string;
  playerColor: string;
  latestPoints: number;
  points: ScoreChartPoint[];
  path: string;
}

interface ScoreChartModel {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  plotBottom: number;
  minTime: number;
  maxTime: number;
  yTicks: Array<{ value: number; y: number }>;
  series: ScoreChartSeries[];
}

function buildScoreChartModel(
  leaderboard: LeaderboardRow[],
  history: ScoreHistoryPoint[],
  metric: ScoreMetricConfig
): ScoreChartModel | null {
  if (leaderboard.length === 0) return null;

  const now = Date.now();
  const maxHistoryTime = now + 5 * 60_000;
  const historyByPlayer = new Map<string, Array<{ time: number; value: number }>>();

  for (const point of history) {
    const rawTime = new Date(point.recordedAt).getTime();
    const value = Number(metric.getHistoryValue(point));
    if (!Number.isFinite(rawTime) || !Number.isFinite(value)) continue;
    if (rawTime > maxHistoryTime) continue;

    const time = Math.min(rawTime, now);
    const points = historyByPlayer.get(point.playerId) ?? [];
    points.push({ time, value });
    historyByPlayer.set(point.playerId, points);
  }

  const rawSeries = leaderboard.map((row) => {
    const points = [...(historyByPlayer.get(row.playerId) ?? [])].sort((a, b) => a.time - b.time);
    const latest = points[points.length - 1];
    const currentValue = metric.getLeaderboardValue(row);

    if (!latest) {
      points.push({ time: now, value: currentValue });
    } else if (
      Math.abs(latest.value - currentValue) > 0.01 ||
      now - latest.time > 60_000
    ) {
      points.push({ time: now, value: currentValue });
    }

    if (points.length === 1) {
      points.unshift({
        time: points[0].time - 6 * 3_600_000,
        value: points[0].value
      });
    }

    return {
      playerId: row.playerId,
      displayName: row.displayName,
      playerColor: row.playerColor,
      latestValue: currentValue,
      rawPoints: points
    };
  });

  const allPoints = rawSeries.flatMap((series) => series.rawPoints);
  if (allPoints.length === 0) return null;

  let minTime = Math.min(...allPoints.map((point) => point.time));
  let maxTime = Math.max(...allPoints.map((point) => point.time));
  if (minTime === maxTime) {
    minTime -= 6 * 3_600_000;
    maxTime += 6 * 3_600_000;
  }

  const minPoints = Math.min(0, ...allPoints.map((point) => point.value));
  const minimumChartValue = metric.key === "shops" ? 1 : GAME_CONFIG.tokenUnit;
  const maxPoints = Math.max(...allPoints.map((point) => point.value), minimumChartValue);
  const padding = Math.max(minimumChartValue, (maxPoints - minPoints) * 0.12);
  const yMin = Math.max(0, minPoints - padding);
  const yMax = maxPoints + padding;

  const xForTime = (time: number) =>
    SCORE_CHART_PLOT.left +
    ((time - minTime) / Math.max(1, maxTime - minTime)) *
      (SCORE_CHART_PLOT.right - SCORE_CHART_PLOT.left);
  const yForPoints = (points: number) =>
    SCORE_CHART_PLOT.bottom -
    ((points - yMin) / Math.max(1, yMax - yMin)) *
      (SCORE_CHART_PLOT.bottom - SCORE_CHART_PLOT.top);

  const series = rawSeries.map((raw) => {
    const plottedPoints = raw.rawPoints.map((point, index) => ({
      ...point,
      x: xForTime(point.time),
      y: yForPoints(point.value),
      isLatest: index === raw.rawPoints.length - 1
    }));

    return {
      playerId: raw.playerId,
      displayName: raw.displayName,
      playerColor: raw.playerColor,
      latestPoints: raw.latestValue,
      points: plottedPoints,
      path: plottedPoints.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ")
    };
  });

  return {
    width: SCORE_CHART_WIDTH,
    height: SCORE_CHART_HEIGHT,
    plotLeft: SCORE_CHART_PLOT.left,
    plotRight: SCORE_CHART_PLOT.right,
    plotBottom: SCORE_CHART_PLOT.bottom,
    minTime,
    maxTime,
    yTicks: buildScoreChartTicks(yMin, yMax, yForPoints, metric),
    series
  };
}

function buildScoreChartTicks(
  minPoints: number,
  maxPoints: number,
  yForPoints: (points: number) => number,
  metric: ScoreMetricConfig
): Array<{ value: number; y: number }> {
  if (metric.key === "shops") {
    const maxTick = Math.max(1, Math.ceil(maxPoints));
    const step = maxTick <= 4 ? 1 : Math.ceil(maxTick / 3);
    const values = new Set<number>();

    for (let value = 0; value <= maxTick; value += step) {
      values.add(value);
    }
    values.add(maxTick);

    return [...values].sort((a, b) => a - b).map((value) => ({
      value,
      y: yForPoints(value)
    }));
  }

  return [0, 0.33, 0.66, 1].map((ratio) => {
    const value = minPoints + (maxPoints - minPoints) * ratio;
    return {
      value,
      y: yForPoints(value)
    };
  });
}

function formatAxisTokenLabel(points: number): string {
  const tokens = points / GAME_CONFIG.tokenUnit;
  if (Math.abs(tokens) >= 10) return Math.round(tokens).toString();
  return tokens.toFixed(1).replace(/\.0$/, "");
}

function formatChartTickDate(time: number): string {
  return new Date(time).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
}

function formatDateRange(minTime: number, maxTime: number): string {
  const start = formatChartTickDate(minTime);
  const end = formatChartTickDate(maxTime);
  return start === end ? start : `${start} - ${end}`;
}

function formatBulletinDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
}

function formatDemandEventRemaining(event: DemandEvent, nowMs: number): string {
  const diffMs = new Date(event.endsAt).getTime() - nowMs;
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "Ending now";

  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m left`;

  const hours = Math.ceil(minutes / 60);
  if (hours <= 48) return `${hours}h left`;

  return `${Math.ceil(hours / 24)}d left`;
}

function isDemandEventActive(event: DemandEvent, nowMs: number): boolean {
  const startsAt = new Date(event.startsAt).getTime();
  const endsAt = new Date(event.endsAt).getTime();

  return (
    !event.endedAt &&
    Number.isFinite(startsAt) &&
    Number.isFinite(endsAt) &&
    startsAt <= nowMs &&
    endsAt > nowMs
  );
}

function formatRadiusMeters(radiusM: number): string {
  if (radiusM >= 1000) return `${(radiusM / 1000).toFixed(radiusM % 1000 === 0 ? 0 : 1)}km`;
  return `${Math.round(radiusM)}m`;
}

function formatCoordinatePair(center: EventCenter): string {
  return `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`;
}

function normalizeShopLevelConfig(config: ShopLevelConfig | null | undefined): ShopLevelConfig {
  const thresholds = Array.isArray(config?.thresholdsPoints)
    ? config.thresholdsPoints
        .map(Number)
        .filter((threshold) => Number.isFinite(threshold) && threshold > 0)
        .slice(0, 5)
    : DEFAULT_SHOP_LEVEL_THRESHOLDS_POINTS;
  const bonusPointsPerLevel = Number(config?.bonusPointsPerLevel);

  return {
    thresholdsPoints: thresholds.length === 5
      ? thresholds
      : DEFAULT_SHOP_LEVEL_THRESHOLDS_POINTS,
    bonusPointsPerLevel: Number.isFinite(bonusPointsPerLevel) && bonusPointsPerLevel > 0
      ? bonusPointsPerLevel
      : DEFAULT_SHOP_LEVEL_BONUS_POINTS
  };
}

function getShopLevelModel(lifetimeIncome: number, config: ShopLevelConfig): ShopLevelModel {
  const safeConfig = normalizeShopLevelConfig(config);
  const safeLifetime = Math.max(0, Number(lifetimeIncome) || 0);
  const currentLevel = safeConfig.thresholdsPoints.reduce((level, threshold) => {
    return safeLifetime >= threshold ? level + 1 : level;
  }, 0);
  const previousThreshold = currentLevel > 0
    ? safeConfig.thresholdsPoints[currentLevel - 1]
    : 0;
  const nextThreshold = currentLevel < safeConfig.thresholdsPoints.length
    ? safeConfig.thresholdsPoints[currentLevel]
    : null;
  const nextSpan = nextThreshold === null
    ? 1
    : Math.max(1, nextThreshold - previousThreshold);

  return {
    currentLevel,
    currentVisual: currentLevel > 0 ? SHOP_LEVEL_VISUALS[currentLevel - 1] : null,
    nextLevel: nextThreshold === null ? null : currentLevel + 1,
    nextVisual: nextThreshold === null ? null : SHOP_LEVEL_VISUALS[currentLevel],
    previousThreshold,
    nextThreshold,
    progress: nextThreshold === null
      ? 1
      : Math.max(0, Math.min(1, (safeLifetime - previousThreshold) / nextSpan)),
    bonusPointsPerHour: currentLevel * safeConfig.bonusPointsPerLevel
  };
}

function TokenProgressRing({
  progress,
  color,
  pulseKey,
  label
}: {
  progress: number;
  color: string;
  pulseKey: number;
  label: string;
}) {
  return (
    <span
      key={pulseKey}
      className={pulseKey > 0 ? "token-progress-ring token-progress-ring--pulse" : "token-progress-ring"}
      style={{
        "--token-progress": `${Math.max(0, Math.min(1, progress)) * 360}deg`,
        "--token-color": color
      } as Record<string, string>}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}

function PinDetail({
  pin,
  shopLevelConfig,
  isOwner,
  nowMs,
  onRequestRestock,
  onRequestRadiusUpgrade,
  isBusy
}: {
  pin: GamePin;
  shopLevelConfig: ShopLevelConfig;
  isOwner: boolean;
  nowMs: number;
  onRequestRestock: () => void;
  onRequestRadiusUpgrade: () => void;
  isBusy: boolean;
}) {
  const canUpgradeRadius = isOwner && pin.radiusLevel < GAME_CONFIG.radiusUpgradeMaxLevel;

  return (
    <div className="detail-grid">
      <ShopLevelProgressStrip pin={pin} config={shopLevelConfig} />
      <div className="metric-card">
        <span>Owner</span>
        <strong className="metric-card__value">
          <ColorDot color={pin.ownerColor} />
          {pin.ownerName}
        </strong>
      </div>
      <div className="metric-card">
        <span>Popularity</span>
        <strong>{pin.busyLabel}</strong>
      </div>
      <div className="metric-card">
        <span>Income</span>
        <strong>{formatHourlyTokenRate(pin.currentHourlyRate)}</strong>
      </div>
      <div className="metric-card">
        <span>Competition</span>
        <strong>{formatRate(pin.competitionPressure)}</strong>
      </div>
      <div className="metric-card">
        <span>Radius</span>
        <strong>{formatRadius(pin)}</strong>
      </div>
      <div className="metric-card">
        <span>Lifetime Sales</span>
        <strong>{formatSalesAmount(pin.lifetimeIncome)}</strong>
      </div>
      <RestockStatusStrip pin={pin} nowMs={nowMs} />
      {isOwner && pin.pinType === "standard" ? (
        <button className="secondary-action" type="button" onClick={onRequestRestock} disabled={isBusy}>
          <PackageCheck size={18} />
          Restock Now
        </button>
      ) : null}
      {canUpgradeRadius ? (
        <button className="upgrade-action" type="button" onClick={onRequestRadiusUpgrade} disabled={isBusy}>
          <MapPin size={18} />
          Upgrade Radius
        </button>
      ) : null}
    </div>
  );
}

function RestockStatusStrip({
  pin,
  nowMs
}: {
  pin: GamePin;
  nowMs: number;
}) {
  const progress = getRestockProgress(pin, nowMs);
  const className = pin.pinType === "standard"
    ? "status-strip status-strip--restock"
    : "status-strip";

  return (
    <div
      className={className}
      style={{ "--restock-progress": `${progress}` } as Record<string, string>}
    >
      <Timer size={16} />
      <span>{formatPinTiming(pin, nowMs)}</span>
    </div>
  );
}

function RestockConfirmPanel({
  pin,
  shopLevelConfig,
  pointsBalance,
  isBusy,
  onConfirm,
  onCancel
}: {
  pin: GamePin;
  shopLevelConfig: ShopLevelConfig;
  pointsBalance: number;
  isBusy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const hasEnoughTokens = pointsBalance >= GAME_CONFIG.restockCost;

  return (
    <section className="screen-panel screen-panel--confirm" role="dialog" aria-modal="true">
      <div className="screen-panel__header">
        <div className="section-title">
          <PackageCheck size={20} />
          <h2>Restock</h2>
        </div>
        <button className="icon-button" type="button" onClick={onCancel} title="Close">
          <X size={20} />
        </button>
      </div>
      <div className="screen-panel__body">
        <div className="confirm-stack">
          <p className="confirm-question">
            Spend {formatCompactTokenCost(GAME_CONFIG.restockCost)} to restock?
          </p>
          <div className="selected-build-type">
            <span>
              <strong>
                <ShopNameWithLevel pin={pin} config={shopLevelConfig} />
              </strong>
              <small>{pin.busyLabel} · {formatHourlyTokenRate(pin.currentHourlyRate)}</small>
            </span>
            <b>{formatCompactTokenCost(GAME_CONFIG.restockCost)}</b>
          </div>
          {!hasEnoughTokens ? <p className="muted">Not enough tokens.</p> : null}
          <div className="build-confirm-actions">
            <button className="secondary-action" type="button" onClick={onCancel} disabled={isBusy}>
              Cancel
            </button>
            <button
              className="primary-action"
              type="button"
              onClick={onConfirm}
              disabled={isBusy || !hasEnoughTokens}
            >
              <PackageCheck size={18} />
              Confirm
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function RadiusUpgradeConfirmPanel({
  pin,
  shopLevelConfig,
  pointsBalance,
  isBusy,
  onConfirm,
  onCancel
}: {
  pin: GamePin;
  shopLevelConfig: ShopLevelConfig;
  pointsBalance: number;
  isBusy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const hasEnoughTokens = pointsBalance >= GAME_CONFIG.radiusUpgradeCost;
  const currentRadius = competitionRadiusForLevel(pin.radiusLevel);
  const nextRadius = competitionRadiusForLevel(pin.radiusLevel + 1);

  return (
    <section className="screen-panel screen-panel--confirm" role="dialog" aria-modal="true">
      <div className="screen-panel__header">
        <div className="section-title">
          <MapPin size={20} />
          <h2>Radius</h2>
        </div>
        <button className="icon-button" type="button" onClick={onCancel} title="Close">
          <X size={20} />
        </button>
      </div>
      <div className="screen-panel__body">
        <div className="confirm-stack">
          <p className="confirm-question">
            Spend 3 tokens to double radius?
          </p>
          <div className="selected-build-type">
            <span>
              <strong>
                <ShopNameWithLevel pin={pin} config={shopLevelConfig} />
              </strong>
              <small>{currentRadius}m to {nextRadius}m</small>
            </span>
            <b>{formatCompactTokenCost(GAME_CONFIG.radiusUpgradeCost)}</b>
          </div>
          {!hasEnoughTokens ? <p className="muted">Not enough tokens.</p> : null}
          <div className="build-confirm-actions">
            <button className="secondary-action" type="button" onClick={onCancel} disabled={isBusy}>
              Cancel
            </button>
            <button
              className="primary-action"
              type="button"
              onClick={onConfirm}
              disabled={isBusy || !hasEnoughTokens}
            >
              <MapPin size={18} />
              Confirm
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function DeleteBulletinConfirmPanel({
  bulletin,
  isBusy,
  onConfirm,
  onCancel
}: {
  bulletin: Bulletin;
  isBusy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="screen-panel screen-panel--confirm" role="dialog" aria-modal="true">
      <div className="screen-panel__header">
        <div className="section-title">
          <MessageSquare size={20} />
          <h2>Delete</h2>
        </div>
        <button className="icon-button" type="button" onClick={onCancel} title="Close">
          <X size={20} />
        </button>
      </div>
      <div className="screen-panel__body">
        <div className="confirm-stack">
          <p className="confirm-question">Delete this bulletin?</p>
          <div className="selected-build-type">
            <span>
              <strong>{bulletin.title}</strong>
              <small>Players will no longer see this message.</small>
            </span>
          </div>
          <div className="build-confirm-actions">
            <button className="secondary-action" type="button" onClick={onCancel} disabled={isBusy}>
              Cancel
            </button>
            <button className="danger-action" type="button" onClick={onConfirm} disabled={isBusy}>
              Delete
            </button>
          </div>
        </div>
      </div>
    </section>
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

function requireBulletinImageFile(file: File | null): File {
  if (!file) throw new Error("Add a bulletin image.");
  return file;
}

function readBoundedNumber(value: string, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number.`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function ensureIncreasingThresholds(thresholdsPoints: number[]): void {
  if (thresholdsPoints.length !== SHOP_LEVEL_VISUALS.length) {
    throw new Error("Enter exactly five shop level thresholds.");
  }

  for (let index = 0; index < thresholdsPoints.length; index += 1) {
    if (thresholdsPoints[index] <= 0) {
      throw new Error("Shop level thresholds must be positive.");
    }

    if (index > 0 && thresholdsPoints[index] <= thresholdsPoints[index - 1]) {
      throw new Error("Shop level thresholds must increase.");
    }
  }
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

function formatRestock(value: string | null, nowMs: number): string {
  if (!value) return "No deadline";
  const diffMs = new Date(value).getTime() - nowMs;
  if (diffMs <= 0) return "Needs restock";
  const hours = Math.ceil(diffMs / 3_600_000);
  if (hours > 24) return `${Math.ceil(hours / 24)}d stocked`;
  return `${hours}h stocked`;
}

function formatExpiry(value: string | null, nowMs: number): string {
  if (!value) return "No expiry";
  const diffMs = new Date(value).getTime() - nowMs;
  if (diffMs <= 0) return "Expired";
  const hours = Math.ceil(diffMs / 3_600_000);
  if (hours > 24) return `${Math.ceil(hours / 24)}d until removed`;
  return `${hours}h until removed`;
}

function formatPinTiming(pin: GamePin, nowMs: number): string {
  if (pin.status !== "stocked") return formatStatus(pin.status);
  if (pin.pinType === "temporary") return formatExpiry(pin.expiresAt, nowMs);
  return formatRestock(pin.restockDueAt, nowMs);
}

function getRestockProgress(pin: GamePin, nowMs: number): number {
  if (pin.pinType !== "standard" || !pin.restockDueAt) return 0;

  const dueMs = new Date(pin.restockDueAt).getTime();
  if (!Number.isFinite(dueMs) || dueMs <= nowMs) return 0;

  const startMs = new Date(pin.lastRestockedAt ?? pin.placedAt).getTime();
  const fallbackStartMs = dueMs - GAME_CONFIG.standardRestockHours * 3_600_000;
  const effectiveStartMs = Number.isFinite(startMs) ? startMs : fallbackStartMs;
  const totalMs = Math.max(1, dueMs - effectiveStartMs);

  return Math.max(0, Math.min(1, (dueMs - nowMs) / totalMs));
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

function formatRadius(pin: GamePin): string {
  return `${competitionRadiusForLevel(pin.radiusLevel)}m`;
}

function formatHourlyTokenRate(pointsPerHour: number | null | undefined): string {
  const points = Number.isFinite(pointsPerHour) ? Number(pointsPerHour) : 0;
  const tokensPerHour = points / GAME_CONFIG.tokenUnit;
  const sign = tokensPerHour >= 0 ? "+" : "";
  return `${sign}${tokensPerHour.toFixed(2)}/h`;
}

function formatCompactTokenCost(points: number): string {
  return (points / GAME_CONFIG.tokenUnit)
    .toFixed(2)
    .replace(/^0\./, ".")
    .replace(/\.00$/, "");
}

function formatSalesAmount(points: number): string {
  return (Math.max(0, points) / GAME_CONFIG.tokenUnit).toFixed(2);
}

function pointsToTokenInput(points: number): string {
  return (points / GAME_CONFIG.tokenUnit)
    .toFixed(2)
    .replace(/\.?0+$/, "");
}

function ShopNameWithLevel({
  pin,
  config
}: {
  pin: GamePin;
  config: ShopLevelConfig;
}) {
  const level = getShopLevelModel(pin.lifetimeIncome, config);
  const visual = level.currentVisual ?? level.nextVisual;

  return (
    <span className="shop-name-with-level">
      <span>{pin.name}</span>
      {visual ? (
        <ShopLevelIcon
          visual={visual}
          isPending={!level.currentVisual}
        />
      ) : null}
    </span>
  );
}

function ShopLevelProgressStrip({
  pin,
  config
}: {
  pin: GamePin;
  config: ShopLevelConfig;
}) {
  const level = getShopLevelModel(pin.lifetimeIncome, config);
  const earnedColor = level.currentVisual?.color ?? SHOP_LEVEL_VISUALS[0].color;
  const nextColor = level.nextVisual?.color ?? level.currentVisual?.color ?? SHOP_LEVEL_VISUALS[0].color;
  const salesLabel = level.nextThreshold
    ? `${formatSalesAmount(pin.lifetimeIncome)} / ${formatSalesAmount(level.nextThreshold)} sales`
    : `${formatSalesAmount(pin.lifetimeIncome)} sales · max level`;

  return (
    <div
      className="shop-level-progress"
      style={{
        "--shop-level-progress": `${level.progress}`,
        "--shop-level-earned-color": earnedColor,
        "--shop-level-next-color": nextColor
      } as Record<string, string>}
      role="progressbar"
      aria-label={`Shop level progress: ${salesLabel}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level.progress * 100)}
      title={salesLabel}
    />
  );
}

function ShopLevelIcon({
  visual,
  isPending = false
}: {
  visual: (typeof SHOP_LEVEL_VISUALS)[number];
  isPending?: boolean;
}) {
  return (
    <span
      className={[
        "shop-level-icon",
        isPending ? "shop-level-icon--pending" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ "--shop-level-color": visual.color } as Record<string, string>}
      role="img"
      title={visual.label}
      aria-label={visual.label}
    >
      {"•".repeat(visual.dots)}
    </span>
  );
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
