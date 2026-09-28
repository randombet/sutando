/**
 * Upstream loss under bodhi's `upstreamLossPolicy: 'hold'`, driven through a real
 * VoiceSession (stub transport, host-owned client channel) with the voice agent's
 * own close wiring:
 *  - the classifier runs BEFORE bodhi's close handler (wireCloseClassifier), so a
 *    terminal close has opened the fatal backoff by the time bodhi's reconnector
 *    asks the host gate whether it may redial;
 *  - the fatal backoff is part of that gate (hostOwnsUpstreamRecovery), so the
 *    terminal close parks the session in UPSTREAM_LOST and nothing dials, even
 *    with a saved resumption handle and the recovery coordinator disabled;
 *  - a retryable close still takes bodhi's automatic reconnect.
 *
 * voice-agent.ts calls main() at import time, so the test composes the same
 * exported pieces the agent wires rather than booting it.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { VoiceSession, type LLMTransport, type VoiceSessionConfig } from 'bodhi-realtime-agent';

import { wireCloseClassifier } from '../src/voice-error-classifier.ts';
import { hostOwnsUpstreamRecovery } from '../src/voice-redial-scheduler.ts';

/** The window voice-agent's close handler opens on every non-retryable close. */
const FATAL_BACKOFF_MS = 5 * 60 * 1000;
/** Past the reconnector's first backoff step (1 s), when its automatic dial runs. */
const AUTO_DIAL_WINDOW_MS = 1_500;
const QUOTA_REASON = 'You exceeded your current quota, please check your plan and billing details.';

interface StubTransport {
	transport: LLMTransport;
	connects: number;
	reconnects: number;
}

/** Gemini-shaped enough for bodhi: setup completes inside connect(), and the
 *  recovery primitives (dial generation, incumbent abort) are present. */
function createStubTransport(): StubTransport {
	const stub = { connects: 0, reconnects: 0 } as StubTransport;
	let dialGen = 0;
	let transportGeneration = 0;
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
		get currentDialGen() { return dialGen; },
		get currentTransportGeneration() { return transportGeneration; },
		async connect() {
			stub.connects++;
			dialGen++;
			transportGeneration++;
			connected = true;
			transport.onSessionReady?.(`stub_${dialGen}`);
		},
		async disconnect() { connected = false; },
		async reconnect() {
			stub.reconnects++;
			dialGen++;
			connected = true;
		},
		async abortIncumbent() {
			dialGen++;
			connected = false;
			return 'closed' as const;
		},
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
	stub.transport = transport;
	return stub;
}

const sessions: VoiceSession[] = [];

/** One session with the voice agent's upstream-loss wiring; the recovery
 *  coordinator is disabled, so only the fatal backoff can own recovery. */
function createHarness() {
	const stub = createStubTransport();
	let fatalBackoffUntil = 0;
	let ended = 0;
	const wiringErrors: string[] = [];
	const lost: Array<{ reason: string; code?: number }> = [];
	const config: VoiceSessionConfig = {
		sessionId: 'sess_upstream_loss',
		userId: 'user',
		apiKey: 'test-key',
		agents: [{ name: 'main', instructions: 'Test agent.', tools: [] }],
		initialAgent: 'main',
		model: { modelId: 'test-model' } as unknown as VoiceSessionConfig['model'],
		transport: stub.transport,
		clientSender: { sendAudio: () => {}, sendJson: () => {} },
		upstreamLossPolicy: 'hold',
		suppressClientAutoActions: () => hostOwnsUpstreamRecovery({
			coordinatorOwnsRecovery: false,
			fatalBackoffUntil,
			now: Date.now(),
		}),
		hooks: { onSessionEnd: () => { ended++; } },
		log: () => {},
	};
	const session = new VoiceSession(config);
	sessions.push(session);
	// The agent's close handler opens the fatal backoff on every non-retryable close.
	wireCloseClassifier(stub.transport, (c) => {
		if (!c.retryable) fatalBackoffUntil = Date.now() + FATAL_BACKOFF_MS;
	}, (m) => wiringErrors.push(m));
	session.eventBus.subscribe('session.upstreamLost', (e) => lost.push({ reason: e.reason, code: e.code }));
	return {
		stub,
		session,
		lost,
		wiringErrors,
		get ended() { return ended; },
		get fatalBackoffUntil() { return fatalBackoffUntil; },
	};
}

/** An established connection with a saved resumption handle. */
async function establish(h: ReturnType<typeof createHarness>): Promise<void> {
	await h.session.start();
	assert.equal(h.session.sessionManager.state, 'ACTIVE');
	h.stub.transport.onResumptionUpdate?.('handle-1', true);
	assert.equal(h.session.sessionManager.resumptionHandle, 'handle-1');
}

describe('upstream loss under the hold policy (real VoiceSession, stub transport)', () => {
	after(async () => {
		for (const s of sessions) await s.close().catch(() => {});
	});

	it('a terminal close parks in UPSTREAM_LOST at once and dials nothing in the backoff window', async () => {
		const h = createHarness();
		await establish(h);

		h.stub.transport.onClose?.(1011, QUOTA_REASON);
		// Synchronous: bodhi saw the backoff already open, so it never entered RECONNECTING.
		assert.equal(h.session.sessionManager.state, 'UPSTREAM_LOST');
		assert.ok(h.fatalBackoffUntil > Date.now(), 'the terminal close opened the fatal backoff');

		await delay(AUTO_DIAL_WINDOW_MS);
		assert.equal(h.stub.reconnects, 0, 'no automatic reconnect');
		assert.equal(h.stub.connects, 1, 'no fresh dial');
		assert.equal(h.session.sessionManager.state, 'UPSTREAM_LOST');
		assert.deepEqual(h.lost, [{ reason: 'host-owns-recovery', code: 1011 }]);
		assert.equal(h.ended, 0, 'parked, not finalized: onSessionEnd fires only on a real close');
		assert.deepEqual(h.wiringErrors, []);

		// The redial the health tick issues once the backoff lifts brings it back.
		const r = h.session.recoverUpstream({
			reason: 'human-retry', skipContextInjection: false, holdSyntheticUntilFreshSpeech: false,
		});
		await r.activated;
		assert.equal(h.session.sessionManager.state, 'ACTIVE');
		assert.equal(h.stub.connects, 2);
		assert.equal(h.stub.reconnects, 0);
	});

	it('a retryable close still takes bodhi\'s automatic reconnect', async () => {
		const h = createHarness();
		await establish(h);

		h.stub.transport.onClose?.(1011, 'Internal error encountered.');
		assert.equal(h.session.sessionManager.state, 'RECONNECTING');
		assert.equal(h.fatalBackoffUntil, 0, 'a retryable close opens no backoff');

		await delay(AUTO_DIAL_WINDOW_MS);
		assert.equal(h.stub.reconnects, 1, 'one automatic reconnect with the saved handle');
		assert.equal(h.session.sessionManager.state, 'ACTIVE');
		assert.deepEqual(h.lost, []);
		assert.equal(h.ended, 0);
		assert.deepEqual(h.wiringErrors, []);
	});
});

describe('wireCloseClassifier', () => {
	it('classifies before delegating to the handler it wraps', () => {
		const order: string[] = [];
		const t: { onClose?: (code?: number, reason?: string) => void } = {
			onClose: (code) => { order.push(`bodhi:${code}`); },
		};
		wireCloseClassifier(t, (c) => { order.push(`classify:${c.category}`); }, () => {});
		t.onClose?.(1011, QUOTA_REASON);
		assert.deepEqual(order, ['classify:quota_exceeded', 'bodhi:1011']);
	});

	it('a throw on either side is logged and does not stop the other', () => {
		const errors: string[] = [];
		let delegated = 0;
		const t: { onClose?: (code?: number, reason?: string) => void } = {
			onClose: () => { delegated++; throw new Error('handler boom'); },
		};
		wireCloseClassifier(t, () => { throw new Error('classifier boom'); }, (m) => errors.push(m));
		t.onClose?.(1006, 'socket lost');
		assert.equal(delegated, 1);
		assert.deepEqual(errors, ['classifier threw: classifier boom', 'origOnClose threw: handler boom']);
	});
});
