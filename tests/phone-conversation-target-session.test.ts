/**
 * The phone adapter's session wiring, run against the installed bodhi-realtime-agent.
 *
 * conversation-server.ts boots the phone service at import time, so the test lifts
 * createCallSession, cleanupCall and their helpers out of its source (TypeScript AST,
 * as phone-playback-cleanup.test.ts does) and runs that production code with a real
 * VoiceSession and GeminiLiveTransport. Only the edges are stubbed: the Gemini Live
 * connection under the transport, the Twilio socket, file writes, and the recording
 * and narration modules the adapter loads lazily.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';
import { Live } from '@google/genai';
import { VoiceSession, type RecoverUpstreamArgs, type VoiceSessionConfig } from 'bodhi-realtime-agent';
import { WebSocket } from 'ws';

const REDIAL_MS = 1_500;
const GREETING = '[Speak this greeting to the caller now]: Hi, this is Sutando. How can I help?';
const NARRATION_NUDGE = '[System: continue the screen demo narration]';

// --- Stub Gemini Live connection (under the real GeminiLiveTransport) --------------

type ServerMessage = Record<string, unknown>;
interface FakeDial {
	config: Record<string, unknown>;
	send(msg: ServerMessage): void;
	close(code: number, reason: string): void;
	sent: Array<Record<string, unknown>>;
}
type LiveConnect = (params: {
	config: Record<string, unknown>;
	callbacks: { onmessage(msg: ServerMessage): void; onclose?(e: { code?: number; reason?: string }): void };
}) => Promise<unknown>;

const dials: FakeDial[] = [];
let refuseDials = 0;
/** Dials held open (no session yet) until the test releases them. */
let stallDials = 0;
const stalled: Array<() => void> = [];
const liveProto = Live.prototype as unknown as { connect: LiveConnect };
const realConnect = liveProto.connect;
liveProto.connect = async ({ config, callbacks }) => {
	const dial: FakeDial = {
		config,
		send: (msg) => callbacks.onmessage(msg),
		close: (code, reason) => callbacks.onclose?.({ code, reason }),
		sent: [],
	};
	dials.push(dial);
	if (refuseDials > 0) {
		refuseDials--;
		throw new Error('dial refused');
	}
	if (stallDials > 0) {
		stallDials--;
		await new Promise<void>((resolve) => stalled.push(resolve));
	}
	setImmediate(() => callbacks.onmessage({ setupComplete: {} }));
	const record = (msg: Record<string, unknown>) => { dial.sent.push(msg); };
	return { sendRealtimeInput: record, sendClientContent: record, sendToolResponse: record, close: () => {} };
};

/** Every text the client sent on a dial, realtime or clientContent. */
function textsSent(dial: FakeDial): string[] {
	const texts: string[] = [];
	for (const msg of dial.sent) {
		if (typeof msg.text === 'string') texts.push(msg.text);
		for (const turn of (msg.turns as Array<{ parts?: Array<{ text?: string }> }> | undefined) ?? []) {
			for (const part of turn.parts ?? []) if (part.text) texts.push(part.text);
		}
	}
	return texts;
}

/** The agent's instructions carry the callSid, so each dial maps to its call. */
const dialsOf = (callSid: string) => dials.filter((d) => String(d.config.systemInstruction).includes(callSid));
const liveDial = (callSid: string) => dialsOf(callSid).at(-1)!;
const textsTo = (callSid: string) => dialsOf(callSid).flatMap(textsSent);
const count = (texts: string[], needle: string) => texts.filter((t) => t.includes(needle)).length;

const pcm24k = (samples: number) => {
	const buf = Buffer.alloc(samples * 2);
	for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(8000 * Math.sin(i / 7)), i * 2);
	return buf;
};

/** One complete model answer: transcript, audio, turnComplete. */
function modelSays(dial: FakeDial, text: string, audio = pcm24k(960)): void {
	dial.send({ serverContent: { outputTranscription: { text } } });
	dial.send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: audio.toString('base64') } }] } } });
	dial.send({ serverContent: { turnComplete: true } });
}
const callerSays = (dial: FakeDial, text: string) => dial.send({ serverContent: { inputTranscription: { text } } });

async function waitFor(cond: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for ${what}`);
		await delay(10);
	}
}

// --- The adapter, lifted from conversation-server.ts -------------------------------

interface CallSession {
	callSid: string;
	hangingUp: boolean;
	voiceSession: VoiceSession;
	transcript: { role: string; text: string }[];
	resultQueue: { text: string }[];
	channelScanHandle?: NodeJS.Timeout;
}
interface Adapter {
	createCallSession(params: Record<string, unknown>): Promise<CallSession>;
	cleanupCall(callSid: string): void;
	pcm24kToMulaw8k(pcm: Buffer): Buffer;
}

function liftFromServer(names: string[]): string {
	const path = new URL('../skills/phone-conversation/scripts/conversation-server.ts', import.meta.url);
	const source = readFileSync(path, 'utf8');
	const ast = ts.createSourceFile('conversation-server.ts', source, ts.ScriptTarget.Latest, true);
	return names.map((name) => {
		const fn = ast.statements.find((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === name);
		assert.ok(fn, `conversation-server.ts no longer declares ${name}()`);
		const js = ts.transpileModule(fn.getText(ast), {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
		}).outputText;
		// The lazy module loads go through the stubs below.
		return js.replace(/\bimport\(/g, '__import(');
	}).join('\n');
}

const env = {
	recording: false,
	muted: false,
	onReconnectCalls: 0,
	teed: [] as Buffer[],
	rows: [] as Array<{ role: string; text: string; callSid: string }>,
	logs: [] as string[],
};
const activeCalls = new Map<string, CallSession>();
const sessions: VoiceSession[] = [];
const configs = new Map<string, VoiceSessionConfig>();
const recoveries = new Map<string, RecoverUpstreamArgs[]>();

class ObservedVoiceSession extends VoiceSession {
	constructor(config: VoiceSessionConfig) {
		super({ ...config, log: (m) => env.logs.push(m) });
		configs.set(config.sessionId, config);
		sessions.push(this);
		const calls: RecoverUpstreamArgs[] = [];
		recoveries.set(config.sessionId, calls);
		const recover = this.recoverUpstream.bind(this);
		this.recoverUpstream = (args) => {
			calls.push(args);
			return recover(args);
		};
	}
}

const browserTools = {
	isRecordingMuted: () => env.muted,
	setupRecordingHooks: () => {},
	onCallEnd: () => {},
	// Same guard as recording-tools' onReconnect: it nudges only while a recording runs.
	onReconnect: (session: VoiceSession) => {
		env.onReconnectCalls++;
		if (env.recording) void session.injectText(NARRATION_NUDGE, { mode: 'live' });
	},
};
const narrationTee = { teeAudio: (pcm: Buffer) => { env.teed.push(pcm); }, cleanup: () => {} };
const capture = (...args: unknown[]) => { env.logs.push(args.map(String).join(' ')); };

const deps: Record<string, unknown> = {
	__import: async (specifier: string) => {
		if (specifier.endsWith('/src/browser-tools.js')) return browserTools;
		if (specifier.endsWith('/narration-tee.js')) return narrationTee;
		throw new Error(`unexpected lazy import ${specifier}`);
	},
	console: { log: capture, error: capture, warn: capture },
	ts: () => '',
	VoiceSession: ObservedVoiceSession,
	GEMINI_API_KEY: 'test-key',
	google: (modelId: string) => ({ modelId }),
	VOICE_MODEL: 'gemini-2.5-flash',
	VOICE_NATIVE_AUDIO_MODEL: 'gemini-3.1-flash-live-preview',
	buildAgent: (call: CallSession) => ({
		name: 'phone',
		instructions: `Phone agent for ${call.callSid}.`,
		tools: [],
		greeting: GREETING,
	}),
	createSessionRecorder: () => ({ events: [], toolCalls: [], startTicker: () => {}, flush: () => {} }),
	startPhoneTicker: () => ({}),
	attachVisionToCall: async () => {},
	detachVisionFromCall: () => {},
	WebSocket,
	activeCalls,
	pendingMeetingJoins: new Set<string>(),
	recordConversation: (role: string, text: string, callSid: string) => { env.rows.push({ role, text, callSid }); },
	recordToolCall: () => {},
	writeFileSync: () => {},
	appendFileSync: () => {},
	symlinkSync: () => {},
	unlinkSync: () => {},
	mkdirSync: () => {},
	existsSync: () => false,
	readdirSync: () => [],
	readFileSync: () => '',
	join: (...parts: string[]) => parts.join('/'),
	RESULTS_DIR: '/fixture/results',
	CALLS_DIR: '/fixture/results/calls',
	TASKS_DIR: '/fixture/tasks',
	WORKSPACE_DIR: '/fixture',
	PLAYBACK_PATH: '/fixture/playback-path',
	resultBelongsTo: () => false,
	phoneCallKey: (callSid: string) => `phone-${callSid}`,
	spawn: () => ({ on() { return this; } }),
	confineUserContent: (text: string) => text,
	twilioHangup: async () => {},
};
const body = `"use strict";\n${liftFromServer(['pcmToMulaw', 'pcm24kToMulaw8k', 'injectOrQueue', 'createCallSession', 'cleanupCall'])}\n`
	+ 'return { createCallSession, cleanupCall, pcm24kToMulaw8k };';
const adapter = new Function(...Object.keys(deps), body)(...Object.values(deps)) as Adapter;

function fakeTwilioSocket() {
	const frames: Array<{ event: string; streamSid: string; media: { payload: string } }> = [];
	return { readyState: WebSocket.OPEN, send: (msg: string) => { frames.push(JSON.parse(msg)); }, frames };
}

let callSeq = 0;
/** A call as the Twilio `start` handler sets it up: session created, then registered live. */
async function startCall(extra: Record<string, unknown> = {}) {
	const seq = String(++callSeq).padStart(3, '0');
	const callSid = `CA${seq}`;
	const twilio = fakeTwilioSocket();
	const call = await adapter.createCallSession({
		callSid,
		streamSid: `MZ${seq}`,
		purpose: '',
		twilioWs: twilio,
		callerNumber: '+15550100',
		callerVerified: true,
		isOwner: false,
		isMeeting: false,
		...extra,
	});
	activeCalls.set(callSid, call);
	await waitFor(() => count(textsTo(callSid), GREETING) === 1, 'the greeting');
	modelSays(liveDial(callSid), `Hello from ${callSid}.`);
	return { call, callSid, streamSid: `MZ${seq}`, twilio };
}

describe('phone adapter on a hosted VoiceSession', () => {
	after(async () => {
		for (const call of activeCalls.values()) clearInterval(call.channelScanHandle);
		await Promise.all(sessions.map((s) => s.close('test_end').catch(() => {})));
		liveProto.connect = realConnect;
	});

	it('hands the session the Twilio sender and the hold policy, and sends no realtimeInputConfig upstream', async () => {
		const { callSid } = await startCall();
		const config = configs.get(`phone_${callSid}`)!;
		assert.equal(typeof config.clientSender?.sendAudio, 'function');
		assert.equal('port' in config, false, 'no local client WebSocket port');
		assert.equal('host' in config, false);
		assert.equal(config.upstreamLossPolicy, 'hold');
		assert.equal(config.realtimeInputConfig, false);

		const setup = dialsOf(callSid)[0].config;
		assert.equal(Object.hasOwn(setup, 'realtimeInputConfig'), false, 'setup must carry no realtimeInputConfig key');
		assert.equal(count(textsTo(callSid), GREETING), 1, 'one greeting on the single attach');
		adapter.cleanupCall(callSid);
	});

	it('sends model audio to Twilio as 8 kHz mu-law media frames and tees it for narration', async () => {
		const { callSid, streamSid, twilio } = await startCall();
		twilio.frames.length = 0;
		env.teed.length = 0;

		const audio = pcm24k(960);
		modelSays(liveDial(callSid), 'Here is the answer.', audio);
		await waitFor(() => twilio.frames.length === 2, 'two media frames');
		assert.ok(twilio.frames.every((f) => f.event === 'media' && f.streamSid === streamSid));
		const mulaw = Buffer.concat(twilio.frames.map((f) => Buffer.from(f.media.payload, 'base64')));
		assert.deepEqual(mulaw, adapter.pcm24kToMulaw8k(audio));
		assert.deepEqual(env.teed, [audio]);

		// While a recording mutes the agent, nothing reaches the caller or the narration tee.
		env.muted = true;
		try {
			modelSays(liveDial(callSid), 'Muted answer.');
			await delay(50);
			assert.equal(twilio.frames.length, 2);
			assert.equal(env.teed.length, 1);
		} finally {
			env.muted = false;
		}
		adapter.cleanupCall(callSid);
	});

	it('redials once, 1.5 s after an upstream loss, with no second greeting and no duplicate transcript rows', async () => {
		const { call, callSid } = await startCall();
		const calls = recoveries.get(`phone_${callSid}`)!;
		callerSays(liveDial(callSid), 'What time is it?');
		modelSays(liveDial(callSid), 'It is noon.');
		await waitFor(() => env.rows.filter((r) => r.callSid === callSid).length === 3, 'three transcript rows');
		env.recording = true;
		env.onReconnectCalls = 0;
		try {
			const lostAt = Date.now();
			liveDial(callSid).close(1011, 'Internal error encountered.');
			assert.equal(call.voiceSession.sessionManager.state, 'UPSTREAM_LOST');
			await delay(REDIAL_MS - 400);
			assert.equal(calls.length, 0, 'no redial before 1.5 s');

			await waitFor(() => call.voiceSession.sessionManager.state === 'ACTIVE', 'the redial');
			assert.ok(Date.now() - lostAt >= REDIAL_MS - 50);
			assert.deepEqual(calls, [{ reason: 'human-retry', skipContextInjection: false, holdSyntheticUntilFreshSpeech: false }]);
			assert.equal(dialsOf(callSid).length, 2);
			await waitFor(() => count(textsSent(liveDial(callSid)), NARRATION_NUDGE) === 1, 'the narration nudge');

			callerSays(liveDial(callSid), 'Thanks.');
			modelSays(liveDial(callSid), 'You are welcome.');
			await delay(REDIAL_MS + 200);
			assert.equal(calls.length, 1, 'exactly one redial');
			assert.equal(env.onReconnectCalls, 1, 'one narration continuation per reconnect');
			assert.equal(count(textsTo(callSid), NARRATION_NUDGE), 1);
			assert.equal(count(textsTo(callSid), GREETING), 1, 'recovery sends no greeting');
			assert.deepEqual(
				env.rows.filter((r) => r.callSid === callSid).map((r) => `${r.role}: ${r.text}`),
				[
					`phone-agent: Hello from ${callSid}.`,
					'phone-caller: What time is it?',
					'phone-agent: It is noon.',
					'phone-caller: Thanks.',
					'phone-agent: You are welcome.',
				],
			);
		} finally {
			env.recording = false;
		}
		adapter.cleanupCall(callSid);
	});

	it('does not redial a call that hung up, before or during the 1.5 s wait', async () => {
		const before = await startCall();
		const during = await startCall();
		before.call.hangingUp = true;
		liveDial(before.callSid).close(1011, 'Internal error encountered.');
		liveDial(during.callSid).close(1011, 'Internal error encountered.');
		await delay(REDIAL_MS / 2);
		activeCalls.delete(during.callSid);
		await delay(REDIAL_MS + 300);

		for (const { call, callSid } of [before, during]) {
			assert.deepEqual(recoveries.get(`phone_${callSid}`), []);
			assert.equal(dialsOf(callSid).length, 1);
			assert.equal(call.voiceSession.sessionManager.state, 'UPSTREAM_LOST');
			clearInterval(call.channelScanHandle);
			activeCalls.delete(callSid);
			await call.voiceSession.close('test_end');
		}
	});

	it('re-arms exactly one further 1.5 s redial when a recovery fails to activate', async () => {
		const { call, callSid } = await startCall();
		const calls = recoveries.get(`phone_${callSid}`)!;
		refuseDials = 1;
		liveDial(callSid).close(1011, 'Internal error encountered.');
		await waitFor(() => calls.length === 1, 'the first redial');
		const firstAt = Date.now();
		await waitFor(() => call.voiceSession.sessionManager.state === 'UPSTREAM_LOST', 'the failed redial to park');
		await delay(REDIAL_MS - 400);
		assert.equal(calls.length, 1, 'the retry waits 1.5 s');

		await waitFor(() => call.voiceSession.sessionManager.state === 'ACTIVE', 'the retried redial');
		assert.ok(Date.now() - firstAt >= REDIAL_MS - 50);
		await delay(REDIAL_MS + 200);
		assert.equal(calls.length, 2, 'one retry, not one per failure signal');
		assert.equal(dialsOf(callSid).length, 3, 'initial dial, refused dial, retried dial');
		assert.equal(count(textsTo(callSid), GREETING), 1);
		adapter.cleanupCall(callSid);
	});

	it('continues a recording narration once after an automatic resumption, with no greeting or host redial', async () => {
		for (const recording of [true, false]) {
			const { call, callSid } = await startCall();
			liveDial(callSid).send({ sessionResumptionUpdate: { newHandle: `h-${callSid}`, resumable: true } });
			env.recording = recording;
			env.onReconnectCalls = 0;
			try {
				liveDial(callSid).close(1011, 'Internal error encountered.');
				assert.equal(call.voiceSession.sessionManager.state, 'RECONNECTING');
				await waitFor(() => call.voiceSession.sessionManager.state === 'ACTIVE', 'the automatic resumption');
				assert.deepEqual(liveDial(callSid).config.sessionResumption, { handle: `h-${callSid}` }, 'resumed, not redialed fresh');
				await delay(100);
				assert.deepEqual(recoveries.get(`phone_${callSid}`), [], 'no host redial');
				assert.equal(env.onReconnectCalls, 1);
				assert.equal(count(textsTo(callSid), NARRATION_NUDGE), recording ? 1 : 0);
				assert.equal(count(textsTo(callSid), GREETING), 1);
			} finally {
				env.recording = false;
			}
			adapter.cleanupCall(callSid);
		}
	});

	it('injects a finished child call into the parent once, outside the parent transcript', async () => {
		const parent = await startCall();
		const child = await startCall({ parentCallSid: parent.callSid });
		callerSays(liveDial(child.callSid), 'Tuesday works for me.');
		modelSays(liveDial(child.callSid), 'Great, see you Tuesday.');
		await waitFor(() => child.call.transcript.length === 3, 'the child transcript');

		adapter.cleanupCall(child.callSid);
		await waitFor(() => count(textsTo(parent.callSid), '[Concurrent call ended]') === 1, 'the parent injection');
		assert.ok(textsTo(parent.callSid).some((t) => t.includes('Other person: Tuesday works for me.')));

		modelSays(liveDial(parent.callSid), 'They said Tuesday works.');
		await delay(REDIAL_MS + 200);
		assert.equal(count(textsTo(parent.callSid), '[Concurrent call ended]'), 1, 'injected exactly once');
		assert.deepEqual(parent.call.resultQueue, []);
		const parentRecords = [
			...parent.call.transcript.map((t) => t.text),
			...env.rows.filter((r) => r.callSid === parent.callSid).map((r) => r.text),
		];
		assert.equal(parentRecords.filter((t) => t.includes('Concurrent call ended')).length, 0);
		adapter.cleanupCall(parent.callSid);
	});

	it('queues a child result the reconnecting parent refuses and sends it at the parent\'s next turn end', async () => {
		const parent = await startCall();
		const child = await startCall({ parentCallSid: parent.callSid });
		callerSays(liveDial(child.callSid), 'Friday is better.');
		modelSays(liveDial(child.callSid), 'Noted, Friday.');
		await waitFor(() => child.call.transcript.length === 3, 'the child transcript');

		// The child ends while the parent's redial is still dialing: no provider connection.
		stallDials = 1;
		liveDial(parent.callSid).close(1011, 'Internal error encountered.');
		await waitFor(() => stalled.length === 1, 'the parent redial to start dialing');
		assert.equal(parent.call.voiceSession.sessionManager.state, 'RECONNECTING');
		adapter.cleanupCall(child.callSid);
		await waitFor(() => parent.call.resultQueue.length === 1, 'the refused injection to queue');
		assert.match(parent.call.resultQueue[0].text, /^\[Concurrent call ended\]/);
		assert.equal(count(textsTo(parent.callSid), '[Concurrent call ended]'), 0);

		stalled.shift()!();
		await waitFor(() => parent.call.voiceSession.sessionManager.state === 'ACTIVE', 'the parent redial');
		assert.equal(count(textsTo(parent.callSid), '[Concurrent call ended]'), 0, 'held until the next turn end');
		modelSays(liveDial(parent.callSid), 'Back online.');
		await waitFor(() => count(textsSent(liveDial(parent.callSid)), '[Concurrent call ended]') === 1, 'the drain');
		assert.deepEqual(parent.call.resultQueue, []);
		await delay(100);
		assert.equal(count(textsTo(parent.callSid), '[Concurrent call ended]'), 1);
		adapter.cleanupCall(parent.callSid);
	});
});
