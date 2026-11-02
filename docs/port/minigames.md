# Swoop racing and turret minigames

Covers `src/module/ModuleMiniGame.ts`, `ModuleMGPlayer.ts`, `ModuleMGEnemy.ts`, `ModuleMGObstacle.ts`,
`ModuleMGGunBank.ts`, `ModuleMGGunBullet.ts`, the `SWMG_*` routines in `src/nwscript/builtins/minigame.ts`
(plus the seven preserved upstream bodies in `builtins/upstream/minigame.ts` that now delegate to it), and the
minigame key bindings in `src/controls/IngameControls.ts`.

## Runtime model

- **Events.** Every minigame script runs through `ModuleMiniGame.dispatchEvent(object, scriptKey, context, fallback)`.
  It installs the event context that `SWMG_GetLastEvent`, `SWMG_GetLastEventModelName`, `SWMG_GetLastBulletHit*`,
  `SWMG_GetLastBulletFired*`, `SWMG_GetLastFollowerHit`, `SWMG_GetLastObstacleHit` and `SWMG_GetLastHPChange` read
  for the duration of the handler. A nested dispatch (for example `OnDamage` raised by `SWMG_OnBulletHit` inside
  `OnHitBullet`) gets its own context, and the outer handler's values come back when it returns.
  `SWMG_GetLastEvent` is the script key (`OnHitObstacle`, `OnTrackLoop`, `OnAccelerate`, `OnHitBullet`, ...), or
  the MDL animation event name inside `OnAnimEvent`. The model name is the model that was hit into (or the bullet
  model) for hit events, otherwise the object's own first model.
- **Defaults.** When an object has no script for `OnHitBullet`, `OnHitObstacle`/`OnHitFollower` (player),
  `OnDamage` or `OnDeath`, the engine default runs. Scripts reach the same defaults through
  `SWMG_OnBulletHit` (OBJECT_SELF takes the bullet's damage), `SWMG_OnObstacleHit`, `SWMG_OnDamage` (damage
  animation) and `SWMG_OnDeath` (death animation; followers stop following their track).
- **Lifecycle.** `OnCreate` runs once per object (enemies, obstacles, then the player). The area calls both
  `initMiniGameObjects` and `runMiniGameScripts`; the second call used to run every enemy's `OnCreate` again.
  `OnHeartbeat` fires every 3 seconds per created object (player, followers, obstacles).
- **Collisions** are done in world space. The player and followers ride their track's `modelhook`, obstacles
  sit at their LYT position (default radius 1, `SWMG_SetSphereRadius` overrides). Entering a sphere fires the
  player's `OnHitFollower`/`OnHitObstacle` and then the other object's `OnHitFollower`, once per contact.
  Bullets use a swept segment-vs-sphere test, so fast bullets cannot pass through a target between frames.

## Swoop racing (Type 1)

- Speed climbs at `Accel_Secs` toward the current gear's cap. There are 5 gears; gear *n* caps speed at
  `Minimum_Speed + (Maximum_Speed - Minimum_Speed) * (n + 1) / 5`. The action key (`MGshoot`) shifts up and fires
  `OnAccelerate`. A boost above the cap bleeds back down at `Accel_Secs`.
- Default obstacle/follower hit: anything named `*accel*`/`*boost*` is an accelerator pad (speed to
  `Maximum_Speed`, `OnAccelerate`). Anything else is a crash unless the swoop is invulnerable: `Bump_Damage`,
  speed back to `Minimum_Speed` in first gear, `Invince_Period` of invulnerability, `OnBrake`.
- Steering (`MGActionLeft/Right`) is applied for the frames the key is held; it no longer sticks after release.
- Jumping (`MGActionUp`) is off until a script sets a jump speed (TSL `SWMG_SetJumpSpeed`). Airborne swoops
  skip collisions.
- Each track length travelled is one `OnTrackLoop`; the swoop returns to the start of the track. Lap times are
  kept on the player (`lapTimes`, `finishTime` once `Num_Loops` laps are done). The track length is the distance
  from the track start to the far end of the area's room geometry along +Y, unless set explicitly.

## Turret (Type 2)

- Holding fire fires every gun bank as fast as its time between shots allows. Each bullet copies the bank's
  current stats, so `SWMG_SetGunBankDamage/Speed/Lifespan/TimeBetweenShots/Target/BulletModel` affect the next shot.
  Firing raises the owner's `OnFire` with `SWMG_GetLastBulletFired*` set.
- Player bullets hit live, non-trigger followers and obstacles. Enemy bullets hit the player. Hits raise the
  target's `OnHitBullet`; damage goes through `OnDamage` and, at 0 hit points, `OnDeath` exactly once.
  Invulnerable objects take no damage. Win/lose decisions belong to those scripts.
- Enemy gun banks fire when the player's collision sphere is on their line of fire (the axis bullets travel
  along) and, if `Sensing_Radius` is set, in range. `SWMG_IsGunBankTargetting` reports that state.

## Save/load

Mid-minigame save/load is unsupported: minigame runtime state is not serialized. The fail-safe is
`SaveGame.CanSaveCurrentGame()`, which refuses any save while the area has a minigame (and in minigame mode),
so no save ever holds a half-run race or fight. Area saves keep the ARE `MiniGame` template, so re-entering
the module starts the minigame fresh. Pinned by `src/tests/minigames/minigame-save-guard.test.ts`.

## Tests

`src/tests/minigames/swoop-turret.test.ts` and `swoop-turret-routines.test.ts` run the real minigame classes
headless (synthetic ARE structs, `THREE.Object3D` tracks with a `modelhook`, fake scripts, a fixed time step)
and call every `SWMG_*` routine through the reconciled K1 and TSL action maps.

## Not verified against the retail engine

No game assets or retail executable were used. These are reasoned choices, not observed behavior:
the gear count and gear caps; that accelerator pads are recognized by name; the crash response; jump physics
(9.8 m/s²); heartbeat cadence (3 s, as for other objects); `SWMG_GetLastEvent` returning the script key for
non-animation events; the model name reported for hit events; `SWMG_GetLastBulletHitPart` being the target's
model name; follower names coming from the first model; trigger followers (`Trigger` = 1) never shooting or being
shot; sound slot defaults (volume 127; the settings are stored but drive no audio yet); the meaning of the TSL-only
`SWMG_GetTrackPosition`, `SWMG_SetFollowerPosition` (sets OBJECT_SELF's track offset, returns its world position)
and `SWMG_PlayerApplyForce` (one-frame displacement); the track-length-from-rooms rule; firing along local +Y.
Obstacle models from the LYT are still not rendered. Speed blur (`SWMG_SetSpeedBlurEffect`) remains a no-op.
