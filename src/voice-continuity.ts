// voice-continuity — P7 D7.3 continuity helpers (Tranche A engine-side):
// the stale-repeat goodbye guard and the centralized conversation-clear.
// Both are policy the voice agent previously carried inline in three places;
// centralizing them is the fix for G-P7-8 (a clear path that empties bodhi's
// conversationContext without rebasing the transcript cursor makes the
// turn.end logger skip every item that accumulates after the clear).

import type { VoiceSession } from 'bodhi-realtime-agent';

/** State for the stale-repeat goodbye guard. */
export interface GoodbyeGuardState {
  lastText: string | null;
  userTurnsAtFire: number;
}

export function initialGoodbyeGuard(): GoodbyeGuardState {
  return { lastText: null, userTurnsAtFire: -1 };
}

/**
 * Should a strict-detected farewell fire session_end? A reconnect replay can
 * make the model repeat the SAME short farewell with no new real user turn —
 * that repeat must not re-fire the end-session machinery (the 2026-04-09
 * replay-contamination class; D7.3 Tranche A interim until bodhi's
 * epoch-fenced boundary lands). Pure: returns the decision plus next state.
 */
export function shouldFireGoodbye(
  state: GoodbyeGuardState,
  lastText: string,
  userTurnCount: number,
): { fire: boolean; next: GoodbyeGuardState } {
  if (state.lastText !== null && lastText === state.lastText && userTurnCount <= state.userTurnsAtFire) {
    return { fire: false, next: state };
  }
  return { fire: true, next: { lastText, userTurnsAtFire: userTurnCount } };
}

/**
 * Clear a dead session's Gemini resumption handle before a fresh reconnect
 * (field incident 2026-08-14): when Gemini invalidates a session it closes
 * 1008 "Requested entity was not found", and a redial that replays the dead
 * handle in `sessionResumption: { handle }` completes setup, then is killed
 * the same way (observed survival staircase: 9 min → 18 s → 0.9 s). Clearing
 * costs nothing here: this path already rebuilds context via text injection,
 * never via resume; mid-session GoAway resume (the legitimate handle use) does
 * not run through it. bodhi's clearResumption() drops both the session's and
 * the transport's copy. Returns true when a stale handle was actually cleared.
 */
export function clearStaleResumptionHandle(
  session: Pick<VoiceSession, 'clearResumption'> | null | undefined,
): boolean {
  try {
    return session?.clearResumption() ?? false;
  } catch {
    /* a failing seam must never break the reconnect path */
    return false;
  }
}

export interface ConversationClearHelper {
  /** The turn.end logger's cursor into conversationContext.items. */
  cursor: { index: number };
  /** Reset the session's conversation context (bodhi persists the items
   *  first) and rebase the cursor with it. Returns items cleared. */
  clear(reason: string): number;
}

/**
 * The ONE way to empty bodhi's conversationContext (used by end_session, the
 * goodbye detector, and the sessionEnding turn.end sweep). Items and cursor
 * move together, always.
 */
export function createConversationClearHelper(
  getSession: () => Pick<VoiceSession, 'resetConversationContext'> | null | undefined,
  log: (line: string) => void = () => {},
): ConversationClearHelper {
  const cursor = { index: 0 };
  return {
    cursor,
    clear(reason: string): number {
      let cleared = 0;
      try {
        cleared = getSession()?.resetConversationContext(reason).cleared ?? 0;
      } catch (e) {
        log(`[clear-items] ${reason}: could not clear conversationContext: ${e}`);
      }
      // The cursor rebases even when the array was empty or unreadable — a
      // stale cursor against an emptied array is exactly the G-P7-8 bug.
      cursor.index = 0;
      if (cleared > 0) log(`[clear-items] ${reason}: cleared ${cleared} conversationContext items`);
      return cleared;
    },
  };
}
