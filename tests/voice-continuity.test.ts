import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession, type LLMTransport, type VoiceSessionConfig } from 'bodhi-realtime-agent';
import {
	initialGoodbyeGuard,
	shouldFireGoodbye,
	createConversationClearHelper,
	clearStaleResumptionHandle,
} from '../src/voice-continuity.js';

describe('P7 D7.3 stale-repeat goodbye guard', () => {
	it('first detection fires and latches text + user-turn watermark', () => {
		const v = shouldFireGoodbye(initialGoodbyeGuard(), 'Goodbye!', 3);
		assert.equal(v.fire, true);
		assert.deepEqual(v.next, { lastText: 'Goodbye!', userTurnsAtFire: 3 });
	});

	it('the SAME farewell with no new user turn is suppressed (reconnect replay)', () => {
		const first = shouldFireGoodbye(initialGoodbyeGuard(), 'Goodbye!', 3);
		const replay = shouldFireGoodbye(first.next, 'Goodbye!', 3);
		assert.equal(replay.fire, false);
		assert.equal(replay.next, first.next, 'state unchanged on suppression');
	});

	it('the same farewell AFTER a new real user turn fires again', () => {
		const first = shouldFireGoodbye(initialGoodbyeGuard(), 'Goodbye!', 3);
		const again = shouldFireGoodbye(first.next, 'Goodbye!', 4);
		assert.equal(again.fire, true);
		assert.equal(again.next.userTurnsAtFire, 4);
	});

	it('a different farewell fires regardless of turn count', () => {
		const first = shouldFireGoodbye(initialGoodbyeGuard(), 'Goodbye!', 3);
		const other = shouldFireGoodbye(first.next, 'Bye for now!', 3);
		assert.equal(other.fire, true);
	});

	it('a rebased (fresh) guard fires at ANY count — the per-session reset contract', () => {
		// voice-agent's resetSessionGateState() replaces the guard whenever
		// userTurnCount resets; without the rebase, the next session's count
		// (restarted below the old watermark) would suppress a real goodbye.
		const first = shouldFireGoodbye(initialGoodbyeGuard(), 'Goodbye!', 3);
		assert.equal(first.fire, true);
		const nextSession = shouldFireGoodbye(initialGoodbyeGuard(), 'Goodbye!', 1);
		assert.equal(nextSession.fire, true);
	});
});

describe('P7 D7.3 centralized conversation clear (G-P7-8)', () => {
	it('resets through the session seam and rebases the cursor together', () => {
		const reasons: string[] = [];
		const logs: string[] = [];
		const session = {
			resetConversationContext: (reason: string) => { reasons.push(reason); return { cleared: 3 }; },
		};
		const h = createConversationClearHelper(() => session, (m) => logs.push(m));
		h.cursor.index = 3;
		const cleared = h.clear('test');
		assert.equal(cleared, 3);
		assert.deepEqual(reasons, ['test'], 'one reset, carrying the reason');
		assert.equal(h.cursor.index, 0, 'cursor rebased WITH the clear');
		assert.ok(logs.some((l) => l.includes('cleared 3')));
	});

	it('rebases the cursor even when the reset throws — a stale cursor against an emptied context is the bug', () => {
		const logs: string[] = [];
		const h = createConversationClearHelper(
			() => ({
				resetConversationContext: () => {
					throw new Error('reset failed');
				},
			}),
			(m) => logs.push(m),
		);
		h.cursor.index = 7;
		assert.equal(h.clear('early'), 0);
		assert.equal(h.cursor.index, 0);
		assert.ok(logs.some((l) => l.includes('could not clear')));
	});

	it('no session yet: clears nothing, still rebases', () => {
		const h = createConversationClearHelper(() => null, () => {});
		h.cursor.index = 2;
		assert.equal(h.clear('none'), 0);
		assert.equal(h.cursor.index, 0);
	});
});

describe('stale resumption-handle clearing (1008 \'Requested entity was not found\' staircase)', () => {
	it('clears through the session seam and reports a cleared handle', () => {
		let calls = 0;
		const session = { clearResumption: () => { calls += 1; return true; } };
		assert.equal(clearStaleResumptionHandle(session), true);
		assert.equal(calls, 1);
	});

	it('no stale handle → false', () => {
		assert.equal(clearStaleResumptionHandle({ clearResumption: () => false }), false);
	});

	it('a missing or throwing seam never throws (a broken seam must not break reconnect)', () => {
		assert.equal(clearStaleResumptionHandle(null), false);
		assert.equal(clearStaleResumptionHandle(undefined), false);
		assert.equal(clearStaleResumptionHandle({ clearResumption: () => { throw new Error('boom'); } }), false);
	});
});

// The same helpers against a real VoiceSession (stub transport, host-owned client channel).
const sessions: VoiceSession[] = [];

function createStubTransport(): LLMTransport {
	let connected = false;
	const transport = {
		capabilities: {
			messageTruncation: false,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: false,
			sessionResumption: true,
			contextCompression: false,
			groundingMetadata: false,
			textResponseModality: true,
		},
		audioFormat: { inputSampleRate: 16000, outputSampleRate: 24000, channels: 1, bitDepth: 16, encoding: 'pcm' },
		get isConnected() { return connected; },
		async connect() {
			connected = true;
			transport.onSessionReady?.('stub_1');
		},
		async disconnect() { connected = false; },
		async reconnect() { connected = true; },
		clearResumption() {},
		sendAudio() {},
		commitAudio() {},
		clearAudio() {},
		async updateSession() {},
		async transferSession() {},
		sendContent() {},
		sendFile() {},
		sendToolResult() {},
		triggerGeneration() {},
	} as unknown as LLMTransport;
	return transport;
}

function createSession(): { session: VoiceSession; transport: LLMTransport } {
	const transport = createStubTransport();
	const config: VoiceSessionConfig = {
		sessionId: 'sess_continuity',
		userId: 'user',
		apiKey: 'test-key',
		agents: [{ name: 'main', instructions: 'Test agent.', tools: [] }],
		initialAgent: 'main',
		model: { modelId: 'test-model' } as unknown as VoiceSessionConfig['model'],
		transport,
		clientSender: { sendAudio: () => {}, sendJson: () => {} },
		log: () => {},
	};
	const session = new VoiceSession(config);
	sessions.push(session);
	return { session, transport };
}

describe('continuity helpers on a real VoiceSession', () => {
	after(async () => {
		for (const s of sessions) await s.close().catch(() => {});
	});

	it('the clear empties the session conversation and rebases the cursor', () => {
		const { session } = createSession();
		session.conversationContext.addUserMessage('hello');
		session.conversationContext.addAssistantMessage('Goodbye!');
		const h = createConversationClearHelper(() => session);
		h.cursor.index = session.conversationContext.items.length;
		assert.equal(h.clear('end_session'), 2);
		assert.equal(session.conversationContext.items.length, 0);
		assert.equal(h.cursor.index, 0);
		session.conversationContext.addUserMessage('next');
		assert.deepEqual(
			session.conversationContext.items.slice(h.cursor.index).map((i) => i.content),
			['next'],
			'the turn.end logger sees the first item after the clear',
		);
	});

	it('the resumption clear drops a saved handle once', async () => {
		const { session, transport } = createSession();
		await session.start();
		transport.onResumptionUpdate?.('dead-handle-123', true);
		assert.equal(session.sessionManager.resumptionHandle, 'dead-handle-123');
		assert.equal(clearStaleResumptionHandle(session), true);
		assert.equal(session.sessionManager.resumptionHandle, null);
		assert.equal(clearStaleResumptionHandle(session), false, 'nothing left to clear');
	});
});
