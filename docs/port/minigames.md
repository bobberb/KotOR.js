# Swoop racing and turret minigames

Covers `src/module/ModuleMiniGame.ts`, `ModuleMGPlayer.ts`, `ModuleMGEnemy.ts`, `ModuleMGObstacle.ts`,
`ModuleMGGunBank.ts`, `ModuleMGGunBullet.ts`, the `SWMG_*` routines in `src/nwscript/builtins/minigame.ts`
(plus the seven preserved upstream bodies in `builtins/upstream/minigame.ts` that now delegate to it), the
minigame key processors in `src/controls/MiniGameControls.ts` (registered by `IngameControls.ts`), and the
DelayCommand context capture in `builtins/scripting.ts` / `src/events/EventTimedEvent.ts`.

## Runtime model

- **Events.** Every minigame script runs through `ModuleMiniGame.dispatchEvent(object, scriptKey, context, fallback)`.
  Each event gets a **fresh** context, which `SWMG_GetLastEvent`, `SWMG_GetLastEventModelName`,
  `SWMG_GetLastBulletHit*`, `SWMG_GetLastBulletFired*`, `SWMG_GetLastFollowerHit`, `SWMG_GetLastObstacleHit` and
  `SWMG_GetLastHPChange` read while the handler runs. Nothing carries over from an enclosing event or from calls
  made outside any handler. A nested event (for example `OnDamage` raised by `SWMG_OnBulletHit` inside
  `OnHitBullet`) gets its own context, and the outer handler's context comes back when it returns. Outside any
  handler the routines return empty values. `SWMG_AdjustFollowerHitPoints`/`SWMG_SetFollowerHitPoints` record
  `GetLastHPChange` only inside a handler.
- **Scheduled work.** `DelayCommand` called inside a minigame handler stores a snapshot of that event's context on
  the timed event (`EventTimedEvent.miniGameContext`, runtime only, never saved). The delayed action reads it when
  it runs. `AssignCommand` runs synchronously, so it already runs inside the event.
- `SWMG_GetLastEvent` is the script key (`OnHitObstacle`, `OnTrackLoop`, `OnAccelerate`, `OnHitBullet`, ...), or
  the MDL animation event name inside `OnAnimEvent`. For hit events the model name is the other party's model (or
  the bullet model); for other events it is the object's own first model.
- **Hit pair.** In the player's `OnHitObstacle`/`OnHitFollower`, the obstacle or follower is the thing hit. In an
  obstacle's `OnHitFollower`, `GetLastFollowerHit` is the player and `GetLastObstacleHit` is the obstacle itself.
- **Defaults.** When an object has no script for `OnHitBullet`, `OnHitObstacle`/`OnHitFollower` (player),
  `OnDamage` or `OnDeath`, the engine default runs. Scripts reach the same defaults through:
  - `SWMG_OnBulletHit`: OBJECT_SELF takes the bullet's damage.
  - `SWMG_OnObstacleHit`: resolved from the caller's side. Called by the player, it applies to the object the
    player hit; called by an obstacle or follower, it applies with that object as the thing hit. It runs at most
    once per contact, so the player's script and the obstacle's script can both call it without doubling it.
  - `SWMG_OnDamage`: damage animation.
  - `SWMG_OnDeath`: death animation; followers stop following their track.
- **Lifecycle.** `OnCreate` runs once per object (enemies, obstacles, then the player). The area calls both
  `initMiniGameObjects` and `runMiniGameScripts`; the second call used to run every enemy's `OnCreate` again.
  `OnHeartbeat` fires every 3 seconds per created object (player, followers, obstacles).
- **Collisions** are done in world space. The player and followers ride their track's `modelhook`; obstacles sit
  at their LYT position (default radius 1; `SWMG_SetSphereRadius` overrides). Entering a sphere fires the player's
  `OnHitFollower`/`OnHitObstacle`, then the other object's `OnHitFollower`, once per contact, until the spheres
  separate. Bullets use a swept segment-vs-sphere test, so fast bullets cannot pass through a target between frames.

## Swoop racing (Type 1)

- **Speed and gears.** Speed climbs at `Accel_Secs` toward the current gear's cap. There are 5 gears; gear *n*
  caps speed at `Minimum_Speed + (Maximum_Speed - Minimum_Speed) * (n + 1) / 5`.
  - The action key (`MGshoot`) shifts up and fires `OnAccelerate`, but only once speed reaches 90% of the current
    gear's cap (`SHIFT_WINDOW`).
  - A shift happens on the press: holding the key, or OS key repeat, does not shift again until it is released.
  - A crash drops back to first gear.
  - A boost above the cap bleeds back down at `Accel_Secs`.
- **Default obstacle/follower hit.** Anything named `*accel*`/`*boost*` is an accelerator pad: speed goes to
  `Maximum_Speed` and `OnAccelerate` fires. Anything else is a crash unless the swoop is invulnerable:
  `Bump_Damage`, speed back to `Minimum_Speed` in first gear, `Invince_Period` of invulnerability, `OnBrake`.
- **Steering** (`MGActionLeft/Right`, keyboard or gamepad held state) sets an input that is consumed every frame.
  - The steering rate defaults to ARE `LateralAccel` until a script calls `SWMG_SetLateralAccelerationPerSecond`.
  - Lateral speed is capped by ARE `MovementPerSec` when it is set.
  - Without `UseInertia` the swoop slides at full lateral speed while steering and stops on release. With
    `UseInertia` it accelerates and coasts down at the lateral acceleration.
  - The lateral offset from the lane centre is clamped to `TunnelXNeg..TunnelXPos`, as authored in the template,
    unless the X axis is infinite. Hitting the wall stops lateral motion.
- **Jumping** (`MGActionUp`) is off until a script sets a jump speed (TSL `SWMG_SetJumpSpeed`). Airborne swoops
  skip collisions.
- **Laps.** If the player's track model has an animation, that animation carries the rider: it loops at a
  playback rate of `speed / Maximum_Speed` (1 when there is no maximum), and each loop is one `OnTrackLoop`. This
  is the same `elapsedCount` mechanism followers use.
  - A track with no animation only loops when `trackLength` is set explicitly. Then each length travelled is one
    `OnTrackLoop`, and the track jumps back to its start.
  - Without an animation or an explicit length there are no laps. Lap length is never guessed from room geometry.
  - Lap times are kept on the player: `lapTimes`, and `finishTime` once `Num_Loops` laps are done (set once).

## Turret (Type 2)

- **Aiming.** Each axis is clamped to its tunnel limits unless `TunnelInfinite` (`Tunnellnfinite` in some retail
  templates) frees that axis.
- **Player fire.** Holding fire (keyboard or gamepad held state) fires every gun bank as fast as its time between
  shots allows. Each bullet copies the bank's current stats, so
  `SWMG_SetGunBankDamage/Speed/Lifespan/TimeBetweenShots/Target/BulletModel` affect the next shot. Firing raises the
  owner's `OnFire` with `SWMG_GetLastBulletFired*` set.
- **Hits.** Player bullets hit live, non-trigger followers and obstacles. Enemy bullets hit the player. Hits raise
  the target's `OnHitBullet`; damage goes through `OnDamage` and, at 0 hit points, `OnDeath` exactly once.
  Invulnerable objects take no damage. Win/lose decisions belong to those scripts.
- **Enemy fire.** A gun bank targets the player when the player's sphere is inside its firing cone: the barrel
  axis (+Y), widened by the largest of `Horiz_Spread`, `Vert_Spread` and `Inaccuracy` (degrees), and within
  `Sensing_Radius` when that is set. Its shots are aimed at the player and deviate randomly by up to
  `Inaccuracy`. Trigger followers never fire. `SWMG_IsGunBankTargetting` reports the targeting state.

## Save/load

Mid-minigame save/load is unsupported: minigame runtime state is not serialized. The fail-safe is
`SaveGame.CanSaveCurrentGame()`, which refuses any save while the area has a minigame (and in minigame mode), so
no save ever holds a half-run race or fight. Area saves keep the ARE `MiniGame` template, so re-entering the
module starts the minigame fresh. Pinned by `src/tests/minigames/minigame-save-guard.test.ts`.

## Tests

`src/tests/minigames/swoop-turret.test.ts` and `swoop-turret-routines.test.ts` run the real minigame classes
headless: synthetic ARE structs, `THREE.Object3D` tracks with a `modelhook`, a fake animated track model, fake
scripts and a fixed time step. They drive input through `processMiniGameAction` and call every `SWMG_*` routine
through the reconciled K1 and TSL action maps.

## Not verified against the retail engine

No game assets or retail executable were used. These are reasoned choices, not observed behavior:

- **Gears:** the gear count (5) and gear caps, the 90% shift window, and dropping to first gear on a crash.
- **Collisions:** that accelerator pads are recognized by name; the crash response.
- **Steering:** the meaning of ARE `LateralAccel`/`MovementPerSec`/`UseInertia` for steering; reading the swoop
  `TunnelX` limits as track units.
- **Laps:** the animated-track lap rule and its speed-scaled playback rate.
- **Movement and timing:** jump physics (9.8 m/s²); heartbeat cadence (3 s, as for other objects).
- **Event values:**
  - `SWMG_GetLastEvent` returning the script key for non-animation events.
  - The model name reported for hit events.
  - `SWMG_GetLastBulletHitPart` being the target's model name.
  - Fresh per-event contexts. Retail may instead keep "last" values until the next event.
- **Objects and sound:** follower names coming from the first model; trigger followers (`Trigger` = 1) never
  shooting or being shot; sound slot defaults (volume 127; stored only, they drive no audio yet).
- **Enemy fire:** the spread fields as cone half-angles in degrees, and aimed enemy shots.
- **TSL-only routines:** the meaning of `SWMG_GetTrackPosition`, `SWMG_SetFollowerPosition` (sets OBJECT_SELF's
  track offset and returns its world position) and `SWMG_PlayerApplyForce` (one-frame displacement).

Obstacle models from the LYT are still not rendered. Speed blur (`SWMG_SetSpeedBlurEffect`) remains a no-op.
