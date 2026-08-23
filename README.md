# I KNOW THAT! — v1.1 Functional Test Build

This is the first **assembled functional test**.

## What is wired now

### Full flow
Home → game mode → players/teams → TV connection → instructions → questions → scoring → final results.

### Individual games
- NEXT GEN
- OLD SCHOOL
- Up to 10 players
- Hint 1 / Hint 2
- Reveal
- Award point
- Pass
- Next is locked until the question is resolved
- Change Question
- Undo
- Show Score
- Pause TV
- Final champion

### FAMILY SHOWDOWN
- Next Gen vs Old School
- Q1–5 = 1 point
- Q6–10 = 2 points
- Q11–15 = 3 points
- Q16–20 = 4 points
- Miss → steal workflow
- Pass
- Bonus Vault
- Rapid Fire
- Omega
- Logo Challenge
- Final team winner screen

## Immediate testing — no Firebase required

Open `index.html` through a local web server or GitHub Pages.

Use the Host's **TV PREVIEW** button. The built-in preview renders from the exact same game state, so you can test the entire game logic immediately without BroadcastChannel or localStorage.

This is intentional: no more temporary cross-tab sync patches.

## True Host ↔ TV cross-device sync

The code already contains a Cloud Firestore session adapter.

1. Create/use a Firebase project specifically for I KNOW THAT!
2. Enable Cloud Firestore.
3. Edit `firebase-config.js`.
4. Paste the Firebase Web App config.
5. Deploy the included `firestore.rules` for this family-test build.
6. Host the folder on GitHub Pages (or any static host).
7. Host creates a game.
8. TV opens the generated link:
   `index.html?view=tv&code=ABCD`

The TV sends a heartbeat every 10 seconds. The Host shows TV CONNECTED when it has seen the display recently.

## Important testing note

The included Firestore rules are deliberately simple for family testing and are **not intended as hardened public production security**. A later production pass should separate private Host state from public Display state or add authentication.

## Question data

Question content is separate from application code in `questions.js`.

This build contains a compact functional test bank:
- 10 Next Gen
- 10 Old School
- 20 Family Showdown
- 10 Bonus Vault
- Omega
- Rapid Fire placeholders

The larger cleaned question banks can replace/extend this file without redesigning the app.

## Visual questions

The real photo/logo asset bank has not been inserted yet. Visual rounds currently use placeholders, matching the approved prototype plan.

## Files

- `index.html` — app entry
- `styles.css` — locked visual language assembled into the app
- `app.js` — game engine, Host, TV renderer, Firestore sync
- `questions.js` — question database
- `firebase-config.js` — trivia-game Firebase config
- `firestore.rules` — temporary family-test rules
- `assets/compact_logo.png` — approved compact logo


## v1.1 fixes
- Show Score is now a working toggle and automatically opens the built-in TV Preview in demo mode.
- Pause TV is now a working Pause / Resume toggle and automatically opens the TV Preview in demo mode.
- Undo now reverses the last gameplay action, including Hint, Reveal, scoring, Pass, steal decisions, and question changes.
- Undo no longer changes the current TV display mode.
- Individual score lists sort highest score to lowest on both Host and TV.
- Gameplay starts with a clean Undo history so Undo cannot accidentally send the Host back to setup/instructions.

## v1.2 Showdown steal-flow correction

Family Showdown now keeps the answer hidden until the answering sequence is finished:

1. Current team answers.
2. Host marks **Correct**, **Missed → Steal**, or **Pass** before any answer reveal.
3. If missed, the other team gets a steal chance while the answer remains hidden.
4. Host marks the steal Correct or Missed.
5. Only after the outcome is final does the answer appear on the TV.

This prevents the stealing generation from seeing the answer before its attempt.


## v1.3 Individual Specials

The Specials button is active in all game modes.

Individual games show:
- Logo Challenge
- Who Am I?
- What Is This?
- Name That Artist
- Movie / TV Challenge

Individual special questions are worth 1 point and do not advance the regular question count.

Family Showdown additionally has:
- Bonus Vault
- Rapid Fire
- Omega



## v1.4 Host Answer / Wrong-Answer Flow

Normal gameplay now follows a game-show-safe flow:

- Host always sees the correct answer privately.
- Host always sees Hint 1 and Hint 2 privately.
- Hint buttons mean SHOW HINT ON TV.
- SHOW ANSWER ON TV is separate from scoring.
- Individual WRONG flashes a large red X on the TV and keeps the answer hidden so another player can answer.
- Family Showdown WRONG flashes the X and moves to the steal team without exposing the answer.
- Correct scoring does not automatically expose the answer.
- Pass does not automatically expose the answer.
- Next Question stays locked until:
  1. the question is scored or passed, and
  2. the Host has shown the answer on the TV.


## v1.5 Wrong-Answer Feedback Fix

- Wrong-answer TV reaction is now rendered as a global TV overlay rather than being tied only to the normal-question template.
- The large red X therefore works on normal questions and special rounds.
- The X stays visible for 2 seconds.
- The Host WRONG button visibly changes to "WRONG SENT TO TV" while the TV reaction is active.
- Family Showdown also displays a Host-side "WRONG SENT TO TV" confirmation as it moves into the steal state.


## v1.6 Demo TV Reaction Fix

When Firebase is not configured, TV reactions now automatically open the built-in TV Preview.

This fixes the testing problem where the 2-second Wrong X could finish before the Host manually switched to TV Preview.

- Tap WRONG on the Host.
- TV Preview opens immediately.
- The large red X is already visible.
- Reaction display time is 2.5 seconds.
- With Firebase enabled, the separate TV continues to receive the reaction normally and no automatic preview is opened.


## v1.7 Special Round Structure

Regular specials are now five-question mini-rounds instead of one-question detours.

Applies to:
- Logo Challenge
- Who Am I?
- What Is This?
- Name That Artist
- Movie / TV Challenge

Changes:
- Each regular special contains 5 test questions.
- After a question is scored/passed and the answer is shown, the Host gets NEXT SPECIAL QUESTION.
- The Host can optionally RETURN TO MAIN GAME at any time.
- The fifth question finishes the special round.
- Regular special Host and TV screens now use the same locked game-card structure as normal gameplay.
- Question/visual remains on the left.
- Scoreboard remains on the right at all times.
- Player names and scores are no longer displayed inside the question card.
- Special progress is shown along the bottom.


## v1.8 Family Showdown Correct Flow

Family Showdown correct answers are now a one-tap Host action.

- Tap NEXT GEN CORRECT / OLD SCHOOL CORRECT.
- Points are awarded immediately.
- The TV immediately gets the large CORRECT reaction.
- The correct answer is revealed automatically behind the reaction.
- When the reaction clears, the answer is already visible.
- Next Question is immediately ready.

The same one-tap behavior applies to a successful steal.

Pass and missed-steal outcomes still require SHOW ANSWER ON TV because no team earned the answer/points.


## v1.9 Unified Score/Reveal Flow + Specials Cleanup

Universal score flow:
- Wrong = large X only; answer stays hidden so someone else can answer.
- Awarding a point/team score automatically reveals the answer.
- Passing automatically reveals the answer and shows NO POINTS.
- TV scoring reaction shows the player/team name and points awarded.
- The word CORRECT is not used for score-result reactions.

Specials:
- Bonus Vault now uses the same question-card layout as regular Showdown.
- Team score remains on the right.
- Bonus values are labeled BONUS POINT VALUE (+1 / +2 / +3 / +5).
- Host always sees Bonus answer + Hint 1 + Hint 2.
- Bonus wrong keeps the question open.
- Bonus score/pass reveals automatically.
- Regular Logo / Who Am I / What Is This / Artist / Movie-TV specials use the same score/reveal rule in individual and Showdown modes.
- Omega now shows Host-only answer + hints and uses the same card/right-score visual structure.

Rapid Fire:
- +1 · NEXT LOGO immediately advances to the next item.
- PASS · NEXT LOGO immediately advances.
- Each +1 immediately increases the active team's main score.
- Host sees the current answer privately.
- TV keeps timer and team score on the right.


## v2.0 Universal Reveal Timing

Every normal question and answer-based special now uses the same TV sequence:

1. The answer is revealed by itself for 2 seconds.
2. The score / player / team / NO POINTS result appears for 2 seconds.
3. The result animation disappears.
4. The revealed answer remains visible on the question card.
5. Next Question / Next Special Question is ready.

This applies to:
- Next Gen
- Old School
- Family Showdown
- Bonus Vault
- Logo Challenge
- Who Am I?
- What Is This?
- Name That Artist
- Movie / TV Challenge
- Omega

Wrong-answer X behavior is unchanged:
- Wrong flashes the X.
- The answer stays hidden.
- Another player/team can still answer.

Rapid Fire intentionally remains the timed exception:
- +1 immediately advances to the next logo.
- Pass immediately advances to the next logo.


## v2.1 Visual Restore
- TV welcome / connected screen restored to the approved three-step display-home style.
- TV gameplay header restored to the approved centered logo with full-width retro stripes.
- TV right-side scoreboard restyled to match the approved scoreboard look.
- Host-side game logic from v2.0 remains intact.
