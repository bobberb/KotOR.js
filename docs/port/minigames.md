# Swoop racing and turret minigames

Covers `src/module/ModuleMiniGame.ts`, `ModuleMGPlayer.ts`, `ModuleMGEnemy.ts`, `ModuleMGObstacle.ts`,
`ModuleMGGunBank.ts`, `ModuleMGGunBullet.ts`, the `SWMG_*` routines in `src/nwscript/builtins/minigame.ts`
(plus the seven preserved upstream bodies in `builtins/upstream/minigame.ts` that now delegate to it), the
minigame key processors in `src/controls/MiniGameControls.ts` (registered by `IngameControls.ts`), and the
DelayCommand context capture in `builtins/scripting.ts` / `src/events/EventTimedEvent.ts`.

## Runtime model

- **Events and last values.** Every minigame script runs through
  `ModuleMiniGame.dispatchEvent(object, scriptKey, context, fallback)`. The minigame keeps one "last values"
  record, like the engine-global retail state. `SWMG_GetLastEvent`, `SWMG_GetLastEventModelName`,
  `SWMG_GetLastBulletHit*`, `SWMG_GetLastBulletFired*`, `SWMG_GetLastFollowerHit`, `SWMG_GetLastObstacleHit` and
  `SWMG_GetLastHPChange` all read that record.
  - An event writes only the values it defines; everything else keeps its last value. So `OnDamage` raised by a
    bullet still sees the bullet's damage, shooter and part. `OnDeath` sees the HP change and the killer. A swoop's
    `OnDamage` after a crash sees the obstacle it hit.
  - Values written by a nested event (for example the `-4` HP change of `OnDamage` raised by `SWMG_OnBulletHit`
    inside `OnHitBullet`) stay visible to the outer handler. Only `event`/`modelName` revert when the nested event
    returns.
  - Values persist after the event ends, until another event overwrites them.
  - `SWMG_AdjustFollowerHitPoints`/`SWMG_SetFollowerHitPoints` record `GetLastHPChange` only inside a handler.
    Calls outside any handler write nothing.
- **Scheduled work.** `DelayCommand` called inside a minigame handler stores a snapshot of the last values on the
  timed event (`EventTimedEvent.miniGameContext`, runtime only, never saved). The delayed action reads that
  snapshot even if later events have changed the live record, which is put back afterwards. `AssignCommand` runs
  synchronously, so it already runs inside the event.
- **Time stepping.** `tick` splits a frame into steps of at most 0.25 s, so bullets, heartbeats and laps advance
  normally through a long frame. Collisions are swept within each step, so a long frame cannot skip one either. A
  frame longer than 1 s only advances 1 s, which drops a hitch such as a backgrounded tab the way a pause would.
- **Input.** Minigame input is ignored while the game is paused. After a pause, or when a menu closes back into the
  minigame (`GameState.RestoreEnginePlayMode` → `resumeInput`), a fire/shift key still held must be released and
  pressed again before it acts.
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
  separate.
  - Player contacts are swept along the player's path over each step, and the path is cut at lap resets so the
    jump back to the start is never swept through the course.
    - On a track without animation, the cut is exact: the path is swept up to the finish line and again from the
      start, so a long frame across the finish still hits an obstacle just before it.
    - On an animated track, the engine's animation manager poses the rider one update after its clock wraps, so the
      jump shows up on the step after the lap (or on the same step). Within that window, a displacement more than 3×
      the previous step's counts as the jump, and only its two end positions are tested.
  - Obstacles are static, so they are swept against the player's path segments.
    - Followers move, so they use the relative motion over the step. A follower trailing the player at the same
      speed never touches it, while one crossing the player's path inside a step does.
    - When the player's path is cut, a parked follower is swept like an obstacle and a moving one is compared at end
      positions.
    - When a follower's own track loops (a displacement more than 3× its previous step's), only end positions are
      compared.
  - Once a contact kills the swoop, no further hit events are dispatched in that step.
  - Bullets are swept too, and stop at the first sphere their path enters (nearest along the path, so an obstacle in
    front shields what is behind it). A target that already contains the bullet is hit first.

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
  `Bump_Damage`, speed back to `Minimum_Speed` in first gear, `Invince_Period` of invulnerability, `OnBrake`. If
  the bump damage is lethal, the crash ends with `OnDeath`: no speed reset, invulnerability or `OnBrake` follows.
- **Steering** (`MGActionLeft/Right`, keyboard or gamepad held state) sets an input that is consumed every frame.
  - The steering rate defaults to ARE `LateralAccel` until a script calls `SWMG_SetLateralAccelerationPerSecond`.
  - Lateral speed is capped by ARE `MovementPerSec` when it is set.
  - Without `UseInertia` the swoop slides at full lateral speed while steering and stops on release. With
    `UseInertia` it accelerates and coasts down at the lateral acceleration.
  - Steering moves the swoop along **world X**, which only suits straight courses that run along Y. The lateral
    axis of a curved animated path is not followed.
  - The lateral offset from the lane centre is clamped to the current X tunnel limits, unless the X axis is
    infinite. The lane centre is the track's start X, or the X given to `SWMG_SetPlayerOrigin`. The limits are
    `TunnelXNeg..TunnelXPos` from the template, or whatever `SWMG_SetPlayerTunnelNeg/Pos` last set. Hitting the
    wall stops lateral motion.
- **Jumping** (`MGActionUp`) is off until a script sets a jump speed (TSL `SWMG_SetJumpSpeed`). Airborne swoops
  skip collisions.
- **Laps.** If the player's track model has an animation, that animation carries the rider: it loops at a
  playback rate of `speed / Maximum_Speed`.
  - Without a `Maximum_Speed`, the rate is 1 while the swoop moves and 0 at speed 0, so a stopped swoop's track
    is frozen.
  - Laps are counted from the rider's accumulated animation time divided by the loop length, not from the
    animation manager's wraps (it wraps at most once per update and drops the remainder), so every lap is
    credited on time. Followers count their loops the same way.
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
- **Laps:** the animated-track lap rule, its speed-scaled playback rate, and the frozen track at speed 0 without
  a `Maximum_Speed`.
- **Stepping:** the 0.25 s step and 1 s frame cap.
- **Jump detection:** the 3× displacement rule that recognises a track-loop jump. On an animated track it can
  leave one step around the finish untested, because only the jump's two end positions are compared.
- **Follower motion within a step:** followers are assumed to move linearly across one step.
- **Movement and timing:** jump physics (9.8 m/s²); heartbeat cadence (3 s, as for other objects).
- **Event values:**
  - `SWMG_GetLastEvent` returning the script key for non-animation events.
  - The model name reported for hit events.
  - `SWMG_GetLastBulletHitPart` being the target's model name.
  - The exact last-value rules: which fields each event overwrites, and that writes outside a handler are dropped.
- **Objects and sound:** follower names coming from the first model; trigger followers (`Trigger` = 1) never
  shooting or being shot; sound slot defaults (volume 127; stored only, they drive no audio yet).
- **Enemy fire:** the spread fields as cone half-angles in degrees, and aimed enemy shots.
- **TSL-only routines:** the meaning of `SWMG_GetTrackPosition`, `SWMG_SetFollowerPosition` (sets OBJECT_SELF's
  track offset and returns its world position) and `SWMG_PlayerApplyForce` (one-frame displacement).

Obstacle models from the LYT are still not rendered. Speed blur (`SWMG_SetSpeedBlurEffect`) remains a no-op.
